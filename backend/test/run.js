'use strict';

const fs = require('fs');
const path = require('path');

const testDir = __dirname;
const files = fs
  .readdirSync(testDir)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

let totalPassed = 0;
let totalFailed = 0;

(async () => {
  for (const file of files) {
    console.log(`\n########## Running ${file} ##########`);
    const mod = require(path.join(testDir, file));
    try {
      const result = await mod.run();
      totalPassed += result.passed;
      totalFailed += result.failed;
    } catch (err) {
      console.error(`Test file ${file} crashed:`, err);
      totalFailed += 1;
    }
  }

  console.log(`\n########## TOTAL: ${totalPassed} passed, ${totalFailed} failed ##########`);
  process.exitCode = totalFailed > 0 ? 1 : 0;
})();
