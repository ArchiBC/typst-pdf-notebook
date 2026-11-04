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
const ANCHOR_START = '  // pdf-notebook-anchors:start';
const ANCHOR_END = '  // pdf-notebook-anchors:end';

// The annotation body is ordinary Typst prose. Escape syntax supplied as plain
// text in the dialog so it remains editable without evaluating user input.
function commentMarkup(text) {
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return '#text(' + stringLiteral(text) + ')';
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/([\\#$\[\]*_`@<>])/g, '\\$1')
    .replace(/(^|\n)([ \t]*)([-+=/])/g, '$1$2\\$3')
    .replace(/(^|\n)([ \t]*\d+)\.(?=\s)/g, '$1$2\\.');
}
function commentBody({ page, id, comment }, eol = '\n', block = false) {
  const body = commentMarkup(comment);
  if (block)
    return [
      '',
      '',
      '#pdf-comment(' + page + ', ' + stringLiteral(id) + ')[',
      '  ' + body.replaceAll('\n', eol + '  '),
      ']',
      '',
    ].join(eol);
  return [
    '',
    '',
    '#pdf-comment(' + page + ', ' + stringLiteral(id) + ')',
    '',
    body.replaceAll('\n', eol),
    '',
    '',
  ].join(eol);
}
function commentAnchor({ id, page, excerpt, areas, fingerprint, after }, eol = '\n') {
  const anchor = typeof after === 'string' ? ', after: ' + stringLiteral(after) : '';
  return [
    '  pdf-anchor(' + page + ', ' + stringLiteral(excerpt) + ',',
    '    ' + tuple(areas.map(tuple)) + ',',
    '    id: ' + stringLiteral(id) + ', fingerprint: ' + stringLiteral(fingerprint) + anchor + ',',
    '  )',
    '',
  ].join(eol);
}
function commentSnippet(data) {
  return (
    (data.reanchor ? '' : commentBody(data)) +
    ['', '#{', ANCHOR_START, commentAnchor(data), ANCHOR_END, '}', ''].join('\n')
  );
}
function referenceEdits(source, data, effectiveSource = source, insertionOffset) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const start = source.indexOf(ANCHOR_START),
    end = source.indexOf(ANCHOR_END);
  if (
    start < 0 !== end < 0 ||
    (start >= 0 &&
      (end < start ||
        source.indexOf(ANCHOR_START, start + 1) >= 0 ||
        source.indexOf(ANCHOR_END, end + 1) >= 0))
  )
    throw Error('笔记中的引用定位数据不完整，请恢复定位数据后重试。');
  let block = -1;
  if (start >= 0) {
    const header = '#{' + eol + ANCHOR_START;
    block = source.lastIndexOf(header, start);
    const footer = ANCHOR_END + eol + '}';
    if (block < 0 || source.slice(end, end + footer.length) !== footer)
      throw Error('笔记中的引用定位数据格式已更改，请恢复定位数据后重试。');
    if (!data.reanchor && insertionOffset > block && insertionOffset < end + footer.length)
      throw Error('请将光标移到引用定位数据之外，再插入注释。');
  }
  const position = insertionOffset ?? (block < 0 ? source.length : block);
  if (!Number.isInteger(position) || position < 0 || position > source.length)
    throw Error('笔记光标位置无效，请重新定位后重试。');
  const edits = [];
  const wildcard = new RegExp(
    '^\\s*#import\\s+"' + PACKAGE_IMPORT.replaceAll('.', '\\.') + '"\\s*:\\s*\\*',
    'm',
  );
  const ownImport =
    '#import "' + PACKAGE_IMPORT + '": pdf-comment, pdf-anchor // PDF Notebook 引用';
  const boundary = source.search(/^[ \t]*#(?:show:|note\b|sidenote\b|pdf-comment\b)/m);
  const prelude = source.slice(0, boundary < 0 ? source.length : boundary);
  const imports = [
    ...prelude.matchAll(
      /^[ \t]*#import[ \t]+"@local\/typst-pdf-notebook:\d+\.\d+\.\d+"[^\r\n]*(?:\r?\n|$)/gm,
    ),
  ];
  const last = imports.at(-1);
  const importEnd = last ? last.index + last[0].length : source.startsWith('\ufeff') ? 1 : 0;
  if (!data.reanchor && position < importEnd) throw Error('请将光标移到导入语句之后，再插入注释。');
  if (!wildcard.test(effectiveSource) && !effectiveSource.includes(ownImport)) {
    const separator = last && !last[0].endsWith('\n') ? eol : '';
    edits.push({ start: importEnd, text: separator + ownImport + eol });
  }
  const body = data.reanchor ? '' : commentBody(data, eol);
  const anchor = commentAnchor(data, eol);
  if (body)
    edits.push({
      start: position,
      text: body,
      role: 'comment',
      caret: body.length - eol.length * 2,
    });
  if (start < 0) {
    const footer = eol + ['#{', ANCHOR_START, anchor + ANCHOR_END, '}', ''].join(eol);
    const atEnd = edits.find((edit) => edit.role === 'comment' && edit.start === source.length);
    if (atEnd) atEnd.text += footer;
    else edits.push({ start: source.length, text: footer });
  } else edits.push({ start: end, text: anchor });
  // VS Code treats same-position edits as unordered. Combine them in source order.
  for (let i = 0; i < edits.length; i++)
    for (let j = edits.length - 1; j > i; j--)
      if (edits[i].start === edits[j].start) {
        const prefixLength = edits[i].text.length;
        if (edits[j].role === 'comment') {
          edits[i].role = 'comment';
          edits[i].caret = prefixLength + edits[j].caret;
        }
        edits[i].text += edits[j].text;
        edits.splice(j, 1);
      }
  return edits;
}

// Only migrate the exact 0.3.4 output. Edited or rebound blocks stay intact.
function legacyReferenceEdits(source, effectiveSource = source) {
  if (source.includes(': source-anchor')) return [];
  const literal = '"(?:[^"\\\\\\r\\n]|\\\\(?:["\\\\]|u\\{[0-9a-fA-F]+\\}))*"';
  const pattern = new RegExp(
    '^#\\{\\r?\\n  import "@local/typst-pdf-notebook:0\\.3\\.4": source-comment\\r?\\n' +
      '  source-comment\\((\\d+), (' +
      literal +
      '),\\r?\\n' +
      '    (\\([0-9.,()\\s]+\\)),\\r?\\n' +
      '    id: ("[\\w-]{1,80}"), fingerprint: ("[0-9a-f]{24}")' +
      '(?:, after: (' +
      literal +
      '))?,\\r?\\n' +
      '  \\)\\[\\r?\\n    #text\\((' +
      literal +
      ')\\)\\r?\\n  \\]\\r?\\n\\}',
    'gm',
  );
  const decode = (value) =>
    value
      .slice(1, -1)
      .replace(/\\(u\{([0-9a-fA-F]+)\}|["\\])/g, (_, code, hex) =>
        hex ? String.fromCodePoint(parseInt(hex, 16)) : code,
      );
  const protectedAt = (offset) => {
    const prefix = source.slice(0, offset);
    if (prefix.lastIndexOf('/*') > prefix.lastIndexOf('*/')) return true;
    let fence = 0;
    for (const line of prefix.split(/\r?\n/)) {
      const found = /^[ \t]*(`{3,})/.exec(line);
      if (!found) continue;
      if (!fence) fence = found[1].length;
      else if (found[1].length >= fence) fence = 0;
    }
    return Boolean(fence);
  };
  const found = [];
  for (const match of source.matchAll(pattern)) {
    if (protectedAt(match.index)) continue;
    const values = match[3].match(/\d+(?:\.\d+)?/g)?.map(Number) || [];
    const areas = [];
    for (let i = 0; i < values.length; i += 4) areas.push(values.slice(i, i + 4));
    if (!validAreas(areas)) continue;
    found.push({
      start: match.index,
      end: match.index + match[0].length,
      data: {
        page: Number(match[1]),
        excerpt: decode(match[2]),
        areas,
        id: decode(match[4]),
        fingerprint: decode(match[5]),
        after: match[6] ? decode(match[6]) : undefined,
        comment: decode(match[7]),
        reanchor: true,
      },
    });
  }
  if (!found.length) return [];
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const combined = found.map(({ data }) => commentAnchor(data, eol)).join('');
  const anchorEdits = referenceEdits(source, found[0].data, effectiveSource);
  const single = commentAnchor(found[0].data, eol);
  const target = anchorEdits.find((edit) => edit.text.includes(single));
  if (!target) throw Error('无法安全整理引用定位数据。');
  target.text = target.text.replace(single, combined);
  return [
    ...anchorEdits,
    ...found.map(({ start, end, data }) => ({
      start,
      end,
      text: commentBody(data, eol, true)
        .replace(new RegExp('^(?:\\r?\\n){2}'), '')
        .replace(/\r?\n$/, ''),
    })),
  ];
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
function addPdfHighlights(
  doc,
  page,
  box,
  marks,
  style = 'underline',
  underlineBands = (areas) => areas,
) {
  const subtype = style === 'highlight' ? 'Highlight' : 'Underline';
  const annotations = page.node.Annots();
  const existing = [];
  for (const ref of annotations?.asArray() || []) {
    const a = doc.context.lookup(ref);
    if (!(a instanceof PDFDict) || a.get(PDFName.of('Subtype'))?.toString() !== '/' + subtype)
      continue;
    const quads = a
      .lookupMaybe(PDFName.of('QuadPoints'), PDFArray)
      ?.asArray()
      .map((n) => n.asNumber());
    if (quads) existing.push(quadBounds(quads));
  }
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  const width = rotation % 180 ? box.height : box.width;
  const height = rotation % 180 ? box.width : box.height;
  for (const mark of marks) {
    const areas = style === 'underline' ? underlineBands(mark.areas, width, height) : mark.areas;
    const quads = areas.flatMap(([l, t, r, b]) =>
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
    const padding = style === 'underline' ? 0.4 : 0;
    const rect = [
      Math.min(...boxes.map((r) => r[0])) - padding,
      Math.min(...boxes.map((r) => r[1])) - padding,
      Math.max(...boxes.map((r) => r[2])) + padding,
      Math.max(...boxes.map((r) => r[3])) + padding,
    ];
    const annotation = {
      Type: 'Annot',
      Subtype: subtype,
      Rect: rect,
      QuadPoints: quads,
      C: style === 'highlight' ? [1, 0.84, 0.16] : [0.78, 0.22, 0.25],
      CA: style === 'highlight' ? 0.45 : 1,
      F: 4,
    };
    if (style === 'underline') {
      const number = (v) => Number(v.toFixed(4));
      const operations = ['q', '0.78 0.22 0.25 RG', '0.45 w'];
      for (let i = 0; i + 7 < quads.length; i += 8)
        operations.push(
          number(quads[i + 4] - rect[0]) +
            ' ' +
            number(quads[i + 5] - rect[1]) +
            ' m ' +
            number(quads[i + 6] - rect[0]) +
            ' ' +
            number(quads[i + 7] - rect[1]) +
            ' l S',
        );
      operations.push('Q');
      const appearance = doc.context.register(
        doc.context.flateStream(operations.join('\n'), {
          Type: 'XObject',
          Subtype: 'Form',
          FormType: 1,
          BBox: [0, 0, rect[2] - rect[0], rect[3] - rect[1]],
          Resources: {},
        }),
      );
      annotation.Border = [0, 0, 0.45];
      annotation.BS = { W: 0.45, S: 'S' };
      annotation.AP = { N: appearance };
    }
    page.node.addAnnot(doc.context.register(doc.context.obj(annotation)));
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
  referenceEdits,
  legacyReferenceEdits,
  pageFingerprint,
  notebookHighlights,
  addPdfHighlights,
  pdfPoint,
};
