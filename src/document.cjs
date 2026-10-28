const {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFArray,
  PDFRef,
  PDFString,
  PDFHexString,
  degrees,
} = require('pdf-lib');

function object(doc, value) {
  return value instanceof PDFRef ? doc.context.lookup(value) : value;
}
function text(value) {
  return value?.decodeText?.() ?? '';
}
function readBookmarks(doc) {
  const pages = new Map(doc.getPages().map((p, i) => [p.ref.toString(), i + 1]));
  const named = new Map();
  const seenNames = new Set();
  function names(value) {
    const dict = object(doc, value);
    if (!(dict instanceof PDFDict) || seenNames.has(dict)) return;
    seenNames.add(dict);
    const pairs = dict.lookupMaybe(PDFName.of('Names'), PDFArray);
    if (pairs)
      for (let i = 0; i + 1 < pairs.size(); i += 2)
        named.set(text(object(doc, pairs.get(i))), pairs.get(i + 1));
    const kids = dict.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (kids) for (const child of kids.asArray()) names(child);
  }
  const catalogNames = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  if (catalogNames) names(catalogNames.get(PDFName.of('Dests')));
  const legacy = doc.catalog.lookupMaybe(PDFName.of('Dests'), PDFDict);
  if (legacy) for (const [key, value] of legacy.entries()) named.set(key.decodeText(), value);
  function destination(value, depth = 0) {
    if (depth > 12) return null;
    value = object(doc, value);
    if (value instanceof PDFString || value instanceof PDFHexString || value instanceof PDFName)
      return destination(named.get(text(value) || value.decodeText?.()), depth + 1);
    if (value instanceof PDFDict) return destination(value.get(PDFName.of('D')), depth + 1);
    if (value instanceof PDFArray) {
      const first = value.get(0);
      return (
        pages.get(first?.toString()) ??
        (Number.isInteger(first?.asNumber?.()) ? first.asNumber() + 1 : null)
      );
    }
    return null;
  }
  const outlines = doc.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict),
    result = [],
    visited = new Set();
  function walk(value, depth, parentTitle = null) {
    while (value) {
      const node = object(doc, value);
      if (!(node instanceof PDFDict) || visited.has(node) || visited.size > 10000) return;
      visited.add(node);
      const action = node.lookupMaybe(PDFName.of('A'), PDFDict);
      const page = destination(node.get(PDFName.of('Dest')) || action?.get(PDFName.of('D')));
      const title = text(node.lookup(PDFName.of('Title')));
      if (page)
        result.push({
          title,
          page,
          depth,
          parentTitle,
          id: `pdf-${String(result.length + 1).padStart(3, '0')}`,
        });
      walk(node.get(PDFName.of('First')), depth + 1, title);
      value = node.get(PDFName.of('Next'));
    }
  }
  if (outlines) walk(outlines.get(PDFName.of('First')), 0);
  return { items: result, destination };
}

