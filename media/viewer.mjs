const host = window.notebookHost;
const assets = window.notebookAssets;
const pdfjs = await import(assets.pdfjs);
pdfjs.GlobalWorkerOptions.workerSrc = assets.worker;
// VS Code webview workers cannot import vscode-resource URLs. Load the bundled
// worker on the page and give it a Blob URL; the shared worker is owned here.
const workerSource = await (await fetch(assets.worker)).text();
const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
const workerPort = new Worker(workerUrl, { type: 'module' });
const worker = new pdfjs.PDFWorker({ port: workerPort });
addEventListener('unload', () => {
  worker.destroy();
  workerPort.terminate();
  URL.revokeObjectURL(workerUrl);
});
const $ = (id) => document.getElementById(id),
  viewer = $('viewer'),
  pages = $('pages');
let book,
  notes,
  bookVersion,
  plan = [],
  outline = [],
  generation = 0,
  zoom = 'width',
  scale = 1,
  maxPageWidth = 499,
  geometry = [],
  notesToOutput = new Map(),
  rendering = 0,
  anchorPending,
  navigationFocus;
const nodes = new Map(),
  queue = new Set(),
  rendered = new Map(),
  tasks = new Map(),
  inFlight = new Map(),
  canvasBytes = new Map();
const CACHE_BYTES = 96 * 1024 * 1024,
  MAX_CANVAS_PIXELS = 16 * 1024 * 1024;
let ticks = 0,
  zoomTimer;
