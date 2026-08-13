import * as vscode from "vscode";

export const UI_LANGUAGES = ["en", "ko"] as const;

export type UiLanguage = (typeof UI_LANGUAGES)[number];

export type TranslationFn = typeof vscode.l10n.t;

export const localize: TranslationFn = vscode.l10n.t;

export function getUiLanguage(): UiLanguage {
  return vscode.env.language.toLowerCase().startsWith("ko") ? "ko" : "en";
}

export function getWebviewL10nBundle(): Readonly<Record<string, string>> {
  return vscode.l10n.bundle ?? {};
}
