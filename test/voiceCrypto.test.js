"use strict";

const Crypto = require("crypto");
const VoiceCrypto = require("../lib/voice/VoiceCrypto");
const { Suite } = require("./harness");

// draft-irtf-cfrg-xchacha20poly1305-03, appendix A.3
const RFC_KEY = Buffer.from("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f", "hex");
const RFC_NONCE = Buffer.from("404142434445464748494a4b4c4d4e4f5051525354555657", "hex");
const RFC_AAD = Buffer.from("50515253c0c1c2c3c4c5c6c7", "hex");
const RFC_PLAINTEXT = Buffer.from("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
const RFC_CIPHERTEXT = "bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b4522f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff921f9664c97637da9768812f615c68b13b52ec0875924c1c7987947deafd8780acf49";

module.exports = async function run() {
  const suite = new Suite("voice encryption");
  suite.start();

  suite.check("both Discord AEAD modes are supported",
    VoiceCrypto.supportedModes.includes("aead_aes256_gcm_rtpsize")
    && VoiceCrypto.supportedModes.includes("aead_xchacha20_poly1305_rtpsize"),
    VoiceCrypto.supportedModes.join(", "));

  // Mode negotiation
  suite.check("prefers AES-GCM when offered both",
    VoiceCrypto.negotiate(["aead_xchacha20_poly1305_rtpsize", "aead_aes256_gcm_rtpsize"]) === "aead_aes256_gcm_rtpsize");
  suite.check("falls back to XChaCha20 when AES-GCM is not offered",
    VoiceCrypto.negotiate(["aead_xchacha20_poly1305_rtpsize", "xsalsa20_poly1305"]) === "aead_xchacha20_poly1305_rtpsize");
  suite.check("rejects removed legacy-only modes",
    VoiceCrypto.negotiate(["xsalsa20_poly1305", "xsalsa20_poly1305_suffix"]) === null);
  suite.check("honours a supported preference",
    VoiceCrypto.negotiate(["aead_aes256_gcm_rtpsize", "aead_xchacha20_poly1305_rtpsize"], "aead_xchacha20_poly1305_rtpsize")
    === "aead_xchacha20_poly1305_rtpsize");
  let threw = false;
  try {
    VoiceCrypto.negotiate(["aead_aes256_gcm_rtpsize"], "xsalsa20_poly1305");
  } catch {
    threw = true;
  }
  suite.check("throws on an unsupported preference", threw);

  // XChaCha20-Poly1305 is derived from Node's ChaCha20 primitives, so pin it to
  // the specification's own vector rather than only round-tripping against itself
  {
    const key = RFC_KEY;
    const crypto = new VoiceCrypto("aead_xchacha20_poly1305_rtpsize", key);
    const packet = Buffer.allocUnsafe(RFC_AAD.length + RFC_PLAINTEXT.length + VoiceCrypto.OVERHEAD);
    RFC_AAD.copy(packet, 0);
    // Drive the internal nonce to the RFC's value: the first 4 bytes are the
    // counter and the rest must stay zero, so only a matching counter is testable
    crypto._sendNonce = Buffer.from(RFC_NONCE);
    const length = crypto._sealNodeXChaCha(packet, RFC_AAD.length, RFC_PLAINTEXT, packet.subarray(0, RFC_AAD.length));
    const produced = packet.subarray(RFC_AAD.length, RFC_AAD.length + length).toString("hex");
    suite.check("XChaCha20-Poly1305 matches the RFC test vector", produced === RFC_CIPHERTEXT);
  }

  // Round-trip both modes over a wide range of frame sizes
  const key = Crypto.randomBytes(32);
  for (const mode of VoiceCrypto.supportedModes) {
    const tx = new VoiceCrypto(mode, key);
    const rx = new VoiceCrypto(mode, key);
    let ok = true;
    let lengthOK = true;
    for (let i = 0; i < 1500 && ok; i++) {
      const frame = Crypto.randomBytes(1 + (i % 1000));
      const packet = Buffer.allocUnsafe(12 + frame.length + VoiceCrypto.OVERHEAD);
      packet[0] = 0x80;
      packet[1] = 0x78;
      packet.writeUInt16BE(i & 0xFFFF, 2);
      packet.writeUInt32BE((i * 960) >>> 0, 4);
      packet.writeUInt32BE(1234567, 8);
      const length = tx.encrypt(packet, 12, frame);
      if (length !== packet.length) {
        lengthOK = false;
      }
      const out = rx.decrypt(packet.subarray(0, length), 12);
      ok = !!out && out.equals(frame);
    }
    suite.check(`${mode}: round-trips 1500 frames`, ok);
    suite.check(`${mode}: packet length is header + frame + overhead`, lengthOK);

    // Tampering must be rejected in both the payload and the authenticated header
    const frame = Crypto.randomBytes(120);
    const packet = Buffer.alloc(12 + frame.length + VoiceCrypto.OVERHEAD);
    packet[0] = 0x80;
    packet[1] = 0x78;
    const length = tx.encrypt(packet, 12, frame);

    const payloadTamper = Buffer.from(packet.subarray(0, length));
    payloadTamper[20] ^= 0xFF;
    suite.check(`${mode}: rejects a tampered payload`, rx.decrypt(payloadTamper, 12) === null);

    const headerTamper = Buffer.from(packet.subarray(0, length));
    headerTamper[8] ^= 0x01;
    suite.check(`${mode}: rejects a tampered RTP header`, rx.decrypt(headerTamper, 12) === null);

    const truncated = Buffer.from(packet.subarray(0, 12 + 8));
    suite.check(`${mode}: rejects a truncated packet`, rx.decrypt(truncated, 12) === null);

    const wrongKey = new VoiceCrypto(mode, Crypto.randomBytes(32));
    suite.check(`${mode}: rejects a packet encrypted under another key`,
      wrongKey.decrypt(packet.subarray(0, length), 12) === null);

    // Out-of-order delivery is normal over UDP and must still decrypt
    const a = Buffer.allocUnsafe(12 + 40 + VoiceCrypto.OVERHEAD);
    const b = Buffer.allocUnsafe(12 + 40 + VoiceCrypto.OVERHEAD);
    a.fill(0);
    b.fill(0);
    const fa = Crypto.randomBytes(40);
    const fb = Crypto.randomBytes(40);
    const la = tx.encrypt(a, 12, fa);
    const lb = tx.encrypt(b, 12, fb);
    const outB = rx.decrypt(b.subarray(0, lb), 12);
    const outA = rx.decrypt(a.subarray(0, la), 12);
    suite.check(`${mode}: decrypts out-of-order packets`,
      !!outA && !!outB && outA.equals(fa) && outB.equals(fb));
    suite.check(`${mode}: nonce increments per packet`,
      b.readUInt32BE(lb - 4) === a.readUInt32BE(la - 4) + 1);
  }

  // Constructor validation
  let badKey = false;
  try {
    new VoiceCrypto("aead_aes256_gcm_rtpsize", Buffer.alloc(16));
  } catch {
    badKey = true;
  }
  suite.check("rejects a secret key of the wrong length", badKey);

  let badMode = false;
  try {
    new VoiceCrypto("xsalsa20_poly1305", Crypto.randomBytes(32));
  } catch {
    badMode = true;
  }
  suite.check("rejects a removed encryption mode", badMode);

  // Throughput, as a guard against a pathologically slow backend
  for (const mode of VoiceCrypto.supportedModes) {
    const crypto = new VoiceCrypto(mode, key);
    const frame = Crypto.randomBytes(960);
    const packet = Buffer.allocUnsafe(12 + frame.length + VoiceCrypto.OVERHEAD);
    const iterations = 20000;
    crypto.encrypt(packet, 12, frame);
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
      crypto.encrypt(packet, 12, frame);
    }
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    const perSecond = Math.round(iterations / seconds);
    // A voice stream is 50 packets a second, so this is a very low bar
    suite.check(`${mode}: sustains well over one stream`, perSecond > 5000,
      `${perSecond.toLocaleString()} packets/s, ~${Math.round(perSecond / 50).toLocaleString()} streams/core`);
  }

  return suite;
};
