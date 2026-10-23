# Changelog

The full history (English and 中文) is in the README. Highlights:

## 未发布

- 看板重新设计：页首一句话总结本周写作；今日写作卡加入本周七天（圆点和柱状可在卡片上切换，也可在设置里改）和今天动过的笔记；任务卡改为“接下来”，逾期单独列出，列表可以展开。
- 数据卡改为笔记、总字数、任务完成率、本月写作；鼠标停在走势线上（或聚焦后按左右方向键）会把主数字换成那一周的数值。
- 热力图占满一行，最多显示一年；趋势卡改为“每周写作”，半年和一年按周汇总，附合计、平均和最高一周。
- 新增“库体检”：断链、孤立笔记、重复内容、空笔记和超大笔记，每项可以直接处理；删除空笔记会先确认，并进回收站。原“链接”卡和看板底部的重复内容入口合并进来。
- 样式改用一套设计令牌（7 级字号、4 种圆角、固定阴影和时长），渐变统一为强调色到玫瑰色；新增 `npm run check:tokens` 检查。
- 英文界面：看板、设置、提示、写作报告、字数属性和重复内容清理都有中英两种语言，所有用户（包括老用户）默认跟随 Obsidian 的界面语言，也可以在设置 → 刷新与行为 → 界面语言里指定。Obsidian 是英文界面的老用户升级后会看到英文，需要中文请在这里选“中文”。英文下大数字写作 12K / 1.5M。英文生成的报告笔记标题和 type 是 Weekly / Monthly writing report，看板的“上次生成”中英两种报告都认。
- 新增本地预览：`node scripts/preview/build.mjs`，用示例数据在浏览器里渲染真实的看板代码。
- 修复：常用标签、库体检展开后收不回去（标签卡收起后仍停在展开时的高度；库体检只要还有一栏开着整张卡就不缩）。
- 展开的列表改为卡片内限高滚动（约 8 行），“收起”就在列表下面，整页不再被拉长；库体检一次只展开一栏。热力图当天详情里“还有 N 篇”改为可以展开。
- 新增动效（设置 → 刷新与行为 → 动效，默认开）：打开看板时卡片依次浮现，数字从 0 滚到当前值，圆环、进度条、条形和柱子长出来，走势线从左到右描出，热力图逐列浮现；切换标签页和范围时内容淡入、选中底色滑过去、卡片高度平滑过渡；自动刷新只让变了的数字滚动并短暂高亮。系统开了“减弱动态效果”时全部关闭。

## 1.5.1

- 重设计看板「写作回顾」桌面布局：卡片宽度约 700px 起，周报、月报变为等宽双面板，头部操作右对齐；总字数、柔和涨跌胶囊、打卡和带标签的周目标统一对齐，展开明细以小统计块呈现。按卡片自身宽度适配侧栏及手机堆叠布局，兼容亮暗主题；统一统计数值颜色与字重，月报补充本月进度、进度条及已过天数；桌面双面板等高，标题行共享展开/收起并记住状态，兼容迁移旧的独立状态。周目标为 0 时隐藏，保留最近报告链接及共享统计逻辑。
- 重设计写作周报和月报：原生属性、概览 callout、每日打卡与字数表、前五篇笔记和标签表，修改列表及统计说明可折叠。统一千分位和整数百分比，区分未来日期，统计口径保持不变。
- 预览采用柔和紫色卡片，适配亮色、暗色和手机；期间清晰、正文独立滚动，底部固定取消与写入按钮，同名文件仍可覆盖或另存。
- 补充报告呈现和边界测试；运行 `npm run sample:report` 可生成可复现的周报和月报示例。最低 Obsidian 版本保持 1.7.2。

## 1.5.0

- Weekly writing goal (1500 words by default; 0 disables it), Monday–Sunday progress and weekly check-in count in Today's writing. Existing settings migrate automatically.
- Writing weekly/monthly reports via commands and a small dashboard card, with current/previous period selection, preview before saving, optional note links, and explicit overwrite or save-as-new choices.
- Reports reuse dashboard word counts, check-ins and new-note counts, and include the longest note, common tags and previous-period changes. Reports explain estimated history and the limitations of last-modified timestamps.
- New report folder setting (default `Note Pulse`). Minimum Obsidian version remains 1.7.2.

## 1.4.0

- Clip Dedupe is merged into Note Pulse as **Duplicate cleanup / 重复内容清理**: its own tab, a ribbon icon, commands, and a subtle entry card on the dashboard.
- The beginner flow is unchanged: welcome screen with three steps, plain wording, preview before every change, undo, help, advanced options collapsed.
- New settings group with an on/off switch and a switch for the dashboard card. Existing settings are preserved; settings from a standalone Clip Dedupe install are imported once (read only).
- Clip Dedupe's tests now run in this repo (86 tests in total).

## 1.3.0

- Word count properties for Bases (off by default).
