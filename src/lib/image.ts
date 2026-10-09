export interface PreparedImage {
  blob: Blob;
  url: string;
  width: number;
  height: number;
}

const MAX_EDGE = 1568; // Claude's recommended longest edge; also keeps uploads small.

/** Downscales and re-encodes a photo as JPEG (this also converts formats like HEIC the browser can decode). */
export async function prepareImage(source: Blob | HTMLCanvasElement, mirror = false): Promise<PreparedImage> {
  let bitmap: ImageBitmap | HTMLCanvasElement;
  let w: number;
  let h: number;
  if (source instanceof HTMLCanvasElement) {
    bitmap = source;
    w = source.width;
    h = source.height;
  } else {
    bitmap = await createImageBitmap(source);
    w = bitmap.width;
    h = bitmap.height;
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const width = Math.round(w * scale);
  const height = Math.round(h * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  if (mirror) {
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  if ('close' in bitmap) bitmap.close();
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode photo'))), 'image/jpeg', 0.86),
  );
  return { blob, url: URL.createObjectURL(blob), width, height };
}
