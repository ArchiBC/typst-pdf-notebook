const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { PDFDocument, PDFName, PDFDict, PDFArray, PDFHexString, degrees } = require('pdf-lib');
const { loadBook, planNotebook, exportNotebook } = require('../src/document.cjs');
const { NotebookCompiler } = require('../src/compiler.cjs');
const { assertExportTarget } = require('../src/paths.cjs');
const { installTemplate, PACKAGE_IMPORT, notebookSource } = require('../src/template.cjs');
const { nativeOptions } = require('./support/environment.cjs');

async function fixture(t) {
  const parent = path.resolve(__dirname, '../output/test-runs');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, '笔记 '));
  const packages = path.join(root, '.typst-packages');
  await installTemplate(path.resolve(__dirname, '..'), packages);
  let compiler;
  t.after(async () => {
    compiler?.dispose();
    if (compiler?.proc && compiler.proc.exitCode === null && compiler.proc.signalCode === null)
      await new Promise((r) => compiler.proc.once('exit', r));
    if (path.dirname(root) !== parent) throw Error('Invalid test cleanup target');
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const source = await PDFDocument.create();
  for (const name of ['SOURCE ONE', 'SOURCE TWO', 'SOURCE THREE'])
    source.addPage([300, 450]).drawText(name, { x: 30, y: 400, size: 14 });
  const c = source.context,
    outline = c.obj({ Type: 'Outlines' }),
    outlineRef = c.register(outline);
  const a = c.obj({
      Title: PDFHexString.fromText('Chapter'),
      Parent: outlineRef,
      Dest: [source.getPage(0).ref, 'Fit'],
    }),
    aRef = c.register(a);
  const b = c.obj({
      Title: PDFHexString.fromText('Exercises'),
      Parent: outlineRef,
      Prev: aRef,
      Dest: [source.getPage(1).ref, 'Fit'],
    }),
    bRef = c.register(b);
  a.set(PDFName.of('Next'), bRef);
  outline.set(PDFName.of('First'), aRef);
  outline.set(PDFName.of('Last'), bRef);
  outline.set(PDFName.of('Count'), c.obj(2));
  source.catalog.set(PDFName.of('Outlines'), outlineRef);
  const link = c.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [20, 20, 100, 40],
    Border: [0, 0, 0],
    Dest: [source.getPage(2).ref, 'Fit'],
  });
  source.getPage(0).node.set(PDFName.of('Annots'), c.obj([c.register(link)]));
  const bookBytes = await source.save();
  fs.writeFileSync(path.join(root, 'book.pdf'), bookBytes);
  const template = fs
    .readFileSync(path.join(__dirname, '../templates/legacy/0.2.0/notebook.typ'), 'utf8')
    .replace('size: (176mm, 250mm)', 'size: (300pt, 450pt)');
  fs.writeFileSync(path.join(root, 'template.typ'), template);
  const entry = path.join(root, 'main.typ'),
    answer = path.join(root, 'answer.typ');
  const main =
    '#import "template.typ": notebook, note, source-ref\n#show: notebook\n#note("Exercises")\n#include "answer.typ"\n#note(1)\n\nINLINE NOTE $a+b=b+a$.\n';
  fs.writeFileSync(entry, main);
  fs.writeFileSync(
    answer,
    '#import "template.typ": source-ref\n= Included answer\n\nINCLUDED NOTE 中文字符。\n\n#source-ref(3)[Back to source]\n',
  );
  const positions = [],
    sources = [];
  compiler = new NotebookCompiler({
    ...nativeOptions(),
    root,
    entry,
    packagePath: packages,
    onPosition: (p) => positions.push(p),
    onSource: (s) => sources.push(s),
  });
  await compiler.start([{ path: entry, text: main }]);
  return {
    root,
    entry,
    answer,
    main,
    compiler,
    positions,
    sources,
    book: await loadBook(bookBytes),
  };
}
const wait = async (predicate) => {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.fail('Timed out waiting for source navigation');
};
async function compile(f) {
  const result = await f.compiler.compile({ book: f.book });
  const notes = result.notes || (await PDFDocument.load(result.bytes));
  return { ...result, notes, plan: result.plan || planNotebook(f.book, notes, result.metadata) };
}

