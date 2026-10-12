import { test } from "node:test";
import assert from "node:assert/strict";
import { countParts, countWords, stripMarkdown } from "../src/count";
import {
  WordPropOptions,
  compute,
  decideWrite,
  isRecentlyModified,
  pathSkipReason,
  readingMinutes,
  sanitizeProperty,
} from "../src/wordprops-logic";

const base: WordPropOptions = {
  property: "words",
  readingEnabled: false,
  readingProperty: "reading_time",
  cjkPerMin: 400,
  wordsPerMin: 220,
  minChange: 1,
  skipOutliers: true,
  outlierWords: 20000,
  includeFolders: [],
  excludeFolders: [],
};
const opt = (o: Partial<WordPropOptions> = {}): WordPropOptions => ({ ...base, ...o });
const dec = (existing: Record<string, unknown> | null, words: number, o: Partial<WordPropOptions> = {}) =>
  decideWrite(existing, { words, minutes: readingMinutes(words, 0, 400, 220) }, opt(o));

/* ---------- counting ---------- */

test("counts CJK per character and other scripts per word", () => {
  assert.equal(countWords("你好世界"), 4);
  assert.equal(countWords("hello brave new world"), 4);
  assert.equal(countWords("今天 write 三个 notes"), 6);
  assert.deepEqual(countParts("你好 hello world"), { cjk: 2, other: 2 });
});

test("ignores frontmatter, code, links, urls, comments and embeds", () => {
  const md = [
    "---",
    "title: 很长的标题很长的标题",
    "words: 99999",
    "---",
    "正文四个字",
    "```js",
    "const a = 1;",
    "```",
    "%%注释注释注释%%",
    "![[image.png]]",
    "https://example.com/a/b/c",
    "[[Some Note|别名]]",
  ].join("\n");
  // 正文四个字 = 5 个汉字（正文四个字）, 别名 = 2
  assert.equal(countWords(md), 5 + 2);
  assert.ok(!stripMarkdown(md).includes("99999"));
});

test("writing the property does not change the count", () => {
  const before = "# 标题\n\n这是正文内容。";
  const after = "---\nwords: 10\nreading_time: 1\n---\n" + before;
  assert.equal(countWords(before), countWords(after));
});

test("empty and whitespace-only notes count as 0", () => {
  assert.equal(countWords(""), 0);
  assert.equal(countWords("  \n\n  "), 0);
  assert.equal(countWords("---\ntitle: x\n---\n"), 0);
});

/* ---------- reading time ---------- */

test("reading time rounds up, minimum 1, 0 for empty", () => {
  assert.equal(readingMinutes(0, 0, 400, 220), 0);
  assert.equal(readingMinutes(1, 0, 400, 220), 1);
  assert.equal(readingMinutes(400, 0, 400, 220), 1);
  assert.equal(readingMinutes(401, 0, 400, 220), 2);
  assert.equal(readingMinutes(0, 440, 400, 220), 2);
  assert.equal(readingMinutes(200, 110, 400, 220), 1); // 0.5 + 0.5
  assert.equal(readingMinutes(200, 111, 400, 220), 2);
  assert.equal(readingMinutes(400, 0, 0, 0), 1); // bad speeds fall back to defaults
});

test("compute combines CJK and latin speeds", () => {
  const c = compute("你".repeat(800) + " " + "word ".repeat(220), { cjkPerMin: 400, wordsPerMin: 220 });
  assert.equal(c.words, 1020);
  assert.equal(c.minutes, 3);
});

/* ---------- write decision ---------- */

test("writes when the property is missing, never when equal", () => {
  assert.deepEqual(dec(null, 120), { write: true, words: 120, minutes: null });
  assert.deepEqual(dec({}, 120), { write: true, words: 120, minutes: null });
  assert.deepEqual(dec({ words: 120 }, 120), { write: false, reason: "unchanged" });
});

test("rewrites a non-numeric value as a number", () => {
  assert.equal(dec({ words: "120" }, 120).write, true);
  assert.equal(dec({ words: null }, 120).write, true);
  assert.equal(dec({ words: Number.NaN }, 120).write, true);
});

test("minChange threshold: write only when the difference reaches it", () => {
  assert.equal(dec({ words: 100 }, 101).write, true); // default 1
  assert.equal(dec({ words: 100 }, 104, { minChange: 5 }).write, false);
  assert.equal(dec({ words: 100 }, 105, { minChange: 5 }).write, true);
  assert.equal(dec({ words: 100 }, 95, { minChange: 5 }).write, true); // decreases too
  assert.equal(dec({ words: 100 }, 100, { minChange: 5 }).write, false);
  assert.equal(dec({ words: 100 }, 101, { minChange: 0 }).write, true); // 0 / junk is treated as 1
  assert.equal(dec({ words: 100 }, 100, { minChange: 0 }).write, false);
});

