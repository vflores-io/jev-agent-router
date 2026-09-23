# Jev Agent Router

Choose a model for a coding agent's subagents with Jev, a small classifier
available through OpenRouter. The router supports Codex and Claude Code with
separate adapters over one shared decision core.

Jev runs when either harness is about to start an eligible subagent. Ordinary
user messages do not call Jev. The router selects the subagent's model; it does
not switch the model handling the main conversation. Jev receives the proposed
subagent task title and brief, not the conversation transcript.

## Requirements

- Node.js 20 or later
- Codex or Claude Code with command hooks enabled
- An OpenRouter API key with access to the Jev model

There are no npm dependencies. The router uses Node's built-in modules and
`fetch`.

## Install

Clone this repository somewhere that remains on disk, then create the shared
configuration directory:

```sh
mkdir -p ~/.config/jev-router
cp config.example.json ~/.config/jev-router/config.json
```

Edit `~/.config/jev-router/config.json`:

1. Replace every `your-...` Codex model slug with a model available to your
   account. A Codex ladder entry can be `model-slug` or
   `model-slug@reasoning-effort`.
2. Keep the entries in increasing cost order. The first, second, third, and
   fourth entries represent Jev's four output tiers.
3. The most expensive rung is always gated. `gated_tiers` can list additional
   rungs that should also require approval.
4. Configure the Claude Code ladder and gated tier using the model identifiers
   accepted by your Claude Code installation.

Save the key in `~/.config/jev-router/.env` and restrict its permissions:

```sh
printf '%s\n' 'OPENROUTER_API_KEY=paste-your-key-here' > ~/.config/jev-router/.env
chmod 600 ~/.config/jev-router/.env
```

The key can also be supplied through the process environment. Never commit the
key file.

## Enable Codex

Open `adapters/codex/hooks.json`, replace `/PATH/TO/jev-router` with the
absolute clone path, and merge its `hooks` entries into your active
`~/.codex/hooks.json`. Keep any existing hooks. The supplied hook listens only
for `PreToolUse` on `spawn_agent`; it does not register a prompt hook.

Review and trust the hook in Codex's `/hooks` interface. Start with
`"mode": "shadow"`: Jev decisions are logged, while requested models are left
unchanged. After inspecting decisions and verifying model availability, set
`"mode": "live"` to apply eligible decisions.

In live mode, Codex requires the hook to return `permissionDecision: "allow"`
with `updatedInput` for a rewritten `spawn_agent` call to take effect. This
approves that spawn call without the usual approval prompt; it does not grant
permissions to the spawned agent's later tool calls. Codex hooks do not
currently support `permissionDecision: "ask"` for this rewrite path.

Codex's `updatedInput` replaces the complete tool input, so the adapter copies
all existing spawn arguments before changing `model` and, when configured,
`reasoning_effort`. Unknown model/effort values are left alone.

## Enable Claude Code

Open `adapters/claude-code/hooks.json`, replace `/PATH/TO/jev-router` with the
absolute clone path, and merge its `hooks` entry into your active
`~/.claude/settings.json`. Keep existing settings. The supplied hook listens
only for `PreToolUse` on `Agent` and `Task` tool calls; it does not register a
prompt hook.

Start in `shadow` mode and inspect the decision log before switching to `live`.
Claude Code's hook `updatedInput` replaces the complete tool input; the adapter
preserves the original fields and changes only the selected model.

In live mode, the adapter pairs `updatedInput` with
`permissionDecision: "allow"`, so a routed `Agent` or `Task` spawn skips its
usual permission prompt. This approves only the spawn call; the subagent's
later tool calls still follow Claude Code's permission rules. Matching deny or
ask rules continue to apply. If you prefer to confirm each routed spawn, change
the adapter to return `permissionDecision: "ask"` with `updatedInput`; Claude
Code will show the rewritten call for confirmation, but routing will no longer
be prompt-free.

## Configuration and behavior

- `mode`: `off`, `shadow`, or `live`. Shadow mode makes Jev calls on eligible
  spawns but does not change the chosen model.
- Fork-style tasks and configured denied paths are skipped.
- `ladders`: model identifiers, cheapest to most expensive, for each harness.
  Keep four rungs so they align with Jev's four classifier outputs.
- `gated_tiers`: optional additional rungs for each harness to gate. The most
  expensive rung is always gated. A strong Jev result can recommend a gated
  rung, but the adapter blocks that spawn until the user approves that exact
  task and tier in the transcript. Missing or unrecognized transcript data
  never counts as approval.
- `disabled_tiers`: tiers disabled separately for each harness.
- `deny_paths`: working-directory substrings that must never be sent to Jev.
- `floors_enforced`: when enabled, higher stakes or ambiguity can raise the
  selected rung, but never into a gated rung.

The router fails open on configuration, network, timeout, or response errors:
it leaves the harness's requested model in place. A deliberately gated spawn
is the exception and remains blocked until approved. Approval is checked by the
adapter from the user's transcript message, not from an agent's claim.

Codex exposes its transcript path as an unstable interface. The Codex approval
parser accepts only recognized transcript records and fails closed if the
format is missing or changes. Recheck this behavior after harness upgrades.
Hooks are a useful guardrail, not a complete security boundary; specialized
execution paths may bypass hooks.

## Data and logs

Configuration is stored at `~/.config/jev-router/config.json`; the API key is
read from `~/.config/jev-router/.env`. Decision logs default to
`~/.local/state/jev-router/decisions.jsonl`, and per-session approval state to
`~/.local/state/jev-router/sessions/`. Logs contain harness, task title, chosen
action/model, timing, and a hash of the task brief. They do not contain the raw
brief. Review `deny_paths` and log permissions for your work.

Set `JEV_ROUTER=off` in the hook environment or set `"mode": "off"` for the
kill switch.

## Check it

Offline tests require only Node.js:

```sh
node --test test/*.test.mjs
```

An optional live smoke test makes one inexpensive Jev request:

```sh
node scripts/test-jev.mjs
```

The smoke test never prints credentials. For a controlled live rollout, first
confirm a real subagent's model in the harness session metadata rather than
relying only on router logs.

## Layout

- `core/` — classifier request, decision rules, configuration, logs, and state
- `adapters/codex/` — Codex spawn hook
- `adapters/claude-code/` — Claude Code spawn hook
- `test/` — offline behavior tests
- `config.example.json` — starting point; model slugs must be customized

Contributions and reports of incorrect model choices are welcome. Please omit
private task details and credentials from issues and logs.