test('reads PDF bookmarks and resolves mixed numeric/bookmark anchors in book order', async (t) => {
  const f = await fixture(t),
    r = await compile(f);
  assert.equal(f.book.items.length, 2);
  assert.equal(r.notes.getPageCount(), 2);
  assert.deepEqual(
    r.plan.rows.map((x) => (x.kind === 'source' ? `S${x.page}` : `N${x.page}`)),
    ['S1', 'N2', 'S2', 'N1', 'S3'],
  );
  assert.equal(r.plan.notesToOutput[1], 4);
  assert.equal(r.plan.notesToOutput[2], 2);
  assert.ok(
    f.compiler.vectorBytes < 2 * 1024 * 1024,
    'Only notes enter the Tinymist preview stream',
  );
});
test('unsaved included and inline edits grow/shrink note pages without changing source files', async (t) => {
  const f = await fixture(t),
    original = fs.readFileSync(f.answer, 'utf8');
  f.compiler.update(
    f.answer,
    '= Included answer\n\n' +
      Array.from(
        { length: 32 },
        (_, i) => `PARAGRAPH ${i}. ` + 'Answer and reasoning. '.repeat(10),
      ).join('\n\n'),
  );
  const long = await compile(f);
  assert.ok(long.notes.getPageCount() > 2);
  assert.equal(long.plan.blocks[0].last, long.plan.blocks[1].first - 1);
  f.compiler.update(f.answer, 'UNSAVED SHORT NOTE');
  f.compiler.update(f.entry, f.main.replace('INLINE NOTE', 'UNSAVED INLINE NOTE'));
  const short = await compile(f);
  assert.equal(short.notes.getPageCount(), 2);
  assert.equal(short.plan.rows.length, 5);
  assert.equal(fs.readFileSync(f.answer, 'utf8'), original);
  assert.equal(fs.readFileSync(f.entry, 'utf8'), f.main);
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await getDocument({ data: new Uint8Array(short.bytes), verbosity: 0 }).promise;
  assert.match(
    (await (await pdf.getPage(1)).getTextContent()).items.map((x) => x.str).join(''),
    /UNSAVED SHORT NOTE/,
  );
  assert.match(
    (await (await pdf.getPage(2)).getTextContent()).items.map((x) => x.str).join(''),
    /UNSAVED INLINE NOTE/,
  );
  await pdf.loadingTask.destroy();
});
test('forward and inverse navigation identify inline and included Typst source', async (t) => {
  const f = await fixture(t);
  await compile(f);
  await f.compiler.forward(f.entry, 6, 8);
  await wait(() => f.positions.length);
  const inline = f.positions.at(-1);
  assert.equal(inline.page, 2);
  f.compiler.inverse(inline.page, inline.x + 5, inline.y - 3);
  await wait(() => f.sources.some((s) => decodeURI(s.uri).endsWith('/main.typ')));
  assert.equal(f.sources.at(-1).selection.start.line, 6);
  f.compiler.update(f.answer, fs.readFileSync(f.answer, 'utf8'));
  await compile(f);
  const before = f.positions.length;
  await f.compiler.forward(f.answer, 3, 8);
  await wait(() => f.positions.length > before);
  const included = f.positions.at(-1);
  assert.equal(included.page, 1);
  const count = f.sources.length;
  f.compiler.inverse(included.page, included.x + 5, included.y - 3);
  await wait(() => f.sources.length > count);
  assert.ok(decodeURI(f.sources.at(-1).uri).endsWith('/answer.typ'));
  assert.equal(f.sources.at(-1).selection.start.line, 3);
});
test('export copies original page streams, reconstructs bookmarks and remaps source links', async (t) => {
  const f = await fixture(t),
    r = await compile(f),
    bytes = await exportNotebook(f.book, r.notes, r.plan),
    out = await loadBook(bytes);
  assert.equal(out.pageCount, 5);
  for (let i = 1; i <= 3; i++) {
    const before = f.book.doc.getPage(i - 1).node.lookup(PDFName.of('Contents'), PDFArray),
      after = out.doc
        .getPage(r.plan.sourceToOutput[i] - 1)
        .node.lookup(PDFName.of('Contents'), PDFArray);
    assert.equal(before.size(), after.size());
    for (let k = 0; k < before.size(); k++)
      assert.deepEqual(
        f.book.doc.context.lookup(before.get(k)).contents,
        out.doc.context.lookup(after.get(k)).contents,
      );
  }
  assert.equal(out.items.find((x) => x.title === 'Exercises').page, 3);
  const sourceAnn = out.doc
    .getPage(0)
    .node.lookup(PDFName.of('Annots'), PDFArray)
    .lookup(0, PDFDict);
  assert.equal(out.destination(sourceAnn.get(PDFName.of('Dest'))), 5);
  const noteAnn = out.doc.getPage(3).node.lookup(PDFName.of('Annots'), PDFArray).lookup(0, PDFDict);
  assert.equal(out.destination(noteAnn.get(PDFName.of('Dest'))), 5);
});
test('empty notes add no reserved blank pages and invalid anchors fail explicitly', async (t) => {
  const f = await fixture(t);
  f.compiler.update(
    f.entry,
    '#import "template.typ": notebook, note\n#show: notebook\n#note(1)\n\n',
  );
  const empty = await compile(f);
  assert.equal(empty.plan.rows.length, 3);
  assert.equal(empty.plan.noteCount, 0);
  f.compiler.update(f.entry, f.main.replace('#note(1)', '#note(999)'));
  const compiled = await f.compiler.compile(),
    doc = await PDFDocument.load(compiled.bytes);
  assert.throws(() => planNotebook(f.book, doc, compiled.metadata), /无法唯一确定/);
});
test('Typst note layout does not read the original PDF and accepts inline blocks', async (t) => {
  const f = await fixture(t);
  fs.renameSync(path.join(f.root, 'book.pdf'), path.join(f.root, 'absent.pdf'));
  f.compiler.update(
    f.entry,
    '#import "template.typ": notebook, note\n#show: notebook\n#note(1)[INLINE BLOCK]\n#note(1)\n\nFLAT BODY\n',
  );
  const r = await compile(f);
  assert.equal(r.notes.getPageCount(), 2);
  assert.equal(r.plan.noteCount, 2);
});
test('rotated original pages keep correct preview dimensions', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([300, 450]).setRotation(degrees(90));
  const book = await loadBook(await doc.save());
  assert.equal(book.sizes[0].width, 450);
  assert.equal(book.sizes[0].height, 300);
});
test('inserting a custom root bookmark preserves original bookmark parentage', async (t) => {
  const f = await fixture(t),
    doc = f.book.doc,
    root = doc.catalog.lookup(PDFName.of('Outlines'), PDFDict),
    firstRef = root.get(PDFName.of('First')),
    first = doc.context.lookup(firstRef),
    lastRef = root.get(PDFName.of('Last')),
    last = doc.context.lookup(lastRef);
  first.delete(PDFName.of('Next'));
  first.set(PDFName.of('First'), lastRef);
  first.set(PDFName.of('Last'), lastRef);
  first.set(PDFName.of('Count'), doc.context.obj(1));
  last.delete(PDFName.of('Prev'));
  last.set(PDFName.of('Parent'), firstRef);
  root.set(PDFName.of('Last'), firstRef);
  f.book = await loadBook(await doc.save());
  const r = await f.compiler.compile(),
    notes = await PDFDocument.load(r.bytes);
  r.metadata[0].bookmarks = [{ page: 1, title: 'Custom root', id: 'custom', depth: 0 }];
  const plan = planNotebook(f.book, notes, r.metadata),
    out = await loadBook(await exportNotebook(f.book, notes, plan));
  assert.equal(out.items.find((x) => x.title === 'Exercises').parentTitle, 'Chapter');
  assert.equal(out.items.find((x) => x.title === 'Custom root').parentTitle, null);
});
test('export protects the original PDF and source, including Windows case aliases', async () => {
  const original = path.resolve(__dirname, '../templates/notebook.typ');
  await assert.rejects(() => assertExportTarget(original, original), /不能覆盖/);
  if (process.platform === 'win32')
    await assert.rejects(() => assertExportTarget(original.toUpperCase(), original), /不能覆盖/);
  await assertExportTarget(path.resolve(__dirname, '../output/safe.pdf'), original);
});

