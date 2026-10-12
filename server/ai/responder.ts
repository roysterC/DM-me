import Anthropic from '@anthropic-ai/sdk';
import { type PhotoMode, STORY_BGS, type StoryBg } from '../../shared/types';
import type { Budget } from '../budget';

export interface PersonaReply {
  messages: string[];
  /** One of the visitor's messages ("m12") her first bubble quote-replies to. */
  replyTo: string | null;
  heartLatest: boolean;
  /** A camera-roll reference such as "p12". */
  photo: { ref: string; mode: PhotoMode } | null;
  /** What the visitor's disappearing photo(s) seen this turn showed, for her to remember them by. */
  photoMemory: string | null;
}

/** One story Alisa writes: a camera-roll photo (by reference) with a caption, or text on a background. */
export interface StoryDraft {
  photoRef: string | null;
  caption: string;
  bg: StoryBg;
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
  /** Folds older messages (a transcript) into what Alisa remembers of a long chat. */
  summarize(previous: string | null, transcript: string): Promise<string>;
  /** Alisa's stories for the day; `prompt` is storiesPrompt(). */
  writeStories(prompt: string, photoRefs: string[]): Promise<StoryDraft[]>;
}

export function storiesSchema(photoRefs: string[]) {
  return {
    type: 'object',
    properties: {
      stories: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            photo: { type: 'string', enum: ['none', ...photoRefs], description: 'A camera-roll reference, or "none" for a text story.' },
            caption: { type: 'string' },
            background: { type: 'string', enum: STORY_BGS, description: 'The colour behind a text story.' },
          },
          required: ['photo', 'caption', 'background'],
          additionalProperties: false,
        },
      },
    },
    required: ['stories'],
    additionalProperties: false,
  };
}

/** At most three stories; photos only from the camera roll, and a text story needs its text. */
export function parseStories(raw: string, photoRefs: string[]): StoryDraft[] {
  const data = JSON.parse(raw) as { stories?: unknown };
  const list = Array.isArray(data.stories) ? (data.stories as Record<string, unknown>[]) : [];
  return list
    .map((s) => ({
      photoRef: typeof s.photo === 'string' && photoRefs.includes(s.photo) ? s.photo : null,
      caption: typeof s.caption === 'string' ? s.caption.trim().slice(0, 300) : '',
      bg: (STORY_BGS as unknown[]).includes(s.background) ? (s.background as StoryBg) : 'violet',
    }))
    .filter((s) => s.photoRef || s.caption)
    .slice(0, 3);
}

const SUMMARY_PROMPT = `You keep the memory of a long direct-message chat for Alisa, who is chatting with someone. Older messages are about to drop out of what she can see, so write what she should remember from them.

Write in the second person to Alisa ("they told you...", "you sent them..."), as plain short sentences, at most 200 words. Keep what matters for carrying on the chat naturally: who they are (name, age, where they're from, work or study, people and pets they mention), what they like and care about, plans and events they mentioned (with dates when given), running jokes, things you promised or asked, the overall tone between you, and photos either of you sent. Drop small talk that leads nowhere. Facts only: don't invent or guess anything.

You'll get what she remembered before (possibly nothing) and the older messages. Merge them into one updated memory; if they conflict, the newer messages win.`;

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
      reply_to_message: {
        type: 'string',
        description: 'Reference of one of their messages (like "m12") that your first bubble quote-replies to, or "none". Almost always "none".',
      },
      heart_latest_user_message: { type: 'boolean' },
      send_photo: { type: 'string', enum: ['none', ...photoRefs] },
      send_photo_mode: { type: 'string', enum: ['keep', 'once', 'replay'] },
      remember_photo: {
        type: 'string',
        description:
          'Only when they sent a view-once or replayable photo you can see this turn: one short line on what it shows, which is all you will remember of it afterwards. Otherwise "".',
      },
    },
    required: ['messages', 'reply_to_message', 'heart_latest_user_message', 'send_photo', 'send_photo_mode', 'remember_photo'],
    additionalProperties: false,
  };
}

export class AiUnavailableError extends Error {}

export const DONE_FOR_TODAY = 'Alisa’s done chatting for today. Come back tomorrow.';

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
  const replyTo = typeof data.reply_to_message === 'string' && /^m\d+$/.test(data.reply_to_message) ? data.reply_to_message : null;
  const memory = typeof data.remember_photo === 'string' ? data.remember_photo.trim().slice(0, 300) : '';
  return {
    messages,
    replyTo,
    heartLatest: data.heart_latest_user_message === true,
    photo: ref ? { ref, mode } : null,
    photoMemory: memory || null,
  };
}

