import * as vscode from "vscode";
import { MENU_COMMAND_ALIAS_PREFIX, MENU_COMMAND_ALIAS_TARGETS } from "./menuCommandAliases";
import type { UiLanguage } from "./uiLanguage";

type RegisterFn = <TArgs extends unknown[]>(id: string, callback: (...args: TArgs) => unknown) => void;

export async function setMenuLanguageContext(language: UiLanguage): Promise<void> {
  await vscode.commands.executeCommand("setContext", "skillBridge.isKoreanUi", language === "ko");
}

export function registerMenuCommandAliases(register: RegisterFn): void {
  for (const targetCommand of MENU_COMMAND_ALIAS_TARGETS) {
    const suffix = targetCommand.slice("skillBridge.".length);
    register(`${MENU_COMMAND_ALIAS_PREFIX}en.${suffix}`, async (...args: unknown[]) => {
      await vscode.commands.executeCommand(targetCommand, ...args);
    });
    register(`${MENU_COMMAND_ALIAS_PREFIX}ko.${suffix}`, async (...args: unknown[]) => {
      await vscode.commands.executeCommand(targetCommand, ...args);
    });
  }
}
