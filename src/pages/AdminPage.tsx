import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { type AdminStoryDTO, type LibraryPhotoDTO, type SendMode, STORY_BGS, type StoryBg } from '../../shared/types';
import { api, ApiError } from '../api';
import { IconBack } from '../components/Icons';
import { prepareImage } from '../lib/image';
import { shortAge } from '../lib/time';

const message = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/** Nova's stories and camera roll, behind ADMIN_PASSWORD. */
export function AdminPage() {
  const [state, setState] = useState<{ enabled: boolean; admin: boolean; storage: 'local' | 's3' } | null>(null);
  const [tab, setTab] = useState<'photos' | 'stories'>('photos');

  const load = () =>
    api.admin
      .me()
      .then(setState)
      .catch(() => setState({ enabled: false, admin: false, storage: 'local' }));
  useEffect(() => {
    load();
  }, []);

  return (
    <div className="phone admin">
      <header className="chat-header">
        <Link className="icon-btn" to="/" aria-label="Back to chat">
          <IconBack size={26} />
        </Link>
        <h1 className="admin-title">Manage Nova</h1>
        <span className="spacer" />
        {state?.admin && (
          <button
            type="button"
            className="text-btn"
            onClick={async () => {
              await api.admin.logout().catch(() => {});
              load();
            }}
          >
            Lock
          </button>
        )}
      </header>
      <div className="admin-body">
        {!state ? (
          <p className="muted">Loading…</p>
        ) : !state.enabled ? (
          <p className="muted">
            The admin page is off. Set <code>ADMIN_PASSWORD</code> on the server and restart it.
          </p>
        ) : !state.admin ? (
          <Unlock onDone={load} />
        ) : (
          <>
            <div className="mode-switch compact" role="tablist" aria-label="Section">
              {(['photos', 'stories'] as const).map((t) => (
                <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'selected' : undefined} onClick={() => setTab(t)}>
                  {t === 'photos' ? 'Camera roll' : 'Stories'}
                </button>
              ))}
            </div>
            {tab === 'photos' ? <CameraRoll storage={state.storage} /> : <Stories />}
          </>
        )}
      </div>
    </div>
  );
}

