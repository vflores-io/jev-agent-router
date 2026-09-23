// Transcript-backed one-spawn approval. Codex documents transcript_path as
// convenient but unstable; unknown shapes therefore never grant approval.
import fs from 'node:fs';
import { sha } from '../../core/log.mjs';

export const MARKER = 'JEV-ROUTER: GATED-TIER';
export const spawnTag = (hash) => `[spawn:${String(hash).slice(0, 10)}]`;

function payloadOf(line) {
  try {
    const row = JSON.parse(line);
    if (row.type === 'response_item' && row.payload) return row.payload;
    // Accommodate the API-style envelope if Codex changes to it.
    if (row.message) return row.message;
  } catch {}
  return null;
}

function textOf(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((x) => x?.text ?? '').join('\n');
  return '';
}

export function checkApproval(transcriptPath, hash, gatedModel, consumed = []) {
  const none = { approved: false, choice: null, answerId: null };
  let lines;
  try { lines = fs.readFileSync(transcriptPath, 'utf8').split('\n'); } catch { return none; }
  const tag = spawnTag(hash);
  let blockedAt = -1;
  let blockedCall = null;
  const userAnswers = [];
  for (let i = 0; i < lines.length; i++) {
    const p = payloadOf(lines[i]);
    if (!p) continue;
    const content = textOf(p.output ?? p.content);
    if (p.type === 'custom_tool_call_output' && content.includes(MARKER) && content.includes(tag)) {
      blockedAt = i;
      blockedCall = p.call_id ?? p.id ?? null;
      continue;
    }
    if (p.type === 'message' && p.role === 'user' && i > blockedAt && blockedAt >= 0) {
      const txt = textOf(p.content).trim();
      const id = p.id ?? `line-${i}`;
      if (!consumed.includes(id)) userAnswers.push({ i, id, text: txt });
    }
  }
  // A user must approve this exact spawn and tier in their own transcript
  // message. A bare "yes", assistant text, or agent claim cannot authorize it.
  const modelToken = String(gatedModel).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const answer = userAnswers.find((a) =>
    new RegExp(`\\bapprove\\b[\\s\\S]*${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*\\b${modelToken}\\b`, 'i').test(a.text)
  );
  if (!answer || !blockedCall) return none;
  return { approved: true, choice: gatedModel, answerId: answer.id };
}

export const requestTagFor = (description, brief) => sha(`${description ?? ''}\n${brief ?? ''}`);
