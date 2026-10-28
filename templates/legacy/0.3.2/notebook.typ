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
  assert(options.pos().len() <= 1, message: "note 的位置后最多接受一段正文。")
  let settings = (after: after, ..options.named())
  if options.pos().len() == 0 {
    metadata((kind: "pdf-note-start", settings: settings))
  } else {
    metadata((kind: "pdf-note-block", note: (..settings, body: options.pos().first())))
  }
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
  config: (:),
  body,
) = {
  set document(title: title)
  let theme = math-theme.resolve-config(config: (..config, title: title))
  let content = {
    // 插页与原书书签由插件处理；Typst 只排版笔记，不读取原 PDF。
    metadata((kind: "pdf-notebook", version: 1, template: "chengsi", pdf: pdf,
      title: title, bookmarks: bookmarks))
    let entries = collect-notes(body).filter(n =>
      note-items(n.body).filter(item => not note-whitespace(item)).len() > 0)
    let ids = ()
    for (index, raw) in entries.enumerate() {
      let item = (title: none, style: "blank", chrome: true, id: none, placement: "after",
        ..note-settings.at(str(raw.after), default: (:)), ..raw)
      assert(("after", "right").contains(item.placement), message: "placement 只支持 after 或 right。")
      let id = if item.id == none { "note-" + str(index + 1) } else { item.id }
      assert(not ids.contains(id), message: "笔记 id 重复：" + id)
      ids.push(id)
      let title = if item.title == none { str(item.after) + " · 笔记" } else { item.title }
      let start-label = label("pdf-note-" + id)
      let (width, height) = size
      math-theme.page-frame(width: width, height: height, title: title, config: theme,
        source: "原 PDF · " + str(item.after) + if item.placement == "right" { "" } else { " 之后" },
        style: item.style, chrome: item.chrome,
        page-number: current => current - query(start-label).first().location().page() + 1,
      )[
        #context metadata((kind: "pdf-note", id: id, after: item.after,
          title: title, placement: item.placement, page: here().page()))
        #start-label
        #invisible-heading(title, 1)
        // Each note owns its numbering. Keep the physical page counter intact
        // for insertion planning and source navigation, including continued pages.
        #counter(heading).update(0)
        #counter(math.equation).update(0)
        #counter(figure.where(kind: "math-note")).update(0)
        #counter(figure.where(kind: "math-example")).update(0)
        #counter(figure.where(kind: image)).update(0)
        #counter(figure.where(kind: table)).update(0)
        #counter(footnote).update(0)
        #set heading(outlined: false, bookmarked: false)
        #show heading: it => math-theme.show-heading(theme, it)
        #item.body
      ]
      pagebreak(weak: true)
    }
  }
  math-theme.apply-theme(theme, content)
}
