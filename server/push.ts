import crypto from 'node:crypto';
import webpush from 'web-push';
import type { DB, MessageRow } from './db';

export interface PushKeys {
  publicKey: string;
  privateKey: string;
}

export interface Subscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Delivers one notification; throws an error with `statusCode` 404/410 when the subscription is gone. */
export type PushSend = (sub: Subscription, payload: string, keys: PushKeys, subject: string) => Promise<unknown>;

const webPushSend: PushSend = (sub, payload, keys, subject) =>
  webpush.sendNotification(sub, payload, {
    vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
    // A reply that couldn't be delivered within a day isn't worth showing late.
    TTL: 24 * 3600,
    urgency: 'high',
  });

/**
 * The server's push identity (VAPID keys): from the environment, or derived from SECRET, so they
 * stay the same across restarts and restores without another file to back up. (Browsers tie
 * each subscription to these keys; new keys would silently end every subscription.)
 */
export function loadPushKeys(secret: string): PushKeys {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  const privateKey = crypto.createHmac('sha256', secret).update('dm-me push key').digest();
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(privateKey);
  return { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: privateKey.toString('base64url') };
}

const MAX_SUBSCRIPTIONS = 5;
/**
 * How long after Alisa's bubble is due to wait before notifying: an open chat fetches the bubble
 * right when it's due, which shows the visitor is watching, so no notification is needed.
 */
const WATCH_GRACE_MS = 4000;

/**
 * "Alisa replied" notifications. A visitor subscribes from the chat; when Alisa's reply lands
 * (her first bubble's due time) and their chat didn't fetch it, each of their devices gets a
 * notification with it. (Deciding on the server, rather than having the page's service worker
 * hide notifications while the chat is open, matters on iPhones: Safari withdraws push from
 * sites whose pushes don't show a notification.)
 */
export class PushService {
  private timers = new Set<ReturnType<typeof setTimeout>>();
  /** When each visitor's chat last fetched messages. */
  private lastFetch = new Map<number, number>();

  constructor(
    private db: DB,
    readonly keys: PushKeys,
    private send: PushSend = webPushSend,
    private graceMs = WATCH_GRACE_MS,
  ) {}

  subscribe(visitorId: number, sub: Subscription, origin: string) {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (visitor_id, endpoint, p256dh, auth, origin, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (endpoint) DO UPDATE SET visitor_id = excluded.visitor_id, p256dh = excluded.p256dh, auth = excluded.auth, origin = excluded.origin`,
      )
      .run(visitorId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, origin, new Date().toISOString());
    // A handful of devices per visitor is plenty; drop the oldest beyond that.
    this.db
      .prepare(
        `DELETE FROM push_subscriptions WHERE visitor_id = ? AND endpoint NOT IN (
           SELECT endpoint FROM push_subscriptions WHERE visitor_id = ? ORDER BY created_at DESC LIMIT ?)`,
      )
      .run(visitorId, visitorId, MAX_SUBSCRIPTIONS);
  }

  unsubscribe(visitorId: number, endpoint: string) {
    this.db.prepare('DELETE FROM push_subscriptions WHERE visitor_id = ? AND endpoint = ?').run(visitorId, endpoint);
  }

  /** Their open chat just fetched its messages. */
  sawChat(visitorId: number) {
    if (this.lastFetch.size > 10_000) this.lastFetch.clear();
    this.lastFetch.set(visitorId, Date.now());
  }

  subscribed(visitorId: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM push_subscriptions WHERE visitor_id = ?').get(visitorId);
  }

  /** After Alisa replies: notify when her first new bubble is due, if it's still there then. */
  afterReply(visitorId: number, conversationId: number, since: number, personaName: string) {
    if (!this.subscribed(visitorId)) return;
    const first = this.db
      .prepare("SELECT * FROM messages WHERE conversation_id = ? AND sender = 'ai' AND id > ? ORDER BY created_at, id LIMIT 1")
      .get(conversationId, since) as MessageRow | undefined;
    if (!first) return;
    const due = Date.parse(first.created_at);
    const timer = setTimeout(
      () => {
        this.timers.delete(timer);
        // Their chat is open: it fetched the bubble when it was due.
        if ((this.lastFetch.get(visitorId) ?? 0) >= due) return;
        void this.notify(visitorId, first.id, personaName);
      },
      Math.max(0, due - Date.now()) + this.graceMs,
    );
    timer.unref?.();
    this.timers.add(timer);
  }

  async notify(visitorId: number, messageId: number, personaName: string) {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as MessageRow | undefined;
    if (!row) return; // the chat was deleted meanwhile
    const body = row.kind === 'photo' ? `${personaName} sent a photo` : (row.text ?? '').slice(0, 180);
    const subs = this.db.prepare('SELECT * FROM push_subscriptions WHERE visitor_id = ?').all(visitorId) as {
      endpoint: string;
      p256dh: string;
      auth: string;
      origin: string;
    }[];
    const payload = JSON.stringify({ title: personaName, body, url: '/', tag: 'chat' });
    // Who's sending, for the push service: the site's own https address (Apple rejects anything else).
    const subjectFor = (origin: string) => (origin.startsWith('https://') ? origin : 'mailto:push@dm-me.invalid');
    await Promise.all(
      subs.map((s) =>
        this.send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, this.keys, subjectFor(s.origin)).catch((err) => {
          const status = (err as { statusCode?: number }).statusCode;
          // The browser dropped this subscription (unsubscribed, or the app was removed).
          if (status === 404 || status === 410) this.unsubscribe(visitorId, s.endpoint);
          else console.error('Push failed', status ?? (err instanceof Error ? err.message : err));
        }),
      ),
    );
  }

  /** Cancels notifications still waiting for their bubble (tests, shutdown). */
  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