const options = {
  worker,
  useWorkerFetch: false,
  cMapUrl: assets.cmaps,
  cMapPacked: true,
  standardFontDataUrl: assets.fonts,
  wasmUrl: assets.wasm,
  isEvalSupported: false,
};
function status(text, error = false) {
  $('status').textContent = text;
  document.querySelector('footer').classList.toggle('error', error);
}
function showError(message) {
  $('problem').hidden = false;
  $('empty').hidden = true;
  $('problem-detail').textContent = message.text;
  $('upgrade-template').hidden = !message.canUpgradeTemplate;
  $('problem-hint').textContent = message.canUpgradeTemplate
    ? '当前笔记使用旧版模板。#note(..., right) 和 #sidenote(...) 需要新版模板；升级保留正文与未保存修改，并支持撤销。'
    : '请查看错误详情并修正笔记源码，预览会自动重试。';
  status('笔记编译失败，修正源码后自动重试。', true);
  report();
}
function report() {
  document.body.dataset.renderedPages = String(rendered.size);
  host.postMessage({
    type: 'diagnostics',
    value: {
      totalPages: plan.length,
      canvases: pages.querySelectorAll('.paper canvas').length,
      renderedPages: rendered.size,
      canvasBytes: [...canvasBytes.values()].reduce((a, b) => a + b, 0),
      notesPages: notes?.numPages,
      bookPages: book?.numPages,
      currentOutputPage: Number($('page').value),
      revision: generation,
      error: $('problem').hidden ? null : $('problem-detail').textContent,
      templateUpgradeAvailable: !$('upgrade-template').hidden,
    },
  });
}
function capture() {
  const top = viewer.scrollTop;
  const node = geometry[rowAt(top)];
  return node ? { key: node.row.key, fraction: (top - node.top) / node.height } : null;
}
function restore(anchor) {
  if (!anchor) return;
  const node = nodes.get(anchor.key);
  if (node) viewer.scrollTop = node.top + anchor.fraction * node.height;
}
function rowAt(y) {
  let lo = 0,
    hi = geometry.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (geometry[mid].top + geometry[mid].height <= y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function visibleRows(padding = 0) {
  const bottom = viewer.scrollTop + viewer.clientHeight + padding;
  const list = [];
  for (
    let i = rowAt(viewer.scrollTop - padding);
    i < geometry.length && geometry[i].top < bottom;
    i++
  )
    list.push(geometry[i]);
  return list;
}
function release(key) {
  tasks.get(key)?.cancel();
  tasks.delete(key);
  const node = nodes.get(key);
  if (node) {
    node.token++;
    for (const layer of node.textLayers || []) layer.cancel();
    node.textLayers = [];
    node.textElements = [];
    node.linkLayers = [];
    for (const canvas of node.paper.querySelectorAll('canvas')) canvas.width = canvas.height = 0;
    node.paper.replaceChildren();
    // cleanup waits internally for cancelled PDF.js render tasks to finish.
    for (const page of node.pdfPages || []) page.cleanup();
    node.pdfPages = [];
  }
  canvasBytes.delete(key);
  rendered.delete(key);
  queue.delete(key);
}
function pageScale(next, width = maxPageWidth) {
  const available = Math.max(180, viewer.clientWidth - (viewer.clientWidth < 480 ? 18 : 42));
  return next === 'width' ? available / width : (Number(next) * 96) / 72;
}
function layout() {
  scale = pageScale(zoom);
  for (const row of plan) {
    const node = nodes.get(row.key),
      paper = node?.paper;
    if (!paper) continue;
    // Fit each sheet independently: a single widened page must not shrink the book.
    node.scale = zoom === 'width' ? (scale * maxPageWidth) / row.width : scale;
    paper.style.width = `${row.width * node.scale}px`;
    paper.style.height = `${row.height * node.scale}px`;
    paper.style.setProperty('--scale-factor', node.scale);
    paper.style.setProperty('--total-scale-factor', node.scale);
    paper.style.setProperty('--user-unit', 1);
    paper.style.setProperty('--scale-round-x', '1px');
    paper.style.setProperty('--scale-round-y', '1px');
    node.style.width = paper.style.width;
    for (const element of node.textElements || [])
      element.style.transform = `scale(${node.scale / node.rasterScale})`;
    for (const layer of node.linkLayers || []) {
      layer.style.transformOrigin = '0 0';
      layer.style.transform = `scale(${node.scale / node.rasterScale})`;
    }
  }
  // One geometry pass after layout; scrolling never scans every page or reads layout.
  geometry = plan.map((row) => nodes.get(row.key));
  for (const node of geometry) {
    node.top = node.offsetTop;
    node.height = node.offsetHeight;
  }
}
function queueVisible() {
  const nearby = visibleRows(600),
    allowed = new Set(nearby.map((node) => node.row.key));
  for (const key of queue) if (!allowed.has(key)) queue.delete(key);
  for (const key of inFlight.keys()) if (!allowed.has(key)) release(key);
  for (const node of nearby) if (!rendered.has(node.row.key)) queue.add(node.row.key);
  pump();
}
function evict() {
  let bytes = [...canvasBytes.values()].reduce((a, b) => a + b, 0);
  if (rendered.size <= 8 && bytes <= CACHE_BYTES) return;
  const center = viewer.scrollTop + viewer.clientHeight / 2;
  const candidates = [...rendered.keys()]
    .map((key) => ({ key, d: Math.abs(nodes.get(key).top + nodes.get(key).height / 2 - center) }))
    .sort((a, b) => b.d - a.d);
  for (const { key } of candidates) {
    if (rendered.size <= 8 && bytes <= CACHE_BYTES) break;
    const node = nodes.get(key);
    if (
      node.top + node.height < viewer.scrollTop - 100 ||
      node.top > viewer.scrollTop + viewer.clientHeight + 100
    ) {
      bytes -= canvasBytes.get(key) || 0;
      release(key);
    }
  }
  report();
}
async function draw(key) {
  if (inFlight.has(key)) return;
  const node = nodes.get(key),
    row = node?.row;
  if (!row || rendered.has(key)) return;
  const token = node.token,
    localScale = node.scale;
  if (!book || !notes) return;
  inFlight.set(key, token);
  const activeTasks = new Set(),
    pdfPages = [];
  const taskGroup = {
    cancel: () => {
      for (const task of activeTasks) task.cancel();
    },
  };
  tasks.set(key, taskGroup);
  try {
    const paper = node.paper;
    node.pdfPages = pdfPages;
    node.textLayers = [];
    node.textElements = [];
    node.linkLayers = [];
    node.rasterScale = localScale;
    paper.replaceChildren();
    const ratio = Math.min(
      devicePixelRatio || 1,
      2,
      Math.sqrt(MAX_CANVAS_PIXELS / (row.width * row.height * localScale ** 2)),
    );
    let bytes = 0;
    rendered.set(key, false);
    canvasBytes.set(key, 0);
    evict();
    for (const part of row.parts) {
      if (node.token !== token) return;
      const doc = part.kind === 'source' ? book : notes;
      const page = await doc.getPage(part.page);
      pdfPages.push(page);
      if (node.token !== token || nodes.get(key) !== node) return;
      const viewport = page.getViewport({ scale: localScale });
      const container = document.createElement('div');
      container.className = 'page-part';
      container.dataset.kind = part.kind;
      container.pagePart = part;
      container.style.cssText = `left:${(part.x / row.width) * 100}%;top:${(part.y / row.height) * 100}%;width:${(part.width / row.width) * 100}%;height:${(part.height / row.height) * 100}%`;
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width * ratio);
      canvas.height = Math.ceil(viewport.height * ratio);
      container.append(canvas);
      paper.append(container);
      bytes += canvas.width * canvas.height * 4;
      // Track both halves before asynchronous rendering, including cancelled work.
      canvasBytes.set(key, bytes);
      evict();
      if (node.token !== token) return;
      const task = page.render({
        canvasContext: canvas.getContext('2d'),
        viewport,
        transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
      });
      activeTasks.add(task);
      try {
        await task.promise;
      } catch (e) {
        if (e.name === 'RenderingCancelledException') return;
        throw e;
      } finally {
        activeTasks.delete(task);
      }
      if (node.token !== token || localScale !== node.scale) return;
      const text = document.createElement('div');
      text.className = 'textLayer';
      // Freeze PDF.js font metrics until repaint; scaling the wrapper preserves
      // glyph advances/selection bounds and leaves its rotation transform intact.
      const shell = document.createElement('div');
      shell.className = 'text-shell';
      shell.style.width = `${viewport.width}px`;
      shell.style.height = `${viewport.height}px`;
      shell.style.setProperty('--total-scale-factor', localScale);
      shell.style.setProperty('--scale-factor', localScale);
      shell.append(text);
      container.append(shell);
      node.textElements.push(shell);
      const layer = new pdfjs.TextLayer({
        textContentSource: page.streamTextContent(),
        container: text,
        viewport,
      });
      node.textLayers.push(layer);
      await layer.render();
      if (node.token !== token) return;
      await links(page, node, viewport, token, part, container);
    }
    if (node.token !== token) return;
    rendered.set(key, true);
    evict();
    report();
  } catch (error) {
    if (node.token !== token) return;
    release(key);
    throw error;
  } finally {
    if (tasks.get(key) === taskGroup) tasks.delete(key);
    inFlight.delete(key);
    if (node.token !== token) for (const page of pdfPages) page.cleanup();
  }
}
function pump() {
  if (zoomTimer) return;
  while (rendering < 2 && queue.size) {
    const center = viewer.scrollTop + viewer.clientHeight / 2;
    const key = [...queue]
      .filter((k) => nodes.has(k) && !inFlight.has(k))
      .sort(
        (a, b) =>
          Math.abs(nodes.get(a).top + nodes.get(a).height / 2 - center) -
          Math.abs(nodes.get(b).top + nodes.get(b).height / 2 - center),
      )[0];
    if (!key) break;
    queue.delete(key);
    rendering++;
    draw(key)
      .catch((e) => {
        if (e.name !== 'AbortException' && e.name !== 'RenderingCancelledException') {
          status(e.message, true);
          host.postMessage({ type: 'viewer-error', text: e.message });
        }
      })
      .finally(() => {
        rendering--;
        pump();
      });
  }
}
function outputFor(kind, page) {
  return plan.find((row) => row.parts.some((part) => part.kind === kind && part.page === page));
}
async function links(page, node, viewport, token, part, container) {
  const list = await page.getAnnotations(),
    layer = document.createElement('div');
  if (node.token !== token) return;
  layer.className = 'link-layer';
  for (const annotation of list) {
    if (annotation.subtype !== 'Link') continue;
    const r = [
        ...viewport.convertToViewportPoint(annotation.rect[0], annotation.rect[1]),
        ...viewport.convertToViewportPoint(annotation.rect[2], annotation.rect[3]),
      ],
      a = document.createElement('a');
    a.style.cssText = `left:${Math.min(r[0], r[2])}px;top:${Math.min(r[1], r[3])}px;width:${Math.abs(r[2] - r[0])}px;height:${Math.abs(r[3] - r[1])}px`;
    a.href = '#';
    a.setAttribute('aria-label', annotation.url || '跳转到引用页');
    a.onclick = async (e) => {
      e.preventDefault();
      const original = /^pdf-notebook-source:(\d+)$/.exec(
        annotation.unsafeUrl || annotation.url || '',
      );
      if (original) {
        const row = outputFor('source', Number(original[1]));
        if (row) go(row.outputPage);
      } else if (annotation.url && /^https?:\/\//.test(annotation.url))
        host.postMessage({ type: 'external', url: annotation.url });
      else if (annotation.dest) {
        try {
          const doc = part.kind === 'source' ? book : notes;
          const dest =
            typeof annotation.dest === 'string'
              ? await doc.getDestination(annotation.dest)
              : annotation.dest;
          const no =
            typeof dest[0] === 'number' ? dest[0] + 1 : (await doc.getPageIndex(dest[0])) + 1;
          const row = outputFor(part.kind, no);
          if (row) go(row.outputPage);
        } catch {}
      }
    };
    layer.append(a);
  }
  node.linkLayers.push(layer);
  container.append(layer);
}
async function update(message) {
  const current = ++generation,
    anchor = capture();
  status('正在更新笔记…');
  const newBookVersion = message.bookUrl + '|' + message.bookVersion;
  if (bookVersion !== newBookVersion) {
    for (const key of nodes.keys()) release(key);
    await book?.loadingTask.destroy();
    book = await pdfjs.getDocument({ ...options, url: message.bookUrl }).promise;
    bookVersion = newBookVersion;
  }
  if (current !== generation) return;
  const next = await pdfjs.getDocument({
    ...options,
    data: Uint8Array.from(atob(message.notesData), (c) => c.charCodeAt(0)),
  }).promise;
  if (current !== generation) {
    await next.loadingTask.destroy();
    return;
  }
  for (const [key, node] of nodes)
    if (node.row.parts.some((part) => part.kind === 'note')) {
      node.token++;
      release(key);
    }
  const previous = notes;
  notes = next;
  plan = message.rows;
  maxPageWidth = Math.max(499, ...plan.map((row) => row.width));
  outline = message.outline;
  notesToOutput = new Map(
    plan.flatMap((row) =>
      row.parts.filter((part) => part.kind === 'note').map((part) => [part.page, { row, part }]),
    ),
  );
  const keys = new Set(plan.map((r) => r.key));
  if (navigationFocus && !keys.has(navigationFocus.key)) navigationFocus = null;
  for (const [key, node] of nodes)
    if (!keys.has(key)) {
      release(key);
      node.remove();
      nodes.delete(key);
    }
  let cursor = pages.firstElementChild;
  for (const row of plan) {
    let node = nodes.get(row.key);
    if (!node) {
      node = document.createElement('article');
      node.className = `sheet ${row.kind}`;
      node.dataset.key = row.key;
      node.token = 0;
      const caption = document.createElement('div');
      caption.className = 'caption';
      const paper = document.createElement('div');
      paper.className = 'paper';
      node.paper = paper;
      node.caption = caption;
      node.append(caption, paper);
      nodes.set(row.key, node);
    }
    node.row = row;
    const label =
      row.kind === 'source'
        ? `原书第 ${row.page} 页`
        : row.kind === 'side'
          ? `原书第 ${row.page} 页 · ${row.title}`
          : row.title;
    const caption = `${row.outputPage} / ${plan.length}  ·  ${label}${row.fallback ? '（已转附页）' : ''}`;
    if (node.caption.textContent !== caption) node.caption.textContent = caption;
    if (node === cursor) cursor = cursor.nextElementSibling;
    else pages.insertBefore(node, cursor);
  }
  $('empty').hidden = true;
  $('title').textContent = message.title || 'PDF 阅读笔记';
  $('total').textContent = '/ ' + plan.length;
  $('page').max = plan.length;
  layout();
  restore(anchor);
  renderOutline();
  if (message.error) showError(message.error);
  else {
    $('problem').hidden = true;
    $('upgrade-template').hidden = true;
    status(`${plan.length} 页 · ${message.noteCount} 份笔记`);
  }
  queueVisible();
  report();
  // All old note render tasks have been cancelled before retiring this document.
  await previous?.loadingTask.destroy();
  if (anchorPending) {
    const p = anchorPending;
    anchorPending = null;
    position(p);
  }
  host.postMessage({ type: 'document-ready', revision: message.revision });
}
function renderOutline() {
  const query = $('filter').value.trim().toLowerCase();
  $('outline').replaceChildren();
  for (const item of outline) {
    if (query && !item.title.toLowerCase().includes(query)) continue;
    const b = document.createElement('button');
    b.textContent = item.title;
    b.title = item.title;
    b.style.paddingLeft = `${8 + Math.min(item.depth || 0, 5) * 12}px`;
    if (item.id === undefined && item.page === undefined) b.className = 'note';
    b.onclick = () => go(item.outputPage);
    $('outline').append(b);
  }
}
function go(number) {
  const row = plan[Math.max(0, Math.min(plan.length - 1, number - 1))];
  if (row) {
    nodes.get(row.key).scrollIntoView({ block: 'start' });
    focusPage(row);
    queueVisible();
  }
}
function focusPage(row) {
  // A short/wide target can share the viewport with a much taller neighbour.
  // Keep an explicit jump selected until the user actually scrolls vertically.
  navigationFocus = { key: row.key, top: viewer.scrollTop };
  $('page').value = row.outputPage;
}
function position(p) {
  const target = notesToOutput.get(p.page);
  if (!target) {
    anchorPending = p;
    return;
  }
  const { row, part } = target,
    node = nodes.get(row.key);
  const y = node.top + 23 + (part.y + p.y) * node.scale;
  if (y < viewer.scrollTop + 40 || y > viewer.scrollTop + viewer.clientHeight - 50)
    viewer.scrollTop = y - viewer.clientHeight * 0.35;
  const x = node.offsetLeft + (part.x + p.x) * node.scale;
  if (x < viewer.scrollLeft + 20 || x > viewer.scrollLeft + viewer.clientWidth - 30)
    viewer.scrollLeft = Math.max(0, x - viewer.clientWidth * 0.6);
  focusPage(row);
  queueVisible();
  report();
}
function changeZoom(next) {
  if (next === zoom && Math.abs(pageScale(next) - scale) < 0.000001) return;
  const anchor = capture();
  zoom = next;
  clearTimeout(zoomTimer);
  // Keep visible pixels/text while zooming, including a partially rendered page.
  // Cancelling work must not detach an active text selection before repaint.
  for (const key of inFlight.keys()) {
    const node = nodes.get(key);
    node.token++;
    tasks.get(key)?.cancel();
    for (const layer of node.textLayers || []) layer.cancel();
  }
  layout();
  restore(anchor);
  zoomTimer = setTimeout(() => {
    zoomTimer = null;
    for (const key of [...rendered.keys()]) release(key);
    queueVisible();
  }, 160);
}
$('page').addEventListener('change', () => go(Number($('page').value)));
$('page').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') go(Number($('page').value));
});
$('zoom').onchange = () => changeZoom($('zoom').value);
function currentScale() {
  const row = plan[Number($('page').value) - 1];
  return nodes.get(row?.key)?.scale ?? scale;
}
$('zoom-in').onclick = () => {
  const next = Math.min(3, (currentScale() / (96 / 72)) * 1.15);
  changeZoom(next);
  $('zoom').value = '';
};
$('zoom-out').onclick = () => {
  const next = Math.max(0.4, currentScale() / (96 / 72) / 1.15);
  changeZoom(next);
  $('zoom').value = '';
};
$('toggle-outline').onclick = () => {
  $('sidebar').classList.toggle('hidden');
  changeZoom(zoom);
};
$('filter').oninput = renderOutline;
$('export').onclick = () => host.postMessage({ type: 'export' });
$('upgrade-template').onclick = () => host.postMessage({ type: 'upgrade-template' });
viewer.addEventListener(
  'scroll',
  () => {
    if (ticks) return;
    ticks = requestAnimationFrame(() => {
      ticks = 0;
      let best = null,
        overlap = 0;
      for (const node of visibleRows()) {
        const visible = Math.max(
          0,
          Math.min(node.top + node.height, viewer.scrollTop + viewer.clientHeight) -
            Math.max(node.top, viewer.scrollTop),
        );
        if (visible > overlap) {
          overlap = visible;
          best = node.row;
        }
      }
      const focused =
        navigationFocus && Math.abs(viewer.scrollTop - navigationFocus.top) < 0.5
          ? nodes.get(navigationFocus.key)?.row
          : null;
      if (focused) best = focused;
      else navigationFocus = null;
      if (best) $('page').value = best.outputPage;
      queueVisible();
      evict();
    });
  },
  { passive: true },
);
viewer.addEventListener('click', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  const partNode = e.target.closest('.page-part'),
    node = partNode?.closest('.sheet');
  if (!node || partNode.pagePart.kind !== 'note') return;
  const r = partNode.getBoundingClientRect(),
    part = partNode.pagePart;
  e.preventDefault();
  host.postMessage({
    type: 'inverse',
    page: part.page,
    x: ((e.clientX - r.left) / r.width) * part.width,
    y: ((e.clientY - r.top) / r.height) * part.height,
  });
});
let resizeTimer;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!plan.length) return;
    if (zoom === 'width') changeZoom(zoom);
    queueVisible();
  }, 150);
}).observe(viewer);
window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'document') update(m).catch((e) => status(e.message, true));
  else if (m.type === 'position') position(m);
  else if (m.type === 'status') status(m.text);
  else if (m.type === 'error') showError(m);
});
host.postMessage({ type: 'ready' });
