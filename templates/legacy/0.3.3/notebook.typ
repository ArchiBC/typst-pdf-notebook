// Inserted-page notebook using the bundled Chengsi 0.1.2 mathematical styles.
#import "math.typ" as math-theme
#let note-page = math-theme.note-page
#let definition = math-theme.definition
#let theorem = math-theme.theorem
#let lemma = math-theme.lemma
#let proposition = math-theme.proposition
#let corollary = math-theme.corollary
#let example = math-theme.example
#let exercise = math-theme.exercise
#let proof = math-theme.proof
#let remark = math-theme.remark
#let epigraph = math-theme.epigraph
#let code = math-theme.code
#let environments = math-theme.environments
#let bookmark(page, title, id: none, level: auto) = (
  page: page, title: title, id: id, depth: if level == auto { auto } else { level - 1 },
)

#let source-ref(page, body) = link("pdf-notebook-source:" + str(page), body)

#let invisible-heading(title, level) = {
  show heading: it => []
  heading(level: level, numbering: none, outlined: true, bookmarked: true, title)
}

// 只展开顶层内容序列；表格、公式、标题等元素保持其原生结构。
#let note-items(body) = {
  if body.func() == [].func() and body.has("children") {
    body.children.map(note-items).flatten()
  } else {
    (body,)
  }
}

#let note-whitespace(body) = {
  (body == [] or body == [ ] or body.func() == parbreak or
    (body.func() == text and body.text.trim() == ""))
}

// 无方括号时作为起始标记，后续正文归属于它，直到下一个标记或文末。
// 也保留 #note(位置)[正文] 的独立内容块形式。
#let note(after, ..options) = {
  let positional = options.pos()
  let is-right = positional.len() > 0 and positional.first() == right
  if is-right { positional = positional.slice(1) }
  assert(positional.len() <= 1, message: "note 的位置后最多接受 right 标记和一段正文。")
  let settings = (after: after, ..if is-right { (placement: "right") } else { (:) }, ..options.named())
  if positional.len() == 0 {
    metadata((kind: "pdf-note-start", settings: settings))
  } else {
    metadata((kind: "pdf-note-block", note: (..settings, body: positional.first())))
  }
}
#let sidenote(after, ..options) = note(after, right, ..options)

#let side-length(value, base) = {
  if type(value) == ratio or type(value) == int or type(value) == float { value * base }
  else if type(value) == length { value }
  else if type(value) == relative { value.ratio * base + value.length }
  else { panic("便签宽度应为百分比（如 50%）或长度（如 60mm）。") }
}

#let writing-body(theme, body) = {
  counter(heading).update(0)
  counter(math.equation).update(0)
  counter(figure.where(kind: "math-note")).update(0)
  counter(figure.where(kind: "math-example")).update(0)
  counter(figure.where(kind: image)).update(0)
  counter(figure.where(kind: table)).update(0)
  counter(footnote).update(0)
  set heading(outlined: false, bookmarked: false)
  show heading: it => math-theme.show-heading(theme, it)
  body
}

#let collect-notes(body) = {
  let entries = ()
  let current = none
  let parts = ()
  for item in note-items(body) {
    let value = if item.func() == metadata and type(item.value) == dictionary { item.value } else { (:) }
    let kind = value.at("kind", default: none)
    if kind == "pdf-note-start" or kind == "pdf-note-block" {
      if current != none {
        entries.push((..current, body: parts.fold([], (a, b) => a + b)))
      }
      current = none
      parts = ()
      if kind == "pdf-note-start" {
        current = value.settings
      } else {
        entries.push(value.note)
      }
    } else if current != none {
      parts.push(item)
    } else {
      assert(note-whitespace(item), message: "请先写 #note(页码或书签)，然后直接写笔记正文。")
    }
  }
  if current != none {
    entries.push((..current, body: parts.fold([], (a, b) => a + b)))
  }
  entries
}

#let notebook(
  pdf: "book.pdf",
  title: "阅读笔记",
  size: (176mm, 250mm),
  bookmarks: (),
  note-settings: (:),
  side-width: 100% / 3,
  side-margin: 6mm,
  config: (:),
  body,
) = {
  set document(title: title)
  let theme = math-theme.resolve-config(config: (..config, title: title))
  // The plugin checks actual native pagination and requests full-size fallback
  // through compiler inputs. No auxiliary source or configuration file is needed.
  let layout = json(bytes(sys.inputs.at("__pdf_notebook_layout", default: "{}")))
  let content = {
    // 插页与原书书签由插件处理；Typst 只排版笔记，不读取原 PDF。
    metadata((kind: "pdf-notebook", version: 1, template: "chengsi", pdf: pdf,
      title: title, bookmarks: bookmarks, sideLayout: 1, noteLayout: layout))
    let entries = collect-notes(body).filter(n =>
      note-items(n.body).filter(item => not note-whitespace(item)).len() > 0).map(raw =>
      (title: none, style: "blank", chrome: auto, id: none, placement: "after", width: auto, margin: auto,
        ..note-settings.at(str(raw.after), default: (:)), ..raw))
    let side-counts = (:)
    for item in entries {
      if item.placement == "right" {
        let key = repr(item.after)
        side-counts.insert(key, side-counts.at(key, default: 0) + 1)
      }
    }
    let ids = ()
    for (index, item) in entries.enumerate() {
      assert(("after", "right").contains(item.placement), message: "placement 只支持 after 或 right。")
      let id = if item.id == none { "note-" + str(index + 1) } else { item.id }
      assert(not ids.contains(id), message: "笔记 id 重复：" + id)
      ids.push(id)
      let title = if item.title == none { str(item.after) + " · 笔记" } else { item.title }
      let start-label = label("pdf-note-" + id)
      let (page-width, height) = size
      let render(placement, width, frame-theme, fallback: none) = {
        let chrome = placement != "right" and (item.chrome == auto or item.chrome)
        math-theme.page-frame(width: width, height: height, title: title, config: frame-theme,
          source: "原 PDF · " + str(item.after) + if placement == "right" { "" } else { " 之后" },
          style: item.style, chrome: chrome,
          page-number: current => current - query(start-label).first().location().page() + 1,
        )[
          #context metadata((kind: "pdf-note", id: id, after: item.after,
            title: title, placement: placement, requestedPlacement: item.placement,
            ..if fallback == none { (:) } else { (fallback: fallback) }, page: here().page()))
          #start-label
          #invisible-heading(title, 1)
          // Each note owns its numbering. Keep the physical page counter intact
          // for insertion planning and source navigation, including continued pages.
          #writing-body(frame-theme, item.body)
        ]
        pagebreak(weak: true)
      }
      if item.placement == "right" {
        let width = side-length(if item.width == auto { side-width } else { item.width }, page-width)
        let margin = if item.margin == auto { side-margin } else { item.margin }
        let frame-theme = (..theme, margin: margin)
        let usable-width = width - math-theme.margin-side(margin, "left", "x") - math-theme.margin-side(margin, "right", "x")
        let usable-height = height - math-theme.margin-side(margin, "top", "y") - math-theme.margin-side(margin, "bottom", "y")
        assert(usable-width > 0pt and usable-height > 0pt, message: "便签宽度或页边距没有留下可写区域。")
        let duplicate = side-counts.at(repr(item.after), default: 0) > 1
        let fallback = if duplicate { "multiple" } else { layout.at(id, default: none) }
        if fallback != none {
          render("after", page-width, theme, fallback: fallback)
        } else {
          render("right", width, frame-theme)
        }
      } else {
        render("after", page-width, theme)
      }
    }
  }
  math-theme.apply-theme(theme, content)
}
