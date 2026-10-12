/**
 * Downloads and decodes images ahead of time, so a story shows the moment it
 * opens instead of on a black screen. Each image is fetched once per URL; the
 * Image objects are kept so the browser holds on to the decoded picture.
 */
const loaded = new Map<string, { img: HTMLImageElement; ready: Promise<void> }>();

export function preloadImage(url: string): Promise<void> {
  let entry = loaded.get(url);
  if (!entry) {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    // decode() waits for the download too; a failed one is the viewer's to handle, not ours.
    entry = { img, ready: img.decode().catch(() => {}) };
    loaded.set(url, entry);
  }
  return entry.ready;
}

/** Lets go of every preloaded picture except these, so the map doesn't grow in a long-open tab. */
export function forgetPreloadsExcept(urls: string[]) {
  const keep = new Set(urls);
  for (const url of loaded.keys()) if (!keep.has(url)) loaded.delete(url);
}
