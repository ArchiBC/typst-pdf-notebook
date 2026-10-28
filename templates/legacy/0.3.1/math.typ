// Chengsi 0.1.2 stays unmodified in chengsi/. This adapter owns the inserted-page
// frame and the public math helpers; all mathematical styling comes from Chengsi.
#import "chengsi/template.typ" as chengsi

#let resolve-config(config: (:)) = chengsi.resolve((
  author: "", ..config, cover: false, toc: false, chapter-break: false,
))
#let theme-state = state("pdf-notebook-chengsi", resolve-config())

// Keep the figure itself labelable. Wrapping a theorem in context would attach
// <labels> to the context and break native @references.
#let statement(zh, en, body, title: none, numbering: auto, kind: "math-note") = figure(
  body, kind: kind, outlined: false,
  supplement: context chengsi.localized(theme-state.get(), zh, en),
  caption: metadata((role: en, title: title)),
  ..if numbering == auto { (:) } else { (numbering: numbering) },
)
#let definition = statement.with("定义", "Definition")
#let theorem = statement.with("定理", "Theorem")
#let lemma = statement.with("引理", "Lemma")
#let proposition = statement.with("命题", "Proposition")
#let corollary = statement.with("推论", "Corollary")
#let example = statement.with("例", "Example", kind: "math-example")
#let exercise = statement.with("练习", "Exercise")

// These figures are presentation markers. The active Chengsi configuration is
// applied later, so a notebook's theme/fonts also reach proofs and remarks.
#let proof(body, title: auto) = figure(body, kind: "notebook-proof", numbering: none,
  outlined: false, caption: metadata((title: title)))
#let remark(body, title: auto) = figure(body, kind: "notebook-remark", numbering: none,
  outlined: false, caption: metadata((title: title)))
#let epigraph(body, ..options) = figure(body, kind: "notebook-epigraph", numbering: none,
  outlined: false, caption: metadata(options.named()))
#let code = chengsi.environments(config: resolve-config()).code
#let environments(config: (:)) = chengsi.environments(config: resolve-config(config: config))

#let apply-theme(config, body) = {
  theme-state.update(config)
  let env = chengsi.environments(config: config)
  show figure.where(kind: "math-note"): set figure(numbering: config.theorem-numbering)
  show figure.where(kind: "math-example"): set figure(numbering: config.example-numbering)
  show figure.where(kind: "notebook-proof"): set block(breakable: true)
  show figure.where(kind: "notebook-remark"): set block(breakable: true)
  show figure.where(kind: "notebook-proof"): it => {
    set align(left)
    (env.proof)(it.body, ..it.caption.body.value)
  }
  show figure.where(kind: "notebook-remark"): it => {
    set align(left)
    (env.remark)(it.body, ..it.caption.body.value)
  }
  show figure.where(kind: "notebook-epigraph"): it => (env.epigraph)(it.body, ..it.caption.body.value)
  chengsi.notes(config: config, body)
}

// Inserted notes use Chengsi's section/subsection typography at native heading
// levels. This avoids a chapter banner and preserves numbering and @references.
#let show-heading(config, it) = block(
  above: config.heading-before, below: config.heading-after, sticky: true,
)[
  #text(font: config.font-heading, weight: "bold", fill: config.ink,
    size: if it.level == 1 { config.section-title-size } else { config.subsection-title-size },
  )[
    #if it.numbering != none {
      context counter(heading).display(it.numbering)
      h(0.6em)
    }
    #it.body
  ]
]

#let margin-side(margin, side, axis) = if type(margin) == dictionary {
  margin.at(side, default: margin.at(axis, default: margin.at("rest", default: 0pt)))
} else { margin }

#let page-frame(
  title: "阅读笔记", source: "", width: 176mm, height: 250mm,
  style: "blank", chrome: true, page-number: none, config: resolve-config(), body,
) = {
  assert(("blank", "ruled", "grid").contains(style), message: "未知纸张样式")
  let left-margin = margin-side(config.margin, "left", "x")
  let right-margin = margin-side(config.margin, "right", "x")
  let top-margin = margin-side(config.margin, "top", "y")
  let bottom-margin = margin-side(config.margin, "bottom", "y")
  let writing-width = width - left-margin - right-margin
  let writing-height = height - top-margin - bottom-margin
  let step = 6mm
  set page(
    width: width, height: height, margin: config.margin,
    header-ascent: calc.min(7mm, calc.max(1mm, top-margin - 14mm)), footer-descent: 7mm,
    header: if chrome and config.headers {
      block(width: 100%)[
        #set par(justify: false, leading: 0.4em, spacing: 0pt)
        #text(font: config.font-heading, fill: config.accent, size: 10pt, weight: "bold", title)
        #v(1.3mm)
        #text(font: config.font-heading, fill: config.muted, size: 7.5pt, source)
        #v(2mm)
        #line(length: 100%, stroke: 0.4pt + config.rule)
      ]
    },
    footer: if chrome and config.page-numbers {
      align(right, context text(font: config.font-heading, fill: config.muted, size: 8pt)[
        笔记 #if page-number == none { counter(page).display("1") } else {
          page-number(counter(page).get().first())
        }
      ])
    },
    background: if style != "blank" {
      for i in range(int(calc.floor(writing-height / step)) + 1) {
        place(top + left, dx: left-margin, dy: top-margin + i * step,
          line(length: writing-width, stroke: 0.25pt + config.rule))
      }
      if style == "grid" {
        for i in range(int(calc.floor(writing-width / step)) + 1) {
          place(top + left, dx: left-margin + i * step, dy: top-margin,
            line(start: (0pt, 0pt), end: (0pt, writing-height), stroke: 0.25pt + config.rule))
        }
      }
    },
  )
  body
}

// Retain the standalone note-page utility without resetting page counters once
// per inserted note inside notebook().
#let note-page(
  title: "阅读笔记", source: "", width: 176mm, height: 250mm,
  style: "blank", chrome: true, page-number: none, config: (:), body,
) = {
  let c = resolve-config(config: config)
  apply-theme(c, page-frame(title: title, source: source, width: width, height: height,
    style: style, chrome: chrome, page-number: page-number, config: c, body))
}
