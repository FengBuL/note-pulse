import { App, CachedMetadata, TFile, getAllTags } from "obsidian";
import { countWords } from "./count";
import { DashboardSettings, normalizeFolder, splitList } from "./settings";

/** 内容少于这个字数的日记（多半是空模板）不算打卡 */
export const DAILY_MIN_WORDS = 10;

/* ---------------- 日期工具 ---------------- */

export const DAY_MS = 24 * 60 * 60 * 1000;

export function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

export function dayKey(d: Date | number): string {
  const x = typeof d === "number" ? new Date(d) : d;
  return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;
}

export function startOfDay(d: Date | number): Date {
  const x = new Date(typeof d === "number" ? d : d.getTime());
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + n);
  return x;
}

export function parseDateStr(s: string): Date | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s.trim());
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (isNaN(d.getTime())) return null;
  // 拒绝 2026-02-31 这类会被自动进位的非法日期
  if (d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) return null;
  return d;
}

/* ---------------- 字数统计 ---------------- */

/* ---------------- 数据结构 ---------------- */

export interface ContentInfo {
  mtime: number;
  size: number;
  words: number;
  /** 行号 -> 任务行原文 */
  taskLines: Record<number, string>;
  /** 上次计入“每日新增字数”时的字数 */
  logged?: number;
}

export interface TaskInfo {
  file: TFile;
  line: number;
  text: string;
  status: "done" | "pending" | "cancelled";
  due?: string;
}

export interface GroupStat {
  key: string;
  file?: TFile;
  total: number;
  done: number;
  pending: number;
}

export interface FileStat {
  file: TFile;
  created: number;
  mtime: number;
  words: number;
  /** 计入写作统计的字数：采集文件夹和（开启排除时的）超大笔记为 0 */
  writeWords: number;
  /** 位于采集 / 剪藏文件夹 */
  collected: boolean;
  /** 字数超过超大笔记阈值 */
  big: boolean;
  folder: string;
  tags: string[];
  links: number;
  /** 图片 / 附件 / 笔记嵌入的数量 */
  embeds?: number;
}

export type HintKind = "folder" | "spike" | "onboarding";

export interface Hint {
  key: string;
  kind: HintKind;
  /** folder：文件夹名；spike：日期 */
  target?: string;
  count?: number;
  total?: number;
}

export interface VaultStats {
  generatedAt: number;
  durationMs: number;
  totalNotes: number;
  totalWords: number;
  /** 计入写作统计的总字数 */
  writeWordsTotal: number;
  created7: number;
  created30: number;
  modified7: number;
  modified30: number;
  totalLinks: number;
  uniqueTags: number;
  tagOccurrences: number;
  files: FileStat[];
  /** 日期 -> 当日写作字数（按设置的模式，已排除超大 / 采集笔记） */
  dayWords: Record<string, number>;
  /** 智能模式下，这个日期之前的数据是按修改日估算的；其它模式为 null */
  estimatedBefore: string | null;
  /** 开始实测记录的日期 */
  logStartDay: string | null;
  /** 日期 -> 当日修改过的笔记 */
  dayModified: Record<string, TFile[]>;
  /** 日期 -> 当日新建的笔记数（不含采集文件夹） */
  dayCreated: Record<string, number>;
  dailyNotes: Record<string, TFile>;
  /** 因“超大”或“采集”而不计入写作字数的笔记 */
  outliers: { count: number; words: number; top: FileStat[]; threshold: number; mode: "exclude" | "off" };
  hints: Hint[];
  tasks: {
    total: number;
    done: number;
    pending: number;
    cancelled: number;
    overdue: TaskInfo[];
    dueSoon: TaskInfo[];
    byFolder: GroupStat[];
    byNote: GroupStat[];
  };
  tags: [string, number][];
  links: {
    topLinked: { file: TFile; count: number }[];
    orphans: TFile[];
    unresolvedCount: number;
    topUnresolved: [string, number][];
    /** 断链名 -> 第一篇出现它的笔记路径（新建笔记时按 Obsidian 的规则决定放在哪） */
    unresolvedSource?: Record<string, string>;
  };
  folders: { folder: string; notes: number; words: number }[];
}

