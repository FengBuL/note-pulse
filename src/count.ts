/* 字数统计：纯函数，不依赖 Obsidian API（便于单元测试）。看板统计和“字数属性”共用同一套逻辑。 */

/** 汉字 / 假名按字计数；谚文（韩文）有空格分词，按词计数，所以不放在这里 */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2fa1f}]/gu;
/** 其余文字（拉丁、西里尔、希腊、阿拉伯、谚文……）按“词”计数 */
const WORD_RE = /[\p{L}\p{N}\p{M}]+(?:['’.-][\p{L}\p{N}\p{M}]+)*/gu;

/** 去掉不算“写作”的内容。所有范围匹配都限制在单行或有限长度内，避免超大文本上的回溯。 */
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
  t = t.replace(/!\[\[[^\]\n]{0,300}\]\]/g, " ");
  t = t.replace(/!\[[^\]\n]{0,300}\]\([^)\n]{0,2000}\)/g, " ");
  // wiki 链接 [[a|b]] -> b, [[a]] -> a
  t = t.replace(/\[\[([^\]|\n]{0,300})\|([^\]\n]{0,300})\]\]/g, "$2");
  t = t.replace(/\[\[([^\]\n]{0,300})\]\]/g, "$1");
  // markdown 链接 [text](url) -> text
  t = t.replace(/\[([^\]\n]{0,500})\]\([^)\n]{0,2000}\)/g, "$1");
  // 裸 URL（含 www. 和 mailto:）
  t = t.replace(/(?:https?:\/\/|www\.|mailto:)\S+/gi, " ");
  // HTML 标签（限制长度，避免大量未闭合的 < 造成二次方回溯）
  t = t.replace(/<[^>\n]{1,300}>/g, " ");
  // 脚注标记、任务/列表标记、标题、引用、强调等符号
  t = t.replace(/\[\^[^\]\n]{0,100}\]/g, " ");
  t = t.replace(/^\s*[-*+]\s+\[.\]\s*/gm, " ");
  t = t.replace(/[#*_>~=`|[\]()^]/g, " ");
  return t;
}

/** 分别统计中日文字数和其余文字的词数（阅读时长需要分开算） */
export function countParts(text: string): { cjk: number; other: number } {
  const t = stripMarkdown(text);
  const cjk = t.match(CJK_RE);
  const rest = t.replace(CJK_RE, " ");
  const latin = rest.match(WORD_RE);
  return { cjk: cjk ? cjk.length : 0, other: latin ? latin.length : 0 };
}

export function countWords(text: string): number {
  const p = countParts(text);
  return p.cjk + p.other;
}