test('native package imports keep per-book defaults and explicit per-note overrides', async (t) => {
  const f = await fixture(t);
  f.compiler.update(
    f.entry,
    `#import "${PACKAGE_IMPORT}": notebook, note
#show: notebook.with(
  pdf: "book.pdf", title: "Package notebook", size: (300pt, 450pt),
  bookmarks: ((page: 3, title: "Last page", id: "last"),),
  note-settings: ("1": (title: "Default title", style: "grid", chrome: false)),
)
#note(1)

FLAT NOTE

#note(1, title: "Explicit title", id: "explicit", style: "blank")[BLOCK NOTE]

#note("last")
#include "answer.typ"
`,
  );
  const r = await compile(f);
  assert.equal(r.notes.getPageCount(), 3);
  assert.equal(r.plan.rows.length, 6);
  assert.equal(r.metadata[0].title, 'Package notebook');
  assert.deepEqual(
    r.plan.blocks.map((b) => b.title),
    ['Default title', 'Explicit title', 'last · 笔记'],
  );
  assert.equal(r.notes.getPage(0).getWidth(), 300);
  assert.equal(r.notes.getPage(0).getHeight(), 450);
  assert.equal(r.plan.blocks[1].id, 'explicit');
  assert.equal(r.plan.blocks[2].after, 3);
});

test('initializer source compiles from the built-in package without a workspace template', async (t) => {
  const f = await fixture(t);
  fs.unlinkSync(path.join(f.root, 'template.typ'));
  f.compiler.update(
    f.entry,
    notebookSource({ pdf: 'book.pdf', title: '中文阅读笔记', width: 300, height: 450 }),
  );
  const r = await compile(f);
  assert.equal(r.notes.getPageCount(), 1);
  assert.equal(r.plan.rows.length, 4);
  assert.equal(r.plan.config.pdf, 'book.pdf');
  assert.equal(r.plan.config.title, '中文阅读笔记');
  assert.equal(r.plan.config.template, 'chengsi');
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await getDocument({ data: new Uint8Array(r.bytes), verbosity: 0 }).promise;
  const text = (await (await pdf.getPage(1)).getTextContent()).items
    .map((x) => x.str)
    .join('')
    .replace(/\s/g, '');
  assert.match(text, /1我的笔记/);
  assert.match(text, /笔记1/);
  assert.doesNotMatch(text, /0\.1|page-number|counter\(page\)|else/);
  await pdf.loadingTask.destroy();
});

