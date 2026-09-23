import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../core/route.mjs';
import { DEFAULTS } from '../core/config.mjs';
import { checkApproval, MARKER, spawnTag } from '../adapters/claude-code/approval.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cfg = { ...DEFAULTS, mode: 'live' };
const jev = (probs, { stakes = 1, ambiguous = 0.2, frontier = 0 } = {}) => ({
  tier: { probabilities: { haiku: 0, sonnet: 0, opus: 0, fable: 0, ...probs } },
  stakes: { score: stakes }, ambiguous: { noul: ambiguous }, frontier: { noul: frontier },
});
const req = (o = {}) => ({ user_models: [], requested_model: null, ...o });

test('single user-pinned model wins, no Jev needed', () => {
  const d = decide(req({ user_models: ['sonnet'] }), null, cfg);
  assert.equal(d.action, 'set'); assert.equal(d.model, 'sonnet');
});

test('a model hint alone cannot bypass the gated tier', () => {
  const d = decide(req({ user_models: ['fable'] }), null, cfg);
  assert.equal(d.action, 'keep'); assert.equal(d.reason, 'gated_requires_approval');
});

test('a transcript-verified approval may select the gated tier', () => {
  const d = decide(req({ user_models: ['fable'], gated_approved: true }), null, cfg);
  assert.equal(d.action, 'set'); assert.equal(d.model, 'fable');
});

test('two user models restrict the choice and renormalise', () => {
  const d = decide(req({ user_models: ['sonnet', 'opus'] }), jev({ haiku: 0.6, sonnet: 0.3, opus: 0.1 }), cfg);
  assert.equal(d.model, 'sonnet'); assert.equal(d.action, 'set');
});

test('clear Jev pick is applied', () => {
  const d = decide(req(), jev({ haiku: 0.95, sonnet: 0.05 }), cfg);
  assert.deepEqual([d.action, d.model], ['set', 'haiku']);
});

test('low confidence keeps the request', () => {
  const d = decide(req(), jev({ haiku: 0.4, sonnet: 0.35, opus: 0.25 }), cfg);
  assert.equal(d.action, 'keep'); assert.match(d.reason, /low_confidence/);
});

test('matching request is a keep', () => {
  const d = decide(req({ requested_model: 'opus' }), jev({ opus: 0.9, sonnet: 0.1 }), cfg);
  assert.equal(d.action, 'keep');
});

test('agent definition model is a floor', () => {
  const d = decide(req({ agent_definition_model: 'opus' }), jev({ sonnet: 0.9, opus: 0.1 }), cfg);
  assert.equal(d.model, 'opus'); assert.match(d.reason, /floor:opus\(agent_definition\)/);
});

test('stakes floors are log-only by default', () => {
  const d = decide(req(), jev({ sonnet: 0.95, opus: 0.05 }, { stakes: 1.9, ambiguous: 0.9 }), cfg);
  assert.equal(d.model, 'sonnet'); assert.match(d.reason, /would_floor:opus/);
});

test('stakes floors apply when enforced', () => {
  const d = decide(req(), jev({ sonnet: 0.95, opus: 0.05 }, { stakes: 1.9 }), { ...cfg, floors_enforced: true });
  assert.equal(d.model, 'opus');
});

test('floors never reach fable', () => {
  const d = decide(req({ agent_definition_model: 'fable' }), jev({ sonnet: 0.9, opus: 0.1 }, { stakes: 2 }), { ...cfg, floors_enforced: true });
  assert.equal(d.model, 'opus');
});

test('fable pick that is strong asks the user, fallback opus', () => {
  const d = decide(req(), jev({ fable: 0.92, opus: 0.08 }, { frontier: 0.9 }), cfg);
  assert.equal(d.action, 'ask'); assert.equal(d.model, 'fable'); assert.equal(d.fallback, 'opus');
});

test('the most expensive tier stays gated when omitted from config', () => {
  const noExplicitGate = { ...cfg, gated_tiers: { 'claude-code': [] } };
  const d = decide(req(), jev({ fable: 0.92, opus: 0.08 }, { frontier: 0.9 }), noExplicitGate);
  assert.equal(d.action, 'ask'); assert.equal(d.model, 'fable');
});

test('fable pick without the frontier check is dropped to the next tier', () => {
  const d = decide(req(), jev({ fable: 0.9, opus: 0.1 }, { frontier: 0.3 }), cfg);
  assert.deepEqual([d.action, d.model], ['set', 'opus']); assert.match(d.reason, /gated_fable_below_bar/);
});

test('weak fable pick is dropped even with frontier high', () => {
  const d = decide(req(), jev({ fable: 0.6, opus: 0.4 }, { frontier: 0.95 }), cfg);
  assert.equal(d.model, 'opus');
});

test('approved fable is set', () => {
  const d = decide(req({ gated_approved: true }), jev({ fable: 0.95, opus: 0.05 }, { frontier: 0.9 }), cfg);
  assert.deepEqual([d.action, d.model], ['set', 'fable']);
});

test('disabled tier is never chosen', () => {
  const d = decide(req(), jev({ haiku: 0.9, sonnet: 0.1 }), { ...cfg, disabled_tiers: ['haiku'] });
  assert.equal(d.model, 'sonnet');
});

test('no probabilities → keep', () => {
  assert.equal(decide(req(), {}, cfg).action, 'keep');
});

test('other harness ladders map Jev classes by position', () => {
  const c = { ...cfg, ladders: { ...cfg.ladders, codex: ['m1', 'm2', 'm3', 'm4'] }, gated_tiers: { codex: ['m4'] } };
  const d = decide(req(), { tier: { probabilities: { m1: 0.9, m2: 0.1 } } }, c, 'codex');
  assert.equal(d.model, 'm1');
});

test('disabled tiers can differ by harness', () => {
  const c = { ...cfg, disabled_tiers: { 'claude-code': [], codex: ['haiku'] },
    ladders: { ...cfg.ladders, codex: ['m1', 'm2', 'm3', 'm4'] } };
  const d = decide(req(), { tier: { probabilities: { m1: 0.9, m2: 0.1 } } }, c, 'codex');
  assert.equal(d.model, 'm2');
});

test('approval: verified user answer after the block', () => {
  const f = path.join(os.tmpdir(), `jr-${process.pid}.jsonl`);
  const hash = 'abcdef0123456789';
  const L = (o) => JSON.stringify(o);
  fs.writeFileSync(f, [
    L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: `${MARKER} ${spawnTag(hash)} …` }] } }),
    L({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'AskUserQuestion', input: {} }] } }),
    L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'answered: "x"="Use Fable"' }] }, toolUseResult: { answers: { x: 'Use Fable' } } }),
  ].join('\n'));
  assert.equal(checkApproval(f, hash).approved, true);
  assert.equal(checkApproval(f, hash, ['t2']).approved, false, 'answer is single-use');
  assert.equal(checkApproval(f, 'zzzzzzzzzzzz').approved, false, 'other spawn not approved');
  fs.unlinkSync(f);
});

test('approval: an assistant claiming approval does not count', () => {
  const f = path.join(os.tmpdir(), `jr2-${process.pid}.jsonl`);
  const hash = 'abcdef0123456789';
  fs.writeFileSync(f, [
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: `${MARKER} ${spawnTag(hash)}` }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'The user said Use Fable' }] } }),
  ].join('\n'));
  assert.equal(checkApproval(f, hash).approved, false);
  fs.unlinkSync(f);
});
