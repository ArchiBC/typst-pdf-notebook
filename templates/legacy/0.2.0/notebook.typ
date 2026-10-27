// 随 VS Code 插件分发的 Typst 本地包。书籍配置由 notebook.with(...) 传入。

#let note-page(
  title: "阅读笔记",
  source: "",
  width: 176mm,
  height: 250mm,
  style: "blank",
  chrome: true,
  page-number: none,
  body,
) = {
  assert(("blank", "ruled", "grid").contains(style), message: "未知纸张样式")
  let ink = rgb("244E52")
  let muted = rgb("748488")
  let guide = rgb("E3EBED")
  let margin = 15mm
  let top-margin = 28mm
  let bottom-margin = 20mm
  let step = 6mm
  let writing-width = width - 2 * margin
  let writing-height = height - top-margin - bottom-margin

  set text(
    font: ("Noto Serif SC", "Source Han Serif SC", "Microsoft YaHei", "Libertinus Serif"),
    size: 10.5pt, lang: "zh", fill: rgb("26373B"),
  )
  set par(justify: true, leading: 0.72em)
  set heading(numbering: none)
  show heading: it => block(above: 1.2em, below: 0.65em)[
    #text(fill: ink, weight: "bold", size: if it.depth == 1 { 14pt } else { 11.5pt })[
      #it.body
    ]
  ]
  set page(
    width: width, height: height,
    margin: (left: margin, right: margin, top: top-margin, bottom: bottom-margin),
    header-ascent: 7mm, footer-descent: 7mm,
    header: if chrome {
      block(width: 100%)[
        #text(fill: ink, size: 11pt, weight: "bold", title)
        #v(1.5mm)
        #text(fill: muted, size: 7.5pt, source)
        #v(2mm)
        #line(length: 100%, stroke: 0.6pt + ink)
      ]
    },
    footer: if chrome {
      context grid(
        columns: (1fr, auto),
        text(fill: muted, size: 7.5pt)[阅读 · 演算 · 思考],
        text(fill: muted, size: 7.5pt)[笔记 #if page-number == none {
          counter(page).display("1")
        } else {
          page-number(counter(page).get().first())
        }],
      )
    },
    background: if style != "blank" {
      for i in range(int(calc.floor(writing-height / step)) + 1) {
        place(top + left, dx: margin, dy: top-margin + i * step,
          line(length: writing-width, stroke: 0.25pt + guide))
      }
      if style == "grid" {
        for i in range(int(calc.floor(writing-width / step)) + 1) {
          place(top + left, dx: margin + i * step, dy: top-margin,
            line(start: (0pt, 0pt), end: (0pt, writing-height), stroke: 0.25pt + guide))
        }
      }
    },
  )
  body
}

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
  body,
) = {
  set document(title: title)
  // 插页与原书书签由插件处理；Typst 只排版笔记，不读取原 PDF。
  metadata((kind: "pdf-notebook", version: 1, pdf: pdf,
    title: title, bookmarks: bookmarks))
  let entries = collect-notes(body).filter(n =>
    note-items(n.body).filter(item => not note-whitespace(item)).len() > 0)
  let ids = ()
  for (index, raw) in entries.enumerate() {
    let item = (title: none, style: "blank", chrome: true, id: none,
      ..note-settings.at(str(raw.after), default: (:)), ..raw)
    let id = if item.id == none { "note-" + str(index + 1) } else { item.id }
    assert(not ids.contains(id), message: "笔记 id 重复：" + id)
    ids.push(id)
    let title = if item.title == none { str(item.after) + " · 笔记" } else { item.title }
    let start-label = label("pdf-note-" + id)
    let (width, height) = size
    note-page(width: width, height: height, title: title,
      source: "原 PDF · " + str(item.after) + " 之后", style: item.style, chrome: item.chrome,
      page-number: current => current - query(start-label).first().location().page() + 1,
    )[
      #context metadata((kind: "pdf-note", id: id, after: item.after,
        title: title, page: here().page()))
      #start-label
      #invisible-heading(title, 1)
      #set heading(offset: 1, outlined: false, bookmarked: false)
      #item.body
    ]
    pagebreak(weak: true)
  }
}