test('Chengsi keeps native theorem references and disables cover, contents and chapter breaks', async (t) => {
  const f = await fixture(t);
  f.compiler.update(
    f.entry,
    `#import "${PACKAGE_IMPORT}": *
#show: notebook.with(pdf: "book.pdf", size: (500pt, 710pt), config: (
  theme: "indigo", margin: 15mm, heading-numbering: none,
  theorem-numbering: "(1)", cover: true, toc: true, chapter-break: true,
))
#note(1)
#set heading(offset: 0)
= 第一段
#context metadata((kind: "heading-check", name: "first", page: here().page()))
第一段的普通正文。
= 第二段
#context metadata((kind: "heading-check", name: "second", page: here().page()))
#definition(title: [线性映射])[对向量 $u,v$ 和标量 $a,b$，有 $T(a u+b v)=a T(u)+b T(v)$。]
#theorem(title: [核是子空间])[若 $T:V -> W$ 是线性映射，则 $ker T$ 是 $V$ 的子空间。]<kernel>
#proof[
  #context metadata((kind: "font-check", font: repr(text.font), fill: repr(text.fill)))
  由线性性，$T(0)=0$，且核对线性组合封闭。
]
参见 @kernel。
#context metadata((kind: "numbering-check", values: query(figure.where(kind: "math-note")).map(f => f.numbering)))
`,
  );
  const r = await compile(f);
  assert.deepEqual(
    r.metadata.filter((m) => m.kind === 'heading-check').map((m) => m.page),
    [1, 1],
  );
  assert.deepEqual(r.metadata.find((m) => m.kind === 'numbering-check').values, ['(1)', '(1)']);
  const font = r.metadata.find((m) => m.kind === 'font-check');
  assert.match(font.font, /Noto Serif SC/i);
  assert.match(font.fill.toLowerCase(), /292d3b/);
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await getDocument({ data: new Uint8Array(r.bytes), verbosity: 0 }).promise;
  const text = (await (await pdf.getPage(1)).getTextContent()).items
    .map((x) => x.str)
    .join('')
    .replace(/\s/g, '');
  assert.match(text, /定理\(2\)/);
  assert.doesNotMatch(text, /CONTENTS|QUIETMATHEMATICS|你的名字/);
  await pdf.loadingTask.destroy();
});

test('long Chengsi proofs paginate naturally and keep included source navigation', async (t) => {
  const f = await fixture(t);
  const answer = path.join(f.root, 'math-answer.typ');
  const body =
    `#import "${PACKAGE_IMPORT}": *\n#theorem[The kernel is a subspace.]<kernel>\n#proof[\n\nMATH INCLUDED BODY\n\n` +
    Array.from(
      { length: 35 },
      (_, i) =>
        `STEP ${i}. ` + 'A linear map preserves addition and scalar multiplication. '.repeat(5),
    ).join('\n\n') +
    '\n]\nBy @kernel, the proof is complete.\n';
  fs.writeFileSync(answer, body);
  const main = `#import "${PACKAGE_IMPORT}": *\n#show: notebook.with(pdf: "book.pdf", size: (300pt,450pt))\n#note(1)\n#include "math-answer.typ"\n#note(2)[NEXT NOTE]\n`;
  f.compiler.update(f.entry, main);
  const r = await compile(f);
  assert.ok(r.notes.getPageCount() > 3);
  assert.equal(r.plan.blocks[0].last, r.plan.blocks[1].first - 1);
  await f.compiler.forward(answer, 4, 8);
  await wait(() => f.positions.length > 0);
  const point = f.positions.at(-1);
  assert.ok(point.page >= 1 && point.page < r.plan.blocks[1].first);
  const before = f.sources.length;
  f.compiler.inverse(point.page, point.x + 5, point.y - 3);
  await wait(() => f.sources.length > before);
  assert.ok(decodeURI(f.sources.at(-1).uri).endsWith('/math-answer.typ'));
  assert.equal(f.sources.at(-1).selection.start.line, 4);
});

