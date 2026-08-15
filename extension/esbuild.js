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

const base = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: true,
  external: ['vscode'],
  logLevel: 'info',
};

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
    const ctxs = await Promise.all(builds.map((b) => esbuild.context(b)));
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log('esbuild: watching for changes...');
    return;
  }
  await Promise.all(builds.map((b) => esbuild.build(b)));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
