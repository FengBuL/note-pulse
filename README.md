# Note Pulse

**English** | [中文](#中文说明)

Note Pulse is an [Obsidian](https://obsidian.md) plugin that opens a dashboard of your vault in one view: today's writing and streak, note and word count trends, a writing heatmap, task completion, and tag, folder and link stats.

The UI is in Chinese. It follows your light or dark theme, has no external dependencies (all charts are plain SVG), and works on desktop and mobile.

![Note Pulse, dark theme](docs/preview-dark.png)

<details>
<summary>Light theme</summary>

![Note Pulse, light theme](docs/preview-light.png)

</details>

> Screenshots are rendered with sample data.

## Features

| Panel | What it shows |
| --- | --- |
| Today's writing | Progress ring for today's words vs. your daily goal, current streak, last 7 days, longest streak, check-in days in the past year, daily notes this month |
| Stat cards | Total notes and total words (with 30-day change and a 12-week sparkline), task completion rate (with overdue count), total links (with orphan notes and connectivity) |
| Writing heatmap | Recent weeks sized to the view width; hover for words written and notes changed or created; click a day to list notes modified that day |
| Growth trend | Cumulative words or new notes, over 30 days, 90 days or 1 year, with hover values |
| Tasks | Done, open, overdue and due within 7 days; due list jumps straight to the task line; open tasks by folder or by note. Understands `📅 YYYY-MM-DD`, `⏳` and `[due:: ]`; `- [-]` counts as cancelled |
| Tags and folders | Most used tags (click to search), note and word counts per top-level folder (click to reveal) |
| Links | Linked notes, orphan notes, unresolved links; lists of most linked notes, orphans and common unresolved links |

Every note in the dashboard is clickable. The dashboard refreshes automatically (debounced) when your vault changes, and only computes while it is open. Tags, links and tasks come from Obsidian's metadata cache; word counts are cached by modification time, so later refreshes only re-read changed files.

## Installation

### From Community plugins (after approval)

1. Open **Settings → Community plugins → Browse**.
2. Search for **Note Pulse**, then install and enable it.

### Manual

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/FengBuL/note-pulse/releases/latest).
2. Put them in `<your vault>/.obsidian/plugins/note-pulse/`.
3. Reload Obsidian and enable **Note Pulse** under **Settings → Community plugins**.

### Usage

Click the dashboard icon in the left ribbon, or run the command **打开看板** (Open dashboard) from the command palette. Use **刷新看板数据** (Refresh dashboard) to recompute.

## Settings

| Setting | Description |
| --- | --- |
| Excluded folders | Notes in these folders are ignored, one per line or comma separated |
| Daily notes folder | Notes named `YYYY-MM-DD` here count as daily notes; leave empty to search the whole vault |
| Daily word goal | A day counts toward your streak when it reaches this many words (or has a daily note); 0 means any writing counts |
| Heatmap mode | **By modified date**: a note's full word count goes to the day it was last modified (works immediately, rough). **By daily added words**: records word deltas from the day you enable it (more accurate) |
| Created date fields | Frontmatter fields such as `created: 2025-01-01` used as the creation date, useful when sync resets file times |
| Auto refresh and delay | Refresh after vault changes, and the debounce delay |
| Open notes in new tab | Keep the dashboard open when you click a note |

## Notes and limits

- Word counts are approximate. Frontmatter, code blocks, comments, URLs, embeds and Markdown syntax are removed; each CJK character counts as one word, other languages are counted by words.
- Creation time defaults to the file's ctime, which sync tools (iCloud, Git, …) may reset. Add a `created` frontmatter field for accurate trends.
- The cumulative word trend assigns each note's current word count to its creation date. It is not a historical snapshot.
- Dates use your local time zone.
- Clicking a tag needs the core **Search** plugin enabled.
- The plugin reads your notes locally only. It makes no network requests and collects no data.

## Development

```bash
npm install
npm run dev     # watch build
npm run build   # type check + production build -> main.js
```

```
src/
├── main.ts      # entry: view, commands, ribbon icon, auto refresh, persistence
├── view.ts      # dashboard view and panels
├── stats.ts     # statistics (words, tasks, links, tags, folders, daily notes)
├── charts.ts    # SVG charts: trend, sparkline, ring, bar list, tooltip
└── settings.ts  # settings tab
```

To release, run `npm version <patch|minor|major>` (updates `manifest.json` and `versions.json`), run `npm run build`, then create a GitHub release whose tag matches the version (no `v` prefix) and attach `main.js`, `manifest.json` and `styles.css`.

## License

[MIT](LICENSE) © FengBuL

---

## 中文说明

Note Pulse（笔记脉搏）是一个 Obsidian 插件，在一个页面里集中展示你仓库的各项数据：今日写作与连续打卡、笔记与字数趋势、写作热力图、任务完成情况，以及标签、文件夹和链接统计。

界面为中文，自动适配明暗主题，没有任何外部依赖（图表均为原生 SVG），桌面端和移动端都能用。

### 功能

| 区块 | 内容 |
| --- | --- |
| 今日写作 | 今日字数与每日目标的进度环、当前连续打卡天数、近 7 天打卡、最长连续、近一年打卡天数、本月日记数 |
| 指标卡 | 笔记总数、总字数（带近 30 天变化和近 12 周迷你折线）、任务完成率（含逾期数）、链接总数（含孤立笔记数和连通率） |
| 写作热力图 | 按看板宽度显示最近若干周；悬停查看当天写作字数、修改和新建笔记数；点击格子查看当天修改过的笔记 |
| 增长趋势 | 累计字数或新建笔记数，范围 30 天、90 天、1 年，悬停查看数值 |
| 任务 | 已完成、未完成、已逾期、7 天内到期；到期列表点击直接跳到任务所在行；可按文件夹或笔记查看未完成任务。识别 `📅 YYYY-MM-DD`、`⏳`、`[due:: ]`，`- [-]` 视为已取消 |
| 标签 / 文件夹 | 标签使用排行（点击搜索）、各顶层文件夹的笔记数和字数（点击在文件列表中定位） |
| 链接 | 已连接笔记、孤立笔记、未解析链接；最常被链接、孤立笔记、常见未解析链接三个列表 |

看板中的笔记都可以点击打开。仓库内容变化后会自动刷新（带防抖，只在看板打开时计算）。

### 安装

**插件市场（审核通过后）：** 打开「设置 → 第三方插件 → 浏览」，搜索 **Note Pulse**，安装并启用。

**手动安装：**

1. 从 [最新 Release](https://github.com/FengBuL/note-pulse/releases/latest) 下载 `main.js`、`manifest.json`、`styles.css`。
2. 放进 `<你的仓库>/.obsidian/plugins/note-pulse/`（`.obsidian` 是隐藏文件夹，Mac 上按 `Cmd+Shift+.` 显示）。
3. 重启 Obsidian，在「设置 → 第三方插件」中启用 **Note Pulse**。

**使用：** 点左侧边栏的看板图标，或在命令面板运行「打开看板」。

### 设置项

| 设置 | 说明 |
| --- | --- |
| 排除的文件夹 | 其中的笔记不参与统计，每行一个或用逗号分隔 |
| 日记文件夹 | 文件名为 `YYYY-MM-DD` 的笔记视为日记；留空则在整个仓库中识别 |
| 每日字数目标 | 当天字数达到目标即算打卡（写了日记也算）；设为 0 表示有写作就算 |
| 写作热力图统计方式 | **按修改日**：笔记全文字数计入最后修改的那天（立即可用，但较粗略）；**按每日新增字数**：从启用之日起记录增量，更准确 |
| 创建日期字段名 | frontmatter 中的 `created: 2025-01-01` 等字段优先作为创建日期，适合同步后文件时间不准的情况 |
| 自动刷新 / 延迟 | 内容变化后自动刷新及防抖时间 |
| 在新标签页打开笔记 | 点击看板中的笔记时是否新开标签页 |

### 说明与限制

- 字数是近似值：去除 frontmatter、代码块、注释、URL、嵌入和 Markdown 符号；中日韩文字每字计 1，其他语言按单词计。
- 创建时间默认取文件 ctime，iCloud、Git 等同步可能会重置它，建议在 frontmatter 写 `created` 字段。
- 累计字数趋势是把每篇笔记“当前”字数计入其创建日期，并非历史快照。
- 日期使用本机时区。点击标签需要启用核心插件「搜索」。
- 插件只在本地读取笔记，不联网，不收集任何数据。

### 许可证

[MIT](LICENSE) © FengBuL
