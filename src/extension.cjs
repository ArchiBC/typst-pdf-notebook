const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { fileURLToPath } = require('node:url');
const { PDFDocument } = require('pdf-lib');
const { NotebookCompiler } = require('./compiler.cjs');
const { loadBook, planNotebook, exportNotebook } = require('./document.cjs');
const { assertExportTarget } = require('./paths.cjs');
const { notebookSource, templateUpgradeEdits } = require('./template.cjs');
const { TINYMIST_ID, TemplateBridge, resolveEngine } = require('./tinymist.cjs');

function inside(root, file) {
  const rel = path.relative(root, file);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
class NotebookSession {
  constructor(context, root, entry, output, bridge) {
    Object.assign(this, { context, root, entry, output, bridge });
    this.disposables = [];
    this.revision = 0;
    this.wanted = false;
    this.sourceEvents = [];
    this.positionEvents = [];
    this.disposed = false;
  }
  async startCompiler() {
    const settings = await this.bridge.ensure(this.entry, this.root);
    const tiny = vscode.extensions.getExtension(TINYMIST_ID);
    if (!tiny) throw Error('请先安装 Tinymist 扩展。');
    const engine = await resolveEngine({
      ...settings,
      extensionPath: tiny.extensionPath,
      root: this.root,
    });
    if (this.disposed) return;
    this.engine = { ...settings, ...engine };
    this.output.appendLine(`笔记引擎：${engine.binary}；模板目录：${settings.packagePath}`);
    this.compiler = new NotebookCompiler({
      ...settings,
      binary: engine.binary,
      root: this.root,
      entry: this.entry,
      onLog: (s) => this.output.append(s),
      onSource: (p) => this.revealSource(p),
      onPosition: (p) => {
        this.positionEvents.push(p);
        this.positionEvents = this.positionEvents.slice(-10);
        this.post({ type: 'position', ...p });
      },
    });
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(this.entry));
    const documents = vscode.workspace.textDocuments
      .filter(
        (d) =>
          d.uri.scheme === 'file' && inside(this.root, d.uri.fsPath) && d.languageId === 'typst',
      )
      .map((d) => ({ path: d.uri.fsPath, text: d.getText() }));
    if (!documents.some((d) => d.path === this.entry))
      documents.push({ path: this.entry, text: doc.getText() });
    if (this.disposed) return;
    await this.compiler.start(documents);
  }
  async start() {
    this.starting = true;
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (
          e.document.uri.scheme === 'file' &&
          inside(this.root, e.document.uri.fsPath) &&
          e.document.languageId === 'typst'
        ) {
          this.compiler?.update(e.document.uri.fsPath, e.document.getText());
          this.schedule();
        }
      }),
    );
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((d) => {
        if (
          d.uri.scheme === 'file' &&
          inside(this.root, d.uri.fsPath) &&
          d.languageId === 'typst'
        ) {
          this.compiler?.update(d.uri.fsPath, d.getText());
          this.schedule();
        }
      }),
    );
    this.disposables.push(
      vscode.workspace.onDidCloseTextDocument((d) => {
        if (this.compiler?.opened.has(d.uri.toString())) {
          this.compiler.close(d.uri.fsPath);
          this.schedule();
        }
      }),
    );
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (
          e.kind === vscode.TextEditorSelectionChangeKind.Command ||
          Date.now() < (this.suppressFollowUntil || 0)
        )
          return;
        if (
          vscode.workspace
            .getConfiguration('pdfNotebook', vscode.Uri.file(this.entry))
            .get('followCursor', true) &&
          this.panel?.visible
        ) {
          clearTimeout(this.followTimer);
          this.followTimer = setTimeout(
            () =>
              this.forward(e.textEditor).catch((e) => {
                if (!this.disposed) this.output.appendLine(e.message);
              }),
            170,
          );
        }
      }),
    );
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.root, '**/*.{typ,pdf}'),
    );
    const changed = (uri) => {
      if (uri.fsPath === this.bookPath) {
        this.book = null;
        this.schedule();
      } else if (uri.fsPath.endsWith('.typ') && !this.compiler?.opened.has(uri.toString()))
        this.schedule();
    };
    watcher.onDidChange(changed);
    watcher.onDidCreate(changed);
    watcher.onDidDelete(changed);
    this.disposables.push(watcher);
    await this.startCompiler();
    this.starting = false;
    try {
      await this.refresh();
    } catch {
      // Keep the initialized session alive so a cold compilation failure can
      // show its diagnostic and recover when the user fixes or upgrades the source.
    }
  }
  async reconfigure() {
    if (this.disposed) return;
    if (this.configurationPromise) {
      this.configureAgain = true;
      return this.configurationPromise;
    }
    this.reconfiguring = true;
    this.revision++;
    clearTimeout(this.timer);
    clearTimeout(this.followTimer);
    this.configurationPromise = (async () => {
      await this.refreshing?.catch(() => {});
      do {
        this.configureAgain = false;
        this.compiler?.dispose();
        if (this.disposed) return;
        await this.startCompiler();
      } while (this.configureAgain && !this.disposed);
      this.reconfiguring = false;
      if (!this.disposed) await this.refresh();
    })().finally(() => {
      this.reconfiguring = false;
      this.configurationPromise = null;
    });
    return this.configurationPromise;
  }
  schedule() {
    this.revision++;
    this.wanted = true;
    clearTimeout(this.timer);
    if (this.starting || this.reconfiguring) return;
    this.timer = setTimeout(() => this.refresh().catch((e) => this.error(e)), 200);
  }
  async refresh() {
    if (this.reconfiguring) return this.configurationPromise;
    clearTimeout(this.timer);
    this.wanted = true;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      while (this.wanted && !this.disposed && !this.reconfiguring) {
        this.wanted = false;
        const revision = this.revision;
        this.post({ type: 'status', text: '正在更新笔记…' });
        try {
          let compiled = await this.compiler.compile();
          if (this.disposed) return;
          if (revision !== this.revision) {
            this.wanted = true;
            continue;
          }
          const config = compiled.metadata.find((x) => x.kind === 'pdf-notebook');
          if (!config?.pdf) throw Error('模板未提供原书路径。');
          const bookPath = path.resolve(path.dirname(this.entry), config.pdf);
          if (!inside(this.root, bookPath)) throw Error('原书 PDF 请放在当前工作区内。');
          if (!this.book || this.bookPath !== bookPath) {
            const stat = await fs.stat(bookPath);
            this.book = await loadBook(await fs.readFile(bookPath));
            this.bookPath = bookPath;
            this.bookVersion = `${stat.size}-${stat.mtimeMs}`;
          }
          compiled = await this.compiler.compile({ book: this.book, snapshot: compiled });
          const notes =
            compiled.notes || (await PDFDocument.load(compiled.bytes, { updateMetadata: false }));
          const plan = compiled.plan || planNotebook(this.book, notes, compiled.metadata);
          if (revision !== this.revision) {
            this.wanted = true;
            continue;
          }
          this.snapshot = { ...compiled, notes, plan, revision };
          this.lastError = null;
          this.publish();
        } catch (error) {
          if (this.disposed) return;
          if (revision !== this.revision) {
            this.wanted = true;
            continue;
          }
          this.lastError = error;
          this.error(error);
          if (this.wanted) continue;
          throw error;
        }
      }
    })().finally(() => (this.refreshing = null));
    return this.refreshing;
  }
  post(message) {
    return this.panel?.webview.postMessage(message);
  }
  error(error) {
    if (this.disposed) return;
    this.output.appendLine(error.stack || String(error));
    this.post(this.errorMessage(error));
  }
  errorMessage(error) {
    const doc = vscode.workspace.textDocuments.find(
      (d) => d.uri.scheme === 'file' && d.uri.fsPath === this.entry,
    );
    return {
      type: 'error',
      text: error.message,
      canUpgradeTemplate: Boolean(doc && templateUpgradeEdits(doc.getText()).length),
    };
  }
  publish() {
    if (!this.panel) return;
    if (!this.snapshot) {
      this.post(
        this.lastError
          ? this.errorMessage(this.lastError)
          : { type: 'status', text: '正在更新笔记…' },
      );
      return;
    }
    const { bytes, plan, revision } = this.snapshot;
    this.post({
      type: 'document',
      bookUrl: this.panel.webview.asWebviewUri(vscode.Uri.file(this.bookPath)).toString(),
      bookVersion: this.bookVersion,
      notesData: bytes.toString('base64'),
      rows: plan.rows,
      outline: plan.outline,
      title: plan.config.title,
      noteCount: plan.noteCount,
      revision,
      error: this.lastError ? this.errorMessage(this.lastError) : null,
    });
  }
  async open() {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'typst-pdf-notebook',
      'PDF 阅读笔记',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.context.extensionUri, vscode.Uri.file(this.root)],
      },
    );
    this.panel.onDidDispose(() => {
      this.panel = null;
      this.dispose();
      this.onClose?.();
    });
    this.panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        this.receivedMessages = (this.receivedMessages || []).concat(msg.type).slice(-20);
        if (msg.type === 'ready') this.publish();
        else if (
          msg.type === 'document-ready' &&
          msg.revision === this.snapshot?.revision &&
          this.lastCursor &&
          !this.disposed &&
          vscode.workspace
            .getConfiguration('pdfNotebook', vscode.Uri.file(this.entry))
            .get('followCursor', true)
        ) {
          // Recompute after pagination changes; an earlier jump may have used
          // the old merged-page map while this notes document was loading.
          const { file, line, character } = this.lastCursor;
          await this.compiler.forward(file, line, character);
        } else if (
          msg.type === 'inverse' &&
          this.snapshot &&
          Number.isInteger(msg.page) &&
          msg.page >= 1 &&
          msg.page <= this.snapshot.notes.getPageCount() &&
          Number.isFinite(msg.x) &&
          Number.isFinite(msg.y)
        )
          this.compiler.inverse(msg.page, msg.x, msg.y);
        else if (msg.type === 'export') await this.export();
        else if (msg.type === 'upgrade-template') {
          if (
            await vscode.commands.executeCommand(
              'pdfNotebook.useChengsi',
              vscode.Uri.file(this.entry),
            )
          )
            await this.refresh();
        } else if (msg.type === 'external' && /^https?:\/\//.test(msg.url))
          await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        else if (msg.type === 'diagnostics') this.viewerDiagnostics = msg.value;
        else if (msg.type === 'viewer-error') {
          this.viewerError = msg.text;
          this.output.appendLine('Webview: ' + msg.text);
        }
      } catch (e) {
        this.error(e);
        vscode.window.showErrorMessage(e.message);
      }
    });
    this.panel.webview.html = await this.html(this.panel.webview);
    this.publish();
  }
  async html(webview) {
    let html = await fs.readFile(path.join(this.context.extensionPath, 'media/index.html'), 'utf8');
    const asset = (p) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, p)).toString();
    const config = {
      pdfjs: asset('vendor/pdfjs/build/pdf.mjs'),
      worker: asset('vendor/pdfjs/build/pdf.worker.mjs'),
      cmaps: asset('vendor/pdfjs/cmaps') + '/',
      fonts: asset('vendor/pdfjs/standard_fonts') + '/',
      wasm: asset('vendor/pdfjs/wasm') + '/',
    };
    const nonce = crypto.randomBytes(18).toString('base64');
    const csp = `default-src 'none'; img-src ${webview.cspSource} blob: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}' 'wasm-unsafe-eval'; worker-src ${webview.cspSource} blob:; connect-src ${webview.cspSource}; font-src ${webview.cspSource} blob: data:;`;
    return html
      .replaceAll('{{CSP}}', csp)
      .replaceAll('{{NONCE}}', nonce)
      .replace('{{CONFIG}}', JSON.stringify(config).replaceAll('<', '\\u003c'))
      .replace('{{PDFCSS}}', asset('vendor/pdfjs/web/pdf_viewer.css'))
      .replace('{{CSS}}', asset('media/viewer.css'))
      .replace('{{JS}}', asset('media/viewer.mjs'));
  }
  async revealSource(params) {
    let file;
    try {
      file = fileURLToPath(params.uri);
    } catch {
      return;
    }
    if (!inside(this.root, file) || !file.endsWith('.typ')) return;
    this.sourceEvents.push(params);
    this.sourceEvents = this.sourceEvents.slice(-10);
    this.suppressFollowUntil = Date.now() + 600;
    const range = params.selection
      ? new vscode.Range(
          params.selection.start.line,
          params.selection.start.character,
          params.selection.end.line,
          params.selection.end.character,
        )
      : undefined;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.One,
      selection: range,
      preserveFocus: false,
      preview: false,
    });
  }
  async forward(editor = vscode.window.activeTextEditor) {
    if (
      editor &&
      editor.document.languageId === 'typst' &&
      inside(this.root, editor.document.uri.fsPath)
    ) {
      this.lastCursor = {
        file: editor.document.uri.fsPath,
        line: editor.selection.active.line,
        character: editor.selection.active.character,
      };
      await this.compiler.forward(
        editor.document.uri.fsPath,
        editor.selection.active.line,
        editor.selection.active.character,
      );
    }
  }
  async export(target) {
    if (
      !this.snapshot ||
      this.snapshot.revision !== this.revision ||
      this.wanted ||
      this.refreshing ||
      this.lastError
    )
      await this.refresh();
    if (!this.snapshot || this.lastError) throw this.lastError || Error('笔记尚未成功编译。');
    if (!target) {
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(this.root, 'output/pdf/notebook.pdf')),
        filters: { PDF: ['pdf'] },
        saveLabel: '导出整本笔记',
      });
      if (!uri) return;
      target = uri.fsPath;
    }
    const resolved = path.resolve(target);
    await assertExportTarget(resolved, this.bookPath, this.entry);
    const bytes = await exportNotebook(this.book, this.snapshot.notes, this.snapshot.plan);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    const temp = resolved + `.${crypto.randomBytes(5).toString('hex')}.tmp`;
    try {
      await fs.writeFile(temp, bytes);
      await fs.rename(temp, resolved);
    } finally {
      await fs.rm(temp, { force: true });
    }
    this.post({ type: 'status', text: `已导出 ${this.snapshot.plan.rows.length} 页` });
    return resolved;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    clearTimeout(this.followTimer);
    for (const d of this.disposables) d.dispose();
    this.compiler?.dispose();
  }
}

