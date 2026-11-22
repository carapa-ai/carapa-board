export function formatRelativeDate(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function shortenDeviceId(id: string): string {
  return id.length > 24 ? `${id.slice(0, 10)}…${id.slice(-6)}` : id;
}

export function deviceDisplayLabel(d: {
  label?: string | null;
  deviceId: string;
}): string {
  if (d.label && d.label.trim()) return d.label;
  return shortenDeviceId(d.deviceId);
}
