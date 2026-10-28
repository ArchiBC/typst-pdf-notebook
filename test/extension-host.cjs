const vscode = require('vscode'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
async function wait(fn, label) {
  const end = Date.now() + 25000;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw Error('Timeout: ' + label);
}
async function replace(doc, text) {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    doc.uri,
    new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
    text,
  );
  assert.equal(await vscode.workspace.applyEdit(edit), true);
}
async function editorMetadata() {
  const exported = await vscode.commands.executeCommand(
    'tinymist.export',
    'Query',
    { selector: 'metadata', field: 'value', format: 'json' },
    { write: false },
  );
  try {
    return JSON.parse(exported.data);
  } catch {
    return JSON.parse(Buffer.from(exported.data, 'base64').toString());
  }
}
async function run() {
  const root = process.env.NOTEBOOK_TEST_ROOT;
  const manifest = require('../package.json');
  const extension = vscode.extensions.getExtension(`${manifest.publisher}.${manifest.name}`);
  assert.ok(extension);
  assert.ok(extension.packageJSON.extensionDependencies.includes('myriad-dreamin.tinymist'));
  assert.ok(vscode.extensions.getExtension('myriad-dreamin.tinymist'));
  const activeBeforeCommand = extension.isActive;
  assert.equal(
    activeBeforeCommand,
    false,
    'PDF command should activate the extension without a Typst editor',
  );
  const starterFolder = path.join(root, '单文件笔记');
  fs.mkdirSync(starterFolder);
  const starterPdf = path.join(starterFolder, '练习册.PDF');
  fs.copyFileSync(path.join(root, 'book.pdf'), starterPdf);
  const settingsFile = path.join(root, '.vscode/settings.json');
  const originalSettings = fs.readFileSync(settingsFile, 'utf8');
  const initialized = await vscode.commands.executeCommand(
    'pdfNotebook.newNote',
    vscode.Uri.file(starterPdf),
  );
  assert.equal(
    initialized.toLowerCase(),
    path.join(starterFolder, '练习册.notes.typ').toLowerCase(),
  );
  assert.equal(extension.isActive, true);
  const api = await extension.activate();
  const starter = await vscode.workspace.openTextDocument(initialized);
  const starterText = starter.getText();
  assert.match(starterText, /@local\/typst-pdf-notebook:0\.3\.3/);
  assert.match(starterText, /size: \(498\.9pt, 708\.66pt\)/);
  assert.match(starterText, /pdf: "练习册.PDF"/);
  assert.equal(starterText.includes('template.typ'), false);
  assert.deepEqual(fs.readdirSync(starterFolder).sort(), ['练习册.PDF', '练习册.notes.typ']);
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), originalSettings);
  const starterSession = await api.getSession();
  assert.equal(starterSession.entry, starter.uri.fsPath);
  assert.equal(starterSession.snapshot.plan.rows.length, 342);
  assert.equal(starterSession.snapshot.plan.config.template, 'chengsi');
  await replace(starter, starterText + '\n\nUNSAVED STARTER');
  await vscode.commands.executeCommand('pdfNotebook.newNote', vscode.Uri.file(starterFolder));
  assert.equal(starter.getText(), starterText + '\n\nUNSAVED STARTER');
  assert.equal(fs.readFileSync(initialized, 'utf8'), starterText);
  assert.deepEqual(fs.readdirSync(starterFolder).sort(), ['练习册.PDF', '练习册.notes.typ']);
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), originalSettings);
  const extraPath = path.join(starterFolder, 'extra.typ');
  fs.writeFileSync(extraPath, 'INCLUDED STARTER BODY');
  await replace(starter, starterText + '\n\n#include "extra.typ"');
  const extra = await vscode.workspace.openTextDocument(extraPath);
  await vscode.window.showTextDocument(extra, { viewColumn: vscode.ViewColumn.One });
  assert.equal((await api.getSession()).entry, starter.uri.fsPath);
  await starterSession.refresh();
  assert.equal(starterSession.lastError, null);
  starterSession.dispose();
  // Recreate a cold missing-package cache in a test-owned package directory.
  const coldPath = path.join(root, 'cold.notes.typ');
  const coldSaved =
    '#import "@local/typst-pdf-notebook:0.3.1": *\n#show: notebook.with(pdf: "book.pdf")\n#note(1)\nCOLD SAVED\n';
  fs.writeFileSync(coldPath, coldSaved);
  const coldDoc = await vscode.workspace.openTextDocument(coldPath);
  await replace(
    coldDoc,
    coldSaved + '#metadata((kind: "cold-unsaved", value: "KEEP"))\nCOLD UNSAVED\n',
  );
  await vscode.window.showTextDocument(coldDoc, { viewColumn: vscode.ViewColumn.One });
  const originalPackages = process.env.TYPST_PACKAGE_PATH;
  const coldPackages = path.join(root, 'cold-packages');
  fs.mkdirSync(coldPackages);
  // Give the editor an empty package root without touching watched directories.
  // Its next process will cache the missing import before the bridge installs it.
  process.env.TYPST_PACKAGE_PATH = coldPackages;
  try {
    await vscode.commands.executeCommand('tinymist.restartServer');
    await assert.rejects(
      () => vscode.commands.executeCommand('tinymist.export', 'Pdf', {}, { write: false }),
      /package not found/,
    );
    const beforeRestart = api.integration.restarts;
    const repaired = await api.ensureTemplate(coldDoc.uri, { force: true });
    assert.equal(repaired.restarted, true);
    assert.equal(api.integration.restarts, beforeRestart + 1);
    const values = await editorMetadata();
    assert.ok(values.some((m) => m.kind === 'cold-unsaved' && m.value === 'KEEP'));
    await api.ensureTemplate(coldDoc.uri, { force: true });
    assert.equal(
      api.integration.restarts,
      beforeRestart + 1,
      'unchanged templates must not restart Tinymist',
    );
    assert.equal(fs.readFileSync(coldPath, 'utf8'), coldSaved);
  } finally {
    process.env.TYPST_PACKAGE_PATH = originalPackages;
    await vscode.commands.executeCommand('tinymist.restartServer');
  }
  const oldEntry = path.join(root, 'old.notes.typ');
  const oldSource =
    '#import "@local/typst-pdf-notebook:0.3.0": notebook, note\n#show: notebook.with(pdf: "book.pdf")\n#note(1)\n\nOLD NOTE BODY\n';
  fs.writeFileSync(oldEntry, oldSource);
  const oldDoc = await vscode.workspace.openTextDocument(oldEntry);
  await replace(oldDoc, oldSource + '\nUNSAVED USER TEXT');
  await vscode.window.showTextDocument(oldDoc, { viewColumn: vscode.ViewColumn.One });
  assert.equal(await vscode.commands.executeCommand('pdfNotebook.useChengsi'), true);
  assert.ok(oldDoc.getText().startsWith('#import "@local/typst-pdf-notebook:0.3.3": *'));
  assert.ok(oldDoc.getText().endsWith('OLD NOTE BODY\n\nUNSAVED USER TEXT'));
  assert.equal(fs.readFileSync(oldEntry, 'utf8'), oldSource);
  assert.equal(oldDoc.isDirty, true);
  const migratedSession = await api.getSession();
  assert.equal(migratedSession.snapshot.plan.config.template, 'chengsi');
  assert.equal(migratedSession.snapshot.plan.rows.length, 342);
  migratedSession.dispose();
  const main = await vscode.workspace.openTextDocument(path.join(root, 'main.typ'));
  await vscode.window.showTextDocument(main, { viewColumn: vscode.ViewColumn.One });
  await vscode.commands.executeCommand('pdfNotebook.open');
  const session = await api.getSession();
  await wait(() => {
    if (session.viewerError) throw Error('Webview: ' + session.viewerError);
    return session.viewerDiagnostics?.bookPages === 341 && session.viewerDiagnostics?.canvases > 0;
  }, 'webview loads original PDF');
  assert.equal(session.snapshot.plan.rows.length, 343);
  assert.equal(session.snapshot.plan.config.template, 'chengsi');
  assert.ok(session.viewerDiagnostics.canvases <= 8);
  const evidence = {
    vscode: vscode.version,
    extensionVersion: extension.packageJSON.version,
    extensionPath: extension.extensionPath,
    initial: session.viewerDiagnostics,
    originalBookmarks: session.book.items.length,
    builtinTemplate: {
      initialized: true,
      preservesExistingNotes: true,
      nativeImport: true,
      siblingTypOnly: true,
      directoryCommand: true,
      settingsUnchanged: true,
      activeEntryDetected: true,
      commandActivationFromPdf: !activeBeforeCommand,
      includedFileEntryDetected: true,
      chengsiDefault: true,
      migrationPreservesUnsavedBody: true,
      tinymistAutoDependency: true,
      coldPackageCacheRecovered: true,
      editorUnsavedContentSurvivesRestart: true,
    },
  };
  const editor = await vscode.window.showTextDocument(main, { viewColumn: vscode.ViewColumn.One });
  assert.deepEqual(session.compiler.fontPaths, JSON.parse(process.env.NOTEBOOK_TEST_FONT_PATHS));
  assert.equal(session.compiler.packagePath, process.env.TYPST_PACKAGE_PATH);
  const originalMain = main.getText();
  const previousCompiler = session.compiler;
  const engineFolder = path.join(root, '自定义引擎');
  fs.mkdirSync(engineFolder);
  const customBinary = path.join(
    engineFolder,
    process.platform === 'win32' ? 'tinymist.exe' : 'tinymist',
  );
  fs.copyFileSync(session.engine.binary, customBinary);
  if (process.platform !== 'win32') fs.chmodSync(customBinary, 0o755);
  const tinyConfig = vscode.workspace.getConfiguration('tinymist', main.uri);
  const oldServerPath = tinyConfig.inspect('serverPath').workspaceValue;
  const oldExtraArgs = tinyConfig.inspect('typstExtraArgs').workspaceValue;
  await tinyConfig.update('serverPath', customBinary, vscode.ConfigurationTarget.Workspace);
  const relativePackages = path.join(root, 'relative-packages');
  await tinyConfig.update(
    'typstExtraArgs',
    [
      'main.typ',
      '--input',
      'notebook-ci=linked',
      '--package-path',
      path.relative(root, relativePackages),
    ],
    vscode.ConfigurationTarget.Workspace,
  );
  await replace(
    main,
    originalMain +
      '\n#metadata((kind: "linked-config", value: sys.inputs.at("notebook-ci", default: "missing")))\n',
  );
  await wait(
    () =>
      session.compiler !== previousCompiler &&
      !session.configurationPromise &&
      session.snapshot.metadata.some((m) => m.kind === 'linked-config' && m.value === 'linked'),
    'live Tinymist configuration and unsaved edit',
  );
  assert.equal(session.engine.source, 'tinymist.serverPath');
  assert.equal(session.engine.binary, customBinary);
  assert.equal(path.relative(relativePackages, session.compiler.packagePath), '');
  assert.equal(fs.readFileSync(path.join(root, 'main.typ'), 'utf8'), originalMain);
  evidence.tinymistConfiguration = {
    customBinary: true,
    fontPaths: true,
    inputs: true,
    unsavedDuringRestart: true,
    relativePackagePath: true,
  };
  await tinyConfig.update('serverPath', oldServerPath, vscode.ConfigurationTarget.Workspace);
  await tinyConfig.update('typstExtraArgs', oldExtraArgs, vscode.ConfigurationTarget.Workspace);
  await replace(main, originalMain);
  await wait(
    () =>
      !session.configurationPromise &&
      session.snapshot.revision === session.revision &&
      !session.snapshot.metadata.some((m) => m.kind === 'linked-config'),
    'restoring the original compiler configuration',
  );
  editor.selection = new vscode.Selection(12, 6, 12, 6);
  await session.forward(editor);
  await wait(() => session.positionEvents.length > 0, 'forward source mapping');
  const point = session.positionEvents.at(-1);
  assert.equal(point.page, 2);
  await wait(
    () => session.viewerDiagnostics?.currentOutputPage === 30,
    'forward mapping reveals output page 30',
  );
  evidence.forward = {
    notesPosition: point,
    outputPage: session.viewerDiagnostics.currentOutputPage,
  };
  session.compiler.inverse(point.page, point.x + 6, point.y - 3);
  await wait(() => session.sourceEvents.length > 0, 'inverse mapping');
  await wait(
    () => vscode.window.activeTextEditor?.document.uri.fsPath === main.uri.fsPath,
    'inverse reveals editor',
  );
  assert.equal(vscode.window.activeTextEditor.selection.active.line, 12);
  evidence.inverse = session.sourceEvents.at(-1);
  const original = main.getText(),
    revision = session.snapshot.revision;
  await replace(
    main,
    original +
      '\n\n' +
      Array.from(
        { length: 45 },
        (_, i) =>
          `HOST UNSAVED PARAGRAPH ${i}. ` + 'Some reasoning about vector spaces. '.repeat(9),
      ).join('\n\n'),
  );
  await wait(
    () => session.snapshot.revision > revision && session.snapshot.notes.getPageCount() > 2,
    'unsaved expansion',
  );
  assert.ok(main.isDirty);
  evidence.expanded = {
    notesPages: session.snapshot.notes.getPageCount(),
    outputPages: session.snapshot.plan.rows.length,
  };
  const expanded = session.snapshot.revision;
  await replace(main, original);
  await wait(
    () => session.snapshot.revision > expanded && session.snapshot.notes.getPageCount() === 2,
    'automatic shrink',
  );
  assert.equal(session.snapshot.plan.rows.length, 343);
  const answer = await vscode.workspace.openTextDocument(path.join(root, 'notes/answers-1a.typ'));
  const includedText = answer.getText(),
    before = session.snapshot.revision;
  await replace(answer, includedText + '\n\nUNSAVED INCLUDED NOTE');
  await wait(() => session.snapshot.revision > before, 'unsaved included edit');
  assert.ok(answer.isDirty);
  evidence.includedUnsaved = true;
  const paginationRevision = session.snapshot.revision;
  await replace(
    answer,
    includedText +
      '\n\n' +
      Array.from(
        { length: 35 },
        (_, i) => `INCLUDED FLOW ${i}. ` + 'Reasoning through the exercise. '.repeat(8),
      ).join('\n\n'),
  );
  await wait(
    () =>
      session.snapshot.revision > paginationRevision && session.snapshot.plan.blocks[1].first > 2,
    'included pagination moves later note',
  );
  const shiftedPage = session.snapshot.plan.notesToOutput[session.snapshot.plan.blocks[1].first];
  await wait(
    () => session.viewerDiagnostics?.currentOutputPage === shiftedPage,
    'cursor location remaps after earlier note grows',
  );
  evidence.forwardAfterPagination = {
    outputPage: shiftedPage,
    notesPage: session.snapshot.plan.blocks[1].first,
  };
  const flowRevision = session.snapshot.revision;
  await replace(answer, includedText + '\n\nUNSAVED INCLUDED NOTE');
  await wait(
    () => session.snapshot.revision > flowRevision && session.snapshot.notes.getPageCount() === 2,
    'included pagination shrinks again',
  );
  const saved = main.getText(),
    good = session.snapshot.revision;
  await replace(main, saved + '\n#let invalid = (');
  await wait(() => session.lastError, 'invalid source diagnostic');
  assert.equal(session.snapshot.revision, good);
  await replace(main, saved);
  await wait(() => !session.lastError && session.snapshot.revision > good, 'error recovery');
  evidence.errorRecovery = true;
  const exported = await session.export(path.join(root, 'result.pdf'));
  evidence.exported = {
    path: exported,
    bytes: fs.statSync(exported).size,
    pages: session.snapshot.plan.rows.length,
  };
  // A virtual right column must use the same source map as an inserted note.
  const sideMain = original.replace('#note("习题1A")', '#note("习题1A", right)');
  const sideRevision = session.snapshot.revision;
  await replace(main, sideMain);
  await wait(
    () =>
      session.snapshot.revision > sideRevision &&
      session.snapshot.plan.rows.some((x) => x.kind === 'side'),
    'right column appears',
  );
  const sideRow = session.snapshot.plan.rows.find((x) => x.kind === 'side');
  assert.equal(sideRow.page, 23);
  assert.equal(session.snapshot.plan.rows.length, 342);
  assert.ok(Math.abs(sideRow.width - 665.2) < 0.01);
  const sideEditor = await vscode.window.showTextDocument(answer, {
    viewColumn: vscode.ViewColumn.One,
  });
  sideEditor.selection = new vscode.Selection(2, 8, 2, 8);
  const sidePosition = session.positionEvents.at(-1);
  await session.forward(sideEditor);
  try {
    await wait(
      () =>
        session.positionEvents.at(-1) !== sidePosition &&
        session.viewerDiagnostics?.currentOutputPage === 23,
      'forward mapping to right column',
    );
  } catch (error) {
    fs.writeFileSync(
      path.join(root, 'side-forward-failure.json'),
      JSON.stringify(
        {
          positions: session.positionEvents,
          sameEvent: session.positionEvents.at(-1) === sidePosition,
          diagnostics: session.viewerDiagnostics,
          expected: sideRow,
          lastCursor: session.lastCursor,
          viewerError: session.viewerError,
          sourceSelection: sideEditor.selection,
          revision: session.revision,
          snapshotRevision: session.snapshot.revision,
        },
        null,
        2,
      ),
    );
    throw error;
  }
  const sidePoint = session.positionEvents.at(-1),
    sideSource = session.sourceEvents.at(-1);
  session.compiler.inverse(sidePoint.page, sidePoint.x + 5, sidePoint.y - 3);
  await wait(() => session.sourceEvents.at(-1) !== sideSource, 'inverse mapping from right column');
  assert.ok(decodeURI(session.sourceEvents.at(-1).uri).endsWith('/notes/answers-1a.typ'));
  assert.equal(session.sourceEvents.at(-1).selection.start.line, 2);
  const sideExport = await session.export(path.join(root, 'side-result.pdf'));
  const { PDFDocument } = require('pdf-lib');
  const sidePdf = await PDFDocument.load(fs.readFileSync(sideExport));
  assert.equal(sidePdf.getPageCount(), 342);
  assert.ok(Math.abs(sidePdf.getPage(22).getWidth() - 665.2) < 0.01);
  const sideBody = answer.getText(),
    overflowRevision = session.snapshot.revision;
  await replace(answer, sideBody + '\n#lorem(1200)\n');
  await wait(
    () =>
      session.snapshot.revision > overflowRevision &&
      session.snapshot.plan.blocks[0].fallback === 'overflow',
    'right column becomes regular inserts',
  );
  assert.equal(
    session.snapshot.plan.rows.some((x) => x.kind === 'side'),
    false,
  );
  const fallbackPages = session.snapshot.plan.rows.length;
  const shrinkRevision = session.snapshot.revision;
  await replace(answer, sideBody);
  await wait(
    () =>
      session.snapshot.revision > shrinkRevision &&
      session.snapshot.plan.rows.some((x) => x.kind === 'side'),
    'shortened note returns to the right',
  );
  const recoveredPosition = session.positionEvents.at(-1);
  sideEditor.selection = new vscode.Selection(2, 8, 2, 8);
  await session.forward(sideEditor);
  await wait(
    () =>
      session.positionEvents.at(-1) !== recoveredPosition &&
      session.viewerDiagnostics?.currentOutputPage === 23,
    'recovered side retains forward mapping',
  );
  const recoveredPoint = session.positionEvents.at(-1),
    recoveredSource = session.sourceEvents.at(-1);
  session.compiler.inverse(recoveredPoint.page, recoveredPoint.x + 5, recoveredPoint.y - 3);
  await wait(
    () => session.sourceEvents.at(-1) !== recoveredSource,
    'recovered side retains inverse mapping',
  );
  assert.equal(session.sourceEvents.at(-1).selection.start.line, 2);
  evidence.sideNote = {
    sourcePage: 23,
    outputPages: sidePdf.getPageCount(),
    width: sidePdf.getPage(22).getWidth(),
    forwardOutputPage: 23,
    inverseLine: 2,
    fallbackPages,
    recovered: true,
    recoveredSourceMapping: true,
  };
  const restoreRevision = session.snapshot.revision;
  await replace(main, original);
  await wait(
    () => session.snapshot.revision > restoreRevision && session.snapshot.plan.rows.length === 343,
    'restore standard inserts',
  );
  assert.equal(
    fs.readFileSync(path.join(root, 'main.typ'), 'utf8'),
    original,
    'Unsaved edits must not rewrite the file',
  );
  if (process.env.NOTEBOOK_STRESS_HOST) {
    const { performance } = require('node:perf_hooks');
    const exportedSourcePages = { ...session.snapshot.plan.sourceToOutput };
    const base = main.getText();
    const compile = session.compiler.compile.bind(session.compiler);
    let compilations = 0;
    const durations = [],
      editTimes = [];
    session.compiler.compile = async (...args) => {
      const start = performance.now();
      compilations++;
      try {
        return await compile(...args);
      } finally {
        durations.push(performance.now() - start);
      }
    };
    const burstStart = performance.now();
    for (let i = 0; i < 40; i++) {
      await replace(main, base + `\n\n#metadata((kind: "stress-edit", value: ${i}))\nEDIT ${i}`);
      editTimes.push(performance.now());
      await new Promise((r) => setTimeout(r, 15));
    }
    await wait(
      () =>
        session.snapshot.revision === session.revision &&
        session.snapshot.metadata.some((m) => m.kind === 'stress-edit' && m.value === 39),
      'last rapid edit reaches compiled snapshot',
    );
    const editGaps = editTimes.slice(1).map((t, i) => t - editTimes[i]);
    const expectedBatches = 1 + editGaps.filter((t) => t >= 190).length;
    assert.ok(
      compilations <= expectedBatches + 2,
      `Unexpected compilation storm: ${compilations} compiles for ${expectedBatches} edit batches`,
    );
    evidence.typingStress = {
      edits: 40,
      compilations,
      elapsedMs: performance.now() - burstStart,
      finalValue: 39,
      compileMs: durations,
      maxEditGapMs: Math.max(...editGaps),
    };
    session.compiler.compile = compile;
    const { PDFDocument } = require('pdf-lib');
    const merged = await PDFDocument.load(fs.readFileSync(exported));
    const streams = (doc, page) => {
      // The extension bundles its own pdf-lib classes. Use each document's
      // accessors instead of comparing PDFName/PDFArray instances across bundles.
      const contents = page.node.Contents();
      return (
        typeof contents?.asArray === 'function'
          ? contents.asArray().map((ref) => doc.context.lookup(ref))
          : contents
            ? [contents]
            : []
      ).map((s) => Buffer.from(s.contents));
    };
    for (let p = 1; p <= session.book.pageCount; p++)
      assert.deepEqual(
        streams(session.book.doc, session.book.doc.getPage(p - 1)),
        streams(merged, merged.getPage(exportedSourcePages[p] - 1)),
      );
    evidence.typingStress.originalStreamsPreserved = session.book.pageCount;
    assert.equal(fs.readFileSync(path.join(root, 'main.typ'), 'utf8'), original);
  }
  evidence.final = session.viewerDiagnostics;
  assert.equal(session.viewerError, undefined);
  assert.ok(evidence.final.renderedPages <= 8);
  assert.ok(evidence.final.canvases <= 10);
  fs.writeFileSync(process.env.NOTEBOOK_EVIDENCE, JSON.stringify(evidence, null, 2));
  const closingRefresh = session.refresh();
  session.panel.dispose();
  await closingRefresh;
  await wait(() => session.disposed, 'closing preview disposes session');
  console.log('Notebook extension-host integration passed');
}
module.exports = { run };
