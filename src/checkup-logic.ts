/* 库体检里的纯计算：断链修复建议、链接改写、同名笔记、未引用附件、孤立笔记过滤。不依赖 Obsidian API，便于单元测试。 */

/** 路径去掉 .md、取文件名 */
export function baseName(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.replace(/\.md$/i, "");
}

/** 比较用的名字：小写、去掉空白和常见分隔符，“RAG 代码落地-重构版”和“RAG代码落地-重构版”算同一个 */
export function looseKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s_\-—–·・.,，。:：()（）[\]【】]+/g, "");
}

export interface LinkSuggestion {
  /** 断链里写的名字（可能带路径），原样 */
  name: string;
  /** 建议改成指向的笔记路径 */
  target: string;
  /** exact：文件名完全一样，只是路径变了；loose：只差空格、大小写或分隔符 */
  kind: "exact" | "loose";
}

/**
 * 断链修复建议：只在能唯一确定时给出。
 * 1. 断链名去掉路径后，和某篇笔记的文件名完全相同（笔记被移动过）。
 * 2. 否则，去掉空格、大小写和分隔符后只有一篇笔记对得上。
 * 有两篇以上候选时不猜，返回 null。
 */
export function suggestTarget(name: string, notePaths: string[]): LinkSuggestion | null {
  const clean = name.replace(/\\$/, "").trim();
  const wanted = baseName(clean);
  if (!wanted) return null;
  const exact = notePaths.filter((p) => baseName(p) === wanted);
  if (exact.length === 1) return { name, target: exact[0], kind: "exact" };
  if (exact.length > 1) {
    // 断链里带了路径时，用路径的末尾几段再挑一次
    const tail = clean.toLowerCase();
    const byTail = exact.filter((p) => p.toLowerCase().replace(/\.md$/, "").endsWith(tail));
    return byTail.length === 1 ? { name, target: byTail[0], kind: "exact" } : null;
  }
  const key = looseKey(wanted);
  if (key.length < 2) return null;
  const loose = notePaths.filter((p) => looseKey(baseName(p)) === key);
  return loose.length === 1 ? { name, target: loose[0], kind: "loose" } : null;
}

/** 链接文字里要写的目标：同名笔记只有一篇时写文件名，否则写不带 .md 的完整路径 */
export function linkText(target: string, notePaths: string[]): string {
  const name = baseName(target);
  const same = notePaths.filter((p) => baseName(p) === name).length;
  return same > 1 ? target.replace(/\.md$/i, "") : name;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 把文本里指向 from 的 [[链接]] 改成指向 to：保留 ! 嵌入、#标题、^块、|别名，以及表格里转义的 \|。
 * from 按 Obsidian 的规则比较：不区分大小写，可带可不带 .md。返回新文本和改了几处。
 */
export function rewriteLinks(text: string, from: string, to: string): { text: string; count: number } {
  const target = escapeRe(from.replace(/\\$/, "").replace(/\.md$/i, ""));
  // [[ 目标 (.md)? (#… 或 ^…)? (\\?|别名)? ]]
  const re = new RegExp(`(!?\\[\\[)\\s*${target}(?:\\.md)?\\s*((?:[#^][^\\]|\\\\]*)?)(\\\\?\\|[^\\]]*)?(\\]\\])`, "gi");
  let count = 0;
  const out = text.replace(re, (_m, open: string, sub: string, alias: string | undefined, close: string) => {
    count++;
    return `${open}${to}${sub}${alias ?? ""}${close}`;
  });
  return { text: out, count };
}

/** 同名笔记：文件名相同（不区分大小写）、在不同文件夹的几篇 */
export function sameNameGroups(notePaths: string[]): string[][] {
  const by = new Map<string, string[]>();
  for (const p of notePaths) {
    const k = baseName(p).toLowerCase();
    const list = by.get(k);
    if (list) list.push(p);
    else by.set(k, [p]);
  }
  return [...by.values()].filter((g) => g.length > 1).map((g) => g.sort()).sort((a, b) => a[0].localeCompare(b[0]));
}

/** 不是笔记、也不是 Obsidian 自己的文件：图片、PDF、音视频等附件 */
const ATTACHMENT_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|heic|pdf|mp3|m4a|wav|ogg|flac|mp4|mov|webm|mkv|docx?|xlsx?|pptx?|zip|txt|csv)$/i;

export function isAttachment(path: string): boolean {
  return ATTACHMENT_EXT.test(path);
}

/** 没有被任何笔记链接或嵌入的附件（referenced 是 resolvedLinks 里出现过的所有目标路径） */
export function unusedAttachments(files: string[], referenced: Set<string>): string[] {
  return files.filter((p) => isAttachment(p) && !referenced.has(p)).sort();
}

/** 在忽略的文件夹（含子文件夹）里 */
export function inFolders(path: string, folders: string[]): boolean {
  return folders.some((f) => f && (path === f || path.startsWith(f + "/")));
}
