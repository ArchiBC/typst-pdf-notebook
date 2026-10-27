// Headless renderer stress test. Uses production assets; no user files are written.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { chromium } = require('playwright-core');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { NotebookCompiler } = require('../src/compiler.cjs');
const { loadBook, planNotebook, exportNotebook } = require('../src/document.cjs');
const { installTemplate, PACKAGE_IMPORT } = require('../src/template.cjs');
const { nativeOptions } = require('./support/environment.cjs');
const { createBook } = require('./support/book.cjs');

const project = path.resolve(__dirname, '..');
const label = process.argv[2] || 'current';
if (!/^[a-z0-9-]+$/i.test(label)) throw Error('Invalid benchmark label');
const sourcePath = process.argv[3];
const output = path.join(project, 'output');
let fixture, compiler, browser, server;
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
    canvasCount: pages.querySelectorAll('.paper > canvas').length,
    canvasBytes: [...pages.querySelectorAll('.paper > canvas')].reduce((n,c) => n+c.width*c.height*4,0),
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
  const header = `#import "${templateImport}": notebook, note\n#show: notebook.with(pdf: "book.pdf", size: (498.9pt,708.66pt))\n`;
  const short = header + '#note(1)\n\n= Benchmark note\n\nA short answer with $a+b=b+a$.\n';
  await fs.writeFile(entry, short);
  compiler = new NotebookCompiler({
    ...nativeOptions(),
    packagePath: packages,
    root: fixture,
    entry,
  });
  await compiler.start([{ path: entry, text: short }]);
  const started = performance.now();
  const shortResult = await compiler.compile();
  report.coldCompileMs = performance.now() - started;
  const originalPath = sourcePath || path.join(fixture, 'book.pdf');
  if (!sourcePath) await createBook(originalPath);
  const originalBook = await loadBook(await fs.readFile(originalPath));
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
    const notes = await PDFDocument.load(result.bytes);
    const plan = planNotebook(book, notes, result.metadata);
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
  report.viewport = { width: 1440, height: 1000, deviceScaleFactor: 2 };
  const selectedCases =
    process.env.NOTEBOOK_STRESS_CASES?.split(',') ||
    (process.env.NOTEBOOK_STRESS_FOCUS ? ['real'] : ['real', 'large']);
  for (const name of selectedCases) {
    if (!['real', 'large'].includes(name)) throw Error('Unknown stress case: ' + name);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 2,
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
        const canvases = [...document.querySelectorAll('.paper > canvas')];
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
          span = window.__copySpan.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(paper.querySelector('.textLayer'));
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return {
          text: selection.toString(),
          x: (span.left - box.left) / box.width,
          y: (span.top - box.top) / box.height,
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
          span = window.__copySpan.getBoundingClientRect();
        return {
          x: (span.left - box.left) / box.width,
          y: (span.top - box.top) / box.height,
          connected: window.__copySpan.isConnected,
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
  .catch((e) => {
    report.failed = true;
    report.error = e.stack;
    console.error(e);
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
