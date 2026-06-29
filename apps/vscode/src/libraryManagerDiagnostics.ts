import type { LibraryEntry, LibraryPayload } from "./libraryManagerTypes";

type SideEntryStats = {
  raw: number;
  existing: number;
  missingPlaceholders: number;
  added: number;
  removed: number;
  modified: number;
  typeChanged: number;
  same: number;
};

type CompareStats = {
  total: number;
  both: number;
  workspaceOnly: number;
  centralOnly: number;
  modified: number;
  same: number;
};

export type LibraryPayloadDiagnostics = {
  workspace: SideEntryStats;
  central: SideEntryStats;
  compare: CompareStats;
  tools: string[];
};

export type LibraryClientSummary = {
  mode: string;
  view: string;
  statusFilter: string;
  agentFilter: string;
  query: string;
  total: number;
  both: number;
  workspaceOnly: number;
  centralOnly: number;
  modified: number;
  same: number;
  visible: number;
  ready: number;
  selected: number;
};

export type LibrarySummaryMismatch = {
  field: keyof CompareStats;
  payload: number;
  client: number;
};

function sideEntryStats(entries: LibraryEntry[]): SideEntryStats {
  return {
    raw: entries.length,
    existing: entries.filter((entry) => entry.exists).length,
    missingPlaceholders: entries.filter((entry) => !entry.exists).length,
    added: entries.filter((entry) => entry.status === "added").length,
    removed: entries.filter((entry) => entry.status === "removed").length,
    modified: entries.filter((entry) => entry.status === "modified").length,
    typeChanged: entries.filter((entry) => entry.status === "typeChanged").length,
    same: entries.filter((entry) => entry.status === "same").length
  };
}

function entrySkillKey(entry: LibraryEntry): string {
  return `${entry.tool}:skills/${entry.folder}`;
}

export function summarizeLibraryPayload(payload: LibraryPayload): LibraryPayloadDiagnostics {
  const workspaceExisting = new Map<string, LibraryEntry>();
  const centralExisting = new Map<string, LibraryEntry>();
  for (const entry of payload.workspace.entries) {
    if (entry.exists) workspaceExisting.set(entrySkillKey(entry), entry);
  }
  for (const entry of payload.central.entries) {
    if (entry.exists) centralExisting.set(entrySkillKey(entry), entry);
  }
  const keys = new Set([...workspaceExisting.keys(), ...centralExisting.keys()]);
  let both = 0;
  let workspaceOnly = 0;
  let centralOnly = 0;
  let modified = 0;
  let same = 0;
  for (const key of keys) {
    const workspace = workspaceExisting.get(key);
    const central = centralExisting.get(key);
    if (workspace && central) {
      both += 1;
      if (workspace.status === "modified" || workspace.status === "typeChanged" || central.status === "modified" || central.status === "typeChanged") {
        modified += 1;
      } else {
        same += 1;
      }
    } else if (workspace) {
      workspaceOnly += 1;
    } else if (central) {
      centralOnly += 1;
    }
  }
  return {
    workspace: sideEntryStats(payload.workspace.entries),
    central: sideEntryStats(payload.central.entries),
    compare: {
      total: keys.size,
      both,
      workspaceOnly,
      centralOnly,
      modified,
      same
    },
    tools: payload.tools
  };
}

export function formatLibraryPayloadDiagnostics(label: string, payload: LibraryPayload): string {
  const summary = summarizeLibraryPayload(payload);
  const workspace = summary.workspace;
  const central = summary.central;
  const compare = summary.compare;
  return [
    `[LibraryManager] ${label}`,
    `tools=${summary.tools.join(",") || "-"}`,
    `workspace raw=${workspace.raw} existing=${workspace.existing} placeholders=${workspace.missingPlaceholders} added=${workspace.added} modified=${workspace.modified} same=${workspace.same}`,
    `central raw=${central.raw} existing=${central.existing} placeholders=${central.missingPlaceholders} added=${central.added} modified=${central.modified} same=${central.same}`,
    `compare total=${compare.total} both=${compare.both} workspaceOnly=${compare.workspaceOnly} centralOnly=${compare.centralOnly} modified=${compare.modified} same=${compare.same}`
  ].join(" | ");
}

function numberFrom(value: unknown): number {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function stringFrom(value: unknown): string {
  return String(value ?? "");
}

export function parseLibraryClientSummary(value: unknown): LibraryClientSummary | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  return {
    mode: stringFrom(payload.mode),
    view: stringFrom(payload.view),
    statusFilter: stringFrom(payload.statusFilter),
    agentFilter: stringFrom(payload.agentFilter),
    query: stringFrom(payload.query),
    total: numberFrom(payload.total),
    both: numberFrom(payload.both),
    workspaceOnly: numberFrom(payload.workspaceOnly),
    centralOnly: numberFrom(payload.centralOnly),
    modified: numberFrom(payload.modified),
    same: numberFrom(payload.same),
    visible: numberFrom(payload.visible),
    ready: numberFrom(payload.ready),
    selected: numberFrom(payload.selected)
  };
}

export function formatLibraryClientSummary(summary: LibraryClientSummary): string {
  return [
    "[LibraryManager] clientSummary",
    `view=${summary.view}`,
    `mode=${summary.mode}`,
    `filter=${summary.statusFilter}`,
    `agent=${summary.agentFilter}`,
    `query=${summary.query || "-"}`,
    `total=${summary.total}`,
    `both=${summary.both}`,
    `workspaceOnly=${summary.workspaceOnly}`,
    `centralOnly=${summary.centralOnly}`,
    `modified=${summary.modified}`,
    `same=${summary.same}`,
    `visible=${summary.visible}`,
    `ready=${summary.ready}`,
    `selected=${summary.selected}`
  ].join(" | ");
}

export function comparePayloadAndClientSummary(
  payloadSummary: LibraryPayloadDiagnostics,
  clientSummary: LibraryClientSummary
): LibrarySummaryMismatch[] {
  const fields: Array<keyof CompareStats> = ["total", "both", "workspaceOnly", "centralOnly", "modified", "same"];
  return fields
    .map((field) => ({
      field,
      payload: payloadSummary.compare[field],
      client: clientSummary[field]
    }))
    .filter((item) => item.payload !== item.client);
}

export function formatLibrarySummaryMismatch(mismatches: LibrarySummaryMismatch[]): string {
  if (mismatches.length === 0) return "";
  return `[LibraryManager] summaryMismatch | ${mismatches.map((item) => `${item.field} payload=${item.payload} client=${item.client}`).join(" | ")}`;
}