function visibleBox(page) {
  const media = page.getMediaBox(),
    crop = page.getCropBox();
  const x = Math.max(media.x, crop.x),
    y = Math.max(media.y, crop.y);
  const width = Math.min(media.x + media.width, crop.x + crop.width) - x;
  const height = Math.min(media.y + media.height, crop.y + crop.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : media;
}

async function loadBook(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return {
    doc,
    bytes,
    pageCount: doc.getPageCount(),
    sizes: doc.getPages().map((p) => {
      const rotation = p.getRotation().angle;
      const swap = Math.abs(rotation) % 180 === 90;
      const box = visibleBox(p);
      return {
        width: swap ? box.height : box.width,
        height: swap ? box.width : box.height,
        rotation,
      };
    }),
    ...readBookmarks(doc),
  };
}

function planNotebook(book, notes, metadata) {
  const configs = metadata.filter((x) => x?.kind === 'pdf-notebook');
  if (configs.length !== 1 || configs[0].version !== 1)
    throw Error('入口需要使用笔记模板的 #show: notebook。');
  const config = configs[0];
  const autoDepth = Math.max(0, ...book.items.map((x) => x.depth)) + 1;
  const custom = (config.bookmarks || []).map((b) => ({
    ...b,
    origin: 'custom',
    depth: Number.isInteger(b.depth) ? b.depth : autoDepth,
  }));
  const marks = [...book.items.map((x) => ({ ...x, origin: 'source' })), ...custom];
  for (const m of marks)
    if (!Number.isInteger(m.page) || m.page < 1 || m.page > book.pageCount)
      throw Error(`书签页码超出原书范围：${m.title}`);
  function resolve(after) {
    if (Number.isInteger(after) && after >= 1 && after <= book.pageCount) return after;
    if (typeof after === 'string') {
      let found = marks.filter((x) => x.id === after);
      if (!found.length) found = marks.filter((x) => x.title === after);
      if (found.length === 1) return found[0].page;
    }
    throw Error(`无法唯一确定插页位置：${after}。请使用原 PDF 页码或唯一书签。`);
  }
  const starts = metadata.filter((x) => x?.kind === 'pdf-note'),
    ids = new Set();
  const blocks = starts.map((n, i) => {
    if (typeof n.id !== 'string' || ids.has(n.id)) throw Error('笔记 id 为空或重复。');
    ids.add(n.id);
    const end = i + 1 < starts.length ? starts[i + 1].page - 1 : notes.getPageCount();
    if (!Number.isInteger(n.page) || n.page < 1 || n.page > end || end > notes.getPageCount())
      throw Error(`笔记分页元数据无效：${n.id}`);
    const placement = n.placement ?? 'after';
    if (!['after', 'right'].includes(placement)) throw Error(`未知笔记位置：${placement}`);
    return {
      ...n,
      placement,
      requestedPlacement: n.requestedPlacement ?? placement,
      after: resolve(n.after),
      first: n.page,
      last: end,
    };
  });
  const grouped = new Map();
  for (const n of blocks) {
    if (!grouped.has(n.after)) grouped.set(n.after, []);
    grouped.get(n.after).push(n);
  }
  const rows = [],
    sourceToOutput = {},
    notesToOutput = {};
  function push(row) {
    row.outputPage = rows.length + 1;
    row.parts ??= [
      { kind: row.kind, page: row.page, x: 0, y: 0, width: row.width, height: row.height },
    ];
    rows.push(row);
  }
  for (let p = 1; p <= book.pageCount; p++) {
    const attached = grouped.get(p) || [],
      size = book.sizes[p - 1];
    const candidates = attached.filter((n) => n.placement === 'right');
    let side;
    for (const n of candidates) {
      if (candidates.length > 1) n.fallback = 'multiple';
      else if (n.first !== n.last) n.fallback = 'overflow';
      else if (notes.getPage(n.first - 1).getHeight() > size.height + 0.01) n.fallback = 'height';
      if (n.fallback) n.placement = 'after';
      else side = n;
    }
    sourceToOutput[p] = rows.length + 1;
    if (side) {
      const note = notes.getPage(side.first - 1);
      notesToOutput[side.first] = rows.length + 1;
      push({
        kind: 'side',
        key: `side:${p}:${side.id}`,
        page: p,
        title: side.title,
        width: size.width + note.getWidth(),
        height: size.height,
        parts: [
          { kind: 'source', page: p, x: 0, y: 0, width: size.width, height: size.height },
          {
            kind: 'note',
            page: side.first,
            x: size.width,
            y: 0,
            width: note.getWidth(),
            height: note.getHeight(),
            noteId: side.id,
          },
        ],
      });
    } else push({ kind: 'source', key: `source:${p}`, page: p, ...size, title: `原书 ${p}` });
    for (const n of attached.filter((n) => n !== side))
      for (let k = n.first; k <= n.last; k++) {
        const page = notes.getPage(k - 1);
        notesToOutput[k] = rows.length + 1;
        push({
          kind: 'note',
          key: `note:${n.id}:${k - n.first + 1}`,
          page: k,
          noteId: n.id,
          fallback: n.fallback,
          title: n.title,
          width: page.getWidth(),
          height: page.getHeight(),
        });
      }
  }
  const outline = [
    ...marks.map((m, i) => ({ ...m, outputPage: sourceToOutput[m.page], order: i })),
    ...blocks.map((n, i) => ({
      title: n.title,
      origin: 'note',
      depth: 1,
      outputPage: notesToOutput[n.first],
      order: marks.length + i,
    })),
  ].sort((a, b) => a.outputPage - b.outputPage || a.order - b.order);
  return { config, rows, blocks, outline, sourceToOutput, notesToOutput, noteCount: blocks.length };
}

function writeOutline(doc, items) {
  const context = doc.context,
    root = context.obj({ Type: 'Outlines' }),
    rootRef = context.register(root);
  const sourceStack = [],
    extraStack = [],
    top = [];
  for (const item of items) {
    const depth = Math.max(0, item.depth || 0),
      isSource = item.origin === 'source';
    const stack = isSource ? sourceStack : extraStack;
    if (isSource) extraStack.length = 0;
    while (stack.length && stack.at(-1).depth >= depth) stack.pop();
    const node = {
      item,
      depth,
      children: [],
      dict: context.obj({
        Title: PDFHexString.fromText(item.title),
        Dest: [doc.getPage(item.outputPage - 1).ref, 'XYZ', null, null, null],
      }),
    };
    node.ref = context.register(node.dict);
    const parent =
      stack.at(-1) || (!isSource ? [...sourceStack].reverse().find((n) => n.depth < depth) : null);
    if (parent) parent.children.push(node);
    else top.push(node);
    stack.push(node);
  }
  function wire(nodes, parent) {
    let total = 0;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      n.dict.set(PDFName.of('Parent'), parent);
      if (i) n.dict.set(PDFName.of('Prev'), nodes[i - 1].ref);
      if (i + 1 < nodes.length) n.dict.set(PDFName.of('Next'), nodes[i + 1].ref);
      const descendants = wire(n.children, n.ref);
      if (n.children.length) {
        n.dict.set(PDFName.of('First'), n.children[0].ref);
        n.dict.set(PDFName.of('Last'), n.children.at(-1).ref);
        n.dict.set(PDFName.of('Count'), context.obj(descendants));
      }
      total += 1 + descendants;
    }
    return total;
  }
  const count = wire(top, rootRef);
  if (top.length) {
    root.set(PDFName.of('First'), top[0].ref);
    root.set(PDFName.of('Last'), top.at(-1).ref);
  }
  root.set(PDFName.of('Count'), context.obj(count));
  doc.catalog.set(PDFName.of('Outlines'), rootRef);
}

