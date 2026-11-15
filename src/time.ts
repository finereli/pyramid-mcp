/**
 * Dates as the user lived them. Every timestamp is stored in UTC; labels are
 * rendered in an IANA timezone: a note's own (the zone the user was in when
 * it was recorded), else the memory's current one. A note written at 00:30 in
 * Skopje reads as that day, not the day before in UTC.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
    });
    formatters.set(tz, f);
  }
  return f;
}

function parts(ts: number, tz: string): Record<string, string> {
  return Object.fromEntries(formatter(tz).formatToParts(new Date(ts)).map(p => [p.type, p.value]));
}

export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** 2026-11-10, in the given zone. */
export function localDate(ts: number, tz = 'UTC'): string {
  const p = parts(ts, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** 2026-11-10 23:40 GMT+1, in the given zone. */
export function localStamp(ts: number, tz = 'UTC'): string {
  const p = parts(ts, tz);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

/** 2026-11-03 – 2026-11-10, or one date when both ends fall on the same local day. */
export function localRange(start: number, end: number, tz = 'UTC'): string {
  const a = localDate(start, tz), b = localDate(end, tz);
  return a === b ? a : `${a} – ${b}`;
}
