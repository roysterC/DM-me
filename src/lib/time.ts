const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

const timeOf = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

/** The centered label between messages: "Today 9:02 PM", "Yesterday 8:10 AM", "Sat 9:02 PM", "Oct 3, 9:02 PM". */
export function separatorLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days === 0) return `Today ${timeOf(d)}`;
  if (days === 1) return `Yesterday ${timeOf(d)}`;
  if (days < 7) return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${timeOf(d)}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
  return `${date}, ${timeOf(d)}`;
}

/** Instagram-style short age: "now", "4m", "3h", "2d", "5w". */
export function shortAge(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 604_800) return `${Math.floor(s / 86_400)}d`;
  return `${Math.floor(s / 604_800)}w`;
}

/** "Seen just now", "Seen 5m ago", "Seen 2h ago". */
export function seenLabel(iso: string, now = Date.now()): string {
  const age = shortAge(iso, now);
  return age === 'now' ? 'Seen just now' : `Seen ${age} ago`;
}
