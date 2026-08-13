export type ParsedNpxSkillsAddCommand = {
  repoUrl: string;
  skills: string[];
};

export function parseNpxSkillsAddCommand(input: string): ParsedNpxSkillsAddCommand | null {
  const tokens = tokenizeCommand(input.trim());
  if (!tokens || tokens.length < 4) return null;
  if (tokens[0] === "$" || tokens[0] === ">") tokens.shift();
  if (!/^(?:npx|npx\.cmd)$/i.test(tokens.shift() ?? "")) return null;
  if (tokens[0] === "-y" || tokens[0] === "--yes") tokens.shift();
  if (tokens.shift() !== "skills" || tokens.shift() !== "add") return null;

  let repoUrl = "";
  const skills: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "--skill" || token === "-s") {
      const skill = tokens[index + 1];
      if (!skill || skill.startsWith("-")) return null;
      skills.push(skill);
      index += 1;
      continue;
    }
    if (token.startsWith("--skill=")) {
      const skill = token.slice("--skill=".length).trim();
      if (!skill) return null;
      skills.push(skill);
      continue;
    }
    if (token === "--agent" || token === "-a") {
      index += 1;
      while (index + 1 < tokens.length && !(tokens[index + 1] ?? "").startsWith("-")) index += 1;
      continue;
    }
    if (["--copy", "--yes", "-y", "--all", "--global", "-g"].includes(token)) continue;
    if (token.startsWith("-")) return null;
    if (repoUrl) return null;
    repoUrl = token;
  }
  if (!repoUrl || /[;&|<>]/.test(repoUrl)) return null;
  return { repoUrl, skills: [...new Set(skills.length > 0 ? skills : ["*"])] };
}

function tokenizeCommand(input: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index] ?? "";
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (quote) return null;
  if (current) tokens.push(current);
  return tokens;
}
