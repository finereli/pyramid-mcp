/**
 * Pure formatters for the read side (recall + load_memory). No DB, no network —
 * unit-testable in isolation. These shape the text blocks the agent reads, and
 * carry the confidence-tier convention the `instructions` field explains.
 */
import type { ModelRow, ObservationRow, SummaryRow, ObservationMatch } from './memory-do.js';

const DAY_MS = 86_400_000;

function isoDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
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

/** Raw recall results — numbered, dated, newest-relevant first. Agent synthesizes. */
export function formatRecall(matches: ObservationMatch[]): string {
  if (matches.length === 0) return 'No relevant memories found.';
  return matches.map((m, i) => `[${i + 1}] [${isoDate(m.timestamp)}] ${m.text}`).join('\n\n');
}

/**
 * Recency-first recent notes — the short-term continuity substitute. Caps by
 * character budget so a busy stretch can't blow the context window.
 */
export function formatRecentNotes(obs: ObservationRow[], capChars = 6000): string {
  if (obs.length === 0) return '';
  const lines: string[] = [];
  let used = 0;
  for (const o of obs) {
    const line = `- [${isoDate(o.timestamp)}] ${o.text}`;
    if (used + line.length > capChars && lines.length > 0) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

/**
 * A model view: description + confidence, tiered summaries (oldest→newest, with
 * tier metadata), then recent verbatim observations (oldest→newest). Summaries
 * are empty until the pyramid (Task #6) populates them; the view degrades to
 * recent observations alone, which is correct.
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
  for (const s of summaries) {
    parts.push(`\n[tier ${s.tier} · ${s.sourceCount} obs · ${isoDate(s.startTimestamp)}–${isoDate(s.endTimestamp)}]\n${s.text}`);
  }
  if (recentObs.length > 0) {
    const ordered = [...recentObs].sort((a, b) => a.timestamp - b.timestamp); // oldest→newest
    parts.push('\nRecent notes (verbatim):');
    for (const o of ordered) parts.push(`- [${isoDate(o.timestamp)}] ${o.text}`);
  }
  return parts.join('\n');
}

/** Observation-RAG receipts block for load_memory. */
export function formatReceipts(matches: ObservationMatch[]): string {
  if (matches.length === 0) return '';
  const lines = matches.map(m => `- [${isoDate(m.timestamp)}] ${m.text}`);
  return `# Relevant receipts\n_Specific facts retrieved from memory — names, dates, numbers. Use as receipts, not a transcript._\n\n${lines.join('\n')}`;
}

/** The model index — every active model, for agent-as-router picks. */
export function formatModelIndex(models: ModelRow[]): string {
  if (models.length === 0) return '';
  const sorted = [...models].sort((a, b) => a.name.localeCompare(b.name));
  const lines = sorted.map(m => `- ${m.name}: ${m.description ?? ''}`.trimEnd());
  return `# Model index\n_The mental models available. Pass any of these names to load_memory to pull its view._\n\n${lines.join('\n')}`;
}
