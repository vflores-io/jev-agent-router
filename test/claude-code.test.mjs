import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkApproval, MARKER, spawnTag } from '../adapters/claude-code/approval.mjs';
import { handleSpawn } from '../adapters/claude-code/spawn.mjs';

function config(dir) {
  return {
    mode: 'live',
    ladders: { 'claude-code': ['haiku', 'sonnet', 'opus', 'fable'] },
    gated_tiers: { 'claude-code': ['fable'] },
    disabled_tiers: { 'claude-code': [], codex: [] },
    deny_paths: [], log_path: path.join(dir, 'decisions.jsonl'),
    state_dir: path.join(dir, 'sessions'), debug: false,
  };
}

test('Claude Code spawn routes without per-message setup and preserves every input field', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-claude-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = config(dir); let routed; let output;
  const input = {
    subagent_type: 'general-purpose', description: 'Inspect a parser',
    prompt: 'Read parser.mjs and summarize its behavior.', model: 'haiku',
    custom_field: { retain: true },
  };
  await handleSpawn({ session_id: 'session-1', cwd: '/tmp/project', tool_name: 'Agent', tool_input: input }, {
    cfg,
    router: async (req, options) => {
      routed = { req, options };
      return { action: 'set', model: 'sonnet' };
    },
    writeOutput: (value) => { output = value; },
  });
  assert.equal(routed.options.harness, 'claude-code');
  assert.equal(Object.hasOwn(routed.req, 'phase'), false);
  assert.equal(routed.req.brief, input.prompt);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'allow');
  assert.deepEqual(output.hookSpecificOutput.updatedInput, { ...input, model: 'sonnet' });
});

test('Claude Code approval matches the exact configured gated rung and spawn', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-claude-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const transcript = path.join(dir, 'transcript.jsonl');
  const hash = 'abcde0123456789'; const tag = spawnTag(hash);
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'block', content: `${MARKER} ${tag}` }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'ask', name: 'AskUserQuestion', input: {} }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'ask', content: 'answered' }] }, toolUseResult: { answers: { choice: 'Use vendor/premium@high' } } }),
  ].join('\n'));
  const ladder = ['vendor/cheap@low', 'vendor/standard@medium', 'vendor/strong@high', 'vendor/premium@high'];
  assert.deepEqual(checkApproval(transcript, hash, [], ladder, ['vendor/premium@high']), {
    approved: true, choice: 'vendor/premium@high', answerId: 'ask',
  });
  assert.equal(checkApproval(transcript, hash, ['ask'], ladder, ['vendor/premium@high']).approved, false);
  assert.equal(checkApproval(transcript, 'other-spawn', [], ladder, ['vendor/premium@high']).approved, false);
});