test("empty notes without the property are left alone", () => {
  assert.deepEqual(dec(null, 0), { write: false, reason: "empty" });
  assert.deepEqual(dec({ title: "x" }, 0), { write: false, reason: "empty" });
  // but a stale non-zero value on a now-empty note is corrected
  assert.equal(dec({ words: 50 }, 0).write, true);
});

test("outliers are skipped only when the option is on", () => {
  assert.deepEqual(dec(null, 20001), { write: false, reason: "outlier" });
  assert.equal(dec(null, 20000).write, true);
  assert.equal(dec(null, 20001, { skipOutliers: false }).write, true);
});

test("reading time rides along with a words write", () => {
  const r = decideWrite({ words: 100 }, { words: 900, minutes: 3 }, opt({ readingEnabled: true }));
  assert.deepEqual(r, { write: true, words: 900, minutes: 3 });
});

test("reading time alone triggers a write only when missing or not a number", () => {
  const c = { words: 100, minutes: 1 };
  const o = opt({ readingEnabled: true });
  assert.equal(decideWrite({ words: 100, reading_time: 1 }, c, o).write, false);
  assert.equal(decideWrite({ words: 100 }, c, o).write, true);
  assert.equal(decideWrite({ words: 100, reading_time: "1" }, c, o).write, true);
  // small drift inside the threshold does not rewrite just for reading time
  assert.equal(decideWrite({ words: 100, reading_time: 1 }, { words: 101, minutes: 2 }, opt({ readingEnabled: true, minChange: 5 })).write, false);
  // disabled: never touches reading time
  assert.deepEqual(decideWrite({ words: 1 }, { words: 2, minutes: 1 }, opt()), { write: true, words: 2, minutes: null });
});

test("custom property names are respected", () => {
  assert.equal(decideWrite({ wc: 5 }, { words: 5, minutes: 1 }, opt({ property: "wc" })).write, false);
  assert.equal(decideWrite({ words: 5 }, { words: 5, minutes: 1 }, opt({ property: "wc" })).write, true);
});

/* ---------- scope ---------- */

test("only .md files are processed", () => {
  assert.equal(pathSkipReason("a.md", "md", opt()), null);
  assert.equal(pathSkipReason("a.MD", "MD", opt()), null);
  assert.equal(pathSkipReason("a.canvas", "canvas", opt()), "not-md");
  assert.equal(pathSkipReason("a.base", "base", opt()), "not-md");
});

test("exclude and include folders, including sub-folders and name prefixes", () => {
  const o = opt({ excludeFolders: ["x", "Templates"], includeFolders: ["Notes"] });
  assert.equal(pathSkipReason("Notes/a.md", "md", o), null);
  assert.equal(pathSkipReason("Notes/sub/a.md", "md", o), null);
  assert.equal(pathSkipReason("Other/a.md", "md", o), "not-included");
  assert.equal(pathSkipReason("Notes2/a.md", "md", o), "not-included"); // not a prefix match
  const ex = opt({ excludeFolders: ["x"] });
  assert.equal(pathSkipReason("x/2026.md", "md", ex), "excluded");
  assert.equal(pathSkipReason("x/deep/2026.md", "md", ex), "excluded");
  assert.equal(pathSkipReason("xylophone/a.md", "md", ex), null);
  assert.equal(pathSkipReason("a.md", "md", opt({ excludeFolders: [""] })), null); // empty entries ignored
  // exclude wins over include
  assert.equal(pathSkipReason("Notes/Templates/a.md", "md", opt({ includeFolders: ["Notes"], excludeFolders: ["Notes/Templates"] })), "excluded");
});

test("recently modified files are protected for 2 seconds", () => {
  assert.equal(isRecentlyModified(10_000, 11_999), true);
  assert.equal(isRecentlyModified(10_000, 12_000), false);
  assert.equal(isRecentlyModified(10_000, 60_000), false);
});

test("property names are sanitised", () => {
  assert.equal(sanitizeProperty(" words ", "x"), "words");
  assert.equal(sanitizeProperty("字数", "x"), "字数");
  assert.equal(sanitizeProperty("", "words"), "words");
  assert.equal(sanitizeProperty("a: b", "words"), "words");
  assert.equal(sanitizeProperty("a\nb", "words"), "words");
});
