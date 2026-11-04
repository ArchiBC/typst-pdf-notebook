const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
async function wait(fn, label) {
  const end = Date.now() + 25000;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error('Timeout: ' + label);
}
async function run() {
  const root = process.env.NOTEBOOK_TEST_ROOT;
  const main = await vscode.workspace.openTextDocument(path.join(root, 'main.typ'));
  let editor = await vscode.window.showTextDocument(main, { viewColumn: vscode.ViewColumn.One });
  await vscode.commands.executeCommand('pdfNotebook.open');
  const api = await vscode.extensions.getExtension('arcbc.typst-pdf-notebook').activate();
  const session = await api.getSession();
  assert.ok(session.snapshot && !session.lastError);
  const original = main.getText();
  const selectedOffset = original.indexOf('Thoughts about linear maps.') + 'Thoughts'.length;
  const point = main.positionAt(selectedOffset);
  editor.selection = new vscode.Selection(point, point);
  await wait(() => session.insertionEditor?.document === main, 'main editor tracked');
  const message = {
    type: 'save-comment',
    page: 1,
    areas: [[0.1, 0.1, 0.3, 0.12]],
    excerpt: 'Page 1',
    comment: 'CURSOR COMMENT',
    bookVersion: session.bookVersion,
    bookUrl: session.panel.webview.asWebviewUri(vscode.Uri.file(session.bookPath)).toString(),
  };
  editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));
  await assert.rejects(() => session.writeReference(message), /笔记配置之后/);
  assert.equal(main.getText(), original, 'the prelude is never modified by a misplaced cursor');
  editor.selection = new vscode.Selection(point, point);
  session.panel.reveal(vscode.ViewColumn.Beside, false);
  await session.writeReference(message);
  await wait(
    () => session.snapshot.plan.highlights.length === 1 && !session.lastError,
    'main comment compiled',
  );
  const changed = main.getText();
  assert.ok(changed.indexOf('#pdf-comment(1,') > changed.indexOf('Thoughts'));
  assert.ok(changed.indexOf('#pdf-comment(1,') < changed.indexOf('about linear maps.'));
  assert.match(changed, /#pdf-comment\(1, "[\w-]+"\)(?!\[)/);
  assert.ok(changed.includes('CURSOR COMMENT'));
  assert.equal(fs.readFileSync(main.uri.fsPath, 'utf8'), original);
  const mark = session.snapshot.plan.highlights[0];
  const block = session.snapshot.plan.blocks.find(
    (b) => mark.notePage >= b.first && mark.notePage <= b.last,
  );
  assert.equal(block.after, 28, 'comment stays in the note at the cursor');
  editor = await vscode.window.showTextDocument(main, { viewColumn: vscode.ViewColumn.One });
  await vscode.commands.executeCommand('undo');
  await wait(() => main.getText() === original, 'main insert is undoable');
  await wait(
    () => session.snapshot.plan.highlights.length === 0 && !session.lastError,
    'main undo compiled',
  );
  const included = await vscode.workspace.openTextDocument(path.join(root, 'notes/answers-1a.typ'));
  const before = included.getText();
  editor = await vscode.window.showTextDocument(included, { viewColumn: vscode.ViewColumn.One });
  const pos = included.positionAt(before.indexOf('A linear map'));
  editor.selection = new vscode.Selection(pos, pos);
  await wait(() => session.insertionEditor?.document === included, 'included editor tracked');
  session.panel.reveal(vscode.ViewColumn.Beside, false);
  await session.writeReference({ ...message, page: 2, comment: 'INCLUDED COMMENT' });
  await wait(
    () => session.snapshot.plan.highlights.length === 1 && !session.lastError,
    'included comment compiled',
  );
  const actual = included.getText();
  assert.ok(actual.indexOf('#pdf-comment(2,') > actual.indexOf('INCLUDED ANSWER.'));
  assert.ok(actual.indexOf('#pdf-comment(2,') < actual.indexOf('A linear map'));
  assert.ok(actual.includes('INCLUDED COMMENT'));
  assert.equal(fs.readFileSync(included.uri.fsPath, 'utf8'), before);
  const includedMark = session.snapshot.plan.highlights[0];
  const includedBlock = session.snapshot.plan.blocks.find(
    (b) => includedMark.notePage >= b.first && includedMark.notePage <= b.last,
  );
  assert.equal(includedBlock.after, 23);
  await vscode.window.showTextDocument(included, { viewColumn: vscode.ViewColumn.One });
  await vscode.commands.executeCommand('undo');
  await wait(() => included.getText() === before, 'included insert is undoable');
  const unrelatedPath = path.join(root, 'unrelated.typ');
  fs.writeFileSync(unrelatedPath, 'UNRELATED');
  const unrelated = await vscode.workspace.openTextDocument(unrelatedPath);
  await vscode.window.showTextDocument(unrelated, { viewColumn: vscode.ViewColumn.One });
  await wait(() => session.insertionEditor?.document === unrelated, 'unrelated editor tracked');
  await assert.rejects(() => session.writeReference(message), /未被当前笔记入口/);
  assert.equal(unrelated.getText(), 'UNRELATED');
  console.log('Caret insertion and included-file integration passed');
  session.dispose();
}
module.exports = { run };