const textOf = (content: Anthropic.ContentBlock[]) =>
  content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

/**
 * Claude Haiku 5.5 at low effort: quick, cheap replies for chat. Haiku has no
 * server-side refusal fallback, so a declined request gets a short reply here.
 * Every call is counted against the daily budget, and none is made once it's spent.
 */
export class ClaudeResponder implements Responder {
  constructor(
    private model: string,
    private budget: Budget | null = null,
    private client: Pick<Anthropic, 'messages'> = new Anthropic(),
  ) {}

  private async call(params: Omit<Anthropic.MessageCreateParamsNonStreaming, 'model'>): Promise<Anthropic.Message> {
    if (this.budget?.exhausted()) throw new AiUnavailableError(DONE_FOR_TODAY);
    try {
      const response = await this.client.messages.create({ model: this.model, ...params });
      this.budget?.record(this.model, response.usage);
      return response;
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
      return { messages: ['I can’t help with that one.'], replyTo: null, heartLatest: false, photo: null, photoMemory: null };
    }
    const reply = parseReply(textOf(response.content), photoRefs);
    if (reply.messages.length === 0 && !reply.photo) {
      throw new AiUnavailableError('Alisa’s reply came back empty. Try again.');
    }
    return reply;
  }

  async summarize(previous: string | null, transcript: string): Promise<string> {
    const response = await this.call({
      max_tokens: 1500,
      output_config: { effort: 'low' },
      system: SUMMARY_PROMPT,
      messages: [
        {
          role: 'user',
          content: `What Alisa remembered before:\n${previous?.trim() || '(nothing yet)'}\n\nThe older messages:\n${transcript}`,
        },
      ],
    });
    const text = response.stop_reason === 'refusal' ? '' : textOf(response.content).trim();
    if (!text) throw new AiUnavailableError('The chat summary came back empty.');
    return text.slice(0, 3000);
  }

  async writeStories(prompt: string, photoRefs: string[]): Promise<StoryDraft[]> {
    const response = await this.call({
      max_tokens: 2000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: storiesSchema(photoRefs) } },
      messages: [{ role: 'user', content: prompt }],
    });
    const stories = response.stop_reason === 'refusal' ? [] : parseStories(textOf(response.content), photoRefs);
    if (stories.length === 0) throw new AiUnavailableError('Alisa’s stories came back empty.');
    return stories;
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
 * Mentions of "photo" make it send a view-once photo; "heart" earns a heart;
 * "quote me" makes it quote-reply to the first message of the visitor's turn.
 */
export class FakeResponder implements Responder {
  calls: ReplyRequest[] = [];

  async reply(req: ReplyRequest): Promise<PersonaReply> {
    this.calls.push(req);
    const last = req.messages[req.messages.length - 1];
    const blocks = typeof last.content === 'string' ? [{ type: 'text' as const, text: last.content }] : last.content;
    const raw = blocks.map((b) => (b.type === 'text' ? b.text : '')).join(' ');
    const text = raw.replace(/\[[^\]]*\]\s*/g, '').trim();
    const sawImage = blocks.some((b) => b.type === 'image');
    const lower = text.toLowerCase();
    const wantsPhoto = !sawImage && lower.includes('photo') && req.photoRefs.length > 0;
    return {
      messages: sawImage ? ['Ooh, that looks great.', 'Golden edges and everything.'] : [`You said: ${text}`],
      replyTo: lower.includes('quote me') ? (/\[(m\d+) ·/.exec(raw)?.[1] ?? null) : null,
      heartLatest: sawImage || lower.includes('heart'),
      photo: wantsPhoto ? { ref: req.photoRefs[0], mode: lower.includes('replay') ? 'replay' : 'once' } : null,
      photoMemory: sawImage ? 'a golden-edged skillet' : null,
    };
  }

  async describe(): Promise<string> {
    return 'a test photo';
  }

  storyPrompts: string[] = [];

  async writeStories(prompt: string, photoRefs: string[]): Promise<StoryDraft[]> {
    this.storyPrompts.push(prompt);
    return [
      { photoRef: photoRefs[0] ?? null, caption: 'made this again bc i have no self control 😭', bg: 'violet' },
      { photoRef: null, caption: 'sunday reset or sunday rot. pick one', bg: 'sunset' },
    ];
  }

  summaries: { previous: string | null; transcript: string }[] = [];

  async summarize(previous: string | null, transcript: string): Promise<string> {
    this.summaries.push({ previous, transcript });
    const lines = transcript.split('\n').length;
    return `${previous ? `${previous} ` : ''}(remembered ${lines} lines)`;
  }
}
