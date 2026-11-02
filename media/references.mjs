const $ = (id) => document.getElementById(id);
const sourcePart = (node) =>
  (node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement)?.closest(
    '.page-part[data-kind="source"]',
  );
const fraction = (n) => Math.round(Math.max(0, Math.min(1, n)) * 1e6) / 1e6;
const inside = ([l, t, r, b], x, y) => x >= l && x <= r && y >= t && y <= b;
const overlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
function bounds(x1, y1, x2, y2) {
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)].map(fraction);
}
function relative(r, p) {
  return bounds(
    (r.left - p.left) / p.width,
    (r.top - p.top) / p.height,
    (r.right - p.left) / p.width,
    (r.bottom - p.top) / p.height,
  );
}
function drawBox(node, [l, t, r, b]) {
  Object.assign(node.style, {
    left: l * 100 + '%',
    top: t * 100 + '%',
    width: (r - l) * 100 + '%',
    height: (b - t) * 100 + '%',
  });
}
function textNodes(part) {
  const text = part.querySelector('.textLayer'),
    nodes = [];
  if (text) {
    const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) if (walker.currentNode.length) nodes.push(walker.currentNode);
  }
  return nodes;
}
function selectedText() {
  const selection = getSelection();
  if (!selection.rangeCount || selection.isCollapsed) return;
  const range = selection.getRangeAt(0),
    part = sourcePart(range.startContainer);
  if (!part || sourcePart(range.endContainer) !== part) return;
  const excerpt = selection.toString().trim();
  if (!excerpt) return;
  const p = part.getBoundingClientRect(),
    areas = [];
  for (const node of textNodes(part)) {
    if (!range.intersectsNode(node)) continue;
    const slice = document.createRange();
    slice.setStart(node, node === range.startContainer ? range.startOffset : 0);
    slice.setEnd(node, node === range.endContainer ? range.endOffset : node.length);
    for (const rect of slice.getClientRects()) {
      const a = relative(rect, p);
      if (a[0] >= a[2] || a[1] >= a[3]) continue;
      const last = areas.at(-1);
      if (
        last &&
        Math.abs(last[1] - a[1]) * p.height < 1 &&
        Math.abs(last[3] - a[3]) * p.height < 1 &&
        a[0] >= last[0] &&
        (a[0] - last[2]) * p.width < 2
      )
        last[2] = Math.max(last[2], a[2]);
      else areas.push(a);
    }
  }
  if (areas.length)
    return {
      part,
      page: part.pagePart.page,
      areas,
      excerpt,
      location: range.getBoundingClientRect(),
    };
}
function nativeAreas(annotation, viewport) {
  const points = annotation.quadPoints;
  const boxes = [];
  if (points?.length)
    for (let i = 0; i + 7 < points.length; i += 8) {
      const xy = points.slice(i, i + 8);
      boxes.push([
        Math.min(xy[0], xy[2], xy[4], xy[6]),
        Math.min(xy[1], xy[3], xy[5], xy[7]),
        Math.max(xy[0], xy[2], xy[4], xy[6]),
        Math.max(xy[1], xy[3], xy[5], xy[7]),
      ]);
    }
  else if (annotation.rect) boxes.push(annotation.rect);
  return boxes
    .map((box) => {
      const [x1, y1] = viewport.convertToViewportPoint(box[0], box[1]);
      const [x2, y2] = viewport.convertToViewportPoint(box[2], box[3]);
      return bounds(
        x1 / viewport.width,
        y1 / viewport.height,
        x2 / viewport.width,
        y2 / viewport.height,
      );
    })
    .filter(([l, t, r, b]) => l < r && t < b);
}
function nativeExcerpt(part, areas) {
  const p = part.getBoundingClientRect(),
    range = document.createRange(),
    chars = [];
  for (const node of textNodes(part)) {
    range.selectNodeContents(node);
    if (!areas.some((a) => overlaps(a, relative(range.getBoundingClientRect(), p)))) continue;
    let i = 0;
    for (const ch of node.data) {
      range.setStart(node, i);
      i += ch.length;
      range.setEnd(node, i);
      const r = range.getBoundingClientRect();
      const x = ((r.left + r.right) / 2 - p.left) / p.width,
        y = ((r.top + r.bottom) / 2 - p.top) / p.height;
      if (areas.some((a) => inside(a, x, y))) chars.push(ch);
    }
  }
  return chars.join('').trim();
}
function sameAreas(a, b) {
  return (
    a.length === b.length &&
    a.every((r) => b.some((other) => r.every((v, i) => Math.abs(v - other[i]) < 0.0002)))
  );
}
function near(element, rect) {
  const { width, height } = element.getBoundingClientRect();
  const x =
    rect.right + width + 8 < innerWidth
      ? rect.right + 6
      : Math.min(rect.left, innerWidth - width - 6);
  const y = rect.bottom + height + 10 < innerHeight ? rect.bottom + 5 : rect.top - height - 5;
  element.style.left = Math.max(5, x) + 'px';
  element.style.top = Math.max(5, Math.min(y, innerHeight - height - 5)) + 'px';
}

