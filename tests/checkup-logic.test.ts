import { test } from "node:test";
import assert from "node:assert/strict";
import { baseName, inFolders, linkText, looseKey, rewriteLinks, sameNameGroups, suggestTarget, unusedAttachments } from "../src/checkup-logic";

const notes = [
  "Claude code常用指令/Claude Code 使用指南（新版）.md",
  "大模型学习/RAG：从环境搭建到代码落地实录/RAG 代码落地-重构版.md",
  "工作/岗位计划索引.md",
  "harness/公众号文章/TG03-边界与确认门.md",
  "harness/Track C/TG03-边界与确认门.md",
  "harness/README.md",
  "墨笔-更新版/README.md",
];

test("笔记被移动过：断链里的旧路径按文件名找到新位置", () => {
  assert.deepEqual(suggestTarget("岗位/岗位计划索引", notes), { name: "岗位/岗位计划索引", target: "工作/岗位计划索引.md", kind: "exact" });
});

test("只差空格、大小写或分隔符：唯一对得上才建议", () => {
  assert.deepEqual(suggestTarget("RAG代码落地-重构版", notes), {
    name: "RAG代码落地-重构版",
    target: "大模型学习/RAG：从环境搭建到代码落地实录/RAG 代码落地-重构版.md",
    kind: "loose",
  });
  assert.equal(looseKey("RAG 代码落地-重构版"), looseKey("rag代码落地重构版"));
});

test("有两篇以上候选、或者根本对不上时不猜", () => {
  assert.equal(suggestTarget("TG03-边界与确认门", notes), null);
  assert.equal(suggestTarget("JSON", notes), null);
  assert.equal(suggestTarget("passes", notes), null);
  assert.equal(suggestTarget("Claude code常用指令/Claude Code 使用指南", notes), null, "名字不一样（少了“（新版）”）不算");
});

test("同名候选里，断链带的路径能唯一选中时照样建议", () => {
  assert.deepEqual(suggestTarget("Track C/TG03-边界与确认门", notes)?.target, "harness/Track C/TG03-边界与确认门.md");
});

test("表格里转义的 \\| 别名：断链名末尾的反斜杠去掉再比", () => {
  assert.equal(suggestTarget("岗位/岗位计划索引\\", notes)?.target, "工作/岗位计划索引.md");
});

test("改写链接：保留嵌入、标题、块、别名和表格转义；不碰别的链接", () => {
  const src = [
    "见 [[岗位/岗位计划索引]] 和 [[岗位/岗位计划索引|计划]]。",
    "| [[岗位/岗位计划索引\\|索引]] | x |",
    "![[岗位/岗位计划索引#第二节]] [[岗位/岗位计划索引.md^abc]]",
    "[[岗位/岗位计划索引其它]] [[别的笔记]]",
  ].join("\n");
  const r = rewriteLinks(src, "岗位/岗位计划索引", "岗位计划索引");
  assert.equal(r.count, 5);
  assert.equal(
    r.text,
    [
      "见 [[岗位计划索引]] 和 [[岗位计划索引|计划]]。",
      "| [[岗位计划索引\\|索引]] | x |",
      "![[岗位计划索引#第二节]] [[岗位计划索引^abc]]",
      "[[岗位/岗位计划索引其它]] [[别的笔记]]",
    ].join("\n")
  );
  // 撤销：反方向再改一次就回来（.md 后缀不会被恢复，但链接指向相同）
  const back = rewriteLinks(r.text, "岗位计划索引", "岗位/岗位计划索引");
  assert.equal(back.count, 5);
});

test("改写链接不区分大小写，名字里的正则符号按字面匹配", () => {
  assert.equal(rewriteLinks("[[a.b (1)]] [[A.B (1)]] [[axb (1)]]", "a.b (1)", "c").text, "[[c]] [[c]] [[axb (1)]]");
});

test("链接文字：文件名唯一写文件名，有重名写完整路径", () => {
  assert.equal(linkText("工作/岗位计划索引.md", notes), "岗位计划索引");
  assert.equal(linkText("harness/README.md", notes), "harness/README");
});

test("同名笔记分组", () => {
  assert.deepEqual(sameNameGroups(notes), [
    ["harness/README.md", "墨笔-更新版/README.md"],
    ["harness/Track C/TG03-边界与确认门.md", "harness/公众号文章/TG03-边界与确认门.md"],
  ]);
});

test("未引用的附件：只看附件类型，被链接过的不算", () => {
  const files = ["a/图.png", "a/用了.png", "笔记.md", "数据.canvas", "x/文档.pdf", "安全/key.txt"];
  assert.deepEqual(unusedAttachments(files, new Set(["a/用了.png"])), ["a/图.png", "x/文档.pdf", "安全/key.txt"]);
});

test("文件夹过滤含子文件夹，不误伤同前缀的文件夹", () => {
  assert.ok(inFolders("日常总结/2026-10-23.md", ["日常总结"]));
  assert.ok(!inFolders("日常总结归档/a.md", ["日常总结"]));
  assert.ok(!inFolders("a.md", [""]));
  assert.equal(baseName("a/b/c.md"), "c");
});
