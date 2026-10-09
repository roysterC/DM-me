import Anthropic from '@anthropic-ai/sdk';
import type { PhotoMode } from '../../shared/types';
import { CAMERA_ROLL, type CameraRollId } from './nova';

export interface NovaReply {
  messages: string[];
  heartLatest: boolean;
  photo: { id: CameraRollId; mode: PhotoMode } | null;
}

export interface ReplyRequest {
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
}

export interface Responder {
  reply(req: ReplyRequest): Promise<NovaReply>;
}

/** The shape Nova answers in. Kept in a stable order so the prompt prefix caches. */
export const REPLY_SCHEMA = {
  type: 'object',
  properties: {
    messages: {
      type: 'array',
      items: { type: 'string' },
      description: 'Chat bubbles to send, in order. Usually one to three short ones.',
    },
    heart_latest_user_message: { type: 'boolean' },
    send_photo: { type: 'string', enum: ['none', ...CAMERA_ROLL.map((p) => p.id)] },
    send_photo_mode: { type: 'string', enum: ['keep', 'once', 'replay'] },
  },
  required: ['messages', 'heart_latest_user_message', 'send_photo', 'send_photo_mode'],
  additionalProperties: false,
} as const;

export class AiUnavailableError extends Error {}

export function parseReply(raw: string): NovaReply {
  const data = JSON.parse(raw) as {
    messages?: unknown;
    heart_latest_user_message?: unknown;
    send_photo?: unknown;
    send_photo_mode?: unknown;
  };
  const messages = Array.isArray(data.messages)
    ? data.messages.filter((m): m is string => typeof m === 'string').map((m) => m.trim()).filter(Boolean).slice(0, 6)
    : [];
  const photoId = CAMERA_ROLL.find((p) => p.id === data.send_photo)?.id;
  const mode: PhotoMode = data.send_photo_mode === 'once' || data.send_photo_mode === 'replay' ? data.send_photo_mode : 'keep';
  return {
    messages,
    heartLatest: data.heart_latest_user_message === true,
    photo: photoId ? { id: photoId, mode } : null,
  };
}

export class ClaudeResponder implements Responder {
  private client = new Anthropic();
  constructor(private model: string) {}

  async reply({ system, messages }: ReplyRequest): Promise<NovaReply> {
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 4000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: {
          effort: 'low',
          format: { type: 'json_schema', schema: REPLY_SCHEMA as unknown as Record<string, unknown> },
        },
        cache_control: { type: 'ephemeral' },
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages,
      });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        throw new AiUnavailableError('Nova isn’t connected: the server’s ANTHROPIC_API_KEY was rejected.');
      }
      if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError) {
        throw new AiUnavailableError('Nova is busy right now. Try again in a moment.');
      }
      if (err instanceof Anthropic.APIConnectionError) {
        throw new AiUnavailableError('Nova couldn’t be reached. Check the server’s connection.');
      }
      throw err;
    }

    if (response.stop_reason === 'refusal') {
      return { messages: ['I can’t help with that one.'], heartLatest: false, photo: null };
    }
    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const reply = parseReply(text);
    if (reply.messages.length === 0 && !reply.photo) {
      throw new AiUnavailableError('Nova’s reply came back empty. Try again.');
    }
    return reply;
  }
}

/**
 * Deterministic stand-in used by tests and local demos (DM_ME_FAKE_AI=1).
 * Mentions of "photo" make it send a view-once photo; "heart" earns a heart.
 */
export class FakeResponder implements Responder {
  calls: ReplyRequest[] = [];

  async reply(req: ReplyRequest): Promise<NovaReply> {
    this.calls.push(req);
    const last = req.messages[req.messages.length - 1];
    const blocks = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
    const text = blocks
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join(' ')
      .replace(/\[[^\]]*\]\s*/g, '')
      .trim();
    const sawImage = blocks.some((b) => b.type === 'image');
    const lower = text.toLowerCase();
    return {
      messages: sawImage ? ['Ooh, that looks great.', 'Golden edges and everything.'] : [`You said: ${text}`],
      heartLatest: sawImage || lower.includes('heart'),
      photo: lower.includes('photo') ? { id: 'skillet', mode: lower.includes('replay') ? 'replay' : 'once' } : null,
    };
  }
}
