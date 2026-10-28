#import "@local/typst-pdf-notebook:0.3.2": *
#show: notebook.with(
  pdf: "book.pdf",
  size: (176mm, 250mm),
)

#note(1, placement: "right", title: "页内便签")

= 这页的理解

原书在左，笔记在右。这里直接顶格写正文。

#theorem[线性映射保持向量加法与数乘。]

#source-ref(1)[返回本页原文]

#note(2)

= 较长的解答

常规笔记仍放在原书第 2 页之后，并按内容自然分页。

// 右侧便签写超过一页时，整份笔记也会自动改为这种普通附页。
