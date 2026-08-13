# Changelog

All notable changes to the Skill Bridge VS Code extension are documented here.

## 0.2.36 - 2026-08-13

### Added

- Added a hierarchical change-review table that groups file changes under collapsible skill folders.
- Added parent, child, and partial-selection states so folder and file choices remain consistent.
- Added separate selected-skill and selected-file counts to remove duplicate folder/file totals.
- Added visible webview error reporting with line and column details, plus matching Skill Bridge output logs.
- Added a packaging check that parses generated webview scripts and exercises review-screen error and hierarchy behavior.

### Changed

- Improved initial refresh responsiveness by moving file fingerprint collection out of the visible refresh path.
- Reduced repeated tree rebuilds by applying related provider state in a single update.
- Changed review risk summaries and AI review input to count effective skill/file changes instead of duplicate folder summaries.
- Changed search and status filtering to retain the parent skill context while showing matching files.

### Fixed

- Fixed a generated change-review script syntax error that could leave the screen stuck on its initial loading state.
- Fixed confusing review totals where folder summary rows and their child files were counted as separate apply targets.
- Preserved watcher correctness by waiting for the latest background fingerprint before evaluating file-system events.
