"use strict";

const Crypto = require("crypto");

/**
 * The AEAD encryption modes supported by Discord's voice gateway, in order of
 * preference. The legacy `xsalsa20_poly1305` family was removed by Discord on
 * 2024-11-18 and is intentionally not implemented.
 *
 * Both modes are "rtpsize" variants: the RTP header (including the CSRC list
 * and the 4 byte extension header, when present) is sent in the clear and
 * authenticated as additional data, and a 32 bit big-endian counter is
 * appended to every packet as the nonce.
 */
const MODE_AES256_GCM = "aead_aes256_gcm_rtpsize";
const MODE_XCHACHA20_POLY1305 = "aead_xchacha20_poly1305_rtpsize";

const SUPPORTED_MODES = [MODE_AES256_GCM, MODE_XCHACHA20_POLY1305];

const TAG_BYTES = 16;
const NONCE_BYTES = 4;
const AES_NONCE_BYTES = 12;
const XCHACHA_NONCE_BYTES = 24;

const MAX_NONCE = 0xFFFFFFFF;

const SIGMA = [0x61707865, 0x3320646E, 0x79622D32, 0x6B206574];
const HCHACHA_INPUT = Buffer.alloc(64);

let Sodium = null;
try {
  Sodium = require("sodium-native");
  if (typeof Sodium.crypto_aead_xchacha20poly1305_ietf_encrypt !== "function") {
    Sodium = null;
  }
} catch {
  Sodium = null;
}

const sodiumHasAES = !!Sodium
  && typeof Sodium.crypto_aead_aes256gcm_encrypt === "function"
  && typeof Sodium.crypto_aead_aes256gcm_is_available === "function"
  && Sodium.crypto_aead_aes256gcm_is_available();

const nodeHasAES = Crypto.getCiphers().includes("aes-256-gcm");
const nodeHasChaCha = Crypto.getCiphers().includes("chacha20-poly1305") && Crypto.getCiphers().includes("chacha20");

/**
 * Derive an XChaCha20 subkey from a 256 bit key and a 128 bit nonce.
 *
 * Node has no `xchacha20-poly1305` cipher, but XChaCha20 is defined as
 * ChaCha20 keyed with `HChaCha20(key, nonce[0..16])`, and HChaCha20 can be
 * recovered from a raw ChaCha20 keystream block: OpenSSL's `chacha20` cipher
 * maps its 16 byte IV directly onto state words 12-15, so subtracting the
 * initial state from the keystream yields the unmodified working state that
 * HChaCha20 is specified to output. Verified against the RFC test vectors.
 * @arg {Buffer} key The 32 byte key
 * @arg {Buffer} nonce The first 16 bytes of the 24 byte nonce
 * @returns {Buffer} The 32 byte subkey
 */
function hchacha20(key, nonce) {
  const keystream = Crypto.createCipheriv("chacha20", key, nonce).update(HCHACHA_INPUT);
  const subkey = Buffer.allocUnsafe(32);
  for (let i = 0; i < 4; i++) {
    subkey.writeUInt32LE((keystream.readUInt32LE(i * 4) - SIGMA[i]) >>> 0, i * 4);
    subkey.writeUInt32LE((keystream.readUInt32LE(48 + i * 4) - nonce.readUInt32LE(i * 4)) >>> 0, 16 + i * 4);
  }
  return subkey;
}

/**
 * Handles encryption and decryption of RTP voice packets
 * @prop {String} mode The negotiated encryption mode
 * @prop {Boolean} native Whether a native (libsodium) backend is in use
 */
