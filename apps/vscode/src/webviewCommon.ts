import { getWebviewL10nBundle, type UiLanguage } from "./uiLanguage";

export type WebviewTone = "info" | "warn" | "error";

export type WebviewUiState = {
  busy?: boolean;
  message?: string;
  tone?: WebviewTone;
  action?: string;
};

export type RenderWebviewDocumentOptions = {
  language: UiLanguage;
  title: string;
  nonce: string;
  styles: string;
  body: string;
  script?: string;
  scriptsEnabled?: boolean;
};

export function createWebviewNonce(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function renderWebviewL10nRuntime(): string {
  const bundle = JSON.stringify(getWebviewL10nBundle()).replace(/</g, "\\u003c");
  return `
    const __skillBridgeL10n = ${bundle};
    function t(message, ...args) {
      const template = __skillBridgeL10n[message] || message;
      return template.replace(/\\{(\\d+)\\}/g, (_match, index) => String(args[Number(index)] ?? ""));
    }
  `;
}

export function renderWebviewDocument(options: RenderWebviewDocumentOptions): string {
  const scriptsEnabled = options.scriptsEnabled ?? !!options.script;
  const scriptPolicy = scriptsEnabled ? `script-src 'nonce-${options.nonce}';` : "script-src 'none';";
  const script = scriptsEnabled && options.script
    ? `\n  <script nonce="${options.nonce}">${options.script}</script>`
    : "";

  return `<!doctype html>
<html lang="${options.language}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; ${scriptPolicy}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(options.title)}</title>
  <style>${options.styles}</style>
</head>
<body>
${options.body}${script}
</body>
</html>`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}
