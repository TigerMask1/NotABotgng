export class GroqManager {
  private keys: string[];
  private idx = 0;
  private cooldowns = new Map<string, number>();

  constructor() {
    const raw = process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || '';
    this.keys = raw.split(',').map(k => k.trim()).filter(Boolean);
    if (!this.keys.length) console.warn('[Groq] no keys found in GROQ_API_KEYS');
    else console.log(`[Groq] ${this.keys.length} key(s) loaded`);
  }

  canCall(): boolean { return this.keys.length > 0; }

  private pickKey(): string | null {
    const now = Date.now();
    for (let i = 0; i < this.keys.length; i++) {
      const k = this.keys[(this.idx + i) % this.keys.length];
      if (!this.cooldowns.get(k) || now > this.cooldowns.get(k)!) {
        this.idx = (this.idx + i + 1) % this.keys.length;
        return k;
      }
    }
    return this.keys[0]; // fallback
  }

  async call(
    systemPrompt: string,
    userPrompt: string,
    temp = 0.5,
    // JSON-mode-compatible models first. groq/compound-mini does NOT support
    // response_format: json_object (it's a compound system, not a plain LLM)
    // so it is intentionally excluded from the default model list.
    // llama-3.1-8b-instant is deprecated as of mid-2026.
    models = ['llama-3.3-70b-versatile', 'openai/gpt-oss-20b'],
    jsonMode = true
  ): Promise<string> {
    const maxAttempts = Math.min(3, Math.max(this.keys.length, 1) * 2);
    let lastError = '';

    for (const model of models) {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const key = this.pickKey();
        if (!key) throw new Error('[Groq] no keys available');

        try {
          const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${key}`
            },
            body: JSON.stringify({
              model: model,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
              ],
              temperature: temp,
              ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
              // Hard cap: prevent runaway calls from sitting for >8s
              max_tokens: 512,
            })
          });

          if (res.status === 429) {
            const body = await res.json().catch(() => ({})) as any;
            // Respect the Retry-After from the header if available
            const retryAfterSec = parseInt(res.headers.get('retry-after') || '10', 10);
            this.cooldowns.set(key, Date.now() + retryAfterSec * 1000);
            console.warn(`[Groq:${model}] ...${key.slice(-4)} 429 — cd ${retryAfterSec}s`);
            lastError = '429 Rate Limit';
            continue;
          }

          if (!res.ok) {
            const err = await res.text().catch(() => res.statusText);
            const errShort = err.slice(0, 200);
            console.warn(`[Groq:${model}] ${res.status}: ${errShort}`);
            lastError = `${res.status}: ${errShort}`;
            // Model-level error (400/404): skip remaining attempts for this model
            if (res.status === 400 || res.status === 404) break;
            throw new Error(`Groq ${res.status}: ${errShort}`);
          }

          const data = await res.json() as any;
          const text = data.choices?.[0]?.message?.content ?? '';
          if (!text.trim()) {
            lastError = 'empty response';
            console.warn(`[Groq:${model}] empty response, retrying`);
            continue;
          }
          console.log(`[Groq:${model}] key=...${key.slice(-4)} | ${text.length}ch`);
          return text;

        } catch (e: any) {
          lastError = e.message ?? String(e);
          console.warn(`[Groq:${model}] attempt ${attempt + 1}: ${e.message?.slice(0, 80)}`);

          // Model-level error: no point retrying the same model
          if (e.message?.includes('404') || e.message?.includes('400')) break;
        }
      }
    }

    // All Groq attempts exhausted — fall back to Gemini
    console.warn(`[Groq] All attempts failed (${lastError}). Falling back to Gemini...`);
    try {
      const { gemini } = await import('./geminiBot.ts');
      // Use the same ACTIVE_MODEL that geminiBot defaults to
      return await gemini.call(systemPrompt, userPrompt, temp, undefined, [], jsonMode ? undefined : 0);
    } catch (fallbackError: any) {
      throw new Error(`[Groq] all Groq models failed and Gemini fallback also failed. Groq error: ${lastError}. Gemini error: ${fallbackError.message}`);
    }
  }
}

export const groq = new GroqManager();