class VoiceCrypto {
  /**
   * @arg {String} mode The encryption mode to use, as negotiated with the voice gateway
   * @arg {Buffer | Array<Number>} secretKey The 32 byte secret key from the session description
   */
  constructor(mode, secretKey) {
    if (!SUPPORTED_MODES.includes(mode)) {
      throw new Error(`Unsupported voice encryption mode: ${mode}`);
    }

    this.mode = mode;
    this.key = Buffer.isBuffer(secretKey) ? secretKey : Buffer.from(secretKey);
    if (this.key.length !== 32) {
      throw new Error(`Invalid voice secret key length: ${this.key.length}`);
    }

    this._aes = mode === MODE_AES256_GCM;
    this._nonce = 0;
    // Nonce buffers are reused across packets. Only the leading 4 bytes ever
    // change, so the zero padding is written once here.
    this._sendNonce = Buffer.alloc(this._aes ? AES_NONCE_BYTES : XCHACHA_NONCE_BYTES);
    this._recvNonce = Buffer.alloc(this._aes ? AES_NONCE_BYTES : XCHACHA_NONCE_BYTES);

    if (Sodium && (!this._aes || sodiumHasAES)) {
      this.native = true;
      this._seal = this._aes ? this._sealSodiumAES : this._sealSodiumXChaCha;
      this._open = this._aes ? this._openSodiumAES : this._openSodiumXChaCha;
    } else {
      this.native = false;
      this._seal = this._aes ? this._sealNodeAES : this._sealNodeXChaCha;
      this._open = this._aes ? this._openNodeAES : this._openNodeXChaCha;
      if (!this._aes) {
        // Reused across packets so the hot path stays allocation-free. The
        // counter sits in the first 16 nonce bytes, so the subkey still has to
        // be rederived per packet.
        this._subNonce = Buffer.alloc(12);
        this._recvSubNonce = Buffer.alloc(12);
      }
    }
  }

  /**
   * Decrypt a received RTP packet
   * @arg {Buffer} packet The full packet, including the RTP header and trailing nonce
   * @arg {Number} headerSize The size of the unencrypted RTP header, in bytes
   * @returns {Buffer?} The decrypted payload, or null if authentication failed
   */
  decrypt(packet, headerSize) {
    if (packet.length < headerSize + TAG_BYTES + NONCE_BYTES) {
      return null;
    }

    packet.copy(this._recvNonce, 0, packet.length - NONCE_BYTES);

    const ciphertext = packet.subarray(headerSize, packet.length - NONCE_BYTES);
    const header = packet.subarray(0, headerSize);

    try {
      return this._open(ciphertext, header);
    } catch {
      return null;
    }
  }

  /**
   * Encrypt an Opus frame in place. The RTP header must already be written to
   * the first `headerSize` bytes of `packet`; the ciphertext, authentication
   * tag and nonce are appended after it
   * @arg {Buffer} packet The packet buffer to write into
   * @arg {Number} headerSize The size of the RTP header, in bytes
   * @arg {Buffer} frame The Opus frame to encrypt
   * @returns {Number} The total length of the finished packet
   */
  encrypt(packet, headerSize, frame) {
    this._nonce = this._nonce === MAX_NONCE ? 0 : this._nonce + 1;
    this._sendNonce.writeUInt32BE(this._nonce, 0);

    const header = packet.subarray(0, headerSize);
    const length = this._seal(packet, headerSize, frame, header);

    packet.writeUInt32BE(this._nonce, headerSize + length);
    return headerSize + length + NONCE_BYTES;
  }

