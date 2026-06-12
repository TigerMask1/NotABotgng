/**
 * GROQ API MANAGER - Multi-Key Failover & Token Management
 * Handles multiple API keys, load balancing, rate-limit tracking
 * Purpose: Maximize throughput, minimize errors, stay within daily limits
 */

import Groq from 'groq-sdk';

export interface ApiKeyStats {
  key: string;
  requestsToday: number;
  errorsToday: number;
  lastError?: string;
  lastUsed?: number;
  isHealthy: boolean;
}

class GroqManager {
  private clients: Map<string, Groq> = new Map();
  private keyStats: Map<string, ApiKeyStats> = new Map();
  private currentKeyIndex = 0;
  private keys: string[] = [];
  private dailyLimit = 14400; // ~200 req/min for 24hrs
  private resetTime = Date.now() + 24 * 60 * 60 * 1000;

  constructor() {
    this.initializeKeys();
  }

  private initializeKeys() {
    const keyString = process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY;
    if (!keyString) {
      console.error('[GroqManager] No GROQ_API_KEY(S) found in .env');
      process.exit(1);
    }

    this.keys = keyString.split(',').map((k) => k.trim()).filter((k) => k.length > 0);

    if (this.keys.length === 0) {
      console.error('[GroqManager] No valid API keys found');
      process.exit(1);
    }

    // Initialize clients and stats for each key
    this.keys.forEach((key) => {
      this.clients.set(key, new Groq({ apiKey: key }));
      this.keyStats.set(key, {
        key,
        requestsToday: 0,
        errorsToday: 0,
        isHealthy: true,
      });
    });

    console.log(`[GroqManager] Initialized with ${this.keys.length} API key(s)`);
  }

  /**
   * Get the next healthy API key with the lowest request count
   */
  private getHealthyKey(): string | null {
    const healthy = this.keys.filter((key) => {
      const stats = this.keyStats.get(key)!;
      return stats.isHealthy && stats.requestsToday < this.dailyLimit * 0.9; // Don't use if >90% of limit
    });

    if (healthy.length === 0) {
      console.warn('[GroqManager] No healthy keys available, trying all keys');
      return this.keys[0]; // Fall back to first key
    }

    // Return key with lowest request count
    return healthy.reduce((lowest, current) => {
      const lowestCount = this.keyStats.get(lowest)!.requestsToday;
      const currentCount = this.keyStats.get(current)!.requestsToday;
      return currentCount < lowestCount ? current : lowest;
    });
  }

  /**
   * Make a request with automatic failover
   */
  async request(
    model: string,
    messages: any[],
    temperature: number = 0.9,
    maxTokens: number = 300,
    retries: number = 3
  ): Promise<string> {
    let lastError: any = null;

    for (let attempt = 0; attempt < retries; attempt++) {
      const key = this.getHealthyKey();
      if (!key) {
        throw new Error('[GroqManager] All API keys exhausted');
      }

      const stats = this.keyStats.get(key)!;
      const client = this.clients.get(key)!;

      try {
        // Reset daily counter if needed
        if (Date.now() > this.resetTime) {
          this.keyStats.forEach((s) => {
            s.requestsToday = 0;
            s.errorsToday = 0;
            s.isHealthy = true;
          });
          this.resetTime = Date.now() + 24 * 60 * 60 * 1000;
          console.log('[GroqManager] Daily limit reset');
        }

        const response = await client.chat.completions.create({
          messages,
          model,
          temperature,
          max_tokens: maxTokens,
        });

        stats.requestsToday++;
        stats.lastUsed = Date.now();
        stats.lastError = undefined;

        const usage = response.usage;
        console.log(
          `[Groq] ${model} | Tokens: ${usage.prompt_tokens}+${usage.completion_tokens}=${usage.total_tokens} | Key: ${key.slice(-4)}`
        );

        return response.choices[0]?.message?.content || '';
      } catch (error: any) {
        lastError = error;
        stats.errorsToday++;
        stats.lastError = error.message;

        // Mark key as unhealthy if rate limited
        if (error.status === 429) {
          stats.isHealthy = false;
          console.warn(`[GroqManager] Key ${key.slice(-4)} rate limited, marking unhealthy`);
        }

        console.error(
          `[GroqManager] Attempt ${attempt + 1}/${retries} failed on key ${key.slice(-4)}: ${error.message}`
        );

        // Wait before retry with exponential backoff
        if (attempt < retries - 1) {
          const waitMs = Math.min(1000 * Math.pow(2, attempt), 5000);
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
      }
    }

    throw new Error(`[GroqManager] All retries failed: ${lastError?.message}`);
  }

  /**
   * Get stats for all keys
   */
  getStats(): ApiKeyStats[] {
    return this.keys.map((key) => this.keyStats.get(key)!);
  }

  /**
   * Get available request count
   */
  getAvailableRequests(): number {
    const total = this.keys.reduce((sum, key) => {
      const stats = this.keyStats.get(key)!;
      return sum + Math.max(0, this.dailyLimit - stats.requestsToday);
    }, 0);
    return Math.max(0, total);
  }
}

export const groqManager = new GroqManager();
