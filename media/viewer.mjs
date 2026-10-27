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
  anchorPending;
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
function report() {
  document.body.dataset.renderedPages = String(rendered.size);
  host.postMessage({
    type: 'diagnostics',
    value: {
      totalPages: plan.length,
      canvases: pages.querySelectorAll('.paper > canvas').length,
      renderedPages: rendered.size,
      canvasBytes: [...canvasBytes.values()].reduce((a, b) => a + b, 0),
      notesPages: notes?.numPages,
      bookPages: book?.numPages,
      currentOutputPage: Number($('page').value),
      revision: generation,
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
    node.textLayer?.cancel();
    node.textLayer = null;
    node.linkLayer = null;
    for (const canvas of node.paper.querySelectorAll('canvas')) canvas.width = canvas.height = 0;
    node.paper.replaceChildren();
    // cleanup waits internally for cancelled PDF.js render tasks to finish.
    node.pdfPage?.cleanup();
    node.pdfPage = null;
  }
  canvasBytes.delete(key);
  rendered.delete(key);
  queue.delete(key);
}
function pageScale(next) {
  const available = Math.max(180, viewer.clientWidth - (viewer.clientWidth < 480 ? 18 : 42));
  return next === 'width' ? available / maxPageWidth : (Number(next) * 96) / 72;
}
function layout() {
  scale = pageScale(zoom);
  for (const row of plan) {
    const node = nodes.get(row.key),
      paper = node?.paper;
    if (!paper) continue;
    paper.style.width = `${row.width * scale}px`;
    paper.style.height = `${row.height * scale}px`;
    paper.style.setProperty('--scale-factor', scale);
    paper.style.setProperty('--total-scale-factor', scale);
    paper.style.setProperty('--user-unit', 1);
    node.style.width = paper.style.width;
    if (node.linkLayer) {
      node.linkLayer.style.transformOrigin = '0 0';
      node.linkLayer.style.transform = `scale(${scale / node.rasterScale})`;
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
    doc = row.kind === 'source' ? book : notes,
    localScale = scale;
  if (!doc) return;
  inFlight.set(key, token);
  let page;
  try {
    page = await doc.getPage(row.page);
    if (node.token !== token || nodes.get(key) !== node) return;
    const viewport = page.getViewport({ scale: localScale });
    const paper = node.paper;
    node.pdfPage = page;
    node.rasterScale = localScale;
    const canvas = document.createElement('canvas'),
      ratio = Math.min(
        devicePixelRatio || 1,
        2,
        Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)),
      );
    canvas.width = Math.ceil(viewport.width * ratio);
    canvas.height = Math.ceil(viewport.height * ratio);
    paper.replaceChildren(canvas);
    // Account for canvas memory before asynchronous drawing/text extraction.
    // Cancelled or failed pages must never become untracked resident canvases.
    rendered.set(key, false);
    canvasBytes.set(key, canvas.width * canvas.height * 4);
    evict();
    if (node.token !== token) return;
    const task = page.render({
      canvasContext: canvas.getContext('2d'),
      viewport,
      transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
    });
    tasks.set(key, task);
    try {
      await task.promise;
    } catch (e) {
      if (e.name === 'RenderingCancelledException') return;
      throw e;
    } finally {
      if (tasks.get(key) === task) tasks.delete(key);
    }
    if (node.token !== token || localScale !== scale) return;
    const text = document.createElement('div');
    text.className = 'textLayer';
    paper.append(text);
    node.textLayer = new pdfjs.TextLayer({
      textContentSource: page.streamTextContent(),
      container: text,
      viewport,
    });
    await node.textLayer.render();
    if (node.token !== token) return;
    await links(page, node, viewport, token);
    if (node.token !== token) return;
    rendered.set(key, true);
    evict();
    report();
  } catch (error) {
    if (node.token !== token) return;
    release(key);
    throw error;
  } finally {
    inFlight.delete(key);
    if (node.token !== token) page?.cleanup();
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
async function links(page, node, viewport, token) {
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
        const row = plan.find((x) => x.kind === 'source' && x.page === Number(original[1]));
        if (row) go(row.outputPage);
      } else if (annotation.url && /^https?:\/\//.test(annotation.url))
        host.postMessage({ type: 'external', url: annotation.url });
      else if (annotation.dest) {
        try {
          const doc = node.row.kind === 'source' ? book : notes;
          const dest =
            typeof annotation.dest === 'string'
              ? await doc.getDestination(annotation.dest)
              : annotation.dest;
          const no =
            typeof dest[0] === 'number' ? dest[0] + 1 : (await doc.getPageIndex(dest[0])) + 1;
          const row = plan.find((x) => x.kind === node.row.kind && x.page === no);
          if (row) go(row.outputPage);
        } catch {}
      }
    };
    layer.append(a);
  }
  node.linkLayer = layer;
  node.paper.append(layer);
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
    if (node.row.kind === 'note') {
      node.token++;
      release(key);
    }
  const previous = notes;
  notes = next;
  plan = message.rows;
  maxPageWidth = Math.max(499, ...plan.map((row) => row.width));
  outline = message.outline;
  notesToOutput = new Map(plan.filter((x) => x.kind === 'note').map((x) => [x.page, x.outputPage]));
  const keys = new Set(plan.map((r) => r.key));
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
    const caption = `${row.outputPage} / ${plan.length}  ·  ${row.kind === 'source' ? '原书第 ' + row.page + ' 页' : row.title}`;
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
  status(`${plan.length} 页 · ${message.noteCount} 份笔记`);
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
    $('page').value = row.outputPage;
    queueVisible();
  }
}
function position(p) {
  const number = notesToOutput.get(p.page);
  if (!number) {
    anchorPending = p;
    return;
  }
  const row = plan[number - 1],
    node = nodes.get(row.key);
  const y = node.top + 23 + p.y * scale;
  if (y < viewer.scrollTop + 40 || y > viewer.scrollTop + viewer.clientHeight - 50)
    viewer.scrollTop = y - viewer.clientHeight * 0.35;
  $('page').value = number;
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
    node.textLayer?.cancel();
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
$('zoom-in').onclick = () => {
  const next = Math.min(3, (scale / (96 / 72)) * 1.15);
  changeZoom(next);
  $('zoom').value = '';
};
$('zoom-out').onclick = () => {
  const next = Math.max(0.4, scale / (96 / 72) / 1.15);
  changeZoom(next);
  $('zoom').value = '';
};
$('toggle-outline').onclick = () => {
  $('sidebar').classList.toggle('hidden');
  changeZoom(zoom);
};
$('filter').oninput = renderOutline;
$('export').onclick = () => host.postMessage({ type: 'export' });
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
      if (best) $('page').value = best.outputPage;
      queueVisible();
      evict();
    });
  },
  { passive: true },
);
viewer.addEventListener('click', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  const paper = e.target.closest('.paper'),
    node = paper?.closest('.sheet');
  if (!node || node.row.kind !== 'note') return;
  const r = paper.getBoundingClientRect();
  e.preventDefault();
  host.postMessage({
    type: 'inverse',
    page: node.row.page,
    x: ((e.clientX - r.left) / r.width) * node.row.width,
    y: ((e.clientY - r.top) / r.height) * node.row.height,
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
  else if (m.type === 'error') status(m.text, true);
});
host.postMessage({ type: 'ready' });
