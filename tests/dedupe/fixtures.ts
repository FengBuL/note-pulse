/** Realistic synthetic notes in the style of an auto-collected X (Twitter) folder: frontmatter, headings, tables, quotes, lists. */
import { TokenizeOptions } from "../../src/dedupe/core/tokenize";

export const OPTS: TokenizeOptions = {
  ignoreFrontmatter: true,
  ignoreCode: true,
  ignoreHeadings: true,
  ignoreLinkOnly: true,
  minLength: 80,
  detectStatusIds: true,
};

export interface Post {
  id: string;
  user: string;
  text: string;
}

export const POSTS: Post[] = [
  { id: "1842110000000000001", user: "karpathy", text: "Agents are the new apps: a good agent loop plus a handful of well-designed tools beats a thousand-feature product for most everyday jobs." },
  { id: "1842110000000000002", user: "sama", text: "We shipped a new reasoning model today. It is slower on easy questions and far better on the hard ones, which is the trade most people actually want." },
  { id: "1842110000000000003", user: "dotey", text: "把提示词当成产品需求文档来写：目标、约束、输入输出格式、失败案例，四块写清楚，模型的表现会稳定很多，而且更容易复盘问题到底出在哪。" },
  { id: "1842110000000000004", user: "swyx", text: "The best AI engineering teams spend more time on evals than on prompts. If you cannot measure a regression you cannot ship with confidence." },
  { id: "1842110000000000005", user: "op7418", text: "今天试了新的长上下文模型，处理三百页的 PDF 没有出现明显的遗忘，但是引用页码仍然会偶尔错位，需要在流程里加一步人工核对。" },
  { id: "1842110000000000006", user: "simonw", text: "LLMs are good at turning messy input into structured output. Start with a schema, validate everything, and treat the model as an untrusted parser." },
  { id: "1842110000000000007", user: "emollick", text: "Most organisations are still running pilots. The ones seeing real gains rebuilt a single workflow end to end rather than adding a chatbot on top of an existing process." },
  { id: "1842110000000000008", user: "lijigang", text: "做知识库最容易犯的错误是只收集不整理，收藏夹里躺着上千条链接，真正需要的时候一条也找不到，所以每周固定留半小时做清理。" },
  { id: "1842110000000000009", user: "levelsio", text: "Shipping small things every week compounds. After a year you have fifty releases and a few of them took off, which no amount of planning would have predicted." },
  { id: "1842110000000000010", user: "rowancheung", text: "Three open-source models were released this week with permissive licences. The gap to closed models keeps narrowing on coding benchmarks but not on long-horizon tasks." },
  { id: "1842110000000000011", user: "vista8", text: "做内容的人要警惕数据好看的陷阱：点赞数高不代表转化高，最好同时记录收藏、转发和私信数量，才能判断内容是否真的有价值。" },
  { id: "1842110000000000012", user: "paulg", text: "The most common mistake in a startup is working on something nobody wants, and the second most common is believing a polite compliment is evidence that they do." },
];

export const postRow = (i: number, p: Post, qs = "?s=20") => `| ${i} | @${p.user} | ${p.text} | https://x.com/${p.user}/status/${p.id}${qs} |`;
export const postQuote = (p: Post) => `> @${p.user}: ${p.text}\n> https://twitter.com/${p.user}/status/${p.id}`;
export const postBullet = (p: Post) => `- @${p.user}：${p.text}\n  - 链接：https://x.com/${p.user}/status/${p.id}\n  - 备注：待跟进`;

export function frontmatter(date: string, status = "sampled", extra = ""): string {
  return `---\ndate: ${date}\naccount: shovy\nstatus: ${status}\ntags: [x, foryou]\n${extra}---\n`;
}

export function table(posts: Post[], qs = "?s=20"): string {
  return ["| # | 作者 | 内容 | 链接 |", "|---|------|------|------|", ...posts.map((p, i) => postRow(i + 1, p, qs))].join("\n");
}

/** A morning sample: table of the first posts, quotes, and a list. */
export function sampleNote(date: string, time: string, tablePosts: Post[], quotes: Post[], bullets: Post[], tail = ""): string {
  return (
    frontmatter(date) +
    `\n# ForYou 采样清单 ${time}\n\n## 概览\n\n本次共采样 50 条，其中和 AI 相关的 ${tablePosts.length + quotes.length} 条，已记录在下方。\n\n## 高价值帖子\n\n${table(tablePosts)}\n\n## 值得引用\n\n${quotes.map(postQuote).join("\n\n")}\n\n## 待跟进\n\n${bullets.map(postBullet).join("\n")}\n` +
    (tail ? `\n${tail}\n` : "")
  );
}

export const FILES: Record<string, { text: string; ctime: number; mtime: number }> = {};

const T0 = Date.UTC(2026, 9, 5, 5, 0, 0);
const add = (path: string, text: string, hoursAfter: number) => {
  FILES[path] = { text, ctime: T0 + hoursAfter * 3600e3, mtime: T0 + hoursAfter * 3600e3 };
};

export function buildVault(): typeof FILES {
  for (const k of Object.keys(FILES)) delete FILES[k];
  const P = POSTS;
  add("x/2026-10-05-1423-ForYou采样清单.md", sampleNote("2026-10-05", "14:23", P.slice(0, 6), [P[1], P[2]], [P[3], P[4]]), 0);
  add("x/2026-10-05-2025-ForYou采样清单.md", sampleNote("2026-10-05", "20:25", P.slice(2, 9), [P[2], P[6]], [P[4], P[7]], "## 新增观察\n\n晚间这一批里关于评测和工作流的讨论明显变多，值得单独开一篇笔记整理成方法论，以后写周报时直接引用。"), 6);
  // A follow-up run that re-includes the previous run's content in full
  const evening = FILES["x/2026-10-05-2025-ForYou采样清单.md"].text;
  add("x/2026-10-06-0912-ForYou续查.md", evening.replace("20:25", "09:12").replace("2026-10-05", "2026-10-06") + `\n## 续查结果\n\n${table(P.slice(9, 12))}\n`, 24);
  add("notes/周报-第41周.md", `# 第 41 周周报\n\n本周主要完成了看板插件的上架准备，以及公众号排版工具的两个小版本迭代，还顺手整理了一批采集笔记里重复出现的内容，确认了清理的基本思路。\n\n下周计划：整理采集笔记里重复的内容，建立固定的清理流程，并把清理前后的体积变化和遇到的问题都完整记录下来，写进下一期的周报里面。\n`, 30);
  add("notes/周报-第42周.md", `# 第 42 周周报\n\n本周主要完成了看板插件的上架准备，以及公众号排版工具的两个小版本迭代，还顺手整理了一批采集笔记里重复出现的内容，确认了清理的基本思路。\n\n下周计划：开始做一个新的插件，并且更新社交媒体上的发布内容和介绍文案，同时抽时间回复用户在仓库里留下的各种反馈和问题。\n`, 40);
  return FILES;
}
