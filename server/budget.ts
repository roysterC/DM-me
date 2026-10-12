import type { DB } from './db';
import { nowIso } from './db';

/** Token counts from a Claude response (`response.usage`). */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** USD per million tokens. Cache writes (5-minute) cost 1.25x input. */
interface Price {
  input: number;
  output: number;
  cacheRead: number;
  /** Haiku 5.5 charges more for the whole request once the prompt passes 100K tokens. */
  long?: { input: number; output: number; cacheRead: number };
}

const PRICES: Record<string, Price> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, long: { input: 0.5, output: 2.5, cacheRead: 0.05 } },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
};
/** Models not listed above are counted at the most expensive rate, so the budget errs on the safe side. */
const UNKNOWN: Price = { input: 10, output: 50, cacheRead: 1 };

export function costUsd(model: string, usage: Usage): number {
  const write = usage.cache_creation_input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  const base = PRICES[model] ?? UNKNOWN;
  const p = base.long && usage.input_tokens + write + read > 100_000 ? base.long : base;
  return (usage.input_tokens * p.input + write * p.input * 1.25 + read * p.cacheRead + usage.output_tokens * p.output) / 1e6;
}

export interface SpendToday {
  day: string;
  calls: number;
  spentUsd: number;
  /** 0 = no limit. */
  limitUsd: number;
}

/**
 * What the site spends on Claude per UTC day, across every visitor. Once the day's spend reaches
 * the limit, Alisa stops replying until midnight UTC.
 */
export class Budget {
  constructor(
    private db: DB,
    readonly limitUsd: number,
  ) {}

  record(model: string, usage: Usage) {
    const micro = Math.round(costUsd(model, usage) * 1e6);
    this.db
      .prepare(
        `INSERT INTO ai_usage (day, calls, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, cost_micro_usd)
         VALUES (?, 1, ?, ?, ?, ?, ?)
         ON CONFLICT (day) DO UPDATE SET
           calls = calls + 1,
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens,
           cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
           cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
           cost_micro_usd = cost_micro_usd + excluded.cost_micro_usd`,
      )
      .run(
        today(),
        usage.input_tokens,
        usage.output_tokens,
        usage.cache_creation_input_tokens ?? 0,
        usage.cache_read_input_tokens ?? 0,
        micro,
      );
  }

  today(): SpendToday {
    const day = today();
    const row = this.db.prepare('SELECT calls, cost_micro_usd FROM ai_usage WHERE day = ?').get(day) as
      | { calls: number; cost_micro_usd: number }
      | undefined;
    return { day, calls: row?.calls ?? 0, spentUsd: (row?.cost_micro_usd ?? 0) / 1e6, limitUsd: this.limitUsd };
  }

  exhausted(): boolean {
    return this.limitUsd > 0 && this.today().spentUsd >= this.limitUsd;
  }
}

const today = () => nowIso().slice(0, 10);
