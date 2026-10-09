import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { STORY_BGS, type StoryBg, type StoryDTO } from '../../shared/types';
import { api, ApiError } from '../api';
import { IconBack } from '../components/Icons';
import { prepareImage } from '../lib/image';
import { shortAge } from '../lib/time';

type AdminStory = StoryDTO & { active: boolean; views: number };

/** Post and remove Nova's stories. Only usernames in ADMIN_USERNAMES can use it. */
export function AdminPage() {
  const [stories, setStories] = useState<AdminStory[] | null>(null);
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
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Couldn’t load stories.'));

  useEffect(() => {
    load();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const photo = kind === 'photo' && file ? (await prepareImage(file)).blob : undefined;
      await api.admin.create({ kind, caption, bg, hours, photo });
      setCaption('');
      setFile(null);
      (e.target as HTMLFormElement).reset();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t post that story.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number) => {
    if (!confirm('Delete this story? Everyone loses access to it.')) return;
    await api.admin.remove(id).catch(() => {});
    load();
  };

  return (
    <div className="phone admin">
      <header className="chat-header">
        <Link className="icon-btn" to="/" aria-label="Back to chat">
          <IconBack size={26} />
        </Link>
        <h1 className="admin-title">Nova’s stories</h1>
      </header>
      <div className="admin-body">
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
                {s.mediaUrl ? (
                  <img src={s.mediaUrl} alt="" />
                ) : (
                  <span className={`admin-thumb bg-${s.bg ?? 'violet'}`} aria-hidden="true" />
                )}
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
      </div>
    </div>
  );
}
