/*
 * 看板页首的“人情味”：问候语、需要留意的提醒、值得庆祝的达成。
 * 纯函数，不依赖 Obsidian API，便于单元测试；文字通过传入的 t(中文, 英文) 取，不直接依赖当前语言。
 */

export type Say = (zh: string, en: string) => string;

export interface DayContext {
  now: Date;
  todayKey: string;
  todayWords: number;
  /** 每日目标（0 表示没设，写了任何字就算） */
  goal: number;
  /** 今天算不算打卡（含写了日记） */
  todayDone: boolean;
  /** 当前连续打卡天数、这一段连续的第一天（没有连续就是 null） */
  streak: number;
  streakStart: string | null;
  weekWords: number;
  /** 每周目标（0 表示没设） */
  weeklyGoal: number;
  /** 本周一的日期键 */
  weekStartKey: string;
  changePct: number | null;
  overdue: number;
  dueToday: number;
  dueTomorrow: number;
}

export type DayPart = "dawn" | "morning" | "noon" | "afternoon" | "evening" | "night";

export function dayPart(hour: number): DayPart {
  if (hour < 5) return "night";
  if (hour < 9) return "dawn";
  if (hour < 12) return "morning";
  if (hour < 14) return "noon";
  if (hour < 18) return "afternoon";
  if (hour < 23) return "evening";
  return "night";
}

const fmt = (n: number) => n.toLocaleString("en-US");

/** 同一天里说同一句，隔天换一句：按日期取一个稳定的数 */
function pick<T>(list: T[], seed: string): T {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return list[h % list.length];
}

/** 问候语（“早上好”“晚上好”） */
export function hello(part: DayPart, t: Say): string {
  switch (part) {
    case "dawn":
    case "morning":
      return t("早上好", "Good morning");
    case "noon":
      return t("中午好", "Good day");
    case "afternoon":
      return t("下午好", "Good afternoon");
    case "evening":
      return t("晚上好", "Good evening");
    default:
      return t("夜深了", "Still up?");
  }
}

export type Mood = "done" | "start" | "push" | "risk" | "rest";

export function mood(c: DayContext): Mood {
  const part = dayPart(c.now.getHours());
  const reached = c.goal > 0 ? c.todayWords >= c.goal : c.todayWords > 0;
  if (reached || c.todayDone) return "done";
  if (part === "night") return "rest";
  if (c.streak > 0 && (part === "evening" || part === "afternoon")) return c.goal > 0 ? "risk" : "push";
  return c.todayWords > 0 ? "push" : "start";
}

/** 页首那一句话：问候 + 今天的状态（目标达成了、还差多少、别让连续打卡断了……） */
export function greetingTitle(c: DayContext, t: Say): string {
  const part = dayPart(c.now.getHours());
  const left = Math.max(0, c.goal - c.todayWords);
  const n = fmt(c.todayWords);
  const m = mood(c);
  const seed = c.todayKey + m;
  const h = hello(part, t);
  let body: string;
  switch (m) {
    case "done":
      body = pick(
        [
          t(`今天的目标达成了，写了 ${n} 字`, `Today's goal is done, ${n} words in`),
          t("今天的字数够了，做得好", "You've written enough today. Well done"),
          t(`今天已经写了 ${n} 字，目标达成`, `${n} words today, goal reached`),
        ],
        seed
      );
      break;
    case "start":
      body = pick(
        [
          t("今天也来写一点吧", "Let's write a little today"),
          t("先写下第一句，剩下的会跟上来", "Write the first line, the rest will follow"),
          t("新的一天，从一段文字开始", "A new day starts with a few words"),
        ],
        seed
      );
      break;
    case "risk":
      body = pick(
        [
          t(`再写 ${fmt(left)} 字，就能保住连续 ${c.streak} 天`, `${fmt(left)} more words keeps your ${c.streak}-day streak alive`),
          t(`连续 ${c.streak} 天了，今天还差 ${fmt(left)} 字`, `${c.streak} days in a row, ${fmt(left)} words to go today`),
        ],
        seed
      );
      break;
    case "push":
      body =
        c.goal > 0
          ? pick(
              [
                t(`今天写了 ${n} 字，还差 ${fmt(left)} 字就打卡了`, `${n} words so far, ${fmt(left)} to go`),
                t(`已经有 ${n} 字了，再接再厉`, `${n} words already, keep going`),
              ],
              seed
            )
          : t(`今天写了 ${n} 字，继续`, `${n} words today, keep going`);
      break;
    default:
      body = c.todayWords > 0 ? t(`今天写了 ${n} 字，早点休息`, `${n} words today. Get some rest`) : t("早点休息，明天再写", "Rest well, write tomorrow");
  }
  return `${h}${t("，", ", ")}${body}`;
}

export type AlertSeverity = "danger" | "warn" | "info";
export type AlertKind = "overdue" | "dueToday" | "dueTomorrow" | "streak" | "weekly";

