const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const PACKAGE_NAME = 'typst-pdf-notebook';
const PACKAGE_VERSION = '0.3.1';
const PACKAGE_IMPORT = `@local/${PACKAGE_NAME}:${PACKAGE_VERSION}`;

function packageRoot({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (env.TYPST_PACKAGE_PATH) return path.resolve(env.TYPST_PACKAGE_PATH);
  const data =
    platform === 'win32'
      ? env.APPDATA || path.join(home, 'AppData/Roaming')
      : platform === 'darwin'
        ? path.join(home, 'Library/Application Support')
        : env.XDG_DATA_HOME || path.join(home, '.local/share');
  return path.join(data, 'typst/packages');
}

async function installTemplate(extensionRoot, packages = packageRoot()) {
  // vsce renames the root LICENSE to LICENSE.txt in the installed extension.
  const license = await fs.readFile(path.join(extensionRoot, 'LICENSE')).catch((e) => {
    if (e.code !== 'ENOENT') throw e;
    return fs.readFile(path.join(extensionRoot, 'LICENSE.txt'));
  });
  const files = new Map([
    ['notebook.typ', await fs.readFile(path.join(extensionRoot, 'templates/notebook.typ'))],
    ['math.typ', await fs.readFile(path.join(extensionRoot, 'templates/math.typ'))],
    ['NOTICE.txt', await fs.readFile(path.join(extensionRoot, 'templates/NOTICE.txt'))],
    ['LICENSE', license],
  ]);
  async function addDirectory(folder, prefix) {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const source = path.join(folder, entry.name),
        name = `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) throw Error(`模板资源不能是符号链接：${source}`);
      if (entry.isDirectory()) await addDirectory(source, name);
      else if (entry.isFile()) files.set(name, await fs.readFile(source));
    }
  }
  await addDirectory(path.join(extensionRoot, 'templates/chengsi'), 'chengsi');
  files.set('typst.toml', await fs.readFile(path.join(extensionRoot, 'templates/typst.toml')));
  const legacy = new Map([
    [
      'notebook.typ',
      await fs.readFile(path.join(extensionRoot, 'templates/legacy/0.2.0/notebook.typ')),
    ],
    ['LICENSE', license],
    [
      'typst.toml',
      await fs.readFile(path.join(extensionRoot, 'templates/legacy/0.2.0/typst.toml')),
    ],
  ]);
  const previousChengsi = new Map(files);
  for (const name of ['notebook.typ', 'math.typ', 'typst.toml'])
    previousChengsi.set(
      name,
      await fs.readFile(path.join(extensionRoot, 'templates/legacy/0.3.0', name)),
    );
  const bundles = [
    { target: path.join(packages, 'local', PACKAGE_NAME, PACKAGE_VERSION), files },
    { target: path.join(packages, 'local', PACKAGE_NAME, '0.2.0'), files: legacy },
    { target: path.join(packages, 'local', PACKAGE_NAME, '0.3.0'), files: previousChengsi },
  ];
  const conflict = (file) => Error(`Typst 本地包已存在不同内容，未覆盖：${file}`);
  // Check the entire existing package before filling missing files; never replace user edits.
  async function matches(file, expected) {
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw conflict(file);
      if (!(await fs.readFile(file)).equals(expected)) throw conflict(file);
      return true;
    } catch (e) {
      if (e.code === 'ENOENT') return false;
      throw e;
    }
  }
  for (const bundle of bundles) {
    const existing = await fs.lstat(bundle.target).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
      return null;
    });
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
      throw conflict(bundle.target);
    for (const [name, bytes] of bundle.files) await matches(path.join(bundle.target, name), bytes);
  }
  let changed = false;
  // Write the manifest last so a new package cannot be imported before its source exists.
  for (const bundle of bundles)
    for (const [name, bytes] of bundle.files) {
      const file = path.join(bundle.target, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      try {
        await fs.writeFile(file, bytes, { flag: 'wx' });
        changed = true;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        await matches(file, bytes);
      }
    }
  return {
    target: bundles[0].target,
    changed,
    import: PACKAGE_IMPORT,
    legacyTargets: bundles.slice(1).map((bundle) => bundle.target),
  };
}

function notebookSource({ pdf, title, width, height }) {
  const relativePdf = pdf.split(path.sep).join('/');
  return `#import "${PACKAGE_IMPORT}": *
#show: notebook.with(
  pdf: ${JSON.stringify(relativePdf)},
  title: ${JSON.stringify(title)},
  size: (${Number(width.toFixed(3))}pt, ${Number(height.toFixed(3))}pt),
)

#note(1)

= 我的笔记

在这里写下解答或想法。
`;
}

function templateUpgradeEdits(source) {
  // Only upgrade a notebook entry/configuration prelude, never quoted code in notes.
  if (
    !/^\s*#show:\s*(?:[\w-]+\.)*notebook\b/m.test(source) &&
    !/^\s*#let\s+notebook\s*=\s*[\w-]+\.notebook\b/m.test(source)
  )
    return [];
  const marker = /^\s*#note\s*\(/m.exec(source);
  const prelude = source.slice(0, marker?.index ?? source.length);
  const imported =
    /^[ \t]*#import\s+"(@local\/typst-pdf-notebook:0\.(?:2\.0|3\.0))"([^\r\n]*)/m.exec(prelude);
  if (!imported) return [];
  const start = imported.index + imported[0].indexOf(imported[1]);
  const edits = [{ start, end: start + imported[1].length, text: PACKAGE_IMPORT }];
  const standard = /^:\s*((?:notebook\s*,\s*note|note\s*,\s*notebook))\s*(?:\/\/.*)?$/.exec(
    imported[2],
  );
  if (standard) {
    const symbols = start + imported[1].length + 1 + imported[2].indexOf(standard[1]);
    edits.push({ start: symbols, end: symbols + standard[1].length, text: '*' });
  }
  return edits;
}

module.exports = {
  PACKAGE_NAME,
  PACKAGE_VERSION,
  PACKAGE_IMPORT,
  packageRoot,
  installTemplate,
  notebookSource,
  templateUpgradeEdits,
};
