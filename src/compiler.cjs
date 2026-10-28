const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const WebSocket = require('ws');
const { PDFDocument } = require('pdf-lib');
const { planNotebook } = require('./document.cjs');
const { validateServer } = require('./tinymist.cjs');

class NotebookCompiler {
  constructor({
    binary,
    root,
    entry,
    packagePath,
    fontPaths = [],
    extraArgs = [],
    onSource,
    onPosition,
    onLog = () => {},
  }) {
    Object.assign(this, {
      binary,
      root,
      entry,
      packagePath,
      fontPaths,
      extraArgs,
      onSource,
      onPosition,
      onLog,
    });
    this.pending = new Map();
    this.opened = new Map();
    this.next = 0;
    this.disposed = false;
    this.log = '';
    this.protocolReady = false;
    this.compileQueue = Promise.resolve();
    this.noteLayout = {};
  }
  send(message) {
    if (!this.disposed && this.proc?.stdin.writable && !this.proc.stdin.destroyed) {
      const data = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
      this.proc.stdin.write(`Content-Length: ${data.length}\r\n\r\n`);
      this.proc.stdin.write(data);
    }
  }
  notify(method, params) {
    this.send({ method, params });
  }
  request(method, params) {
    return new Promise((resolve, reject) => {
      if (this.disposed) return reject(Error('笔记编译器已关闭'));
      const id = ++this.next;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error(`${method} 超时\n${this.log.slice(-1800)}`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  command(command, ...args) {
    return this.request('workspace/executeCommand', { command, arguments: args });
  }
  async start(documents = []) {
    try {
      await this.startServer(documents);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  async startServer(documents) {
    if (this.disposed) throw Error('笔记编译器已关闭');
    for (const doc of documents)
      if (!this.opened.has(pathToFileURL(doc.path).href)) this.update(doc.path, doc.text);
    const config = {
      rootPath: this.root,
      fontPaths: this.fontPaths,
      typstExtraArgs: [
        this.entry,
        ...this.extraArgs,
        ...(this.packagePath ? ['--package-path', this.packagePath] : []),
      ],
      exportPdf: 'never',
      outputPath: '$root/output/pdf/notes',
      customizedShowDocument: false,
    };
    this.configuration = config;
    this.baseExtraArgs = config.typstExtraArgs.slice();
    this.proc = spawn(this.binary, ['lsp'], { cwd: this.root, windowsHide: true });
    this.proc.stdin.on('error', (e) => {
      if (!this.disposed) this.fail(e);
    });
    let buffer = Buffer.alloc(0);
    this.proc.stderr.on('data', (b) => {
      this.log = (this.log + b).slice(-30000);
      if (!this.disposed) this.onLog(b.toString());
    });
    this.proc.on('error', (e) => this.fail(e));
    this.proc.on('exit', (code) => {
      if (!this.disposed)
        this.fail(Error(`Tinymist 进程已退出 (${code})\n${this.log.slice(-1800)}`));
    });
    this.proc.stdout.on('data', (b) => {
      buffer = Buffer.concat([buffer, b]);
      while (true) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const size = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())?.[1]);
        if (!Number.isFinite(size)) return this.fail(Error('无效 LSP 响应'));
        if (buffer.length < end + 4 + size) return;
        const msg = JSON.parse(buffer.subarray(end + 4, end + 4 + size));
        buffer = buffer.subarray(end + 4 + size);
        this.receive(msg, config);
      }
    });
    const uri = pathToFileURL(this.root).href;
    const init = await this.request('initialize', {
      processId: process.pid,
      rootUri: uri,
      workspaceFolders: [{ uri, name: 'PDF Notebook' }],
      capabilities: {
        workspace: { configuration: true },
        window: { showDocument: { support: true } },
        general: { positionEncodings: ['utf-16'] },
      },
      initializationOptions: config,
    });
    this.version = init.serverInfo?.version;
    this.capabilities = init.capabilities;
    validateServer(init.serverInfo, init.capabilities);
    this.notify('initialized', {});
    this.protocolReady = true;
    for (const [uri, doc] of this.opened)
      this.notify('textDocument/didOpen', {
        textDocument: { uri, version: doc.version, languageId: 'typst', text: doc.text },
      });
    this.vectorBytes = 0;
    await this.startPreview();
  }
  async startPreview() {
    const task = await this.command('tinymist.doStartPreview', [
      '--task-id',
      'pdf-notebook',
      '--data-plane-host',
      '127.0.0.1:0',
      '--no-open',
      this.entry,
    ]);
    this.socket = new WebSocket(`ws://127.0.0.1:${task.dataPlanePort}`, {
      origin: `http://127.0.0.1:${task.staticServerPort || task.dataPlanePort}`,
    });
    this.previewStarted = true;
    this.socket.on('message', (data) => {
      if (this.disposed) return;
      const prefix = data.subarray(0, 20).toString();
      if (prefix.startsWith('jump,') || prefix.startsWith('viewport,')) {
        const [page, x, y] = data.toString().split(',')[1].split(' ').map(Number);
        if (!this.fitting && [page, x, y].every(Number.isFinite)) this.onPosition?.({ page, x, y });
      } else this.vectorBytes += data.length;
    });
    this.socket.on('error', (e) => this.onLog(`定位连接：${e.message}`));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('定位连接超时')), 10000);
      this.socket.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }
  async stopPreview() {
    if (!this.previewStarted) return;
    this.previewStarted = false;
    this.socket?.terminate();
    this.socket = null;
    await this.command('tinymist.doKillPreview', 'pdf-notebook');
  }
  receive(msg, config) {
    if (this.disposed) return;
    if (msg.method && msg.id !== undefined) {
      if (msg.method === 'workspace/configuration')
        this.send({
          id: msg.id,
          result: msg.params.items.map((i) =>
            i.section === 'tinymist'
              ? config
              : (config[i.section?.replace(/^tinymist\./, '')] ?? null),
          ),
        });
      else if (msg.method === 'window/showDocument')
        Promise.resolve(this.onSource?.(msg.params)).then(
          () => this.send({ id: msg.id, result: { success: true } }),
          () => this.send({ id: msg.id, result: { success: false } }),
        );
      else this.send({ id: msg.id, result: null });
    } else if (this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      msg.error ? p.reject(Error(msg.error.message)) : p.resolve(msg.result);
    }
  }
  update(file, text) {
    const uri = pathToFileURL(file).href,
      old = this.opened.get(uri);
    const version = (old?.version || 0) + 1;
    this.opened.set(uri, { version, text });
    if (!this.protocolReady) return;
    if (old)
      this.notify('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    else
      this.notify('textDocument/didOpen', {
        textDocument: { uri, version, languageId: 'typst', text },
      });
  }
  close(file) {
    const uri = pathToFileURL(file).href;
    this.opened.delete(uri);
    if (this.protocolReady) this.notify('textDocument/didClose', { textDocument: { uri } });
  }
  compile(options = {}) {
    // Configuration changes and exports share one native compiler. Serialize
    // them so two callers cannot receive different pagination snapshots.
    const pending = this.compileQueue.then(() => this.fitNotes(options));
    this.compileQueue = pending.catch(() => {});
    return pending;
  }
  async setNoteLayout(layout) {
    const normalized = Object.fromEntries(
      Object.entries(layout).sort(([a], [b]) => a.localeCompare(b)),
    );
    if (JSON.stringify(this.noteLayout) === JSON.stringify(normalized)) return;
    // Tinymist reloads projects when inputs change, disposing their preview
    // watchers. Close the old task before that reload and reconnect only after
    // the final pagination is ready, keeping the same LSP process and documents.
    await this.stopPreview();
    this.noteLayout = normalized;
    this.configuration.typstExtraArgs = [
      ...this.baseExtraArgs,
      '--input',
      `__pdf_notebook_layout=${JSON.stringify(normalized)}`,
    ];
    this.notify('workspace/didChangeConfiguration', { settings: { tinymist: this.configuration } });
  }
  async fitNotes({ book, snapshot } = {}) {
    this.fitting = true;
    try {
      if (!snapshot) await this.setNoteLayout({});
      let result = snapshot || (await this.compileConfigured());
      const config = result.metadata.find((x) => x?.kind === 'pdf-notebook');
      // Immutable older packages retain their original behavior.
      if (config?.sideLayout !== 1) return result;
      const starts = result.metadata.filter((x) => x?.kind === 'pdf-note');
      if (!book && !starts.some((n) => n.placement === 'right')) return result;
      let notes = result.notes || (await PDFDocument.load(result.bytes, { updateMetadata: false }));
      const layout = { ...this.noteLayout };
      let plan;
      if (book) {
        plan = planNotebook(book, notes, result.metadata);
        for (const n of plan.blocks)
          if (n.requestedPlacement === 'right' && n.fallback) layout[n.id] = n.fallback;
      } else {
        for (let i = 0; i < starts.length; i++) {
          const n = starts[i],
            last = i + 1 < starts.length ? starts[i + 1].page - 1 : notes.getPageCount();
          if (n.placement === 'right' && last > n.page) layout[n.id] = 'overflow';
        }
      }
      const before = JSON.stringify(this.noteLayout);
      await this.setNoteLayout(layout);
      if (before !== JSON.stringify(this.noteLayout)) {
        result = await this.compileConfigured();
        notes = await PDFDocument.load(result.bytes, { updateMetadata: false });
        if (book) plan = planNotebook(book, notes, result.metadata);
      }
      return { ...result, notes, ...(plan ? { plan } : {}) };
    } finally {
      try {
        if (!this.disposed && !this.previewStarted) await this.startPreview();
      } finally {
        this.fitting = false;
      }
    }
  }
  async compileConfigured() {
    // Tinymist normally applies didChangeConfiguration before the next export.
    // Check its acknowledgement rather than publishing a stale fallback layout.
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await this.compileOnce();
      const config = result.metadata.find((x) => x?.kind === 'pdf-notebook');
      if (config?.sideLayout !== 1) return result;
      const actual = config.noteLayout || {},
        wanted = this.noteLayout;
      if (
        Object.keys(actual).length === Object.keys(wanted).length &&
        Object.keys(wanted).every((key) => actual[key] === wanted[key])
      )
        return result;
    }
    throw Error('Tinymist 尚未应用便签分页配置，请重试预览。');
  }
  async compileOnce() {
    const [pdf, meta] = await Promise.all([
      this.command('tinymist.exportPdf', this.entry, {}, { write: false }),
      this.command(
        'tinymist.exportQuery',
        this.entry,
        { selector: 'metadata', field: 'value', format: 'json' },
        { write: false },
      ),
    ]);
    if (typeof pdf?.data !== 'string' || typeof meta?.data !== 'string')
      throw Error('Tinymist 未返回笔记 PDF 或元数据；请检查源码诊断。');
    const bytes = Buffer.from(pdf.data, 'base64');
    let metadata;
    try {
      metadata = JSON.parse(meta.data);
    } catch {
      metadata = JSON.parse(Buffer.from(meta.data, 'base64').toString());
    }
    return { bytes, metadata };
  }
  async forward(file, line, character) {
    await this.compileQueue;
    return this.command('tinymist.scrollPreview', 'pdf-notebook', {
      event: 'panelScrollTo',
      filepath: file,
      line,
      character,
    });
  }
  inverse(page, x, y) {
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(`src-point ${JSON.stringify({ page_no: page, x, y })}`);
  }
  fail(error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    if (!this.disposed) this.onLog(error.message);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.protocolReady = false;
    this.socket?.terminate();
    if (this.proc) {
      this.proc.kill();
    }
    this.fail(Error('笔记编译器已关闭'));
  }
}
module.exports = { NotebookCompiler };
