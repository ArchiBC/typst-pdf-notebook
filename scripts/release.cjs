const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const yauzl = require('yauzl');

const REPOSITORY = 'ArchiBC/typst-pdf-notebook';
const PUBLISHER = 'ArcBC';
const NAME = 'typst-pdf-notebook';
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function boolean(value, name) {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw Error(`${name} must be true or false`);
}
function createPlan(manifest, lock, env) {
  if (env.GITHUB_REPOSITORY !== REPOSITORY) throw Error('Unexpected release repository');
  if (manifest.publisher !== PUBLISHER || manifest.name !== NAME)
    throw Error('Unexpected extension identity');
  if (!VERSION.test(manifest.version)) throw Error('Release version must be X.Y.Z');
  if (lock.version !== manifest.version || lock.packages?.['']?.version !== manifest.version)
    throw Error('package.json and package-lock.json versions differ');
  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '')) throw Error('Invalid source commit');
  const dryRun = boolean(env.RELEASE_DRY_RUN, 'RELEASE_DRY_RUN');
  const marketplace = boolean(env.MARKETPLACE_TRUSTED_PUBLISHING, 'MARKETPLACE_TRUSTED_PUBLISHING');
  const tag = `v${manifest.version}`;
  const tagged = env.GITHUB_REF === `refs/tags/${tag}`;
  if (!['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME))
    throw Error('Only tag pushes and manual releases are supported');
  if (dryRun && env.GITHUB_EVENT_NAME !== 'workflow_dispatch')
    throw Error('Dry runs must be manually dispatched');
  if (!tagged && (!dryRun || env.GITHUB_REF !== 'refs/heads/main'))
    throw Error(`Release ref must be refs/tags/${tag}; only a dry run may use main`);
  return {
    repository: REPOSITORY,
    publisher: PUBLISHER,
    name: NAME,
    version: manifest.version,
    tag,
    ref: env.GITHUB_REF,
    sha: env.GITHUB_SHA,
    filename: `${NAME}-${manifest.version}.vsix`,
    dryRun,
    marketplace,
  };
}
function readVsixManifest(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      let found = false;
      const fail = (error) => {
        zip.close();
        reject(error);
      };
      zip.on('error', fail);
      zip.on('end', () => {
        if (!found) reject(Error('VSIX has no extension/package.json'));
      });
      zip.on('entry', (entry) => {
        if (entry.fileName !== 'extension/package.json') return zip.readEntry();
        found = true;
        if (entry.uncompressedSize > 128 * 1024) return fail(Error('Oversized VSIX manifest'));
        zip.openReadStream(entry, (error, stream) => {
          if (error) return fail(error);
          const chunks = [];
          stream.on('error', fail);
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => {
            zip.close();
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (error) {
              reject(error);
            }
          });
        });
      });
      zip.readEntry();
    });
  });
}
function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
async function verifyPackage(root, plan, receipt) {
  const file = path.join(root, 'output', plan.filename);
  const manifest = await readVsixManifest(file);
  for (const key of ['publisher', 'name', 'version'])
    if (manifest[key] !== plan[key]) throw Error(`VSIX ${key} does not match the release plan`);
  const result = { ...plan, sha256: digest(file), bytes: fs.statSync(file).size };
  if (receipt)
    for (const key of Object.keys(result))
      if (result[key] !== receipt[key]) throw Error(`Verified artifact changed: ${key}`);
  return result;
}
function marketplaceArguments(plan, file) {
  if (plan.dryRun) throw Error('A dry run cannot publish');
  if (!plan.marketplace) throw Error('Marketplace Trusted Publishing is not enabled');
  return ['publish', '--oidc', '--packagePath', file];
}
function assetUploads(assets, expected, published) {
  return expected.filter((asset) => {
    const existing = assets.find((candidate) => candidate.name === asset.name);
    if (!existing) {
      if (published) throw Error(`Published release is missing ${asset.name}; not modifying it`);
      return true;
    }
    if (existing.digest !== `sha256:${asset.sha256}`)
      throw Error(`Release asset differs: ${asset.name}; not overwriting it`);
    return false;
  });
}
function newerThan(version, tag) {
  if (!tag) return true;
  if (!/^v/.test(tag) || !VERSION.test(tag.slice(1))) return false;
  const previous = tag.slice(1).split('.').map(BigInt);
  const current = version.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (current[i] !== previous[i]) return current[i] > previous[i];
  return false;
}
function summary(text) {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n\n');
}
function loadPlan(root) {
  return createPlan(
    JSON.parse(fs.readFileSync(path.join(root, 'package.json'))),
    JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'))),
    process.env,
  );
}
function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', windowsHide: true }).trim();
}
function getRelease(plan, target) {
  const result = spawnSync('gh', ['api', `repos/${plan.repository}/releases/${target}`], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status === 0) return JSON.parse(result.stdout);
  if (/HTTP 404/.test(result.stderr || '')) return undefined;
  throw Error(result.error?.message || result.stderr || 'Cannot read GitHub release');
}
async function githubRelease(root, plan, verified) {
  if (plan.dryRun) throw Error('A dry run cannot publish');
  const file = path.join(root, 'output', plan.filename);
  const checksum = `${file}.sha256`;
  const expected = [file, checksum].map((file) => ({
    file,
    name: path.basename(file),
    sha256: digest(file),
  }));
  const latest = getRelease(plan, 'latest');
  let existing = getRelease(plan, `tags/${plan.tag}`);
  if (existing && !existing.draft) {
    assetUploads(existing.assets, expected, true);
    summary(`GitHub release already contains the verified assets: ${existing.html_url}`);
    return;
  }
  if (!existing) {
    const notes = path.join(root, 'output/release-notes.md');
    const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const start = changelog
      .split(/\r?\n/)
      .findIndex((line) =>
        new RegExp(`^## ${plan.version.replaceAll('.', '\\.')}($|\\s)`).test(line),
      );
    if (start < 0) throw Error(`CHANGELOG.md has no ${plan.version} entry`);
    const changes = changelog
      .split(/\r?\n/)
      .slice(start + 1)
      .join('\n')
      .split(/\n## /)[0]
      .trim();
    fs.writeFileSync(
      notes,
      `${changes}\n\n${
        plan.marketplace
          ? '[Install from Marketplace](https://marketplace.visualstudio.com/items?itemName=ArcBC.typst-pdf-notebook)'
          : 'Marketplace automatic publishing is not enabled. Install the attached VSIX using Extensions: Install from VSIX.'
      }\n\nSource commit: ${plan.sha}\nVSIX SHA-256: ${verified.sha256}\n`,
    );
    gh([
      'release',
      'create',
      plan.tag,
      '--repo',
      plan.repository,
      '--verify-tag',
      '--draft',
      '--target',
      plan.sha,
      '--title',
      `Typst PDF Notebook ${plan.version}`,
      '--notes-file',
      notes,
      '--latest=false',
    ]);
    existing = getRelease(plan, `tags/${plan.tag}`);
  }
  for (const asset of assetUploads(existing.assets, expected, false))
    gh(['release', 'upload', plan.tag, asset.file, '--repo', plan.repository]);
  gh([
    'release',
    'edit',
    plan.tag,
    '--repo',
    plan.repository,
    '--draft=false',
    `--latest=${newerThan(plan.version, latest?.tag_name)}`,
  ]);
  summary(`GitHub release: https://github.com/${plan.repository}/releases/tag/${plan.tag}`);
}
async function main() {
  const root = path.resolve(__dirname, '..');
  const command = process.argv[2];
  const plan = loadPlan(root);
  fs.mkdirSync(path.join(root, 'output'), { recursive: true });
  if (command === 'plan') {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (sha !== plan.sha) throw Error('Checkout is not the triggering commit');
    if (!plan.dryRun) {
      const tagged = execFileSync('git', ['rev-parse', `${plan.ref}^{commit}`], {
        encoding: 'utf8',
      }).trim();
      if (tagged !== plan.sha) throw Error('Release tag moved');
      execFileSync('git', ['merge-base', '--is-ancestor', plan.sha, 'origin/main']);
    }
    if (process.env.GITHUB_OUTPUT)
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        `dry_run=${plan.dryRun}\nmarketplace=${plan.marketplace}\nversion=${plan.version}\n`,
      );
    summary(
      `Release ${plan.tag}: ${plan.dryRun ? 'DRY RUN, no publication' : 'tag release'}. ` +
        `Marketplace: ${plan.marketplace ? 'OIDC enabled' : 'DISABLED; GitHub VSIX only'}.`,
    );
    return;
  }
  const receiptFile = path.join(root, 'output/release-verification.json');
  const receipt =
    command === 'verify' ? undefined : JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  const verified = await verifyPackage(root, plan, receipt);
  const file = path.join(root, 'output', plan.filename);
  if (command === 'verify') {
    fs.writeFileSync(receiptFile, JSON.stringify(verified, null, 2));
    fs.writeFileSync(`${file}.sha256`, `${verified.sha256}  ${plan.filename}\n`);
    summary(
      `Verified the VSIX tested on Windows, macOS and Linux: ${plan.filename}\nSHA-256: ${verified.sha256}`,
    );
  } else if (command === 'marketplace') {
    const cli = path.join(path.dirname(require.resolve('@vscode/vsce/package.json')), 'vsce');
    execFileSync(process.execPath, [cli, ...marketplaceArguments(plan, file)], {
      stdio: 'inherit',
    });
  } else if (command === 'github') {
    await githubRelease(root, plan, verified);
  } else throw Error('Use plan, verify, marketplace or github');
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { createPlan, verifyPackage, marketplaceArguments, assetUploads, newerThan };
