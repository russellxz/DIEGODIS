"use strict";

const ChildProcess = require("child_process");
const Crypto = require("crypto");
const Dgram = require("dgram");
const Fs = require("fs");
const Https = require("https");
const Os = require("os");
const Path = require("path");
const { WebSocketServer } = require("ws");

const VoiceConnection = require("../lib/voice/VoiceConnection");
const VoiceCrypto = require("../lib/voice/VoiceCrypto");
const { Suite } = require("./harness");

const SSRC = 987654321;

/**
 * The voice gateway is only reachable over wss, so the stand-in server needs a
 * certificate. It is generated per run into a temp directory rather than
 * committed, and the test is skipped when openssl is unavailable
 * @returns {Object?} The key and certificate, or null if they cannot be made
 */
function generateCertificate() {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "eris-voice-test-"));
  const keyPath = Path.join(dir, "key.pem");
  const certPath = Path.join(dir, "cert.pem");
  const result = ChildProcess.spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048",
    "-keyout", keyPath, "-out", certPath,
    "-days", "1", "-nodes",
    "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1",
  ], { stdio: "ignore" });

  if (result.error || result.status !== 0) {
    Fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }
  return {
    key: Fs.readFileSync(keyPath),
    cert: Fs.readFileSync(certPath),
    cleanup: () => Fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Stands in for Discord's voice gateway and media server: speaks voice gateway
 * v8 over wss and answers IP discovery over UDP
 * @arg {Object} certificate The TLS key and certificate to serve with
 * @arg {Array<String>} offeredModes The encryption modes to advertise in READY
 * @arg {Buffer} secret The session secret key to hand out
 * @returns {Promise<Object>} The running server
 */
async function startVoiceServer(certificate, offeredModes, secret) {
  const udp = Dgram.createSocket("udp4");
  await new Promise((resolve) => udp.bind(0, "127.0.0.1", resolve));

  const server = Https.createServer({ key: certificate.key, cert: certificate.cert });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const wss = new WebSocketServer({ server });

  const state = {
    identify: null,
    selectProtocol: null,
    heartbeats: [],
    resumes: [],
    seq: 0,
    client: null,
    packets: [],
    port: server.address().port,
  };

  wss.on("connection", (ws) => {
    state.ws = ws;
    const send = (op, d, sequenced) => {
      const payload = { op, d };
      if (sequenced) {
        payload.seq = state.seq++;
      }
      ws.send(JSON.stringify(payload));
    };
    send(8, { heartbeat_interval: 15000 });
    ws.on("message", (raw) => {
      const packet = JSON.parse(raw);
      switch (packet.op) {
        case 0:
          state.identify = packet.d;
          send(2, { ssrc: SSRC, ip: "127.0.0.1", port: udp.address().port, modes: offeredModes }, true);
          break;
        case 1:
          state.selectProtocol = packet.d;
          send(4, { mode: packet.d.data.mode, secret_key: [...secret] }, true);
          break;
        case 3:
          state.heartbeats.push(packet.d);
          send(6, { t: packet.d && packet.d.t });
          break;
        case 7:
          state.resumes.push(packet.d);
          send(9, {}, true);
          break;
      }
    });
  });

  udp.on("message", (msg, rinfo) => {
    if (msg.length === 74 && msg.readUInt16BE(0) === 0x1) {
      state.client = rinfo;
      const response = Buffer.alloc(74);
      response.writeUInt16BE(0x2, 0);
      response.writeUInt16BE(70, 2);
      response.writeUInt32BE(SSRC, 4);
      response.write("127.0.0.1", 8, "ascii");
      response.writeUInt16BE(rinfo.port, 72);
      udp.send(response, rinfo.port, rinfo.address);
      return;
    }
    if (msg.length === 4) {
      return; // keep-alive
    }
    state.packets.push(Buffer.from(msg));
  });

  state.send = (packet) => udp.send(packet, state.client.port, state.client.address);
  state.close = () => {
    wss.close();
    server.close();
    udp.close();
  };
  return state;
}

async function testMode(suite, certificate, offeredModes, expectedMode) {
  const secret = Crypto.randomBytes(32);
  const server = await startVoiceServer(certificate, offeredModes, secret);
  const connection = new VoiceConnection("test-guild", { shard: {}, opusOnly: true });
  connection.on("error", () => {});

  try {
    const ready = new Promise((resolve, reject) => {
      connection.once("ready", resolve);
      connection.once("disconnect", (err) => reject(err || new Error("disconnected")));
      setTimeout(() => reject(new Error("timed out waiting for ready")), 8000);
    });
    connection.connect({
      endpoint: `127.0.0.1:${server.port}`,
      token: "token",
      session_id: "session",
      user_id: "42",
      channel_id: "channel",
    });
    await ready;

    suite.check(`${expectedMode}: handshake completes`, connection.ready);
    suite.check(`${expectedMode}: negotiates the expected mode`, connection.mode === expectedMode, connection.mode);
    suite.check(`${expectedMode}: SELECT_PROTOCOL announces the negotiated mode`,
      server.selectProtocol.data.mode === expectedMode);
    suite.check(`${expectedMode}: IP discovery reports the real external port`,
      server.selectProtocol.data.port === server.client.port);
    suite.check(`${expectedMode}: heartbeats use the v8 {t, seq_ack} form`,
      server.heartbeats.length > 0
      && typeof server.heartbeats[0].t === "number"
      && "seq_ack" in server.heartbeats[0],
      JSON.stringify(server.heartbeats[0]));
    suite.check(`${expectedMode}: tracks the gateway sequence for resuming`, connection._seq >= 0,
      `seq ${connection._seq}`);

    // --- Sending ---
    server.packets.length = 0;
    const frames = [];
    for (let i = 0; i < 20; i++) {
      const frame = Crypto.randomBytes(100 + i);
      frames.push(frame);
      connection.sendAudioFrame(frame, 960);
      await new Promise((resolve) => setImmediate(resolve));
    }
    await new Promise((resolve) => setTimeout(resolve, 250));

    const receiver = new VoiceCrypto(expectedMode, secret);
    let decrypted = 0;
    let matched = 0;
    let sequenceOK = true;
    let timestampOK = true;
    let ssrcOK = true;
    const firstSequence = server.packets.length ? server.packets[0].readUInt16BE(2) : 0;
    const firstTimestamp = server.packets.length ? server.packets[0].readUInt32BE(4) : 0;
    server.packets.forEach((packet, i) => {
      if (packet.readUInt32BE(8) !== SSRC) {
        ssrcOK = false;
      }
      if (packet.readUInt16BE(2) !== ((firstSequence + i) & 0xFFFF)) {
        sequenceOK = false;
      }
      if (packet.readUInt32BE(4) !== ((firstTimestamp + i * 960) >>> 0)) {
        timestampOK = false;
      }
      const out = receiver.decrypt(packet, 12);
      if (out) {
        decrypted++;
        if (frames.some((frame) => frame.equals(out))) {
          matched++;
        }
      }
    });
    suite.check(`${expectedMode}: every sent packet decrypts`, decrypted === server.packets.length,
      `${decrypted}/${server.packets.length}`);
    suite.check(`${expectedMode}: sent payloads arrive intact`, matched === frames.length,
      `${matched}/${frames.length}`);
    suite.check(`${expectedMode}: RTP ssrc is correct`, ssrcOK);
    suite.check(`${expectedMode}: RTP sequence increments by one`, sequenceOK);
    suite.check(`${expectedMode}: RTP timestamp increments by the frame size`, timestampOK);

    // dgram does not copy what it is handed, so a burst inside one tick would
    // corrupt earlier packets if the send buffer were shared
    server.packets.length = 0;
    const burst = [];
    for (let i = 0; i < 5; i++) {
      const frame = Crypto.randomBytes(50 + i);
      burst.push(frame);
      connection.sendAudioFrame(frame, 960);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    const burstReceiver = new VoiceCrypto(expectedMode, secret);
    let burstOK = 0;
    server.packets.forEach((packet) => {
      const out = burstReceiver.decrypt(packet, 12);
      if (out && burst.some((frame) => frame.equals(out))) {
        burstOK++;
      }
    });
    suite.check(`${expectedMode}: a same-tick burst is not clobbered`, burstOK === burst.length,
      `${burstOK}/${burst.length}`);

    // --- Receiving ---
    const sender = new VoiceCrypto(expectedMode, secret);
    const voice = connection;
    voice.ssrcUserMap[SSRC] = "user-1";
    const stream = voice.receive("opus");
    const received = [];
    stream.on("data", (data, userID, timestamp, sequence) => received.push({ data, userID, timestamp, sequence }));

    const plain = Crypto.randomBytes(80);
    const simple = Buffer.allocUnsafe(12 + plain.length + VoiceCrypto.OVERHEAD);
    simple[0] = 0x80;
    simple[1] = 0x78;
    simple.writeUInt16BE(7, 2);
    simple.writeUInt32BE(4800, 4);
    simple.writeUInt32BE(SSRC, 8);
    server.send(simple.subarray(0, sender.encrypt(simple, 12, plain)));

    // Discord attaches an RFC 5285 header extension to received audio
    const extensionBody = Crypto.randomBytes(8);
    const audio = Crypto.randomBytes(60);
    const inner = Buffer.concat([extensionBody, audio]);
    const extended = Buffer.allocUnsafe(16 + inner.length + VoiceCrypto.OVERHEAD);
    extended[0] = 0x90; // extension bit set
    extended[1] = 0x78;
    extended.writeUInt16BE(8, 2);
    extended.writeUInt32BE(5760, 4);
    extended.writeUInt32BE(SSRC, 8);
    extended.writeUInt16BE(0xBEDE, 12);
    extended.writeUInt16BE(2, 14); // two 32-bit words of extension body
    server.send(extended.subarray(0, sender.encrypt(extended, 16, inner)));

    await new Promise((resolve) => setTimeout(resolve, 300));
    suite.check(`${expectedMode}: receives both packets`, received.length === 2, `${received.length}/2`);
    suite.check(`${expectedMode}: decrypts and attributes a received packet`,
      !!received[0] && received[0].data.equals(plain) && received[0].userID === "user-1"
      && received[0].timestamp === 4800 && received[0].sequence === 7);
    suite.check(`${expectedMode}: strips the RTP header extension`,
      !!received[1] && received[1].data.equals(audio),
      received[1] ? `${received[1].data.length} vs ${audio.length} bytes` : "not received");

    server.send(Crypto.randomBytes(60));
    server.send(Buffer.alloc(8));
    await new Promise((resolve) => setTimeout(resolve, 200));
    suite.check(`${expectedMode}: undecryptable packets are dropped, not emitted`, received.length === 2,
      `${received.length}/2`);

    // --- Resuming after the socket drops underneath us ---
    const lastSeq = connection._seq;
    const resumed = new Promise((resolve) => connection.once("resumed", resolve));
    server.ws.terminate();
    await Promise.race([resumed, new Promise((resolve) => setTimeout(() => resolve("timeout"), 8000))]);

    suite.check(`${expectedMode}: resumes after an unexpected close`, connection.ready && !connection.resuming);
    suite.check(`${expectedMode}: RESUME carries the last sequence`,
      server.resumes.length > 0 && server.resumes[0].seq_ack === lastSeq,
      server.resumes.length ? `seq_ack ${server.resumes[0].seq_ack}, last seen ${lastSeq}` : "no resume sent");
    suite.check(`${expectedMode}: only one reconnect attempt was made`, server.resumes.length === 1,
      `${server.resumes.length} resumes`);

    // Audio must still flow on the resumed session
    server.packets.length = 0;
    const afterResume = Crypto.randomBytes(70);
    connection.sendAudioFrame(afterResume, 960);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const resumeReceiver = new VoiceCrypto(expectedMode, secret);
    suite.check(`${expectedMode}: audio still sends after resuming`,
      server.packets.some((packet) => {
        const out = resumeReceiver.decrypt(packet, 12);
        return out && out.equals(afterResume);
      }), `${server.packets.length} packets seen`);
  } finally {
    connection.disconnect(undefined, false);
    connection._destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    server.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

module.exports = async function run() {
  const suite = new Suite("voice connection (against a stand-in voice gateway)");
  suite.start();

  const certificate = generateCertificate();
  if (!certificate) {
    suite.skip("voice gateway handshake", "openssl is needed to generate a test certificate");
    return suite;
  }

  // The stand-in server uses a self-signed certificate
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const warningListener = (warning) => warning.name === "Warning" && warning.message.includes("NODE_TLS_REJECT_UNAUTHORIZED");
  process.on("warning", warningListener);

  try {
    await testMode(suite, certificate,
      ["aead_aes256_gcm_rtpsize", "aead_xchacha20_poly1305_rtpsize", "xsalsa20_poly1305"],
      "aead_aes256_gcm_rtpsize");
    await testMode(suite, certificate,
      ["aead_xchacha20_poly1305_rtpsize", "xsalsa20_poly1305_lite"],
      "aead_xchacha20_poly1305_rtpsize");
  } finally {
    process.off("warning", warningListener);
    if (previous === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
    }
    certificate.cleanup();
  }

  return suite;
};