function rewriteLinks(source, copies, output, destination, toOutput, sourceToOutput = toOutput) {
  for (let p = 0; p < copies.length; p++) {
    const original = source.getPage(p).node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    const copied = copies[p].node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!original || !copied) continue;
    for (let i = 0; i < Math.min(original.size(), copied.size()); i++) {
      const src = object(source, original.get(i)),
        dst = object(output, copied.get(i));
      if (!(src instanceof PDFDict) || !(dst instanceof PDFDict)) continue;
      const action = src.lookupMaybe(PDFName.of('A'), PDFDict);
      const sourceLink = /^pdf-notebook-source:(\d+)$/.exec(
        text(action?.lookupMaybe(PDFName.of('URI'), PDFString, PDFHexString)),
      );
      if (sourceLink && sourceToOutput[sourceLink[1]]) {
        dst.delete(PDFName.of('A'));
        dst.set(
          PDFName.of('Dest'),
          output.context.obj([
            output.getPage(sourceToOutput[sourceLink[1]] - 1).ref,
            'XYZ',
            null,
            null,
            null,
          ]),
        );
        continue;
      }
      const page = destination(src.get(PDFName.of('Dest')) || action?.get(PDFName.of('D')));
      if (page && toOutput[page]) {
        dst.delete(PDFName.of('A'));
        dst.set(
          PDFName.of('Dest'),
          output.context.obj([output.getPage(toOutput[page] - 1).ref, 'XYZ', null, null, null]),
        );
      }
    }
  }
}

