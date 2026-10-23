/* 界面语言：中文或英文。文案在用到的地方成对写出 L("中文", "English")，改一处就能看到两种语言。 */
import { moment } from "obsidian";

export type LanguagePref = "auto" | "zh" | "en";

let zh = true;

/** Obsidian 自己的界面语言是不是中文（简体、繁体都算） */
export function obsidianIsChinese(): boolean {
  let l = "en";
  try {
    l = moment.locale() || document.documentElement.lang || "en";
  } catch {
    l = "en";
  }
  return l.toLowerCase().startsWith("zh");
}

/** auto 跟随 Obsidian 的界面语言 */
export function setLanguage(pref: LanguagePref): void {
  zh = pref === "zh" || (pref !== "en" && obsidianIsChinese());
}

export function isZh(): boolean {
  return zh;
}

/** 按当前语言取一条文案 */
export function L(zhText: string, enText: string): string {
  return zh ? zhText : enText;
}

/** 英文复数：1 note / 2 notes */
export function plural(n: number, one: string, many = one + "s"): string {
  return n === 1 ? one : many;
}

const ZH_WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const EN_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** 星期几的短名：中文“一”，英文 "Mon"（d 为 Date.getDay()，0 是周日） */
export function weekdayShort(d: number): string {
  return zh ? ZH_WEEKDAYS[d] : EN_WEEKDAYS[d];
}

/** 最窄的写法（本周七天的小格子）：中文“一”，英文 "M" */
export function weekdayLetter(d: number): string {
  return zh ? ZH_WEEKDAYS[d] : "SMTWTFS"[d];
}

/** 完整写法：中文“周一”，英文 "Mon" */
export function weekdayName(d: number): string {
  return zh ? `周${ZH_WEEKDAYS[d]}` : EN_WEEKDAYS[d];
}

const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 月份短名：中文“10月”，英文 "Oct"（m 为 0–11） */
export function monthShort(m: number): string {
  return zh ? `${m + 1}月` : EN_MONTHS[m];
}

/** 月日：中文“10月24日”，英文 "Oct 24" */
export function monthDay(d: Date): string {
  return zh ? `${d.getMonth() + 1}月${d.getDate()}日` : `${EN_MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** 年月日：中文“2026年10月24日”，英文 "Oct 24, 2026" */
export function fullDate(d: Date): string {
  return zh ? `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日` : `${EN_MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

export type UnitKind = "words" | "notes" | "days" | "tasks" | "links" | "passages" | "folders" | "tags";
const ZH_UNITS: Record<UnitKind, string> = { words: "字", notes: "篇", days: "天", tasks: "项", links: "个", passages: "段", folders: "个", tags: "个" };
const EN_UNITS: Record<UnitKind, [string, string]> = {
  words: ["word", "words"],
  notes: ["note", "notes"],
  days: ["day", "days"],
  tasks: ["task", "tasks"],
  links: ["link", "links"],
  passages: ["passage", "passages"],
  folders: ["folder", "folders"],
  tags: ["tag", "tags"],
};

/** 数量单位：中文“字 / 篇 / 天”，英文按数量分单复数 */
export function unit(kind: UnitKind, n = 2): string {
  return zh ? ZH_UNITS[kind] : EN_UNITS[kind][n === 1 ? 0 : 1];
}

/** “数字 + 单位”连写成一句：中文“12 篇”，英文 "12 notes" */
export function count(n: number | string, kind: UnitKind): string {
  return `${n} ${unit(kind, typeof n === "number" ? n : 2)}`;
}
