export function renderLibraryManagerClientScript(initialPayloadJson: string, language: "en" | "ko"): string {
  return `
    (() => {
      let api = null;
      try {
        const vscode = acquireVsCodeApi();
        api = vscode;
        let currentLanguage = "${language}";
        let state = ${initialPayloadJson};
        const ui = {
          view: "compare",
          mode: "send",
          query: "",
          status: "actionable",
          agent: "all",
          groups: { workspace: "all", central: "all" },
          detailStatus: { workspace: "all", central: "all" },
          detailSort: { workspace: "name", central: "name" },
          selected: {}
        };
        let lastClientSummarySignature = "";

        function isKo(){ return currentLanguage === "ko"; }
        function t(en, ko){ return isKo() ? ko : en; }
        function esc(value){
          return String(value ?? "")
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;");
        }
        function setStatus(message, tone){
          const el = document.getElementById("statusLine");
          if (!el) return;
          el.textContent = message || t("Ready", "준비 완료");
          el.className = "status " + (tone || "");
        }
        function normalizePath(value){ return String(value || "").replaceAll("\\\\", "/"); }
        function skillPath(folder){ return "skills/" + normalizePath(folder).replace(/^skills\\//, ""); }
        function skillNameFromPath(relativePath){
          const parts = normalizePath(relativePath).split("/").filter(Boolean);
          return parts[0] === "skills" ? (parts[1] || relativePath) : (parts[0] || relativePath);
        }
        function summarizeStatus(statuses){
          if (statuses.includes("typeChanged")) return "modified";
          if (statuses.includes("modified")) return "modified";
          if (statuses.includes("added")) return "onlyHere";
          if (statuses.includes("removed")) return "onlyThere";
          return "same";
        }
        function sideSkills(side){
          const source = side === "workspace" ? state.workspace : state.central;
          const entries = Array.isArray(source?.entries) ? source.entries : [];
          const map = new Map();
          for (const entry of entries) {
            if (!entry.exists) continue;
            const relativePath = skillPath(entry.folder);
            const key = entry.tool + ":" + relativePath;
            const prev = map.get(key) || {
              key,
              tool: entry.tool,
              relativePath,
              name: skillNameFromPath(relativePath),
              fileCount: 0,
              statuses: [],
              createdAt: null,
              updatedAt: null,
              groups: new Set()
            };
            prev.fileCount += 1;
            prev.statuses.push(entry.status || "same");
            if (entry.createdAt && (!prev.createdAt || Date.parse(entry.createdAt) < Date.parse(prev.createdAt))) prev.createdAt = entry.createdAt;
            if (entry.updatedAt && (!prev.updatedAt || Date.parse(entry.updatedAt) > Date.parse(prev.updatedAt))) prev.updatedAt = entry.updatedAt;
            for (const groupName of (Array.isArray(entry.groupNames) ? entry.groupNames : [])) {
              if (groupName) prev.groups.add(groupName);
            }
            map.set(key, prev);
          }
          return Array.from(map.values()).map((item) => ({
            key: item.key,
            tool: item.tool,
            relativePath: item.relativePath,
            name: item.name,
            fileCount: item.fileCount,
            rawStatus: summarizeStatus(item.statuses),
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            groups: Array.from(item.groups).sort()
          })).sort((a, b) => a.tool.localeCompare(b.tool) || a.relativePath.localeCompare(b.relativePath));
        }
        function compareRows(){
          const workspace = new Map(sideSkills("workspace").map((item) => [item.key, item]));
          const central = new Map(sideSkills("central").map((item) => [item.key, item]));
          const keys = Array.from(new Set([...workspace.keys(), ...central.keys()])).sort();
          return keys.map((key) => {
            const w = workspace.get(key) || null;
            const c = central.get(key) || null;
            const base = w || c;
            let status = "same";
            if (w && !c) status = "workspaceOnly";
            else if (!w && c) status = "centralOnly";
            else if (w?.rawStatus === "modified" || c?.rawStatus === "modified") status = "modified";
            return {
              key,
              tool: base.tool,
              relativePath: base.relativePath,
              name: base.name,
              status,
              workspaceFiles: w ? w.fileCount : 0,
              centralFiles: c ? c.fileCount : 0,
              workspaceGroups: w ? w.groups : [],
              centralGroups: c ? c.groups : []
            };
          });
        }
        function isActionable(row){
          if (ui.mode === "send") return row.status === "workspaceOnly" || row.status === "modified";
          return row.status === "centralOnly" || row.status === "modified";
        }
        function sourceOnlyStatus(){
          return ui.mode === "send" ? "workspaceOnly" : "centralOnly";
        }
        function targetOnlyStatus(){
          return ui.mode === "send" ? "centralOnly" : "workspaceOnly";
        }
        function statusLabel(status){
          if (status === "workspaceOnly") {
            return ui.mode === "send" ? t("Workspace new", "작업공간 신규") : t("Workspace only", "작업공간만");
          }
          if (status === "centralOnly") {
            return ui.mode === "bring" ? t("Central new", "중앙 신규") : t("Central only", "중앙만");
          }
          if (status === "modified") return t("Modified", "수정됨");
          return t("Same", "동일");
        }
        function statusClass(status){
          if (status === "workspaceOnly" || status === "centralOnly") return "b-new";
          if (status === "modified") return "b-modified";
          if (status === "same") return "b-same";
          return "b-target";
        }
        function detailStatusLabel(status){
          if (status === "modified") return t("Modified", "수정됨");
          if (status === "onlyHere") return t("Only here", "여기에만 있음");
          return t("Same", "동일");
        }
        function formatDate(value){
          if (!value) return "-";
          const date = new Date(value);
          if (Number.isNaN(date.getTime())) return "-";
          const pad = (part) => String(part).padStart(2, "0");
          return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
        }
        function modeTitle(){
          return ui.mode === "send"
            ? t("Save Workspace skills to Central", "작업공간 스킬을 중앙에 반영")
            : t("Bring Central skills to Workspace", "중앙 스킬을 작업공간으로 가져오기");
        }
        function modeSubtitle(rows){
          const actionable = rows.filter(isActionable).length;
          return ui.mode === "send"
            ? t(actionable + " skill(s) can be saved to Central. Modified skills overwrite Central after review.", actionable + "개 스킬을 중앙에 반영할 수 있습니다.")
            : t(actionable + " skill(s) can be brought in. Modified skills overwrite Workspace after review.", actionable + "개 스킬을 작업공간으로 가져올 수 있습니다.");
        }
        function passes(row){
          const q = ui.query.trim().toLowerCase();
          if (q && !(row.tool + " " + row.name + " " + row.relativePath + " " + row.workspaceGroups.join(" ") + " " + row.centralGroups.join(" ")).toLowerCase().includes(q)) return false;
          if (ui.agent !== "all" && row.tool !== ui.agent) return false;
          if (ui.status === "actionable") return isActionable(row);
          if (ui.status === "all") return row.status !== targetOnlyStatus();
          if (ui.status === "new" || ui.status === "sourceOnly") return row.status === sourceOnlyStatus();
          if (ui.status === "modified") return row.status === "modified";
          if (ui.status === "same") return row.status === "same";
          if (ui.status === "targetOnly") return row.status === targetOnlyStatus();
          if (ui.status === "workspaceOnly") return row.status === "workspaceOnly";
          if (ui.status === "centralOnly") return row.status === "centralOnly";
          return true;
        }
        function visibleRows(){ return compareRows().filter(passes); }
        function actionableVisibleRows(){ return visibleRows().filter(isActionable); }
        function compareSummary(){
          const rows = compareRows();
          return {
            mode: ui.mode,
            view: ui.view,
            statusFilter: ui.status,
            agentFilter: ui.agent,
            query: ui.query,
            total: rows.length,
            both: rows.filter((row) => row.workspaceFiles > 0 && row.centralFiles > 0).length,
            workspaceOnly: rows.filter((row) => row.status === "workspaceOnly").length,
            centralOnly: rows.filter((row) => row.status === "centralOnly").length,
            modified: rows.filter((row) => row.status === "modified").length,
            same: rows.filter((row) => row.status === "same").length,
            visible: visibleRows().length,
            ready: actionableVisibleRows().length,
            selected: selectedVisibleRows().length
          };
        }
        function emitClientSummary(){
          const summary = compareSummary();
          const signature = JSON.stringify(summary);
          if (signature === lastClientSummarySignature) return;
          lastClientSummarySignature = signature;
          vscode.postMessage({ type: "clientSummary", payload: summary });
        }
        function renderSummary(){
          const summary = compareSummary();
          const metrics = ui.mode === "send"
            ? [
              ["actionable", t("Ready to save", "반영할 수 있음"), summary.workspaceOnly + summary.modified],
              ["sourceOnly", t("Workspace new", "작업공간 신규"), summary.workspaceOnly],
              ["modified", t("Modified", "수정됨"), summary.modified],
              ["same", t("Already same", "이미 동일"), summary.same]
            ]
            : [
              ["actionable", t("Ready to bring", "가져올 수 있음"), summary.centralOnly + summary.modified],
              ["sourceOnly", t("Central new", "중앙 신규"), summary.centralOnly],
              ["modified", t("Modified", "수정됨"), summary.modified],
              ["same", t("Already same", "이미 동일"), summary.same]
            ];
          document.getElementById("summary").innerHTML = metrics.map(([status, label, value]) =>
            '<button class="metric metric-button ' + (ui.status === status ? "active" : "") + '" data-status-filter="' + esc(status) + '" type="button"><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong></button>'
          ).join("");
        }
        function renderFilters(){
          const status = document.getElementById("statusButtons");
          const agent = document.getElementById("agentButtons");
          if (ui.status === "targetOnly" || ui.status === "workspaceOnly" || ui.status === "centralOnly") {
            ui.status = "actionable";
          }
          const sourceOnlyLabel = ui.mode === "send"
            ? t("Workspace only (new to Central)", "작업공간만 (중앙에 반영할 신규)")
            : t("Central only (new to Workspace)", "중앙만 (가져올 신규)");
          const statusOptions = [
            ["actionable", t("Ready to apply", "반영 가능")],
            ["all", t("All in this direction", "현재 방향 전체")],
            ["sourceOnly", sourceOnlyLabel],
            ["modified", t("Modified", "수정됨")],
            ["same", t("Same", "동일")]
          ];
          status.innerHTML = statusOptions.map(([value, label]) =>
            '<button class="chip ' + (ui.status === value ? "active" : "") + '" data-status-filter="' + esc(value) + '" type="button">' + esc(label) + '</button>'
          ).join("");
          const tools = Array.isArray(state.tools) ? state.tools : [];
          agent.innerHTML = [["all", t("All agents", "전체 에이전트")], ...tools.map((tool) => [tool, tool])]
            .map(([value, label]) => '<button class="chip ' + (ui.agent === value ? "active" : "") + '" data-agent-filter="' + esc(value) + '" type="button">' + esc(label) + '</button>').join("");
        }
        function groupsForSide(side){
          return Array.from(new Set(sideSkills(side).flatMap((row) => row.groups))).sort();
        }
        function detailRows(side){
          const status = ui.detailStatus[side] || "all";
          const sort = ui.detailSort[side] || "name";
          const rows = sideSkills(side).filter((row) => {
            const q = ui.query.trim().toLowerCase();
            const group = ui.groups[side] || "all";
            const searchable = [
              row.tool,
              row.name,
              row.relativePath,
              detailStatusLabel(row.rawStatus),
              row.rawStatus,
              formatDate(row.createdAt),
              formatDate(row.updatedAt),
              row.groups.join(" ")
            ].join(" ").toLowerCase();
            return (!q || searchable.includes(q))
              && (ui.agent === "all" || row.tool === ui.agent)
              && (group === "all" || row.groups.includes(group))
              && (status === "all" || row.rawStatus === status);
          });
          return rows.sort((left, right) => {
            if (sort === "agent") return left.tool.localeCompare(right.tool) || left.name.localeCompare(right.name);
            if (sort === "files") return right.fileCount - left.fileCount || left.name.localeCompare(right.name);
            if (sort === "created") return String(right.createdAt || "").localeCompare(String(left.createdAt || "")) || left.name.localeCompare(right.name);
            if (sort === "updated") return String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")) || left.name.localeCompare(right.name);
            if (sort === "group") return (left.groups[0] || "").localeCompare(right.groups[0] || "") || left.name.localeCompare(right.name);
            return left.name.localeCompare(right.name);
          });
        }
        function renderDetailFilters(side){
          const agent = document.getElementById(side + "AgentFilter");
          const group = document.getElementById(side + "GroupFilter");
          const status = document.getElementById(side + "StatusFilter");
          const sort = document.getElementById(side + "SortFilter");
          if (!agent || !group || !status || !sort) return;
          const tools = Array.from(new Set(sideSkills(side).map((row) => row.tool))).sort();
          agent.innerHTML = [["all", t("All agents", "전체 에이전트")], ...tools.map((tool) => [tool, tool])]
            .map(([value, label]) => '<option value="' + esc(value) + '" ' + (ui.agent === value ? "selected" : "") + '>' + esc(label) + '</option>').join("");
          const groups = groupsForSide(side);
          const selectedGroup = groups.includes(ui.groups[side]) ? ui.groups[side] : "all";
          ui.groups[side] = selectedGroup;
          group.innerHTML = [["all", t("All groups", "전체 그룹")], ...groups.map((item) => [item, item])]
            .map(([value, label]) => '<option value="' + esc(value) + '" ' + (selectedGroup === value ? "selected" : "") + '>' + esc(label) + '</option>').join("");
          const statusValue = ui.detailStatus[side] || "all";
          status.innerHTML = [
            ["all", t("All statuses", "전체 상태")],
            ["onlyHere", t("Only here", "여기에만 있음")],
            ["modified", t("Modified", "수정됨")],
            ["same", t("Same", "동일")]
          ].map(([value, label]) => '<option value="' + esc(value) + '" ' + (statusValue === value ? "selected" : "") + '>' + esc(label) + '</option>').join("");
          const sortValue = ui.detailSort[side] || "name";
          sort.innerHTML = [
            ["name", t("Sort: Skill", "정렬: 스킬")],
            ["agent", t("Sort: Agent", "정렬: 에이전트")],
            ["files", t("Sort: Files", "정렬: 파일")],
            ["updated", t("Sort: Updated", "정렬: 수정일")],
            ["created", t("Sort: Created", "정렬: 생성일")],
            ["group", t("Sort: Group", "정렬: 그룹")]
          ].map(([value, label]) => '<option value="' + esc(value) + '" ' + (sortValue === value ? "selected" : "") + '>' + esc(label) + '</option>').join("");
        }
        function selectedVisibleRows(){
          return visibleRows().filter((row) => ui.selected[row.key] && isActionable(row));
        }
        function syncHeaderCheckbox(){
          const allBox = document.getElementById("selectAllRows");
          if (!(allBox instanceof HTMLInputElement)) return;
          const actionableRows = actionableVisibleRows();
          const selectedCount = selectedVisibleRows().length;
          allBox.disabled = actionableRows.length === 0;
          allBox.checked = actionableRows.length > 0 && selectedCount === actionableRows.length;
          allBox.indeterminate = selectedCount > 0 && selectedCount < actionableRows.length;
          allBox.title = actionableRows.length === 0
            ? t("No rows can be applied in this view", "이 보기에는 반영할 수 있는 항목이 없습니다")
            : t("Select all rows that can be applied in this view", "현재 보기의 반영 가능한 항목 전체 선택");
        }
        function renderCompareTable(){
          const rows = visibleRows();
          const actionableCount = actionableVisibleRows().length;
          const selectedCount = selectedVisibleRows().length;
          document.getElementById("panelTitle").textContent = modeTitle();
          document.getElementById("panelSubtitle").textContent = modeSubtitle(compareRows()) + " · " + t("Showing ", "표시 ") + rows.length + t(" item(s)", "개") + " · " + t("Ready ", "반영 가능 ") + actionableCount + " · " + t("Selected ", "선택 ") + selectedCount;
          document.getElementById("runSelectedBtn").textContent = ui.mode === "send"
            ? t("Save selected to Central", "선택 항목 중앙에 반영")
            : t("Bring selected to Workspace", "선택 항목 작업공간으로 가져오기");
          document.getElementById("runSelectedBtn").disabled = selectedCount === 0;
          if (rows.length === 0) {
            document.getElementById("compareTable").innerHTML = '<div class="empty">' + esc(t("No skills match the current filter.", "현재 필터와 맞는 스킬이 없습니다.")) + '</div>';
            return;
          }
          document.getElementById("compareTable").innerHTML =
            '<table><thead><tr>' +
            '<th class="check-col"><input id="selectAllRows" type="checkbox" data-action="toggle-all" /></th><th>' + esc(t("Skill", "스킬")) + '</th><th class="agent-col">' + esc(t("Agent", "에이전트")) + '</th>' +
            '<th class="status-col">' + esc(t("Status", "상태")) + '</th><th class="count-col">' + esc(t("Workspace", "작업공간")) + '</th>' +
            '<th class="count-col">' + esc(t("Central", "중앙")) + '</th><th>' + esc(t("Groups", "그룹")) + '</th><th class="action-col">' + esc(t("Action", "작업")) + '</th>' +
            '</tr></thead><tbody>' +
            rows.map((row) => {
              const actionable = isActionable(row);
              const checked = ui.selected[row.key] && actionable ? "checked" : "";
              const groups = ui.mode === "send" ? row.workspaceGroups : row.centralGroups;
              const button = actionable
                ? '<button class="primary" data-action="run-one" data-key="' + esc(row.key) + '">' + esc(ui.mode === "send" ? t("Save", "반영") : t("Bring", "가져오기")) + '</button>'
                : '<button disabled>' + esc(t("No action", "작업 없음")) + '</button>';
              const diff = row.status === "modified"
                ? '<button class="ghost" data-action="diff" data-key="' + esc(row.key) + '">' + esc(t("Diff", "비교")) + '</button>'
                : "";
              return '<tr>' +
                '<td><input type="checkbox" data-action="toggle-row" data-key="' + esc(row.key) + '" ' + checked + ' ' + (!actionable ? "disabled" : "") + ' /></td>' +
                '<td><div class="path"><strong>' + esc(row.name) + '</strong><span class="muted">' + esc(row.relativePath) + '</span></div></td>' +
                '<td>' + esc(row.tool) + '</td>' +
                '<td><span class="badge ' + statusClass(row.status) + '">' + esc(statusLabel(row.status)) + '</span></td>' +
                '<td>' + esc(row.workspaceFiles) + ' ' + esc(t("files", "파일")) + '</td>' +
                '<td>' + esc(row.centralFiles) + ' ' + esc(t("files", "파일")) + '</td>' +
                '<td><div class="truncate muted" title="' + esc(groups.join(", ")) + '">' + esc(groups.length ? groups.join(", ") : "-") + '</div></td>' +
                '<td><div class="row-actions">' + diff + button + '</div></td>' +
              '</tr>';
            }).join("") +
            '</tbody></table>';
          syncHeaderCheckbox();
        }
        function renderDetail(side){
          const target = document.getElementById(side === "workspace" ? "workspaceDetail" : "centralDetail");
          const summaryTarget = document.getElementById(side === "workspace" ? "workspaceSummary" : "centralSummary");
          const allRows = sideSkills(side);
          const rows = detailRows(side);
          const allGroups = groupsForSide(side);
          const agents = Array.from(new Set(allRows.map((row) => row.tool)));
          const files = rows.reduce((sum, row) => sum + row.fileCount, 0);
          const groupNames = allGroups.slice(0, 3).join(", ");
          if (summaryTarget) {
            const metrics = [
              [t("Skills", "스킬"), allRows.length],
              [t("Showing", "표시 중"), rows.length],
              [t("Agents", "에이전트"), agents.length],
              [t("Files shown", "표시 파일"), files],
              [t("Groups", "그룹"), allGroups.length],
              [t("Group names", "주요 그룹"), groupNames || "-"]
            ];
            summaryTarget.innerHTML = metrics.map(([label, value]) =>
              '<div class="metric"><span>' + esc(label) + '</span><strong title="' + esc(value) + '">' + esc(value) + '</strong></div>'
            ).join("");
          }
          renderDetailFilters(side);
          if (rows.length === 0) {
            target.innerHTML = '<div class="empty">' + esc(t("No skills match the current filter.", "현재 필터와 맞는 스킬이 없습니다.")) + '</div>';
            return;
          }
          target.innerHTML = '<table class="detail-table"><thead><tr><th>' + esc(t("Skill", "스킬")) + '</th><th class="agent-col">' + esc(t("Agent", "에이전트")) + '</th><th class="status-col">' + esc(t("Status", "상태")) + '</th><th class="count-col">' + esc(t("Files", "파일")) + '</th><th class="date-col">' + esc(t("Created", "생성일")) + '</th><th class="date-col">' + esc(t("Updated", "수정일")) + '</th><th>' + esc(t("Groups", "그룹")) + '</th></tr></thead><tbody>' +
            rows.map((row) => '<tr><td><div class="path"><strong>' + esc(row.name) + '</strong><span class="muted">' + esc(row.relativePath) + '</span></div></td><td>' + esc(row.tool) + '</td><td><span class="badge ' + statusClass(row.rawStatus === "onlyHere" ? "workspaceOnly" : row.rawStatus) + '">' + esc(detailStatusLabel(row.rawStatus)) + '</span></td><td>' + esc(row.fileCount) + '</td><td class="date-cell">' + esc(formatDate(row.createdAt)) + '</td><td class="date-cell">' + esc(formatDate(row.updatedAt)) + '</td><td><span class="muted truncate" title="' + esc(row.groups.join(", ")) + '">' + esc(row.groups.length ? row.groups.join(", ") : "-") + '</span></td></tr>').join("") +
            '</tbody></table>';
        }
        function renderTabs(){
          document.body.classList.toggle("view-workspace", ui.view === "workspace");
          document.body.classList.toggle("view-central", ui.view === "central");
          document.querySelectorAll("[data-view]").forEach((btn) => btn.classList.toggle("active", btn.getAttribute("data-view") === ui.view));
          document.querySelectorAll("[data-mode]").forEach((btn) => btn.classList.toggle("active", btn.getAttribute("data-mode") === ui.mode));
        }
        function render(){
          renderTabs();
          renderSummary();
          renderFilters();
          renderCompareTable();
          renderDetail("workspace");
          renderDetail("central");
          emitClientSummary();
        }
        function rowByKey(key){ return compareRows().find((row) => row.key === key) || null; }
        function targetFromRow(row){ return { tool: row.tool, relativePath: row.relativePath, kind: "folder" }; }
        function runRows(rows){
          const targets = rows.filter(isActionable).map(targetFromRow);
          if (targets.length === 0) {
            setStatus(t("Select at least one skill that can be applied.", "반영할 수 있는 스킬을 하나 이상 선택하세요."), "warn");
            return;
          }
          const sourceSide = ui.mode === "send" ? "workspace" : "central";
          vscode.postMessage({ type: "moveSelected", payload: { sourceSide, targets } });
          setStatus((ui.mode === "send" ? t("Save requested: ", "중앙 반영 요청: ") : t("Bring requested: ", "가져오기 요청: ")) + targets.length, "info");
        }
        function chooseStatus(value){
          ui.status = value || "actionable";
          ui.selected = {};
          render();
        }
        function chooseAgent(value){
          ui.agent = value || "all";
          ui.selected = {};
          render();
        }
        document.getElementById("searchInput").addEventListener("input", (event) => {
          const input = event.target;
          ui.query = input instanceof HTMLInputElement ? input.value : "";
          render();
        });
        document.getElementById("refreshBtn").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
        document.getElementById("languageBtn").addEventListener("click", () => {
          currentLanguage = isKo() ? "en" : "ko";
          vscode.postMessage({ type: "setLanguage", payload: { language: currentLanguage } });
        });
        document.querySelectorAll("[data-install-side]").forEach((button) => button.addEventListener("click", () => {
          const side = button.getAttribute("data-install-side") === "central" ? "central" : "workspace";
          const sideLabel = side === "central" ? t("Central", "중앙") : t("Workspace", "작업공간");
          setStatus(t("Opening add flow for ", "스킬 추가 흐름을 여는 중: ") + sideLabel, "info");
          vscode.postMessage({ type: "installNpx", payload: { side } });
        }));
        document.querySelectorAll("[data-view]").forEach((btn) => btn.addEventListener("click", () => {
          ui.view = btn.getAttribute("data-view") || "compare";
          render();
        }));
        document.querySelectorAll("[data-mode]").forEach((btn) => btn.addEventListener("click", () => {
          ui.mode = btn.getAttribute("data-mode") === "bring" ? "bring" : "send";
          ui.status = "actionable";
          ui.selected = {};
          render();
        }));
        document.getElementById("summary").addEventListener("click", (event) => {
          const target = event.target;
          const button = target instanceof Element ? target.closest("[data-status-filter]") : null;
          if (!(button instanceof HTMLElement)) return;
          chooseStatus(button.getAttribute("data-status-filter") || "actionable");
        });
        document.getElementById("statusButtons").addEventListener("click", (event) => {
          const target = event.target;
          const button = target instanceof Element ? target.closest("[data-status-filter]") : null;
          if (!(button instanceof HTMLElement)) return;
          chooseStatus(button.getAttribute("data-status-filter") || "actionable");
        });
        document.getElementById("agentButtons").addEventListener("click", (event) => {
          const target = event.target;
          const button = target instanceof Element ? target.closest("[data-agent-filter]") : null;
          if (!(button instanceof HTMLElement)) return;
          chooseAgent(button.getAttribute("data-agent-filter") || "all");
        });
        for (const side of ["workspace", "central"]) {
          document.getElementById(side + "AgentFilter").addEventListener("change", (event) => {
            const select = event.target;
            ui.agent = select instanceof HTMLSelectElement ? select.value : "all";
            ui.selected = {};
            render();
          });
          document.getElementById(side + "GroupFilter").addEventListener("change", (event) => {
            const select = event.target;
            ui.groups[side] = select instanceof HTMLSelectElement ? select.value : "all";
            render();
          });
          document.getElementById(side + "StatusFilter").addEventListener("change", (event) => {
            const select = event.target;
            ui.detailStatus[side] = select instanceof HTMLSelectElement ? select.value : "all";
            render();
          });
          document.getElementById(side + "SortFilter").addEventListener("change", (event) => {
            const select = event.target;
            ui.detailSort[side] = select instanceof HTMLSelectElement ? select.value : "name";
            render();
          });
        }
        document.getElementById("selectVisibleBtn").addEventListener("click", () => {
          for (const row of actionableVisibleRows()) {
            ui.selected[row.key] = true;
          }
          render();
        });
        document.getElementById("clearSelectionBtn").addEventListener("click", () => {
          ui.selected = {};
          render();
        });
        document.getElementById("runSelectedBtn").addEventListener("click", () => runRows(selectedVisibleRows()));
        document.getElementById("compareTable").addEventListener("click", (event) => {
          const target = event.target;
          const el = target instanceof Element ? target.closest("[data-action]") : null;
          if (!(el instanceof HTMLElement)) return;
          const key = el.getAttribute("data-key") || "";
          const row = rowByKey(key);
          const action = el.getAttribute("data-action");
          if (action === "toggle-all") {
            const actionableRows = actionableVisibleRows();
            const selectedCount = selectedVisibleRows().length;
            const shouldSelect = selectedCount < actionableRows.length;
            for (const item of actionableRows) {
              if (shouldSelect) ui.selected[item.key] = true;
              else delete ui.selected[item.key];
            }
            renderCompareTable();
            return;
          }
          if (!row) return;
          if (action === "toggle-row") {
            const checked = el instanceof HTMLInputElement ? el.checked : !ui.selected[key];
            if (checked) ui.selected[key] = true;
            else delete ui.selected[key];
            renderCompareTable();
            return;
          }
          if (action === "run-one") {
            runRows([row]);
            return;
          }
          if (action === "diff") {
            const sourceSide = ui.mode === "send" ? "workspace" : "central";
            vscode.postMessage({ type: "openDiff", payload: { sourceSide, tool: row.tool, relativePath: row.relativePath, kind: "folder" } });
          }
        });
        window.addEventListener("message", (event) => {
          const message = event.data;
          if (!message || typeof message !== "object") return;
          if (message.type === "state") {
            state = message.payload || state;
            ui.selected = {};
            render();
            return;
          }
          if (message.type === "ui") {
            const payload = message.payload || {};
            setStatus(payload.message || t("Ready", "준비 완료"), payload.tone || "");
          }
        });
        window.addEventListener("error", (event) => {
          setStatus(t("Screen error: ", "화면 오류: ") + (event.message || t("Unknown error", "알 수 없는 오류")), "error");
        });
        window.addEventListener("unhandledrejection", (event) => {
          const reason = event.reason && event.reason.message ? event.reason.message : String(event.reason || t("Unknown error", "알 수 없는 오류"));
          setStatus(t("Screen error: ", "화면 오류: ") + reason, "error");
        });
        render();
        vscode.postMessage({ type: "clientReady" });
      } catch (error) {
        const message = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
        const status = document.getElementById("statusLine");
        if (status) {
          status.textContent = "Skill Library initialization failed: " + message;
          status.className = "status error";
        }
        try {
          const fallback = api || (typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null);
          fallback?.postMessage?.({ type: "clientError", payload: { message } });
        } catch {
          // ignore reporting failures
        }
      }
    })();
  `;
}
