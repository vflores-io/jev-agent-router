// Jev client. OpenRouter and TypeSafe share the {model, state, questions} body and answer shape.
// Returns { answers, usage, model } or throws Error with .code.

export async function callJev({ provider, key, cfg, body }) {
  const p = cfg.providers?.[provider];
  if (!p) throw Object.assign(new Error(`unknown provider ${provider}`), { code: 'provider' });
  const deadline = Date.now() + cfg.jev_timeout_ms;
  for (let attempt = 0; attempt < 2; attempt++) {
    const left = deadline - Date.now();
    if (left <= 50) break;
    let res;
    try {
      res = await fetch(p.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: p.model, ...body }),
        signal: AbortSignal.timeout(left),
      });
    } catch (e) {
      throw Object.assign(new Error(e.name === 'TimeoutError' ? 'timeout' : e.message), { code: 'network' });
    }
    if (res.ok) {
      const j = await res.json();
      if (!j.answers) throw Object.assign(new Error('no answers in response'), { code: 'shape' });
      return j;
    }
    if ((res.status === 429 || res.status === 529) && attempt === 0) {
      await new Promise((r) => setTimeout(r, 150));
      continue;
    }
    const text = (await res.text().catch(() => '')).slice(0, 200);
    throw Object.assign(new Error(`HTTP ${res.status} ${text}`), { code: String(res.status) });
  }
  throw Object.assign(new Error('timeout'), { code: 'timeout' });
}
