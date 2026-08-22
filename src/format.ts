/**
 * Pure formatters for the read side (recall + load_memory). No DB, no network —
 * unit-testable in isolation. These shape the text blocks the agent reads, and
 * carry the confidence-tier convention the `instructions` field explains.
 */
import type { ModelRow, ObservationRow, SummaryRow, ObservationMatch } from './memory-do.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function isoDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Timezone-free label for an observation timestamp. The last ~48h render as
 * durations ("2h ago"), because "today"/"yesterday" depend on a timezone the
 * server doesn't know, and models confuse recent ISO dates against a "now"
 * they can't see. Beyond that, ISO dates with a day count for the first two
 * weeks. Render-time only — dates inside stored summary text stay absolute.
 */
export function timeLabel(ts: number, now: number): string {
  const diff = now - ts;
  if (diff < 60_000) return 'just now';
  if (diff < HOUR_MS) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 48 * HOUR_MS) return `${Math.floor(diff / HOUR_MS)}h ago`;
  const days = Math.floor(diff / DAY_MS);
  if (days < 14) return `${isoDate(ts)} · ${days}d ago`;
  return isoDate(ts);
}

/** Compact char count for compression labels: 862 → "862", 1,540 → "1.5K", 61,200 → "61K". */
function fmtChars(n: number): string {
  if (n >= 9_950) return `${Math.round(n / 1000)}K`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

/**
 * Confidence metadata for a model view: how much backs it and how fresh it is.
 * Ported from Glopus router.ts formatConfidenceMeta.
 *   [client-cristi · 12 obs · spans 3mo · latest 2026-05-20 (2d ago)]
 */
export function formatConfidenceMeta(
  name: string,
  conf: { obsCount: number; earliest: number | null; latest: number | null },
  now: number = Date.now(),
): string {
  if (conf.obsCount === 0 || conf.latest === null || conf.earliest === null) return `[${name} · 0 obs]`;
  const latestDate = isoDate(conf.latest);
  const daysSinceLatest = Math.floor((now - conf.latest) / DAY_MS);
  const spanDays = Math.floor((conf.latest - conf.earliest) / DAY_MS);
  const spanLabel = spanDays >= 60 ? `${Math.round(spanDays / 30)}mo` : spanDays >= 2 ? `${spanDays}d` : 'today';
  const recency = daysSinceLatest === 0 ? 'today' : daysSinceLatest === 1 ? 'yesterday' : `${daysSinceLatest}d ago`;
  return `[${name} · ${conf.obsCount} obs · spans ${spanLabel} · latest ${latestDate} (${recency})]`;
}

/** Label for a match: observations by relative time/date, summaries by range, tier, and how many raw observations stand behind them. */
function matchLabel(m: ObservationMatch, now: number): string {
  if (m.kind === 'summary') {
    const start = m.startTimestamp ?? m.timestamp;
    const range = isoDate(start) === isoDate(m.timestamp) ? isoDate(m.timestamp) : `${isoDate(start)}–${isoDate(m.timestamp)}`;
    const backing = m.obsCount ? ` · ${m.obsCount} obs` : '';
    return `[${range} · summary tier ${m.tier ?? 0}${backing}]`;
  }
  return `[${timeLabel(m.timestamp, now)}]`;
}

/** Raw recall results — numbered, dated, best first. Observations are receipts, summaries are arcs. Agent synthesizes. */
export function formatRecall(matches: ObservationMatch[], now: number = Date.now()): string {
  if (matches.length === 0) return 'No relevant memories found.';
  return matches.map((m, i) => `[${i + 1}] ${matchLabel(m, now)} ${m.text}`).join('\n\n');
}

/**
 * Recency-first recent notes — the short-term continuity substitute. Caps by
 * character budget so a busy stretch can't blow the context window.
 */
export function formatRecentNotes(obs: ObservationRow[], capChars = 6000, now: number = Date.now()): string {
  if (obs.length === 0) return '';
  const lines: string[] = [];
  let used = 0;
  for (const o of obs) {
    const line = `- [${timeLabel(o.timestamp, now)}] ${o.text}`;
    if (used + line.length > capChars && lines.length > 0) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

/**
 * A model view: description + confidence, then the pyramid COVER — summaries
 * not yet rolled into a higher one — oldest first with tier (depth) and date
 * range on each, then the unsummarized tail verbatim (oldest→newest). Reading
 * the cover oldest-first gives old arcs at high tiers and progressively finer
 * recent summaries: the resolution gradient. The caller passes only the
 * UNSUMMARIZED tail as recentObs — observations a summary already covers must
 * not reappear verbatim, or the view carries the same history twice. With no
 * summaries yet the view degrades to recent observations alone, which is correct.
 */
export function formatModelView(
  model: ModelRow,
  conf: { obsCount: number; earliest: number | null; latest: number | null },
  summaries: SummaryRow[],
  recentObs: ObservationRow[],
  now: number = Date.now(),
): string {
  const parts: string[] = [];
  parts.push(`## ${model.name} — ${model.description ?? ''}`.trimEnd());
  parts.push(formatConfidenceMeta(model.name, conf, now));
  // Chronological by start (ties: higher tier first), then recent verbatim notes.
  // Ramp rows (already covered by a tile above) say so, so the overlap is explicit.
  for (const s of [...summaries].sort((a, b) => a.startTimestamp - b.startTimestamp || b.tier - a.tier)) {
    // Confidence calibration: how many raw observations stand behind this text,
    // and how hard they were compressed. Falls back to the immediate source
    // count for rows predating the transitive stats.
    const backing = s.obsCount != null
      ? `${s.obsCount} obs${s.sourceChars ? ` · ${fmtChars(s.sourceChars)}→${fmtChars(s.text.length)} chars` : ''}`
      : `${s.sourceCount} ${s.tier === 0 ? 'obs' : `tier-${s.tier - 1} summaries`}`;
    const ended = now - s.endTimestamp < 48 * HOUR_MS ? ` · ended ${timeLabel(s.endTimestamp, now)}` : '';
    const covered = s.covered ? ' · finer view of a period summarized above' : '';
    parts.push(`\n[tier ${s.tier} · ${backing} · ${isoDate(s.startTimestamp)}–${isoDate(s.endTimestamp)}${ended}${covered}]\n${s.text}`);
  }
  if (recentObs.length > 0) {
    const ordered = [...recentObs].sort((a, b) => a.timestamp - b.timestamp); // oldest→newest
    parts.push('\nRecent notes (verbatim):');
    for (const o of ordered) parts.push(`- [${timeLabel(o.timestamp, now)}${o.covered ? ' · also summarized above' : ''}] ${o.text}`);
  }
  return parts.join('\n');
}

/** Observation-RAG receipts block for load_memory. */
export function formatReceipts(matches: ObservationMatch[], now: number = Date.now()): string {
  if (matches.length === 0) return '';
  const lines = matches.map(m => `- ${matchLabel(m, now)} ${m.text}`);
  return `# Relevant receipts\n_Specific facts retrieved from memory — names, dates, numbers. Use as receipts, not a transcript._\n\n${lines.join('\n')}`;
}

/** The model index — every active model, for agent-as-router picks. */
export function formatModelIndex(models: ModelRow[]): string {
  if (models.length === 0) return '';
  const sorted = [...models].sort((a, b) => a.name.localeCompare(b.name));
  const lines = sorted.map(m => `- ${m.name}: ${m.description ?? ''}`.trimEnd());
  return `# Model index\n_The mental models available. Pass any of these names to load_memory to pull its view._\n\n${lines.join('\n')}`;
}