test('each note restarts native numbering while continued pages and cross-note references stay correct', async (t) => {
  const f = await fixture(t);
  const included = path.join(f.root, 'second-unit.typ');
  fs.writeFileSync(
    included,
    `#import "${PACKAGE_IMPORT}": *
= Second unit
== Second subsection
$ b = b $
#theorem[SECOND THEOREM]<theorem-b>
#example[SECOND EXAMPLE]
#figure(rect(width: 12pt, height: 12pt), caption: [Second picture])
#figure(table(columns: 1, [Second cell]), caption: [Second table])
Second footnote#footnote[SECOND FOOTNOTE]
FIRST REF @theorem-a. SECOND REF @theorem-b.
`,
  );
  f.compiler.update(
    f.entry,
    `#import "${PACKAGE_IMPORT}": *
#show: notebook.with(pdf: "book.pdf", size: (400pt, 600pt))
#let check(stage) = context metadata((kind: "unit-counters", stage: stage,
  heading: counter(heading).get(), equation: counter(math.equation).get(),
  statement: counter(figure.where(kind: "math-note")).get(),
  example: counter(figure.where(kind: "math-example")).get(),
  image: counter(figure.where(kind: image)).get(),
  table: counter(figure.where(kind: table)).get(), footnote: counter(footnote).get(),
  page: here().page(),
))
#note(1)
= First unit
== First subsection
$ a = a $
$ a + 0 = a $
#definition[FIRST DEFINITION]
#theorem[FIRST THEOREM]<theorem-a>
#example[FIRST EXAMPLE]
#figure(rect(width: 12pt, height: 12pt), caption: [First picture])
#figure(table(columns: 1, [First cell]), caption: [First table])
First footnote#footnote[FIRST FOOTNOTE]
#check("first")
#lorem(700)
= Continued first unit
$ a - a = 0 $
#theorem[CONTINUED THEOREM]
#example[CONTINUED EXAMPLE]
#check("continued")
#note(2)

#note(3)
#include "second-unit.typ"
#check("second")
#note(3, id: "block-unit")[
  = Third unit
  $ c = c $
  #theorem[THIRD THEOREM]
  #example[THIRD EXAMPLE]
  #check("third")
]
`,
  );
  const r = await compile(f);
  const rows = Object.fromEntries(
    r.metadata.filter((m) => m.kind === 'unit-counters').map((m) => [m.stage, m]),
  );
  const values = (stage) => {
    const { kind, stage: name, page, ...counters } = rows[stage];
    return counters;
  };
  assert.deepEqual(values('first'), {
    heading: [1, 1],
    equation: [2],
    statement: [2],
    example: [1],
    image: [1],
    table: [1],
    footnote: [1],
  });
  assert.deepEqual(values('continued'), {
    heading: [2],
    equation: [3],
    statement: [3],
    example: [2],
    image: [1],
    table: [1],
    footnote: [1],
  });
  assert.deepEqual(values('second'), {
    heading: [1, 1],
    equation: [1],
    statement: [1],
    example: [1],
    image: [1],
    table: [1],
    footnote: [1],
  });
  assert.deepEqual(values('third'), {
    heading: [1],
    equation: [1],
    statement: [1],
    example: [1],
    image: [0],
    table: [0],
    footnote: [0],
  });
  assert.equal(r.plan.blocks.length, 3, 'empty markers must not create note units');
  assert.ok(rows.continued.page > rows.first.page, 'one unit should continue over several pages');
  assert.ok(rows.second.page > rows.continued.page);
  assert.ok(rows.third.page > rows.second.page);
  assert.equal(r.plan.blocks[1].first, rows.second.page);
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await getDocument({ data: new Uint8Array(r.bytes), verbosity: 0 }).promise;
  try {
    let text = '';
    for (let n = 1; n <= pdf.numPages; n++)
      text += (await (await pdf.getPage(n)).getTextContent()).items.map((x) => x.str).join('');
    assert.match(text.replace(/\s/g, ''), /FIRSTREF定理2/);
    assert.match(text.replace(/\s/g, ''), /SECONDREF定理1/);
  } finally {
    await pdf.loadingTask.destroy();
  }
});

test('closing the compiler during export rejects pending work without a broken-pipe error', async (t) => {
  const f = await fixture(t);
  const pending = f.compiler.compile();
  f.compiler.dispose();
  await assert.rejects(pending, /已关闭/);
  f.compiler.update(f.entry, f.main);
  f.compiler.dispose();
});

test('a right note replaces one source page and retains mixed bookmark and inserted notes', async (t) => {
  const f = await fixture(t);
  const source = `#import "${PACKAGE_IMPORT}": *
#show: notebook.with(pdf: "book.pdf", size: (300pt, 450pt))
#note("Exercises", placement: "right", title: "Side answer")

SIDE ANSWER TARGET. $a+b=b+a$.

#note(1)

REGULAR ANSWER.
`;
  f.compiler.update(f.entry, source);
  const r = await compile(f);
  assert.deepEqual(
    r.plan.rows.map((x) => x.kind),
    ['source', 'note', 'side', 'source'],
  );
  const row = r.plan.rows[2];
  assert.equal(row.width, 400);
  assert.equal(row.height, 450);
  assert.deepEqual(
    row.parts.map((p) => [p.kind, p.page, p.x]),
    [
      ['source', 2, 0],
      ['note', 1, 300],
    ],
  );
  assert.equal(r.plan.sourceToOutput[2], 3);
  assert.equal(r.plan.notesToOutput[1], 3);
  assert.equal(r.plan.outline.find((x) => x.title === 'Side answer').outputPage, 3);
  const line = source.split('\n').findIndex((x) => x.startsWith('SIDE ANSWER'));
  await f.compiler.forward(f.entry, line, 8);
  await wait(() => f.positions.length);
  const point = f.positions.at(-1);
  assert.equal(point.page, 1);
  f.compiler.inverse(point.page, point.x + 5, point.y - 3);
  await wait(() => f.sources.length);
  assert.equal(f.sources.at(-1).selection.start.line, line);
});

test('an overflowing right note becomes full-size inserted pages and returns to the side after shrinking', async (t) => {
  const f = await fixture(t);
  const header = `#import "${PACKAGE_IMPORT}": *\n#show: notebook.with(pdf: "book.pdf", size: (300pt, 450pt))\n#note(1, placement: "right")\n`;
  f.compiler.update(f.entry, header + '\n#lorem(1000)\n');
  const long = await compile(f);
  assert.ok(long.notes.getPageCount() > 1);
  assert.equal(long.plan.blocks[0].placement, 'after');
  assert.equal(long.plan.blocks[0].fallback, 'overflow');
  assert.equal(long.plan.rows[0].kind, 'source');
  assert.equal(long.plan.rows.length, f.book.pageCount + long.notes.getPageCount());
  assert.ok(
    long.plan.rows
      .filter((x) => x.kind === 'note')
      .every((x) => x.width === 300 && x.height === 450),
  );
  const output = await loadBook(await exportNotebook(f.book, long.notes, long.plan));
  assert.equal(output.pageCount, long.plan.rows.length);
  f.compiler.update(f.entry, header + '\nSHORT SIDE ANSWER\n');
  const short = await compile(f);
  assert.equal(short.plan.rows.length, f.book.pageCount);
  assert.equal(short.plan.rows[0].kind, 'side');
  assert.equal(short.plan.blocks[0].fallback, undefined);
  assert.equal(fs.readFileSync(f.entry, 'utf8'), f.main);
});

