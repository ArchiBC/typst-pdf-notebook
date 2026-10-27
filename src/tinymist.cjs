const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { installTemplate, packageRoot } = require('./template.cjs');

const TINYMIST_ID = 'myriad-dreamin.tinymist';
const REQUIRED_COMMANDS = [
  'tinymist.exportPdf',
  'tinymist.exportQuery',
  'tinymist.doStartPreview',
  'tinymist.scrollPreview',
];
const valueOptions = new Set([
  '--input',
  '--font-path',
  '--package-cache-path',
  '--features',
  '--pdf-standard',
  '--ppi',
  '--creation-timestamp',
  '--cert',
]);
const switchOptions = new Set(['--ignore-system-fonts', '--no-pdf-tags']);
const ownedOptions = new Set(['--root', '--name', '--when', '--format', '-f', '--pages']);

function expandPath(value, { root, entry, env = process.env, home = os.homedir() }) {
  if (typeof value !== 'string') throw Error('Tinymist 路径必须是字符串。');
  const values = {
    workspaceFolder: root,
    workspaceRoot: root,
    cwd: root,
    workspaceFolderBasename: path.basename(root),
    userHome: home,
    file: entry,
    fileDirname: path.dirname(entry),
    fileBasename: path.basename(entry),
    fileBasenameNoExtension: path.parse(entry).name,
  };
  return value.replace(/\$\{([^}]+)\}/g, (_, name) => {
    const result = name.startsWith('env:') ? env[name.slice(4)] : values[name];
    if (result === undefined) throw Error(`无法解析 Tinymist 路径变量：\${${name}}`);
    return result;
  });
}

function normalizeSettings(configuration, context) {
  // vscode-languageclient starts Tinymist in the first workspace folder.
  // Resolve resource paths there before passing them to a notebook session.
  const cwd = context.cwd || context.root;
  const get = (name, fallback) =>
    configuration.get?.(name, fallback) ?? configuration[name] ?? fallback;
  const raw = get('typstExtraArgs', []);
  if (!Array.isArray(raw) || raw.some((a) => typeof a !== 'string'))
    throw Error('tinymist.typstExtraArgs 必须是字符串数组。');
  let explicitPackages;
  const extraArgs = [];
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i];
    if (!arg.startsWith('-')) continue; // The notebook session owns its input/output files.
    const eq = arg.indexOf('=');
    const flag = eq < 0 ? arg : arg.slice(0, eq);
    if (switchOptions.has(flag)) {
      extraArgs.push(arg);
      continue;
    }
    if (!valueOptions.has(flag) && !ownedOptions.has(flag) && flag !== '--package-path')
      throw Error(`笔记会话暂不支持 Tinymist 参数 ${flag}。`);
    const value = eq < 0 ? raw[++i] : arg.slice(eq + 1);
    if (!value || value.startsWith('--')) throw Error(`Tinymist 参数 ${flag} 缺少值。`);
    if (flag === '--package-path') explicitPackages = path.resolve(cwd, value);
    else if (!ownedOptions.has(flag)) {
      const resolved =
        flag === '--font-path'
          ? value
              .split(path.delimiter)
              .map((p) => path.resolve(cwd, p))
              .join(path.delimiter)
          : ['--package-cache-path', '--cert'].includes(flag)
            ? path.resolve(cwd, value)
            : value;
      extraArgs.push(flag, resolved);
    }
  }
  const fonts = get('fontPaths', []) || [];
  if (!Array.isArray(fonts) || fonts.some((p) => typeof p !== 'string'))
    throw Error('tinymist.fontPaths 必须是路径数组。');
  const configuredPath = get('serverPath', null);
  const env = context.env || process.env;
  return {
    configuredPath: configuredPath ? expandPath(configuredPath, context) : undefined,
    fontPaths: fonts.map((p) => path.resolve(cwd, expandPath(p, context))),
    extraArgs,
    packagePath:
      explicitPackages ||
      (env.TYPST_PACKAGE_PATH ? path.resolve(cwd, env.TYPST_PACKAGE_PATH) : packageRoot({ env })),
  };
}

