const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function environment() {
  const manifest = path.resolve(__dirname, '../../output/test-env.json');
  return fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8')) : {};
}
function nativeOptions() {
  const saved = environment();
  let binary = process.env.NOTEBOOK_TINYMIST_BINARY || saved.binary;
  if (!binary) {
    const dir =
      process.env.NOTEBOOK_EXTENSIONS_DIR || path.join(os.homedir(), '.vscode/extensions');
    const tiny = fs
      .readdirSync(dir)
      .filter((n) => /^myriad-dreamin\.tinymist-/.test(n))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
    if (tiny)
      binary = path.join(
        dir,
        tiny,
        'out',
        process.platform === 'win32' ? 'tinymist.exe' : 'tinymist',
      );
  }
  if (!binary || !fs.existsSync(binary))
    throw Error('缺少测试用 Tinymist。请先运行 npm run test:prepare。');
  const fontPaths = process.env.NOTEBOOK_FONT_PATHS
    ? JSON.parse(process.env.NOTEBOOK_FONT_PATHS)
    : saved.fontPaths || [];
  return { binary, fontPaths };
}
module.exports = { environment, nativeOptions };
