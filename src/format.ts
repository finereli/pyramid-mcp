/**
 * Pure formatters for the read side (recall + load_memory + load_model). No DB, no network —
 * unit-testable in isolation. These shape the text blocks the agent reads, and
 * carry the confidence-tier convention the `instructions` field explains.
 */
import type { ModelRow, ObservationRow, SummaryRow, ObservationMatch, RecentDays } from './memory-do.js';

const DAY_MS = 86_400_000;

function isoDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Compact char counts for compression labels: 612, 1.0K, 61K. */
function fmtChars(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return k >= 10 ? `${Math.round(k)}K` : `${k.toFixed(1)}K`;
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

/** Label for a match: observations by date, summaries by range and tier. */
function matchLabel(m: ObservationMatch): string {
  if (m.kind === 'summary') {
    const start = m.startTimestamp ?? m.timestamp;
    const range = isoDate(start) === isoDate(m.timestamp) ? isoDate(m.timestamp) : `${isoDate(start)}–${isoDate(m.timestamp)}`;
    const backing = m.obsCount ? ` · ${m.obsCount} obs` : '';
    return `[${range} · summary tier ${m.tier ?? 0}${backing}]`;
  }
  if (m.supersededBy) {
    const by = m.supersededBy.text.length > 160 ? `${m.supersededBy.text.slice(0, 160)}…` : m.supersededBy.text;
    return `[${isoDate(m.timestamp)} · SUPERSEDED on ${isoDate(m.supersededBy.timestamp)} by: "${by}"]`;
  }
  return `[${isoDate(m.timestamp)}]`;
}

/** Raw recall results — numbered, dated, best first. Observations are receipts, summaries are arcs. Agent synthesizes. */
export function formatRecall(matches: ObservationMatch[]): string {
  if (matches.length === 0) return 'No relevant memories found.';
  return matches.map((m, i) => `[${i + 1}] ${matchLabel(m)} ${m.text}`).join('\n\n');
}

/**
 * Recency-first recent notes — the short-term continuity substitute. Caps by
 * character budget so a busy stretch can't blow the context window.
 */
export function formatRecentNotes(obs: ObservationRow[], capChars = 6000): string {
  return recentNoteLines(obs, capChars).join('\n');
}

function recentNoteLines(obs: ObservationRow[], capChars: number): string[] {
  const lines: string[] = [];
  let used = 0;
  for (const o of obs) {
    const line = `- [${isoDate(o.timestamp)}] ${o.text}`;
    if (used + line.length > capChars && lines.length > 0) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines;
}

/** A note's first sentence, cut to `max` chars — the fallback gist for a day with no digest yet. */
function firstSentence(text: string, max = 110): string {
  const m = text.match(/^.*?[.!?](\s|$)/);
  const s = (m ? m[0] : text).trim();
  return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s;
}

/**
 * load_memory's continuity block: the latest active day verbatim (newest
 * first, capped by characters, with a count of what the cap held back), then
 * each earlier active day as one line: its digest, or, until the digest is
 * written, the first sentences of its newest few notes. One busy day can no
 * longer push the rest of the week out.
 */
export function formatRecentDays(
  recent: RecentDays,
  digests: Map<string, { text: string; sourceCount: number }>,
  capChars = 6000,
): string {
  if (!recent.latestDay || recent.latest.length === 0) return '';
  const parts: string[] = [];
  const shown = recentNoteLines(recent.latest, capChars);
  const shownCount = shown.length;
  const n = recent.latest.length;
  parts.push(`## ${recent.latestDay} — latest day, verbatim (${n} note${n === 1 ? '' : 's'})\n${shown.join('\n')}`);
  if (shownCount < n) parts.push(`_+${n - shownCount} earlier note${n - shownCount === 1 ? '' : 's'} from ${recent.latestDay} not shown; recall finds them._`);
  if (recent.earlier.length > 0) {
    const lines = recent.earlier.map(({ day, notes }) => {
      const count = `${notes.length} note${notes.length === 1 ? '' : 's'}`;
      const d = digests.get(day);
      if (d && d.sourceCount === notes.length) return `- ${day} (${count}): ${d.text}`;
      const gist = notes.slice(0, 3).map(o => firstSentence(o.text)).join(' · ');
      const more = notes.length > 3 ? ` · +${notes.length - 3} more` : '';
      return `- ${day} (${count}, digest pending): ${gist}${more}`;
    });
    parts.push(`## Earlier days — one digest each\n${lines.join('\n')}`);
  }
  return parts.join('\n\n');
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
  // Label carries the TRANSITIVE backing (raw observations and their chars,
  // through all tiers) plus the summary's own length — the compression ratio
  // at a glance. Direct source counts are useless above tier 0 (always the
  // fan-in); what calibrates confidence is how much was compressed away.
  for (const s of [...summaries].sort((a, b) => a.startTimestamp - b.startTimestamp || b.tier - a.tier)) {
    const covered = s.covered ? ' · finer view of a period summarized above' : '';
    parts.push(`\n[tier ${s.tier} · ${s.obsCount} obs · ${fmtChars(s.sourceChars)}→${fmtChars(s.text.length)} chars · ${isoDate(s.startTimestamp)}–${isoDate(s.endTimestamp)}${covered}]\n${s.text}`);
  }
  if (recentObs.length > 0) {
    const ordered = [...recentObs].sort((a, b) => a.timestamp - b.timestamp); // oldest→newest
    parts.push('\nRecent notes (verbatim):');
    for (const o of ordered) parts.push(`- [${isoDate(o.timestamp)}${o.covered ? ' · also summarized above' : ''}] ${o.text}`);
  }
  return parts.join('\n');
}

/** "today", "yesterday", "12d ago", "4mo ago" — how long since a timestamp. */
export function ago(ts: number, now: number = Date.now()): string {
  const days = Math.floor((now - ts) / DAY_MS);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 60) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}

/**
 * The model index — every active model, for agent-as-router picks. With
 * `activity`, each line ends in its note count and newest note date, so a
 * stale description (says "active", last note four months ago) shows itself.
 */
export function formatModelIndex(
  models: ModelRow[],
  activity?: Map<string, { obsCount: number; latest: number | null }>,
  now: number = Date.now(),
): string {
  if (models.length === 0) return '';
  const sorted = [...models].sort((a, b) => a.name.localeCompare(b.name));
  const meta = (m: ModelRow): string => {
    if (!activity) return '';
    const a = activity.get(m.id);
    if (!a || a.obsCount === 0 || a.latest === null) return ' [no notes yet]';
    return ` [${a.obsCount} obs · last ${isoDate(a.latest)}, ${ago(a.latest, now)}]`;
  };
  const lines = sorted.map(m => `- ${m.name}: ${m.description ?? ''}`.trimEnd() + meta(m));
  const legend = activity
    ? ' Brackets show how many notes back each model and when the newest was written; an old date means its description may be out of date.'
    : '';
  return `# Model index\n_The mental models available. Pass any of these names to load_model to pull its view.${legend}_\n\n${lines.join('\n')}`;
}
