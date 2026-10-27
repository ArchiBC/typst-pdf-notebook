const fs = require('node:fs/promises');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');
const { createHostFixture } = require('./support/book.cjs');
const { environment } = require('./support/environment.cjs');
async function main() {
  const project = path.resolve(__dirname, '..'),
    output = path.join(project, 'output');
  const prepared = environment();
  if (!prepared.code) throw Error('请先运行 npm run test:prepare。');
  await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'host-workspace-'));
  await createHostFixture(root);
  await fs.mkdir(path.join(root, '.vscode'));
  await fs.writeFile(
    path.join(root, '.vscode/settings.json'),
    JSON.stringify({
      'tinymist.exportPdf': 'never',
      'tinymist.fontPaths': prepared.fontPaths,
      'tinymist.typstExtraArgs': ['main.typ'],
      'tinymist.rootPath': root,
      'tinymist.configureDefaultWordSeparator': 'disable',
    }),
  );
  await runTests({
    vscodeExecutablePath: prepared.code,
    extensionDevelopmentPath: process.env.NOTEBOOK_EXTENSION_PATH || prepared.extensionPath,
    extensionTestsPath: path.join(__dirname, 'extension-host.cjs'),
    extensionTestsEnv: {
      NOTEBOOK_TEST_ROOT: root,
      NOTEBOOK_EVIDENCE: path.join(output, 'extension-host-evidence.json'),
      NOTEBOOK_STRESS_HOST: process.env.NOTEBOOK_STRESS_HOST || '',
      TYPST_PACKAGE_PATH: path.join(root, '.typst-packages'),
      NOTEBOOK_TEST_FONT_PATHS: JSON.stringify(prepared.fontPaths),
    },
    launchArgs: [
      root,
      '--user-data-dir',
      path.join(root, '.profile'),
      '--extensions-dir',
      prepared.extensions,
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-updates',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    ],
  });
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
