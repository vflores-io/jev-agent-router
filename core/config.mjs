// Config loading. Harness-neutral. Never throws: bad config → defaults + shadow mode.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_DIR = path.join(os.homedir(), '.config', 'jev-router');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export const expandHome = (p) => (p && p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

export const DEFAULTS = {
  mode: 'shadow', // off | shadow | live
  provider: 'openrouter',
  providers: {
    openrouter: { url: 'https://openrouter.ai/api/alpha/decisions', model: 'typesafe/jev-1.13' },
  },
  jev_timeout_ms: 2500,
  max_brief_chars: 24000,

  // Ladder order = cost order. Each harness ladder maps to Jev output tiers by position.
  ladders: { 'claude-code': ['haiku', 'sonnet', 'opus', 'fable'] },
  gated_tiers: { 'claude-code': ['fable'] },
  disabled_tiers: { 'claude-code': [], codex: [] },

  min_prob: 0.7,

  // Gated tier needs ALL of: tier pick with p >= gated_min_prob AND the
  // independent "frontier" check >= gated_frontier_min. Otherwise it is dropped
  // and the best non-gated tier is used.
  gated_min_prob: 0.85,
  gated_frontier_min: 0.8,

  // Stakes / ambiguity floors start as log-only. Enable after evaluating your ladder.
  floors_enforced: false,
  stakes_opus: 1.5,
  stakes_sonnet: 0.75,
  ambiguous_opus: 0.75,

  // Case-insensitive substrings of the working directory; matching repos are never routed
  // (their briefs never leave the machine). Set per user in config.json.
  deny_paths: [],

  log_path: '~/.local/state/jev-router/decisions.jsonl',
  state_dir: '~/.local/state/jev-router/sessions',
  debug: false,

  // Optional wording overrides for the classifier request.
  criteria: null, // null → built-in defaults in questions.mjs
};

function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? merge(base[k], v) : v;
  }
  return out;
}

export function loadConfig(file = CONFIG_PATH) {
  let cfg = DEFAULTS;
  let error = null;
  try {
    if (fs.existsSync(file)) cfg = merge(DEFAULTS, JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    error = `config_invalid: ${e.message}`;
    cfg = { ...DEFAULTS, mode: 'shadow' };
  }
  if (process.env.JEV_ROUTER === 'off') cfg = { ...cfg, mode: 'off' };
  return { cfg, error };
}
