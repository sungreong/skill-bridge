import * as vscode from "vscode";

export function applySkillBridgePanelBranding(panel: vscode.WebviewPanel, extensionUri: vscode.Uri): void {
  panel.iconPath = vscode.Uri.joinPath(extensionUri, "resources", "skill-bridge-tab-icon.png");
}
