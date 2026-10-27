const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
async function build() {
  const root = path.resolve(__dirname, '..');
  await esbuild.build({
    entryPoints: [path.join(root, 'src/extension.cjs')],
    outfile: path.join(root, 'dist/extension.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
    logLevel: 'info',
  });
  const library = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const vendor = path.join(root, 'vendor/pdfjs');
  fs.mkdirSync(vendor, { recursive: true });
  for (const name of [
    'build/pdf.mjs',
    'build/pdf.worker.mjs',
    'web/pdf_viewer.css',
    'cmaps',
    'standard_fonts',
    'wasm',
    'LICENSE',
  ]) {
    const dest = path.join(vendor, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(path.join(library, name), dest, { recursive: true });
  }
  fs.copyFileSync(
    path.join(root, 'node_modules/pdf-lib/LICENSE.md'),
    path.join(root, 'vendor/pdf-lib-LICENSE.md'),
  );
  fs.copyFileSync(path.join(root, 'node_modules/ws/LICENSE'), path.join(root, 'vendor/ws-LICENSE'));
}
build().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
