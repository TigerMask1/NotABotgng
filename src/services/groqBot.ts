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
    models = ['groq/compound-mini', 'llama-3.1-8b-instant', 'llama-3.3-70b-versatile']
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
              response_format: { type: 'json_object' }
            })
          });

          if (res.status === 429) {
            const body = await res.json().catch(() => ({})) as any;
            this.cooldowns.set(key, Date.now() + 10000);
            console.warn(`[Groq:${model}] ...${key.slice(-4)} 429`);
            lastError = '429 Rate Limit';
            continue;
          }

          if (!res.ok) {
            const err = await res.text().catch(() => res.statusText);
            throw new Error(`Groq ${res.status}: ${err.slice(0, 120)}`);
          }

          const data = await res.json() as any;
          const text = data.choices?.[0]?.message?.content ?? '';
          console.log(`[Groq:${model}] key=...${key.slice(-4)} | ${text.length}ch`);
          return text;
        } catch (e: any) {
          lastError = e.message ?? String(e);
          console.warn(`[Groq:${model}] attempt ${attempt + 1}: ${e.message?.slice(0, 80)}`);
          
          // If the model itself is not found or invalid (404/400), don't keep retrying this model, break to the next model
          if (e.message?.includes('404') || e.message?.includes('400')) {
            break;
          }
        }
      }
    }
    throw new Error(`[Groq] all attempts and models failed. Last error: ${lastError}`);
  }
}

export const groq = new GroqManager();
