// Loaded by the VS Code extension host as the extensionTestsPath module.
// Modern VS Code removed the built-in mocha globals: the host now calls the
// exported run() function, which owns its own Mocha instance (resolved from
// the extension's node_modules) and executes the compiled smoke suite.
const Mocha = require('mocha');
const path = require('path');

exports.run = async function run() {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 120000 });
  mocha.addFile(path.resolve(__dirname, '..', 'dist-test', 'smoke.test.js'));
  return new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) reject(new Error(`${failures} smoke test(s) failed`));
      else resolve();
    });
  });
};
