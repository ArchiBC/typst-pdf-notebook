const assert = require('node:assert/strict');

// A native PDF highlight covering the first few words of the synthetic book.
function addFixtureHighlight(doc) {
  const c = doc.context;
  doc.getPage(0).node.addAnnot(
    c.register(
      c.obj({
        Type: 'Annot',
        Subtype: 'Highlight',
        Rect: [35, 647, 68, 660],
        QuadPoints: [35, 660, 68, 660, 35, 647, 68, 647],
        C: [1, 1, 0],
      }),
    ),
  );
}
async function checkReferenceTools(page) {
  await page.selectOption('#zoom', '0.75');
  const part = page.locator('[data-key="source:1"] [data-kind="source"]');
  await page.locator('[data-key="source:1"]').scrollIntoViewIfNeeded();
  await page.waitForFunction(
    () =>
      window.__benchmark.ready('source:1') &&
      document.querySelector('[data-key="source:1"]').rasterScale === 1,
  );
  const text = part.locator('.textLayer span').first();
  await text.scrollIntoViewIfNeeded();
  const point = await part.evaluate((p) => {
    const r = p.getBoundingClientRect(),
      s = p.pagePart;
    return { x: r.x + (48 / s.width) * r.width, y: r.y + (1 - 653 / s.height) * r.height };
  });
  await page.mouse.click(point.x, point.y);
  await page.locator('#comment-card').waitFor({ state: 'visible' });
  assert.match(await page.locator('#comment-excerpt').textContent(), /Page/);
  await page.locator('#cancel-comment').click();

  const rect = await text.evaluate((s) => {
    const n = s.firstChild,
      range = document.createRange();
    range.setStart(n, 0);
    range.setEnd(n, 6);
    return range.getBoundingClientRect().toJSON();
  });
  await page.mouse.move(rect.left + 0.5, rect.top + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.right - 0.5, rect.top + rect.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.locator('#write-comment').click();
  await page.locator('#comment-body').fill('My proof');
  await page.locator('#save-comment').click();
  const saved = await page.evaluate(() =>
    window.__messages.filter((m) => m.type === 'save-comment').at(-1),
  );
  assert.match(saved.excerpt, /Page/);
  assert.equal(saved.page, 1);
  assert.equal(saved.comment, 'My proof');
  assert(saved.areas.length > 0);
  await page.evaluate(
    (request) =>
      window.postMessage({ type: 'reference-result', request, text: 'Saved' }, location.origin),
    saved.request,
  );
  await page.locator('#comment-card').waitFor({ state: 'hidden' });
  await page.locator('#clip-tool').click();
  await page.mouse.move(point.x + 40, point.y + 12);
  await page.mouse.down();
  await page.mouse.move(point.x, point.y, { steps: 6 });
  await page.mouse.up();
  const clip = await page.evaluate(() =>
    window.__messages.filter((m) => m.type === 'clip-reference').at(-1),
  );
  const [l, t, r, b] = clip.areas[0];
  assert.equal(clip.page, 1);
  assert(l < r && t < b);
  assert(Math.abs((r - l) * 498.9 - 40) < 1 && Math.abs((b - t) * 708.66 - 12) < 1);
}
module.exports = { addFixtureHighlight, checkReferenceTools };
