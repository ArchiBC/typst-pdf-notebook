const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  normalizeSettings,
  resolveEngine,
  validateServer,
  REQUIRED_COMMANDS,
  TemplateBridge,
} = require('../src/tinymist.cjs');
const { NotebookCompiler } = require('../src/compiler.cjs');
const { PACKAGE_IMPORT } = require('../src/template.cjs');
const { nativeOptions } = require('./support/environment.cjs');

async function workspace(t) {
  const parent = path.resolve(__dirname, '../output/test-runs');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'tinymist-'));
  const compilers = [];
  t.after(async () => {
    for (const c of compilers) {
      c.dispose();
      if (c.proc?.exitCode === null && c.proc.signalCode === null)
        await new Promise((r) => c.proc.once('exit', r));
    }
    assert.equal(path.dirname(root), parent);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return {
    root,
    entry: path.join(root, 'main.typ'),
    packages: path.join(root, 'packages'),
    compilers,
  };
}

test('Tinymist settings retain layout options, expand paths and isolate notebook entry/output', () => {
  const root = path.resolve('sample workspace'),
    entry = path.join(root, 'notes.typ');
  const result = normalizeSettings(
    {
      serverPath: '${workspaceFolder}/bin/tinymist',
      fontPaths: ['${env:NOTE_FONTS}', '${fileDirname}/fonts'],
      typstExtraArgs: [
        'old-main.typ',
        '--root',
        '/old-root',
        '--input=lang=zh',
        '--font-path',
        '/shared fonts',
        '--package-path=local-packages',
        '--format',
        'svg',
        '--no-pdf-tags',
      ],
    },
    { root, entry, env: { NOTE_FONTS: path.join(root, 'global-fonts') } },
  );
  assert.equal(path.resolve(result.configuredPath), path.join(root, 'bin/tinymist'));
  assert.deepEqual(result.fontPaths, [path.join(root, 'global-fonts'), path.join(root, 'fonts')]);
  assert.deepEqual(result.extraArgs, [
    '--input',
    'lang=zh',
    '--font-path',
    '/shared fonts',
    '--no-pdf-tags',
  ]);
  assert.equal(result.packagePath, path.join(root, 'local-packages'));
  assert.throws(
    () => normalizeSettings({ typstExtraArgs: ['--package-path'] }, { root, entry }),
    /缺少值/,
  );
  assert.throws(
    () => normalizeSettings({ fontPaths: ['${unknown}'] }, { root, entry }),
    /无法解析/,
  );
});

test('engine discovery honors serverPath and never silently falls back from an invalid explicit binary', async () => {
  const root = path.resolve('workspace');
  const calls = [];
  const probe = async (binary) => {
    calls.push(binary);
    if (binary !== 'tinymist') throw Error('missing');
  };
  const fallback = await resolveEngine({ extensionPath: root, root, platform: 'linux', probe });
  assert.equal(fallback.source, 'PATH');
  assert.equal(calls.length, 2);
  calls.length = 0;
  await assert.rejects(
    () => resolveEngine({ extensionPath: root, root, configuredPath: './custom/tiny', probe }),
    /serverPath/,
  );
  assert.deepEqual(calls, [path.join(root, 'custom/tiny')]);
  const windows = await resolveEngine({
    extensionPath: root,
    root,
    platform: 'win32',
    probe: async () => {},
  });
  assert.ok(windows.binary.endsWith('tinymist.exe'));
});

test('server handshake checks both version and actual navigation/export capabilities', () => {
  const capabilities = { executeCommandProvider: { commands: REQUIRED_COMMANDS } };
  assert.doesNotThrow(() => validateServer({ version: '0.15.10' }, capabilities));
  assert.throws(() => validateServer({ version: '0.14.9' }, capabilities), /0.15.10/);
  assert.throws(() => validateServer({ version: '0.16.0' }, {}), /缺少/);
});

test('template bootstrap serializes concurrent installs and retries a failed editor refresh', async (t) => {
  const f = await workspace(t);
  let attempts = 0;
  const bridge = new TemplateBridge({
    extensionRoot: path.resolve(__dirname, '..'),
    getConfiguration: () => ({ typstExtraArgs: ['--package-path', f.packages] }),
    restartEditor: async () => {
      if (++attempts === 1) throw Error('editor restarting');
    },
  });
  await assert.rejects(() => bridge.ensure(f.entry, f.root), /editor restarting/);
  const recovered = await bridge.ensure(f.entry, f.root);
  assert.equal(recovered.changed, false);
  assert.equal(recovered.restarted, true);
  await Promise.all([
    bridge.ensure(f.entry, f.root),
    bridge.ensure(f.entry, f.root, { force: true }),
  ]);
  assert.equal(attempts, 2);
  assert.equal(bridge.restarts, 1);
});

test('first template installation recovers a real cached missing package and preserves unsaved source', async (t) => {
  const f = await workspace(t);
  await fs.mkdir(f.packages);
  const saved = `#import "${PACKAGE_IMPORT}": *\n#show: notebook\n#note(1)\nSAVED\n`;
  const unsaved = saved + '#metadata((kind: "unsaved", value: "KEEP"))\nUNSAVED CONTENT\n';
  await fs.writeFile(f.entry, saved);
  const start = async () => {
    const c = new NotebookCompiler({
      ...nativeOptions(),
      root: f.root,
      entry: f.entry,
      packagePath: f.packages,
    });
    f.compilers.push(c);
    await c.start([{ path: f.entry, text: unsaved }]);
    return c;
  };
  let editor = await start();
  await assert.rejects(() => editor.compile(), /package not found/);
  const bridge = new TemplateBridge({
    extensionRoot: path.resolve(__dirname, '..'),
    getConfiguration: () => ({ typstExtraArgs: ['--package-path', f.packages] }),
    restartEditor: async () => {
      editor.dispose();
      editor = await start();
    },
  });
  assert.equal((await bridge.ensure(f.entry, f.root)).restarted, true);
  const compiled = await editor.compile();
  assert.ok(compiled.metadata.some((m) => m.kind === 'unsaved' && m.value === 'KEEP'));
  assert.equal(await fs.readFile(f.entry, 'utf8'), saved);
  assert.equal((await bridge.ensure(f.entry, f.root)).restarted, false);
  assert.equal(bridge.restarts, 1);
});

test('edits made during LSP initialization reach the first compiled snapshot', async (t) => {
  const f = await workspace(t);
  const bridge = new TemplateBridge({
    extensionRoot: path.resolve(__dirname, '..'),
    getConfiguration: () => ({ typstExtraArgs: ['--package-path', f.packages] }),
    restartEditor: async () => {},
  });
  await bridge.ensure(f.entry, f.root);
  const initial = `#import "${PACKAGE_IMPORT}": *\n#show: notebook\n#note(1)\nINITIAL\n`;
  await fs.writeFile(f.entry, initial);
  const c = new NotebookCompiler({
    ...nativeOptions(),
    root: f.root,
    entry: f.entry,
    packagePath: f.packages,
  });
  f.compilers.push(c);
  const starting = c.start([{ path: f.entry, text: initial }]);
  c.update(f.entry, initial + '#metadata((kind: "startup-edit", value: 7))\nLATEST\n');
  await starting;
  assert.ok((await c.compile()).metadata.some((m) => m.kind === 'startup-edit' && m.value === 7));
});
