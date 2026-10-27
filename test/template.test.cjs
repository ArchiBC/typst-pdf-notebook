const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  packageRoot,
  installTemplate,
  PACKAGE_IMPORT,
  templateUpgradeEdits,
} = require('../src/template.cjs');

test('vendored Chengsi files retain their upstream byte hashes on every platform', async () => {
  const root = path.resolve(__dirname, '../templates/chengsi');
  const upstream = JSON.parse(await fs.readFile(path.join(root, 'UPSTREAM.json'), 'utf8'));
  for (const file of upstream.files) {
    const hash = crypto
      .createHash('sha256')
      .update(await fs.readFile(path.join(root, file.path)))
      .digest('hex');
    assert.equal(hash, file.sha256, file.path);
  }
});

test('template package uses Typst standard data paths and honors TYPST_PACKAGE_PATH', () => {
  assert.equal(
    packageRoot({ platform: 'win32', env: { APPDATA: 'C:/roaming' } }),
    path.join('C:/roaming', 'typst/packages'),
  );
  assert.equal(
    packageRoot({ platform: 'linux', env: { XDG_DATA_HOME: '/user/data' } }),
    path.join('/user/data', 'typst/packages'),
  );
  assert.equal(
    packageRoot({ platform: 'darwin', env: {}, home: '/user' }),
    path.join('/user', 'Library/Application Support/typst/packages'),
  );
  assert.equal(
    packageRoot({ env: { TYPST_PACKAGE_PATH: 'custom-packages' } }),
    path.resolve('custom-packages'),
  );
});

test('bundled package installs idempotently and refuses to overwrite user changes', async (t) => {
  const parent = path.resolve(__dirname, '../output/test-runs');
  await fs.mkdir(parent, { recursive: true });
  const packages = await fs.mkdtemp(path.join(parent, 'packages-'));
  t.after(async () => {
    assert.equal(path.dirname(packages), parent);
    await fs.rm(packages, { recursive: true, force: true });
  });
  const extension = path.resolve(__dirname, '..');
  const installed = await installTemplate(extension, packages);
  assert.equal(installed.changed, true);
  assert.equal(installed.import, PACKAGE_IMPORT);
  const manifest = await fs.readFile(path.join(installed.target, 'typst.toml'), 'utf8');
  assert.match(manifest, /name = "typst-pdf-notebook"/);
  assert.match(manifest, /version = "0\.3\.1"/);
  assert.ok(
    (await fs.readFile(path.join(installed.target, 'math.typ'), 'utf8')).includes(
      'chengsi/template.typ',
    ),
  );
  assert.ok(
    (await fs.readFile(path.join(installed.target, 'chengsi/template.typ'), 'utf8')).includes(
      'Quiet Mathematics',
    ),
  );
  assert.match(
    await fs.readFile(path.join(installed.legacyTargets[0], 'typst.toml'), 'utf8'),
    /version = "0\.2\.0"/,
  );
  assert.match(
    await fs.readFile(path.join(installed.legacyTargets[1], 'typst.toml'), 'utf8'),
    /version = "0\.3\.0"/,
  );
  assert.equal(
    await fs.readFile(path.join(installed.legacyTargets[1], 'notebook.typ'), 'utf8'),
    await fs.readFile(path.join(extension, 'templates/legacy/0.3.0/notebook.typ'), 'utf8'),
  );
  const source = path.join(installed.target, 'notebook.typ');
  const mtime = (await fs.stat(source)).mtimeMs;
  assert.equal((await installTemplate(extension, packages)).changed, false);
  assert.equal((await fs.stat(source)).mtimeMs, mtime);
  const packaged = path.join(packages, 'packaged-extension');
  await fs.mkdir(packaged);
  await fs.cp(path.join(extension, 'templates'), path.join(packaged, 'templates'), {
    recursive: true,
  });
  await fs.copyFile(path.join(extension, 'LICENSE'), path.join(packaged, 'LICENSE.txt'));
  assert.equal((await installTemplate(packaged, packages)).changed, false);
  await fs.writeFile(source, '// USER TEMPLATE');
  await assert.rejects(() => installTemplate(extension, packages), /未覆盖/);
  assert.equal(await fs.readFile(source, 'utf8'), '// USER TEMPLATE');
});

test('upgrading a notebook changes only its import and preserves note bodies and custom imports', () => {
  const body =
    '\n#note(28)\n\n= 我的正文\n\n```typ\n#import "@local/typst-pdf-notebook:0.2.0": note\n```\n';
  const source =
    '#import "@local/typst-pdf-notebook:0.2.0": note, notebook\n#show: notebook\n' + body;
  const apply = (s) =>
    templateUpgradeEdits(s)
      .reverse()
      .reduce((text, e) => text.slice(0, e.start) + e.text + text.slice(e.end), s);
  const next = apply(source);
  assert.ok(next.startsWith(`#import "${PACKAGE_IMPORT}": *`));
  assert.ok(next.endsWith(body));
  assert.equal(templateUpgradeEdits(next).length, 0);
  const chengsi = source.replaceAll(':0.2.0', ':0.3.0');
  const nextChengsi = apply(chengsi);
  assert.ok(nextChengsi.startsWith(`#import "${PACKAGE_IMPORT}": *`));
  assert.ok(nextChengsi.endsWith(body.replaceAll(':0.2.0', ':0.3.0')));
  const custom =
    '#import "@local/typst-pdf-notebook:0.2.0" as core\n#let notebook = core.notebook.with(pdf: "book.pdf")\n';
  assert.ok(apply(custom).includes(`"${PACKAGE_IMPORT}" as core`));
  assert.equal(
    templateUpgradeEdits('```typ\n#import "@local/typst-pdf-notebook:0.2.0": note\n```').length,
    0,
  );
});
