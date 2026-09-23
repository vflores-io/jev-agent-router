// Append-only JSONL log. One write per line so concurrent sessions don't interleave. Never throws.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { expandHome } from './config.mjs';

export const sha = (s) => crypto.createHash('sha256').update(String(s ?? '')).digest('hex');

export function logDecision(cfg, entry) {
  try {
    const file = expandHome(cfg.log_path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch {}
}

export function debugLog(cfg, name, obj) {
  if (!cfg.debug) return;
  try {
    const file = path.join(path.dirname(expandHome(cfg.log_path)), `debug-${name}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n');
  } catch {}
}
