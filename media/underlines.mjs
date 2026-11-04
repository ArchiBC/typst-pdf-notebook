// Merge neighbouring selections on the same visual line. Geometry is measured
// in page points so the grouping remains stable across zoom and display DPI.
export function underlineBands(areas, width, height) {
  if (!(width > 0 && height > 0)) return areas.map((area) => area.slice());
  const boxes = areas
    .map(([l, t, r, b]) => ({ l: l * width, t: t * height, r: r * width, b: b * height }))
    .sort((a, b) => a.t - b.t || a.l - b.l);
  const lines = [];
  for (const box of boxes) {
    const h = box.b - box.t;
    let best,
      score = -Infinity;
    for (const line of lines) {
      const ref = line.reference,
        refHeight = ref.b - ref.t;
      const overlap = Math.min(box.b, ref.b) - Math.max(box.t, ref.t);
      const centerDistance = Math.abs((box.t + box.b - ref.t - ref.b) / 2);
      if (overlap < Math.min(h, refHeight) * 0.3 || centerDistance > Math.max(h, refHeight) * 0.65)
        continue;
      const similarity = overlap / Math.min(h, refHeight) - centerDistance / Math.max(h, refHeight);
      if (similarity > score) {
        best = line;
        score = similarity;
      }
    }
    if (!best) {
      lines.push({ reference: box, boxes: [box] });
      continue;
    }
    best.boxes.push(box);
    if (h > best.reference.b - best.reference.t) best.reference = box;
  }
  const result = [];
  for (const line of lines) {
    const sorted = line.boxes.slice().sort((a, b) => a.l - b.l);
    const bottomOrder = sorted.slice().sort((a, b) => a.b - b.b);
    const total = bottomOrder.reduce((n, box) => n + box.r - box.l, 0);
    let accumulated = 0,
      baseline = bottomOrder.at(-1).b;
    for (const box of bottomOrder) {
      accumulated += box.r - box.l;
      if (accumulated >= total / 2) {
        baseline = box.b;
        break;
      }
    }
    const maxGap = Math.max(2, (line.reference.b - line.reference.t) * 0.55);
    let group;
    for (const box of sorted) {
      if (group && box.l - group.r <= maxGap) {
        group.r = Math.max(group.r, box.r);
        group.t = Math.min(group.t, box.t);
      } else {
        group = { l: box.l, t: box.t, r: box.r };
        result.push({ ...group, baseline });
      }
      const last = result.at(-1);
      last.r = group.r;
      last.t = group.t;
    }
  }
  return result.map(({ l, t, r, baseline }) => [
    l / width,
    Math.min(t, baseline - 0.01) / height,
    r / width,
    baseline / height,
  ]);
}
