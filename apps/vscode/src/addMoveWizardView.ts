import type * as vscode from "vscode";
import type { SkillAssetTreeMeta, SkillTreeFilterMode, ToolType } from "./types";
import { localize, type UiLanguage } from "./uiLanguage";
import { createWebviewNonce, renderWebviewL10nRuntime } from "./webviewCommon";
import { renderWebviewClientCommonScript } from "./webviewClientCommon";
import { renderWebviewCommonStyles } from "./webviewCommonStyles";

export type AddMoveWizardPayload = {
  workspace: {
    total: number;
    changed: number;
    fresh: number;
    risk: number;
    missing: number;
    recent: number;
    preview: Array<{ tool: ToolType; skillName: string; status: SkillAssetTreeMeta["status"]; warnings: number; fileCount: number }>;
  };
  central: {
    total: number;
    changed: number;
    fresh: number;
    risk: number;
    missing: number;
    recent: number;
    preview: Array<{ tool: ToolType; skillName: string; status: SkillAssetTreeMeta["status"]; warnings: number; fileCount: number }>;
  };
  activeFilter: SkillTreeFilterMode;
  language: UiLanguage;
};

export function renderAddMoveWizardHtml(
  webview: vscode.Webview,
  payload: AddMoveWizardPayload
): string {
  void webview;
  const nonce = createWebviewNonce();
  const initial = JSON.stringify(payload).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="${payload.language}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${localize("Add or Move Helper")}</title>
  <style>
    ${renderWebviewCommonStyles()}
    body { margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    .wrap { padding: 8px 10px; display: grid; gap: 7px; }
    .head { display: flex; justify-content: space-between; gap: 8px; align-items: flex-start; }
    .head-actions { display: flex; gap: 5px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
    h1 { margin: 0; font-size: 16px; font-weight: 700; }
    .muted { color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.35; }
    .actions { display: grid; grid-template-columns: repeat(auto-fit, minmax(172px, 1fr)); gap: 5px; }
    .action { text-align: left; border: 1px solid var(--vscode-panel-border); color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); border-radius: 5px; padding: 6px 8px; display: grid; gap: 2px; cursor: pointer; min-height: 0; transition: border-color 120ms ease, background 120ms ease, transform 120ms ease; }
    .action:hover { background: var(--vscode-list-hoverBackground); border-color: var(--vscode-focusBorder); }
    .action:focus-visible, button.ghost:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .action:active { transform: translateY(1px); }
    .action.pending { border-color: var(--sb-accent); background: var(--vscode-list-activeSelectionBackground); }
    button:disabled { opacity: .58; cursor: progress; }
    .action b { font-size: 13px; }
    .action span { font-size: 12px; color: var(--vscode-descriptionForeground); line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 6px; }
    .panel { border: 1px solid var(--vscode-panel-border); border-radius: 5px; overflow: hidden; }
    .panel-head { padding: 6px 8px; background: var(--vscode-sideBar-background); display: flex; justify-content: space-between; gap: 6px; align-items: center; }
    .panel-head b { font-size: 13px; }
    .metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: var(--vscode-panel-border); }
    .metric { background: var(--vscode-editor-background); padding: 5px 7px; }
    .metric .k { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .metric .v { font-size: 14px; font-weight: 700; }
    .preview { padding: 5px 7px; display: grid; gap: 4px; max-height: 128px; overflow: auto; scrollbar-gutter: stable; }
    .row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; align-items: center; font-size: 12px; }
    .row-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chip { display: inline-flex; align-items: center; border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 2px 7px; font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
    .status-new { color: var(--sb-success); border-color: var(--sb-success); }
    .status-changed { color: var(--sb-warning); border-color: var(--sb-warning); }
    .status-risk, .status-missingSkillMd { color: var(--sb-danger); border-color: var(--sb-danger); }
    .status-recent { color: var(--sb-accent); border-color: var(--sb-accent); }
    .foot { display: flex; justify-content: space-between; gap: 8px; align-items: center; }
    button.ghost { border: 1px solid var(--vscode-input-border); color: var(--vscode-input-foreground); background: var(--vscode-input-background); border-radius: 4px; padding: 4px 8px; cursor: pointer; }
    .feedback { border: 1px solid var(--vscode-panel-border); border-radius: 5px; padding: 5px 7px; font-size: 12px; }
    .feedback.info { border-color: var(--vscode-panel-border); color: var(--vscode-descriptionForeground); }
    .feedback.warn { border-color: var(--sb-warning); color: var(--sb-warning); }
    .feedback.error { border-color: var(--sb-danger); color: var(--sb-danger); }
  </style>
</head>
<body>
  <div class="wrap sb-root">
    <div class="head sb-topbar">
      <div>
        <h1 id="title"></h1>
        <div id="subtitle" class="muted"></div>
      </div>
      <div class="head-actions">
        <button id="refresh" class="ghost" type="button"></button>
      </div>
    </div>
    <div class="actions">
      <button class="action" data-action="newSkill" type="button"><b></b><span></span></button>
      <button class="action" data-action="promoteAsset" type="button"><b></b><span></span></button>
      <button class="action" data-action="importAsset" type="button"><b></b><span></span></button>
      <button class="action" data-action="hydrateProject" type="button"><b></b><span></span></button>
      <button class="action" data-action="downloadCentralSkill" type="button"><b></b><span></span></button>
      <button class="action" data-action="downloadSkillManagerSkill" type="button"><b></b><span></span></button>
      <button class="action" data-action="createPack" type="button"><b></b><span></span></button>
      <button class="action" data-action="copyAgent" type="button"><b></b><span></span></button>
      <button class="action" data-action="installNpx" type="button"><b></b><span></span></button>
    </div>
    <div class="grid">
      <div class="panel" id="workspacePanel"></div>
      <div class="panel" id="centralPanel"></div>
    </div>
    <div id="feedback" class="feedback sb-status-bar info"></div>
    <div class="foot">
      <div class="muted" id="filterLabel"></div>
    </div>
  </div>
  <script nonce="${nonce}">
    ${renderWebviewClientCommonScript()}
    const vscode = acquireVsCodeApi();
    let state = ${initial};
    const ui = {
      title: document.getElementById("title"),
      subtitle: document.getElementById("subtitle"),
      workspace: document.getElementById("workspacePanel"),
      central: document.getElementById("centralPanel"),
      feedback: document.getElementById("feedback"),
      filterLabel: document.getElementById("filterLabel"),
      refresh: document.getElementById("refresh")
    };
    const uiState = { busy:false, action:"" };
    const copy = {
        title: "Add or Move Helper",
        subtitle: "Create, bring, save, and move skills after checking risk signals first.",
        refresh: "Refresh",
        initialFeedback: "Choose an action. VS Code prompts and the pre-transfer review will open next.",
        busyFeedback: "A task is already opening. Check the VS Code prompt.",
        refreshing: "Refreshing skill assets...",
        openingPrompt: "Opening",
        nextStep: "Next step",
        filterPrefix: "Current tree filter:",
        skillCount: "skills",
        fileCount: "files",
        warningCount: "warnings",
        emptySkills: "No skills to show.",
        metricChanged: "Changed",
        metricNew: "New",
        metricRisk: "Warnings",
        metricMissing: "Missing SKILL.md",
        metricRecent: "Recent",
        metricShown: "Shown",
        workspacePanel: "Workspace",
        centralPanel: "Central",
        statusNew: "New skill",
        statusChanged: "Changed",
        statusRisk: "Warning",
        statusMissing: "Missing SKILL.md",
        statusRecent: "Recent",
        statusSame: "Same",
        filterAll: "All",
        filterChanged: "Changed",
        filterNew: "New",
        filterRisk: "Warnings",
        filterMissing: "Missing SKILL.md",
        filterRecent: "Recent",
        actions: {
          newSkill: ["Create New Skill", "Choose a target agent and create skills/<name>/SKILL.md."],
          promoteAsset: ["Save to Central", "Review one workspace skill before saving it to the central library."],
          importAsset: ["Bring to Workspace", "Review one central skill before applying it to this workspace."],
          hydrateProject: ["Apply Preset to Workspace", "Apply a saved project preset or selected Central skills to this project."],
          downloadCentralSkill: ["Bring Central Skill to Workspace", "Search the central library and apply a skill to a workspace agent folder."],
          downloadSkillManagerSkill: ["Install Skill Manager Helper", "Apply the bundled skill-manager skill from this extension to the current workspace."],
          createPack: ["Create Preset from Central Skills", "Save selected Central skills as a reusable preset for a project type."],
          copyAgent: ["Copy to Another Agent", "Copy a skill between Claude, Codex, .agents, or another agent within Workspace or Central."],
          installNpx: ["Install from npx", "Open the existing install flow, then continue to review and apply changes."]
      }
    };
    ${renderWebviewL10nRuntime()}
    function copyText(key){ return t(copy[key] ?? key); }
    function actionLabel(action){
      const pair = copy.actions[action];
      return pair ? t(pair[0]) : action;
    }
    function esc(v){ return String(v ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;"); }
    function labelStatus(status){
      if (status === "new") return copyText("statusNew");
      if (status === "changed") return copyText("statusChanged");
      if (status === "risk") return copyText("statusRisk");
      if (status === "missingSkillMd") return copyText("statusMissing");
      if (status === "recent") return copyText("statusRecent");
      return copyText("statusSame");
    }
    function labelFilterMode(mode){
      if (mode === "changed") return copyText("filterChanged");
      if (mode === "new") return copyText("filterNew");
      if (mode === "risk") return copyText("filterRisk");
      if (mode === "missingSkillMd") return copyText("filterMissing");
      if (mode === "recent") return copyText("filterRecent");
      return copyText("filterAll");
    }
    function setFeedback(message, tone){
      ui.feedback.textContent = message || copyText("initialFeedback");
      ui.feedback.className = "feedback " + (tone || "info");
    }
    function setBusy(busy, action){
      uiState.busy = !!busy;
      uiState.action = busy ? String(action || "") : "";
      document.querySelectorAll("button").forEach((button) => {
        button.disabled = uiState.busy;
        button.classList.toggle("pending", uiState.busy && button.dataset.action === uiState.action);
      });
    }
    function renderSide(title, data){
      const rows = data.preview.map(item => '<div class="row"><div class="row-name" title="' + esc(item.tool + "/" + item.skillName) + '">' + esc(item.tool) + ' / ' + esc(item.skillName) + '</div><span class="chip status-' + esc(item.status) + '">' + esc(labelStatus(item.status)) + ' · ' + esc(copyText("fileCount")) + ' ' + item.fileCount + (item.warnings ? ' · ' + esc(copyText("warningCount")) + ' ' + item.warnings : '') + '</span></div>').join("");
      return '<div class="panel-head"><b>' + esc(title) + '</b><span class="chip">' + data.total + ' ' + esc(copyText("skillCount")) + '</span></div>'
        + '<div class="metrics">'
        + '<div class="metric"><div class="k">' + esc(copyText("metricChanged")) + '</div><div class="v">' + data.changed + '</div></div>'
        + '<div class="metric"><div class="k">' + esc(copyText("metricNew")) + '</div><div class="v">' + data.fresh + '</div></div>'
        + '<div class="metric"><div class="k">' + esc(copyText("metricRisk")) + '</div><div class="v">' + data.risk + '</div></div>'
        + '<div class="metric"><div class="k">' + esc(copyText("metricMissing")) + '</div><div class="v">' + data.missing + '</div></div>'
        + '<div class="metric"><div class="k">' + esc(copyText("metricRecent")) + '</div><div class="v">' + data.recent + '</div></div>'
        + '<div class="metric"><div class="k">' + esc(copyText("metricShown")) + '</div><div class="v">' + data.preview.length + '</div></div>'
        + '</div><div class="preview">' + (rows || '<div class="muted">' + esc(copyText("emptySkills")) + '</div>') + '</div>';
    }
    function render(){
      ui.title.textContent = copyText("title");
      ui.subtitle.textContent = copyText("subtitle");
      ui.refresh.textContent = copyText("refresh");
      document.querySelectorAll(".action").forEach((button) => {
        const action = button.dataset.action || "";
        const pair = copy.actions[action];
        const title = button.querySelector("b");
        const body = button.querySelector("span");
        if (title && pair) title.textContent = t(pair[0]);
        if (body && pair) body.textContent = t(pair[1]);
      });
      ui.workspace.innerHTML = renderSide(copyText("workspacePanel"), state.workspace);
      ui.central.innerHTML = renderSide(copyText("centralPanel"), state.central);
      ui.filterLabel.textContent = copyText("filterPrefix") + " " + labelFilterMode(state.activeFilter);
      if (!ui.feedback.textContent) setFeedback("");
    }
    document.body.addEventListener("click", (event) => {
      const source = event.target;
      const el = source instanceof Element ? source.closest("button") : null;
      if (!(el instanceof HTMLButtonElement)) return;
      if (uiState.busy) {
        setFeedback(copyText("busyFeedback"), "warn");
        return;
      }
      if (el.id === "refresh") {
        setBusy(true, "refresh");
        setFeedback(copyText("refreshing"));
        vscode.postMessage({ type: "refresh" });
        return;
      }
      const action = el.dataset.action;
      if (!action) return;
      setBusy(true, action);
      setFeedback((actionLabel(action) || copyText("nextStep")) + " - " + copyText("openingPrompt") + "...");
      vscode.postMessage({ type: action });
    });
    window.addEventListener("message", (event) => {
      const message = event.data || {};
      if (message.type === "state") {
        state = message.payload;
        render();
      }
      if (message.type === "ui") {
        const payload = message.payload || {};
        if (typeof payload.busy === "boolean") {
          setBusy(payload.busy, payload.action || "");
        }
        setFeedback(payload.message || "", payload.tone || "info");
      }
    });
    setFeedback(copyText("initialFeedback"), "info");
    render();
  </script>
</body>
</html>`;
}
