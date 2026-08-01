"use strict";

const SUITES = [
  "./components.test",
  "./voiceCrypto.test",
  "./gatewayCompression.test",
  "./voiceConnection.test",
];

(async () => {
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const path of SUITES) {
    const suite = await require(path)();
    passed += suite.passed;
    failed += suite.failed;
    skipped += suite.skipped;
  }

  const summary = `${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`;
  console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}${summary}\x1b[0m`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