export interface Alert {
  kind: AlertKind;
  severity: AlertSeverity;
  /** 任务数、还差的字数、剩几天等，文字里用 */
  count: number;
  extra?: number;
}

/** 需要留意的事，按急迫程度排好：已逾期 > 今天到期 > 连续打卡快断了 > 明天到期 > 本周目标快到期 */
export function computeAlerts(c: DayContext): Alert[] {
  const out: Alert[] = [];
  if (c.overdue > 0) out.push({ kind: "overdue", severity: "danger", count: c.overdue });
  if (c.dueToday > 0) out.push({ kind: "dueToday", severity: "warn", count: c.dueToday });
  const hour = c.now.getHours();
  if (c.streak > 0 && !c.todayDone && hour >= 18) out.push({ kind: "streak", severity: "warn", count: c.streak, extra: Math.max(0, c.goal - c.todayWords) });
  if (c.dueTomorrow > 0) out.push({ kind: "dueTomorrow", severity: "info", count: c.dueTomorrow });
  if (c.weeklyGoal > 0 && c.weekWords < c.weeklyGoal) {
    // 周一在前：周六、周日是这一周最后两天
    const idx = (c.now.getDay() + 6) % 7;
    const daysLeft = 7 - idx;
    if (daysLeft <= 2) out.push({ kind: "weekly", severity: "info", count: c.weeklyGoal - c.weekWords, extra: daysLeft });
  }
  return out;
}

/** 提醒的文字 */
export function alertText(a: Alert, t: Say): string {
  switch (a.kind) {
    case "overdue":
      return t(`${a.count} 项任务已逾期`, `${a.count} ${a.count === 1 ? "task is" : "tasks are"} overdue`);
    case "dueToday":
      return t(`${a.count} 项任务今天到期`, `${a.count} ${a.count === 1 ? "task is" : "tasks are"} due today`);
    case "dueTomorrow":
      return t(`${a.count} 项任务明天到期`, `${a.count} ${a.count === 1 ? "task is" : "tasks are"} due tomorrow`);
    case "streak":
      return a.extra
        ? t(`今天还没打卡，写 ${fmt(a.extra)} 字就能保住连续 ${a.count} 天`, `Not checked in yet. ${fmt(a.extra)} words keeps your ${a.count}-day streak`)
        : t(`今天还没打卡，连续 ${a.count} 天快断了`, `Not checked in yet. Your ${a.count}-day streak is at risk`);
    default:
      return t(`本周目标还差 ${fmt(a.count)} 字，${a.extra === 1 ? "今天是最后一天" : "还剩 2 天"}`, `${fmt(a.count)} words left for this week's goal, ${a.extra === 1 ? "last day today" : "2 days to go"}`);
  }
}

export type AchievementKind = "daily" | "weekly" | "streak";

export interface Achievement {
  key: string;
  kind: AchievementKind;
  n: number;
}

/** 连续打卡的里程碑 */
export const STREAK_MILESTONES = [3, 7, 14, 21, 30, 50, 100, 200, 365, 500, 1000];

/** 今天达成了、还没庆祝过的事：每日目标、每周目标、连续打卡里程碑。已经庆祝过的（celebrated 里有）不再返回 */
export function achievements(c: DayContext, celebrated: ReadonlySet<string>): Achievement[] {
  const out: Achievement[] = [];
  const reached = c.goal > 0 ? c.todayWords >= c.goal : c.todayWords > 0;
  if (reached) out.push({ key: `d:${c.todayKey}`, kind: "daily", n: c.todayWords });
  if (c.weeklyGoal > 0 && c.weekWords >= c.weeklyGoal) out.push({ key: `w:${c.weekStartKey}`, kind: "weekly", n: c.weekWords });
  if (c.todayDone && c.streakStart && STREAK_MILESTONES.includes(c.streak)) out.push({ key: `s:${c.streak}:${c.streakStart}`, kind: "streak", n: c.streak });
  return out.filter((a) => !celebrated.has(a.key));
}

/** 庆祝时说的话 */
export function achievementText(a: Achievement, t: Say): string {
  switch (a.kind) {
    case "daily":
      return t(`今天的写作目标达成了，写了 ${fmt(a.n)} 字`, `Today's writing goal reached: ${fmt(a.n)} words`);
    case "weekly":
      return t(`本周的字数目标达成了，已经写了 ${fmt(a.n)} 字`, `This week's goal reached: ${fmt(a.n)} words`);
    default:
      return t(`连续打卡 ${a.n} 天，了不起`, `${a.n} days in a row. Impressive`);
  }
}

/** 已庆祝的记录只留最近的，免得设置里无限增长 */
export function pruneCelebrated(list: string[], keep = 120): string[] {
  return list.length > keep ? list.slice(list.length - keep) : list;
}