test('side-page export preserves selectable original and note text, outlines and both sets of links', async (t) => {
  const f = await fixture(t);
  f.compiler.update(
    f.entry,
    `#import "${PACKAGE_IMPORT}": *
#show: notebook.with(pdf: "book.pdf", size: (300pt, 450pt))
#note(1, placement: "right", title: "Right answer")

RIGHT SELECTABLE ANSWER.

#source-ref(3)[RETURN TO ORIGINAL]

#note(2)

REGULAR SELECTABLE ANSWER.
`,
  );
  const r = await compile(f),
    bytes = await exportNotebook(f.book, r.notes, r.plan);
  const out = await loadBook(bytes);
  assert.equal(out.pageCount, 4);
  assert.equal(out.doc.getPage(0).getWidth(), 400);
  assert.equal(out.items.find((x) => x.title === 'Chapter').page, 1);
  assert.equal(out.items.find((x) => x.title === 'Right answer').page, 1);
  const annotations = out.doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
  assert.ok(annotations.size() >= 2);
  const original = annotations.lookup(0, PDFDict);
  assert.equal(out.destination(original.get(PDFName.of('Dest'))), 4);
  for (let i = 1; i < annotations.size(); i++) {
    const right = annotations.lookup(i, PDFDict);
    assert.equal(out.destination(right.get(PDFName.of('Dest'))), 4);
    assert.ok(right.lookup(PDFName.of('Rect'), PDFArray).get(0).asNumber() >= 300);
  }
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  try {
    const page = await pdf.getPage(1),
      text = (await page.getTextContent()).items;
    assert.match(text.map((x) => x.str).join(''), /SOURCE ONE/);
    assert.match(
      text
        .map((x) => x.str)
        .join('')
        .replace(/\s/g, ''),
      /RIGHTSELECTABLEANSWER/,
    );
    assert.ok(text.find((x) => x.str.includes('RIGHT')).transform[4] >= 300);
    assert.equal((await page.getAnnotations()).length, annotations.size());
  } finally {
    await pdf.loadingTask.destroy();
  }
});

test('side-page export normalizes crop offsets and every quarter-turn without moving original text or links', async (t) => {
  const f = await fixture(t),
    bookBytes = f.book.bytes;
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  for (const rotation of [0, 90, 180, 270]) {
    const source = await PDFDocument.load(bookBytes),
      page = source.getPage(0);
    page.setCropBox(20, 30, 240, 400);
    page.setRotation(degrees(rotation));
    page.node
      .lookup(PDFName.of('Annots'), PDFArray)
      .lookup(0, PDFDict)
      .set(PDFName.of('Rect'), source.context.obj([40, 100, 120, 120]));
    f.book = await loadBook(await source.save());
    const size = f.book.sizes[0];
    f.compiler.update(
      f.entry,
      `#import "${PACKAGE_IMPORT}": *
#show: notebook.with(pdf: "book.pdf", size: (${size.width}pt, ${size.height}pt), config: (margin: 20pt))
#note(1, placement: "right", chrome: false)
ROTATION SIDE NOTE.
`,
    );
    const r = await compile(f);
    assert.equal(r.plan.rows[0].kind, 'side', `rotation ${rotation}`);
    const bytes = await exportNotebook(f.book, r.notes, r.plan),
      out = await loadBook(bytes);
    assert.equal(out.doc.getPage(0).getRotation().angle, 0);
    assert.ok(Math.abs(out.doc.getPage(0).getWidth() - (size.width * 4) / 3) < 0.01);
    assert.equal(out.doc.getPage(0).getHeight(), size.height);
    const before = await getDocument({ data: new Uint8Array(f.book.bytes), verbosity: 0 }).promise;
    const after = await getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
    try {
      const originalPage = await before.getPage(1),
        outputPage = await after.getPage(1);
      const originalText = (await originalPage.getTextContent()).items.find((x) =>
        x.str.includes('SOURCE ONE'),
      );
      const outputText = (await outputPage.getTextContent()).items.find((x) =>
        x.str.includes('SOURCE ONE'),
      );
      const oldPoint = originalPage
        .getViewport({ scale: 1 })
        .convertToViewportPoint(originalText.transform[4], originalText.transform[5]);
      const newPoint = outputPage
        .getViewport({ scale: 1 })
        .convertToViewportPoint(outputText.transform[4], outputText.transform[5]);
      assert.ok(Math.abs(oldPoint[0] - newPoint[0]) < 0.02, `text x at ${rotation}`);
      assert.ok(Math.abs(oldPoint[1] - newPoint[1]) < 0.02, `text y at ${rotation}`);
      const originalLink = (await originalPage.getAnnotations())[0];
      const outputLink = (await outputPage.getAnnotations())[0];
      const rect = (p, r) => {
        const viewport = p.getViewport({ scale: 1 });
        const a = viewport.convertToViewportPoint(r[0], r[1]),
          b = viewport.convertToViewportPoint(r[2], r[3]);
        return [
          Math.min(a[0], b[0]),
          Math.min(a[1], b[1]),
          Math.max(a[0], b[0]),
          Math.max(a[1], b[1]),
        ];
      };
      const oldRect = rect(originalPage, originalLink.rect),
        newRect = rect(outputPage, outputLink.rect);
      assert.ok(
        oldRect.every((v, i) => Math.abs(v - newRect[i]) < 0.02),
        `link at ${rotation}`,
      );
    } finally {
      await before.loadingTask.destroy();
      await after.loadingTask.destroy();
    }
  }
});

