import { App, CachedMetadata, TFile, getAllTags } from "obsidian";
import { DashboardSettings, normalizeFolder, splitList } from "./settings";

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
  return d;
}

/* ---------------- 字数统计 ---------------- */

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\u{20000}-\u{2fa1f}]/gu;
const WORD_RE = /[A-Za-z0-9\u00C0-\u024F\u0400-\u04FF]+(?:['’.\-][A-Za-z0-9\u00C0-\u024F\u0400-\u04FF]+)*/g;

export function stripMarkdown(text: string): string {
  let t = text;
  // frontmatter
  t = t.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/, "");
  // 注释
  t = t.replace(/%%[\s\S]*?%%/g, " ");
  t = t.replace(/<!--[\s\S]*?-->/g, " ");
  // 代码块
  t = t.replace(/```[\s\S]*?```/g, " ");
  t = t.replace(/~~~[\s\S]*?~~~/g, " ");
  // 数学块
  t = t.replace(/\$\$[\s\S]*?\$\$/g, " ");
  // 嵌入
  t = t.replace(/!\[\[[^\]]*\]\]/g, " ");
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  // wiki 链接 [[a|b]] -> b, [[a]] -> a
  t = t.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2");
  t = t.replace(/\[\[([^\]]*)\]\]/g, "$1");
  // markdown 链接 [text](url) -> text
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // 裸 URL
  t = t.replace(/https?:\/\/\S+/g, " ");
  // HTML 标签
  t = t.replace(/<[^>]+>/g, " ");
  // 任务/列表标记、标题、引用、强调等符号
  t = t.replace(/^\s*[-*+]\s+\[.\]\s*/gm, " ");
  t = t.replace(/[#*_>~=`|\[\]()^]/g, " ");
  return t;
}

export function countWords(text: string): number {
  const t = stripMarkdown(text);
  const cjk = t.match(CJK_RE);
  const cjkCount = cjk ? cjk.length : 0;
  const rest = t.replace(CJK_RE, " ");
  const latin = rest.match(WORD_RE);
  return cjkCount + (latin ? latin.length : 0);
}

/* ---------------- 数据结构 ---------------- */

export interface ContentInfo {
  mtime: number;
  size: number;
  words: number;
  /** 行号 -> 任务行原文 */
  taskLines: Record<number, string>;
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
  folder: string;
  tags: string[];
  links: number;
}

export interface VaultStats {
  generatedAt: number;
  durationMs: number;
  totalNotes: number;
  totalWords: number;
  created7: number;
  created30: number;
  modified7: number;
  modified30: number;
  totalLinks: number;
  uniqueTags: number;
  tagOccurrences: number;
  files: FileStat[];
  /** 日期 -> 当日写作字数（按设置的模式） */
  dayWords: Record<string, number>;
  /** 日期 -> 当日修改过的笔记 */
  dayModified: Record<string, TFile[]>;
  dayCreated: Record<string, number>;
  dailyNotes: Record<string, TFile>;
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
  };
  folders: { folder: string; notes: number; words: number }[];
}

export interface PersistentData {
  wordLog: Record<string, number>;
  fileWords: Record<string, number>;
  logInitialized: boolean;
}

/* ---------------- 工具 ---------------- */

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

/* ---------------- 主统计 ---------------- */

