// Copies source and the same VSIX into an isolated WSL ext4 workspace.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const project = path.resolve(__dirname, '..');
const prefix = process.argv[2] ? ['-d', process.argv[2]] : [];
const quote = (s) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
function wsl(command) {
  return execFileSync('wsl', [...prefix, '--', 'bash', '-c', command], { encoding: 'utf8' }).trim();
}
async function copy(args, destination) {
  await new Promise((resolve, reject) => {
    const pack = spawn('tar', args, {
      cwd: project,
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
    });
    const unpack = spawn(
      'wsl',
      [
        ...prefix,
        '--',
        'bash',
        '-c',
        `mkdir -p ${quote(destination)}; tar -xf - -C ${quote(destination)}`,
      ],
      { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true },
    );
    pack.stdout.pipe(unpack.stdin);
    const statuses = [];
    for (const child of [pack, unpack]) {
      child.on('error', reject);
      child.on('exit', (code) => {
        statuses.push(code);
        if (statuses.length === 2)
          statuses.some(Boolean) ? reject(Error('WSL copy failed')) : resolve();
      });
    }
  });
}
async function main() {
  if (process.platform !== 'win32') throw Error('Run this helper from Windows.');
  const root = wsl(
    'mkdir -p "$HOME/.cache/typst-note/workspaces"; mktemp -d "$HOME/.cache/typst-note/workspaces/run-XXXXXX"',
  );
  if (!/^\/[\w/.-]+\/typst-note\/workspaces\/run-[A-Za-z0-9]+$/.test(root))
    throw Error('Invalid WSL workspace');
  console.log('WSL workspace: ' + root);
  await copy(
    [
      '-cf',
      '-',
      '--exclude=./node_modules',
      '--exclude=./output',
      '--exclude=./vendor',
      '--exclude=./dist',
      '--exclude=./.git',
      '--exclude=./.vscode-test',
      '.',
    ],
    root,
  );
  const pkg = require('../package.json');
  await copy(['-cf', '-', `output/${pkg.name}-${pkg.version}.vsix`], root);
  const fonts = ['NotoSerifSC-VF.ttf', 'NotoSansSC-VF.ttf'];
  const fontRoot = path.join(process.env.WINDIR, 'Fonts');
  const localFonts = fonts.every((name) => fs.existsSync(path.join(fontRoot, name)));
  if (localFonts) await copy(['-C', fontRoot, '-cf', '-', ...fonts], root + '/test-fonts');
  const command = `set -euo pipefail
export PATH="$HOME/.cache/typst-note/runtime/node-v24.22.1-linux-x64/bin:$PATH"
export NOTEBOOK_TEST_CACHE="$HOME/.cache/typst-note/test-cache"
export NOTEBOOK_TEST_PROXY="\${HTTPS_PROXY:-\${https_proxy:-}}"
cd ${quote(root)}
${localFonts ? 'export NOTEBOOK_FONT_PATHS=' + quote(JSON.stringify([root + '/test-fonts'])) : ''}
npm ci > output/npm-ci.log 2>&1 || { cat output/npm-ci.log; exit 1; }
npm run test:prepare > output/prepare.log 2>&1 || { cat output/prepare.log; exit 1; }
npm test > output/native.log 2>&1 || { cat output/native.log; exit 1; }
xvfb-run -a npm run test:host > output/host.log 2>&1 || { tail -80 output/host.log; exit 1; }
cat output/test-env.json
tail -9 output/native.log
tail -4 output/host.log
`;
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      const child = spawn('wsl', [...prefix, '--', 'bash', '-c', command], {
        stdio: 'inherit',
        windowsHide: true,
      });
      child.on('error', reject);
      child.on('exit', (code) => resolve(code));
    });
  } finally {
    const dest = path.join(project, 'output/wsl');
    fs.mkdirSync(dest, { recursive: true });
    const unpack = spawn('tar', ['-xf', '-', '-C', dest], {
      stdio: ['pipe', 'inherit', 'inherit'],
      windowsHide: true,
    });
    const pack = spawn(
      'wsl',
      [
        ...prefix,
        '--',
        'bash',
        '-c',
        `cd ${quote(root)}; tar -cf - --ignore-failed-read output/test-env.json output/prepare.log output/native.log output/host.log output/extension-host-evidence.json`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true },
    );
    pack.stdout.pipe(unpack.stdin);
    await Promise.all([pack, unpack].map((child) => new Promise((r) => child.on('exit', r))));
    fs.writeFileSync(path.join(dest, 'workspace.txt'), root + '\n');
  }
  if (result) throw Error('WSL tests failed: ' + result);
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
