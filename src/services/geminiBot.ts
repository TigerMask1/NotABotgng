import * as fs from 'node:fs';
import { Telemetry } from './telemetry.ts';

const ACTIVE_MODEL = 'gemini-3.1-flash-lite';
const DEBUG_LOG_REQUESTS = process.env.DEBUG_LOG_REQUESTS === 'true';

interface ImagePart { mimeType: string; data: string; }

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

export class GeminiManager {
  private keys: string[];
  private idx = 0;
  private cooldowns = new Map<string, number>();

  private keyStats = new Map<string, { rpm: number; rpd: number; lastMin: number; lastDay: number }>();

  private getPacificDay(nowMs: number) {
    return Math.floor((nowMs - 7 * 3600_000) / 86400_000);
  }

  private trackRequest(key: string): { rpm: number; rpd: number } {
    const nowMs = Date.now();
    const currMin = Math.floor(nowMs / 60_000);
    const currDay = this.getPacificDay(nowMs);
    
    let stats = this.keyStats.get(key);
    if (!stats) {
      stats = { rpm: 0, rpd: 0, lastMin: currMin, lastDay: currDay };
      this.keyStats.set(key, stats);
    }
    
    if (stats.lastMin !== currMin) { stats.rpm = 0; stats.lastMin = currMin; }
    if (stats.lastDay !== currDay) { stats.rpd = 0; stats.lastDay = currDay; }
    
    stats.rpm++;
    stats.rpd++;
    return { rpm: stats.rpm, rpd: stats.rpd };
  }

  constructor() {
    const raw = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
    this.keys = raw.split(',').map(k => k.trim()).filter(Boolean);
    if (!this.keys.length) console.error('[Gemini] no keys found in GEMINI_API_KEYS');
    else console.log(`[Gemini] ${this.keys.length} key(s) loaded`);
  }

  private pickKey(): string | null {
    const now = Date.now();
    for (let i = 0; i < this.keys.length; i++) {
      const k = this.keys[(this.idx + i) % this.keys.length];
      if (!this.cooldowns.get(k) || now > this.cooldowns.get(k)!) {
        this.idx = (this.idx + i + 1) % this.keys.length;
        return k;
      }
    }
    let best = this.keys[0], bestCd = Infinity;
    for (const k of this.keys) {
      const cd = this.cooldowns.get(k) ?? 0;
      if (cd < bestCd) { bestCd = cd; best = k; }
    }
    return best;
  }

  async call(
    systemPrompt: string,
    userPrompt: string,
    temp = 0.9,
    model = ACTIVE_MODEL,
    images: ImagePart[] = [],
    maxOutputTokens?: number,
  ): Promise<string> {
    const userParts = [
      ...images.map(img => ({ inlineData: { mimeType: img.mimeType, data: img.data } })),
      { text: userPrompt },
    ];
    const generationConfig: Record<string, any> = { temperature: temp, responseMimeType: 'application/json' };
    if (maxOutputTokens) generationConfig.maxOutputTokens = maxOutputTokens;

    const requestBody = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: userParts }],
      generationConfig,
    };

    if (DEBUG_LOG_REQUESTS) {
      try {
        const loggable = {
          ...requestBody,
          contents: [{
            role: 'user',
            parts: userParts.map((p: any) =>
              p.inlineData ? { inlineData: { mimeType: p.inlineData.mimeType, data: `[base64 omitted, ${Math.round(p.inlineData.data.length * 0.75 / 1024)}kb]` } } : p
            ),
          }],
        };
        const dump = [
          `── ${new Date().toISOString()} ──`,
          `endpoint: https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          `model: ${model} | temp: ${temp} | maxOutputTokens: ${maxOutputTokens ?? '(none)'}`,
          '',
          '--- FULL REQUEST BODY (what actually gets POSTed) ---',
          JSON.stringify(loggable, null, 2),
        ].join('\n');
        fs.writeFileSync('./debug_last_request.txt', dump, 'utf8');
      } catch (e: any) {
        console.warn('[Debug] failed to write request dump:', e.message?.slice(0, 80));
      }
    }

    let lastError = '';
    const startTime = Date.now();
    const maxAttempts = Math.min(4, Math.max(this.keys.length, 1) * 2);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const key = this.pickKey();
      if (!key) { lastError = 'no keys available'; throw new Error('[Gemini] no keys available'); }
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
          }
        );
        if (res.status === 429) {
          const body = await res.json().catch(() => ({})) as any;
          const retryMs = ((body?.error?.details?.[0]?.retryDelay?.seconds ?? 10) as number) * 1000;
          this.cooldowns.set(key, Date.now() + retryMs);
          
          const errMsg = body?.error?.message || '';
          let limitType = 'Unknown 429';
          if (errMsg.includes('Resource has been exhausted')) limitType = 'RPM (Resource exhausted)';
          else if (errMsg.includes('Tokens per minute')) limitType = 'TPM (Tokens per minute)';
          else if (errMsg.includes('Daily request limit')) limitType = 'RPD (Daily limit)';
          else if (errMsg.includes('quota')) limitType = 'Quota Exceeded';
          
          console.warn(`[Gemini] ...${key.slice(-4)} 429 ${limitType} — cd ${retryMs / 1000}s. Msg: ${errMsg}`);
          lastError = `429 Rate Limit: ${limitType}`;
          continue;
        }
        if (!res.ok) {
          const err = await res.text().catch(() => res.statusText);
          throw new Error(`Gemini ${res.status}: ${err.slice(0, 120)}`);
        }
        
        const stats = this.trackRequest(key);
        const data = await res.json() as any;
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        const finishReason = data.candidates?.[0]?.finishReason ?? 'unknown';
        
        const inTokens = data.usageMetadata?.promptTokenCount ?? 0;
        const outTokens = data.usageMetadata?.candidatesTokenCount ?? 0;
        const durationMs = Date.now() - startTime;
        
        Telemetry.track('NOTABOT_API_CALL', {
          model,
          inTokens,
          outTokens,
          durationMs,
          finishReason
        });
        
        console.log(`[Gemini:${model}] key=...${key.slice(-4)} | ${text.length}ch | in:${inTokens} out:${outTokens} | reqs: ${stats.rpm}/min, ${stats.rpd}/day | finish=${finishReason}`);
        if (!text.trim()) {
          console.warn(`[Gemini] ...${key.slice(-4)} returned empty text (finish=${finishReason}) — retrying`);
          lastError = `empty text (finish=${finishReason})`;
          continue;
        }
        return text;
      } catch (e: any) {
        lastError = e.message ?? String(e);
        if (e.message?.includes('429')) continue;
        console.error(`[Gemini] attempt ${attempt + 1}: ${e.message?.slice(0, 80)}`);
        if (attempt < Math.max(this.keys.length, 1) * 2 - 1)
          await sleep(Math.min(1500 * 2 ** attempt, 10_000));
      }
    }
    throw new Error(`[Gemini] all attempts failed. Last error: ${lastError}`);
  }

  canCall(): boolean { return this.keys.length > 0; }

  getKey(): string | null { return this.pickKey(); }

  status(): string {
    const now = Date.now();
    const keys = this.keys.map(k =>
      `...${k.slice(-4)}${(this.cooldowns.get(k) ?? 0) > now
        ? ` (cd ${Math.ceil(((this.cooldowns.get(k) ?? 0) - now) / 1000)}s)` : ''}`
    ).join(' | ');
    return `gemini: ${this.keys.length} key(s) | ${keys || 'none'}`;
  }
}

export const gemini = new GeminiManager();
