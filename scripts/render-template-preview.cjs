const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { installTemplate } = require('../src/template.cjs');
async function main() {
  const project = path.resolve(__dirname, '..'),
    output = path.join(project, 'output');
  await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'preview-workspace-'));
  try {
    const packages = path.join(root, 'packages');
    await installTemplate(project, packages);
    const entry = path.join(root, 'sample.typ');
    await fs.copyFile(path.join(project, 'examples/chengsi.notes.typ'), entry);
    execFileSync(
      'typst',
      [
        'compile',
        '--package-path',
        packages,
        '--format',
        'png',
        '--ppi',
        '120',
        entry,
        path.join(root, 'page-{p}.png'),
      ],
      { stdio: 'inherit', windowsHide: true },
    );
    const images = (await fs.readdir(root)).filter((f) => /^page-\d+\.png$/.test(f)).sort();
    for (const name of images) {
      const target = path.join(output, name.replace('page-', 'chengsi-preview-'));
      await fs.copyFile(path.join(root, name), target);
      console.log(target);
    }
  } finally {
    if (path.dirname(root) !== output) throw Error('Unsafe preview cleanup target');
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
