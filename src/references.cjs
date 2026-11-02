const { createHash } = require('node:crypto');
const {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFString,
  PDFName,
  PDFRawStream,
  PDFRef,
  decodePDFRawStream,
} = require('pdf-lib');
const { PACKAGE_IMPORT } = require('./template.cjs');

function validAreas(areas) {
  return (
    Array.isArray(areas) &&
    areas.length > 0 &&
    areas.length <= 512 &&
    areas.every(
      (r) =>
        Array.isArray(r) &&
        r.length === 4 &&
        r.every((v) => Number.isFinite(v) && v >= 0 && v <= 1) &&
        r[0] < r[2] &&
        r[1] < r[3],
    )
  );
}
function stringLiteral(s) {
  return (
    '"' +
    s.replace(/["\\\x00-\x1f\x7f]/g, (c) =>
      c === '"' || c === '\\' ? '\\' + c : '\\u{' + c.codePointAt(0).toString(16) + '}',
    ) +
    '"'
  );
}
const tuple = (values) => '(' + values.join(', ') + ',)';
function clipSnippet(file, page, size, [l, t, r, b]) {
  const rect = [l * size.width, t * size.height, (r - l) * size.width, (b - t) * size.height];
  const points = (values) => tuple(values.map((x) => Number(x.toFixed(5))));
  return `#{\n  import "${PACKAGE_IMPORT}": source-clip\n  source-clip(read(${stringLiteral(file)}, encoding: none), ${page}, ${points([size.width, size.height])}, ${points(rect)})\n}`;
}
function commentSnippet({
  id,
  page,
  excerpt,
  areas,
  fingerprint,
  after,
  comment,
  reanchor = false,
}) {
  const anchor = typeof after === 'string' ? ', after: ' + stringLiteral(after) : '';
  const fn = reanchor ? 'source-anchor' : 'source-comment';
  const body = reanchor ? '' : `[\n    #text(${stringLiteral(comment)})\n  ]`;
  return `\n\n#{\n  import "${PACKAGE_IMPORT}": ${fn}\n  ${fn}(${page}, ${stringLiteral(excerpt)},\n    ${tuple(areas.map(tuple))},\n    id: "${id}", fingerprint: "${fingerprint}"${anchor},\n  )${body}\n}\n`;
}

// Hash what paints a page. File dates, PDF object numbers, incremental saves
// and annotation dictionaries are deliberately not part of a reading anchor.
function pageFingerprint(book, number) {
  const pages = (book.pageFingerprints ??= new Map());
  if (pages.has(number)) return pages.get(number);
  const page = book.doc.getPage(number - 1);
  const cache = (book.renderDigests ??= new WeakMap());
  const visiting = new Set();
  function digest(obj) {
    if (obj instanceof PDFRef) obj = book.doc.context.lookup(obj);
    if (!obj) return 'missing';
    if (cache.has(obj)) return cache.get(obj);
    if (visiting.has(obj)) return 'cycle';
    visiting.add(obj);
    const hash = createHash('sha256');
    if (obj instanceof PDFString || obj instanceof PDFHexString) {
      // PDF editors can serialize the same font or text bytes as literal or hexadecimal strings.
      hash.update('string:').update(obj.asBytes());
    } else if (obj instanceof PDFArray) {
      hash.update('array:' + obj.asArray().map(digest).join('/'));
    } else if (obj instanceof PDFDict || obj instanceof PDFRawStream) {
      const stream = obj instanceof PDFRawStream;
      const dict = stream ? obj.dict : obj;
      const ignored = new Set(['/Metadata', '/Parent', '/P', '/StructParent', '/StructParents']);
      if (stream) {
        let bytes = obj.getContents();
        ignored.add('/Length');
        try {
          bytes = decodePDFRawStream(obj).decode();
          ignored.add('/Filter');
          ignored.add('/DecodeParms');
        } catch {
          /* Opaque image filters are fingerprinted in their native encoding. */
        }
        hash.update(bytes);
      }
      const entries = dict
        .entries()
        .map(([k, v]) => [k.toString(), v])
        .filter(([k]) => !ignored.has(k));
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      for (const [k, v] of entries) hash.update(k + '=' + digest(v) + '\n');
    } else hash.update(obj.toString());
    visiting.delete(obj);
    const result = hash.digest('hex');
    cache.set(obj, result);
    return result;
  }
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray() : [contents];
  // Writers may surround the unchanged page program with save/restore streams
  // when attaching an annotation. These balanced outer operators paint nothing.
  function loneOperator(ref, operator) {
    const stream = book.doc.context.lookup(ref);
    if (!(stream instanceof PDFRawStream) || stream.getContents().length > 64) return false;
    try {
      return (
        Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1').trim() === operator
      );
    } catch {
      return false;
    }
  }
  while (streams.length > 1 && loneOperator(streams[0], 'q') && loneOperator(streams.at(-1), 'Q')) {
    streams.shift();
    streams.pop();
  }
  const geometry = [
    page.getMediaBox(),
    page.getCropBox(),
    page.getRotation().angle,
    page.node.get(PDFName.of('UserUnit'))?.toString() || '1',
  ];
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify([
        geometry,
        streams.map(digest),
        (page.node.Resources()?.entries() || [])
          .filter(
            ([k, v]) =>
              k.toString() !== '/ProcSet' &&
              !(
                book.doc.context.lookup(v) instanceof PDFDict &&
                !book.doc.context.lookup(v).keys().length
              ),
          )
          .map(([k, v]) => [k.toString(), digest(v)])
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ]),
    )
    .digest('hex')
    .slice(0, 24);
  pages.set(number, fingerprint);
  return fingerprint;
}
function notebookHighlights(book, metadata) {
  const marks = new Map();
  for (const m of metadata) {
    if (m?.kind !== 'pdf-highlight') continue;
    if (
      !/^[\w-]{1,80}$/.test(m.id) ||
      typeof m.id !== 'string' ||
      !Number.isInteger(m.page) ||
      m.page < 1 ||
      !validAreas(m.areas) ||
      typeof m.excerpt !== 'string' ||
      marks.has(m.id)
    )
      throw Error('笔记中的高亮引用位置或 ID 无效。');
    marks.set(m.id, {
      ...m,
      stale: m.page > book.pageCount || pageFingerprint(book, m.page) !== m.fingerprint,
    });
  }
  return [...marks.values()];
}
// Display fractions (top left) to original PDF user space, before widening a side page.
function pdfPoint(page, box, u, v) {
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const xy = { 0: [u, 1 - v], 90: [v, u], 180: [1 - u, v], 270: [1 - v, 1 - u] }[rot];
  return [box.x + xy[0] * box.width, box.y + xy[1] * box.height];
}
function addPdfHighlights(doc, page, box, marks) {
  const annotations = page.node.Annots();
  const existing = [];
  for (const ref of annotations?.asArray() || []) {
    const a = doc.context.lookup(ref);
    if (!(a instanceof PDFDict) || a.get(PDFName.of('Subtype'))?.toString() !== '/Highlight')
      continue;
    const quads = a
      .lookupMaybe(PDFName.of('QuadPoints'), PDFArray)
      ?.asArray()
      .map((n) => n.asNumber());
    if (quads) existing.push(quadBounds(quads));
  }
  for (const mark of marks) {
    const quads = mark.areas.flatMap(([l, t, r, b]) =>
      [
        [l, t],
        [r, t],
        [l, b],
        [r, b],
      ].flatMap(([u, v]) => pdfPoint(page, box, u, v)),
    );
    const boxes = quadBounds(quads);
    if (
      existing.some(
        (list) =>
          list.length === boxes.length &&
          boxes.every((r, i) => r.every((v, j) => Math.abs(v - list[i][j]) < 0.1)),
      )
    )
      continue;
    existing.push(boxes);
    const rect = [
      Math.min(...boxes.map((r) => r[0])),
      Math.min(...boxes.map((r) => r[1])),
      Math.max(...boxes.map((r) => r[2])),
      Math.max(...boxes.map((r) => r[3])),
    ];
    page.node.addAnnot(
      doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Highlight',
          Rect: rect,
          QuadPoints: quads,
          C: [1, 0.84, 0.16],
          CA: 0.45,
          F: 4,
        }),
      ),
    );
  }
}
function quadBounds(quads) {
  const result = [];
  for (let i = 0; i + 7 < quads.length; i += 8) {
    const [x1, y1, x2, y2, x3, y3, x4, y4] = quads.slice(i, i + 8);
    result.push([
      Math.min(x1, x2, x3, x4),
      Math.min(y1, y2, y3, y4),
      Math.max(x1, x2, x3, x4),
      Math.max(y1, y2, y3, y4),
    ]);
  }
  return result.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}
module.exports = {
  validAreas,
  clipSnippet,
  commentSnippet,
  pageFingerprint,
  notebookHighlights,
  addPdfHighlights,
  pdfPoint,
};