export interface PersistentData {
  /** 日期 -> 当日新增字数（普通笔记）。1.7.0 起只是本机的记录，保存到 devices/<设备 ID>.json */
  wordLog: Record<string, number>;
  /** 日期 -> 当日新增字数（超大笔记，默认不显示），本机 */
  wordLogBig: Record<string, number>;
  /** 1.7.0 之前 data.json 里的记录（所有设备混在一起）：只读，参与相加 */
  legacyLog?: Record<string, number>;
  legacyLogBig?: Record<string, number>;
  /** 其它设备的记录：只读，参与相加 */
  otherLogs?: { wordLog: Record<string, number>; wordLogBig: Record<string, number> }[];
  /**
   * 本机编辑器里改动过、增量还没记的笔记路径 -> 最后一次按键的时间。设置了它，就只有这些笔记的增量算本机写作，
   * 其余的变化（同步进来的、外部程序写的）只更新基线。为 undefined 时按旧办法：所有变化都算。
   */
  localEdits?: Map<string, number>;
  logInitialized: boolean;
  /** 开始实测记录的日期（YYYY-MM-DD） */
  logStartDay: string;
  /** 旧版本（≤1.0.0）保存在 data.json 里的逐文件字数，仅用于一次性迁移 */
  legacyFileWords?: Record<string, number>;
  /** 缓存文件丢失时，只补齐“已记录字数”而不计入新增 */
  seedOnly?: boolean;
  /** 内存标记：data.json 有待保存的改动 */
  dirty?: boolean;
  /** 内存标记：cache.json 有待保存的改动 */
  cacheDirty?: boolean;
  /** 内存标记：本机设备文件有待保存的改动 */
  deviceDirty?: boolean;
}

/* ---------------- 工具 ---------------- */

const yieldToUi = () => new Promise<void>((r) => window.setTimeout(r, 0));

async function runPool<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers: Promise<void>[] = [];
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        await fn(items[idx]);
      } catch (e) {
        console.error("[note-pulse] 读取失败", e);
      }
    }
  };
  for (let k = 0; k < Math.min(limit, items.length); k++) workers.push(worker());
  await Promise.all(workers);
}

const TASK_LINE_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[(.)\]\s?(.*)$/;

function normalizeValues(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  const arr = Array.isArray(v) ? v : [v];
  const out: string[] = [];
  for (const item of arr) {
    if (item === null || item === undefined) continue;
    let s = String(item).trim();
    s = s.replace(/^\[\[/, "").replace(/\]\]$/, "");
    if (s.includes("|")) s = s.split("|").pop() || s;
    s = s.replace(/^#/, "").trim();
    if (s) out.push(s);
  }
  return out;
}

function getField(fm: Record<string, unknown> | undefined, fields: string[]): string[] {
  if (!fm) return [];
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(fm, f)) {
      const vals = normalizeValues(fm[f]);
      if (vals.length) return vals;
    }
    // 大小写不敏感匹配
    const lower = f.toLowerCase();
    for (const k of Object.keys(fm)) {
      if (k.toLowerCase() === lower) {
        const vals = normalizeValues(fm[k]);
        if (vals.length) return vals;
      }
    }
  }
  return [];
}