function transformAnnotations(page, matrix) {
  const annotations = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (!annotations) return;
  const [a, b, c, d, e, f] = matrix;
  const point = (x, y) => [a * x + c * y + e, b * x + d * y + f];
  for (const ref of annotations.asArray()) {
    const annotation = object(page.doc, ref);
    if (!(annotation instanceof PDFDict)) continue;
    const rect = annotation.lookupMaybe(PDFName.of('Rect'), PDFArray);
    if (rect?.size() === 4) {
      const [x0, y0, x1, y1] = rect.asArray().map((n) => n.asNumber());
      const corners = [point(x0, y0), point(x1, y0), point(x0, y1), point(x1, y1)];
      annotation.set(
        PDFName.of('Rect'),
        page.doc.context.obj([
          Math.min(...corners.map((p) => p[0])),
          Math.min(...corners.map((p) => p[1])),
          Math.max(...corners.map((p) => p[0])),
          Math.max(...corners.map((p) => p[1])),
        ]),
      );
    }
    const quad = annotation.lookupMaybe(PDFName.of('QuadPoints'), PDFArray);
    if (quad && quad.size() % 2 === 0) {
      const values = quad.asArray().map((n) => n.asNumber()),
        transformed = [];
      for (let i = 0; i < values.length; i += 2)
        transformed.push(...point(values[i], values[i + 1]));
      annotation.set(PDFName.of('QuadPoints'), page.doc.context.obj(transformed));
    }
  }
}

function widenSource(page, row) {
  const box = visibleBox(page),
    source = row.parts[0];
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  const { x, y, width: w, height: h } = box;
  const matrices = {
    0: [1, 0, 0, 1, -x, -y],
    90: [0, -1, 1, 0, -y, w + x],
    180: [-1, 0, 0, -1, w + x, h + y],
    270: [0, 1, -1, 0, h + y, -x],
  };
  const matrix = matrices[rotation];
  if (!matrix) throw Error(`原页旋转角度不受支持：${rotation}`);
  matrix[5] += row.height - source.height;
  const context = page.doc.context;
  // Retain the original streams/resources and clip before widening the crop box.
  // Normalizing /Rotate makes the added column stay on the visible right side.
  page.node.normalize();
  page.node.wrapContentStreams(
    context.register(
      context.flateStream(
        `q\n0 ${row.height - source.height} ${source.width} ${source.height} re W n\n${matrix.join(' ')} cm\n`,
      ),
    ),
    context.register(context.flateStream('Q\n')),
  );
  transformAnnotations(page, matrix);
  page.setRotation(degrees(0));
  page.setMediaBox(0, 0, row.width, row.height);
  page.setCropBox(0, 0, row.width, row.height);
}

async function exportNotebook(book, notes, plan) {
  const result = await PDFDocument.create();
  const source = await result.copyPages(book.doc, book.doc.getPageIndices());
  const inserts = plan.blocks.length ? await result.copyPages(notes, notes.getPageIndices()) : [];
  for (const row of plan.rows) {
    if (row.kind !== 'side') {
      result.addPage((row.kind === 'source' ? source : inserts)[row.page - 1]);
      continue;
    }
    const page = source[row.page - 1];
    result.addPage(page);
    widenSource(page, row);
    const part = row.parts[1],
      note = inserts[part.page - 1];
    const embedded = await result.embedPage(note);
    page.drawPage(embedded, { x: part.x, y: row.height - part.y - part.height });
    const dy = row.height - part.y - part.height;
    transformAnnotations(note, [1, 0, 0, 1, part.x, dy]);
    const annotations = note.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (annotations) for (const ref of annotations.asArray()) page.node.addAnnot(ref);
  }
  result.setTitle(plan.config.title || 'PDF 阅读笔记');
  result.setCreator('Typst PDF Notebook');
  rewriteLinks(book.doc, source, result, book.destination, plan.sourceToOutput);
  const noteDest = readBookmarks(notes).destination;
  rewriteLinks(notes, inserts, result, noteDest, plan.notesToOutput, plan.sourceToOutput);
  writeOutline(result, plan.outline);
  return result.save();
}

module.exports = { loadBook, readBookmarks, planNotebook, exportNotebook };
