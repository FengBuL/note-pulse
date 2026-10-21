# Changelog

The full history (English and 中文) is in the README. Highlights:

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
