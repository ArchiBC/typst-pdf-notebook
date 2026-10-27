const fs = require('node:fs/promises');
const path = require('node:path');
const { PDFDocument, PDFName, PDFHexString, StandardFonts } = require('pdf-lib');
const { PACKAGE_IMPORT } = require('../../src/template.cjs');

async function createBook(file, pages = 341) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.TimesRoman);
  for (let n = 1; n <= pages; n++) {
    const page = pdf.addPage([498.9, 708.66]);
    for (let line = 0; line < 16; line++)
      page.drawText(`Page ${n}: Linear maps preserve vector addition and scalar multiplication.`, {
        x: 35,
        y: 650 - line * 24,
        size: 10,
        font,
      });
  }
  const c = pdf.context,
    outline = c.obj({ Type: 'Outlines' }),
    ref = c.register(outline);
  const count = Math.min(167, pages);
  let first, previous;
  for (let n = 0; n < count; n++) {
    const p = n === 0 ? Math.min(23, pages) : 1 + Math.floor((n * pages) / count);
    const item = c.obj({
      Title: PDFHexString.fromText(n === 0 ? '习题1A' : `Chapter ${n}`),
      Parent: ref,
      Dest: [pdf.getPage(p - 1).ref, 'Fit'],
    });
    const current = c.register(item);
    if (!first) first = current;
    if (previous) {
      item.set(PDFName.of('Prev'), previous.ref);
      previous.item.set(PDFName.of('Next'), current);
    }
    previous = { item, ref: current };
  }
  outline.set(PDFName.of('First'), first);
  outline.set(PDFName.of('Last'), previous.ref);
  outline.set(PDFName.of('Count'), c.obj(count));
  pdf.catalog.set(PDFName.of('Outlines'), ref);
  await fs.writeFile(file, await pdf.save());
}
async function createHostFixture(root) {
  await fs.mkdir(path.join(root, 'notes'), { recursive: true });
  await createBook(path.join(root, 'book.pdf'));
  await fs.writeFile(
    path.join(root, 'template.typ'),
    `#import "${PACKAGE_IMPORT}" as core\n#let note = core.note\n#let source-ref = core.source-ref\n#let notebook = core.notebook.with(pdf: "book.pdf", title: "Test notebook", size: (498.9pt,708.66pt))\n`,
  );
  await fs.writeFile(
    path.join(root, 'main.typ'),
    [
      '#import "template.typ": notebook, note, source-ref',
      '#show: notebook',
      '',
      '#note("习题1A")',
      '#include "notes/answers-1a.typ"',
      '',
      '#note(28)',
      '',
      '= 我的想法',
      '',
      'Thoughts about linear maps.',
      '',
      'INLINE SOURCE TARGET. $a+b=b+a$.',
      '',
    ].join('\n'),
  );
  await fs.writeFile(
    path.join(root, 'notes/answers-1a.typ'),
    '= 习题解答\n\nINCLUDED ANSWER. A linear map preserves addition.\n',
  );
}
module.exports = { createBook, createHostFixture };
