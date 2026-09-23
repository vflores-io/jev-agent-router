// What we ask Jev. The four output categories map to each harness ladder by position.
const CANONICAL_TIERS = ['haiku', 'sonnet', 'opus', 'fable'];

export const DEFAULT_CRITERIA = {
  tier_instructions:
    'Which model tier is the cheapest one that will complete this subagent task well on the first attempt',
  tiers: {
    haiku:
      'Read-only or mechanical, clearly bounded work with an obvious definition of done and little judgement: find files or symbols, grep, list call sites, read and summarise given code or text, collect facts, reformat, rename, apply an exact specified edit, simple boilerplate',
    sonnet:
      'Everyday engineering where the approach is fairly clear and success can be checked by tests or review: implement a well-scoped feature or fix across a few files, write or extend tests, fix a bug with a clear failure signal, routine refactors or migrations, review a diff for correctness and style, research a well-defined question',
    opus:
      'The approach is unclear or mistakes are costly and hard to spot: architecture or design decisions, debugging with no obvious root cause, large or cross-cutting refactors, security review or threat analysis, red-teaming a whole body of work, synthesis across many sources, long autonomous multi-step work, or a task a Sonnet-class attempt already failed',
    fable:
      'Only when the brief itself reports that a previous attempt at this exact task by the strongest non-gated tier already failed or fell short. Never for difficulty, length, novelty or importance alone',
  },
  stakes: [
    'Cheap: exploratory or throwaway, mistakes are harmless',
    'Normal: mistakes will be caught by tests or review',
    'High: mistakes reach users or touch security, personal data, money, production or compliance',
  ],
  ambiguous:
    'The task leaves important decisions unspecified, so the agent must use judgement about what to build or conclude',
  frontier:
    'The brief explicitly states that an earlier attempt at this same task by the strongest non-gated tier was made and failed or fell short',
};

function truncate(s, max) {
  s = String(s ?? '');
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.7);
  return s.slice(0, head) + '\n…[truncated]…\n' + s.slice(s.length - (max - head));
}

// ladder contains harness model labels; criteria come from Jev's four output tiers.
export function buildRequest(req, cfg, ladder) {
  const c = { ...DEFAULT_CRITERIA, ...(cfg.criteria || {}) };
  const tiers = {};
  ladder.forEach((name, i) => (tiers[name] = c.tiers[CANONICAL_TIERS[i]] ?? c.tiers[name]));
  return {
    state: {
      agent_role: req.agent_type || 'general-purpose',
      task_title: req.description || '',
      task_brief: truncate(req.brief, cfg.max_brief_chars),
    },
    questions: {
      tier: { type: 'choice', instructions: c.tier_instructions, criteria: tiers },
      stakes: { type: 'score', instructions: 'How costly a mistake in this task\'s output would be', criteria: c.stakes },
      ambiguous: { type: 'noul', instructions: c.ambiguous },
      frontier: { type: 'noul', instructions: c.frontier },
    },
  };
}
