// Small per-session state used for one-time approval tracking.
import fs from 'node:fs';
import path from 'node:path';
import { expandHome } from './config.mjs';

const file = (cfg, sessionId) =>
  path.join(expandHome(cfg.state_dir), `${String(sessionId).replace(/[^\w.-]/g, '_')}.json`);

export function readState(cfg, sessionId) {
  try {
    return JSON.parse(fs.readFileSync(file(cfg, sessionId), 'utf8'));
  } catch {
    return {};
  }
}

export function writeState(cfg, sessionId, patch) {
  try {
    const f = file(cfg, sessionId);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ ...readState(cfg, sessionId), ...patch }));
  } catch {}
}
