// Shared core: route(req) → decision. decide() is pure (no network) and holds all the rules.
// CLI: node core/route.mjs < request.json   → prints the decision JSON.
import { loadConfig } from './config.mjs';
import { resolveProvider } from './key.mjs';
import { buildRequest } from './questions.mjs';
import { callJev } from './jev.mjs';

const r2 = (x) => (typeof x === 'number' ? Math.round(x * 100) / 100 : x);

function summarise(answers) {
  const a = answers || {};
  return {
    probs: Object.fromEntries(Object.entries(a.tier?.probabilities || {}).map(([k, v]) => [k, r2(v)])),
    confidence: r2(a.tier?.confidence),
    stakes: r2(a.stakes?.score),
    ambiguous: r2(a.ambiguous?.noul),
    frontier: r2(a.frontier?.noul),
  };
}

export function decide(req, answers, cfg, harness = 'claude-code') {
  const ladder = cfg.ladders?.[harness];
  const canonical = ['haiku', 'sonnet', 'opus', 'fable'];
  const gated = new Set([ladder[ladder.length - 1], ...(cfg.gated_tiers?.[harness] || [])]);
  // Jev tier names map to each harness ladder by position.
  const byRule = (name) => ladder[canonical.indexOf(name)] ?? name;
  const pos = (name) => ladder.indexOf(name);
  const reasons = [];
  const jev = summarise(answers);
  const out = (action, model, why) => ({ action, model: model ?? null, reason: [...reasons, why].filter(Boolean).join('; '), jev });

  // 0. Allowed set
  const userModels = (req.user_models || []).filter((m) => pos(m) >= 0);
  if (userModels.length === 1) {
    if (gated.has(userModels[0]) && !req.gated_approved)
      return out('keep', null, 'gated_requires_approval');
    return out(userModels[0] === req.requested_model ? 'keep' : 'set', userModels[0], 'user_pinned');
  }
  let allowed = userModels.length ? [...userModels] : [...ladder];
  const disabled = Array.isArray(cfg.disabled_tiers)
    ? cfg.disabled_tiers
    : (cfg.disabled_tiers?.[harness] || []);
  allowed = allowed.filter((m) => !disabled.map(byRule).includes(m));
  allowed.sort((a, b) => pos(a) - pos(b));
  if (!allowed.length) return out('keep', null, 'nothing_allowed');

  // 2. Candidate from Jev, restricted to the allowed set
  const raw = answers?.tier?.probabilities || {};
  const pick = (set) => {
    const total = set.reduce((s, m) => s + (raw[m] || 0), 0);
    if (total <= 0) return null;
    const probs = Object.fromEntries(set.map((m) => [m, (raw[m] || 0) / total]));
    const best = set.reduce((a, b) => (probs[b] > probs[a] ? b : a));
    return { best, p: probs[best] };
  };
  let c = pick(allowed);
  if (!c) return out('keep', null, 'no_probabilities');
  if (gated.has(c.best)) {
    const frontier = answers?.frontier?.noul ?? 0;
    const strong = (raw[c.best] || 0) >= cfg.gated_min_prob && frontier >= cfg.gated_frontier_min;
    if (!strong) {
      reasons.push(`gated_${c.best}_below_bar(p=${r2(raw[c.best])},frontier=${r2(frontier)})`);
      allowed = allowed.filter((m) => !gated.has(m));
      c = allowed.length ? pick(allowed) : null;
      if (!c) return out('keep', null, 'gated_dropped_nothing_left');
    }
  }
  if (c.p < cfg.min_prob) return out('keep', null, `low_confidence(${c.best} p=${r2(c.p)})`);
  reasons.push(`jev:${c.best} p=${r2(c.p)}`);
  let cand = c.best;

  // 3. Floors — raise only, never into a gated tier, never above what the user allowed
  const nonGated = allowed.filter((m) => !gated.has(m));
  const ceiling = nonGated.length ? pos(nonGated[nonGated.length - 1]) : pos(allowed[0]);
  const raise = (name, why, enforced = true) => {
    const p = Math.min(pos(name), ceiling);
    if (p <= pos(cand) || p < 0) return;
    if (!enforced) return reasons.push(`would_floor:${ladder[p]}(${why})`);
    reasons.push(`floor:${ladder[p]}(${why})`);
    cand = ladder[p];
  };
  if (req.agent_definition_model && pos(req.agent_definition_model) >= 0 && !gated.has(cand))
    raise(req.agent_definition_model, 'agent_definition');
  const stakes = answers?.stakes?.score, amb = answers?.ambiguous?.noul;
  if (typeof stakes === 'number') {
    if (stakes >= cfg.stakes_opus) raise(byRule('opus'), `stakes ${r2(stakes)}`, cfg.floors_enforced);
    else if (stakes >= cfg.stakes_sonnet) raise(byRule('sonnet'), `stakes ${r2(stakes)}`, cfg.floors_enforced);
  }
  if (typeof amb === 'number' && amb >= cfg.ambiguous_opus) raise(byRule('opus'), `ambiguous ${r2(amb)}`, cfg.floors_enforced);

  // 4. Gated tier → ask the user unless already approved
  if (gated.has(cand)) {
    if (req.gated_approved) return out('set', cand, 'user_approved');
    return { ...out('ask', cand, 'gated_tier'), fallback: nonGated[nonGated.length - 1] ?? null };
  }

  // 5. Apply
  return cand === req.requested_model ? out('keep', cand, 'matches_request') : out('set', cand, '');
}

export async function route(req, { cfg, harness = 'claude-code' } = {}) {
  cfg = cfg || loadConfig().cfg;
  const t0 = Date.now();
  const { provider, key } = resolveProvider(cfg);
  if (!key) return { action: 'keep', model: null, reason: 'no_key', skip_reason: 'no_key', provider, latency_ms: 0 };
  // A single user-pinned model needs no Jev call.
  const ladder = cfg.ladders[harness];
  if (!Array.isArray(ladder) || ladder.length !== 4)
    return { action: 'keep', model: null, reason: 'invalid_model_ladder', skip_reason: 'invalid_model_ladder', provider, latency_ms: 0 };
  const pinned = (req.user_models || []).filter((m) => ladder.includes(m));
  if (pinned.length === 1) return { ...decide(req, null, cfg, harness), provider, latency_ms: 0 };
  try {
    const body = buildRequest(req, cfg, ladder);
    const res = await callJev({ provider, key, cfg, body });
    return { ...decide(req, res.answers, cfg, harness), provider, jev_model: res.model, usage: res.usage, latency_ms: Date.now() - t0 };
  } catch (e) {
    return { action: 'keep', model: null, reason: `jev_error:${e.code || 'unknown'}`, error: e.message, provider, latency_ms: Date.now() - t0 };
  }
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  let input = '';
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', async () => {
    const req = JSON.parse(input || '{}');
    const { cfg } = loadConfig();
    process.stdout.write(JSON.stringify(await route(req, { cfg, harness: req.harness || 'claude-code' }), null, 2) + '\n');
  });
}
