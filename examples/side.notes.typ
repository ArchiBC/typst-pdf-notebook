#import "@local/typst-pdf-notebook:0.3.3": *
#show: notebook.with(
  pdf: "book.pdf",
  size: (176mm, 250mm),
)

#sidenote(1)

= 这页的理解

原书在左，笔记在右。这里直接顶格写正文。
便签默认占主页三分之一宽度，没有页头、页脚和页码。

#theorem[线性映射保持向量加法与数乘。]

#source-ref(1)[返回本页原文]

#note(2, right, width: 50%)

这份便签占主页一半宽度。也可使用 #raw("#sidenote(2, width: 50%)")。

#note(3)

= 较长的解答

常规笔记仍放在原书第 3 页之后，并按内容自然分页。

// 右侧便签写超过一页时，整份笔记也会自动改为这种普通附页。