function Unlock({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.admin.login(password);
      onDone();
    } catch (err) {
      setError(message(err, 'Couldn’t unlock.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="admin-form" onSubmit={submit}>
      <label className="field">
        <span>Admin password</span>
        <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="primary-btn" disabled={busy}>
        {busy ? 'Checking…' : 'Unlock'}
      </button>
    </form>
  );
}

// ---- Camera roll ----------------------------------------------------------------

function CameraRoll({ storage }: { storage: 'local' | 's3' }) {
  const [photos, setPhotos] = useState<LibraryPhotoDTO[] | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api.admin
      .photos()
      .then((r) => setPhotos(r.photos))
      .catch((err) => setError(message(err, 'Couldn’t load the camera roll.')));
  useEffect(() => {
    load();
  }, []);

  const upload = async (e: FormEvent) => {
    e.preventDefault();
    if (files.length === 0) return;
    setBusy(files.length > 1 ? `Uploading and describing ${files.length} photos…` : 'Uploading…');
    setError(null);
    setNote(null);
    try {
      const blobs = await Promise.all(files.map(async (f) => (await prepareImage(f)).blob));
      await api.admin.addPhotos(blobs, files.length === 1 ? description : '');
      setFiles([]);
      setDescription('');
      (e.target as HTMLFormElement).reset();
      await load();
    } catch (err) {
      setError(message(err, 'Upload failed.'));
    } finally {
      setBusy(null);
    }
  };

  const sync = async () => {
    setBusy('Checking the bucket…');
    setError(null);
    setNote(null);
    try {
      const r = await api.admin.syncPhotos();
      setNote(
        r.added === 0
          ? 'No new photos in the bucket’s library/ folder.'
          : `Added ${r.added} photo${r.added === 1 ? '' : 's'}${r.remaining ? `. ${r.remaining} more waiting: sync again.` : '.'}`,
      );
      await load();
    } catch (err) {
      setError(message(err, 'Sync failed.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <p className="admin-help">
        Nova picks from these when she sends a photo, going by each description. Leave the description empty and Nova
        writes one. “Sends as” sets whether a photo disappears after viewing: leave it on “Nova decides”, or make it
        always view once, replayable or kept in the chat.
      </p>
      <form className="admin-form" onSubmit={upload}>
        <label className="field">
          <span>Photos</span>
          <input type="file" accept="image/*" multiple required onChange={(e) => setFiles([...(e.target.files ?? [])])} />
        </label>
        {files.length <= 1 && (
          <label className="field">
            <span>Description (optional)</span>
            <input value={description} maxLength={300} placeholder="e.g. homemade ramen with a soft egg" onChange={(e) => setDescription(e.target.value)} />
          </label>
        )}
        <button type="submit" className="primary-btn" disabled={!!busy || files.length === 0}>
          Add to camera roll
        </button>
        {storage === 's3' && (
          <button type="button" className="sheet-btn" onClick={sync} disabled={!!busy}>
            Sync from bucket
          </button>
        )}
      </form>
      {busy && <p className="muted small">{busy}</p>}
      {note && <p className="muted small">{note}</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <h2 className="admin-sub">{photos ? `${photos.length} photo${photos.length === 1 ? '' : 's'}` : 'Photos'}</h2>
      {photos === null ? (
        <p className="muted">Loading…</p>
      ) : photos.length === 0 ? (
        <p className="muted">No photos yet. Nova won’t send any until you add some.</p>
      ) : (
        <ul className="admin-list">
          {photos.map((p) => (
            <PhotoRow key={p.id} photo={p} onChanged={load} />
          ))}
        </ul>
      )}
    </>
  );
}

const SEND_MODES: { id: SendMode; label: string }[] = [
  { id: 'auto', label: 'Nova decides' },
  { id: 'once', label: 'View once' },
  { id: 'replay', label: 'Allow replay' },
  { id: 'keep', label: 'Keep in chat' },
];

function PhotoRow({ photo, onChanged }: { photo: LibraryPhotoDTO; onChanged: () => void }) {
  const [text, setText] = useState(photo.description);
  const [saving, setSaving] = useState(false);
  const [sendMode, setSendMode] = useState(photo.sendMode);
  const changeMode = async (mode: SendMode) => {
    setSendMode(mode);
    await api.admin.setSendMode(photo.id, mode).catch(() => setSendMode(photo.sendMode));
  };
  const dirty = text.trim() !== photo.description;
  const save = async () => {
    setSaving(true);
    await api.admin.describePhoto(photo.id, text).catch(() => {});
    setSaving(false);
    onChanged();
  };
  const remove = async () => {
    if (!confirm('Remove this photo from Nova’s camera roll?')) return;
    await api.admin.removePhoto(photo.id).catch(() => {});
    onChanged();
  };
  return (
    <li>
      <img src={photo.url} alt="" />
      <div className="admin-meta">
        <label className="sr-only" htmlFor={`desc-${photo.id}`}>
          Description
        </label>
        <textarea id={`desc-${photo.id}`} className="admin-desc" rows={2} maxLength={300} value={text} onChange={(e) => setText(e.target.value)} />
        <label className="admin-send">
          <span>Sends as</span>
          <select value={sendMode} onChange={(e) => changeMode(e.target.value as SendMode)}>
            {SEND_MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <span className="muted small">
          {photo.sample ? 'Sample photo' : `Added ${shortAge(photo.createdAt)} ago`}
          {dirty && (
            <button type="button" className="text-btn" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
        </span>
      </div>
      <button type="button" className="text-btn danger" onClick={remove}>
        Remove
      </button>
    </li>
  );
}

// ---- Stories -----------------------------------------------------------------------

function Stories() {
  const [stories, setStories] = useState<AdminStoryDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<'photo' | 'text'>('photo');
  const [caption, setCaption] = useState('');
  const [bg, setBg] = useState<StoryBg>('violet');
  const [hours, setHours] = useState(24);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api.admin
      .stories()
      .then((r) => setStories(r.stories))
      .catch((err) => setError(message(err, 'Couldn’t load stories.')));
  useEffect(() => {
    load();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const photo = kind === 'photo' && file ? (await prepareImage(file)).blob : undefined;
      await api.admin.createStory({ kind, caption, bg, hours, photo });
      setCaption('');
      setFile(null);
      (e.target as HTMLFormElement).reset();
      await load();
    } catch (err) {
      setError(message(err, 'Couldn’t post that story.'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number) => {
    if (!confirm('Delete this story? Everyone loses access to it.')) return;
    await api.admin.removeStory(id).catch(() => {});
    load();
  };

  return (
    <>
      <form className="admin-form" onSubmit={submit}>
        <div className="mode-switch compact" role="radiogroup" aria-label="Story type">
          {(['photo', 'text'] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? 'selected' : undefined} onClick={() => setKind(k)}>
              {k === 'photo' ? 'Photo story' : 'Text story'}
            </button>
          ))}
        </div>
        {kind === 'photo' && (
          <label className="field">
            <span>Photo</span>
            <input type="file" accept="image/*" required onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
        )}
        <label className="field">
          <span>{kind === 'photo' ? 'Caption (optional)' : 'Text'}</span>
          <textarea rows={3} maxLength={300} required={kind === 'text'} value={caption} onChange={(e) => setCaption(e.target.value)} />
        </label>
        {kind === 'text' && (
          <fieldset className="bg-picker">
            <legend>Background</legend>
            {STORY_BGS.map((b) => (
              <label key={b} className={`bg-swatch bg-${b}`}>
                <input type="radio" name="bg" value={b} checked={bg === b} onChange={() => setBg(b)} />
                <span className="sr-only">{b}</span>
              </label>
            ))}
          </fieldset>
        )}
        <label className="field">
          <span>Visible for (hours)</span>
          <input type="number" min={1} max={168} value={hours} onChange={(e) => setHours(Number(e.target.value))} />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary-btn" disabled={busy}>
          {busy ? 'Posting…' : 'Post story'}
        </button>
      </form>

      <h2 className="admin-sub">Recent</h2>
      {stories === null ? (
        <p className="muted">Loading…</p>
      ) : stories.length === 0 ? (
        <p className="muted">No stories yet.</p>
      ) : (
        <ul className="admin-list">
          {stories.map((s) => (
            <li key={s.id} className={s.active ? undefined : 'expired'}>
              {s.mediaUrl ? <img src={s.mediaUrl} alt="" /> : <span className={`admin-thumb bg-${s.bg ?? 'violet'}`} aria-hidden="true" />}
              <div className="admin-meta">
                <span className="admin-caption">{s.caption ?? 'No caption'}</span>
                <span className="muted small">
                  {s.active ? `Posted ${shortAge(s.createdAt)} ago` : 'Expired'} · {s.views} {s.views === 1 ? 'view' : 'views'}
                </span>
              </div>
              <button type="button" className="text-btn danger" onClick={() => remove(s.id)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
