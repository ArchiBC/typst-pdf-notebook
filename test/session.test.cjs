const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// The session's configuration lifecycle does not need an editor or a native engine.
const filename = require.resolve('../src/extension.cjs');
const localRequire = createRequire(filename);
const moduleObject = { exports: {} };
vm.runInNewContext(
  fs.readFileSync(filename, 'utf8'),
  {
    module: moduleObject,
    require: (id) => (id === 'vscode' ? {} : localRequire(id)),
    clearTimeout,
    setTimeout,
  },
  { filename },
);
const { NotebookSession } = moduleObject.exports;

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

test('configuration arriving during the final preview refresh is applied with unsaved content', async () => {
  const session = new NotebookSession();
  const entered = deferred(),
    resume = deferred();
  let configuration = 'first',
    text = 'saved',
    builds = 0,
    refreshes = 0,
    snapshot;
  session.startCompiler = async () => {
    builds++;
    session.compiler = { configuration, dispose() {} };
  };
  session.refresh = async () => {
    if (++refreshes === 1) {
      entered.resolve();
      await resume.promise;
    }
    snapshot = { configuration: session.compiler.configuration, text };
  };
  const first = session.reconfigure();
  await entered.promise;
  configuration = 'latest';
  text = 'UNSAVED BODY';
  const latest = session.reconfigure();
  resume.resolve();
  await Promise.all([first, latest]);
  assert.equal(builds, 2);
  assert.deepEqual(snapshot, { configuration: 'latest', text: 'UNSAVED BODY' });
  assert.equal(session.configurationPromise, null);
  assert.equal(session.reconfiguring, false);
});

test('a newer configuration recovers from an earlier refresh failure', async () => {
  const session = new NotebookSession();
  const entered = deferred(),
    resume = deferred();
  let configuration = 'invalid',
    builds = 0,
    refreshed;
  session.startCompiler = async () => {
    builds++;
    session.compiler = { configuration, dispose() {} };
  };
  session.refresh = async () => {
    if (session.compiler.configuration === 'invalid') {
      entered.resolve();
      await resume.promise;
      throw Error('old configuration failed');
    }
    refreshed = session.compiler.configuration;
  };
  const first = session.reconfigure();
  await entered.promise;
  configuration = 'valid';
  const latest = session.reconfigure();
  resume.resolve();
  await Promise.all([first, latest]);
  assert.equal(builds, 2);
  assert.equal(refreshed, 'valid');
  assert.equal(session.configurationPromise, null);
});

test('configuration changes during compiler startup skip the superseded preview', async () => {
  const session = new NotebookSession();
  const entered = deferred(),
    resume = deferred();
  let configuration = 'first',
    builds = 0,
    refreshes = 0;
  session.startCompiler = async () => {
    session.compiler = { configuration, dispose() {} };
    if (++builds === 1) {
      entered.resolve();
      await resume.promise;
    }
  };
  session.refresh = async () => {
    refreshes++;
    assert.equal(session.compiler.configuration, 'latest');
  };
  const first = session.reconfigure();
  await entered.promise;
  configuration = 'latest';
  const latest = session.reconfigure();
  resume.resolve();
  await Promise.all([first, latest]);
  assert.equal(builds, 2);
  assert.equal(refreshes, 1);
});
