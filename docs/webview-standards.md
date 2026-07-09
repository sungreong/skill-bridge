# Skill Bridge Webview Standards

Skill Bridge webviews stay lightweight: no React, no Astryx, no Tailwind, and no separate browser build pipeline. Webviews are still rendered from TypeScript strings, but they must share a small internal standard so screens feel like one product.

## Required Structure

- Use `createWebviewNonce()` for script nonces.
- Use `renderWebviewCommonStyles()` in every webview stylesheet.
- Use the `sb-` prefix for shared layout and component classes.
- Keep existing command ids and webview message types stable.
- Prefer splitting long webviews into `*View.ts`, `*Styles.ts`, and `*ClientScript.ts` once a file approaches 500 lines.

## Layout

- The top-level wrapper must include `sb-root`.
- Interactive screens must provide one bottom status element with `class="sb-status-bar info"`.
- New screens should use `id="statusLine"`; existing screens may keep legacy ids such as `feedback` when changing the id would risk breaking local DOM wiring.
- Main table/list areas must use `min-height: 0` and `overflow: auto`.
- A screen should have one primary scroll region whenever possible.

## Shared Classes

Use these shared classes before adding screen-specific CSS:

- `sb-topbar`, `sb-toolbar`
- `sb-panel`, `sb-panel-head`, `sb-table-wrap`
- `sb-status-bar`
- `sb-button`, `sb-button-primary`, `sb-button-danger`, `sb-button-ghost`
- `sb-badge`, `sb-chip`
- `sb-muted`, `sb-empty`

Screen-specific classes may remain, but they should refine layout only. Do not redefine the same button, badge, panel, and status styling in every file.

## Busy And Status Contract

- Extension-to-webview UI updates use `{ busy?: boolean; message?: string; tone?: "info" | "warn" | "error"; action?: string }`.
- Busy work must disable relevant buttons and inputs.
- Completion and failure must update the screen's single `sb-status-bar` element.
- Use modal VS Code prompts only for destructive confirmation.

## CSP

- Webviews must include `default-src 'none'`.
- Script-enabled screens must use nonce-based scripts.
- Script-disabled/read-only screens must use `script-src 'none'`.
- Inline styles are currently allowed because this project intentionally keeps webview rendering string-based.

## Avoid

- Do not introduce React, Astryx, Tailwind, Redux, or another state library for these webviews.
- Do not place status messages in arbitrary cards or alert boxes when the screen already has a status bar.
- Do not add new one-off color palettes. Prefer `--vscode-*` variables and the common `sb-` classes.
- Do not keep growing a webview file past the line limit; split style/script/render helpers.
