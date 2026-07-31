"use strict";

const util = require("util");
const Base = require("../structures/Base");
const ChildProcess = require("child_process");
const { VoiceOPCodes, GatewayOPCodes } = require("../Constants");
const Dgram = require("dgram");
const Net = require("net");
const Piper = require("./Piper");
const VoiceCrypto = require("./VoiceCrypto");
const VoiceDataStream = require("./VoiceDataStream");
const { createOpus } = require("../util/Opus");

const WebSocket = typeof window !== "undefined" ? require("../util/BrowserWebSocket") : require("ws");

let EventEmitter;
try {
  EventEmitter = require("eventemitter3");
} catch {
  EventEmitter = require("events").EventEmitter;
}

const VOICE_GATEWAY_VERSION = 8;
const MAX_FRAME_SIZE = 1276 * 3;
const SILENCE_FRAME = Buffer.from([0xF8, 0xFF, 0xFE]);

const RTP_HEADER_SIZE = 12;
const RTP_VERSION = 0x80;
const RTP_PAYLOAD_TYPE = 0x78;

const UDP_DISCOVERY_LENGTH = 74;
const UDP_DISCOVERY_TIMEOUT = 10000;
const UDP_KEEPALIVE = Buffer.from([0x80, 0xC8, 0x00, 0x00]);

/**
 * How many packet buffers to rotate through. Frames go out every 20ms and a UDP
 * write completes in microseconds, so this is generous, but it also has to
 * cover the bursts sent in a single tick
 */
const SEND_POOL_SIZE = 8;

const RECONNECT_BASE_DELAY = 500;
const RECONNECT_MAX_DELAY = 30000;

/**
 * Close codes that are fatal: reconnecting cannot succeed without the caller
 * doing something different, so the connection is torn down instead of looping
 */
const FATAL_CLOSE_CODES = new Set([
  4004, // Authentication failed
  4011, // Server not found
  4012, // Unknown protocol
  4016, // Unknown encryption mode
]);

/**
 * Close codes where the session is gone and a fresh IDENTIFY is required
 */
const NEW_SESSION_CLOSE_CODES = new Set([
  4006, // Session no longer valid
  4009, // Session timeout
]);

const converterCommand = {
  cmd: null,
  libopus: false,
};

converterCommand.pickCommand = function pickCommand() {
  let tenative;
  for (const command of ["./ffmpeg", "./avconv", "ffmpeg", "avconv"]) {
    const res = ChildProcess.spawnSync(command, ["-encoders"]);
    if (!res.error) {
      if (!res.stdout.toString().includes("libopus")) {
        tenative = command;
        continue;
      }
      converterCommand.cmd = command;
      converterCommand.libopus = true;
      return;
    }
  }
  if (tenative) {
    converterCommand.cmd = tenative;
    return;
  }
};

/**
 * Represents a voice connection
 * @extends EventEmitter
 * @prop {String} channelID The ID of the voice connection's current channel
 * @prop {Boolean} connecting Whether the voice connection is connecting
 * @prop {Object?} current The state of the currently playing stream
 * @prop {Object} current.options The custom options for the current stream
 * @prop {Array<String>?} current.options.encoderArgs Additional encoder parameters to pass to ffmpeg/avconv (after -i)
 * @prop {String?} current.options.format The format of the resource. If null, FFmpeg will attempt to guess and play the format. Available options: "dca", "ogg", "webm", "pcm", "opusPackets", null
 * @prop {Number?} current.options.frameDuration The resource opus frame duration (required for DCA/Ogg)
 * @prop {Number?} current.options.frameSize The resource opus frame size
 * @prop {Boolean?} current.options.inlineVolume Whether to enable on-the-fly volume changing. Note that enabling this leads to increased CPU usage
 * @prop {Array<String>?} current.options.inputArgs Additional input parameters to pass to ffmpeg/avconv (before -i)
 * @prop {Number?} current.options.sampleRate The resource audio sampling rate
 * @prop {Number?} current.options.voiceDataTimeout Timeout when waiting for voice data (-1 for no timeout)
 * @prop {Number} current.pausedTime How long the current stream has been paused for, in milliseconds
 * @prop {Number} current.pausedTimestamp The timestamp of the most recent pause
 * @prop {Number} current.playTime How long the current stream has been playing for, in milliseconds
 * @prop {Number} current.startTime The timestamp of the start of the current stream
 * @prop {String} id The ID of the voice connection (guild ID)
 * @prop {String?} mode The negotiated encryption mode
 * @prop {Array<String>?} modes The encryption modes offered by the voice gateway
 * @prop {Boolean} paused Whether the voice connection is paused
 * @prop {Boolean} playing Whether the voice connection is playing something
 * @prop {Boolean} ready Whether the voice connection is ready
 * @prop {Boolean} resuming Whether the voice connection is waiting for resuming
 * @prop {Number} volume The current volume level of the connection
 */
