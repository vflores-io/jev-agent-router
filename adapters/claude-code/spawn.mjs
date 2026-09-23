#!/usr/bin/env node
// PreToolUse hook on Agent|Task: pick the subagent's model with Jev.
// Invariant: exits 0 on every path; only the deliberate gated-tier block ever stops a spawn.
import { loadConfig } from '../../core/config.mjs';
import { readState, writeState } from '../../core/state.mjs';
import { route } from '../../core/route.mjs';
import { logDecision, debugLog, sha } from '../../core/log.mjs';
import { agentDefinitionModel } from './agentdefs.mjs';
import { checkApproval, MARKER, spawnTag } from './approval.mjs';

const emit = (obj) => obj && process.stdout.write(JSON.stringify(obj));

export async function handleSpawn(j, { cfg: suppliedCfg, router = route, transcriptApproval = checkApproval, writeOutput = emit } = {}) {
  const loaded = suppliedCfg ? { cfg: suppliedCfg, error: null } : loadConfig();
  const { cfg, error: cfgError } = loaded;
  const ti = j.tool_input || {};
  const base = {
    harness: 'claude-code', session_id: j.session_id, cwd: j.cwd, agent_type: ti.subagent_type || 'general-purpose',
    description: ti.description, brief_chars: String(ti.prompt ?? '').length, brief_sha: sha(ti.prompt),
    requested_model: ti.model ?? null, mode: cfg.mode, config_error: cfgError,
  };
  debugLog(cfg, 'spawn', { keys: Object.keys(j), tool_input_keys: Object.keys(ti), tool_name: j.tool_name });
  const skip = (why) => logDecision(cfg, { ...base, action: 'keep', skip_reason: why });

  if (cfg.mode === 'off') return;
  if (ti.subagent_type === 'fork') return skip('fork');
  if ((cfg.deny_paths || []).some((p) => String(j.cwd || '').toLowerCase().includes(p.toLowerCase()))) return skip('deny_path');
  const hash = sha(ti.description || ti.prompt);
  const state = readState(cfg, j.session_id);
  const ladder = cfg.ladders?.['claude-code'] || [];
  const gatedTiers = [...new Set([...(cfg.gated_tiers?.['claude-code'] || []), ladder.at(-1)].filter(Boolean))];
  const appr = transcriptApproval(
    j.transcript_path, hash, state.consumed_answers || [], ladder, gatedTiers,
  );
  if (appr.answerId) writeState(cfg, j.session_id, { consumed_answers: [...(state.consumed_answers || []), appr.answerId] });

  const req = {
    harness: 'claude-code', session_id: j.session_id, cwd: j.cwd,
    // A verified answer to the gated-tier question pins this one spawn to the user's choice.
    user_models: appr.choice ? [appr.choice] : [],
    agent_type: base.agent_type, agent_definition_model: agentDefinitionModel(ti.subagent_type, j.cwd),
    requested_model: base.requested_model, description: ti.description || '', brief: ti.prompt || '',
    gated_approved: appr.approved,
  };
  const d = await router(req, { cfg, harness: 'claude-code' });
  logDecision(cfg, {
    ...base, user_models: req.user_models, agent_definition_model: req.agent_definition_model,
    gated_approved: req.gated_approved, ...d, skip_reason: d.skip_reason ?? null,
  });

  if (cfg.mode !== 'live') return;
  if (d.action === 'set' && d.model) {
    // updatedInput replaces tool_input, and Claude Code requires allow to apply it.
    // Preserve the complete input and explicitly approve this selected spawn.
    return writeOutput({ hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { ...ti, model: d.model },
    } });
  }
  if (d.action === 'ask') {
    const p = d.jev?.probs?.[d.model];
    return writeOutput({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `${MARKER} ${spawnTag(hash)} Jev recommends ${d.model} for "${ti.description || 'this agent'}" ` +
          `(p=${p}, frontier=${d.jev?.frontier}, stakes=${d.jev?.stakes}). ${d.model} is gated and very expensive: ` +
          `do not spawn it without approval. Ask the user now with AskUserQuestion, options "Use ${d.model[0].toUpperCase() + d.model.slice(1)}", ` +
          `"Use ${d.fallback[0].toUpperCase() + d.fallback.slice(1)} (fallback)", "Skip this agent". Then re-spawn this same agent ` +
          `with the SAME description and the chosen model, or skip it. If several spawns were blocked this way, ask once for all of them.`,
      },
    });
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
