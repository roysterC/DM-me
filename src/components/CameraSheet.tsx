import { useEffect, useRef, useState } from 'react';
import { prepareImage, type PreparedImage } from '../lib/image';
import { IconClose, IconFlip, IconImage } from './Icons';

interface Props {
  onClose: () => void;
  onCaptured: (image: PreparedImage, fromCamera: boolean) => void;
}

/** Live camera with a shutter. Falls back to the device's own camera or file picker when the browser can't stream. */
export function CameraSheet({ onClose, onCaptured }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [facing, setFacing] = useState<'user' | 'environment'>('user');
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    setReady(false);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('This browser can’t open the camera here.');
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1920 } }, audio: false })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        setError(null);
        if (video.current) {
          video.current.srcObject = s;
          video.current.play().catch(() => {});
        }
      })
      .catch((err: DOMException) => {
        setError(
          err.name === 'NotAllowedError'
            ? 'Camera access was blocked. Allow it in your browser settings, or pick a photo instead.'
            : 'No camera was found. You can pick a photo instead.',
        );
      });
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [facing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const capture = async () => {
    const v = video.current;
    if (!v || !v.videoWidth || busy) return;
    setBusy(true);
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext('2d')!.drawImage(v, 0, 0);
    try {
      onCaptured(await prepareImage(canvas, facing === 'user'), true);
    } finally {
      setBusy(false);
    }
  };

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      onCaptured(await prepareImage(file), true);
    } catch {
      setError('That photo couldn’t be opened. Try another one.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay camera" role="dialog" aria-modal="true" aria-label="Camera">
      <div className="camera-stage">
        {!error && (
          <video
            ref={video}
            className={facing === 'user' ? 'mirrored' : undefined}
            playsInline
            muted
            onLoadedData={() => setReady(true)}
          />
        )}
        {error && <p className="camera-error">{error}</p>}
        <div className="camera-top">
          <button type="button" className="round-btn" onClick={onClose} aria-label="Close camera">
            <IconClose size={22} />
          </button>
        </div>
      </div>
      <div className="camera-controls">
        <button type="button" className="round-btn" onClick={() => fileInput.current?.click()} aria-label="Choose a photo instead">
          <IconImage size={22} />
        </button>
        <button
          type="button"
          className="shutter"
          onClick={error ? () => fileInput.current?.click() : capture}
          disabled={busy || (!error && !ready)}
          aria-label={error ? 'Take a photo with your device camera' : 'Take photo'}
        />
        <button
          type="button"
          className="round-btn"
          onClick={() => setFacing((f) => (f === 'user' ? 'environment' : 'user'))}
          aria-label="Switch camera"
          disabled={!!error}
        >
          <IconFlip size={22} />
        </button>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => pickFile(e.target.files?.[0])}
      />
    </div>
  );
}
