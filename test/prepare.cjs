const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
} = require('@vscode/test-electron');
const project = path.resolve(__dirname, '..');
async function runCli(code, args, env = {}) {
  const [cli] = resolveCliArgsFromVSCodeExecutablePath(code, { reuseMachineInstall: true });
  let executable = cli;
  if (process.platform === 'win32') {
    const script = /"([^"\r\n]*resources[\\/]app[\\/]out[\\/]cli\.js)"/i.exec(
      await fs.readFile(cli, 'utf8'),
    )?.[1];
    if (!script?.startsWith('%~dp0')) throw Error('Unknown VS Code CLI layout: ' + cli);
    args = [path.resolve(path.dirname(cli), script.slice('%~dp0'.length)), ...args];
    executable = code;
    env = { ...env, ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' };
  }
  const running = promisify(execFile)(executable, args, {
    env: { ...process.env, DONT_PROMPT_WSL_INSTALL: '1', ...env },
    windowsHide: true,
    timeout: 240000,
    maxBuffer: 4 * 1024 * 1024,
  });
  running.child?.stdin?.end();
  return running;
}
async function prepare() {
  const manifest = require('../package.json');
  const output = path.join(project, 'output');
  await fs.mkdir(output, { recursive: true });
  const cache = path.resolve(process.env.NOTEBOOK_TEST_CACHE || path.join(output, 'test-cache'));
  await fs.mkdir(cache, { recursive: true });
  const code =
    process.env.NOTEBOOK_CODE_BIN ||
    (await downloadAndUnzipVSCode({
      version: process.env.NOTEBOOK_VSCODE_VERSION || 'stable',
      cachePath: path.join(cache, 'vscode'),
    }));
  const vsix = path.resolve(
    process.env.NOTEBOOK_VSIX || path.join(output, `${manifest.name}-${manifest.version}.vsix`),
  );
  await fs.access(vsix);
  const reuse = process.env.NOTEBOOK_REUSE_INSTALL;
  if (reuse && !/^install-[A-Za-z0-9]{6}$/.test(reuse))
    throw Error('Invalid test installation cache name');
  const install = reuse ? path.join(cache, reuse) : await fs.mkdtemp(path.join(cache, 'install-'));
  const extensions = path.join(install, 'extensions'),
    profile = path.join(install, 'profile');
  if (process.env.NOTEBOOK_TEST_PROXY) {
    await fs.mkdir(path.join(profile, 'User'), { recursive: true });
    await fs.writeFile(
      path.join(profile, 'User/settings.json'),
      JSON.stringify({
        'http.proxy': process.env.NOTEBOOK_TEST_PROXY,
      }),
    );
  }
  const cliArgs = [
    '--user-data-dir',
    profile,
    '--extensions-dir',
    extensions,
    ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
  ];
  const result = reuse
    ? { stdout: await fs.readFile(path.join(install, 'installation.log'), 'utf8'), stderr: '' }
    : await runCli(code, [...cliArgs, '--install-extension', vsix, '--force']);
  if (!reuse)
    await fs.writeFile(path.join(install, 'installation.log'), result.stdout + result.stderr);
  const folders = await fs.readdir(extensions);
  const locate = async (id) => {
    for (const name of folders) {
      const folder = path.join(extensions, name);
      const pkg = await fs
        .readFile(path.join(folder, 'package.json'), 'utf8')
        .then(JSON.parse)
        .catch(() => null);
      if (pkg && `${pkg.publisher}.${pkg.name}` === id) return { folder, pkg };
    }
    throw Error('Dependency installation failed: ' + id + '\n' + result.stdout + result.stderr);
  };
  const tiny = await locate('myriad-dreamin.tinymist');
  const own = await locate(`${manifest.publisher}.${manifest.name}`);
  console.log(
    `Installed ${own.pkg.version}; Tinymist ${tiny.pkg.version} was installed automatically.`,
  );
  const fontDir = path.join(cache, 'fonts');
  await fs.mkdir(fontDir, { recursive: true });
  const customFonts = process.env.NOTEBOOK_FONT_PATHS
    ? JSON.parse(process.env.NOTEBOOK_FONT_PATHS).map((p) => path.resolve(p))
    : null;
  for (const [family, folder] of customFonts
    ? []
    : [
        ['NotoSerifSC', 'notoserifsc'],
        ['NotoSansSC', 'notosanssc'],
      ]) {
    const file = path.join(fontDir, family + '.ttf');
    if (!(await fs.stat(file).catch(() => null))?.size) {
      console.log(`Downloading test font ${family}...`);
      const url = `https://raw.githubusercontent.com/google/fonts/e7db6ca603fd4862010383ff17ffd6cc4ffac1c0/ofl/${folder}/${family}%5Bwght%5D.ttf`;
      const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
      if (!response.ok) throw Error(`Font download: ${response.status} ${url}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length < 100000) throw Error('Invalid CJK font: ' + url);
      await fs.writeFile(file + '.tmp', bytes);
      await fs.rename(file + '.tmp', file);
    }
  }
  const prepared = {
    platform: process.platform,
    arch: process.arch,
    code,
    extensions,
    extensionPath: own.folder,
    extensionVersion: own.pkg.version,
    tinyVersion: tiny.pkg.version,
    binary: path.join(
      tiny.folder,
      'out',
      process.platform === 'win32' ? 'tinymist.exe' : 'tinymist',
    ),
    fontPaths: customFonts || [fontDir],
    dependencyAutoInstalled: true,
    reusedTestInstallation: !!reuse,
    installationLog: path.join(install, 'installation.log'),
  };
  await fs.writeFile(path.join(output, 'test-env.json'), JSON.stringify(prepared, null, 2));
  console.log(JSON.stringify(prepared, null, 2));
  return prepared;
}
if (require.main === module)
  prepare().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
module.exports = { prepare, runCli };
