const manifest = require("../apps/vscode/package.json");

const items = manifest.contributes?.menus?.["view/item/context"] ?? [];
const commands = new Set(items.map((item) => item.command).filter(Boolean));

const required = [
  "skillBridge.menu.en.smartWorkspaceActions",
  "skillBridge.menu.ko.smartWorkspaceActions",
  "skillBridge.menu.en.promoteSelected",
  "skillBridge.menu.ko.promoteSelected",
  "skillBridge.menu.en.importSelected",
  "skillBridge.menu.ko.importSelected",
  "skillBridge.menu.en.openGroupOverview",
  "skillBridge.menu.ko.openGroupOverview",
  "skillBridge.menu.en.workspaceGroupActions",
  "skillBridge.menu.ko.workspaceGroupActions",
  "skillBridge.menu.en.centralGroupActions",
  "skillBridge.menu.ko.centralGroupActions"
];

const submenuOnly = [
  "openWorkspaceFolder",
  "openCentralFolder",
  "copyWorkspaceNodePath",
  "copyCentralNodePath",
  "createProjectPresetFromWorkspace",
  "showWorkspaceWarningReasons",
  "showCentralWarningReasons",
  "copyWorkspaceBetweenAgents",
  "copyCentralBetweenAgents",
  "renameGroup",
  "editGroupDescription",
  "deleteGroup",
  "copyWorkspaceGroupBetweenAgents",
  "copyCentralGroupBetweenAgents",
  "createProjectPresetFromWorkspaceGroup"
].flatMap((name) => [`skillBridge.menu.en.${name}`, `skillBridge.menu.ko.${name}`]);

const missing = required.filter((command) => !commands.has(command));
const duplicated = submenuOnly.filter((command) => commands.has(command));

if (missing.length > 0 || duplicated.length > 0) {
  if (missing.length > 0) console.error(`[context-menu-density] Missing core actions: ${missing.join(", ")}`);
  if (duplicated.length > 0) console.error(`[context-menu-density] Secondary actions exposed directly: ${duplicated.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("[context-menu-density] OK. Core actions stay direct and secondary actions stay in grouped flows.");
}
