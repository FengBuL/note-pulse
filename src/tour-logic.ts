/*
 * 2.0 新版本引导：升级后第一次打开看板时，一步一步带用户看一遍新功能（高亮真实的界面、自动进入编辑模式、点“下一步”继续）。
 * 这里只放纯数据和纯函数（步骤、提示卡该放在哪），不依赖 DOM，方便单元测试；画界面的部分在 tour.ts。
 */
import { L } from "./i18n";

/** 引导的版本：以后再有大改版，把它改成新的值，所有人会再看到一次引导 */
export const GUIDE_VERSION = "2.0";

/** 这一步需要看板处在什么状态：是否编辑模式、是否展开了“添加卡片”面板 */
export interface TourState {
  editing: boolean;
  addOpen: boolean;
}

/** 要高亮的界面元素，具体怎么找由 view 决定 */
export type TourTarget = "greeting" | "alerts" | "editBtn" | "card" | "handle" | "switch" | "addBtn" | "addPanel" | "doneBtn" | "firstCard";

/** 这一步上演示的小动画：光标拖动卡片、拖角调大小、点切换按钮 */
export type TourDemo = "drag" | "resize" | "click";

export interface TourStep {
  id: string;
  title: string;
  body: string;
  /** 没有目标的步骤，提示卡放在屏幕中间 */
  target?: TourTarget;
  /** 目标找不到时（比如用户没有提醒、没有带切换的卡片）跳过这一步 */
  optional?: boolean;
  state: TourState;
  demo?: TourDemo;
}

const VIEW: TourState = { editing: false, addOpen: false };
const EDIT: TourState = { editing: true, addOpen: false };
const ADD: TourState = { editing: true, addOpen: true };

/**
 * 所有步骤。wide 为 false（手机或窄面板）时看板只看不改，只讲看得到的部分，不进编辑模式。
 */
