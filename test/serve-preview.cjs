// Development harness: serves the production webview unchanged on loopback.
const http = require('node:http'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { PDFDocument } = require('pdf-lib');
const { NotebookCompiler } = require('../src/compiler.cjs');
const { loadBook, planNotebook, exportNotebook } = require('../src/document.cjs');
const { installTemplate } = require('../src/template.cjs');
const extension = path.resolve(__dirname, '..'),
  root = path.resolve(process.argv[2] || '.'),
  entry = path.join(root, 'main.typ');
const clients = new Set();
let state, book, notes, plan;
const tiny = fs
  .readdirSync(path.join(os.homedir(), '.vscode/extensions'))
  .filter((x) => /^myriad-dreamin\.tinymist-/.test(x))
  .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
function publish(m) {
  for (const res of clients) res.write('data: ' + JSON.stringify(m) + '\n\n');
}
const compiler = new NotebookCompiler({
  binary: path.join(
    os.homedir(),
    '.vscode/extensions',
    tiny,
    'out',
    process.platform === 'win32' ? 'tinymist.exe' : 'tinymist',
  ),
  root,
  entry,
  onPosition: (p) => publish({ type: 'position', ...p }),
  onSource: (p) => {
    console.log('SOURCE', JSON.stringify(p));
    publish({ type: 'source-result', ...p });
  },
});
async function initialize() {
  await installTemplate(extension);
  await compiler.start([{ path: entry, text: fs.readFileSync(entry, 'utf8') }]);
  const r = await compiler.compile(),
    config = r.metadata.find((x) => x.kind === 'pdf-notebook');
  book = await loadBook(fs.readFileSync(path.resolve(root, config.pdf)));
  notes = await PDFDocument.load(r.bytes);
  plan = planNotebook(book, notes, r.metadata);
  state = {
    type: 'document',
    bookUrl: '/source.pdf',
    bookVersion: '1',
    notesData: r.bytes.toString('base64'),
    rows: plan.rows,
    outline: plan.outline,
    title: config.title,
    noteCount: plan.noteCount,
    revision: 1,
  };
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write('\n');
      clients.add(res);
      if (state) res.write('data: ' + JSON.stringify(state) + '\n\n');
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(state));
    }
    if (url.pathname === '/action' && req.method === 'POST') {
      let body = '';
      for await (const b of req) body += b;
      const m = JSON.parse(body);
      if (m.type === 'inverse') compiler.inverse(m.page, m.x, m.y);
      if (m.type === 'export') {
        fs.mkdirSync(path.join(extension, 'output'), { recursive: true });
        fs.writeFileSync(
          path.join(extension, 'output/notebook-demo.pdf'),
          await exportNotebook(book, notes, plan),
        );
      }
      res.end('ok');
      return;
    }
    if (url.pathname === '/source.pdf') {
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      return res.end(book.bytes);
    }
    if (url.pathname === '/') {
      const config = {
        pdfjs: '/vendor/pdfjs/build/pdf.mjs',
        worker: '/vendor/pdfjs/build/pdf.worker.mjs',
        cmaps: '/vendor/pdfjs/cmaps/',
        fonts: '/vendor/pdfjs/standard_fonts/',
        wasm: '/vendor/pdfjs/wasm/',
      };
      let html = fs
        .readFileSync(path.join(extension, 'media/index.html'), 'utf8')
        .replace(
          '{{CSP}}',
          "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; font-src 'self' blob:; connect-src 'self'; img-src 'self' blob: data:",
        )
        .replaceAll('{{NONCE}}', 'test')
        .replace('{{CONFIG}}', JSON.stringify(config))
        .replace('{{PDFCSS}}', '/vendor/pdfjs/web/pdf_viewer.css')
        .replace('{{CSS}}', '/media/viewer.css')
        .replace('{{JS}}', '/media/viewer.mjs');
      html = html.replace(
        '</head>',
        `<script>window.acquireVsCodeApi=()=>({postMessage:m=>{if(m.type==='ready')fetch('/state').then(r=>r.json()).then(m=>window.postMessage(m,location.origin));else if(m.type!=='diagnostics')fetch('/action',{method:'POST',body:JSON.stringify(m)})}});const events=new EventSource('/events');events.onmessage=e=>{const m=JSON.parse(e.data);if(m.type==='source-result'){document.body.dataset.sourceResult=JSON.stringify(m);document.querySelector('#status').textContent='源码：'+decodeURI(m.uri).split('/').pop()+' 第 '+(m.selection.start.line+1)+' 行'}else window.postMessage(m,location.origin)};</script></head>`,
      );
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    const file = path.resolve(extension, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(extension + path.sep)) throw Error('Outside assets');
    const type =
      {
        '.mjs': 'application/javascript',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.wasm': 'application/wasm',
        '.pdf': 'application/pdf',
      }[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    fs.createReadStream(file)
      .on('error', () => res.end())
      .pipe(res);
  } catch (e) {
    res.writeHead(500);
    res.end(e.message);
  }
});
initialize()
  .then(() =>
    server.listen(23871, '127.0.0.1', () =>
      console.log('Notebook preview: http://127.0.0.1:23871'),
    ),
  )
  .catch((e) => {
    console.error(e);
    compiler.dispose();
    process.exitCode = 1;
  });
function close() {
  compiler.dispose();
  for (const c of clients) c.end();
  server.close();
  process.exit();
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
