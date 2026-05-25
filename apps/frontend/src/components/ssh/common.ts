// Shared helpers for the SSH surfaces. Keeping them out of the components
// keeps each file focused on rendering.

import type { SshSessionState, SshStatus } from '../../state/ssh';

export function relTime(at: number | null | undefined): string {
  if (!at) return '—';
  const diff = Date.now() - at;
  if (diff < 0) return 'now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  const y = Math.floor(d / 365);
  return `${y}y ago`;
}

/** "00:14:32" / "1d 03:12:09" — used by the "uptime" label on the host
 *  detail view, mirroring the connecting-overlay's typographic density. */
export function uptime(connectedAt: number | null | undefined): string {
  if (!connectedAt) return '—';
  let s = Math.max(0, Math.floor((Date.now() - connectedAt) / 1000));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  const core = `${pad(h)}:${pad(m)}:${pad(s)}`;
  return d > 0 ? `${d}d ${core}` : core;
}

/** Chunk a colon-fingerprint like "SHA256:abc123…" into four-char groups so
 *  it reads like a packet trace rather than a wall of base64. */
export function chunkFingerprint(fp: string): string {
  const trimmed = fp.replace(/^SHA256:/, '');
  return trimmed.replace(/(.{4})/g, '$1 ').trim();
}

export function statusDotClass(status: SshStatus | undefined): string {
  switch (status) {
    case 'connecting':
      return 'bg-accent animate-pulse-soft';
    case 'connected':
      return 'bg-status-ok';
    case 'error':
      return 'bg-status-err';
    case 'closed':
      return 'border border-border-strong bg-transparent';
    case 'idle':
    default:
      return 'bg-fg-subtle';
  }
}

export function statusLabel(status: SshStatus | undefined): string {
  switch (status) {
    case 'connecting':
      return 'CONNECTING';
    case 'connected':
      return 'CONNECTED';
    case 'error':
      return 'ERROR';
    case 'closed':
      return 'CLOSED';
    default:
      return 'IDLE';
  }
}

export function liveSessionFor(
  sessions: Record<string, SshSessionState>,
  hostId: string,
): SshSessionState | null {
  for (const s of Object.values(sessions)) {
    if (s.hostId === hostId && (s.status === 'connected' || s.status === 'connecting')) {
      return s;
    }
  }
  return null;
}
