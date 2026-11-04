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
  await page.evaluate(
    (request) =>
      window.postMessage({ type: 'reference-result', request, text: 'Copied' }, location.origin),
    clip.request,
  );
  // Simulate an already-synced annotation on top of an existing PDF highlight.
  const noteOutput = await page.evaluate(async () => {
    const name = new URLSearchParams(location.search).get('case');
    const state = await (await fetch('/fixture/' + name)).json();
    state.highlights = [
      {
        id: 'test-mark',
        page: 1,
        number: 1,
        notePage: 1,
        noteX: 20,
        noteY: 20,
        areas: [[35 / 498.9, (708.66 - 660) / 708.66, 68 / 498.9, (708.66 - 647) / 708.66]],
        stale: false,
      },
      {
        id: 'mixed-fonts',
        page: 1,
        number: 2,
        notePage: 1,
        noteX: 20,
        noteY: 20,
        areas: [
          [0.284361, 0.1562, 0.379929, 0.171006],
          [0.375296, 0.153598, 0.395883, 0.175066],
          [0.396491, 0.1562, 0.502762, 0.171006],
        ],
        stale: false,
      },
    ];
    state.annotationStyle = 'underline';
    state.commentTemplate = true;
    state.revision = 42;
    window.postMessage(state, location.origin);
    return state.rows.find((row) => row.parts.some((p) => p.kind === 'note' && p.page === 1))
      .outputPage;
  });
  const badge = page.locator('[data-key="source:1"] .source-badge[data-reference="test-mark"]');
  await badge.waitFor({ state: 'visible' });
  assert.equal(await badge.textContent(), '1');
  assert.equal(
    await part.locator('.source-marks.underline span[data-reference="test-mark"]').count(),
    1,
  );
  const mixedLine = part.locator('.source-marks.underline span[data-reference="mixed-fonts"]');
  assert.equal(await mixedLine.count(), 1, 'mixed-font fragments share one baseline');
  assert.ok(
    (await mixedLine.evaluate((node) => parseFloat(getComputedStyle(node).borderBottomWidth))) <= 1,
  );
  await page.selectOption('#annotation-style', 'highlight');
  assert.ok(
    await page.evaluate(() =>
      window.__messages.some((m) => m.type === 'set-annotation-style' && m.style === 'highlight'),
    ),
  );
  assert.equal(
    await part.locator('.source-marks.highlight span[data-reference="test-mark"]').count(),
    0,
    'the existing PDF highlight is not drawn twice',
  );
  assert.equal(await badge.count(), 1, 'the number remains visible over a native highlight');
  await page.selectOption('#annotation-style', 'underline');
  assert.equal(
    await part.locator('.source-marks.underline span[data-reference="test-mark"]').count(),
    1,
  );
  await page.selectOption('#zoom', '1.25');
  await page.waitForFunction(
    () =>
      Math.abs((document.querySelector('[data-key="source:1"]')?.rasterScale || 0) - 5 / 3) <
        1e-6 && window.__benchmark.ready('source:1'),
  );
  assert.equal(await mixedLine.count(), 1, 'the aligned line remains intact at a larger zoom');
  await badge.click();
  await page.waitForFunction(
    (expected) => Number(document.querySelector('#page').value) === expected,
    noteOutput,
  );
}
module.exports = { addFixtureHighlight, checkReferenceTools };
