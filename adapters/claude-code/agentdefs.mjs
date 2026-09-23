// Find the `model:` pinned in an agent definition's frontmatter. Built-ins → null.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BUILTIN = new Set(['general-purpose', 'Explore', 'Plan', 'fork', 'claude', 'statusline-setup', 'claude-code-guide']);

function find(dir, name, depth = 0) {
  if (depth > 3) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) if (e.isFile() && e.name === `${name}.md`) return path.join(dir, e.name);
  for (const e of entries) if (e.isDirectory()) {
    const hit = find(path.join(dir, e.name), name, depth + 1);
    if (hit) return hit;
  }
  return null;
}

export function agentDefinitionModel(type, cwd) {
  if (!type || BUILTIN.has(type) || type.includes(':')) return null;
  for (const dir of [path.join(cwd || '.', '.claude', 'agents'), path.join(os.homedir(), '.claude', 'agents')]) {
    const f = find(dir, type);
    if (!f) continue;
    const fm = fs.readFileSync(f, 'utf8').match(/^---\n([\s\S]*?)\n---/);
    const m = fm?.[1].match(/^model:\s*["']?([\w.-]+)/m);
    const model = m?.[1]?.toLowerCase();
    return model && model !== 'inherit' ? model : null;
  }
  return null;
}