function sortedEntries(m: Map<string, number>, limit?: number): [string, number][] {
  const arr = Array.from(m.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return limit ? arr.slice(0, limit) : arr;
}

function inc(m: Map<string, number>, k: string, n = 1) {
  m.set(k, (m.get(k) || 0) + n);
}

export function isExcluded(path: string, excluded: string[]): boolean {
  for (const f of excluded) {
    if (!f) continue;
    if (path === f || path.startsWith(f + "/")) return true;
  }
  return false;
}

function folderLists(settings: DashboardSettings) {
  return {
    excluded: splitList(settings.excludedFolders).map(normalizeFolder),
    clipping: splitList(settings.clippingFolders).map(normalizeFolder),
  };
}

/** 被统计的 markdown 文件（已去掉排除文件夹） */
export function includedFiles(app: App, settings: DashboardSettings): TFile[] {
  const { excluded } = folderLists(settings);
  return app.vault.getMarkdownFiles().filter((f) => !isExcluded(f.path, excluded));
}

/** 这次变化是不是在本机编辑器里打出来的（没开多设备记录时一律算） */
function typedHere(pdata: PersistentData, path: string): boolean {
  return !pdata.localEdits || pdata.localEdits.has(path);
}

/** 所有设备的记录相加：1.7.0 之前的旧记录 + 本机 + 其它设备 */
export function mergedWordLog(pdata: PersistentData, includeBig: boolean): Record<string, number> {
  const parts = [pdata.legacyLog || {}, pdata.wordLog, ...(pdata.otherLogs || []).map((o) => o.wordLog)];
  if (includeBig) parts.push(pdata.legacyLogBig || {}, pdata.wordLogBig || {}, ...(pdata.otherLogs || []).map((o) => o.wordLogBig));
  const out: Record<string, number> = {};
  for (const log of parts) for (const [k, v] of Object.entries(log)) out[k] = (out[k] || 0) + v;
  return out;
}

function addLog(pdata: PersistentData, big: boolean, day: string, n: number) {
  const target = big ? (pdata.wordLogBig = pdata.wordLogBig || {}) : pdata.wordLog;
  target[day] = (target[day] || 0) + n;
  pdata.deviceDirty = true;
}

/**
 * 读取变化过的文件并更新内容缓存，同时把字数增量记入“每日新增字数”。
 * 只会读取 mtime / size 变化过的文件；看板关着时也会被调用（只处理被修改的文件）。
 */
export async function syncContent(
  app: App,
  files: TFile[],
  settings: DashboardSettings,
  cache: Map<string, ContentInfo>,
  pdata: PersistentData,
  onProgress?: (done: number, total: number) => void
): Promise<void> {
  const { clipping } = folderLists(settings);
  const readStart = Date.now();
  const toRead = files.filter((f) => {
    const c = cache.get(f.path);
    return !c || c.mtime !== f.stat.mtime || c.size !== f.stat.size;
  });
  let doneCount = 0;
  const total = toRead.length;
  if (onProgress && total > 0) onProgress(0, total);
  let lastYield = Date.now();
  await runPool(toRead, 8, async (f) => {
    const text = await app.vault.cachedRead(f);
    const taskLines: Record<number, string> = {};
    if (text.indexOf("[") >= 0) {
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (l.indexOf("[") >= 0 && TASK_LINE_RE.test(l)) taskLines[i] = l;
      }
    }
    const old = cache.get(f.path);
    cache.set(f.path, { mtime: f.stat.mtime, size: f.stat.size, words: countWords(text), taskLines, logged: old?.logged });
    pdata.cacheDirty = true;
    doneCount++;
    if (onProgress && (doneCount % 50 === 0 || doneCount === total)) onProgress(doneCount, total);
    // 大仓库首次统计时，每隔一小段时间把主线程还给界面
    if (Date.now() - lastYield > 16) {
      await yieldToUi();
      lastYield = Date.now();
    }
  });

  // 每日新增字数
  const now = Date.now();
  const todayKey = dayKey(now);
  const first = !pdata.logInitialized;
  if (first) {
    pdata.logInitialized = true;
    pdata.logStartDay = todayKey;
    pdata.dirty = true;
  }
  if (!pdata.logStartDay) {
    const days = Object.keys(pdata.wordLog).sort();
    pdata.logStartDay = days.length ? days[0] : todayKey;
    pdata.dirty = true;
  }
  const startDay = pdata.logStartDay;
  const legacy = pdata.legacyFileWords;
  for (const f of files) {
    const c = cache.get(f.path);
    if (!c) continue;
    let prev = c.logged;
    if (prev === undefined && legacy && legacy[f.path] !== undefined) prev = legacy[f.path];
    if (prev === undefined && (first || pdata.seedOnly)) prev = c.words; // 初次运行 / 缓存丢失：只建立基线
    const collected = isExcluded(f.path, clipping);
    if (prev === undefined) {
      // 启用之后才出现的新文件：按创建日计入
      const day = dayKey(Math.min(f.stat.ctime, now));
      if (!collected && day >= startDay && c.words > 0 && typedHere(pdata, f.path)) addLog(pdata, c.words > settings.outlierWords, day, c.words);
    } else if (c.words > prev) {
      const d = dayKey(Math.min(f.stat.mtime, now));
      const day = d < startDay ? startDay : d;
      if (!collected && typedHere(pdata, f.path)) addLog(pdata, c.words > settings.outlierWords, day, c.words - prev);
    }
    if (c.logged !== c.words) {
      c.logged = c.words;
      pdata.cacheDirty = true;
    }
  }
  // 这一轮读过的文件，本机的编辑都已经记过了；之后再有变化要重新看是不是本机打的字
  // 读取开始之后又打了字的保留标记，下一轮再算
  if (pdata.localEdits) {
    for (const f of toRead) {
      const t = pdata.localEdits.get(f.path);
      if (t !== undefined && t < readStart) pdata.localEdits.delete(f.path);
    }
  }
}