export function setupReferences({ viewer, send, status, openNote, openSource }) {
  const tool = $('clip-tool'),
    actions = $('selection-actions'),
    card = $('comment-card'),
    input = $('comment-body');
  let identity = {},
    marks = [],
    commentTemplate = true,
    repair,
    retainedText,
    draft,
    drag,
    clipping = false,
    request = 0,
    pending;
  function paint(part) {
    part.querySelector('.source-marks')?.remove();
    const saved = marks.filter((m) => !m.stale && m.page === part.pagePart.page);
    if (!card.hidden && !draft?.invalid && draft?.page === part.pagePart.page) saved.push(draft);
    const layer = document.createElement('div');
    layer.className = 'source-marks';
    for (const m of saved) {
      if (part.nativeMarks?.some((native) => sameAreas(m.areas, native.areas))) continue;
      for (const area of m.areas) {
        const span = document.createElement('span');
        drawBox(span, area);
        layer.append(span);
      }
    }
    if (layer.childElementCount) part.append(layer);
  }
  function repaint() {
    for (const p of viewer.querySelectorAll('.page-part[data-kind="source"]')) paint(p);
  }
  function closeCard() {
    card.hidden = actions.hidden = true;
    draft = undefined;
    repair = retainedText = undefined;
    $('write-comment').textContent = '写侧页注释';
    input.value = '';
    $('comment-error').textContent = '';
    repaint();
  }
  function compose(item) {
    draft = item;
    actions.hidden = true;
    card.hidden = false;
    $('comment-title').textContent =
      `原书第 ${item.page} 页 · ${repair ? '重新关联引用' : '侧页注释'}`;
    $('comment-excerpt').textContent = repair
      ? `原选文：${repair.excerpt}\n新选文：${item.excerpt}`
      : item.excerpt;
    input.hidden = Boolean(repair);
    input.value = retainedText ?? item.comment ?? '';
    $('save-comment').textContent = repair
      ? '关联此处'
      : commentTemplate
        ? '加入笔记'
        : '加入笔记并升级模板';
    $('comment-error').textContent = '';
    near(card, item.location);
    repaint();
    (repair ? $('save-comment') : input).focus();
  }
  function toggleClip(on) {
    if (drag) {
      const { part, id, box } = drag;
      drag = undefined;
      box.remove();
      if (part.hasPointerCapture(id)) part.releasePointerCapture(id);
    }
    clipping = on;
    tool.setAttribute('aria-pressed', String(on));
    viewer.classList.toggle('clipping', on);
  }
  function submit(type, fields) {
    pending = { id: ++request, type };
    if (type === 'save-comment') {
      $('save-comment').disabled = true;
      $('cancel-comment').disabled = true;
    }
    send({ type, ...identity, ...fields, request });
  }
  tool.onclick = () => {
    if (pending || !card.hidden) return;
    closeCard();
    toggleClip(!clipping);
    status(clipping ? '在原书页上拖框，松开复制 Typst 引用。Esc 取消。' : '已退出框选。');
  };
  function pickText() {
    if (clipping || !card.hidden || pending) return;
    draft = selectedText();
    actions.hidden = !draft;
    if (draft) near(actions, draft.location);
  }
  viewer.addEventListener('pointerdown', (e) => {
    if (!clipping || e.button !== 0) {
      if (!actions.hidden) actions.hidden = true;
      return;
    }
    const part = sourcePart(e.target);
    if (!part) return;
    e.preventDefault();
    const box = document.createElement('div');
    box.className = 'clip-box';
    part.append(box);
    const p = part.getBoundingClientRect();
    const u = fraction((e.clientX - p.left) / p.width),
      v = fraction((e.clientY - p.top) / p.height);
    drag = { part, id: e.pointerId, box, u, v };
    part.setPointerCapture(e.pointerId);
    drawBox(box, [u, v, u, v]);
  });
  function draggedArea(e) {
    const p = drag.part.getBoundingClientRect();
    return bounds(drag.u, drag.v, (e.clientX - p.left) / p.width, (e.clientY - p.top) / p.height);
  }
  viewer.addEventListener('pointermove', (e) => {
    if (drag?.id === e.pointerId) drawBox(drag.box, draggedArea(e));
  });
  viewer.addEventListener('pointerup', (e) => {
    if (!drag) {
      if (e.button === 0) requestAnimationFrame(pickText);
      return;
    }
    if (e.pointerId !== drag.id) return;
    const { part } = drag,
      area = draggedArea(e),
      p = part.getBoundingClientRect();
    toggleClip(false);
    if ((area[2] - area[0]) * p.width < 4 || (area[3] - area[1]) * p.height < 4) {
      status('选区太小，请重新框选。');
      return;
    }
    submit('clip-reference', { page: part.pagePart.page, areas: [area] });
  });
  viewer.addEventListener('lostpointercapture', (e) => {
    if (drag?.id === e.pointerId) toggleClip(false);
  });
  viewer.addEventListener('pointercancel', (e) => {
    if (drag?.id === e.pointerId) toggleClip(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pending) {
      toggleClip(false);
      closeCard();
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.key === 'Shift') pickText();
  });
  viewer.addEventListener(
    'scroll',
    () => {
      actions.hidden = true;
    },
    { passive: true },
  );
  $('write-comment').onpointerdown = (e) => e.preventDefault();
  $('write-comment').onclick = () => {
    if (draft) compose(draft);
  };
  $('cancel-comment').onclick = closeCard;
  card.onsubmit = (e) => {
    e.preventDefault();
    if (!draft || pending) return;
    if (draft.invalid) {
      retainedText = input.value;
      card.hidden = true;
      draft = undefined;
      repaint();
      $('write-comment').textContent = '继续注释';
      status('请在原书上重选原文，刚才输入的注释已保留。');
      return;
    }
    submit('save-comment', {
      page: draft.page,
      areas: draft.areas,
      excerpt: draft.excerpt,
      comment: input.value,
      reanchor: repair?.id,
    });
  };
  input.onkeydown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      card.requestSubmit();
    }
  };
  viewer.addEventListener('click', (e) => {
    if (
      clipping ||
      pending ||
      e.ctrlKey ||
      e.metaKey ||
      !card.hidden ||
      !getSelection().isCollapsed ||
      e.target.closest('a')
    )
      return;
    const part = sourcePart(e.target);
    if (!part) return;
    const p = part.getBoundingClientRect(),
      x = (e.clientX - p.left) / p.width,
      y = (e.clientY - p.top) / p.height;
    const hit = (m) => m.areas.some((r) => inside(r, x, y));
    const saved = marks.find((m) => !m.stale && m.page === part.pagePart.page && hit(m));
    if (saved) {
      openNote(saved);
      return;
    }
    const native = part.nativeMarks?.find(hit);
    if (native)
      compose({
        part,
        page: part.pagePart.page,
        areas: native.areas,
        excerpt: nativeExcerpt(part, native.areas) || `原书第 ${part.pagePart.page} 页的高亮选区`,
        comment: native.comment,
        location: new DOMRect(e.clientX, e.clientY, 0, 0),
      });
  });
  return {
    document(message) {
      if (drag && !drag.part.isConnected) toggleClip(false);
      if (identity.bookUrl !== message.bookUrl || identity.bookVersion !== message.bookVersion) {
        toggleClip(false);
        if (!card.hidden && draft) {
          draft.invalid = true;
          $('comment-error').textContent = '原书已更新，请重选原文。你的草稿仍在这里。';
          $('save-comment').textContent = '重选原文';
        } else closeCard();
      }
      identity = { bookUrl: message.bookUrl, bookVersion: message.bookVersion };
      commentTemplate = message.commentTemplate;
      marks = message.highlights || [];
      repaint();
    },
    annotations(part, list, viewport) {
      part.nativeMarks = list
        .filter((a) => a.subtype === 'Highlight')
        .map((a) => ({
          areas: nativeAreas(a, viewport),
          comment: a.contentsObj?.str || '',
        }))
        .filter((a) => a.areas.length);
      paint(part);
    },
    zoom() {
      if (drag) toggleClip(false);
      actions.hidden = true;
    },
    link(id) {
      const m = marks.find((m) => m.id === id);
      if (!m) return;
      if (m.stale) {
        if (!card.hidden || pending) return;
        repair = m;
        $('write-comment').textContent = '关联到这条注释';
        status('原页已变更。在原书重新选择对应原文，再点“关联到这条注释”。Esc 取消。', true);
      } else openSource(m);
    },
    result(m) {
      if (!pending || pending.id !== m.request) return;
      const comment = pending.type === 'save-comment';
      pending = undefined;
      $('save-comment').disabled = $('cancel-comment').disabled = false;
      if (m.error && comment) {
        $('comment-error').textContent = m.error;
        return;
      }
      if (comment) closeCard();
      status(m.error || m.text, !!m.error);
    },
  };
}
