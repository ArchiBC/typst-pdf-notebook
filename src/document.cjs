const {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFArray,
  PDFRef,
  PDFString,
  PDFHexString,
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

async function loadBook(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return {
    doc,
    bytes,
    pageCount: doc.getPageCount(),
    sizes: doc.getPages().map((p) => {
      const rotation = p.getRotation().angle;
      const swap = Math.abs(rotation) % 180 === 90;
      return {
        width: swap ? p.getHeight() : p.getWidth(),
        height: swap ? p.getWidth() : p.getHeight(),
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
    return { ...n, after: resolve(n.after), first: n.page, last: end };
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
    rows.push(row);
  }
  for (let p = 1; p <= book.pageCount; p++) {
    sourceToOutput[p] = rows.length + 1;
    push({ kind: 'source', key: `source:${p}`, page: p, ...book.sizes[p - 1], title: `原书 ${p}` });
    for (const n of grouped.get(p) || [])
      for (let k = n.first; k <= n.last; k++) {
        const page = notes.getPage(k - 1);
        notesToOutput[k] = rows.length + 1;
        push({
          kind: 'note',
          key: `note:${n.id}:${k - n.first + 1}`,
          page: k,
          noteId: n.id,
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

async function exportNotebook(book, notes, plan) {
  const result = await PDFDocument.create();
  const source = await result.copyPages(book.doc, book.doc.getPageIndices());
  const inserts = plan.blocks.length ? await result.copyPages(notes, notes.getPageIndices()) : [];
  for (const row of plan.rows)
    result.addPage((row.kind === 'source' ? source : inserts)[row.page - 1]);
  result.setTitle(plan.config.title || 'PDF 阅读笔记');
  result.setCreator('Typst PDF Notebook');
  rewriteLinks(book.doc, source, result, book.destination, plan.sourceToOutput);
  const noteDest = readBookmarks(notes).destination;
  rewriteLinks(notes, inserts, result, noteDest, plan.notesToOutput, plan.sourceToOutput);
  writeOutline(result, plan.outline);
  return result.save();
}

module.exports = { loadBook, readBookmarks, planNotebook, exportNotebook };