async function activate(context) {
  const output = vscode.window.createOutputChannel('Typst PDF Notebook');
  context.subscriptions.push(output);
  const integration = new TemplateBridge({
    extensionRoot: context.extensionPath,
    getConfiguration: (entry) =>
      vscode.workspace.getConfiguration('tinymist', vscode.Uri.file(entry)),
    getWorkingDirectory: () => {
      const first = vscode.workspace.workspaceFolders?.[0]?.uri;
      return first?.scheme === 'file' ? first.fsPath : process.cwd();
    },
    restartEditor: async () => {
      const tiny = vscode.extensions.getExtension(TINYMIST_ID);
      if (!tiny) throw Error('Tinymist 依赖尚未安装，请完成扩展安装后重试。');
      await tiny.activate();
      for (let attempt = 0; ; attempt++) {
        try {
          await vscode.commands.executeCommand('tinymist.restartServer');
          break;
        } catch (error) {
          if (
            attempt >= 3 ||
            !/not found|stopped|disposed|initializ|restart|starting|not running|connection/i.test(
              error.message,
            )
          )
            throw error;
          await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
        }
      }
    },
    onLog: (text) => output.appendLine(text),
  });
  async function ensureTemplate(uri, options) {
    const resource = uri || vscode.workspace.workspaceFolders?.[0]?.uri;
    const folder = resource ? vscode.workspace.getWorkspaceFolder(resource) : undefined;
    const root =
      folder?.uri.fsPath ||
      (uri?.scheme === 'file' ? path.dirname(uri.fsPath) : context.extensionPath);
    const entry =
      uri?.scheme === 'file' && path.extname(uri.fsPath).toLowerCase() === '.typ'
        ? uri.fsPath
        : path.join(root, 'main.typ');
    return integration.ensure(entry, root, options);
  }
  const template = await ensureTemplate(vscode.window.activeTextEditor?.document.uri);
  output.appendLine(`Typst 模板：${template.import} (${template.target})`);
  const sessions = new Map();
  let upgradeAvailable = false,
    upgradeTimer,
    upgradeRevision = 0;
  async function refreshUpgradeContext() {
    clearTimeout(upgradeTimer);
    const revision = ++upgradeRevision;
    const doc = vscode.window.activeTextEditor?.document;
    const available = Boolean(
      doc?.uri.scheme === 'file' &&
      doc.languageId === 'typst' &&
      templateUpgradeEdits(doc.getText()).length,
    );
    await vscode.commands.executeCommand('setContext', 'pdfNotebook.canUpgradeTemplate', available);
    if (revision === upgradeRevision) upgradeAvailable = available;
  }
  function updateUpgradeContext() {
    refreshUpgradeContext().catch((error) => output.appendLine(error.stack || String(error)));
  }
  async function useChengsi(uri) {
    const doc =
      uri?.scheme === 'file'
        ? await vscode.workspace.openTextDocument(uri)
        : vscode.window.activeTextEditor?.document;
    if (!doc || doc.uri.scheme !== 'file' || path.extname(doc.uri.fsPath).toLowerCase() !== '.typ')
      throw Error('请先打开要升级的 .typ 笔记入口或模板配置文件。');
    await ensureTemplate(doc.uri);
    if (doc.isClosed) return false;
    const edits = templateUpgradeEdits(doc.getText());
    if (!edits.length) {
      vscode.window.showInformationMessage(
        '当前文件已使用最新内置模板，或没有可升级的旧版内置模板导入。',
      );
      return false;
    }
    const edit = new vscode.WorkspaceEdit();
    for (const item of edits)
      edit.replace(
        doc.uri,
        new vscode.Range(doc.positionAt(item.start), doc.positionAt(item.end)),
        item.text,
      );
    if (!(await vscode.workspace.applyEdit(edit))) throw Error('未能更新模板导入。');
    await vscode.window.showTextDocument(doc, { preview: false });
    await refreshUpgradeContext();
    return true;
  }
  const entryStateKey = (folder) => `pdfNotebook.entry:${folder.uri.toString()}`;
  async function initialize(resourceUri) {
    if (!vscode.workspace.isTrusted) throw Error('请在受信任的工作区初始化笔记。');
    if (!vscode.workspace.workspaceFolders?.length) throw Error('请先打开存放原书的文件夹。');
    let pdfUri = resourceUri;
    let defaultUri =
      resourceUri ||
      vscode.window.activeTextEditor?.document.uri ||
      vscode.workspace.workspaceFolders[0].uri;
    if (defaultUri.scheme !== 'file') defaultUri = vscode.workspace.workspaceFolders[0].uri;
    const resourceStat = await fs.stat(defaultUri.fsPath);
    if (!resourceStat.isDirectory()) defaultUri = vscode.Uri.file(path.dirname(defaultUri.fsPath));
    if (
      !pdfUri ||
      resourceStat.isDirectory() ||
      path.extname(pdfUri.fsPath).toLowerCase() !== '.pdf'
    ) {
      const candidates = (await fs.readdir(defaultUri.fsPath, { withFileTypes: true })).filter(
        (file) => file.isFile() && path.extname(file.name).toLowerCase() === '.pdf',
      );
      pdfUri = candidates.length === 1 ? vscode.Uri.joinPath(defaultUri, candidates[0].name) : null;
    }
    if (!pdfUri) {
      const selected = await vscode.window.showOpenDialog({
        title: '选择要写笔记的原书 PDF',
        filters: { PDF: ['pdf'] },
        canSelectMany: false,
        canSelectFiles: true,
        canSelectFolders: false,
        defaultUri,
      });
      if (!selected?.length) return;
      pdfUri = selected[0];
    }
    const folder = vscode.workspace.getWorkspaceFolder(pdfUri);
    if (pdfUri.scheme !== 'file' || !folder || path.extname(pdfUri.fsPath).toLowerCase() !== '.pdf')
      throw Error('请选择当前工作区内的 PDF 文件。');
    const entry = path.join(
      path.dirname(pdfUri.fsPath),
      path.basename(pdfUri.fsPath, path.extname(pdfUri.fsPath)) + '.notes.typ',
    );
    const exists = await fs.lstat(entry).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
      return null;
    });
    if (exists) {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(entry));
      await context.workspaceState.update(
        entryStateKey(folder),
        path.relative(folder.uri.fsPath, entry),
      );
      vscode.window.showInformationMessage('同名笔记已存在，已打开原文件。');
      return entry;
    }
    const book = await loadBook(await fs.readFile(pdfUri.fsPath));
    if (!book.pageCount) throw Error('原书 PDF 没有页面。');
    const { width, height } = book.sizes[0];
    const text = notebookSource({
      pdf: path.relative(path.dirname(entry), pdfUri.fsPath),
      title: path.basename(pdfUri.fsPath, path.extname(pdfUri.fsPath)) + ' · 阅读笔记',
      width,
      height,
    });
    await fs.writeFile(entry, text, { flag: 'wx' });
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(entry));
    await context.workspaceState.update(
      entryStateKey(folder),
      path.relative(folder.uri.fsPath, entry),
    );
    return entry;
  }
  async function getSession() {
    if (!vscode.workspace.isTrusted) throw Error('请在受信任的工作区使用笔记编译。');
    const folder = vscode.workspace.getWorkspaceFolder(
      vscode.window.activeTextEditor?.document.uri || vscode.workspace.workspaceFolders?.[0]?.uri,
    );
    if (!folder) throw Error('请先打开包含笔记的文件夹。');
    const root = folder.uri.fsPath;
    const active = vscode.window.activeTextEditor?.document;
    const remembered = context.workspaceState.get(entryStateKey(folder));
    const configured = vscode.workspace
      .getConfiguration('pdfNotebook', folder.uri)
      .get('entry', 'main.typ');
    let entry = path.resolve(root, remembered || configured);
    if (
      active?.uri.scheme === 'file' &&
      inside(root, active.uri.fsPath) &&
      path.extname(active.uri.fsPath).toLowerCase() === '.typ' &&
      (sessions.has(active.uri.fsPath) ||
        /^\s*#show:\s*(?:[\w-]+\.)*notebook\b/m.test(active.getText()))
    )
      entry = active.uri.fsPath;
    else if (remembered && !(await fs.stat(entry).catch(() => null)))
      entry = path.resolve(root, configured);
    if (!inside(root, entry)) throw Error('笔记入口必须位于当前工作区内。');
    let session = sessions.get(entry);
    if (session?.disposed) {
      sessions.delete(entry);
      session = null;
    }
    if (!session) {
      session = new NotebookSession(context, root, entry, output, integration);
      sessions.set(entry, session);
      session.onClose = () => sessions.delete(entry);
      session.startPromise = session.start().catch((e) => {
        session.dispose();
        sessions.delete(entry);
        throw e;
      });
    }
    await session.startPromise;
    await session.configurationPromise;
    await context.workspaceState.update(entryStateKey(folder), path.relative(root, entry));
    return session;
  }
  const action =
    (fn) =>
    async (...args) => {
      try {
        return await fn(...args);
      } catch (e) {
        output.appendLine(e.stack || String(e));
        vscode.window.showErrorMessage(e.message);
      }
    };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updateUpgradeContext),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document !== vscode.window.activeTextEditor?.document) return;
      clearTimeout(upgradeTimer);
      upgradeTimer = setTimeout(updateUpgradeContext, 100);
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.uri.scheme === 'file' && doc.languageId === 'typst')
        ensureTemplate(doc.uri).catch((error) => output.appendLine(error.stack || String(error)));
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        !['serverPath', 'fontPaths', 'typstExtraArgs'].some((key) =>
          event.affectsConfiguration(`tinymist.${key}`),
        )
      )
        return;
      for (const session of sessions.values())
        session.startPromise
          .then(() => session.reconfigure())
          .catch((error) => {
            session.lastError = error;
            session.error(error);
          });
      if (!sessions.size)
        ensureTemplate(vscode.window.activeTextEditor?.document.uri).catch((error) =>
          output.appendLine(error.stack || String(error)),
        );
    }),
    vscode.commands.registerCommand('pdfNotebook.newNote', action(initialize)),
    vscode.commands.registerCommand('pdfNotebook.useChengsi', action(useChengsi)),
    vscode.commands.registerCommand('pdfNotebook.initialize', action(initialize)),
    vscode.commands.registerCommand(
      'pdfNotebook.open',
      action(async () => {
        const s = await getSession();
        await s.open();
        return s.entry;
      }),
    ),
    vscode.commands.registerCommand(
      'pdfNotebook.export',
      action(async () => {
        const s = await getSession();
        return s.export();
      }),
    ),
    vscode.commands.registerCommand(
      'pdfNotebook.forwardSearch',
      action(async () => {
        const editor = vscode.window.activeTextEditor;
        const s = await getSession();
        await s.open();
        await s.forward(editor);
      }),
    ),
    {
      dispose: () => {
        clearTimeout(upgradeTimer);
        for (const s of sessions.values()) s.dispose();
      },
    },
  );
  await refreshUpgradeContext();
  return {
    getSession,
    sessions,
    ensureTemplate,
    integration,
    get canUpgradeTemplate() {
      return upgradeAvailable;
    },
  };
}
module.exports = { activate, NotebookSession, inside };
