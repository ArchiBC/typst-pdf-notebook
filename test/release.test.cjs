const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  createPlan,
  verifyPackage,
  marketplaceArguments,
  assetUploads,
  newerThan,
  getRelease,
} = require('../scripts/release.cjs');
const manifest = require('../package.json');
const lock = require('../package-lock.json');
const env = {
  GITHUB_REPOSITORY: 'ArchiBC/typst-pdf-notebook',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_REF: `refs/tags/v${manifest.version}`,
  GITHUB_EVENT_NAME: 'push',
};
test('release plans bind repository, tag, publisher and both lockfile versions', () => {
  assert.equal(
    createPlan(manifest, lock, env).filename,
    `${manifest.name}-${manifest.version}.vsix`,
  );
  for (const modified of [
    { GITHUB_REPOSITORY: 'someone/fork' },
    { GITHUB_REF: 'refs/heads/main' },
    { GITHUB_REF: 'refs/tags/v9.9.9' },
    { GITHUB_EVENT_NAME: 'pull_request' },
  ])
    assert.throws(() => createPlan(manifest, lock, { ...env, ...modified }));
  assert.throws(() => createPlan({ ...manifest, publisher: 'other' }, lock, env), /identity/);
  assert.throws(() => createPlan(manifest, { ...lock, version: '9.9.9' }, env), /versions differ/);
  assert.throws(() =>
    createPlan(manifest, { ...lock, packages: { '': { version: '9.9.9' } } }, env),
  );
});
test('branch dry runs are manual only and cannot enable publication', () => {
  const dry = createPlan(manifest, lock, {
    ...env,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    RELEASE_DRY_RUN: 'true',
  });
  assert.equal(dry.dryRun, true);
  assert.throws(() => marketplaceArguments(dry, 'package.vsix'), /dry run/);
  assert.throws(() => createPlan(manifest, lock, { ...env, RELEASE_DRY_RUN: 'true' }), /manually/);
  assert.throws(() =>
    createPlan(manifest, lock, { ...env, MARKETPLACE_TRUSTED_PUBLISHING: 'yes' }),
  );
});
test('Marketplace publication is explicitly OIDC, gated and has no PAT fallback', () => {
  const disabled = createPlan(manifest, lock, env);
  assert.throws(() => marketplaceArguments(disabled, 'package.vsix'), /not enabled/);
  const enabled = createPlan(manifest, lock, { ...env, MARKETPLACE_TRUSTED_PUBLISHING: 'true' });
  assert.deepEqual(marketplaceArguments(enabled, 'package.vsix'), [
    'publish',
    '--oidc',
    '--packagePath',
    'package.vsix',
  ]);
});
test('release verification reads the actual VSIX identity and rejects changed artifact receipts', async () => {
  const root = path.resolve(__dirname, '..');
  const plan = createPlan(manifest, lock, env);
  const receipt = await verifyPackage(root, plan);
  assert.match(receipt.sha256, /^[a-f0-9]{64}$/);
  assert.ok(receipt.bytes > 100000);
  await verifyPackage(root, plan, receipt);
  await assert.rejects(
    verifyPackage(root, plan, { ...receipt, sha256: '0'.repeat(64) }),
    /artifact changed/,
  );
  await assert.rejects(verifyPackage(root, { ...plan, publisher: 'other' }), /publisher/);
});
test('release retries reuse matching assets, reject overwrites and keep published releases intact', () => {
  const asset = { name: 'notes.vsix', sha256: 'a'.repeat(64) };
  assert.deepEqual(assetUploads([], [asset], false), [asset]);
  assert.deepEqual(
    assetUploads([{ name: asset.name, digest: `sha256:${asset.sha256}` }], [asset], true),
    [],
  );
  assert.throws(() => assetUploads([], [asset], true), /not modifying/);
  assert.throws(
    () => assetUploads([{ name: asset.name, digest: 'wrong' }], [asset], false),
    /not overwriting/,
  );
});
test('historical releases cannot replace a newer GitHub Latest release', () => {
  assert.equal(newerThan('0.3.4', 'v0.3.3'), true);
  assert.equal(newerThan('0.3.3', 'v0.3.4'), false);
  assert.equal(newerThan('0.3.3', 'v0.3.3'), false);
  assert.equal(newerThan('0.3.3'), true);
  assert.equal(newerThan('0.3.3', 'unrelated'), false);
});

test('release lookup finds drafts across authenticated pages when the tag endpoint returns 404', () => {
  const plan = createPlan(manifest, lock, env);
  const draft = { id: 42, draft: true, tag_name: plan.tag, assets: [] };
  const calls = [];
  const run = (command, args) => {
    calls.push({ command, args });
    return calls.length === 1
      ? { status: 1, stderr: 'gh: Not Found (HTTP 404)' }
      : { status: 0, stdout: JSON.stringify([[{ tag_name: 'v0.0.1' }], [draft]]) };
  };
  assert.deepEqual(getRelease(plan, `tags/${plan.tag}`, run), draft);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].command, 'gh');
  assert.deepEqual(calls[1].args.slice(-2), ['--paginate', '--slurp']);
  const published = { ...draft, draft: false };
  assert.deepEqual(
    getRelease(plan, `tags/${plan.tag}`, () => ({ status: 0, stdout: JSON.stringify(published) })),
    published,
  );
});

test('release lookup keeps missing drafts separate from permission and transport failures', () => {
  const plan = createPlan(manifest, lock, env);
  const missing = { status: 1, stderr: 'gh: Not Found (HTTP 404)' };
  assert.equal(
    getRelease(plan, 'latest', () => missing),
    undefined,
  );
  let count = 0;
  assert.equal(
    getRelease(plan, `tags/${plan.tag}`, () =>
      ++count === 1 ? missing : { status: 0, stdout: '[[]]' },
    ),
    undefined,
  );
  assert.throws(
    () =>
      getRelease(plan, `tags/${plan.tag}`, () => ({ status: 1, stderr: 'HTTP 403: forbidden' })),
    /403/,
  );
  count = 0;
  assert.throws(
    () =>
      getRelease(plan, `tags/${plan.tag}`, () =>
        ++count === 1 ? missing : { status: 1, error: Error('network unavailable') },
      ),
    /network unavailable/,
  );
});
