#!/usr/bin/env node
// PreToolUse hook on Codex's spawn_agent (matcher alias Agent).
// Shared core decides; every uncertain/error path lets the spawn proceed.
import { loadConfig } from '../../core/config.mjs';
import { readState, writeState } from '../../core/state.mjs';
import { route } from '../../core/route.mjs';
import { logDecision, debugLog, sha } from '../../core/log.mjs';
import { checkApproval, MARKER, requestTagFor, spawnTag } from './approval.mjs';

const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'ultra']);

// Ladder entries are model slugs, optionally followed by @reasoning_effort.
// For example: "your-codex-model@high". Keep this mapping user-configurable.
export function codexModelArgs(rung) {
  const value = String(rung || '');
  const split = value.lastIndexOf('@');
  if (split < 1) return value ? { model: value } : null;
  const model = value.slice(0, split);
  const reasoning_effort = value.slice(split + 1);
  if (!EFFORTS.has(reasoning_effort)) return null;
  return { model, reasoning_effort };
}

const emit = (obj) => obj && process.stdout.write(JSON.stringify(obj));

export async function handleSpawn(j, { cfg: suppliedCfg, router = route, transcriptApproval = checkApproval, writeOutput = emit } = {}) {
  const { cfg, error: cfgError } = suppliedCfg ? { cfg: suppliedCfg, error: null } : loadConfig();
  const ti = j.tool_input || {};
  const taskName = String(ti.task_name ?? ti.description ?? 'subagent');
  const brief = String(ti.message ?? ti.prompt ?? '');
  const description = `${taskName}\n${brief}`.trim();
  const base = {
    harness: 'codex', session_id: j.session_id, cwd: j.cwd, agent_type: taskName,
    description: taskName, brief_chars: brief.length, brief_sha: sha(brief),
    requested_model: ti.model ? `${ti.model}${ti.reasoning_effort ? `@${ti.reasoning_effort}` : ''}` : null,
    mode: cfg.mode, config_error: cfgError,
  };
  const skip = (why) => logDecision(cfg, { ...base, action: 'keep', skip_reason: why });

  if (cfg.mode === 'off') return;
  if (ti.fork === true || ti.fork_turns === 'all' || ti.context_mode === 'fork' || ti.subagent_type === 'fork') return skip('fork');
  if ((cfg.deny_paths || []).some((p) => String(j.cwd || '').toLowerCase().includes(p.toLowerCase()))) return skip('deny_path');
  const hash = requestTagFor(taskName, brief);
  const state = readState(cfg, j.session_id);
  const ladder = cfg.ladders?.codex || [];
  const gatedModels = [...new Set([...(cfg.gated_tiers?.codex || []), ladder.at(-1)].filter((m) => ladder.includes(m)))];
  const appr = gatedModels.map((model) => transcriptApproval(
    j.transcript_path, hash, model, state.consumed_answers || [],
  )).find((result) => result.approved) || { approved: false };
  if (appr.answerId) writeState(cfg, j.session_id, { consumed_answers: [...(state.consumed_answers || []), appr.answerId] });

  const req = {
    harness: 'codex', session_id: j.session_id, cwd: j.cwd,
    // Only the transcript-verified, one-spawn answer above can select the gated rung.
    user_models: appr.approved
      ? [appr.choice]
      : [],
    agent_type: taskName, requested_model: base.requested_model,
    description: taskName, brief, gated_approved: appr.approved,
  };
  let d;
  try {
      d = await router(req, { cfg, harness: 'codex' });
  } catch (e) {
    return logDecision(cfg, { ...base, action: 'keep', skip_reason: `router_error:${e?.code || 'unknown'}` });
  }
  logDecision(cfg, {
    ...base, user_models: req.user_models, gated_approved: req.gated_approved,
    ...d, skip_reason: d.skip_reason ?? null,
  });
  debugLog(cfg, 'codex-spawn', { tool_name: j.tool_name, tool_input_keys: Object.keys(ti), action: d.action });
  if (cfg.mode !== 'live') return;
  if (d.action === 'set' && d.model) {
    const chosen = codexModelArgs(d.model);
    if (!chosen) return;
    // Codex specifies updatedInput as the replacement arguments object.
    return writeOutput({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'allow',
      updatedInput: { ...ti, ...chosen },
    } });
  }
  if (d.action === 'ask' && d.model) {
    const tag = spawnTag(hash);
    const exact = `Approve ${tag} for ${d.model}`;
    return writeOutput({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason:
        `${MARKER} ${tag} Jev recommends ${d.model} for "${taskName}" (p=${d.jev?.probs?.[d.model]}, frontier=${d.jev?.frontier}). ` +
        `Do not spawn at this tier yet. Ask the user whether to approve this exact spawn. The user must reply exactly: "${exact}". ` +
        `After that reply, re-issue this identical spawn. A different choice or any ambiguity must leave this tier unused.`,
    } });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let input = '';
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', async () => {
    try { await handleSpawn(JSON.parse(input)); } catch {}
    process.exit(0);
  });
}
