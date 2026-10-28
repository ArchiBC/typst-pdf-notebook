#import "@local/typst-pdf-notebook:0.3.3": *
#show: notebook.with(
  pdf: "book.pdf",
  title: "线性代数 · 解答与思考",
  size: (498.9pt, 708.66pt),
)

#note(28, title: "线性映射 · 核与子空间")

= 线性映射的核

先记录定义，再把证明与自己的理解放在一起。

#definition(title: [线性映射])[
  设 $V,W$ 是域 $FF$ 上的向量空间。若对任意 $u,v in V$ 和 $a,b in FF$，都有
  $ T(a u+b v)=a T(u)+b T(v), $
  则称 $T:V -> W$ 为线性映射。
]

#theorem(title: [核是子空间])[
  若 $T:V -> W$ 是线性映射，则 $ker T$ 是 $V$ 的子空间。
] <kernel-subspace>

#proof[
  因为 $T(0)=0$，所以 $0 in ker T$。任取 $u,v in ker T$ 和 $a,b in FF$，由线性性得
  $ T(a u+b v)=a T(u)+b T(v)=0. $
  因此 $a u+b v in ker T$，核对线性组合封闭。
]

#exercise(title: [一个具体例子])[
  设 $T:RR^2 -> RR$，$T(x,y)=x-y$。求它的核，并给出一组基。
]

#proof(title: [解答])[
  $ker T={(x,y) in RR^2 : x=y}={t(1,1):t in RR}$，故一组基为 ${(1,1)}$。
]

由 @kernel-subspace 可知，求核就是在求一个满足线性约束的子空间。

#note(29, title: "零映射 · 独立笔记")

= 零映射的核

#theorem(title: [零映射])[
  设 $T:V -> W$ 满足对所有 $v in V$ 都有 $T(v)=0$，则 $ker T=V$。
] <zero-map>

#proof[
  根据核的定义，
  $ ker T={v in V : T(v)=0}=V. $
]

本条笔记中的 @zero-map 从 1 编号；仍可引用上一条笔记中的 @kernel-subspace。