test('ambiguous side columns and a shorter source page fall back to regular inserts', async (t) => {
  const f = await fixture(t);
  f.compiler.update(
    f.entry,
    `#import "${PACKAGE_IMPORT}": *
#show: notebook.with(pdf: "book.pdf", size: (300pt, 450pt))
#note(1, placement: "right")[FIRST SIDE]
#note(1, placement: "right")[SECOND SIDE]
`,
  );
  const r = await compile(f);
  assert.equal(r.plan.rows.length, 5);
  assert.ok(r.plan.blocks.every((x) => x.fallback === 'multiple' && x.placement === 'after'));
  const invalid = r.metadata.map((x) => (x.kind === 'pdf-note' ? { ...x, placement: 'left' } : x));
  assert.throws(() => planNotebook(f.book, r.notes, invalid), /未知笔记位置/);
  f.book.sizes[0].height = 300;
  const single = r.metadata
    .filter((x) => x.kind !== 'pdf-note' || x.id === r.plan.blocks[0].id)
    .map((x) => (x.kind === 'pdf-note' ? { ...x, placement: 'right', fallback: undefined } : x));
  const only = await PDFDocument.create();
  only.addPage([300, 450]);
  const fallback = planNotebook(f.book, only, single);
  assert.equal(fallback.blocks[0].fallback, 'height');
});

test('sidenote and the right marker default to clean one-third columns and retain an explicit half-width', async (t) => {
  const f = await fixture(t);
  f.compiler.update(
    f.entry,
    `#import "${PACKAGE_IMPORT}": *
#show: notebook.with(pdf: "book.pdf", size: (300pt, 450pt))
#sidenote(1, title: "DO NOT PRINT THIS TITLE")

FIRST CLEAN BODY.

#note(2, right)

SECOND CLEAN BODY.

#sidenote(3, width: 50%)[HALF WIDTH BODY.]
`,
  );
  const r = await compile(f);
  assert.equal(r.plan.rows.length, 3);
  assert.deepEqual(
    r.notes.getPages().map((p) => p.getWidth()),
    [100, 100, 150],
  );
  assert.ok(r.plan.rows.every((row) => row.kind === 'side'));
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await getDocument({ data: new Uint8Array(r.bytes), verbosity: 0 }).promise;
  try {
    let text = '';
    for (let n = 1; n <= pdf.numPages; n++)
      text += (await (await pdf.getPage(n)).getTextContent()).items.map((x) => x.str).join('');
    text = text.replace(/\s/g, '');
    assert.match(text, /FIRSTCLEANBODY/);
    assert.match(text, /SECONDCLEANBODY/);
    assert.match(text, /HALFWIDTHBODY/);
    assert.doesNotMatch(text, /DONOTPRINTTHISTITLE|原PDF|笔记1|pdf-notebook-placement/);
  } finally {
    await pdf.loadingTask.destroy();
  }
});

test('side defaults can be shared and a regular note keeps its original chrome', async (t) => {
  const f = await fixture(t);
  f.compiler.update(
    f.entry,
    `#import "${PACKAGE_IMPORT}": *
#show: notebook.with(pdf: "book.pdf", size: (300pt, 450pt), side-width: 50%)
#sidenote(1)[SHARED HALF WIDTH]
#note(2, right, width: 1/3)[THIRD WIDTH]
#note(3, title: "REGULAR HEADER")[REGULAR BODY]
`,
  );
  const r = await compile(f);
  assert.deepEqual(
    r.notes.getPages().map((p) => p.getWidth()),
    [150, 100, 300],
  );
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await getDocument({ data: new Uint8Array(r.bytes), verbosity: 0 }).promise;
  try {
    const text = (await (await pdf.getPage(3)).getTextContent()).items
      .map((x) => x.str)
      .join('')
      .replace(/\s/g, '');
    assert.match(text, /REGULARHEADER/);
    assert.match(text, /原PDF/);
    assert.match(text, /笔记1/);
  } finally {
    await pdf.loadingTask.destroy();
  }
});

