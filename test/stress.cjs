// Headless renderer stress test. Uses production assets; no user files are written.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { PDFDocument, StandardFonts, degrees } = require('pdf-lib');
const { NotebookCompiler } = require('../src/compiler.cjs');
const { loadBook, planNotebook, exportNotebook } = require('../src/document.cjs');
const { installTemplate, PACKAGE_IMPORT } = require('../src/template.cjs');
const { nativeOptions } = require('./support/environment.cjs');
const { createBook } = require('./support/book.cjs');
const { addFixtureHighlight, checkReferenceTools } = require('./support/reference-tools.cjs');

const project = path.resolve(__dirname, '..');
const label = process.argv[2] || 'current';
if (!/^[a-z0-9-]+$/i.test(label)) throw Error('Invalid benchmark label');
const sourcePath = process.argv[3];
const output = path.join(project, 'output');
let fixture, compiler, browser, server;
const positions = [],
  sources = [];
const report = { label, timestamp: new Date().toISOString(), cases: [] };
const instrumentation = `
const benchmarkTimings = {};
const measured = (name, fn) => function(...args) {
  const start = performance.now();
  try { return fn(...args); } finally {
    const values = benchmarkTimings[name] ||= [];
    values.push(performance.now() - start);
  }
};
capture = measured('capture', capture);
layout = measured('layout', layout);
queueVisible = measured('queueVisible', queueVisible);
evict = measured('evict', evict);
window.__benchmark = {
  timings: benchmarkTimings,
  ready: key => rendered.get(key) === true,
  state: () => ({
    pages: plan.length, readyPages: [...rendered.values()].filter(Boolean).length,
    running: rendering, queued: queue.size,
    canvasCount: pages.querySelectorAll('.paper canvas').length,
    canvasBytes: [...pages.querySelectorAll('.paper canvas')].reduce((n,c) => n+c.width*c.height*4,0),
    domNodes: document.getElementsByTagName('*').length,
    jumpMarks: document.querySelectorAll('.jump-mark').length,
  }),
};
`;
function summary(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const at = (p) =>
    Number((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] || 0).toFixed(2));
  return {
    count: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    max: at(1),
    total: Number(values.reduce((a, b) => a + b, 0).toFixed(2)),
  };
}
async function checkCanvasMapping(page, key, expectedParts) {
  const geometry = await page.evaluate((key) => {
    const sheet = [...document.querySelectorAll('.sheet')].find((s) => s.dataset.key === key);
    const paper = sheet.querySelector('.paper').getBoundingClientRect();
    const ratio = Math.min(
      devicePixelRatio || 1,
      2,
      Math.sqrt((16 * 1024 * 1024) / (paper.width * paper.height)),
    );
    return {
      ratio,
      scale: sheet.scale,
      rasterScale: sheet.rasterScale,
      canvases: [...sheet.querySelectorAll('canvas')].map((canvas) => {
        const rect = canvas.getBoundingClientRect();
        return {
          kind: canvas.closest('.page-part').dataset.kind,
          width: canvas.width,
          height: canvas.height,
          cssWidth: rect.width,
          cssHeight: rect.height,
        };
      }),
    };
  }, key);
  assert.equal(geometry.canvases.length, expectedParts, `missing canvases in ${key}`);
  assert.equal(geometry.scale, geometry.rasterScale, `stale raster in ${key}`);
  for (const canvas of geometry.canvases) {
    assert.ok(
      Math.abs(canvas.width - canvas.cssWidth * geometry.ratio) < 0.06 &&
        Math.abs(canvas.height - canvas.cssHeight * geometry.ratio) < 0.06,
      `canvas pixels are being resampled in ${key}: ${JSON.stringify(geometry)}`,
    );
  }
  return geometry;
}
async function main() {
  await fs.mkdir(output, { recursive: true });
  fixture = await fs.mkdtemp(path.join(output, 'stress-fixture-'));
  const packages = path.join(fixture, '.typst-packages');
  await installTemplate(project, packages);
  const viewerSource = await fs.readFile(
    process.env.NOTEBOOK_VIEWER_SOURCE || path.join(project, 'media/viewer.mjs'),
    'utf8',
  );
  report.viewerHash = crypto.createHash('sha256').update(viewerSource).digest('hex');
  report.machine = {
    platform: process.platform,
    cpus: os.cpus().length,
    model: os.cpus()[0]?.model,
    memoryGiB: Math.round(os.totalmem() / 1024 ** 3),
  };
  const entry = path.join(fixture, 'main.typ');
  const templateImport = process.env.NOTEBOOK_TEMPLATE_IMPORT || PACKAGE_IMPORT;
  if (!/^@local\/typst-pdf-notebook:\d+\.\d+\.\d+$/.test(templateImport))
    throw Error('Invalid template import');
  report.templateImport = templateImport;
  const rotation = Number(process.env.NOTEBOOK_STRESS_ROTATION || 0);
  report.sourceRotation = rotation;
  assert.ok([0, 90, 180, 270].includes(rotation));
  const pageSize = rotation % 180 === 90 ? '708.66pt,498.9pt' : '498.9pt,708.66pt';
  const header = `#import "${templateImport}": notebook, note, source-ref\n#show: notebook.with(pdf: "book.pdf", size: (${pageSize}))\n`;
  const short = header + '#note(1)\n\n= Benchmark note\n\nA short answer with $a+b=b+a$.\n';
  await fs.writeFile(entry, short);
  compiler = new NotebookCompiler({
    ...nativeOptions(),
    packagePath: packages,
    root: fixture,
    entry,
    onPosition: (p) => positions.push(p),
    onSource: (p) => sources.push(p),
  });
  await compiler.start([{ path: entry, text: short }]);
  const started = performance.now();
  const shortResult = await compiler.compile();
  report.coldCompileMs = performance.now() - started;
  const originalPath = sourcePath || path.join(fixture, 'book.pdf');
  if (!sourcePath) await createBook(originalPath);
  let originalBook = await loadBook(await fs.readFile(originalPath));
  if (!sourcePath) {
    addFixtureHighlight(originalBook.doc);
    originalBook = await loadBook(await originalBook.doc.save());
  }
  if (rotation) {
    const rotated = await PDFDocument.load(originalBook.bytes);
    rotated.getPage(0).setRotation(degrees(rotation));
    originalBook = await loadBook(await rotated.save());
  }
  const long =
    header +
    Array.from(
      { length: 100 },
      (_, i) =>
        `#note(${1 + Math.floor((i * originalBook.pageCount) / 100)}, id: "stress-${i}")\n\n= Answer ${i}\n\n` +
        Array.from({ length: 4 }, () =>
          'Reasoning about vector spaces and linear maps. '.repeat(12),
        ).join('\n\n'),
    ).join('\n\n');
  compiler.update(entry, long);
  const longStarted = performance.now();
  const longResult = await compiler.compile();
  report.longCompileMs = performance.now() - longStarted;
  const editTimes = [];
  for (let i = 0; i < 10; i++) {
    const before = performance.now();
    compiler.update(entry, long + `\n\nEDIT ${i}`);
    await compiler.compile();
    editTimes.push(performance.now() - before);
  }
  report.warmLongCompileMs = summary(editTimes);
  const synthetic = await PDFDocument.create();
  const font = await synthetic.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 2000; i++) {
    const p = synthetic.addPage([499, 709]);
    p.drawText(`Synthetic stress page ${i + 1}`, { font, size: 15, x: 32, y: 665 });
    for (let line = 0; line < 18; line++)
      p.drawText('Linear algebra: vectors, subspaces, basis and linear transformations.', {
        font,
        size: 10,
        x: 32,
        y: 630 - line * 27,
      });
  }
  const largeBook = await loadBook(await synthetic.save());
  const makeState = async (book, result, name) => {
    result = await compiler.compile({ book, snapshot: result });
    const notes = result.notes || (await PDFDocument.load(result.bytes));
    const plan = result.plan || planNotebook(book, notes, result.metadata);
    return {
      type: 'document',
      bookUrl: `/books/${name}.pdf`,
      bookVersion: '1',
      notesData: result.bytes.toString('base64'),
      rows: plan.rows,
      outline: plan.outline,
      title: name,
      noteCount: plan.noteCount,
      revision: 1,
    };
  };
  const states = {
    real: await makeState(originalBook, shortResult, 'real'),
    large: await makeState(largeBook, shortResult, 'large'),
    long: await makeState(originalBook, longResult, 'real'),
  };
  const sideSource =
    header + '#note(1, right)\n\nSIDE PREVIEW TARGET.\n\n#source-ref(3)[RETURN TO SOURCE]\n';
  compiler.update(entry, sideSource);
  const sideResult = await compiler.compile();
  states.side = await makeState(originalBook, sideResult, 'real');
  compiler.update(entry, sideSource + '\n#lorem(1200)\n');
  states.sideOverflow = await makeState(originalBook, await compiler.compile(), 'real');
  compiler.update(entry, sideSource);
  await compiler.compile();
  const sideNotes = await PDFDocument.load(sideResult.bytes);
  await fs.writeFile(
    path.join(output, 'side-note-example.pdf'),
    await exportNotebook(
      originalBook,
      sideNotes,
      planNotebook(originalBook, sideNotes, sideResult.metadata),
    ),
  );
  const books = { real: originalBook.bytes, large: largeBook.bytes };
  const assetConfig = {
    pdfjs: '/vendor/pdfjs/build/pdf.mjs',
    worker: '/vendor/pdfjs/build/pdf.worker.mjs',
    cmaps: '/vendor/pdfjs/cmaps/',
    fonts: '/vendor/pdfjs/standard_fonts/',
    wasm: '/vendor/pdfjs/wasm/',
  };
  let html = (await fs.readFile(path.join(project, 'media/index.html'), 'utf8'))
    .replace(
      '{{CSP}}',
      "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; font-src 'self' blob:; connect-src 'self'; img-src 'self' blob: data:",
    )
    .replaceAll('{{NONCE}}', 'stress')
    .replace('{{CONFIG}}', JSON.stringify(assetConfig))
    .replace('{{PDFCSS}}', '/vendor/pdfjs/web/pdf_viewer.css')
    .replace('{{CSS}}', '/media/viewer.css')
    .replace('{{JS}}', '/media/viewer.mjs');
  html = html.replace(
    '</head>',
    `<script>window.__messages=[];window.acquireVsCodeApi=()=>({postMessage:m=>{window.__messages.push(m);if(m.type==='document-ready')window.__documentReady=m.revision;if(m.type==='ready')fetch('/fixture/'+new URLSearchParams(location.search).get('case')).then(r=>r.json()).then(m=>window.postMessage(m,location.origin));}})</script></head>`,
  );
  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end(html);
      }
      if (url.pathname.startsWith('/fixture/')) {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(states[url.pathname.slice(9)]));
      }
      if (url.pathname.startsWith('/books/')) {
        res.setHeader('Content-Type', 'application/pdf');
        return res.end(books[path.basename(url.pathname, '.pdf')]);
      }
      const asset = path.resolve(project, '.' + decodeURIComponent(url.pathname));
      if (!asset.startsWith(project + path.sep)) throw Error('Outside assets');
      const body =
        asset === path.join(project, 'media/viewer.mjs')
          ? viewerSource + instrumentation
          : await fs.readFile(asset);
      res.setHeader(
        'Content-Type',
        { '.mjs': 'application/javascript', '.css': 'text/css', '.wasm': 'application/wasm' }[
          path.extname(asset)
        ] || 'application/octet-stream',
      );
      res.end(body);
    } catch (e) {
      res.writeHead(500);
      res.end(e.message);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const executablePath = process.env.NOTEBOOK_BROWSER;
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  });
  report.browser = browser.version();
  const viewport = {
    width: Number(process.env.NOTEBOOK_STRESS_WIDTH || 1440),
    height: Number(process.env.NOTEBOOK_STRESS_HEIGHT || 1000),
  };
  const deviceScaleFactor = Number(process.env.NOTEBOOK_STRESS_DPR || 2);
  if (!(deviceScaleFactor > 0 && deviceScaleFactor <= 4))
    throw Error('Invalid device scale factor');
  report.viewport = { ...viewport, deviceScaleFactor };
  const selectedCases =
    process.env.NOTEBOOK_STRESS_CASES?.split(',') ||
    (process.env.NOTEBOOK_STRESS_FOCUS ? ['real'] : ['real', 'large', 'side']);
  for (const name of selectedCases) {
    if (!['real', 'large', 'side'].includes(name)) throw Error('Unknown stress case: ' + name);
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor,
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.__samples = {
        frames: [],
        longTasks: [],
        addedCanvases: 0,
        peakCanvasBytes: 0,
        peakCanvasCount: 0,
      };
      let previous;
      const tick = (t) => {
        if (previous) window.__samples.frames.push(t - previous);
        previous = t;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      new PerformanceObserver((list) =>
        window.__samples.longTasks.push(...list.getEntries().map((x) => x.duration)),
      ).observe({ type: 'longtask', buffered: true });
      new MutationObserver((records) => {
        for (const record of records)
          for (const n of record.addedNodes)
            if (n.nodeName === 'CANVAS') window.__samples.addedCanvases++;
            else if (n.querySelectorAll)
              window.__samples.addedCanvases += n.querySelectorAll('canvas').length;
        const canvases = [...document.querySelectorAll('.paper canvas')];
        window.__samples.peakCanvasBytes = Math.max(
          window.__samples.peakCanvasBytes,
          canvases.reduce((s, c) => s + c.width * c.height * 4, 0),
        );
        window.__samples.peakCanvasCount = Math.max(
          window.__samples.peakCanvasCount,
          canvases.length,
        );
      }).observe(document, { childList: true, subtree: true });
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    const coldStart = performance.now();
    await page.goto(`http://127.0.0.1:${server.address().port}/?case=${name}`);
    await page.waitForFunction(
      () => window.__documentReady === 1 && window.__benchmark?.state().readyPages > 0,
      {},
      { timeout: 30000 },
    );
    const result = {
      name,
      pages: states[name].rows.length,
      coldOpenMs: performance.now() - coldStart,
      scenarios: [],
    };
    report.cases.push(result);
    const run = async (label, action) => {
      await page.evaluate(() => {
        window.__samples.frames = [];
        window.__samples.longTasks = [];
        window.__samples.addedCanvases = 0;
        for (const k of Object.keys(window.__benchmark.timings)) window.__benchmark.timings[k] = [];
      });
      const before = (await cdp.send('Performance.getMetrics')).metrics;
      const time = performance.now();
      await action();
      await page.waitForTimeout(500);
      await page.waitForFunction(
        () => window.__benchmark.state().running === 0,
        {},
        { timeout: 30000 },
      );
      const elapsedMs = performance.now() - time;
      const measured = await page.evaluate(() => ({
        samples: window.__samples,
        state: window.__benchmark.state(),
        timings: window.__benchmark.timings,
        errors: window.__messages.filter((x) => x.type === 'viewer-error').map((x) => x.text),
      }));
      const visible = await page.evaluate(() => {
        const bounds = document.querySelector('#viewer').getBoundingClientRect();
        return [...document.querySelectorAll('.paper')]
          .filter((p) => {
            const r = p.getBoundingClientRect();
            return r.bottom > bounds.top && r.top < bounds.bottom;
          })
          .map((p) => ({
            canvas: !!p.querySelector('canvas'),
            text: p.querySelector('.textLayer')?.textContent?.length || 0,
          }));
      });
      if (!visible.length || visible.some((p) => !p.canvas))
        throw Error('Visible pages missing raster after workload');
      if (measured.state.jumpMarks) throw Error('Unexpected source-location highlight');
      await cdp.send('HeapProfiler.collectGarbage');
      const after = (await cdp.send('Performance.getMetrics')).metrics;
      const value = (m, k) => m.find((x) => x.name === k)?.value || 0;
      const scenario = {
        label,
        elapsedMs,
        framesMs: summary(measured.samples.frames),
        longTasksMs: summary(measured.samples.longTasks),
        addedCanvases: measured.samples.addedCanvases,
        peakCanvasMiB: measured.samples.peakCanvasBytes / 1024 ** 2,
        peakCanvasCount: measured.samples.peakCanvasCount,
        heapMiB: value(after, 'JSHeapUsedSize') / 1024 ** 2,
        layoutMs: (value(after, 'LayoutDuration') - value(before, 'LayoutDuration')) * 1000,
        scriptMs: (value(after, 'ScriptDuration') - value(before, 'ScriptDuration')) * 1000,
        state: measured.state,
        visible,
        timings: Object.fromEntries(
          Object.entries(measured.timings).map(([k, v]) => [k, summary(v)]),
        ),
      };
      result.scenarios.push(scenario);
      errors.push(...measured.errors);
      console.log(
        JSON.stringify({
          name,
          label,
          frameP95: scenario.framesMs.p95,
          longTasks: scenario.longTasksMs.count,
          canvases: scenario.addedCanvases,
          peakMiB: Math.round(scenario.peakCanvasMiB),
          heapMiB: Math.round(scenario.heapMiB),
        }),
      );
    };
    if (!process.env.NOTEBOOK_STRESS_FOCUS)
      await run('scroll', async () => {
        await page.evaluate(async () => {
          const viewer = document.querySelector('#viewer'),
            sheets = [...document.querySelectorAll('.sheet')];
          const tops = sheets.map((x) => x.offsetTop);
          for (let i = 0; i < 96; i++) {
            viewer.scrollTop =
              tops[Math.min(tops.length - 1, Math.floor((i * (tops.length - 1)) / 95))];
            await new Promise((r) => setTimeout(r, 80));
          }
        });
      });
    if (!process.env.NOTEBOOK_STRESS_FOCUS)
      await run('zoom-burst', async () => {
        await page.evaluate(async () => {
          const zoom = document.querySelector('#zoom');
          for (let i = 0; i < 30; i++) {
            zoom.value = ['0.75', '1', '1.25', '1.5', '2', 'width'][i % 6];
            zoom.dispatchEvent(new Event('change'));
            await new Promise((r) => setTimeout(r, 35));
          }
        });
      });
    if (name === 'real' && !process.env.NOTEBOOK_STRESS_FOCUS)
      await run('notes-update-burst', async () => {
        for (let i = 0; i < 12; i++) {
          await page.evaluate((m) => window.postMessage(m, location.origin), {
            ...(i % 2 ? states.long : states.real),
            revision: 10 + i,
          });
          await page.waitForTimeout(70);
        }
        await page.waitForFunction(() => window.__documentReady === 21, {}, { timeout: 30000 });
        if ((await page.locator('.sheet').count()) !== states.long.rows.length)
          throw Error('Latest notes pagination lost');
      });
    if (name === 'real') {
      const noteKey = await page.locator('.sheet.note').first().getAttribute('data-key');
      assert.ok(noteKey, 'a rendered notebook should contain a note page');
      const rasterChecks = [];
      for (const zoom of ['0.75', '1', '1.5']) {
        await page.selectOption('#zoom', zoom);
        for (const key of ['source:1', noteKey]) {
          await page.locator(`[data-key="${key}"]`).scrollIntoViewIfNeeded();
          await page.waitForFunction(
            (key) => {
              const sheet = [...document.querySelectorAll('.sheet')].find(
                (s) => s.dataset.key === key,
              );
              return window.__benchmark.ready(key) && sheet.scale === sheet.rasterScale;
            },
            key,
            { timeout: 30000 },
          );
          rasterChecks.push({ zoom, key, ...(await checkCanvasMapping(page, key, 1)) });
        }
      }
      result.rasterChecks = rasterChecks;
      // Exercise actual wheel input, including the browser's default scroll behavior.
      await page.setViewportSize({ width: 900, height: 800 });
      await page.selectOption('#zoom', '1');
      await page.locator('[data-key="source:1"]').scrollIntoViewIfNeeded();
      await page.waitForFunction(
        () => window.__benchmark.ready('source:1'),
        {},
        { timeout: 30000 },
      );
      await page.waitForTimeout(300);
      const wheelPoint = await page.evaluate(() => {
        const viewer = document.querySelector('#viewer');
        const paper = document
          .querySelector('[data-key="source:1"] .paper')
          .getBoundingClientRect();
        const bounds = viewer.getBoundingClientRect();
        window.__wheelEvents = [];
        viewer.addEventListener('wheel', (event) => {
          window.__wheelEvents.push({
            ctrl: event.ctrlKey,
            prevented: event.defaultPrevented,
            key: event.target.closest('.sheet')?.dataset.key,
            delta: event.deltaY,
          });
        });
        return {
          x: (Math.max(bounds.left, paper.left) + Math.min(bounds.right, paper.right)) / 2,
          y: (Math.max(bounds.top, paper.top) + Math.min(bounds.bottom, paper.bottom)) / 2,
        };
      });
      const wheelState = () =>
        page.evaluate(({ x, y }) => {
          const viewer = document.querySelector('#viewer');
          const paper = document
            .querySelector('[data-key="source:1"] .paper')
            .getBoundingClientRect();
          return {
            width: paper.width,
            x: (x - paper.left) / paper.width,
            y: (y - paper.top) / paper.height,
            zoomLabel: document.querySelector('#zoom').selectedOptions[0]?.textContent,
            scrollTop: viewer.scrollTop,
            events: window.__wheelEvents,
          };
        }, wheelPoint);
      await page.mouse.move(wheelPoint.x, wheelPoint.y);
      const beforeWheel = await wheelState();
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -100);
      await page.keyboard.up('Control');
      await page.waitForFunction(
        (width) =>
          document.querySelector('[data-key="source:1"] .paper').getBoundingClientRect().width >
          width,
        beforeWheel.width,
      );
      const enlarged = await wheelState();
      assert.ok(enlarged.events.some((event) => event.ctrl && event.prevented));
      const checkZoomLabel = (state) => {
        assert.match(state.zoomLabel || '', /^\d+(\.\d)?%$/);
        assert.ok(
          Math.abs(parseFloat(state.zoomLabel) - (state.width / beforeWheel.width) * 100) < 0.06,
        );
      };
      checkZoomLabel(enlarged);
      assert.ok(
        Math.abs(enlarged.x - beforeWheel.x) < 0.003,
        `wheel zoom keeps the horizontal anchor: ${JSON.stringify({ beforeWheel, enlarged })}`,
      );
      assert.ok(
        Math.abs(enlarged.y - beforeWheel.y) < 0.003,
        'wheel zoom keeps the vertical anchor',
      );
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, 100);
      await page.keyboard.up('Control');
      await page.waitForFunction(
        (width) =>
          Math.abs(
            document.querySelector('[data-key="source:1"] .paper').getBoundingClientRect().width -
              width,
          ) < 1,
        beforeWheel.width,
      );
      const restored = await wheelState();
      assert.equal(restored.zoomLabel, '100%');
      await page.mouse.wheel(0, 160);
      await page.waitForFunction(
        (top) => document.querySelector('#viewer').scrollTop > top,
        restored.scrollTop,
      );
      const scrolled = await wheelState();
      assert.ok(Math.abs(scrolled.width - restored.width) < 1, 'ordinary wheel only scrolls');
      assert.ok(scrolled.events.some((event) => !event.ctrl && !event.prevented));
      await page.keyboard.down('Control');
      for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -1000);
      await page.waitForFunction(
        (width) =>
          Math.abs(
            document.querySelector('[data-key="source:1"] .paper').getBoundingClientRect().width -
              3 * width,
          ) < 1,
        beforeWheel.width,
      );
      await page.waitForFunction(
        () => {
          const sheet = document.querySelector('[data-key="source:1"]');
          return window.__benchmark.ready('source:1') && sheet.scale === sheet.rasterScale;
        },
        {},
        { timeout: 30000 },
      );
      result.maximumZoomRaster = await checkCanvasMapping(page, 'source:1', 1);
      if (deviceScaleFactor >= 2)
        assert.ok(result.maximumZoomRaster.ratio < 2, 'large pages use the raster pixel limit');
      for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 1000);
      await page.keyboard.up('Control');
      await page.waitForFunction(
        (width) =>
          Math.abs(
            document.querySelector('[data-key="source:1"] .paper').getBoundingClientRect().width -
              0.1 * width,
          ) < 1,
        beforeWheel.width,
      );
      await page.waitForFunction(
        () => {
          const bounds = document.querySelector('#viewer').getBoundingClientRect();
          const visible = [...document.querySelectorAll('.sheet')].filter((sheet) => {
            const rect = sheet.getBoundingClientRect();
            return rect.bottom > bounds.top && rect.top < bounds.bottom;
          });
          return (
            visible.length > 0 &&
            visible.every((sheet) => window.__benchmark.ready(sheet.dataset.key))
          );
        },
        {},
        { timeout: 30000 },
      );
      await page.selectOption('#zoom', '1');
      await page.waitForTimeout(300);
      await page.waitForFunction(
        () => window.__benchmark.state().running === 0,
        {},
        { timeout: 30000 },
      );
      const sidebarHidden = await page.evaluate(() => {
        const sidebar = document.querySelector('#sidebar');
        const hidden = sidebar.classList.contains('hidden');
        sidebar.classList.add('hidden');
        return hidden;
      });
      await page.setViewportSize({ width: 270, height: 800 });
      await page.selectOption('#zoom', 'width');
      await page.locator('[data-key="source:1"]').scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      const fit = await page.evaluate(() => {
        const r = document.querySelector('[data-key="source:1"] .paper').getBoundingClientRect();
        const v = document.querySelector('#viewer').getBoundingClientRect();
        return {
          width: r.width,
          x: (Math.max(r.left, v.left) + Math.min(r.right, v.right)) / 2,
          y: (Math.max(r.top, v.top) + Math.min(r.bottom, v.bottom)) / 2,
        };
      });
      assert.ok(fit.width < 0.4 * beforeWheel.width, 'fit-to-width starts below 40%');
      await page.mouse.move(fit.x, fit.y);
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, 100);
      await page.waitForFunction(
        (width) =>
          document.querySelector('[data-key="source:1"] .paper').getBoundingClientRect().width <
          width * 0.96,
        fit.width,
      );
      await page.mouse.wheel(0, -100);
      await page.waitForFunction(
        (width) =>
          Math.abs(
            document.querySelector('[data-key="source:1"] .paper').getBoundingClientRect().width -
              width,
          ) < 1,
        fit.width,
      );
      await page.mouse.wheel(0, -100);
      await page.waitForTimeout(350);
      const fitEnlarged = await wheelState();
      checkZoomLabel(fitEnlarged);
      assert.ok(
        fitEnlarged.width > fit.width * 1.04,
        `small fit wheel must enlarge: ${JSON.stringify({ fit, fitEnlarged })}`,
      );
      await page.mouse.wheel(0, 100);
      await page.keyboard.up('Control');
      await page.waitForFunction(
        (width) =>
          Math.abs(
            document.querySelector('[data-key="source:1"] .paper').getBoundingClientRect().width -
              width,
          ) < 1,
        fit.width,
      );
      await page.evaluate(
        (hidden) => document.querySelector('#sidebar').classList.toggle('hidden', hidden),
        sidebarHidden,
      );
      result.wheelZoom = {
        anchored: true,
        normalScroll: true,
        minimum: 0.1,
        maximum: 3,
        smallFit: true,
      };
      await page.setViewportSize({ width: 1440, height: 1000 });

      // Check selectable Chinese text and link coordinates while CSS-scaled during zoom.
      await page.locator('[data-key="source:300"]').scrollIntoViewIfNeeded();
      await page.waitForFunction(
        () =>
          window.__benchmark.ready('source:300') &&
          document.querySelector('[data-key="source:300"] .textLayer')?.textContent?.length > 10,
        {},
        { timeout: 30000 },
      );
      const before = await page.evaluate(() => {
        const paper = document.querySelector('[data-key="source:300"] .paper');
        window.__copySpan = [...paper.querySelectorAll('.textLayer span')].find((s) =>
          s.textContent.trim(),
        );
        window.__copyLink = paper.querySelector('.link-layer a');
        const box = paper.getBoundingClientRect(),
          span = window.__copySpan.getBoundingClientRect(),
          canvas = paper.querySelector('canvas').getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(paper.querySelector('.textLayer'));
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return {
          text: selection.toString(),
          x: (span.left - box.left) / box.width,
          y: (span.top - box.top) / box.height,
          canvas: [canvas.width / box.width, canvas.height / box.height],
          link: window.__copyLink
            ? (() => {
                const r = window.__copyLink.getBoundingClientRect();
                return [
                  (r.left - box.left) / box.width,
                  (r.top - box.top) / box.height,
                  r.width / box.width,
                  r.height / box.height,
                ];
              })()
            : null,
        };
      });
      if (!before.text.trim()) throw Error('Original PDF text is not selectable');
      const during = await page.evaluate(() => {
        const zoom = document.querySelector('#zoom');
        zoom.value = '1.25';
        zoom.dispatchEvent(new Event('change'));
        const box = document
            .querySelector('[data-key="source:300"] .paper')
            .getBoundingClientRect(),
          span = window.__copySpan.getBoundingClientRect(),
          canvas = document.querySelector('[data-key="source:300"] canvas').getBoundingClientRect();
        return {
          x: (span.left - box.left) / box.width,
          y: (span.top - box.top) / box.height,
          connected: window.__copySpan.isConnected,
          canvas: [canvas.width / box.width, canvas.height / box.height],
          link: window.__copyLink
            ? (() => {
                const r = window.__copyLink.getBoundingClientRect();
                return [
                  (r.left - box.left) / box.width,
                  (r.top - box.top) / box.height,
                  r.width / box.width,
                  r.height / box.height,
                ];
              })()
            : null,
        };
      });
      if (Math.abs(before.x - during.x) > 0.003 || Math.abs(before.y - during.y) > 0.003)
        throw Error(
          'Text selection shifted during deferred zoom: ' +
            JSON.stringify({ before: { x: before.x, y: before.y }, during }),
        );
      if (before.link && before.link.some((n, i) => Math.abs(n - during.link[i]) > 0.003))
        throw Error('PDF link coordinates shifted during deferred zoom');
      if (before.canvas.some((n, i) => Math.abs(n - during.canvas[i]) > 0.001))
        throw Error('Original canvas shifted during deferred zoom');
      await page.waitForTimeout(400);
      result.selection = {
        characters: before.text.length,
        alignedDuringZoom: true,
        linksChecked: !!before.link,
      };
      await page.setViewportSize({ width: 1440, height: 1800 });
      await page.waitForTimeout(600);
      await page.waitForFunction(
        () => window.__benchmark.state().running === 0,
        {},
        { timeout: 30000 },
      );
      const resized = await page.evaluate(() => {
        const bounds = document.querySelector('#viewer').getBoundingClientRect();
        return [...document.querySelectorAll('.paper')]
          .filter((p) => {
            const r = p.getBoundingClientRect();
            return r.bottom > bounds.top && r.top < bounds.bottom;
          })
          .every((p) => !!p.querySelector('canvas'));
      });
      if (!resized) throw Error('Fixed zoom resize left blank visible pages');
      result.fixedZoomResize = true;
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(output, `performance-${label}.png`) });
      if (!sourcePath && !rotation) await checkReferenceTools(page);
    }
    if (name === 'side') {
      await page.evaluate(() => {
        const viewer = document.querySelector('#viewer');
        viewer.scrollTop = viewer.scrollHeight;
      });
      await page.waitForTimeout(200);
      const line = sideSource.split('\n').findIndex((x) => x.startsWith('SIDE PREVIEW TARGET'));
      const oldPositions = positions.length;
      await compiler.forward(entry, line, 8);
      for (let i = 0; i < 100 && positions.length === oldPositions; i++)
        await new Promise((r) => setTimeout(r, 30));
      assert.ok(positions.length > oldPositions, 'native side source position');
      await page.evaluate(
        (p) => window.postMessage({ type: 'position', ...p }, location.origin),
        positions.at(-1),
      );
      await page
        .waitForFunction(
          () =>
            document.querySelector('#page').value === '1' &&
            window.__benchmark.ready('side:1:note-1'),
          {},
          { timeout: 30000 },
        )
        .catch(async (error) => {
          report.navigationFailure = await page.evaluate(() => ({
            currentPage: document.querySelector('#page').value,
            scrollTop: document.querySelector('#viewer').scrollTop,
            side: document.querySelector('.sheet.side').getBoundingClientRect().toJSON(),
            diagnostics: window.__messages.filter((m) => m.type === 'diagnostics').at(-1),
          }));
          throw error;
        });
      const selectable = await page.evaluate(() => {
        const sheet = document.querySelector('.sheet.side');
        const select = (element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const selection = getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          return selection.toString();
        };
        const source = sheet.querySelector('[data-kind="source"]'),
          note = sheet.querySelector('[data-kind="note"]');
        const left = source.getBoundingClientRect(),
          right = note.getBoundingClientRect();
        const glyph = source.querySelector('.textLayer span').getBoundingClientRect();
        return {
          original: select(source.querySelector('.textLayer')),
          note: select(note.querySelector('.textLayer')),
          gap: right.left - left.right,
          originalGlyph: {
            x: (glyph.left - left.left) / left.width,
            y: (glyph.top - left.top) / left.height,
            width: glyph.width,
            height: glyph.height,
          },
        };
      });
      assert.match(selectable.original, /Page 1:/);
      assert.match(selectable.note, /SIDE PREVIEW TARGET/);
      assert.ok(Math.abs(selectable.gap) < 0.5);
      result.sideRaster = await checkCanvasMapping(page, 'side:1:note-1', 2);
      if (rotation === 90) {
        assert.ok(
          selectable.originalGlyph.height > selectable.originalGlyph.width * 3,
          'rotated original text selection follows the glyph direction',
        );
        assert.ok(
          selectable.originalGlyph.x > 0.7 && selectable.originalGlyph.y < 0.2,
          'rotated original selection stays over the first raster line',
        );
      }
      if (rotation === 180)
        assert.ok(
          selectable.originalGlyph.width > selectable.originalGlyph.height * 3 &&
            selectable.originalGlyph.y > 0.7,
          'half-turn original selection follows the raster',
        );
      if (rotation === 270)
        assert.ok(
          selectable.originalGlyph.height > selectable.originalGlyph.width * 3 &&
            selectable.originalGlyph.x < 0.3,
          'three-quarter-turn original selection follows the raster',
        );
      const originalInverses = await page.evaluate(
        () => window.__messages.filter((x) => x.type === 'inverse').length,
      );
      await page
        .locator('.sheet.side [data-kind="source"] .textLayer span')
        .first()
        .click({ modifiers: ['Control'] });
      assert.equal(
        await page.evaluate(() => window.__messages.filter((x) => x.type === 'inverse').length),
        originalInverses,
      );
      await page
        .locator('.sheet.side [data-kind="note"] .textLayer span')
        .filter({ hasText: 'TARGET' })
        .first()
        .click({ modifiers: ['Control'] });
      const inverse = await page.evaluate(() =>
        window.__messages.filter((x) => x.type === 'inverse').at(-1),
      );
      assert.ok(inverse, 'Ctrl-click in the note half must send an inverse-navigation event');
      assert.equal(inverse.page, 1);
      assert.ok(
        inverse.x > 0 && inverse.x < states.side.rows[0].parts[1].width,
        'inverse excludes the source-page offset',
      );
      const oldSources = sources.length;
      compiler.inverse(inverse.page, inverse.x, inverse.y);
      for (let i = 0; i < 100 && sources.length === oldSources; i++)
        await new Promise((r) => setTimeout(r, 30));
      assert.ok(sources.length > oldSources, 'native inverse from the clicked right column');
      assert.equal(sources.at(-1).selection.start.line, line);
      const zoomAlignment = await page.evaluate(() => {
        const note = document.querySelector('.sheet.side [data-kind="note"]');
        const span = [...note.querySelectorAll('.textLayer span')].find((x) =>
          x.textContent.includes('TARGET'),
        );
        const link = note.querySelector('.link-layer a');
        const box = (element) => {
          const r = element.getBoundingClientRect(),
            p = note.getBoundingClientRect();
          return [
            (r.left - p.left) / p.width,
            (r.top - p.top) / p.height,
            r.width / p.width,
            r.height / p.height,
          ];
        };
        const canvasSizes = () =>
          [...document.querySelectorAll('.sheet.side .page-part')].map((part) => {
            const p = part.getBoundingClientRect(),
              c = part.querySelector('canvas').getBoundingClientRect();
            return [c.width / p.width, c.height / p.height];
          });
        const before = { text: box(span), link: box(link), canvases: canvasSizes() };
        const zoom = document.querySelector('#zoom');
        zoom.value = '1.25';
        zoom.dispatchEvent(new Event('change'));
        return { before, after: { text: box(span), link: box(link), canvases: canvasSizes() } };
      });
      for (const key of ['text', 'link'])
        assert.ok(
          zoomAlignment.before[key].every(
            (v, i) => Math.abs(v - zoomAlignment.after[key][i]) < 0.003,
          ),
          `side ${key} remains aligned during zoom: ${JSON.stringify(zoomAlignment)}`,
        );
      assert.ok(
        zoomAlignment.before.canvases.every((size, i) =>
          size.every((v, j) => Math.abs(v - zoomAlignment.after.canvases[i][j]) < 0.001),
        ),
        `side canvases remain aligned during zoom: ${JSON.stringify(zoomAlignment)}`,
      );
      await page.selectOption('#zoom', 'width');
      await page.waitForFunction(
        () => window.__benchmark.ready('side:1:note-1'),
        {},
        { timeout: 30000 },
      );
      await page.locator('.sheet.side [data-kind="note"] .link-layer a').first().click();
      await page.waitForFunction(() => document.querySelector('#page').value === '3');
      await page.evaluate((m) => window.postMessage(m, location.origin), {
        ...states.sideOverflow,
        revision: 101,
      });
      await page.waitForFunction(() => window.__documentReady === 101, {}, { timeout: 30000 });
      assert.equal(await page.locator('.sheet.side').count(), 0);
      assert.equal(await page.locator('.sheet').count(), states.sideOverflow.rows.length);
      await page.evaluate((m) => window.postMessage(m, location.origin), {
        ...states.side,
        revision: 102,
      });
      await page.waitForFunction(() => window.__documentReady === 102, {}, { timeout: 30000 });
      assert.equal(await page.locator('.sheet.side').count(), 1);
      await page.evaluate(
        (p) => window.postMessage({ type: 'position', ...p }, location.origin),
        positions.at(-1),
      );
      await page.waitForFunction(
        () =>
          document.querySelector('#page').value === '1' &&
          window.__benchmark.ready('side:1:note-1'),
        {},
        { timeout: 30000 },
      );
      await page.screenshot({ path: path.join(output, 'side-note-preview.png') });
      const viewerBounds = await page.locator('#viewer').boundingBox();
      await page.mouse.move(
        viewerBounds.x + viewerBounds.width * 0.75,
        viewerBounds.y + viewerBounds.height * 0.5,
      );
      // A narrow side column makes the combined page taller when fitted to width.
      // Scroll beyond that actual sheet before expecting a new current page.
      const sheetBounds = await page.locator('.sheet.side').boundingBox();
      await page.mouse.wheel(0, Math.max(viewerBounds.height, sheetBounds.height) + 50);
      await page.waitForFunction(() => document.querySelector('#page').value !== '1');
      await page.locator('#page').fill('1');
      await page.locator('#page').press('Enter');
      await page.waitForFunction(
        () =>
          document.querySelector('#page').value === '1' &&
          window.__benchmark.ready('side:1:note-1'),
      );
      result.sideNote = {
        sourceRotation: rotation,
        originalGlyph: selectable.originalGlyph,
        selectableCharacters: selectable.original.length,
        noteSelectable: true,
        inverseLine: line,
        originalDoesNotJump: true,
        zoomAligned: true,
        linkToSource: true,
        fallbackPages: states.sideOverflow.rows.length,
        recovered: true,
        manualScrollUnlock: true,
        pageNumberEntry: true,
      };
      errors.push(
        ...(await page.evaluate(() =>
          window.__messages.filter((x) => x.type === 'viewer-error').map((x) => x.text),
        )),
      );
      console.log(JSON.stringify({ name, sideNote: result.sideNote }));
    }
    result.errors = [...new Set(errors)];
    if (result.errors.length) report.failed = true;
    await context.close();
  }
  const exportNotes = await PDFDocument.load(longResult.bytes);
  const exportPlan = planNotebook(originalBook, exportNotes, longResult.metadata);
  const exportStart = performance.now();
  const merged = await exportNotebook(originalBook, exportNotes, exportPlan);
  const mergedPages = (await PDFDocument.load(merged)).getPageCount();
  if (mergedPages !== exportPlan.rows.length) throw Error('Export page count mismatch');
  report.export = {
    pages: mergedPages,
    bytes: merged.length,
    elapsedMs: performance.now() - exportStart,
  };
}
main()
  .catch(async (e) => {
    report.failed = true;
    report.error = e.stack;
    console.error(e);
    const active = browser
      ?.contexts()
      .flatMap((c) => c.pages())
      .at(-1);
    await active
      ?.screenshot({ path: path.join(output, `performance-${label}-failure.png`) })
      .catch(() => {});
  })
  .finally(async () => {
    await browser?.close();
    await new Promise((r) => (server ? server.close(r) : r()));
    compiler?.dispose();
    if (compiler?.proc && compiler.proc.exitCode === null)
      await new Promise((r) => compiler.proc.once('exit', r));
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(
      path.join(output, `performance-${label}.json`),
      JSON.stringify(report, null, 2),
    );
    if (fixture && path.dirname(fixture) === output)
      await fs.rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    process.exitCode = report.failed ? 1 : 0;
  });
