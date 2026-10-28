const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const manifest = require('../package.json');
fs.mkdirSync(path.join(root, 'output'), { recursive: true });
const cli = path.join(path.dirname(require.resolve('@vscode/vsce/package.json')), 'vsce');
execFileSync(
  process.execPath,
  [
    cli,
    'package',
    '--no-dependencies',
    '--out',
    `output/${manifest.name}-${manifest.version}.vsix`,
  ],
  { cwd: root, stdio: 'inherit' },
);