/* ---------------- 主统计 ---------------- */

export async function computeStats(
  app: App,
  settings: DashboardSettings,
  contentCache: Map<string, ContentInfo>,
  pdata: PersistentData,
  onProgress?: (done: number, total: number) => void
): Promise<VaultStats> {
  const t0 = Date.now();
  const { clipping } = folderLists(settings);
  const createdFields = splitList(settings.createdFields);
  const dailyFolder = normalizeFolder(settings.dailyNoteFolder);
  const threshold = Math.max(1000, settings.outlierWords || 20000);
  const excludeBig = settings.outlierMode === "exclude";

  const files = includedFiles(app, settings);
  const included = new Set(files.map((f) => f.path));

  // 1. 读取内容 + 记录每日新增
  await syncContent(app, files, settings, contentCache, pdata, onProgress);
  if (pdata.legacyFileWords || pdata.seedOnly) pdata.dirty = true;
  pdata.legacyFileWords = undefined;
  pdata.seedOnly = false;
  // 清理已删除/已排除文件
  for (const k of Array.from(contentCache.keys())) {
    if (!included.has(k)) {
      contentCache.delete(k);
      pdata.cacheDirty = true;
    }
  }

  const now = Date.now();
  const today = startOfDay(now);
  const d7 = addDays(today, -6).getTime();
  const d30 = addDays(today, -29).getTime();

  // 2. 遍历元数据
  const fileStats: FileStat[] = [];
  const dayModifiedWords: Record<string, number> = {};
  const dayModified: Record<string, TFile[]> = {};
  const dayCreated: Record<string, number> = {};
  const dailyNotes: Record<string, TFile> = {};
  const tagCount = new Map<string, number>();
  const folderNotes = new Map<string, number>();
  const folderWords = new Map<string, number>();
  const folderBig = new Map<string, number>();
  const folderTasks = new Map<string, GroupStat>();
  const noteTasks: GroupStat[] = [];
  const overdue: TaskInfo[] = [];
  const dueSoon: TaskInfo[] = [];
  let tDone = 0,
    tPending = 0,
    tCancelled = 0;
  let totalWords = 0,
    writeTotal = 0,
    totalLinks = 0,
    tagOcc = 0;
  let c7 = 0,
    c30 = 0,
    m7 = 0,
    m30 = 0;
  const soonLimit = addDays(today, 7).getTime();
  const outlierFiles: FileStat[] = [];

  for (const f of files) {
    const cache: CachedMetadata | null = app.metadataCache.getFileCache(f);
    const content = contentCache.get(f.path);
    const words = content ? content.words : 0;
    const fm: Record<string, unknown> | undefined = cache?.frontmatter;
    const collected = isExcluded(f.path, clipping);
    const big = words > threshold;
    const writeWords = collected || (excludeBig && big) ? 0 : words;

    // 创建日期
    let created = f.stat.ctime;
    for (const v of getField(fm, createdFields)) {
      const d = parseDateStr(v);
      if (d) {
        created = d.getTime();
        break;
      }
    }
    const mtime = f.stat.mtime;
    if (!collected) {
      if (created >= d7) c7++;
      if (created >= d30) c30++;
      const ck = dayKey(created);
      dayCreated[ck] = (dayCreated[ck] || 0) + 1;
    }
    if (mtime >= d7) m7++;
    if (mtime >= d30) m30++;
    const mk = dayKey(mtime);
    dayModifiedWords[mk] = (dayModifiedWords[mk] || 0) + writeWords;
    (dayModified[mk] = dayModified[mk] || []).push(f);

    // 日记（内容过少的空模板不算）
    if (!collected && !(excludeBig && big) && /^\d{4}-\d{2}-\d{2}$/.test(f.basename) && words >= DAILY_MIN_WORDS) {
      const inFolder = !dailyFolder || f.path.startsWith(dailyFolder + "/");
      const d = parseDateStr(f.basename);
      if (inFolder && d) dailyNotes[dayKey(d)] = f;
    }

    totalWords += words;
    writeTotal += writeWords;

    // 文件夹
    const folder = f.path.includes("/") ? f.path.split("/")[0] : "(根目录)";
    inc(folderNotes, folder);
    inc(folderWords, folder, words);
    if (big) inc(folderBig, folder);

    // 标签
    const tags = cache ? Array.from(new Set((getAllTags(cache) || []).map((t) => t.toLowerCase()))) : [];
    for (const t of tags) {
      inc(tagCount, t);
      tagOcc++;
    }

    // 链接（只算笔记间的链接，不含图片 / 附件嵌入）
    const links = cache?.links?.length || 0;
    totalLinks += links;

    // 任务
    if (cache?.listItems) {
      let nTotal = 0,
        nDone = 0,
        nPending = 0;
      for (const li of cache.listItems) {
        if (li.task === undefined) continue;
        const line = li.position.start.line;
        const raw = content?.taskLines[line] || "";
        const ch = li.task;
        let status: TaskInfo["status"];
        if (ch === "x" || ch === "X") status = "done";
        else if (ch === "-") status = "cancelled";
        else status = "pending";
        if (status === "cancelled") {
          tCancelled++;
          continue;
        }
        nTotal++;
        if (status === "done") {
          nDone++;
          tDone++;
        } else {
          nPending++;
          tPending++;
          const m = /(?:📅|⏳|\[due::|due::)\s*(\d{4}-\d{2}-\d{2})/.exec(raw);
          if (m) {
            const dd = parseDateStr(m[1]);
            const text = raw.replace(TASK_LINE_RE, "$2").trim();
            const info: TaskInfo = { file: f, line, text, status, due: m[1] };
            if (dd && dd.getTime() < today.getTime()) overdue.push(info);
            else if (dd && dd.getTime() <= soonLimit) dueSoon.push(info);
          }
        }
      }
      if (nTotal > 0) {
        noteTasks.push({ key: f.basename, file: f, total: nTotal, done: nDone, pending: nPending });
        const g = folderTasks.get(folder) || { key: folder, total: 0, done: 0, pending: 0 };
        g.total += nTotal;
        g.done += nDone;
        g.pending += nPending;
        folderTasks.set(folder, g);
      }
    }

    const fs: FileStat = { file: f, created, mtime, words, writeWords, collected, big, folder, tags, links, embeds: cache?.embeds?.length || 0 };
    fileStats.push(fs);
    if (words > 0 && writeWords === 0) outlierFiles.push(fs);
  }

  // 3. 链接统计
  const resolved = app.metadataCache.resolvedLinks || {};
  const unresolved = app.metadataCache.unresolvedLinks || {};
  const inbound = new Map<string, number>();
  const hasOutbound = new Set<string>();
  for (const src of Object.keys(resolved)) {
    if (!included.has(src)) continue;
    const targets = resolved[src];
    for (const dst of Object.keys(targets)) {
      if (dst === src) continue;
      if (!included.has(dst)) continue;
      hasOutbound.add(src);
      inbound.set(dst, (inbound.get(dst) || 0) + targets[dst]);
    }
  }
  const byPath = new Map(files.map((f) => [f.path, f] as [string, TFile]));
  const topLinked = Array.from(inbound.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([p, count]) => ({ file: byPath.get(p), count }))
    .filter((x): x is { file: TFile; count: number } => !!x.file);
  const orphans = files.filter((f) => !inbound.has(f.path) && !hasOutbound.has(f.path));
  const unresolvedMap = new Map<string, number>();
  const unresolvedSource: Record<string, string> = {};
  let unresolvedCount = 0;
  for (const src of Object.keys(unresolved)) {
    if (!included.has(src)) continue;
    for (const [name, n] of Object.entries(unresolved[src])) {
      unresolvedCount += n;
      inc(unresolvedMap, name, n);
      if (!(name in unresolvedSource)) unresolvedSource[name] = src;
    }
  }

  // 4. 写作量（热力图 / 打卡）
  const logStart = pdata.logStartDay || dayKey(now);
  const mergedLog = mergedWordLog(pdata, !excludeBig);
  let dayWords: Record<string, number>;
  let estimatedBefore: string | null = null;
  if (settings.heatmapMode === "delta") dayWords = mergedLog;
  else if (settings.heatmapMode === "mtime") dayWords = dayModifiedWords;
  else {
    dayWords = { ...mergedLog };
    for (const [k, v] of Object.entries(dayModifiedWords)) if (k < logStart) dayWords[k] = v;
    estimatedBefore = logStart;
  }

  overdue.sort((a, b) => (a.due || "").localeCompare(b.due || ""));
  dueSoon.sort((a, b) => (a.due || "").localeCompare(b.due || ""));

  const folders = Array.from(folderNotes.entries())
    .map(([folder, notes]) => ({ folder, notes, words: folderWords.get(folder) || 0 }))
    .sort((a, b) => b.notes - a.notes);

  // 5. 提示：疑似采集文件夹、创建日期集中
  const hints: Hint[] = [];
  const dismissed = new Set(settings.dismissedHints || []);
  if (!settings.onboarded) hints.push({ key: "onboarding", kind: "onboarding" });
  const clippingSet = new Set(clipping);
  for (const [folder, n] of folderNotes) {
    if (folder === "(根目录)" || clippingSet.has(folder)) continue;
    const nb = folderBig.get(folder) || 0;
    if (n >= 3 && nb / n >= 0.6 && !dismissed.has("folder:" + folder)) {
      hints.push({ key: "folder:" + folder, kind: "folder", target: folder, count: nb, total: n });
    }
  }
  if (files.length >= 40) {
    let spikeDay = "",
      spikeN = 0;
    for (const [k, n] of Object.entries(dayCreated)) {
      if (n > spikeN) {
        spikeDay = k;
        spikeN = n;
      }
    }
    if (spikeN >= Math.max(20, files.length * 0.25) && !dismissed.has("spike:" + spikeDay)) {
      hints.push({ key: "spike:" + spikeDay, kind: "spike", target: spikeDay, count: spikeN, total: files.length });
    }
  }

  outlierFiles.sort((a, b) => b.words - a.words);
  const outliers = {
    count: outlierFiles.length,
    words: outlierFiles.reduce((a, f) => a + f.words, 0),
    top: outlierFiles.slice(0, 5),
    threshold,
    mode: settings.outlierMode,
  };

  return {
    generatedAt: now,
    durationMs: Date.now() - t0,
    totalNotes: files.length,
    totalWords,
    writeWordsTotal: writeTotal,
    created7: c7,
    created30: c30,
    modified7: m7,
    modified30: m30,
    totalLinks,
    uniqueTags: tagCount.size,
    tagOccurrences: tagOcc,
    files: fileStats,
    dayWords,
    estimatedBefore,
    logStartDay: pdata.logInitialized ? logStart : null,
    dayModified,
    dayCreated,
    dailyNotes,
    outliers,
    hints,
    tasks: {
      total: tDone + tPending,
      done: tDone,
      pending: tPending,
      cancelled: tCancelled,
      overdue,
      dueSoon,
      byFolder: Array.from(folderTasks.values()).sort((a, b) => b.pending - a.pending || b.total - a.total),
      byNote: noteTasks.sort((a, b) => b.pending - a.pending || b.total - a.total),
    },
    tags: sortedEntries(tagCount),
    links: {
      topLinked,
      orphans,
      unresolvedCount,
      topUnresolved: sortedEntries(unresolvedMap, 50),
      unresolvedSource,
    },
    folders,
  };
}

/** 看板、每周目标和报告共用同一个打卡规则。 */
export function isCheckinDay(stats: VaultStats, goal: number, key: string): boolean {
  const words = stats.dayWords[key] || 0;
  return (goal > 0 ? words >= goal : words > 0) || !!stats.dailyNotes[key];
}