async function resolveEngine({
  extensionPath,
  configuredPath,
  cwd = process.cwd(),
  platform = process.platform,
  probe,
}) {
  const run =
    probe ||
    (async (binary) => {
      await promisify(execFile)(binary, ['probe'], {
        cwd,
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 65536,
      });
    });
  const name = platform === 'win32' ? 'tinymist.exe' : 'tinymist';
  const candidates = configuredPath
    ? [
        {
          binary:
            configuredPath.includes('/') || configuredPath.includes('\\')
              ? path.resolve(cwd, configuredPath)
              : configuredPath,
          source: 'tinymist.serverPath',
        },
      ]
    : [
        { binary: path.join(extensionPath, 'out', name), source: 'Tinymist extension' },
        { binary: name, source: 'PATH' },
      ];
  const failures = [];
  for (const candidate of candidates) {
    try {
      await run(candidate.binary);
      return candidate;
    } catch (error) {
      failures.push(`${candidate.source}: ${error.message}`);
    }
  }
  throw Error(
    `无法启动 Tinymist 引擎。请检查 tinymist.serverPath 或更新 Tinymist 扩展。\n${failures.join('\n')}`,
  );
}

function validateServer(info, capabilities) {
  const version = info?.version || 'unknown';
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match || (+match[1] === 0 && (+match[2] < 15 || (+match[2] === 15 && +match[3] < 10))))
    throw Error(`笔记模板需要 Tinymist 0.15.10 或更新版本，当前为 ${version}。`);
  const commands = capabilities?.executeCommandProvider?.commands || [];
  const missing = REQUIRED_COMMANDS.filter((command) => !commands.includes(command));
  if (missing.length)
    throw Error(`Tinymist ${version} 缺少笔记定位/导出接口：${missing.join(', ')}。`);
}

class TemplateBridge {
  constructor({
    extensionRoot,
    getConfiguration,
    getWorkingDirectory,
    restartEditor,
    onLog = () => {},
  }) {
    Object.assign(this, {
      extensionRoot,
      getConfiguration,
      getWorkingDirectory,
      restartEditor,
      onLog,
    });
    this.installed = new Map();
    this.pending = new Map();
    this.restarts = 0;
    this.refreshRequired = new Set();
    this.restartTail = Promise.resolve();
  }
  async ensure(entry, root, { force = false } = {}) {
    const settings = normalizeSettings(this.getConfiguration(entry), {
      root,
      entry,
      cwd: this.getWorkingDirectory?.(),
    });
    const key = settings.packagePath;
    if (!force && this.installed.has(key))
      return { ...settings, ...this.installed.get(key), changed: false, restarted: false };
    if (!this.pending.has(key)) {
      const promise = (async () => {
        const installed = await installTemplate(this.extensionRoot, key);
        let restarted = false;
        if (installed.changed) this.refreshRequired.add(key);
        if (this.refreshRequired.has(key)) {
          // Tinymist caches missing packages. Clearing its layout cache is not
          // sufficient: restart the editor server after writing the complete package.
          this.restartTail = this.restartTail.catch(() => {}).then(() => this.restartEditor());
          await this.restartTail;
          this.restarts++;
          this.refreshRequired.delete(key);
          restarted = true;
          this.onLog('已安装内置模板，并重启 Tinymist 以刷新本地包。');
        }
        const metadata = { target: installed.target, import: installed.import };
        this.installed.set(key, metadata);
        return { ...metadata, changed: installed.changed, restarted };
      })().finally(() => this.pending.delete(key));
      this.pending.set(key, promise);
    }
    return { ...settings, ...(await this.pending.get(key)) };
  }
}

module.exports = {
  TINYMIST_ID,
  REQUIRED_COMMANDS,
  expandPath,
  normalizeSettings,
  resolveEngine,
  validateServer,
  TemplateBridge,
};
