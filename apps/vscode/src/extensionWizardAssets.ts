import * as vscode from "vscode";
import type { SkillAssetTreeMeta, SkillTreeNode, ToolType } from "./types";
import type { WizardAssetPick } from "./extensionAddMoveWizard";

type TreeSide = "workspace" | "central";
type TranslationFn = (english: string, korean: string) => string;

export function createWizardAssetTools(args: {
  tr: TranslationFn;
  getWorkspaceSkills: () => Array<{ tool: ToolType; relativePath: string }>;
  getCentralSkills: () => Array<{ tool: ToolType; relativePath: string }>;
  getWorkspaceMissingSkillFolders: () => Array<{ tool: ToolType; relativePath: string }>;
  getCentralMissingSkillFolders: () => Array<{ tool: ToolType; relativePath: string }>;
  getWorkspaceAssetMeta: () => Map<string, { status: SkillAssetTreeMeta["status"]; warnings: unknown[]; fileCount: number; updatedAt: string | null }>;
  getCentralAssetMeta: () => Map<string, { status: SkillAssetTreeMeta["status"]; warnings: unknown[]; fileCount: number; updatedAt: string | null }>;
  getSkillFolderRelativePath: (relativePath: string) => string | null;
  normalizeRel: (relativePath: string) => string;
  getSkillFolderRelativePathFromNode: (node: SkillTreeNode | null | undefined) => string | null;
}): {
  pickWizardSide: (title: string) => Promise<TreeSide | undefined>;
  pickWizardAsset: (side: TreeSide, title: string) => Promise<WizardAssetPick | undefined>;
  getWizardAssetPicks: (side: TreeSide) => WizardAssetPick[];
  statusLabelForWizard: (status: SkillAssetTreeMeta["status"]) => string;
  buildSkillMdTemplate: (name: string) => string;
  dedupeWizardAssets: (assets: WizardAssetPick[]) => WizardAssetPick[];
  getWizardAssetFromNode: (side: TreeSide, node: SkillTreeNode) => WizardAssetPick | undefined;
} {
  const statusLabelForWizard = (status: SkillAssetTreeMeta["status"]): string => {
    if (status === "new") return args.tr("New skill", "새 스킬");
    if (status === "changed") return args.tr("Changed", "변경 있음");
    if (status === "missingSkillMd") return args.tr("Missing SKILL.md", "SKILL.md 없음");
    if (status === "risk") return args.tr("Needs attention", "주의 필요");
    if (status === "recent") return args.tr("Recently modified", "최근 수정");
    return args.tr("Same", "동일");
  };

  const getWizardAssetPicks = (side: TreeSide): WizardAssetPick[] => {
    const files = side === "workspace" ? args.getWorkspaceSkills() : args.getCentralSkills();
    const missing = side === "workspace" ? args.getWorkspaceMissingSkillFolders() : args.getCentralMissingSkillFolders();
    const meta = side === "workspace" ? args.getWorkspaceAssetMeta() : args.getCentralAssetMeta();
    const roots = new Map<string, { tool: ToolType; rootRelativePath: string; fileCount: number }>();
    for (const file of files) {
      const folder = args.getSkillFolderRelativePath(file.relativePath);
      if (!folder) continue;
      const key = `${file.tool}:${folder}`;
      const previous = roots.get(key) ?? { tool: file.tool, rootRelativePath: folder, fileCount: 0 };
      previous.fileCount += 1;
      roots.set(key, previous);
    }
    for (const folder of missing) {
      const rootRelativePath = args.normalizeRel(folder.relativePath);
      const key = `${folder.tool}:${rootRelativePath}`;
      if (!roots.has(key)) roots.set(key, { tool: folder.tool, rootRelativePath, fileCount: 0 });
    }
    return [...roots.values()]
      .map((root) => {
        const assetMeta = meta.get(`${root.tool}:${root.rootRelativePath}`);
        return {
          tool: root.tool,
          rootRelativePath: root.rootRelativePath,
          skillName: root.rootRelativePath.split("/")[1] ?? root.rootRelativePath,
          status: assetMeta?.status ?? "same",
          warnings: assetMeta?.warnings ?? [],
          fileCount: assetMeta?.fileCount ?? root.fileCount,
          updatedAt: assetMeta?.updatedAt ?? null
        };
      })
      .sort((a, b) => a.tool.localeCompare(b.tool) || a.skillName.localeCompare(b.skillName));
  };

  const pickWizardSide = async (title: string): Promise<TreeSide | undefined> => {
    const pick = await vscode.window.showQuickPick(
      [
        { label: args.tr("Workspace", "작업공간"), description: args.tr("Agent skills in the current workspace folder", "현재 작업 폴더의 에이전트 스킬"), value: "workspace" as TreeSide },
        { label: args.tr("Central", "중앙"), description: args.tr("Central skill library", "중앙 스킬 저장소"), value: "central" as TreeSide }
      ],
      { title, matchOnDescription: true }
    );
    return pick?.value;
  };

  const pickWizardAsset = async (side: TreeSide, title: string): Promise<WizardAssetPick | undefined> => {
    const assets = getWizardAssetPicks(side);
    if (assets.length === 0) {
      vscode.window.showWarningMessage(args.tr(`No skills are available to select from ${side === "workspace" ? "Workspace" : "Central"}.`, `${side === "workspace" ? "Workspace" : "Central"}에서 선택할 스킬이 없습니다.`));
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      assets.map((asset) => ({
        label: `${asset.tool}/${asset.skillName}`,
        description: statusLabelForWizard(asset.status),
        detail: `${asset.rootRelativePath} · ${args.tr("files", "파일")} ${asset.fileCount} · ${args.tr("warnings", "경고")} ${asset.warnings.length}${asset.updatedAt ? ` · ${asset.updatedAt}` : ""}`,
        value: asset
      })),
      { title, matchOnDescription: true, matchOnDetail: true }
    );
    return pick?.value;
  };

  const buildSkillMdTemplate = (name: string): string => [
    `# ${name}`,
    "",
    "## When to use",
    "",
    "- Describe the situation where this skill should be used.",
    "",
    "## Instructions",
    "",
    "- Add the concrete workflow here.",
    ""
  ].join("\n");

  const dedupeWizardAssets = (assets: WizardAssetPick[]): WizardAssetPick[] => {
    const unique = new Map<string, WizardAssetPick>();
    for (const asset of assets) {
      unique.set(`${asset.tool}:${asset.rootRelativePath}`, asset);
    }
    return [...unique.values()].sort((a, b) => a.tool.localeCompare(b.tool) || a.rootRelativePath.localeCompare(b.rootRelativePath));
  };

  const getWizardAssetFromNode = (side: TreeSide, node: SkillTreeNode): WizardAssetPick | undefined => {
    const rootRelativePath = args.getSkillFolderRelativePathFromNode(node);
    if (!rootRelativePath) {
      vscode.window.showWarningMessage(args.tr("Select a skill folder or a file inside a skill first.", "먼저 스킬 폴더나 스킬 안의 파일을 선택하세요."));
      return undefined;
    }
    const asset = getWizardAssetPicks(side).find((item) => item.tool === node.tool && item.rootRelativePath === rootRelativePath);
    if (!asset) {
      vscode.window.showWarningMessage(args.tr(`Could not find a skill asset for ${node.tool}/${rootRelativePath}.`, `${node.tool}/${rootRelativePath} 스킬 자산을 찾지 못했습니다.`));
      return undefined;
    }
    return asset;
  };

  return {
    pickWizardSide,
    pickWizardAsset,
    getWizardAssetPicks,
    statusLabelForWizard,
    buildSkillMdTemplate,
    dedupeWizardAssets,
    getWizardAssetFromNode
  };
}
