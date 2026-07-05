const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const manifestPath = path.join(root, 'package.json');
const srcRoot = path.join(root, 'src');
const baseNlsPath = path.join(root, 'package.nls.json');
const ignorePath = path.join(root, '.vscodeignore');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const baseNls = JSON.parse(fs.readFileSync(baseNlsPath, 'utf8'));
const vscodeIgnore = fs.readFileSync(ignorePath, 'utf8');

const declared = new Set((manifest.contributes?.commands ?? []).map((c) => c.command));
const implemented = new Set();
const menuAliasRegex = /^skillBridge\.menu\.(en|ko)\.(.+)$/;

const sourceFiles = listFiles(srcRoot, '.ts').map((filePath) => fs.readFileSync(filePath, 'utf8'));
const registerRegex = /register\("([^"]+)"/g;
for (const sourceText of sourceFiles) {
  let match = registerRegex.exec(sourceText);
  while (match) {
    implemented.add(match[1]);
    match = registerRegex.exec(sourceText);
  }
  registerRegex.lastIndex = 0;
}

const missingInCode = [...declared].filter((id) => {
  if (implemented.has(id)) return false;
  const alias = menuAliasRegex.exec(id);
  if (!alias) return true;
  const target = `skillBridge.${alias[2]}`;
  return !declared.has(target) || !implemented.has(target);
});
const missingInManifest = [...implemented].filter((id) => !declared.has(id));
const invalidMenuAliases = [...declared].filter((id) => {
  const alias = menuAliasRegex.exec(id);
  if (!alias) return false;
  const target = `skillBridge.${alias[2]}`;
  return !declared.has(target);
});

if (missingInCode.length > 0 || missingInManifest.length > 0 || invalidMenuAliases.length > 0) {
  console.error('Skill Bridge manifest command mismatch');
  if (missingInCode.length > 0) {
    console.error('Declared but not implemented:');
    for (const id of missingInCode) console.error(`- ${id}`);
  }
  if (missingInManifest.length > 0) {
    console.error('Implemented but not declared:');
    for (const id of missingInManifest) console.error(`- ${id}`);
  }
  if (invalidMenuAliases.length > 0) {
    console.error('Menu aliases without a declared target command:');
    for (const id of invalidMenuAliases) console.error(`- ${id}`);
  }
  process.exit(1);
}

const commonToolCatalogPath = path.join(srcRoot, 'views', 'commonToolCatalog.ts');
if (fs.existsSync(commonToolCatalogPath)) {
  const catalogText = fs.readFileSync(commonToolCatalogPath, 'utf8');
  const catalogCommands = new Set();
  const catalogCommandRegex = /command:\s*"([^"]+)"/g;
  let catalogMatch = catalogCommandRegex.exec(catalogText);
  while (catalogMatch) {
    catalogCommands.add(catalogMatch[1]);
    catalogMatch = catalogCommandRegex.exec(catalogText);
  }
  const catalogMissingInManifest = [...catalogCommands].filter((id) => !declared.has(id));
  const catalogMissingInCode = [...catalogCommands].filter((id) => !implemented.has(id));
  if (catalogMissingInManifest.length > 0 || catalogMissingInCode.length > 0) {
    console.error('Skill Bridge common tool catalog mismatch');
    if (catalogMissingInManifest.length > 0) {
      console.error('Catalog command missing in manifest:');
      for (const id of catalogMissingInManifest) console.error(`- ${id}`);
    }
    if (catalogMissingInCode.length > 0) {
      console.error('Catalog command missing in code registration:');
      for (const id of catalogMissingInCode) console.error(`- ${id}`);
    }
    process.exit(1);
  }
}

const manifestText = JSON.stringify(manifest);
const placeholderRegex = /%([^%]+)%/g;
const placeholders = new Set();
let placeholderMatch = placeholderRegex.exec(manifestText);
while (placeholderMatch) {
  placeholders.add(placeholderMatch[1]);
  placeholderMatch = placeholderRegex.exec(manifestText);
}

const missingNlsKeys = [...placeholders].filter((key) => !(key in baseNls));
if (missingNlsKeys.length > 0) {
  console.error('Skill Bridge manifest localization mismatch');
  console.error('Missing keys in package.nls.json:');
  for (const key of missingNlsKeys) console.error(`- ${key}`);
  process.exit(1);
}

const localizedFiles = fs
  .readdirSync(root)
  .filter((name) => /^package\.nls(\.[^.]+)?\.json$/.test(name));

for (const fileName of localizedFiles) {
  const localized = JSON.parse(fs.readFileSync(path.join(root, fileName), 'utf8'));
  const missingKeys = [...placeholders].filter((key) => !(key in localized));
  if (missingKeys.length > 0) {
    console.error(`Skill Bridge localization file mismatch: ${fileName}`);
    console.error('Missing keys:');
    for (const key of missingKeys) console.error(`- ${key}`);
    process.exit(1);
  }
}

if (!vscodeIgnore.includes('!package.nls*.json')) {
  console.error('Skill Bridge packaging mismatch');
  console.error('Missing allowlist entry in .vscodeignore: !package.nls*.json');
  process.exit(1);
}

console.log(`Skill Bridge command/localization check passed (${declared.size} commands, ${placeholders.size} localization keys, ${localizedFiles.length} locale files).`);

function listFiles(dirPath, extension) {
  const results = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFiles(entryPath, extension));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(extension)) {
      results.push(entryPath);
    }
  }
  return results;
}
