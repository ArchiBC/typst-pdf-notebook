// Rebuild the Marketplace PNG from the editable SVG source.
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright-core');
async function main() {
  const browser = await chromium.launch(
    process.env.NOTEBOOK_BROWSER
      ? { executablePath: process.env.NOTEBOOK_BROWSER }
      : process.platform === 'win32'
        ? { channel: 'msedge' }
        : {},
  );
  try {
    const page = await browser.newPage({
      viewport: { width: 256, height: 256 },
      deviceScaleFactor: 2,
    });
    const svg = await fs.readFile(path.resolve(__dirname, '../media/icon.svg'), 'utf8');
    await page.setContent(
      '<style>html,body{margin:0;background:transparent}svg{display:block}</style>' + svg,
    );
    await page.screenshot({
      path: path.resolve(__dirname, '../media/icon.png'),
      omitBackground: true,
    });
  } finally {
    await browser.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
