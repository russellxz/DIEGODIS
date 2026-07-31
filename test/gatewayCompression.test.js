"use strict";

const Zlib = require("zlib");
const Client = require("../lib/Client");
const Shard = require("../lib/gateway/Shard");
const { Suite } = require("./harness");

/**
 * Discord keeps one continuous compressed stream per connection and flushes it
 * after every gateway message, so frames are produced the same way here
 * @arg {Object} compressor A zlib or zstd compression stream
 * @arg {Array<String>} messages The payloads to frame
 * @arg {Number} flushMode The flush constant to use
 * @returns {Promise<Array<Buffer>>} One buffer per message
 */
async function frameStream(compressor, messages, flushMode) {
  const frames = [];
  for (const message of messages) {
    const chunks = [];
    const onData = (chunk) => chunks.push(chunk);
    compressor.on("data", onData);
    compressor.write(Buffer.from(message));
    await new Promise((resolve) => compressor.flush(flushMode, resolve));
    compressor.off("data", onData);
    frames.push(Buffer.concat(chunks));
  }
  return frames;
}

function stubShard(compress) {
  const client = Object.create(Client.prototype);
  client.options = { compress: compress, maxShards: 1, largeThreshold: 250, intents: 0, autoreconnect: false };
  client.presence = { status: "online", activities: null };
  client.emit = () => {};

  const shard = new Shard(0, client);
  const packets = [];
  shard.onPacket = (packet) => packets.push(packet);
  shard.on("error", () => {});
  return { shard, packets };
}

module.exports = async function run() {
  const suite = new Suite("gateway transport compression");
  suite.start();

  const messages = [];
  for (let i = 0; i < 200; i++) {
    messages.push(JSON.stringify({
      op: 0,
      s: i,
      t: "MESSAGE_CREATE",
      d: { id: `${i}`, content: "lorem ipsum dolor sit amet ".repeat(5), n: i },
    }));
  }
  const rawBytes = messages.reduce((total, m) => total + m.length, 0);
  const inOrder = (packets) => packets.length === messages.length && packets.every((p, i) => p.s === i);
  const intact = (packets) => packets.every((p, i) => p.d.content === JSON.parse(messages[i]).d.content);

  // --- Option normalization ---
  suite.check("compress: true normalizes to zlib-stream",
    new Client("Bot x", { compress: true, restMode: true }).options.compress === "zlib-stream");
  suite.check("compress: \"zstd-stream\" is preserved",
    new Client("Bot x", { compress: "zstd-stream", restMode: true }).options.compress === "zstd-stream");
  suite.check("compress: false stays off",
    new Client("Bot x", { compress: false, restMode: true }).options.compress === false);
  let rejected = false;
  try {
    new Client("Bot x", { compress: "brotli-stream", restMode: true });
  } catch {
    rejected = true;
  }
  suite.check("an unknown compress option is rejected", rejected);

  // --- zstd-stream ---
  if (Zlib.createZstdDecompress) {
    const frames = await frameStream(Zlib.createZstdCompress(), messages, Zlib.constants.ZSTD_e_flush);
    const bytes = frames.reduce((total, f) => total + f.length, 0);

    const { shard, packets } = stubShard("zstd-stream");
    shard._initStreamDecompressor(Zlib.createZstdDecompress());
    for (const frame of frames) {
      shard._onWSMessage(frame);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    suite.check("zstd: every message decoded, in order", inOrder(packets), `${packets.length}/${messages.length}`);
    suite.check("zstd: payloads intact", intact(packets));
    suite.info(`zstd ratio ${(bytes / rawBytes).toFixed(3)} (${rawBytes} -> ${bytes} bytes)`);

    // A WebSocket frame can be split across messages; nothing may be lost
    const split = stubShard("zstd-stream");
    split.shard._initStreamDecompressor(Zlib.createZstdDecompress());
    for (const frame of frames) {
      const half = Math.floor(frame.length / 2);
      split.shard._onWSMessage(frame.subarray(0, half));
      split.shard._onWSMessage(frame.subarray(half));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    suite.check("zstd: split frames reassembled in order", inOrder(split.packets),
      `${split.packets.length}/${messages.length}`);
  } else {
    suite.skip("zstd-stream", "requires Node 22.15.0 or newer");
  }

  // --- zlib-stream ---
  const zlibFrames = await frameStream(Zlib.createDeflate(), messages, Zlib.constants.Z_SYNC_FLUSH);
  const zlibBytes = zlibFrames.reduce((total, f) => total + f.length, 0);

  let ZlibSync;
  try {
    ZlibSync = require("zlib-sync");
  } catch { /* optional accelerator */ }

  if (ZlibSync) {
    const { shard, packets } = stubShard("zlib-stream");
    shard._zlibSync = new ZlibSync.Inflate({ chunkSize: 128 * 1024 });
    for (const frame of zlibFrames) {
      shard._onWSMessage(frame);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    suite.check("zlib (zlib-sync): every message decoded, in order", inOrder(packets),
      `${packets.length}/${messages.length}`);
  } else {
    suite.skip("zlib via zlib-sync", "zlib-sync not installed");
  }

  {
    const { shard, packets } = stubShard("zlib-stream");
    shard._initStreamDecompressor(Zlib.createInflate());
    for (const frame of zlibFrames) {
      shard._onWSMessage(frame);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    suite.check("zlib (built-in fallback): every message decoded, in order", inOrder(packets),
      `${packets.length}/${messages.length}`);
    suite.check("zlib (built-in fallback): payloads intact", intact(packets));
    suite.info(`zlib ratio ${(zlibBytes / rawBytes).toFixed(3)} (${rawBytes} -> ${zlibBytes} bytes)`);
  }

  // --- No compression ---
  {
    const { shard, packets } = stubShard(false);
    for (const message of messages) {
      shard._onWSMessage(Buffer.from(message));
    }
    suite.check("uncompressed: every message decoded, in order", inOrder(packets),
      `${packets.length}/${messages.length}`);
  }

  return suite;
};
