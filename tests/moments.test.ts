import { test } from "node:test";
import assert from "node:assert/strict";
import { DayContext, achievements, alertText, computeAlerts, dayPart, greetingTitle, hello, mood, pruneCelebrated } from "../src/moments";

const zh = (z: string) => z;
const en = (_z: string, e: string) => e;

function ctx(over: Partial<DayContext> = {}, hour = 15, day = 21): DayContext {
  // 2026-10-21 是周三
  return {
    now: new Date(2026, 9, day, hour, 0),
    todayKey: `2026-10-${day}`,
    todayWords: 0,
    goal: 300,
    todayDone: false,
    streak: 0,
    streakStart: null,
    weekWords: 0,
    weeklyGoal: 1500,
    weekStartKey: "2026-10-19",
    changePct: null,
    overdue: 0,
    dueToday: 0,
    dueTomorrow: 0,
    ...over,
  };
}

test("一天里的时段和问候语", () => {
  assert.equal(dayPart(3), "night");
  assert.equal(dayPart(7), "dawn");
  assert.equal(dayPart(10), "morning");
  assert.equal(dayPart(12), "noon");
  assert.equal(dayPart(16), "afternoon");
  assert.equal(dayPart(21), "evening");
  assert.equal(dayPart(23), "night");
  assert.equal(hello("morning", zh), "早上好");
  assert.equal(hello("evening", en), "Good evening");
  assert.equal(hello("night", zh), "夜深了");
});

test("心情：达成、刚开始、写了一点、连续打卡快断了、深夜", () => {
  assert.equal(mood(ctx({ todayWords: 400 })), "done");
  assert.equal(mood(ctx({ todayDone: true })), "done", "写了日记也算");
  assert.equal(mood(ctx({}, 9)), "start");
  assert.equal(mood(ctx({ todayWords: 100 }, 10)), "push");
  assert.equal(mood(ctx({ streak: 5, todayWords: 100 }, 20)), "risk");
  assert.equal(mood(ctx({ streak: 5 }, 15)), "risk");
  assert.equal(mood(ctx({ streak: 0 }, 20)), "start");
  assert.equal(mood(ctx({ todayWords: 50 }, 2)), "rest");
});

test("页首问候：带上具体数字，中英文都有，同一天说同一句", () => {
  const risk = ctx({ streak: 5, todayWords: 120 }, 20);
  const a = greetingTitle(risk, zh);
  assert.match(a, /^晚上好，/);
  assert.match(a, /180/, "还差 180 字");
  assert.match(a, /5/);
  assert.equal(greetingTitle(risk, zh), a);
  assert.match(greetingTitle(risk, en), /^Good evening, /);
  const done = greetingTitle(ctx({ todayWords: 640 }, 9), zh);
  assert.match(done, /^早上好，/);
  assert.ok(/640|目标|够了/.test(done));
  assert.match(greetingTitle(ctx({}, 8), zh), /^早上好，/);
  assert.match(greetingTitle(ctx({ todayWords: 10 }, 1), zh), /^夜深了，/);
  // 没设目标时不会出现“还差 NaN 字”
  assert.ok(!/NaN|undefined/.test(greetingTitle(ctx({ goal: 0, todayWords: 10 }, 15), zh)));
});

test("提醒：逾期最醒目，其次今天到期、连续打卡快断了、明天到期、本周目标快到期，按急迫程度排好", () => {
  const all = computeAlerts(ctx({ overdue: 2, dueToday: 1, dueTomorrow: 3, streak: 4, weekWords: 100 }, 19, 25)); // 周日晚上
  assert.deepEqual(all.map((a) => a.kind), ["overdue", "dueToday", "streak", "dueTomorrow", "weekly"]);
  assert.equal(all[0].severity, "danger");
  assert.equal(all[2].extra, 300);
  assert.equal(all[4].count, 1400);
  assert.equal(all[4].extra, 1, "周日是最后一天");
  assert.deepEqual(computeAlerts(ctx()), []);
  assert.ok(!computeAlerts(ctx({ streak: 4 }, 12)).some((a) => a.kind === "streak"), "白天不催");
  assert.ok(!computeAlerts(ctx({ streak: 4, todayDone: true }, 21)).some((a) => a.kind === "streak"), "已经打卡了不催");
  assert.ok(!computeAlerts(ctx({ weekWords: 100 }, 12, 21)).some((a) => a.kind === "weekly"), "周三不提本周目标");
  assert.ok(!computeAlerts(ctx({ weekWords: 1600 }, 12, 25)).some((a) => a.kind === "weekly"), "目标已达成不提");
  assert.ok(!computeAlerts(ctx({ weeklyGoal: 0 }, 12, 25)).some((a) => a.kind === "weekly"), "没设目标不提");
  assert.equal(alertText(all[0], zh), "2 项任务已逾期");
  assert.equal(alertText({ kind: "overdue", severity: "danger", count: 1 }, en), "1 task is overdue");
  assert.match(alertText(all[2], zh), /300 字.*连续 4 天/);
});

test("达成：每日目标、每周目标、连续打卡里程碑；庆祝过的不再出现", () => {
  const base = ctx({ todayWords: 400, todayDone: true, weekWords: 1600, streak: 7, streakStart: "2026-10-15" }, 21);
  const a = achievements(base, new Set());
  assert.deepEqual(a.map((x) => x.key), ["d:2026-10-21", "w:2026-10-19", "s:7:2026-10-15"]);
  const seen = new Set(["d:2026-10-21"]);
  assert.deepEqual(achievements(base, seen).map((x) => x.kind), ["weekly", "streak"]);
  assert.deepEqual(achievements(base, new Set(a.map((x) => x.key))), []);
  assert.deepEqual(achievements(ctx({ todayWords: 100 }), new Set()), [], "没达标没有");
  assert.ok(!achievements(ctx({ todayWords: 400, todayDone: true, streak: 8, streakStart: "2026-10-14" }), new Set()).some((x) => x.kind === "streak"), "8 天不是里程碑");
  assert.equal(achievements(ctx({ goal: 0, todayWords: 5 }), new Set())[0]?.kind, "daily", "没设目标，写了就算");
  // 断了又重新连到 7 天，开始日不同，key 不同，会再庆祝一次
  const again = achievements({ ...base, streakStart: "2026-11-01" }, new Set(["s:7:2026-10-15"]));
  assert.ok(again.some((x) => x.key === "s:7:2026-11-01"));
});

test("已庆祝的记录只留最近的", () => {
  const list = Array.from({ length: 200 }, (_, i) => `k${i}`);
  const pruned = pruneCelebrated(list, 120);
  assert.equal(pruned.length, 120);
  assert.equal(pruned.at(-1), "k199");
  assert.equal(pruneCelebrated(["a"], 120).length, 1);
});
