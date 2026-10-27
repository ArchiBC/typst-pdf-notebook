// A fresh editor is needed: Tinymist 0.15.10 retains its initial extra arguments
// when its restartServer command is called after a settings change.
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function run() {
  const root = process.env.NOTEBOOK_TEST_ROOT;
  const entry = path.join(root, 'main.typ');
  const doc = await vscode.workspace.openTextDocument(entry);
  await vscode.window.showTextDocument(doc);
  const saved = doc.getText();
  const edit = new vscode.WorkspaceEdit();
  edit.insert(
    doc.uri,
    doc.positionAt(saved.length),
    '\n#metadata((kind: "startup-config", value: sys.inputs.at("notebook-ci", default: "missing")))\n',
  );
  assert.equal(await vscode.workspace.applyEdit(edit), true);
  const extension = vscode.extensions.getExtension('archi.typst-pdf-notebook');
  const api = await extension.activate();
  const session = await api.getSession();
  assert.equal(
    path.relative(path.join(root, 'relative-packages'), session.compiler.packagePath),
    '',
  );
  assert.ok(
    session.snapshot.metadata.some((m) => m.kind === 'startup-config' && m.value === 'startup'),
  );
  const exported = await vscode.commands.executeCommand(
    'tinymist.export',
    'Query',
    { selector: 'metadata', field: 'value', format: 'json' },
    { write: false },
  );
  let metadata;
  try {
    metadata = JSON.parse(exported.data);
  } catch {
    metadata = JSON.parse(Buffer.from(exported.data, 'base64').toString());
  }
  assert.ok(
    metadata.some((m) => m.kind === 'startup-config' && m.value === 'startup'),
    JSON.stringify(metadata),
  );
  assert.equal(
    fs.existsSync(process.env.TYPST_PACKAGE_PATH),
    false,
    'explicit package path takes precedence',
  );
  assert.equal(fs.readFileSync(entry, 'utf8'), saved);
  fs.writeFileSync(
    process.env.NOTEBOOK_EVIDENCE,
    JSON.stringify(
      {
        vscode: vscode.version,
        extensionVersion: extension.packageJSON.version,
        relativePackagePath: true,
        editorConfigurationMatches: true,
        editorAndNotebookInputs: 'startup',
        unsavedContentPreserved: true,
      },
      null,
      2,
    ),
  );
  session.dispose();
  console.log('Tinymist startup configuration integration passed');
}
module.exports = { run };
