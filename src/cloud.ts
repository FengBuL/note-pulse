/*
 * 标签云的排布：用得最多的放在正中间、字最大，往外越来越小。
 * 做法是经典的螺旋排布（word cloud）：按用量从大到小，一个个从中心沿螺旋线往外找第一个不和已放好的重叠的位置。
 * 纯函数，不依赖 DOM。尺寸是估算出来的（汉字按一个字高算宽，其它字符按 0.6），所以标签之间留了余量。
 */

/** 字号档位：和 styles.css 里 .vp-cloud-tag.is-l1 … is-l6 对应（像素） */
export const CLOUD_FONT_PX = [11, 12, 13, 15, 20, 28];

export interface CloudSize {
  w: number;
  h: number;
}

export interface CloudSpot {
  /** 标签中心相对云中心的位置（像素） */
  x: number;
  y: number;
}

/** 用量 → 字号档位（1 到 max）：按平方根拉开，最多的一档最大，最少的一档最小 */
export function cloudLevels(counts: number[], max = CLOUD_FONT_PX.length): number[] {
  if (counts.length === 0) return [];
  const hi = Math.sqrt(Math.max(...counts));
  const lo = Math.sqrt(Math.min(...counts));
  return counts.map((n) => (hi === lo ? Math.min(max, 3) : Math.min(max, 1 + Math.floor(((Math.sqrt(n) - lo) / (hi - lo)) * (max - 0.001)))));
}

/** 估算一个标签的大小：文字宽 + 左右内边距，高按行高 1.5 + 上下内边距 */
export function cloudTagSize(text: string, fontPx: number): CloudSize {
  let em = 0;
  for (const ch of text) em += ch.charCodeAt(0) > 0x2e80 ? 1 : 0.6;
  return { w: Math.ceil(em * fontPx + 22), h: Math.ceil(fontPx * 1.5 + 6) };
}

export interface CloudOptions {
  /** 云的范围（像素）；bounded 为 false 时高度不限（展开后在卡片里滚动） */
  width: number;
  height: number;
  bounded: boolean;
  /** 标签之间最少留多少像素 */
  gap?: number;
}

const overlaps = (a: CloudSpot & CloudSize, b: CloudSpot & CloudSize, gap: number): boolean =>
  Math.abs(a.x - b.x) < (a.w + b.w) / 2 + gap && Math.abs(a.y - b.y) < (a.h + b.h) / 2 + gap;

/**
 * 按顺序（用量从大到小）排布；返回每个标签的位置，放不下的是 null。
 * 第一个标签在正中心；之后的沿椭圆螺旋线往外找位置，椭圆的长宽比跟云的长宽比一致，这样横长的卡片里云也是横着长开的。
 */
export function cloudLayout(sizes: CloudSize[], opt: CloudOptions): (CloudSpot | null)[] {
  const gap = opt.gap ?? 4;
  const halfW = opt.width / 2;
  const halfH = opt.height / 2;
  const aspect = Math.sqrt(Math.max(0.4, Math.min(2.5, opt.width / Math.max(1, opt.height))));
  const placed: (CloudSpot & CloudSize)[] = [];
  const out: (CloudSpot | null)[] = [];
  for (const s of sizes) {
    let found: CloudSpot | null = null;
    // 螺旋：r = 0.9 * θ，角度每次走 0.12 弧度；一圈大约 52 步，足够把空位扫到
    for (let step = 0; step < 9000 && !found; step++) {
      const theta = step * 0.12;
      const r = 0.9 * theta;
      const spot = { x: Math.round(r * Math.cos(theta) * aspect), y: Math.round((r * Math.sin(theta)) / aspect) };
      if (Math.abs(spot.x) + s.w / 2 > halfW) {
        // 超出左右边界：再往外只会更远，这一圈放不下；但螺旋回到别的角度可能又在界内，所以继续找，直到半径远超范围
        if (r > opt.width + opt.height) break;
        continue;
      }
      if (opt.bounded && Math.abs(spot.y) + s.h / 2 > halfH) {
        if (r > opt.width + opt.height) break;
        continue;
      }
      const cand = { ...spot, ...s };
      if (placed.some((p) => overlaps(cand, p, gap))) continue;
      found = spot;
      placed.push(cand);
    }
    out.push(found);
  }
  return out;
}

/** 所有已排好的标签占的高度（不限高度时用来定云的高度） */
export function cloudExtent(sizes: CloudSize[], spots: (CloudSpot | null)[]): { top: number; bottom: number } {
  let top = 0;
  let bottom = 0;
  spots.forEach((p, i) => {
    if (!p) return;
    top = Math.min(top, p.y - sizes[i].h / 2);
    bottom = Math.max(bottom, p.y + sizes[i].h / 2);
  });
  return { top, bottom };
}
