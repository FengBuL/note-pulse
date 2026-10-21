# Changelog

The full history (English and 中文) is in the README. Highlights:

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
