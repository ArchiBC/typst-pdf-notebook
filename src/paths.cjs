const fs = require('node:fs/promises');
const path = require('node:path');
async function identity(file) {
  let value;
  try {
    value = await fs.realpath(file);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    value = path.resolve(file);
  }
  return process.platform === 'win32' ? value.toLowerCase() : value;
}
async function assertExportTarget(target, ...originals) {
  const key = await identity(target);
  for (const file of originals)
    if (key === (await identity(file))) throw Error('导出目标不能覆盖原书或笔记源码。');
}
module.exports = { assertExportTarget };