export function tourSteps(wide: boolean): TourStep[] {
  const welcome: TourStep = {
    id: "welcome",
    title: L("欢迎来到 Note Pulse 2.0", "Welcome to Note Pulse 2.0"),
    body: wide
      ? L(
          "这一版的看板可以自己摆：要哪些卡片、放在哪、多大，都由你定。还新增了日历、目标进度、最近编辑等卡片，把相关的数据合成了带标签页的卡片，图表也能换画法。花一分钟，跟着看一遍怎么用。",
          "The dashboard is now yours to arrange: pick the cards, where they go and how big. There are new cards (calendar, goals, recent edits), combined cards with tabs, and charts you can restyle. Take a minute to see how it works."
        )
      : L(
          "这一版的看板有了新的卡片、问候和提醒，图表也能换画法。手机和窄面板上只看不改，布局会跟着电脑上摆好的走。花一分钟看看有什么新东西。",
          "The dashboard has new cards, a greeting and reminders, and charts you can restyle. On phones and narrow panes it is view-only and follows the layout you arranged on a computer. Take a minute to see what is new."
        ),
    state: VIEW,
  };
  const greeting: TourStep = {
    id: "greeting",
    title: L("页首的问候", "The greeting"),
    body: L("问候会跟着时间和你今天的写作变：目标达成了、还差多少字、再写多少能保住连续打卡……下面一行是本周的小结。", "The greeting follows the time of day and your writing today: goal met, words to go, how to keep your streak. The line below is this week's summary."),
    target: "greeting",
    state: VIEW,
  };
  const alerts: TourStep = {
    id: "alerts",
    title: L("醒目的提醒", "Reminders"),
    body: L("任务逾期（红）、今天到期（橙）、今晚还没打卡（橙）、本周目标还差多少（紫），都做成色块放在这里。点一下，直接跳到相关的卡片。", "Overdue tasks (red), tasks due today (orange), a streak about to break (orange) and the weekly goal (purple) show up here. Click one to jump to the card."),
    target: "alerts",
    optional: true,
    state: VIEW,
  };
  const cards: TourStep = {
    id: "cards",
    title: L("卡片", "Cards"),
    body: L("每张卡片大小不同，显示的内容跟着变：小的只有数字，大的有图表和细节。列表放不下的会折成“还有 N 个”，点开可以在卡片里滚动。", "Cards differ in size and show more as they grow: small ones just a number, big ones charts and details. Lists that do not fit fold into “N more”."),
    target: "firstCard",
    optional: true,
    state: VIEW,
  };
  const finish: TourStep = {
    id: "finish",
    title: wide ? L("都看完了", "All done") : L("开始使用吧", "You are all set"),
    body: wide
      ? L("想再看一遍：在命令面板里搜“新手引导”，或者进入编辑后点编辑栏里的“新手引导”。祝写得开心。", "To see this again, search “guide” in the command palette, or click “Guide” in the edit bar while editing. Happy writing.")
      : L("想再看一遍：在命令面板里搜“新手引导”。要摆卡片，请在电脑上操作，手机会自动同步。", "To see this again, search “guide” in the command palette. To arrange cards, use a computer; your phone follows automatically."),
    state: VIEW,
  };
  if (!wide) return [welcome, greeting, alerts, cards, finish];
  return [
    welcome,
    greeting,
    alerts,
    {
      id: "edit",
      title: L("点铅笔，进入编辑", "Click the pencil to edit"),
      body: L("点这里进入编辑模式，才能摆卡片。点“下一步”，我带你进去。", "Click here to enter edit mode, where you can arrange cards. Press Next and I will take you in."),
      target: "editBtn",
      state: VIEW,
    },
    {
      id: "drag",
      title: L("拖动卡片换位置", "Drag a card to move it"),
      body: L("按住卡片拖到想放的地方，别的卡片会实时让位，虚线框是松手后的位置。按 Esc 取消，Cmd / Ctrl + Z 撤销，也可以用方向键移动。", "Drag a card where you want it; the others make room live and the dashed frame shows where it will land. Esc cancels, Cmd / Ctrl + Z undoes, arrow keys work too."),
      target: "card",
      state: EDIT,
      demo: "drag",
    },
    {
      id: "resize",
      title: L("拖右下角调大小", "Drag the corner to resize"),
      body: L("宽和高按格子吸附（一共 12 列）。每张卡片有自己合适的大小范围，拖大了会显示更多内容，缩小了只留重点。", "Width and height snap to a 12-column grid. Each card has its own sensible range; bigger shows more, smaller keeps the essentials."),
      target: "handle",
      state: EDIT,
      demo: "resize",
    },
    {
      id: "switch",
      title: L("切换指标、范围和图的样子", "Switch metric, period and chart style"),
      body: L("编辑时，卡片上会出现切换：指标、时间范围、标签页，以及图的画法（柱状 / 折线 / 曲线 / 面积、堆叠条 / 环形图、标签云……）。平时看板上不放这些按钮，免得误点。", "While editing, cards show switches for metric, period and tabs, plus the chart style (bar, line, curve, area, donut, cloud…). They stay hidden otherwise so you do not click them by accident."),
      target: "switch",
      optional: true,
      state: EDIT,
      demo: "click",
    },
    {
      id: "add",
      title: L("添加更多卡片", "Add more cards"),
      body: L("点“添加卡片”，打开卡片库。点“下一步”，我带你看。", "Click “Add a card” to open the card library. Press Next to look inside."),
      target: "addBtn",
      state: EDIT,
    },
    {
      id: "library",
      title: L("挑一张卡片", "Pick a card"),
      body: L("卡片按分类列出，每张都有缩略图。带“合并卡”标记的，把几张相关的卡片合成了一张带标签页的卡片。灰色的已经在看板上，点一下能找到它。点卡片加到最后，也可以直接拖到看板上想放的位置。", "Cards are listed by category with a thumbnail each. “Combined” cards merge several related cards into one with tabs. Grey ones are already on the dashboard; click one to find it. Click a card to add it at the end, or drag it where you want it."),
      target: "addPanel",
      state: ADD,
    },
    {
      id: "done",
      title: L("改完点“完成”", "Click Done when finished"),
      body: L("改动自动保存，并随库同步到你的其他设备。手机上看板只看不改，会跟着电脑上的布局。", "Changes are saved automatically and sync across your devices. On a phone the dashboard is view-only and follows your computer's layout."),
      target: "doneBtn",
      state: EDIT,
    },
    finish,
  ];
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const clampN = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/**
 * 提示卡放在哪（左上角）：没有目标时放在屏幕中间；否则优先放目标下面，放不下放上面，
 * 再不行放右边、左边；水平方向对齐目标中心，夹在屏幕里。都放不下（目标很大）时压在屏幕下部。
 */
export function placeCard(target: Rect | null, card: { w: number; h: number }, vp: { w: number; h: number }, gap = 14): { x: number; y: number; side: "center" | "below" | "above" | "right" | "left" | "over" } {
  const maxX = Math.max(gap, vp.w - card.w - gap);
  const maxY = Math.max(gap, vp.h - card.h - gap);
  if (!target) return { x: clampN((vp.w - card.w) / 2, gap, maxX), y: clampN((vp.h - card.h) / 2, gap, maxY), side: "center" };
  const cx = clampN(target.x + target.w / 2 - card.w / 2, gap, maxX);
  const cy = clampN(target.y + target.h / 2 - card.h / 2, gap, maxY);
  const below = target.y + target.h + gap;
  if (below + card.h <= vp.h - gap) return { x: cx, y: below, side: "below" };
  const above = target.y - gap - card.h;
  if (above >= gap) return { x: cx, y: above, side: "above" };
  const right = target.x + target.w + gap;
  if (right + card.w <= vp.w - gap) return { x: right, y: cy, side: "right" };
  const left = target.x - gap - card.w;
  if (left >= gap) return { x: left, y: cy, side: "left" };
  return { x: cx, y: maxY, side: "over" };
}

/** 目标超出屏幕时，高亮框只画屏幕里看得见的那部分 */
export function visibleRect(r: Rect, vp: { w: number; h: number }): Rect {
  const x = clampN(r.x, 0, vp.w);
  const y = clampN(r.y, 0, vp.h);
  const right = clampN(r.x + r.w, 0, vp.w);
  const bottom = clampN(r.y + r.h, 0, vp.h);
  return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) };
}
