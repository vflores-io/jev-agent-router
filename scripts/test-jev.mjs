// One-request live smoke test for Jev through OpenRouter. Never prints credentials.
import { loadConfig } from '../core/config.mjs';
import { resolveProvider } from '../core/key.mjs';
import { callJev } from '../core/jev.mjs';

const { cfg } = loadConfig();
const { provider, key } = resolveProvider({ ...cfg, provider: 'openrouter' });
if (!key) {
  console.error('OPENROUTER_API_KEY is missing in ~/.config/jev-router/.env');
  process.exitCode = 2;
} else {
  const body = {
    state: { sample: 'Hello there.' },
    questions: {
      kind: {
        type: 'choice',
        instructions: 'Which description best fits this short message?',
        criteria: {
          greeting: 'A greeting with no specific request',
          request: 'A request for information or action',
        },
      },
      actionable: {
        type: 'noul',
        instructions: 'Does the message ask for a specific action or information?',
      },
    },
  };

  const started = Date.now();
  try {
    const result = await callJev({ provider, key, cfg, body });
    if (result.answers?.kind?.type !== 'choice' || result.answers?.actionable?.type !== 'noul') {
      throw Object.assign(new Error('response did not contain the expected typed answers'), { code: 'shape' });
    }
    console.log(JSON.stringify({
      ok: true,
      provider,
      model: result.model ?? cfg.providers.openrouter.model,
      answers: result.answers,
      usage: result.usage ?? null,
      elapsed_ms: Date.now() - started,
    }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, provider, code: error.code ?? 'unknown', message: error.message }));
    process.exitCode = 1;
  }
}
