import Anthropic from '@anthropic-ai/sdk';
import type { PhotoMode } from '../../shared/types';

export interface PersonaReply {
  messages: string[];
  heartLatest: boolean;
  /** A camera-roll reference such as "p12". */
  photo: { ref: string; mode: PhotoMode } | null;
}

export interface ReplyRequest {
  system: string;
  messages: Anthropic.MessageParam[];
  /** References Alisa may send this turn. */
  photoRefs: string[];
}

export interface Responder {
  reply(req: ReplyRequest): Promise<PersonaReply>;
  /** One line describing a photo, used to catalogue Alisa's camera roll. */
  describe(data: Uint8Array, mime: string): Promise<string>;
}

/** The shape Alisa answers in. Key order is fixed so the request prefix stays cacheable. */
export function replySchema(photoRefs: string[]) {
  return {
    type: 'object',
    properties: {
      messages: {
        type: 'array',
        items: { type: 'string' },
        description: 'Chat bubbles to send, in order. Usually one to three short ones.',
      },
      heart_latest_user_message: { type: 'boolean' },
      send_photo: { type: 'string', enum: ['none', ...photoRefs] },
      send_photo_mode: { type: 'string', enum: ['keep', 'once', 'replay'] },
    },
    required: ['messages', 'heart_latest_user_message', 'send_photo', 'send_photo_mode'],
    additionalProperties: false,
  };
}

export class AiUnavailableError extends Error {}

export function parseReply(raw: string, photoRefs: string[]): PersonaReply {
  const data = JSON.parse(raw) as Record<string, unknown>;
  const messages = Array.isArray(data.messages)
    ? data.messages
        .filter((m): m is string => typeof m === 'string')
        .map((m) => m.trim())
        .filter(Boolean)
        .slice(0, 6)
    : [];
  const ref = typeof data.send_photo === 'string' && photoRefs.includes(data.send_photo) ? data.send_photo : null;
  const mode: PhotoMode =
    data.send_photo_mode === 'once' || data.send_photo_mode === 'replay' ? data.send_photo_mode : 'keep';
  return { messages, heartLatest: data.heart_latest_user_message === true, photo: ref ? { ref, mode } : null };
}

const textOf = (content: Anthropic.ContentBlock[]) =>
  content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

/**
 * Claude Haiku 5.5 at low effort: quick, cheap replies for chat. Haiku has no
 * server-side refusal fallback, so a declined request gets a short reply here.
 */
export class ClaudeResponder implements Responder {
  private client = new Anthropic();
  constructor(private model: string) {}

  private async call(params: Omit<Anthropic.MessageCreateParamsNonStreaming, 'model'>): Promise<Anthropic.Message> {
    try {
      return await this.client.messages.create({ model: this.model, ...params });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        throw new AiUnavailableError('Alisa isn’t connected: the server’s ANTHROPIC_API_KEY was rejected.');
      }
      if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError) {
        throw new AiUnavailableError('Alisa is busy right now. Try again in a moment.');
      }
      if (err instanceof Anthropic.APIConnectionError) {
        throw new AiUnavailableError('Alisa couldn’t be reached. Check the server’s connection.');
      }
      throw err;
    }
  }

  async reply({ system, messages, photoRefs }: ReplyRequest): Promise<PersonaReply> {
    const response = await this.call({
      max_tokens: 4000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: replySchema(photoRefs) } },
      cache_control: { type: 'ephemeral' },
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages,
    });
    if (response.stop_reason === 'refusal') {
      return { messages: ['I can’t help with that one.'], heartLatest: false, photo: null };
    }
    const reply = parseReply(textOf(response.content), photoRefs);
    if (reply.messages.length === 0 && !reply.photo) {
      throw new AiUnavailableError('Alisa’s reply came back empty. Try again.');
    }
    return reply;
  }

  async describe(data: Uint8Array, mime: string): Promise<string> {
    const response = await this.call({
      max_tokens: 1000,
      output_config: { effort: 'low' },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mime as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                data: Buffer.from(data).toString('base64'),
              },
            },
            {
              type: 'text',
              text: 'Describe this photo in one plain line of under 20 words, for a catalogue an assistant will choose photos from. Say what is shown, not its mood. No quotes, no trailing period.',
            },
          ],
        },
      ],
    });
    const text = response.stop_reason === 'refusal' ? '' : textOf(response.content).trim();
    if (!text) throw new AiUnavailableError('Couldn’t describe that photo. Add a description yourself.');
    return text.replace(/\.$/, '').slice(0, 300);
  }
}

/**
 * Deterministic stand-in used by tests and local demos (DM_ME_FAKE_AI=1).
 * Mentions of "photo" make it send a view-once photo; "heart" earns a heart.
 */
export class FakeResponder implements Responder {
  calls: ReplyRequest[] = [];

  async reply(req: ReplyRequest): Promise<PersonaReply> {
    this.calls.push(req);
    const last = req.messages[req.messages.length - 1];
    const blocks = typeof last.content === 'string' ? [{ type: 'text' as const, text: last.content }] : last.content;
    const text = blocks
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join(' ')
      .replace(/\[[^\]]*\]\s*/g, '')
      .trim();
    const sawImage = blocks.some((b) => b.type === 'image');
    const lower = text.toLowerCase();
    const wantsPhoto = !sawImage && lower.includes('photo') && req.photoRefs.length > 0;
    return {
      messages: sawImage ? ['Ooh, that looks great.', 'Golden edges and everything.'] : [`You said: ${text}`],
      heartLatest: sawImage || lower.includes('heart'),
      photo: wantsPhoto ? { ref: req.photoRefs[0], mode: lower.includes('replay') ? 'replay' : 'once' } : null,
    };
  }

  async describe(): Promise<string> {
    return 'a test photo';
  }
}
