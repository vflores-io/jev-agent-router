import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkApproval, requestTagFor, spawnTag } from '../adapters/codex/approval.mjs';
import { codexModelArgs, handleSpawn } from '../adapters/codex/spawn.mjs';
import { decide } from '../core/route.mjs';

function config(dir, mode = 'live') {
  return {
    mode,
    ladders: {
      codex: ['model-small@low', 'model-mid@medium', 'model-strong@high', 'model-frontier@high'],
      'claude-code': ['haiku', 'sonnet', 'opus', 'fable'],
    },
    gated_tiers: { codex: ['model-frontier@high'], 'claude-code': ['fable'] },
    disabled_tiers: { codex: [], 'claude-code': [] },
    min_prob: 0.7, gated_min_prob: 0.85, gated_frontier_min: 0.8,
    floors_enforced: false, stakes_opus: 1.5, stakes_sonnet: 0.75,
    ambiguous_opus: 0.75, deny_paths: [],
    log_path: path.join(dir, 'decisions.jsonl'), state_dir: path.join(dir, 'sessions'), debug: false,
  };
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-codex-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('Codex ladder entries map configurable model and effort values', () => {
  assert.deepEqual(codexModelArgs('vendor/model-name@xhigh'), {
    model: 'vendor/model-name', reasoning_effort: 'xhigh',
  });
  assert.deepEqual(codexModelArgs('vendor/model-name'), { model: 'vendor/model-name' });
  assert.equal(codexModelArgs('vendor/model-name@unsupported'), null);
});

test('spawn routes without prior prompt state and preserves the complete input', async (t) => {
  const dir = tempDir(t); const cfg = config(dir);
  let req; let output;
  await handleSpawn({ session_id: 's1', cwd: '/tmp/project', tool_name: 'spawn_agent', tool_input: {
    task_name: 'inspect parser', message: 'Read parser and report findings', custom_field: 7,
    model: 'model-mid', reasoning_effort: 'medium',
  } }, {
    cfg, writeOutput: (x) => { output = x; },
    router: async (request, options) => {
      req = { request, options };
      return { action: 'set', model: 'model-strong@high', reason: 'test' };
    },
  });
  assert.equal(req.options.harness, 'codex');
  assert.equal(Object.hasOwn(req.request, 'phase'), false);
  assert.equal(req.request.brief, 'Read parser and report findings');
  assert.deepEqual(output.hookSpecificOutput.updatedInput, {
    task_name: 'inspect parser', message: 'Read parser and report findings', custom_field: 7,
    model: 'model-strong', reasoning_effort: 'high',
  });
  assert.equal(output.hookSpecificOutput.permissionDecision, 'allow');
});

test('shadow mode routes a spawn but does not rewrite its arguments', async (t) => {
  const dir = tempDir(t); const cfg = config(dir, 'shadow');
  let routed = false; let output;
  await handleSpawn({ session_id: 's2', cwd: '/tmp/project', tool_input: {
    task_name: 'read docs', message: 'Summarize the supplied documentation',
  } }, {
    cfg, writeOutput: (x) => { output = x; },
    router: async () => { routed = true; return { action: 'set', model: 'model-small@low' }; },
  });
  assert.equal(routed, true);
  assert.equal(output, undefined);
  const entry = JSON.parse(fs.readFileSync(cfg.log_path, 'utf8').trim());
  assert.equal(entry.harness, 'codex');
  assert.equal(entry.action, 'set');
});

test('configured denied paths skip the Jev call', async (t) => {
  const dir = tempDir(t); const cfg = config(dir); cfg.deny_paths = ['/private-area'];
  let routed = false;
  await handleSpawn({ session_id: 's3', cwd: '/tmp/private-area/project', tool_input: {
    task_name: 'inspect', message: 'This brief stays local',
  } }, { cfg, router: async () => { routed = true; return {}; } });
  assert.equal(routed, false);
  const entry = JSON.parse(fs.readFileSync(cfg.log_path, 'utf8').trim());
  assert.equal(entry.skip_reason, 'deny_path');
});

test('gated tier requires approval for the matching spawn and tier', async (t) => {
  const dir = tempDir(t); const cfg = config(dir);
  cfg.gated_tiers.codex = [];
  const taskName = 'review architecture'; const brief = 'Assess a risky migration';
  const hash = requestTagFor(taskName, brief); const transcript = path.join(dir, 'transcript.jsonl');
  const spawn = { session_id: 's4', cwd: '/tmp/project', transcript_path: transcript,
    tool_input: { task_name: taskName, message: brief } };
  let output;
  await handleSpawn(spawn, { cfg, writeOutput: (x) => { output = x; }, router: async () => ({
    action: 'ask', model: 'model-frontier@high', fallback: 'model-strong@high',
    jev: { probs: { 'model-frontier@high': 0.9 }, frontier: 0.9 },
  }) });
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(output.hookSpecificOutput.permissionDecisionReason.includes(spawnTag(hash)));
  assert.equal(checkApproval(transcript, hash, 'model-frontier@high').approved, false);

  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-1', output: `JEV-ROUTER: GATED-TIER ${spawnTag(hash)} blocked` } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', id: 'user-1', role: 'user', content: [{ type: 'input_text', text: `Approve ${spawnTag(hash)} for model-frontier@high` }] } }),
  ].join('\n'));
  assert.deepEqual(checkApproval(transcript, hash, 'model-frontier@high'), {
    approved: true, choice: 'model-frontier@high', answerId: 'user-1',
  });
  assert.equal(checkApproval(transcript, hash, 'model-frontier@high', ['user-1']).approved, false);
  assert.equal(checkApproval(transcript, 'another-spawn', 'model-frontier@high').approved, false);
});

test('disabled tiers are scoped to each harness', () => {
  const cfg = config('/tmp');
  cfg.disabled_tiers = { codex: ['haiku'], 'claude-code': [] };
  const d = decide({}, { tier: { probabilities: {
    'model-small@low': 0, 'model-mid@medium': 1, 'model-strong@high': 0, 'model-frontier@high': 0,
  } } }, cfg, 'codex');
  assert.equal(d.model, 'model-mid@medium');
});
