// 吸附引擎（纯函数）：节点/组合拖拽时的对齐吸附与等间距吸附。
// 输入拖拽目标 bounds、候选参考形状与容差，输出吸附位移与绘制用参考线——
// 不依赖画布、App 或交互状态，可独立测试。

// 矩形包围盒（世界坐标）：拖拽载体、候选形状、框选矩形与多选组合 bounds
export type Bounds = { x: number; y: number; width: number; height: number }

// 等间距测量线段：起止点（世界坐标）与间距值
export interface SpacingGuide { x1: number; y1: number; x2: number; y2: number; value: number }

// 吸附参考线集合：对齐基线（v 竖线 x 坐标 / h 横线 y 坐标）+ 等间距测量线段
export interface SnapGuides { v: number[]; h: number[]; spacing: SpacingGuide[] }

export interface SnapOptions {
  snapTol: number    // 对齐吸附阈值（世界坐标，调用方按视口缩放折算）
  spacingTol: number // 等间距吸附阈值（世界坐标）
  // 迟滞状态：上一帧对齐吸附在两轴上是否处于吸附态。已吸附的轴本帧用加倍的
  // "释放容差"维持吸附——光标在阈值边界抖动时吸附不反复进出，参考线不闪烁；
  // 由调用方在拖拽会话内逐帧回传，会话结束清零
  prev?: { x: boolean; y: boolean }
}

export interface SnapResult {
  dx: number // 吸附产生的水平位移（应用：box.x += dx）
  dy: number // 吸附产生的垂直位移
  guides: SnapGuides | null // 无任何参考线时为 null
  // 两轴对齐吸附是否处于吸附态（等间距吸附不计入）：供调用方作为下一帧迟滞状态回传
  snappedX: boolean
  snappedY: boolean
}

// 释放容差倍数：处于吸附态的轴用 snapTol 的该倍数做匹配（迟滞区间），
// 进入吸附用原阈值、退出需越过更大的阈值，边界抖动不会导致吸附反复进出
const RELEASE_FACTOR = 2

// 间隙聚类取众数：簇内相邻差值 <= tol，出现次数 >= 2 时取簇均值，否则 NaN
function modeGap(gaps: number[], tol: number): number {
  if (gaps.length < 2) return NaN
  const s = [...gaps].sort((a, b) => a - b)
  let best = NaN
  let bestN = 1
  let i = 0
  while (i < s.length) {
    let j = i
    while (j + 1 < s.length && s[j + 1] - s[j] <= tol) j++
    if (j - i + 1 > bestN) {
      bestN = j - i + 1
      best = (s[i] + s[j]) / 2
    }
    i = j + 1
  }
  return bestN >= 2 ? best : NaN
}

// 单侧吸附的目标间距：当前间隙接近众数时锁定众数，否则复现既有间距 g
function targetGap(cur: number, g: number, mode: number, tol: number): number {
  return !Number.isNaN(mode) && Math.abs(cur - mode) <= tol ? mode : g
}

