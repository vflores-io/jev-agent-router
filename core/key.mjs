// Secrets: process env first, then ~/.config/jev-router/.env. Never logged.
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.mjs';

export function loadEnvFile(file = path.join(CONFIG_DIR, '.env')) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch {}
  return out;
}

const KEY_VARS = { openrouter: 'OPENROUTER_API_KEY' };

export function resolveProvider(cfg) {
  const env = { ...loadEnvFile(), ...process.env };
  const provider = cfg.provider || 'openrouter';
  const key = env[KEY_VARS[provider]] || null;
  return { provider, key };
}
