#!/usr/bin/env node

const path = require("node:path");
const vm = require("node:vm");
const esbuild = require("esbuild");

async function loadTransferManagerRenderer() {
  const vscodeRoot = path.resolve(__dirname, "..");
  const result = await esbuild.build({
    entryPoints: [path.join(vscodeRoot, "src", "transferManagerView.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    plugins: [{
      name: "mock-vscode",
      setup(build) {
        build.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "mock-vscode" }));
        build.onLoad({ filter: /.*/, namespace: "mock-vscode" }, () => ({
          loader: "js",
          contents: `
            export const l10n = { t: (message, ...args) => args.reduce((text, value, index) => text.replace("{" + index + "}", String(value)), message) };
            export const env = { language: "en" };
          `
        }));
      }
    }]
  });
  const RuntimeModule = module.constructor;
  const loaded = new RuntimeModule("transfer-manager-webview-check", module);
  loaded.filename = path.join(vscodeRoot, ".transfer-manager-webview-check.cjs");
  loaded.paths = module.paths;
  loaded._compile(result.outputFiles[0].text, loaded.filename);
  return loaded.exports.renderTransferManagerHtml;
}

function samplePlan() {
  return {
    mode: "workspaceToCentral",
    items: [{
      key: "claude:skills/example/SKILL.md",
      tool: "claude",
      relativePath: "skills/example/SKILL.md",
      status: "modified",
      entryKind: "file",
      selected: true,
      src: "source/SKILL.md",
      dst: "target/SKILL.md",
      srcMtime: null,
      dstMtime: null,
      srcSize: 10,
      dstSize: 12,
      reason: "Changed"
    }],
    summary: {
      addedCount: 0,
      removedCount: 0,
      modifiedCount: 1,
      typeChangedCount: 0,
      sameCount: 0,
      unchangedCount: 0
    }
  };
}

function verifyClientErrorBootstrap(script) {
  const listeners = new Map();
  const postedMessages = [];
  const errorElement = { hidden: true, textContent: "" };
  const window = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    }
  };
  vm.runInNewContext(script, {
    window,
    document: { getElementById: (id) => id === "fatalError" ? errorElement : null },
    acquireVsCodeApi: () => ({ postMessage: (message) => postedMessages.push(message) })
  });
  listeners.get("error")?.({ message: "Synthetic webview failure", lineno: 42, colno: 7 });
  if (errorElement.hidden || !errorElement.textContent.includes("Synthetic webview failure")) {
    throw new Error("Client errors are not rendered in the Transfer Manager webview.");
  }
  const report = postedMessages.find((message) => message?.type === "clientError");
  if (report?.payload?.line !== 42 || report?.payload?.column !== 7) {
    throw new Error("Client error details are not reported to the extension host.");
  }
}

function verifyHierarchyRuntime(scripts) {
  class MockElement {
    constructor(id = "") {
      this.id = id;
      this.dataset = {};
      this.listeners = new Map();
      this.innerHTML = "";
      this.textContent = "";
      this.value = "";
      this.checked = false;
      this.indeterminate = false;
      this.disabled = false;
      this.hidden = false;
      this.className = "";
      this.style = {};
    }
    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }
    querySelectorAll() {
      return [];
    }
  }
  class MockInputElement extends MockElement {}
  class MockButtonElement extends MockElement {}
  const inputIds = new Set(["search", "statusFilter", "toggleAllRows"]);
  const buttonIds = new Set(["bulkSelectAll", "bulkConflict", "copyReviewPrompt", "refreshPlan", "expandScopeBtn", "cancelBtn", "applyBtn"]);
  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) {
      const ElementType = inputIds.has(id) ? MockInputElement : buttonIds.has(id) ? MockButtonElement : MockElement;
      elements.set(id, new ElementType(id));
    }
    return elements.get(id);
  };
  const windowListeners = new Map();
  const sandbox = {
    window: {
      addEventListener(type, listener) {
        const listeners = windowListeners.get(type) ?? [];
        listeners.push(listener);
        windowListeners.set(type, listeners);
      }
    },
    document: {
      getElementById: getElement,
      querySelectorAll: () => []
    },
    acquireVsCodeApi: () => ({ postMessage() {} }),
    Element: MockElement,
    HTMLElement: MockElement,
    HTMLInputElement: MockInputElement,
    HTMLButtonElement: MockButtonElement,
    console
  };
  const context = vm.createContext(sandbox);
  new vm.Script(scripts[0]).runInContext(context);
  new vm.Script(scripts[1]).runInContext(context);
  if (getElement("sumSelectedApply").textContent !== "1" || getElement("sumSelectedFiles").textContent !== "1") {
    throw new Error("Folder and file selections are still double-counted.");
  }
  if (!getElement("rows").innerHTML.includes('class="group-row"') || getElement("rows").innerHTML.includes('class="file-row"')) {
    throw new Error("Skill groups must start collapsed with one group row.");
  }
  const expand = new MockButtonElement();
  expand.dataset.kind = "toggle-expand";
  expand.dataset.groupKey = "claude::example";
  getElement("rows").listeners.get("click")?.({ target: expand });
  if (!getElement("rows").innerHTML.includes('class="file-row"')) {
    throw new Error("Expanding a skill group does not reveal its file rows.");
  }
}

async function main() {
  const renderTransferManagerHtml = await loadTransferManagerRenderer();
  const html = renderTransferManagerHtml({}, samplePlan(), "en");
  const scripts = [...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  if (scripts.length < 2) throw new Error(`Expected bootstrap and application scripts, found ${scripts.length}.`);
  for (const [index, script] of scripts.entries()) {
    new vm.Script(script, { filename: `transfer-manager-webview-${index + 1}.js` });
  }
  verifyClientErrorBootstrap(scripts[0]);
  verifyHierarchyRuntime(scripts);
  if (!html.includes('id="fatalError"') || !html.includes('type: "clientError"')) {
    throw new Error("Transfer Manager webview must expose and report client errors.");
  }
  const hierarchyTokens = [
    'id="sumSelectedFiles"',
    'class="group-row"',
    'class="file-row"',
    'data-kind="toggle-group"',
    'data-kind="toggle-file"',
    "indeterminate"
  ];
  for (const token of hierarchyTokens) {
    if (!html.includes(token)) throw new Error(`Transfer Manager hierarchy is missing ${token}.`);
  }
  console.log(`[webview-scripts] OK. Parsed ${scripts.length} scripts, exercised error reporting, and verified hierarchical selection counts.`);
}

main().catch((error) => {
  console.error(`[webview-scripts] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