// 等间距吸附（主流画板做法）：
// 1. 轴线投影过滤——仅与拖拽节点在另一轴上重叠（含少量容差）的节点参与计算，
//    远处行/列夹杂的零碎间距不进入间距池；
// 2. 高频间距锁定——投影带内相邻节点的间隙聚类取众数（至少出现 2 次），
//    接近众数时直接磁吸到该间距，孤立、不规则的间距不产生吸附力；
// 3. 两侧邻居间隙相等时平分差值；仅一侧有邻居时复现既有间距。
// 直接修改载体 b 的坐标；返回绘制用测量线段，以及两轴是否发生了吸附
function applySpacingSnap(
  b: Bounds,
  candidates: readonly Bounds[],
  tol: number,
): { guides: SpacingGuide[]; snappedX: boolean; snappedY: boolean } {
  const out: SpacingGuide[] = []
  let snappedX = false
  let snappedY = false
  {
    // 水平投影带：与拖拽节点垂直方向重叠（含容差）的节点
    const band = candidates.filter(
      (o) => o.y < b.y + b.height + tol && o.y + o.height > b.y - tol,
    )
    const midY = b.y + b.height / 2
    let L: Bounds | null = null
    let R: Bounds | null = null
    for (const o of band) {
      if (o.x + o.width <= b.x && (!L || o.x + o.width > L.x + L.width)) L = o
      if (o.x >= b.x + b.width && (!R || o.x < R.x)) R = o
    }
    // 高频间距样本：带内每个节点与其最近右邻的间隙
    const gapsX: number[] = []
    for (const o of band) {
      let nr: Bounds | null = null
      for (const p of band) {
        if (p === o || p.x < o.x + o.width) continue
        if (!nr || p.x < nr.x) nr = p
      }
      if (nr) {
        const g = nr.x - (o.x + o.width)
        if (g > 0) gapsX.push(g)
      }
    }
    const modeX = modeGap(gapsX, tol)
    const gL = L ? b.x - (L.x + L.width) : Infinity
    const gR = R ? R.x - (b.x + b.width) : Infinity
    if (L && R && gL > 0 && gR > 0) {
      if (Math.abs(gL - gR) <= tol) {
        b.x -= (gL - gR) / 2 // 平分差值，两侧间隙相等
        snappedX = true
      } else if (!Number.isNaN(modeX) && Math.abs(gL - modeX) <= tol && Math.abs(gR - modeX) <= tol) {
        b.x = L.x + L.width + modeX // 两侧都接近高频间距，磁吸过去
        snappedX = true
      }
    } else if (L && !R && gL > 0) {
      // 仅左侧有邻居：优先吸附到高频间距，否则复现 L 与其左邻 LL
      // （投影带内最近）的既有间距
      let LL: Bounds | null = null
      for (const o of band) {
        if (o === L) continue
        if (o.x + o.width <= L.x && (!LL || o.x + o.width > LL.x + LL.width)) LL = o
      }
      if (LL) {
        const g = L.x - (LL.x + LL.width)
        const target = targetGap(gL, g, modeX, tol)
        if (target > 0 && Math.abs(gL - target) <= tol) {
          b.x = L.x + L.width + target
          snappedX = true
        }
      }
    } else if (R && !L && gR > 0) {
      // 仅右侧有邻居：优先吸附到高频间距，否则复现 R 与其右邻 RR
      // （投影带内最近）的既有间距
      let RR: Bounds | null = null
      for (const o of band) {
        if (o === R) continue
        if (o.x >= R.x + R.width && (!RR || o.x < RR.x)) RR = o
      }
      if (RR) {
        const g = RR.x - (R.x + R.width)
        const target = targetGap(gR, g, modeX, tol)
        if (target > 0 && Math.abs(gR - target) <= tol) {
          b.x = R.x - target - b.width
          snappedX = true
        }
      }
    }
    // 吸附平移后重算，两侧间隙相等时输出测量线段
    if (L && R) {
      const a = b.x - (L.x + L.width)
      const c = R.x - (b.x + b.width)
      if (a > 0 && Math.abs(a - c) <= tol) {
        out.push({ x1: L.x + L.width, y1: midY, x2: b.x, y2: midY, value: a })
        out.push({ x1: b.x + b.width, y1: midY, x2: R.x, y2: midY, value: c })
      }
    } else if (L) {
      // 外侧等间距：把 L 左侧的既有间距一并画出
      let LL: Bounds | null = null
      for (const o of band) {
        if (o === L) continue
        if (o.x + o.width <= L.x && (!LL || o.x + o.width > LL.x + LL.width)) LL = o
      }
      if (LL) {
        const g = L.x - (LL.x + LL.width)
        const a = b.x - (L.x + L.width)
        if (g > 0 && a > 0 && (Math.abs(a - g) <= tol || Math.abs(a - modeX) <= tol)) {
          out.push({ x1: LL.x + LL.width, y1: L.y + L.height / 2, x2: L.x, y2: L.y + L.height / 2, value: g })
          out.push({ x1: L.x + L.width, y1: midY, x2: b.x, y2: midY, value: a })
        }
      }
    } else if (R) {
      // 外侧等间距（拖拽节点在左）：把 R 右侧的既有间距一并画出
      let RR: Bounds | null = null
      for (const o of band) {
        if (o === R) continue
        if (o.x >= R.x + R.width && (!RR || o.x < RR.x)) RR = o
      }
      if (RR) {
        const g = RR.x - (R.x + R.width)
        const a = R.x - (b.x + b.width)
        if (g > 0 && a > 0 && (Math.abs(a - g) <= tol || Math.abs(a - modeX) <= tol)) {
          out.push({ x1: b.x + b.width, y1: midY, x2: R.x, y2: midY, value: a })
          out.push({ x1: R.x + R.width, y1: R.y + R.height / 2, x2: RR.x, y2: R.y + R.height / 2, value: g })
        }
      }
    }
  }
  {
    // 垂直投影带：与拖拽节点水平方向重叠（含容差）的节点，逻辑与水平对称
    const band = candidates.filter(
      (o) => o.x < b.x + b.width + tol && o.x + o.width > b.x - tol,
    )
    const midX = b.x + b.width / 2
    let T: Bounds | null = null
    let B: Bounds | null = null
    for (const o of band) {
      if (o.y + o.height <= b.y && (!T || o.y + o.height > T.y + T.height)) T = o
      if (o.y >= b.y + b.height && (!B || o.y < B.y)) B = o
    }
    // 高频间距样本：带内每个节点与其最近下邻的间隙
    const gapsY: number[] = []
    for (const o of band) {
      let nb: Bounds | null = null
      for (const p of band) {
        if (p === o || p.y < o.y + o.height) continue
        if (!nb || p.y < nb.y) nb = p
      }
      if (nb) {
        const g = nb.y - (o.y + o.height)
        if (g > 0) gapsY.push(g)
      }
    }
    const modeY = modeGap(gapsY, tol)
    const gT = T ? b.y - (T.y + T.height) : Infinity
    const gB = B ? B.y - (b.y + b.height) : Infinity
    if (T && B && gT > 0 && gB > 0) {
      if (Math.abs(gT - gB) <= tol) {
        b.y -= (gT - gB) / 2
        snappedY = true
      } else if (!Number.isNaN(modeY) && Math.abs(gT - modeY) <= tol && Math.abs(gB - modeY) <= tol) {
        b.y = T.y + T.height + modeY
        snappedY = true
      }
    } else if (T && !B && gT > 0) {
      let TT: Bounds | null = null
      for (const o of band) {
        if (o === T) continue
        if (o.y + o.height <= T.y && (!TT || o.y + o.height > TT.y + TT.height)) TT = o
      }
      if (TT) {
        const g = T.y - (TT.y + TT.height)
        const target = targetGap(gT, g, modeY, tol)
        if (target > 0 && Math.abs(gT - target) <= tol) {
          b.y = T.y + T.height + target
          snappedY = true
        }
      }
    } else if (B && !T && gB > 0) {
      let BB: Bounds | null = null
      for (const o of band) {
        if (o === B) continue
        if (o.y >= B.y + B.height && (!BB || o.y < BB.y)) BB = o
      }
      if (BB) {
        const g = BB.y - (B.y + B.height)
        const target = targetGap(gB, g, modeY, tol)
        if (target > 0 && Math.abs(gB - target) <= tol) {
          b.y = B.y - target - b.height
          snappedY = true
        }
      }
    }
    if (T && B) {
      const a = b.y - (T.y + T.height)
      const c = B.y - (b.y + b.height)
      if (a > 0 && Math.abs(a - c) <= tol) {
        out.push({ x1: midX, y1: T.y + T.height, x2: midX, y2: b.y, value: a })
        out.push({ x1: midX, y1: b.y + b.height, x2: midX, y2: B.y, value: c })
      }
    } else if (T) {
      let TT: Bounds | null = null
      for (const o of band) {
        if (o === T) continue
        if (o.y + o.height <= T.y && (!TT || o.y + o.height > TT.y + TT.height)) TT = o
      }
      if (TT) {
        const g = T.y - (TT.y + TT.height)
        const a = b.y - (T.y + T.height)
        if (g > 0 && a > 0 && (Math.abs(a - g) <= tol || Math.abs(a - modeY) <= tol)) {
          out.push({ x1: T.x + T.width / 2, y1: TT.y + TT.height, x2: T.x + T.width / 2, y2: T.y, value: g })
          out.push({ x1: midX, y1: T.y + T.height, x2: midX, y2: b.y, value: a })
        }
      }
    } else if (B) {
      // 外侧等间距（拖拽节点在上）：把 B 下方的既有间距一并画出
      let BB: Bounds | null = null
      for (const o of band) {
        if (o === B) continue
        if (o.y >= B.y + B.height && (!BB || o.y < BB.y)) BB = o
      }
      if (BB) {
        const g = BB.y - (B.y + B.height)
        const a = B.y - (b.y + b.height)
        if (g > 0 && a > 0 && (Math.abs(a - g) <= tol || Math.abs(a - modeY) <= tol)) {
          out.push({ x1: midX, y1: b.y + b.height, x2: midX, y2: B.y, value: a })
          out.push({ x1: B.x + B.width / 2, y1: B.y + B.height, x2: B.x + B.width / 2, y2: BB.y, value: g })
        }
      }
    }
  }
  return { guides: out, snappedX, snappedY }
}

