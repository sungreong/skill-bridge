import type * as vscode from "vscode";
import type { SkillAssetTreeMeta, SkillTreeFilterMode, ToolType } from "./types";
import type { UiLanguage } from "./uiLanguage";

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
  const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const initial = JSON.stringify(payload).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="${payload.language}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${payload.language === "ko" ? "스킬 추가/이동 도우미" : "Add or Move Helper"}</title>
  <style>
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
    .action.pending { border-color: #60a5fa; background: color-mix(in oklab, var(--vscode-button-secondaryBackground) 78%, #60a5fa 22%); }
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
    .status-new { color: #4ade80; border-color: #22c55e; }
    .status-changed { color: #fbbf24; border-color: #f59e0b; }
    .status-risk, .status-missingSkillMd { color: #fb7185; border-color: #fb7185; }
    .status-recent { color: #60a5fa; border-color: #3b82f6; }
    .foot { display: flex; justify-content: space-between; gap: 8px; align-items: center; }
    button.ghost { border: 1px solid var(--vscode-input-border); color: var(--vscode-input-foreground); background: var(--vscode-input-background); border-radius: 4px; padding: 4px 8px; cursor: pointer; }
    .feedback { border: 1px solid var(--vscode-panel-border); border-radius: 5px; padding: 5px 7px; font-size: 12px; }
    .feedback.info { border-color: var(--vscode-panel-border); color: var(--vscode-descriptionForeground); }
    .feedback.warn { border-color: #f59e0b; color: #fbbf24; }
    .feedback.error { border-color: #fb7185; color: #fb7185; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="head">
      <div>
        <h1 id="title"></h1>
        <div id="subtitle" class="muted"></div>
      </div>
      <div class="head-actions">
        <button id="languageToggle" class="ghost" type="button"></button>
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
    <div id="feedback" class="feedback"></div>
    <div class="foot">
      <div class="muted" id="filterLabel"></div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let state = ${initial};
    const ui = {
      title: document.getElementById("title"),
      subtitle: document.getElementById("subtitle"),
      workspace: document.getElementById("workspacePanel"),
      central: document.getElementById("centralPanel"),
      feedback: document.getElementById("feedback"),
      filterLabel: document.getElementById("filterLabel"),
      refresh: document.getElementById("refresh"),
      languageToggle: document.getElementById("languageToggle")
    };
    const uiState = { busy:false, action:"" };
    const copy = {
      en: {
        title: "Add or Move Helper",
        subtitle: "Create, bring, save, and move skills after checking risk signals first.",
        refresh: "Refresh",
        languageToggle: "한국어",
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
      },
      ko: {
        title: "스킬 추가/이동 도우미",
        subtitle: "스킬을 만들고, 작업공간으로 가져오고, 중앙에 반영하고, 다른 에이전트로 복사하기 전에 위험 신호를 먼저 확인합니다.",
        refresh: "새로고침",
        languageToggle: "English",
        initialFeedback: "작업을 선택하면 VS Code 입력창과 반영 전 검토 화면이 이어서 열립니다.",
        busyFeedback: "이미 작업을 여는 중입니다. VS Code 입력창을 확인하세요.",
        refreshing: "스킬 자산 목록을 새로고침하는 중입니다...",
        openingPrompt: "입력창을 여는 중입니다",
        nextStep: "다음 단계",
        filterPrefix: "현재 트리 필터:",
        skillCount: "스킬",
        fileCount: "파일",
        warningCount: "경고",
        emptySkills: "표시할 스킬이 없습니다.",
        metricChanged: "변경",
        metricNew: "새 스킬",
        metricRisk: "주의",
        metricMissing: "SKILL.md 없음",
        metricRecent: "최근",
        metricShown: "표시",
        workspacePanel: "작업공간",
        centralPanel: "중앙",
        statusNew: "새 스킬",
        statusChanged: "변경",
        statusRisk: "주의",
        statusMissing: "SKILL.md 없음",
        statusRecent: "최근",
        statusSame: "동일",
        filterAll: "전체",
        filterChanged: "변경",
        filterNew: "새 항목",
        filterRisk: "주의",
        filterMissing: "SKILL.md 없음",
        filterRecent: "최근",
        actions: {
          newSkill: ["새 스킬 만들기", "대상 에이전트를 고르고 skills/<name>/SKILL.md를 생성합니다."],
          promoteAsset: ["중앙에 반영", "작업공간의 스킬 하나를 반영 전 검토 화면에서 확인한 뒤 중앙에 반영합니다."],
          importAsset: ["작업공간으로 가져오기", "중앙 저장소의 스킬 하나를 반영 전 검토 화면에서 확인한 뒤 가져옵니다."],
          hydrateProject: ["프리셋을 작업공간에 적용", "프로젝트 프리셋이나 선택한 중앙 스킬을 현재 프로젝트에 가져옵니다."],
          downloadCentralSkill: ["중앙 스킬을 작업공간으로 가져오기", "중앙 라이브러리에서 검색해 작업공간 에이전트 폴더에 적용합니다."],
          downloadSkillManagerSkill: ["Skill Manager 도우미 설치", "확장에 번들된 skill-manager 스킬을 현재 작업공간에 적용합니다."],
          createPack: ["중앙 스킬로 프리셋 만들기", "선택한 중앙 스킬을 프로젝트 유형별 재사용 프리셋으로 저장합니다."],
          copyAgent: ["다른 에이전트로 복사", "작업공간 또는 중앙 안에서 Claude, Codex, .agents 등 다른 에이전트로 복사합니다."],
          installNpx: ["npx에서 설치", "기존 설치 흐름을 열고 설치 후 그룹/반영 검토로 이어갑니다."]
        }
      }
    };
    function lang(){ return state.language === "ko" ? "ko" : "en"; }
    function t(key){ return copy[lang()][key] ?? copy.en[key] ?? key; }
    function actionLabel(action){
      const pair = copy[lang()].actions[action] ?? copy.en.actions[action];
      return pair ? pair[0] : action;
    }
    function esc(v){ return String(v ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;"); }
    function labelStatus(status){
      if (status === "new") return t("statusNew");
      if (status === "changed") return t("statusChanged");
      if (status === "risk") return t("statusRisk");
      if (status === "missingSkillMd") return t("statusMissing");
      if (status === "recent") return t("statusRecent");
      return t("statusSame");
    }
    function labelFilterMode(mode){
      if (mode === "changed") return t("filterChanged");
      if (mode === "new") return t("filterNew");
      if (mode === "risk") return t("filterRisk");
      if (mode === "missingSkillMd") return t("filterMissing");
      if (mode === "recent") return t("filterRecent");
      return t("filterAll");
    }
    function setFeedback(message, tone){
      ui.feedback.textContent = message || t("initialFeedback");
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
      const rows = data.preview.map(item => '<div class="row"><div class="row-name" title="' + esc(item.tool + "/" + item.skillName) + '">' + esc(item.tool) + ' / ' + esc(item.skillName) + '</div><span class="chip status-' + esc(item.status) + '">' + esc(labelStatus(item.status)) + ' · ' + esc(t("fileCount")) + ' ' + item.fileCount + (item.warnings ? ' · ' + esc(t("warningCount")) + ' ' + item.warnings : '') + '</span></div>').join("");
      return '<div class="panel-head"><b>' + esc(title) + '</b><span class="chip">' + data.total + ' ' + esc(t("skillCount")) + '</span></div>'
        + '<div class="metrics">'
        + '<div class="metric"><div class="k">' + esc(t("metricChanged")) + '</div><div class="v">' + data.changed + '</div></div>'
        + '<div class="metric"><div class="k">' + esc(t("metricNew")) + '</div><div class="v">' + data.fresh + '</div></div>'
        + '<div class="metric"><div class="k">' + esc(t("metricRisk")) + '</div><div class="v">' + data.risk + '</div></div>'
        + '<div class="metric"><div class="k">' + esc(t("metricMissing")) + '</div><div class="v">' + data.missing + '</div></div>'
        + '<div class="metric"><div class="k">' + esc(t("metricRecent")) + '</div><div class="v">' + data.recent + '</div></div>'
        + '<div class="metric"><div class="k">' + esc(t("metricShown")) + '</div><div class="v">' + data.preview.length + '</div></div>'
        + '</div><div class="preview">' + (rows || '<div class="muted">' + esc(t("emptySkills")) + '</div>') + '</div>';
    }
    function render(){
      document.documentElement.lang = lang();
      ui.title.textContent = t("title");
      ui.subtitle.textContent = t("subtitle");
      ui.refresh.textContent = t("refresh");
      ui.languageToggle.textContent = t("languageToggle");
      document.querySelectorAll(".action").forEach((button) => {
        const action = button.dataset.action || "";
        const pair = copy[lang()].actions[action] ?? copy.en.actions[action];
        const title = button.querySelector("b");
        const body = button.querySelector("span");
        if (title && pair) title.textContent = pair[0];
        if (body && pair) body.textContent = pair[1];
      });
      ui.workspace.innerHTML = renderSide(t("workspacePanel"), state.workspace);
      ui.central.innerHTML = renderSide(t("centralPanel"), state.central);
      ui.filterLabel.textContent = t("filterPrefix") + " " + labelFilterMode(state.activeFilter);
      if (!ui.feedback.textContent) setFeedback("");
    }
    document.body.addEventListener("click", (event) => {
      const source = event.target;
      const el = source instanceof Element ? source.closest("button") : null;
      if (!(el instanceof HTMLButtonElement)) return;
      if (el.id === "languageToggle") {
        state = { ...state, language: lang() === "ko" ? "en" : "ko" };
        vscode.postMessage({ type: "setLanguage", payload: { language: state.language } });
        render();
        return;
      }
      if (uiState.busy) {
        setFeedback(t("busyFeedback"), "warn");
        return;
      }
      if (el.id === "refresh") {
        setBusy(true, "refresh");
        setFeedback(t("refreshing"));
        vscode.postMessage({ type: "refresh" });
        return;
      }
      const action = el.dataset.action;
      if (!action) return;
      setBusy(true, action);
      setFeedback((actionLabel(action) || t("nextStep")) + " - " + t("openingPrompt") + "...");
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
    setFeedback(t("initialFeedback"), "info");
    render();
  </script>
</body>
</html>`;
}