export async function computeStats(
  app: App,
  settings: DashboardSettings,
  contentCache: Map<string, ContentInfo>,
  pdata: PersistentData,
  onProgress?: (done: number, total: number) => void
): Promise<VaultStats> {
  const t0 = Date.now();
  const excluded = splitList(settings.excludedFolders).map(normalizeFolder);
  const createdFields = splitList(settings.createdFields);
  const dailyFolder = normalizeFolder(settings.dailyNoteFolder);

  const files = app.vault.getMarkdownFiles().filter((f) => !isExcluded(f.path, excluded));
  const included = new Set(files.map((f) => f.path));

  // 1. 读取内容（只读取变化过的文件，限制并发）
  const toRead = files.filter((f) => {
    const c = contentCache.get(f.path);
    return !c || c.mtime !== f.stat.mtime || c.size !== f.stat.size;
  });
  let doneCount = 0;
  const total = toRead.length;
  if (onProgress && total > 0) onProgress(0, total);
  await runPool(toRead, 8, async (f) => {
    const text = await app.vault.cachedRead(f);
    const taskLines: Record<number, string> = {};
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.indexOf("[") >= 0 && TASK_LINE_RE.test(l)) taskLines[i] = l;
    }
    contentCache.set(f.path, {
      mtime: f.stat.mtime,
      size: f.stat.size,
      words: countWords(text),
      taskLines,
    });
    doneCount++;
    if (onProgress && (doneCount % 50 === 0 || doneCount === total)) onProgress(doneCount, total);
  });
  // 清理已删除/已排除文件
  for (const k of Array.from(contentCache.keys())) if (!included.has(k)) contentCache.delete(k);

  const now = Date.now();
  const today = startOfDay(now);
  const todayKey = dayKey(today);
  const d7 = addDays(today, -6).getTime();
  const d30 = addDays(today, -29).getTime();

  // 2. 每日新增字数记录（delta 模式）
  const logWasInit = pdata.logInitialized;
  for (const f of files) {
    const c = contentCache.get(f.path);
    if (!c) continue;
    const prev = pdata.fileWords[f.path];
    if (logWasInit) {
      if (prev === undefined) {
        // 新文件：按创建日计入
        const k = f.stat.ctime >= addDays(today, -1).getTime() ? dayKey(f.stat.ctime) : null;
        if (k && c.words > 0) pdata.wordLog[k] = (pdata.wordLog[k] || 0) + c.words;
      } else if (c.words > prev) {
        pdata.wordLog[todayKey] = (pdata.wordLog[todayKey] || 0) + (c.words - prev);
      }
    }
    pdata.fileWords[f.path] = c.words;
  }
  for (const k of Object.keys(pdata.fileWords)) if (!included.has(k)) delete pdata.fileWords[k];
  pdata.logInitialized = true;

  // 3. 遍历元数据
  const fileStats: FileStat[] = [];
  const dayModifiedWords: Record<string, number> = {};
  const dayModified: Record<string, TFile[]> = {};
  const dayCreated: Record<string, number> = {};
  const dailyNotes: Record<string, TFile> = {};
  const tagCount = new Map<string, number>();
  const folderNotes = new Map<string, number>();
  const folderWords = new Map<string, number>();
  const folderTasks = new Map<string, GroupStat>();
  const noteTasks: GroupStat[] = [];
  const overdue: TaskInfo[] = [];
  const dueSoon: TaskInfo[] = [];
  let tDone = 0,
    tPending = 0,
    tCancelled = 0;
  let totalWords = 0,
    totalLinks = 0,
    tagOcc = 0;
  let c7 = 0,
    c30 = 0,
    m7 = 0,
    m30 = 0;
  const soonLimit = addDays(today, 7).getTime();

  for (const f of files) {
    const cache: CachedMetadata | null = app.metadataCache.getFileCache(f);
    const content = contentCache.get(f.path);
    const words = content ? content.words : 0;
    const fm = cache?.frontmatter as Record<string, unknown> | undefined;

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
    if (created >= d7) c7++;
    if (created >= d30) c30++;
    if (mtime >= d7) m7++;
    if (mtime >= d30) m30++;
    const ck = dayKey(created);
    dayCreated[ck] = (dayCreated[ck] || 0) + 1;
    const mk = dayKey(mtime);
    dayModifiedWords[mk] = (dayModifiedWords[mk] || 0) + words;
    (dayModified[mk] = dayModified[mk] || []).push(f);

    // 日记
    if (/^\d{4}-\d{2}-\d{2}$/.test(f.basename)) {
      const inFolder = !dailyFolder || f.path.startsWith(dailyFolder + "/");
      const d = parseDateStr(f.basename);
      if (inFolder && d) dailyNotes[dayKey(d)] = f;
    }

    totalWords += words;

    // 文件夹
    const folder = f.path.includes("/") ? f.path.split("/")[0] : "(根目录)";
    inc(folderNotes, folder);
    inc(folderWords, folder, words);

    // 标签
    const tags = cache ? Array.from(new Set((getAllTags(cache) || []).map((t) => t.toLowerCase()))) : [];
    for (const t of tags) {
      inc(tagCount, t);
      tagOcc++;
    }

    // 链接
    const links = (cache?.links?.length || 0) + (cache?.embeds?.length || 0);
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

    fileStats.push({ file: f, created, mtime, words, folder, tags, links });
  }

  // 4. 链接统计
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
    .map(([p, count]) => ({ file: byPath.get(p) as TFile, count }))
    .filter((x) => !!x.file);
  const orphans = files.filter((f) => !inbound.has(f.path) && !hasOutbound.has(f.path));
  const unresolvedMap = new Map<string, number>();
  let unresolvedCount = 0;
  for (const src of Object.keys(unresolved)) {
    if (!included.has(src)) continue;
    for (const [name, n] of Object.entries(unresolved[src])) {
      unresolvedCount += n;
      inc(unresolvedMap, name, n);
    }
  }

  // 5. 写作量（热力图）
  const dayWords = settings.heatmapMode === "delta" ? { ...pdata.wordLog } : dayModifiedWords;

  overdue.sort((a, b) => (a.due || "").localeCompare(b.due || ""));
  dueSoon.sort((a, b) => (a.due || "").localeCompare(b.due || ""));

  const folders = Array.from(folderNotes.entries())
    .map(([folder, notes]) => ({ folder, notes, words: folderWords.get(folder) || 0 }))
    .sort((a, b) => b.notes - a.notes);

  return {
    generatedAt: now,
    durationMs: Date.now() - t0,
    totalNotes: files.length,
    totalWords,
    created7: c7,
    created30: c30,
    modified7: m7,
    modified30: m30,
    totalLinks,
    uniqueTags: tagCount.size,
    tagOccurrences: tagOcc,
    files: fileStats,
    dayWords,
    dayModified,
    dayCreated,
    dailyNotes,
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
      topUnresolved: sortedEntries(unresolvedMap, 10),
    },
    folders,
  };
}
