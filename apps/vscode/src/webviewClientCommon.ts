export function renderWebviewClientCommonScript(): string {
  return `
    window.SkillBridgeWebview = window.SkillBridgeWebview || (() => {
      function createStatusController(statusId = "statusLine") {
        return {
          set(message, tone) {
            const el = document.getElementById(statusId);
            if (!el) return;
            el.textContent = message || "Ready";
            el.className = "sb-status-bar " + (tone || "info");
          }
        };
      }
      function setBusy(root, busy) {
        const scope = root || document;
        scope.querySelectorAll("button,input,textarea,select").forEach((item) => {
          if ("disabled" in item) item.disabled = !!busy;
        });
      }
      function postOnceWhileBusy(vscode, message, options) {
        const root = options && options.root ? options.root : document;
        if (root.dataset && root.dataset.sbBusy === "true") return false;
        if (root.dataset) root.dataset.sbBusy = "true";
        setBusy(root, true);
        vscode.postMessage(message);
        return true;
      }
      function reportClientError(vscode, error) {
        const message = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
        try { vscode.postMessage({ type: "clientError", payload: { message } }); } catch { /* ignore reporting failures */ }
      }
      return { createStatusController, setBusy, postOnceWhileBusy, reportClientError };
    })();
  `;
}
