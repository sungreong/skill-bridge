const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const manifestPath = path.join(root, 'package.json');
const extensionPath = path.join(root, 'src', 'extension.ts');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const src = fs.readFileSync(extensionPath, 'utf8');

const declared = new Set((manifest.contributes?.commands ?? []).map((c) => c.command));
const implemented = new Set();

const registerRegex = /register\("([^"]+)"/g;
let match = registerRegex.exec(src);
while (match) {
  implemented.add(match[1]);
  match = registerRegex.exec(src);
}

const missingInCode = [...declared].filter((id) => !implemented.has(id));
const missingInManifest = [...implemented].filter((id) => !declared.has(id));

if (missingInCode.length > 0 || missingInManifest.length > 0) {
  console.error('Skill Bridge manifest command mismatch');
  if (missingInCode.length > 0) {
    console.error('Declared but not implemented:');
    for (const id of missingInCode) console.error(`- ${id}`);
  }
  if (missingInManifest.length > 0) {
    console.error('Implemented but not declared:');
    for (const id of missingInManifest) console.error(`- ${id}`);
  }
  process.exit(1);
}

console.log(`Skill Bridge command check passed (${declared.size} commands).`);
