import { promises as fs } from "node:fs";

type CachedTextFile = {
  content: string;
  signature: string;
};

const cache = new Map<string, CachedTextFile>();

async function getSignature(target: string): Promise<string | null> {
  const stat = await fs.stat(target).catch(() => null);
  return stat ? `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` : null;
}

export async function writeTextFileIfChanged(target: string, content: string): Promise<boolean> {
  const cached = cache.get(target);
  if (cached?.content === content && await getSignature(target) === cached.signature) return false;

  const current = await fs.readFile(target, "utf8").catch(() => null);
  const changed = current !== content;
  if (changed) await fs.writeFile(target, content, "utf8");

  const signature = await getSignature(target);
  if (signature) cache.set(target, { content, signature });
  else cache.delete(target);
  return changed;
}
