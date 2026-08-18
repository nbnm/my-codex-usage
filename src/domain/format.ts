import type {DashboardStatus} from './types.js';

export function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

export function formatDuration(minutes: number | undefined): string {
  if (minutes === undefined) {
    return 'unknown window';
  }
  if (minutes % 10_080 === 0) {
    return `${minutes / 10_080}w`;
  }
  if (minutes % 1_440 === 0) {
    return `${minutes / 1_440}d`;
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60}h`;
  }
  return `${minutes}m`;
}

export function formatReset(iso: string | undefined, now: Date = new Date()): string {
  if (iso === undefined) {
    return 'reset unknown';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return 'reset unknown';
  }
  if (date.getTime() <= now.getTime()) {
    return 'reset due';
  }
  const relative = formatRelative(date.getTime() - now.getTime());
  const absolute = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(date);
  return `resets ${relative} (${absolute})`;
}

export function formatUpdated(iso: string | undefined, now: Date = new Date()): string {
  if (iso === undefined) {
    return 'never';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return 'unknown';
  }
  const elapsed = Math.max(0, now.getTime() - date.getTime());
  if (elapsed < 60_000) {
    return 'just now';
  }
  return `${formatRelative(elapsed)} ago`;
}

export function formatTokens(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: value >= 10_000 ? 'compact' : 'standard',
    maximumFractionDigits: 1
  }).format(value);
}

export function formatElapsedSeconds(seconds: number | undefined): string {
  if (seconds === undefined) {
    return 'unavailable';
  }
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safeSeconds / 3_600);
  const minutes = Math.floor((safeSeconds % 3_600) / 60);
  const remainder = safeSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (remainder > 0 || parts.length === 0) {
    parts.push(`${remainder}s`);
  }
  return parts.join(' ');
}

export function statusLabel(status: DashboardStatus): string {
  switch (status) {
    case 'loading':
      return 'Loading';
    case 'authenticating':
      return 'Authenticating';
    case 'fresh':
      return 'Fresh';
    case 'partial':
      return 'Partial';
    case 'stale':
      return 'Stale';
    case 'unauthenticated':
      return 'Sign-in required';
    case 'unavailable':
      return 'Unavailable';
    case 'incompatible':
      return 'Incompatible';
  }
}

function formatRelative(milliseconds: number): string {
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }
  return `${Math.round(hours / 24)}d`;
}
