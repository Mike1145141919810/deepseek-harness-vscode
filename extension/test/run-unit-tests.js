// Runs the compiled unit/integration tests without relying on `node --test`
// directory or glob arguments (directory args broke on Node 24, glob args on
// older Node). Passes one explicit file per invocation, supported since the
// node:test runner shipped.
//
// smoke.test.js is intentionally excluded here: it needs the VS Code extension
// host and is executed by `npm run test:smoke`.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const distDir = path.resolve(__dirname, '..', 'dist-test');
const files = fs
  .readdirSync(distDir)
  .filter((f) => f.endsWith('.test.js'))
  .filter((f) => f !== 'smoke.test.js')
  .sort();

if (files.length === 0) {
  console.error('No compiled tests found in dist-test/; run `npm run compile:tests` first.');
  process.exit(1);
}

let failures = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--test', path.join(distDir, file)], {
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`Failed to launch ${file}: ${result.error.message}`);
    failures += 1;
  } else if (result.status !== 0) {
    failures += 1;
  }
}

if (failures > 0) {
  console.error(`${failures} of ${files.length} test file(s) failed.`);
  process.exit(1);
}
console.log(`All ${files.length} test file(s) passed.`);