class VoiceConnection extends EventEmitter {
  constructor(id, options = {}) {
    super();

    if (typeof window !== "undefined") {
      throw new Error("Voice is not supported in browsers at this time");
    }

    if (VoiceCrypto.supportedModes.length === 0) {
      throw new Error("No supported voice encryption backend found, voice not available");
    }

    this.id = id;
    this.samplingRate = 48000;
    this.channels = 2;
    this.frameDuration = 20;
    this.frameSize = this.samplingRate * this.frameDuration / 1000;
    this.pcmSize = this.frameSize * this.channels * 2;
    this.bitrate = 64000;
    this.shared = !!options.shared;
    this.shard = options.shard || {};
    this.opusOnly = !!options.opusOnly;
    this.preferredEncryptionMode = options.encryptionMode || null;
    if (this.preferredEncryptionMode && !VoiceCrypto.supportedModes.includes(this.preferredEncryptionMode)) {
      throw new Error(`Unsupported voice encryption mode: ${this.preferredEncryptionMode}. Supported modes: ${VoiceCrypto.supportedModes.join(", ")}`);
    }

    if (!this.opusOnly && !this.shared) {
      this.opus = {};
    }

    this.channelID = null;
    this.paused = true;
    this.speaking = false;
    this.sequence = 0;
    this.timestamp = 0;
    this.ssrcUserMap = {};
    this.connectionTimeout = null;
    this.connecting = false;
    this.reconnecting = false;
    this.resuming = false;
    this.ready = false;

    this.crypto = null;
    this.mode = null;
    this._seq = -1;
    this._heartbeatNonce = 0;
    this._heartbeatAcked = true;
    this._reconnectAttempts = 0;
    this._receiveHandler = null;
    this._aadIncludesExtension = null;

    // Packets are built in place so no allocation is needed per frame, but
    // dgram does not copy the buffer it is handed: it is still owned by the
    // socket until the write completes. Frames can be emitted several at a time
    // (the silence burst in stopPlaying, SharedStream fanning out), so buffers
    // are rotated through a pool instead of a single one being overwritten
    // while it is still in flight.
    this._sendPool = new Array(SEND_POOL_SIZE);
    this._sendPoolIndex = 0;
    for (let i = 0; i < SEND_POOL_SIZE; i++) {
      const buffer = Buffer.allocUnsafe(RTP_HEADER_SIZE + MAX_FRAME_SIZE + VoiceCrypto.OVERHEAD);
      buffer[0] = RTP_VERSION;
      buffer[1] = RTP_PAYLOAD_TYPE;
      this._sendPool[i] = buffer;
    }

    if (!options.shared) {
      if (!converterCommand.cmd) {
        converterCommand.pickCommand();
      }

      this.piper = new Piper(converterCommand.cmd, () => createOpus(this.samplingRate, this.channels, this.bitrate));
      /**
       * Fired when the voice connection encounters an error. This event should be handled by users
       * @event VoiceConnection#error
       * @prop {Error} err The error object
       */
      this.piper.on("error", (e) => this.emit("error", e));
      if (!converterCommand.libopus) {
        this.piper.libopus = false;
      }
    }

    this._send = this._send.bind(this);
  }

  get volume() {
    return this.piper.volumeLevel;
  }