// 拖拽吸附总入口：对 bounds 载体（单形状，或多选组合的并集框）做吸附——
// 等间距吸附优先——某轴发生等间距吸附后该轴不再做对齐吸附，
// 避免两类吸附点相邻时（如间距 40px 恰与中线对齐差 1px）来回切换产生抖动；
// 对齐吸附仅同类型基准配对——左对左、中对中、右对右（上/中/下同理），取各类
// 最小差值做吸附平移；吸附后仅在实际吸附的轴上收集精确对齐的基准做参考线
//（等宽节点上下对齐时中线随之对齐，跳过中线参考线）；opts.prev 提供迟滞——
// 上一帧已吸附的轴用加倍的释放容差维持吸附，边界抖动不闪烁。
// 不修改传入的 box，返回位移与参考线，由调用方应用
export function computeSnap(box: Bounds, candidates: readonly Bounds[], opts: SnapOptions): SnapResult {
  const tol = opts.snapTol
  // 迟滞：上一帧已吸附的轴放宽到释放容差，未吸附的轴用进入阈值
  const tolX = opts.prev?.x ? tol * RELEASE_FACTOR : tol
  const tolY = opts.prev?.y ? tol * RELEASE_FACTOR : tol
  const b: Bounds = { ...box }
  // 等间距吸附优先；该轴已吸附时跳过对齐吸附
  const spacing = applySpacingSnap(b, candidates, opts.spacingTol)
  const skipX = spacing.snappedX
  const skipY = spacing.snappedY
  const xs = () => [b.x, b.x + b.width / 2, b.x + b.width]
  const ys = () => [b.y, b.y + b.height / 2, b.y + b.height]
  let bestX: { d: number; shift: number } | null = null
  let bestY: { d: number; shift: number } | null = null
  for (const other of candidates) {
    const oxs = [other.x, other.x + other.width / 2, other.x + other.width]
    const oys = [other.y, other.y + other.height / 2, other.y + other.height]
    for (let i = 0; i < 3; i++) {
      if (!skipX) {
        const d = Math.abs(oxs[i] - xs()[i])
        if (d <= tolX && (!bestX || d < bestX.d)) bestX = { d, shift: oxs[i] - xs()[i] }
      }
      if (!skipY) {
        const d2 = Math.abs(oys[i] - ys()[i])
        if (d2 <= tolY && (!bestY || d2 < bestY.d)) bestY = { d: d2, shift: oys[i] - ys()[i] }
      }
    }
  }
  if (bestX) b.x += bestX.shift
  if (bestY) b.y += bestY.shift
  // 吸附后收集参考线：仅在实际发生对齐吸附的轴上收集，且只收录精确对齐的
  // 基准（吸附平移后差值为浮点零，EPS 过滤舍入误差）——阈值内"接近对齐"的
  // 基线不再画线，避免相差几像素也显示对齐、参考线随鼠标移动忽隐忽现；
  // 等间距吸附的轴由测量线段表达，不重复画对齐线
  const EPS = 1e-6
  const v = new Set<number>()
  const h = new Set<number>()
  if (bestX) {
    for (const other of candidates) {
      const oxs = [other.x, other.x + other.width / 2, other.x + other.width]
      for (let i = 0; i < 3; i++) {
        if (Math.abs(oxs[i] - xs()[i]) <= EPS) v.add(oxs[i])
      }
      // 左右两边都已精确对齐时宽度必然相等、中线随之对齐，跳过中线参考线
      if (Math.abs(oxs[0] - xs()[0]) <= EPS && Math.abs(oxs[2] - xs()[2]) <= EPS) v.delete(oxs[1])
    }
  }
  if (bestY) {
    for (const other of candidates) {
      const oys = [other.y, other.y + other.height / 2, other.y + other.height]
      for (let i = 0; i < 3; i++) {
        if (Math.abs(oys[i] - ys()[i]) <= EPS) h.add(oys[i])
      }
      // 上下两边都已精确对齐时高度必然相等、中线随之对齐，跳过中线参考线
      if (Math.abs(oys[0] - ys()[0]) <= EPS && Math.abs(oys[2] - ys()[2]) <= EPS) h.delete(oys[1])
    }
  }
  return {
    dx: b.x - box.x,
    dy: b.y - box.y,
    snappedX: !skipX && bestX !== null,
    snappedY: !skipY && bestY !== null,
    guides: v.size || h.size || spacing.guides.length
      ? { v: [...v], h: [...h], spacing: spacing.guides }
      : null,
  }
}
