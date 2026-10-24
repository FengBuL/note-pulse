/* 图表样式：同一份数据可以换不同画法。样式选择存在设置里，随库同步。纯类型和函数，不依赖 Obsidian API。 */

/** 写作趋势：柱状 / 折线 / 曲线 / 面积 */
export type TrendStyle = "bar" | "line" | "curve" | "area";
/** 写作节奏：柱状 / 折线 / 面积 */
export type RhythmStyle = "bar" | "line" | "area";
/** 文件夹构成：堆叠条 / 环形图 / 列表 */
export type MixStyle = "stack" | "donut" | "list";
/** 标签排行：条形 / 标签云 */
export type TagStyle = "bars" | "cloud";
/** 笔记长度分布：柱状 / 面积 */
export type LengthStyle = "bar" | "area";

export interface ChartStyles {
  trend: TrendStyle;
  rhythm: RhythmStyle;
  mix: MixStyle;
  tags: TagStyle;
  lengths: LengthStyle;
}

export const DEFAULT_CHART_STYLES: ChartStyles = { trend: "bar", rhythm: "bar", mix: "stack", tags: "bars", lengths: "bar" };

export const TREND_STYLES: TrendStyle[] = ["bar", "line", "curve", "area"];
export const RHYTHM_STYLES: RhythmStyle[] = ["bar", "line", "area"];
export const MIX_STYLES: MixStyle[] = ["stack", "donut", "list"];
export const TAG_STYLES: TagStyle[] = ["bars", "cloud"];
export const LENGTH_STYLES: LengthStyle[] = ["bar", "area"];

/** 读到的样式可能来自别的版本或被手改：不认识的换成默认 */
export function sanitizeChartStyles(raw: unknown): ChartStyles {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback);
  return {
    trend: pick(r.trend, TREND_STYLES, DEFAULT_CHART_STYLES.trend),
    rhythm: pick(r.rhythm, RHYTHM_STYLES, DEFAULT_CHART_STYLES.rhythm),
    mix: pick(r.mix, MIX_STYLES, DEFAULT_CHART_STYLES.mix),
    tags: pick(r.tags, TAG_STYLES, DEFAULT_CHART_STYLES.tags),
    lengths: pick(r.lengths, LENGTH_STYLES, DEFAULT_CHART_STYLES.lengths),
  };
}