  connect(data) {
    this.connecting = true;
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      this.disconnect(undefined, true);
      setTimeout(() => {
        if (!this.connecting && !this.ready) {
          this.connect(data);
        }
      }, 500).unref();
      return;
    }
    clearTimeout(this.connectionTimeout);
    this.connectionTimeout = setTimeout(() => {
      if (this.connecting) {
        this.disconnect(new Error("Voice connection timeout"));
      }
      this.connectionTimeout = null;
    }, this.shard.client ? this.shard.client.options.connectionTimeout : 30000).unref();
    if (!data.endpoint) {
      return; // Endpoint null, wait next update.
    }
    if (!data.token || !data.session_id || !data.user_id) {
      this.disconnect(new Error("Malformed voice server update: " + JSON.stringify(data)));
      return;
    }
    this.channelID = data.channel_id;
    this.endpoint = new URL(`wss://${data.endpoint}`);
    if (this.endpoint.port === "80") {
      this.endpoint.port = "";
    }
    this.endpoint.searchParams.set("v", VOICE_GATEWAY_VERSION);
    this.ws = new WebSocket(this.endpoint.href);
    /**
     * Fired when stuff happens and gives more info
     * @event VoiceConnection#debug
     * @prop {String} message The debug message
     */
    this.emit("debug", "Connection: " + JSON.stringify(data));
    this.ws.on("open", () => {
      /**
       * Fired when the voice connection connects
       * @event VoiceConnection#connect
       */
      this.emit("connect");
      if (this.connectionTimeout) {
        clearTimeout(this.connectionTimeout);
        this.connectionTimeout = null;
      }
      if (this.resuming) {
        // Voice gateway v8 replays buffered messages from seq_ack on resume
        this.sendWS(VoiceOPCodes.RESUME, {
          server_id: this.id,
          session_id: data.session_id,
          token: data.token,
          seq_ack: this._seq,
        });
      } else {
        this._seq = -1;
        this.sendWS(VoiceOPCodes.IDENTIFY, {
          server_id: this.id,
          user_id: data.user_id,
          session_id: data.session_id,
          token: data.token,
        });
      }
    });
    this.ws.on("message", (m) => {
      let packet;
      try {
        packet = JSON.parse(m);
      } catch (err) {
        this.emit("error", err);
        return;
      }
      if (this.listeners("debug").length > 0) {
        this.emit("debug", "Rec: " + JSON.stringify(packet));
      }
      // v8 sequences every message it may need to replay after a resume
      if (packet.seq != null) {
        this._seq = packet.seq;
      }
      switch (packet.op) {
        case VoiceOPCodes.READY: {
          this.ssrc = packet.d.ssrc;
          for (const buffer of this._sendPool) {
            buffer.writeUInt32BE(this.ssrc, 8);
          }

          this.modes = packet.d.modes;
          const mode = VoiceCrypto.negotiate(packet.d.modes, this.preferredEncryptionMode);
          if (!mode) {
            this.disconnect(new Error(`No supported voice encryption mode found. Gateway offered: ${(packet.d.modes || []).join(", ")}`));
            return;
          }
          this.mode = mode;
          this.emit("debug", `Using voice encryption mode: ${mode}`);

          this.udpIP = packet.d.ip;
          this.udpPort = packet.d.port;

          this.emit("debug", "Connecting to UDP: " + this.udpIP + ":" + this.udpPort);

          this.udpSocket = Dgram.createSocket(Net.isIPv6(this.udpIP) ? "udp6" : "udp4");
          this.udpSocket.on("error", (err, msg) => {
            this.emit("error", err);
            if (msg) {
              this.emit("debug", "Voice UDP error: " + msg);
            }
            if (this.ready || this.connecting) {
              this.disconnect(err);
            }
          });
          // IP discovery can silently go unanswered when UDP is filtered, which
          // used to hang the connection until the outer connection timeout
          this._discoveryTimeout = setTimeout(() => {
            this._discoveryTimeout = null;
            if (this.connecting) {
              this.disconnect(new Error("Voice UDP IP discovery timed out"));
            }
          }, UDP_DISCOVERY_TIMEOUT);
          this._discoveryTimeout.unref();

          this.udpSocket.once("message", (packet) => {
            if (this._discoveryTimeout) {
              clearTimeout(this._discoveryTimeout);
              this._discoveryTimeout = null;
            }
            if (packet.length < UDP_DISCOVERY_LENGTH || packet.readUInt16BE(0) !== 0x2) {
              this.disconnect(new Error("Malformed voice UDP discovery response"));
              return;
            }
            let i = 8;
            while (i < packet.length && packet[i] !== 0) {
              i++;
            }
            const localIP = packet.toString("ascii", 8, i);
            const localPort = packet.readUInt16BE(packet.length - 2);
            this.emit("debug", `Discovered IP: ${localIP}:${localPort} (${packet.toString("hex")})`);

            this.sendWS(VoiceOPCodes.SELECT_PROTOCOL, {
              protocol: "udp",
              data: {
                address: localIP,
                port: localPort,
                mode: this.mode,
              },
            });
          });
          this.udpSocket.on("close", (err) => {
            if (err) {
              this.emit("warn", "Voice UDP close: " + err);
            }
            if (this.ready || this.connecting) {
              this.disconnect(err);
            }
          });
          const udpMessage = Buffer.alloc(UDP_DISCOVERY_LENGTH);
          udpMessage.writeUInt16BE(0x1, 0);
          udpMessage.writeUInt16BE(70, 2);
          udpMessage.writeUInt32BE(this.ssrc, 4);
          this.sendUDPPacket(udpMessage);
          break;
        }
        case VoiceOPCodes.RESUMED: {
          this.connecting = false;
          this.resuming = false;
          this.reconnecting = false;
          this.ready = true;
          this._reconnectAttempts = 0;
          /**
           * Fired when the voice connection resumes an interrupted session
           * @event VoiceConnection#resumed
           */
          this.emit("resumed");
          this.resume();
          break;
        }
        case VoiceOPCodes.SESSION_DESCRIPTION: {
          this.mode = packet.d.mode;
          this.secret = Buffer.from(packet.d.secret_key);
          try {
            this.crypto = new VoiceCrypto(this.mode, this.secret);
          } catch (err) {
            this.disconnect(err);
            return;
          }
          this._aadIncludesExtension = null;
          this.connecting = false;
          this.reconnecting = false;
          this.ready = true;
          this._reconnectAttempts = 0;
          // Send audio to properly establish the socket (e.g. for voice receive)
          this.sendAudioFrame(SILENCE_FRAME, this.frameSize);
          /**
           * Fired when the voice connection turns ready
           * @event VoiceConnection#ready
           */
          this.emit("ready");
          this.resume();
          if (this.receiveStreamOpus || this.receiveStreamPCM) {
            this.registerReceiveEventHandler();
          }
          break;
        }
        case VoiceOPCodes.HEARTBEAT_ACK: {
          this._heartbeatAcked = true;
          // v8 acks echo the nonce back inside an object rather than the raw timestamp
          const sent = packet.d && typeof packet.d === "object" ? packet.d.t : packet.d;
          /**
           * Fired when the voice connection receives a pong
           * @event VoiceConnection#pong
           * @prop {Number} latency The current latency in milliseconds
           */
          this.emit("pong", Date.now() - sent);
          break;
        }
        case VoiceOPCodes.SPEAKING: {
          this.ssrcUserMap[packet.d.ssrc] = packet.d.user_id;
          /**
           * Fired when a user begins speaking
           * @event VoiceConnection#speakingStart
           * @prop {String} userID The ID of the user that began speaking
           */
          /**
           * Fired when a user stops speaking
           * @event VoiceConnection#speakingStop
           * @prop {String} userID The ID of the user that stopped speaking
           */
          this.emit(packet.d.speaking ? "speakingStart" : "speakingStop", packet.d.user_id);
          break;
        }
        case VoiceOPCodes.HELLO: {
          if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
          }
          this._heartbeatAcked = true;
          this.heartbeatInterval = setInterval(() => {
            // An unacked heartbeat means the socket is open but the session is
            // dead; reconnecting is the only way out
            if (!this._heartbeatAcked) {
              this.emit("warn", "Voice heartbeat timed out, reconnecting");
              // Terminating hands control to the close handler, which resumes
              if (this.ws) {
                this.ws.terminate();
              }
              return;
            }
            this.heartbeat();
          }, packet.d.heartbeat_interval);

          this.heartbeat();
          break;
        }
        case VoiceOPCodes.CLIENTS_CONNECT: {
          /**
           * Fired when one or more clients connect to the voice channel
           * @event VoiceConnection#usersConnect
           * @prop {String[]} userIDs The IDs of the users that connected
           */
          this.emit("usersConnect", packet.d.user_ids);
          break;
        }
        case VoiceOPCodes.CLIENT_DISCONNECT: {
          if (this.opus) {
            // opusscript requires manual cleanup
            if (this.opus[packet.d.user_id] && this.opus[packet.d.user_id].delete) {
              this.opus[packet.d.user_id].delete();
            }

            delete this.opus[packet.d.user_id];
          }

          /**
           * Fired when a user disconnects from the voice server
           * @event VoiceConnection#userDisconnect
           * @prop {String} userID The ID of the user that disconnected
           */
          this.emit("userDisconnect", packet.d.user_id);
          break;
        }
        default: {
          this.emit("unknown", packet);
          break;
        }
      }
    });
    this.ws.on("error", (err) => {
      this.emit("error", err);
    });
    this.ws.on("close", (code, reason) => {
      let err = !code || code === 1000 ? null : new Error(code + ": " + reason);
      this.emit("warn", `Voice WS close ${code}: ${reason}`);
      // Stop the old heartbeat before anything else. The resume path below
      // returns without going through disconnect, and a surviving interval
      // would later fire its zombie check against the replacement socket
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }
      this._heartbeatAcked = true;
      if (this.connecting || this.ready) {
        let reconnecting = true;
        if (FATAL_CLOSE_CODES.has(code)) {
          // Retrying cannot help: surface the error instead of looping forever
          this.disconnect(err);
          return;
        }
        if (code < 4000 || code === 4015) {
          // Resumable: the session survives, so replay from the last sequence
          this.resuming = true;
          setTimeout(() => {
            if (!this.ready || this.resuming) {
              this.connect(data);
            }
          }, this._reconnectDelay()).unref();
          return;
        }
        if (NEW_SESSION_CLOSE_CODES.has(code)) {
          // The session is gone, so a fresh voice server update is needed
          this.resuming = false;
          this._seq = -1;
          reconnecting = false;
        } else if (code === 4014) {
          if (this.channelID) {
            data.endpoint = null;
            reconnecting = true;
            err = null;
          } else {
            reconnecting = false;
          }
        } else if (code === 1000) {
          reconnecting = false;
        }
        this.disconnect(err, reconnecting);
        if (reconnecting) {
          setTimeout(() => {
            if (!this.connecting && !this.ready) {
              this.connect(data);
            }
          }, this._reconnectDelay()).unref();
        }
      }
    });
  }

  disconnect(error, reconnecting) {
    this.connecting = false;
    this.reconnecting = reconnecting;
    this.resuming = false;
    this.ready = false;
    this.speaking = false;
    this.timestamp = 0;
    this.sequence = 0;

    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
    if (this._discoveryTimeout) {
      clearTimeout(this._discoveryTimeout);
      this._discoveryTimeout = null;
    }

    try {
      if (reconnecting) {
        this.pause();
      } else {
        this.stopPlaying();
      }
    } catch (err) {
      this.emit("error", err);
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.udpSocket) {
      if (this._receiveHandler) {
        this.udpSocket.removeListener("message", this._receiveHandler);
        this._receiveHandler = null;
      }
      try {
        this.udpSocket.close();
      } catch (err) {
        if (err.message !== "Not running") {
          this.emit("error", err);
        }
      }
      this.udpSocket = null;
    }
    if (this.ws) {
      try {
        if (reconnecting) {
          if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.close(4901, "Eris: reconnect");
          } else {
            this.emit("debug", `Terminating websocket (state: ${this.ws.readyState})`);
            this.ws.terminate();
          }
        } else {
          this.ws.close(1000, "Eris: normal");
        }
      } catch (err) {
        this.emit("error", err);
      }
      this.ws = null;
    }
    if (reconnecting) {
      if (error) {
        this.emit("error", error);
      }
    } else {
      this.crypto = null;
      this.secret = null;
      this._seq = -1;
      this._reconnectAttempts = 0;
      this.channelID = null;
      this.updateVoiceState();
      /**
       * Fired when the voice connection disconnects
       * @event VoiceConnection#disconnect
       * @prop {Error?} error The error, if any
       */
      this.emit("disconnect", error);
    }
  }

  heartbeat() {
    this._heartbeatAcked = false;
    this._heartbeatNonce = Date.now();
    // v8 heartbeats carry the last received sequence so the gateway knows what
    // it still has to replay if the connection drops
    this.sendWS(VoiceOPCodes.HEARTBEAT, {
      t: this._heartbeatNonce,
      seq_ack: this._seq,
    });
    if (this.udpSocket) {
      // NAT/connection table keep-alive
      this.sendUDPPacket(UDP_KEEPALIVE);
    }
  }

  /**
   * Pause sending audio (if playing)
   */
  pause() {
    this.paused = true;
    this.setSpeaking(0);
    if (this.current) {
      if (!this.current.pausedTimestamp) {
        this.current.pausedTimestamp = Date.now();
      }
      if (this.current.timeout) {
        clearTimeout(this.current.timeout);
        this.current.timeout = null;
      }
    }
  }

  /**
   * Play an audio or video resource. If playing from a non-opus resource, FFMPEG should be compiled with --enable-libopus for best performance. If playing from HTTPS, FFMPEG must be compiled with --enable-openssl
   * @arg {ReadableStream | String} resource The audio or video resource, either a ReadableStream, URL, or file path
   * @arg {Object} [options] Music options
   * @arg {Array<String>} [options.encoderArgs] Additional encoder parameters to pass to ffmpeg/avconv (after -i)
   * @arg {String} [options.format] The format of the resource. If null, FFmpeg will attempt to guess and play the format. Available options: "dca", "ogg", "webm", "pcm", null
   * @arg {Number} [options.frameDuration=20] The resource opus frame duration (required for DCA/Ogg)
   * @arg {Number} [options.frameSize=2880] The resource opus frame size
   * @arg {Boolean} [options.inlineVolume=false] Whether to enable on-the-fly volume changing. Note that enabling this leads to increased CPU usage
   * @arg {Array<String>} [options.inputArgs] Additional input parameters to pass to ffmpeg/avconv (before -i)
   * @arg {Number} [options.pcmSize=options.frameSize*2*this.channels] The PCM size if the "pcm" format is used
   * @arg {Number} [options.samplingRate=48000] The resource audio sampling rate
   * @arg {Number} [options.voiceDataTimeout=2000] Timeout when waiting for voice data (-1 for no timeout)
   */
  play(source, options = {}) {
    if (this.shared) {
      throw new Error("Cannot play stream on shared voice connection");
    }
    if (!this.ready) {
      throw new Error("Not ready yet");
    }

    options.format = options.format || null;
    options.voiceDataTimeout = !isNaN(options.voiceDataTimeout) ? options.voiceDataTimeout : 2000;
    options.inlineVolume = !!options.inlineVolume;
    options.inputArgs = options.inputArgs || [];
    options.encoderArgs = options.encoderArgs || [];

    options.samplingRate = options.samplingRate || this.samplingRate;
    options.frameDuration = options.frameDuration || this.frameDuration;
    options.frameSize = options.frameSize || options.samplingRate * options.frameDuration / 1000;
    options.pcmSize = options.pcmSize || options.frameSize * 2 * this.channels;

    if (!this.piper.encode(source, options)) {
      this.emit("error", new Error("Unable to encode source"));
      return;
    }

    this.ended = false;
    this.current = {
      startTime: 0, // later
      playTime: 0,
      pausedTimestamp: 0,
      pausedTime: 0,
      bufferingTicks: 0,
      options: options,
      timeout: null,
      buffer: null,
    };

    this.playing = true;

    /**
     * Fired when the voice connection starts playing a stream
     * @event VoiceConnection#start
     */
    this.emit("start");

    this._send();
  }

  /**
   * Generate a receive stream for the voice connection.
   * @arg {String} [type="pcm"] The desired voice data type, either "opus" or "pcm"
   * @returns {VoiceDataStream}
   */
  receive(type) {
    if (type === "pcm") {
      if (!this.receiveStreamPCM) {
        this.receiveStreamPCM = new VoiceDataStream(type);
        if (!this.receiveStreamOpus) {
          this.registerReceiveEventHandler();
        }
      }
    } else if (type === "opus") {
      if (!this.receiveStreamOpus) {
        this.receiveStreamOpus = new VoiceDataStream(type);
        if (!this.receiveStreamPCM) {
          this.registerReceiveEventHandler();
        }
      }
    } else {
      throw new Error(`Unsupported voice data type: ${type}`);
    }
    return type === "pcm" ? this.receiveStreamPCM : this.receiveStreamOpus;
  }

  registerReceiveEventHandler() {
    if (this._receiveHandler || !this.udpSocket) {
      return;
    }

    this._receiveHandler = (msg) => {
      // RTP version 2 with the Opus payload type; anything else is not audio
      if (!this.crypto || (msg[0] & 0xC0) !== RTP_VERSION || msg[1] !== RTP_PAYLOAD_TYPE) {
        return;
      }

      const csrcCount = msg[0] & 0x0F;
      const hasExtension = (msg[0] & 0x10) !== 0;
      const baseHeaderSize = RTP_HEADER_SIZE + csrcCount * 4;

      let data = null;
      if (hasExtension) {
        // The AEAD "rtpsize" modes authenticate the RTP header as additional
        // data. Whether the 4 byte RFC 5285 extension header belongs to that
        // header or to the encrypted payload is not pinned down, so the layout
        // is probed once per session and the result reused from then on.
        if (this._aadIncludesExtension !== false && msg.length > baseHeaderSize + 4) {
          data = this.crypto.decrypt(msg, baseHeaderSize + 4);
          if (data) {
            this._aadIncludesExtension = true;
            // The extension body leads the encrypted payload
            data = data.subarray(msg.readUInt16BE(baseHeaderSize + 2) * 4);
          } else if (this._aadIncludesExtension === true) {
            this.emit("warn", "Failed to decrypt received packet");
            return;
          }
        }
        if (!data) {
          data = this.crypto.decrypt(msg, baseHeaderSize);
          if (data && data.length >= 4) {
            this._aadIncludesExtension = false;
            // Here the extension header itself was encrypted along with its body
            data = data.subarray(4 + data.readUInt16BE(2) * 4);
          }
        }
      } else {
        data = this.crypto.decrypt(msg, baseHeaderSize);
      }

      if (!data) {
        /**
         * Fired to warn of something weird but non-breaking happening
         * @event VoiceConnection#warn
         * @prop {String} message The warning message
         */
        this.emit("warn", "Failed to decrypt received packet");
        return;
      }

      const sequence = msg.readUInt16BE(2);
      const timestamp = msg.readUInt32BE(4);
      const userID = this.ssrcUserMap[msg.readUInt32BE(8)];

      if (this.receiveStreamOpus) {
        /**
         * Fired when a voice data packet is received
         * @event VoiceDataStream#data
         * @prop {Buffer} data The voice data
         * @prop {String} userID The user who sent the voice packet
         * @prop {Number} timestamp The intended timestamp of the packet
         * @prop {Number} sequence The intended sequence number of the packet
         */
        this.receiveStreamOpus.emit("data", data, userID, timestamp, sequence);
      }
      if (this.receiveStreamPCM) {
        if (!this.opus[userID]) {
          this.opus[userID] = createOpus(this.samplingRate, this.channels, this.bitrate);
        }

        const pcm = this.opus[userID].decode(data, this.frameSize);
        if (!pcm) {
          return this.emit("warn", "Failed to decode received packet");
        }
        this.receiveStreamPCM.emit("data", pcm, userID, timestamp, sequence);
      }
    };

    this.udpSocket.on("message", this._receiveHandler);
  }

  /**
   * Resume sending audio (if paused)
   */
  resume() {
    this.paused = false;
    if (this.current) {
      this.setSpeaking(1);
      if (this.current.pausedTimestamp) {
        this.current.pausedTime += Date.now() - this.current.pausedTimestamp;
        this.current.pausedTimestamp = 0;
      }
      this._send();
    } else {
      this.setSpeaking(0);
    }
  }

  /**
   * Send a packet containing an Opus audio frame
   * @arg {Buffer} frame The Opus audio frame
   * @arg {Number} [frameSize] The size (in samples) of the Opus audio frame
   */
  sendAudioFrame(frame, frameSize = this.frameSize) {
    this.timestamp = (this.timestamp + frameSize) >>> 0;
    this.sequence = (this.sequence + 1) & 0xFFFF;

    return this._sendAudioFrame(frame);
  }

  /**
   * Send a packet through the connection's UDP socket. The packet is dropped if the socket isn't established
   * @arg {Buffer} packet The packet data
   */
  sendUDPPacket(packet) {
    if (this.udpSocket) {
      try {
        this.udpSocket.send(packet, 0, packet.length, this.udpPort, this.udpIP);
      } catch (e) {
        this.emit("error", e);
      }
    }
  }

  sendWS(op, data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      data = JSON.stringify({ op: op, d: data });
      this.ws.send(data);
      this.emit("debug", data);
    }
  }

  setSpeaking(value, delay = 0) {
    this.speaking = value === true ? 1 : value === false ? 0 : value;
    this.sendWS(VoiceOPCodes.SPEAKING, {
      speaking: value,
      delay: delay,
      ssrc: this.ssrc,
    });
  }

  /**
   * Modify the output volume of the current stream (if inlineVolume is enabled for the current stream)
   * @arg {Number} [volume=1.0] The desired volume. 0.0 is 0%, 1.0 is 100%, 2.0 is 200%, etc. It is not recommended to go above 2.0
   */
  setVolume(volume) {
    this.piper.setVolume(volume);
  }

  /**
   * Stop the bot from sending audio
   */
  stopPlaying() {
    if (this.ended) {
      return;
    }
    this.ended = true;
    if (this.current && this.current.timeout) {
      clearTimeout(this.current.timeout);
      this.current.timeout = null;
    }
    this.current = null;
    if (this.piper) {
      this.piper.stop();
      this.piper.resetPackets();
    }

    if (this.crypto) {
      for (let i = 0; i < 5; i++) {
        this.sendAudioFrame(SILENCE_FRAME, this.frameSize);
      }
    }
    this.playing = false;
    this.setSpeaking(0);

    /**
     * Fired when the voice connection finishes playing a stream
     * @event VoiceConnection#end
     */
    this.emit("end");
  }

  /**
   * Switch the voice channel the bot is in. The channel to switch to must be in the same guild as the current voice channel
   * @arg {String} channelID The ID of the voice channel
   */
  switchChannel(channelID, reactive) {
    if (this.channelID === channelID) {
      return;
    }

    this.channelID = channelID;
    if (reactive) {
      if (this.reconnecting && !channelID) {
        this.disconnect();
      }
    } else {
      this.updateVoiceState();
    }
  }

  /**
   * Update the bot's voice state
   * @arg {Boolean} selfMute Whether the bot muted itself or not (audio receiving is unaffected)
   * @arg {Boolean} selfDeaf Whether the bot deafened itself or not (audio sending is unaffected)
   */
  updateVoiceState(selfMute, selfDeaf) {
    if (this.shard.sendWS) {
      this.shard.sendWS(GatewayOPCodes.VOICE_STATE_UPDATE, {
        guild_id: this.id === "call" ? null : this.id,
        channel_id: this.channelID || null,
        self_mute: !!selfMute,
        self_deaf: !!selfDeaf,
      });
    }
  }

  _destroy() {
    if (this.opus) {
      for (const key in this.opus) {
        if (this.opus[key].delete) {
          this.opus[key].delete();
        }
        delete this.opus[key];
      }
    }
    delete this.piper;
    if (this.receiveStreamOpus) {
      this.receiveStreamOpus.removeAllListeners();
      this.receiveStreamOpus = null;
    }
    if (this.receiveStreamPCM) {
      this.receiveStreamPCM.removeAllListeners();
      this.receiveStreamPCM = null;
    }
  }

  /**
   * Exponential backoff with jitter, so a voice server outage does not turn
   * every bot into a reconnect storm hammering it at a fixed interval
   * @returns {Number} The delay before the next connection attempt, in milliseconds
   */
  _reconnectDelay() {
    const delay = Math.min(RECONNECT_BASE_DELAY * 2 ** this._reconnectAttempts, RECONNECT_MAX_DELAY);
    this._reconnectAttempts++;
    return delay + Math.random() * Math.min(delay, 1000);
  }

  _send() {
    if (!this.piper.encoding && this.piper.dataPacketCount === 0) {
      return this.stopPlaying();
    }

    if ((this.current.buffer = this.piper.getDataPacket())) {
      if (this.current.startTime === 0) {
        this.current.startTime = Date.now();
      }
      if (this.current.bufferingTicks > 0) {
        this.current.bufferingTicks = 0;
        this.setSpeaking(1);
      }
    } else if (this.current.options.voiceDataTimeout === -1 || this.current.bufferingTicks < this.current.options.voiceDataTimeout / (4 * this.current.options.frameDuration)) { // wait for data
      if (++this.current.bufferingTicks === 1) {
        this.setSpeaking(0);
      }
      this.current.pausedTime += 4 * this.current.options.frameDuration;
      this.timestamp = (this.timestamp + 3 * this.current.options.frameSize) >>> 0;
      this.current.timeout = setTimeout(this._send, 4 * this.current.options.frameDuration);
      return;
    } else {
      return this.stopPlaying();
    }

    this.sendAudioFrame(this.current.buffer, this.current.options.frameSize);
    this.current.playTime += this.current.options.frameDuration;
    this.current.timeout = setTimeout(this._send, this.current.startTime + this.current.pausedTime + this.current.playTime - Date.now());
  }

  _sendAudioFrame(frame) {
    if (!this.crypto) {
      return;
    }
    if (frame.length > MAX_FRAME_SIZE) {
      this.emit("error", new Error(`Opus frame too large to send: ${frame.length} > ${MAX_FRAME_SIZE}`));
      return;
    }

    const packet = this._sendPool[this._sendPoolIndex];
    this._sendPoolIndex = (this._sendPoolIndex + 1) % SEND_POOL_SIZE;

    // The RTP header, SSRC included, is already in place at the head of every
    // pooled buffer, so only the two varying fields are rewritten per frame
    packet.writeUInt16BE(this.sequence, 2);
    packet.writeUInt32BE(this.timestamp, 4);

    const length = this.crypto.encrypt(packet, RTP_HEADER_SIZE, frame);
    return this.sendUDPPacket(packet.subarray(0, length));
  }

  /** @deprecated */
  _sendAudioPacket(audio) {
    return this._sendAudioFrame(audio);
  }

  [util.inspect.custom]() {
    return Base.prototype[util.inspect.custom].call(this);
  }

  toString() {
    return `[VoiceConnection ${this.channelID}]`;
  }

  toJSON(props = []) {
    return Base.prototype.toJSON.call(this, [
      "channelID",
      "connecting",
      "current",
      "id",
      "paused",
      "playing",
      "ready",
      "volume",
      ...props,
    ]);
  }
}

VoiceConnection._converterCommand = converterCommand;

module.exports = VoiceConnection;
