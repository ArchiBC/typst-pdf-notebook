const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os');
const { PDFDocument } = require('pdf-lib');
const { NotebookCompiler } = require('../src/compiler.cjs');
const { loadBook, planNotebook, exportNotebook } = require('../src/document.cjs');
const { assertExportTarget } = require('../src/paths.cjs');
const { installTemplate } = require('../src/template.cjs');
async function main() {
  await installTemplate(path.resolve(__dirname, '..'));
  const entry = path.resolve(process.argv[2] || 'main.typ'),
    target = path.resolve(process.argv[3] || 'output/pdf/notebook.pdf'),
    root = path.dirname(entry);
  const extensions = path.join(os.homedir(), '.vscode/extensions'),
    tiny = (await fs.readdir(extensions))
      .filter((x) => /^myriad-dreamin\.tinymist-/.test(x))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  if (!tiny) throw Error('Tinymist extension is not installed.');
  const compiler = new NotebookCompiler({
    binary: path.join(
      extensions,
      tiny,
      'out',
      process.platform === 'win32' ? 'tinymist.exe' : 'tinymist',
    ),
    root,
    entry,
  });
  try {
    await compiler.start([{ path: entry, text: await fs.readFile(entry, 'utf8') }]);
    const result = await compiler.compile(),
      config = result.metadata.find((x) => x.kind === 'pdf-notebook');
    if (!config?.pdf) throw Error('Notebook metadata is missing.');
    const bookPath = path.resolve(root, config.pdf);
    await assertExportTarget(target, bookPath, entry);
    const book = await loadBook(await fs.readFile(bookPath)),
      notes = await PDFDocument.load(result.bytes),
      plan = planNotebook(book, notes, result.metadata),
      bytes = await exportNotebook(book, notes, plan);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
    console.log(
      JSON.stringify({
        output: target,
        pages: plan.rows.length,
        sourcePages: book.pageCount,
        notesPages: notes.getPageCount(),
        bookmarks: book.items.length,
        bytes: bytes.length,
      }),
    );
  } finally {
    compiler.dispose();
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