  _openNodeAES(ciphertext, header) {
    const decipher = Crypto.createDecipheriv("aes-256-gcm", this.key, this._recvNonce);
    decipher.setAAD(header);
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_BYTES));
    const data = decipher.update(ciphertext.subarray(0, ciphertext.length - TAG_BYTES));
    decipher.final();
    return data;
  }

  _openNodeXChaCha(ciphertext, header) {
    const subkey = hchacha20(this.key, this._recvNonce.subarray(0, 16));
    this._recvSubNonce.fill(0, 0, 4);
    this._recvNonce.copy(this._recvSubNonce, 4, 16, 24);

    const decipher = Crypto.createDecipheriv("chacha20-poly1305", subkey, this._recvSubNonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(header, { plaintextLength: ciphertext.length - TAG_BYTES });
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_BYTES));
    const data = decipher.update(ciphertext.subarray(0, ciphertext.length - TAG_BYTES));
    decipher.final();
    return data;
  }

  _openSodiumAES(ciphertext, header) {
    const data = Buffer.allocUnsafe(ciphertext.length - TAG_BYTES);
    Sodium.crypto_aead_aes256gcm_decrypt(data, null, ciphertext, header, this._recvNonce, this.key);
    return data;
  }

  _openSodiumXChaCha(ciphertext, header) {
    const data = Buffer.allocUnsafe(ciphertext.length - TAG_BYTES);
    Sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(data, null, ciphertext, header, this._recvNonce, this.key);
    return data;
  }

  _sealNodeAES(packet, headerSize, frame, header) {
    const cipher = Crypto.createCipheriv("aes-256-gcm", this.key, this._sendNonce);
    cipher.setAAD(header);
    const written = cipher.update(frame).copy(packet, headerSize);
    cipher.final();
    cipher.getAuthTag().copy(packet, headerSize + written);
    return written + TAG_BYTES;
  }

  _sealNodeXChaCha(packet, headerSize, frame, header) {
    // XChaCha20-Poly1305 is ChaCha20-Poly1305 under a subkey derived from the
    // first 16 nonce bytes, with the remaining 8 forming the sub-nonce
    const subkey = hchacha20(this.key, this._sendNonce.subarray(0, 16));
    this._sendNonce.copy(this._subNonce, 4, 16, 24);

    const cipher = Crypto.createCipheriv("chacha20-poly1305", subkey, this._subNonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(header, { plaintextLength: frame.length });
    const written = cipher.update(frame).copy(packet, headerSize);
    cipher.final();
    cipher.getAuthTag().copy(packet, headerSize + written);
    return written + TAG_BYTES;
  }

  _sealSodiumAES(packet, headerSize, frame, header) {
    const out = packet.subarray(headerSize, headerSize + frame.length + TAG_BYTES);
    Sodium.crypto_aead_aes256gcm_encrypt(out, frame, header, null, this._sendNonce, this.key);
    return out.length;
  }

  _sealSodiumXChaCha(packet, headerSize, frame, header) {
    const out = packet.subarray(headerSize, headerSize + frame.length + TAG_BYTES);
    Sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(out, frame, header, null, this._sendNonce, this.key);
    return out.length;
  }

  /**
   * Pick the best mutually supported encryption mode
   * @arg {Array<String>} available The modes offered by the voice gateway
   * @arg {String} [preferred] A mode to use if the gateway offers it
   * @returns {String?} The chosen mode, or null if there is no overlap
   */
  static negotiate(available, preferred) {
    if (preferred) {
      if (!SUPPORTED_MODES.includes(preferred)) {
        throw new Error(`Unsupported voice encryption mode: ${preferred}. Supported modes: ${SUPPORTED_MODES.join(", ")}`);
      }
      if (available && available.includes(preferred)) {
        return preferred;
      }
    }
    if (!available) {
      return null;
    }
    return VoiceCrypto.supportedModes.find((mode) => available.includes(mode)) || null;
  }

  toString() {
    return `[VoiceCrypto ${this.mode}${this.native ? " native" : ""}]`;
  }
}

/**
 * The overhead added to every Opus frame, in bytes (auth tag + nonce)
 */
VoiceCrypto.OVERHEAD = TAG_BYTES + NONCE_BYTES;
/**
 * The encryption modes supported by this build, in order of preference
 */
VoiceCrypto.supportedModes = SUPPORTED_MODES.filter((mode) => {
  if (mode === MODE_AES256_GCM) {
    return nodeHasAES || sodiumHasAES;
  }
  return nodeHasChaCha || !!Sodium;
});

module.exports = VoiceCrypto;