test('narrow content which fits a regular page falls back at full width, including explicit page breaks', async (t) => {
  const f = await fixture(t);
  const header = `#import "${PACKAGE_IMPORT}": *\n#show: notebook.with(pdf: "book.pdf", size: (300pt, 450pt))\n#sidenote(1)\n`;
  f.compiler.update(f.entry, header + '#lorem(80)\n');
  const r = await compile(f);
  assert.equal(r.plan.blocks[0].placement, 'after');
  assert.equal(r.plan.blocks[0].requestedPlacement, 'right');
  assert.equal(r.plan.blocks[0].fallback, 'overflow');
  assert.equal(r.notes.getPageCount(), 1);
  assert.equal(r.notes.getPage(0).getWidth(), 300);
  f.compiler.update(f.entry, header + 'FIRST PAGE\n#pagebreak()\nSECOND PAGE\n');
  const broken = await compile(f);
  assert.equal(broken.plan.blocks[0].fallback, 'overflow');
  assert.ok(broken.notes.getPages().every((p) => p.getWidth() === 300));
});

test('side layout preserves native labels, counters, footnotes and included-source navigation', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(
    f.answer,
    `#import "${PACKAGE_IMPORT}": *
= Side heading
#theorem[Every kernel is a subspace.]<side-kernel>
Reference @side-kernel. Side footnote#footnote[SHORT FOOTNOTE].
INCLUDED SIDE TARGET.
`,
  );
  f.compiler.update(f.answer, fs.readFileSync(f.answer, 'utf8'));
  f.compiler.update(
    f.entry,
    `#import "${PACKAGE_IMPORT}": *
#show: notebook.with(pdf: "book.pdf", size: (500pt, 450pt))
#sidenote(1, width: 50%)
#include "answer.typ"
#note(2)
#theorem[SECOND UNIT]<second-unit>
Cross note reference @side-kernel and @second-unit.
#context metadata((kind: "side-reference-count", figures: query(figure.where(kind: "math-note")).len()))
`,
  );
  const r = await compile(f);
  assert.equal(r.metadata.find((x) => x.kind === 'side-reference-count').figures, 2);
  assert.equal(r.plan.blocks[0].placement, 'right');
  assert.equal(r.notes.getPage(0).getWidth(), 250);
  await f.compiler.forward(f.answer, 4, 8);
  await wait(() => f.positions.length);
  const point = f.positions.at(-1);
  assert.equal(point.page, r.plan.blocks[0].first);
  f.compiler.inverse(point.page, point.x + 4, point.y - 3);
  await wait(() => f.sources.length);
  assert.equal(f.sources.at(-1).selection.start.line, 4);
  assert.ok(decodeURI(f.sources.at(-1).uri).endsWith('/answer.typ'));
});

test('a long side footnote also recovers a full-width regular page', async (t) => {
  const f = await fixture(t);
  f.compiler.update(
    f.entry,
    `#import "${PACKAGE_IMPORT}": *
#show: notebook.with(pdf: "book.pdf", size: (300pt, 450pt))
#sidenote(1)
SHORT BODY#footnote[#lorem(350)]
`,
  );
  const r = await compile(f);
  assert.equal(r.plan.blocks[0].placement, 'after');
  assert.ok(r.notes.getPages().every((p) => p.getWidth() === 300));
});

test('short syntax works with named imports and keeps native right alignment', async (t) => {
  const f = await fixture(t);
  f.compiler.update(
    f.entry,
    `#import "${PACKAGE_IMPORT}": notebook, note, sidenote
#show: notebook.with(pdf: "book.pdf", size: (300pt, 450pt))
#note(1, right)[#align(right)[RIGHT ALIGNED BODY]]
#sidenote(2)[SECOND BODY]
`,
  );
  const r = await compile(f);
  assert.equal(r.notes.getPageCount(), 2);
  assert.equal(r.plan.rows.filter((x) => x.kind === 'side').length, 2);
});

test('book-aware fallback reflows bookmark aliases and short pages after the first native snapshot', async (t) => {
  const f = await fixture(t);
  const header = `#import "${PACKAGE_IMPORT}": *\n#show: notebook.with(pdf: "book.pdf", size: (300pt, 450pt))\n`;
  f.compiler.update(
    f.entry,
    header + '#sidenote(1)[FIRST BODY]\n#note("Chapter", right)[SECOND BODY]\n',
  );
  const first = await f.compiler.compile();
  assert.equal(first.notes.getPage(0).getWidth(), 100);
  const paired = await f.compiler.compile({ book: f.book, snapshot: first });
  assert.ok(paired.plan.blocks.every((n) => n.placement === 'after' && n.fallback === 'multiple'));
  assert.ok(paired.notes.getPages().every((p) => p.getWidth() === 300));
  f.book.sizes[0].height = 300;
  f.compiler.update(f.entry, header + '#sidenote(1)[SHORT BODY]\n');
  const narrow = await f.compiler.compile();
  const shorter = await f.compiler.compile({ book: f.book, snapshot: narrow });
  assert.equal(shorter.plan.blocks[0].fallback, 'height');
  assert.equal(shorter.notes.getPage(0).getWidth(), 300);
  f.book.sizes[0].height = 450;
  const restored = await compile(f);
  assert.equal(restored.plan.blocks[0].placement, 'right');
  assert.equal(restored.notes.getPage(0).getWidth(), 100);
});
