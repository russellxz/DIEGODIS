"use strict";

/**
 * A deliberately tiny test harness: these tests exercise protocol framing and
 * cryptography, so they need real sockets and timers more than they need a
 * framework, and keeping it dependency-free means `npm test` works off a bare
 * clone
 */
class Suite {
  constructor(name) {
    this.name = name;
    this.passed = 0;
    this.failed = 0;
    this.skipped = 0;
  }

  check(name, ok, extra = "") {
    if (ok) {
      this.passed++;
    } else {
      this.failed++;
    }
    console.log(`  ${ok ? "\x1b[32mpass\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${extra ? `  (${extra})` : ""}`);
    return ok;
  }

  info(message) {
    console.log(`        \x1b[90m${message}\x1b[0m`);
  }

  skip(name, reason) {
    this.skipped++;
    console.log(`  \x1b[33mskip\x1b[0m  ${name}${reason ? `  (${reason})` : ""}`);
  }

  start() {
    console.log(`\n\x1b[1m${this.name}\x1b[0m`);
  }
}

module.exports = { Suite };
