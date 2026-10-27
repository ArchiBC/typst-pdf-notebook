const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
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
  // macOS Unix sockets cannot use long repository-relative profile paths.
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'tpn-host-'));
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
  try {
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
        profile,
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
  } finally {
    await fs
      .cp(path.join(profile, 'logs'), path.join(root, '.profile-logs'), { recursive: true })
      .catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    if (
      path.dirname(profile) !== path.resolve(os.tmpdir()) ||
      !/^tpn-host-[A-Za-z0-9]{6}$/.test(path.basename(profile))
    )
      throw Error('Invalid test profile cleanup target');
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
