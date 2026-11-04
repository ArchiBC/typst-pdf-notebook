const test = require('node:test');
const assert = require('node:assert/strict');

test('underlines align mixed-font fragments on one baseline and keep separate lines apart', async () => {
  const { underlineBands } = await import('../media/underlines.mjs');
  const selected = [
    [0.284361, 0.1562, 0.379929, 0.171006],
    [0.375296, 0.153598, 0.395883, 0.175066],
    [0.396491, 0.1562, 0.502762, 0.171006],
    [0.284361, 0.185, 0.39, 0.2],
  ];
  const before = structuredClone(selected);
  const lines = underlineBands(selected, 498.9, 708.66);
  assert.equal(lines.length, 2);
  assert.ok(Math.abs(lines[0][0] - selected[0][0]) < 1e-9);
  assert.ok(Math.abs(lines[0][2] - selected[2][2]) < 1e-9);
  assert.ok(Math.abs(lines[0][3] - selected[0][3]) < 1e-9);
  assert.ok(lines[1][1] > lines[0][3]);
  assert.deepEqual(selected, before, 'stored selection geometry remains unchanged');
});

test('underlines do not bridge a distant column on the same line', async () => {
  const { underlineBands } = await import('../media/underlines.mjs');
  const lines = underlineBands(
    [
      [0.1, 0.2, 0.2, 0.22],
      [0.55, 0.2, 0.65, 0.22],
    ],
    500,
    700,
  );
  assert.equal(lines.length, 2);
  assert.equal(lines[0][3], lines[1][3]);
});
test('PDF underline exports one thin aligned stroke for mixed fonts at every quarter turn', async () => {
  const {
    PDFDocument,
    PDFName,
    PDFArray,
    PDFDict,
    PDFRawStream,
    decodePDFRawStream,
    degrees,
  } = require('pdf-lib');
  const { addPdfHighlights, pdfPoint } = require('../src/references.cjs');
  const { underlineBands } = await import('../media/underlines.mjs');
  const areas = [
    [0.284361, 0.1562, 0.379929, 0.171006],
    [0.375296, 0.153598, 0.395883, 0.175066],
    [0.396491, 0.1562, 0.502762, 0.171006],
  ];
  for (const rotation of [0, 90, 180, 270]) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([498.9, 708.66]);
    page.setRotation(degrees(rotation));
    const box = { x: 0, y: 0, width: 498.9, height: 708.66 };
    addPdfHighlights(doc, page, box, [{ areas }], 'underline', underlineBands);
    const annotation = page.node.Annots().lookup(0, PDFDict);
    assert.equal(annotation.get(PDFName.of('Subtype')).toString(), '/Underline');
    const quads = annotation
      .lookup(PDFName.of('QuadPoints'), PDFArray)
      .asArray()
      .map((n) => n.asNumber());
    assert.equal(quads.length, 8, `rotation ${rotation} must have one continuous underline`);
    const width = rotation % 180 ? box.height : box.width;
    const height = rotation % 180 ? box.width : box.height;
    const [left, , , bottom] = underlineBands(areas, width, height)[0];
    const expected = pdfPoint(page, box, left, bottom);
    assert.ok(Math.abs(quads[4] - expected[0]) < 1e-8 && Math.abs(quads[5] - expected[1]) < 1e-8);
    const appearance = annotation
      .lookup(PDFName.of('AP'), PDFDict)
      .lookup(PDFName.of('N'), PDFRawStream);
    assert.match(Buffer.from(decodePDFRawStream(appearance).decode()).toString('ascii'), /0\.45 w/);
    addPdfHighlights(doc, page, box, [{ areas }], 'highlight', underlineBands);
    const high = page.node.Annots().lookup(1, PDFDict);
    assert.equal(
      high.lookup(PDFName.of('QuadPoints'), PDFArray).size(),
      24,
      'highlight keeps original rectangles',
    );
  }
});
