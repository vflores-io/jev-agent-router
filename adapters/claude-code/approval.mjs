// Verify, from the transcript itself, whether the user approved a gated-tier spawn.
// The orchestrator cannot write AskUserQuestion results, so its say-so is never enough.
import fs from 'node:fs';

export const MARKER = 'JEV-ROUTER: GATED-TIER';
export const spawnTag = (hash) => `[spawn:${hash.slice(0, 10)}]`;

// Returns { approved: bool, choice: '<configured rung>'|null, answerId }
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function checkApproval(
  transcriptPath,
  hash,
  consumed = [],
  ladder = ['haiku', 'sonnet', 'opus', 'fable'],
  gatedTiers = ['fable'],
) {
  const none = { approved: false, choice: null, answerId: null };
  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
  } catch {
    return none;
  }
  const tag = spawnTag(hash);
  const askIds = new Set();
  let blockedAt = -1;
  const answers = [];
  lines.forEach((line, i) => {
    if (!line) return;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      return;
    }
    const content = j.message?.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b.type === 'tool_use' && b.name === 'AskUserQuestion') askIds.add(b.id);
      if (b.type !== 'tool_result') continue;
      const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
      if (text.includes(MARKER) && text.includes(tag)) blockedAt = i;
      if (askIds.has(b.tool_use_id) && j.type === 'user') answers.push({ i, id: b.tool_use_id, text, result: j.toolUseResult });
    }
  });
  if (blockedAt < 0) return none;
  const ans = answers.filter((a) => a.i > blockedAt && !consumed.includes(a.id)).pop();
  if (!ans) return none;
  const chosen = Object.values(ans.result?.answers || {}).join(' ') || ans.text;
  const choice = ladder.find((model) => new RegExp(`\\buse\\s+${escapeRegex(model)}\\b`, 'i').test(chosen));
  if (choice) return { approved: gatedTiers.includes(choice), choice, answerId: ans.id };
  return none;
}
