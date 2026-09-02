// esbuild bundler for the extension entry and the test entries.
// Usage:
//   node esbuild.js            build src/extension.ts -> dist/extension.js (cjs)
//   node esbuild.js --test     build test/*.test.ts  -> dist-test/*.test.js (cjs)
//   node esbuild.js --watch    watch mode
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const watch = process.argv.includes('--watch');
const buildTests = process.argv.includes('--test');

const bridgeSourceDir = path.resolve(__dirname, '..', 'packages', 'dsh-vscode-bridge');
const bridgeOutputDir = path.resolve(__dirname, 'dist', 'dsh-vscode-bridge');
const bridgeFiles = [
  'package.json',
  'README.md',
  path.join('lib', 'index.js'),
  path.join('lib', 'index.d.ts'),
  path.join('lib', 'client.js'),
  path.join('lib', 'apply-edit.js'),
  path.join('lib', 'apply-edit.d.ts'),
  path.join('lib', 'editor-context.js'),
  path.join('lib', 'editor-context.d.ts'),
];

const base = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: true,
  external: ['vscode'],
  logLevel: 'info',
};

function copyBridgePackage() {
  fs.rmSync(bridgeOutputDir, { recursive: true, force: true });
  for (const relativePath of bridgeFiles) {
    const sourcePath = path.join(bridgeSourceDir, relativePath);
    const outputPath = path.join(bridgeOutputDir, relativePath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.copyFileSync(sourcePath, outputPath);
  }
  console.log(`esbuild: copied DSH bridge to ${path.relative(__dirname, bridgeOutputDir)}`);
}

async function main() {
  const builds = [];
  if (!buildTests) {
    builds.push({
      ...base,
      entryPoints: ['src/extension.ts'],
      outfile: 'dist/extension.js',
    });
  } else {
    const files = fs.readdirSync('test').filter((f) => f.endsWith('.test.ts'));
    for (const file of files) {
      builds.push({
        ...base,
        entryPoints: [path.join('test', file)],
        outfile: path.join('dist-test', file.replace(/\.ts$/, '.js')),
      });
    }
  }
  if (watch) {
    if (!buildTests) copyBridgePackage();
    const ctxs = await Promise.all(builds.map((b) => esbuild.context(b)));
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log('esbuild: watching for changes...');
    return;
  }
  await Promise.all(builds.map((b) => esbuild.build(b)));
  if (!buildTests) copyBridgePackage();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
