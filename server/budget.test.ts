import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { AiUnavailableError, ClaudeResponder } from './ai/responder';
import { Budget, costUsd } from './budget';
import { openDb } from './db';

describe('Claude cost', () => {
  it('prices Haiku 5.5 per million tokens, cache writes at 1.25x and reads at 0.1x input', () => {
    expect(costUsd('claude-haiku-5-5', { input_tokens: 100_000, output_tokens: 0 })).toBeCloseTo(0.01);
    expect(costUsd('claude-haiku-5-5', { input_tokens: 0, output_tokens: 1_000_000 })).toBeCloseTo(0.5);
    const cached = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 80_000, cache_read_input_tokens: 0 };
    expect(costUsd('claude-haiku-5-5', cached)).toBeCloseTo(0.01);
    const read = { ...cached, cache_creation_input_tokens: 0, cache_read_input_tokens: 80_000 };
    expect(costUsd('claude-haiku-5-5', read)).toBeCloseTo(0.0008);
  });

  it('charges the higher rate for the whole request once the prompt passes 100K tokens', () => {
    const usage = { input_tokens: 1_000, output_tokens: 1_000, cache_read_input_tokens: 100_000 };
    expect(costUsd('claude-haiku-5-5', usage)).toBeCloseTo((1_000 * 0.5 + 1_000 * 2.5 + 100_000 * 0.05) / 1e6);
  });

  it('counts models it doesn’t know at the most expensive rate', () => {
    expect(costUsd('claude-something-new', { input_tokens: 1_000_000, output_tokens: 0 })).toBeCloseTo(10);
  });
});

describe('ClaudeResponder budget', () => {
  const reply = { messages: ['hii'], reply_to_message: 'none', heart_latest_user_message: false, send_photo: 'none', send_photo_mode: 'keep' };
  const stub = (usage: Partial<Anthropic.Usage>) => {
    const requests: unknown[] = [];
    const client = {
      messages: {
        create: async (params: unknown) => {
          requests.push(params);
          return {
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: JSON.stringify(reply) }],
            usage: { input_tokens: 0, output_tokens: 0, ...usage },
          };
        },
      },
    } as unknown as Pick<Anthropic, 'messages'>;
    return { client, requests };
  };
  const req = { system: 'be alisa', messages: [{ role: 'user' as const, content: 'hey' }], photoRefs: [] };

  it('records what each call costs, and makes no more calls once the day’s budget is spent', async () => {
    const budget = new Budget(openDb(':memory:'), 0.001);
    const { client, requests } = stub({ input_tokens: 2_000, output_tokens: 1_000 });
    const responder = new ClaudeResponder('claude-haiku-5-5', budget, client);

    expect((await responder.reply(req)).messages).toEqual(['hii']);
    expect(budget.today()).toMatchObject({ calls: 1, spentUsd: 0.0007 });
    await responder.reply(req);
    expect(budget.exhausted()).toBe(true);

    await expect(responder.reply(req)).rejects.toBeInstanceOf(AiUnavailableError);
    await expect(responder.describe(new Uint8Array(1), 'image/jpeg')).rejects.toBeInstanceOf(AiUnavailableError);
    expect(requests).toHaveLength(2);
  });
});
