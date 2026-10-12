import { api } from '../api';

/**
 * Whether this browser can get "Alisa replied" notifications:
 * - 'ready': it can (the visitor still has to say yes);
 * - 'install': an iPhone or iPad, which only allows them once the site is on the Home Screen;
 * - 'blocked': the visitor turned notifications off for this site in the browser;
 * - 'unsupported': no web push here at all.
 */
export type PushSupport = 'ready' | 'install' | 'blocked' | 'unsupported';

export function pushSupport(): PushSupport {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia('(display-mode: standalone)').matches;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return ios && !standalone ? 'install' : 'unsupported';
  }
  if (Notification.permission === 'denied') return 'blocked';
  return 'ready';
}

const base64ToBytes = (b64: string) => {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

async function registration() {
  return navigator.serviceWorker.register('/sw.js');
}

/** Whether this device is signed up for notifications. */
export async function pushEnabled(): Promise<boolean> {
  if (pushSupport() !== 'ready' || Notification.permission !== 'granted') return false;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return !!(await reg?.pushManager.getSubscription());
}

/** Asks for permission (must follow a tap) and signs this device up. False if the visitor said no. */
export async function enablePush(): Promise<boolean> {
  if ((await Notification.requestPermission()) !== 'granted') return false;
  const reg = await registration();
  await navigator.serviceWorker.ready;
  const { key } = await api.push.status();
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64ToBytes(key) }));
  await api.push.subscribe(sub.toJSON());
  return true;
}

export async function disablePush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await api.push.unsubscribe(sub.endpoint).catch(() => {});
  await sub.unsubscribe();
}
