/**
 * Pyramid — per-model depth-tiered summaries with exact-once provenance.
 *
 * Tier 0 summaries are built from batches of raw observations; tier N+1 from
 * batches of tier-N summaries; never the other way round. Summaries are
 * immutable once written. What the agent reads is the *cover* (summaries not
 * yet rolled into a higher one) plus the unsummarized tail of observations.
 *
 * This module is pure (batching, prompts, rendering) so it's unit-testable;
 * the DO runs the queries, calls synthesize(), and stores the results.
 * Spec: docs/pyramid-spec.md.
 */
import type { ObservationRow, ModelRow, SummaryRow } from './memory-do.js';

/** A tier-0 batch closes at this many observations... */
export const TIER0_MAX_OBS = 10;
/** ...or this many characters of observation text, whichever comes first. */
export const TIER0_MAX_CHARS = 8_000;
/** Tier-N summaries roll into one tier-N+1 summary once this many are unrolled. */
export const ROLLUP_FAN_IN = 5;

/** Soft length target by tier (depth), in characters. Stated in the prompt. */
export function targetCharsForTier(tier: number): number {
  if (tier <= 0) return 600;
  if (tier === 1) return 800;
  if (tier === 2) return 1000;
  return 1200;
}

/**
 * Safety ceiling on output tokens: ~2.5x the target at ~3.5 chars/token. It
 * exists so a runaway generation can't happen; it should not fire on a normal
 * run. Length comes from the prompt, not from here.
 */
export function ceilingTokensForTier(tier: number): number {
  return Math.ceil((targetCharsForTier(tier) * 2.5) / 3.5);
}

export function isoDate(ts: number): string { return new Date(ts).toISOString().slice(0, 10); }

function rangeLabel(start: number, end: number): string {
  const a = isoDate(start), b = isoDate(end);
  return a === b ? a : `${a} – ${b}`;
}

// ---------- Batching ----------

/**
 * Cut unsummarized observations (oldest first) into tier-0 batches. A batch
 * closes at TIER0_MAX_OBS observations or TIER0_MAX_CHARS characters, whichever
 * comes first; a single oversize observation closes a batch by itself. The
 * trailing partial batch is returned as `pending` — it stays verbatim until it
 * fills. No time rule: tiers compress data, not time.
 */
export function batchTier0(obs: ObservationRow[]): { batches: ObservationRow[][]; pending: ObservationRow[] } {
  const sorted = [...obs].sort((a, b) => a.timestamp - b.timestamp);
  const batches: ObservationRow[][] = [];
  let cur: ObservationRow[] = [];
  let chars = 0;
  for (const o of sorted) {
    cur.push(o);
    chars += o.text.length;
    if (cur.length >= TIER0_MAX_OBS || chars >= TIER0_MAX_CHARS) {
      batches.push(cur);
      cur = [];
      chars = 0;
    }
  }
  return { batches, pending: cur };
}

/** Group unrolled tier-N summaries (oldest first) into full rollup batches; the remainder stays unrolled. */
export function batchRollup(summaries: SummaryRow[]): SummaryRow[][] {
  const sorted = [...summaries].sort((a, b) => a.startTimestamp - b.startTimestamp || a.endTimestamp - b.endTimestamp);
  const out: SummaryRow[][] = [];
  for (let i = 0; i + ROLLUP_FAN_IN <= sorted.length; i += ROLLUP_FAN_IN) out.push(sorted.slice(i, i + ROLLUP_FAN_IN));
  return out;
}

// ---------- Prompts ----------

const COMMON_RULES = `Rules that apply at every tier:
- Write from this model's lens (its name and purpose are given). Observations are multi-tagged; other models carry their own angle on the same events. Surface what matters for THIS lens.
- Preserve the load-bearing specifics — names, numbers, dates, decisions, turning points, the participants' own phrasing. They are what makes a memory verifiable later, and what later tiers will have to work from. Drop filler, drop repetition, keep the facts.
- Trace the arc with causal connective tissue: what developed, what shifted because of what, what is still open. Narrative, not a flat list.
- Dates: write arcs as date ranges (e.g. "between Jun 6 and Jun 16") and discrete events as dates (e.g. "on Apr 17"). A window that falls on a single day is "on Jun 6", never "between Jun 6 and Jun 6". Dates should read as part of the narrative, not as labels.
- Factual discipline: never invent a number, name, date, or relationship that is not in the material. An omission is correct; a confabulation corrupts everything built on top of this.
- Hold to the target length. Use it fully when the material is rich - ten substantive observations deserve the whole budget, and leaving specifics out to come in short is a loss, not a virtue. Shorter is fine only when the material is genuinely thin.
- Prefer concrete events, decisions, numbers, and names over characterizations. "Decided on May 10 to sell the house" beats "navigated major life decisions"; "closed Cristi at $4K/mo + 10%" beats "made progress on partnerships". At higher tiers this matters most: compress by dropping lesser events, not by turning events into adjectives.
- Recurrence is data: when the same kind of event recurs in the material, state the count and its window — "bad sleep on 4 of the 6 nights noted (Aug 12–17)" beats "a stretch of poor sleep". Count only what is in front of you, and say "of the N noted" — the count is of the record, not of reality.
- Output ONLY the summary prose. No preamble, no headers, no closing line that sums up "overall" or speculates about the future.`;

export const TIER0_SYSTEM = `You are the compression step in a pyramid memory system. You compress a batch of raw observations into one tier-0 summary for a SINGLE mental model.

The raw observations are preserved separately and stay searchable — you do not need to reproduce them. Your job is the first layer of lossy compression: keep what someone reading this model months from now would need, written so that a later step can compress it again without losing the thread. Every word that isn't earning its place makes that later step harder.

${COMMON_RULES}`;

export const ROLLUP_SYSTEM = `You are the compression step in a pyramid memory system. You compress several summaries that were already written through a SINGLE mental model's lens into one summary one tier up.

The input summaries are preserved separately and stay searchable — you are building a more compact representation, not an archive. Merge patterns across the periods, consolidate repeats, keep what is genuinely distinct and load-bearing. Some batches have one unifying thread — compress hard around it. Others span different facets of the lens — keep the breadth. Use your judgment.

Counts of recurring events may only be summed from explicit counts in your inputs — "4 of 6 nights" plus "3 of 5 nights" is "7 of 11 nights noted". If an input says "several" or "often", you do not have a number; keep the vague word rather than inventing one.

${COMMON_RULES}`;

export interface SynthJob {
  kind: 'tier0' | 'rollup';
  tier: number;            // depth of the summary being produced
  system: string;
  user: string;
  maxTokens: number;       // safety ceiling only
  targetChars: number;
  startTs: number;
  endTs: number;
  sourceIds: string[];     // observation ids (tier0) or summary ids (rollup)
}

export function buildTier0Job(model: ModelRow, batch: ObservationRow[]): SynthJob {
  const sorted = [...batch].sort((a, b) => a.timestamp - b.timestamp);
  const startTs = sorted[0]!.timestamp;
  const endTs = sorted[sorted.length - 1]!.timestamp;
  const target = targetCharsForTier(0);
  const body = sorted.map(o => `- [${isoDate(o.timestamp)}] ${o.text}`).join('\n');
  const user = `Model: ${model.name}
Purpose: ${model.description ?? model.name}
Window: ${rangeLabel(startTs, endTs)} (${sorted.length} observations)

Observations, oldest first:
${body}

Write a ~${target}-character tier-0 summary of this window through the "${model.name}" lens.`;
  return { kind: 'tier0', tier: 0, system: TIER0_SYSTEM, user, maxTokens: ceilingTokensForTier(0), targetChars: target, startTs, endTs, sourceIds: sorted.map(o => o.id) };
}

export function buildRollupJob(model: ModelRow, children: SummaryRow[]): SynthJob {
  const sorted = [...children].sort((a, b) => a.startTimestamp - b.startTimestamp);
  const childTier = sorted[0]!.tier;
  const tier = childTier + 1;
  const startTs = Math.min(...sorted.map(s => s.startTimestamp));
  const endTs = Math.max(...sorted.map(s => s.endTimestamp));
  const target = targetCharsForTier(tier);
  const body = sorted.map(s => `[${rangeLabel(s.startTimestamp, s.endTimestamp)} · tier ${s.tier} · ${s.sourceCount} sources]\n${s.text}`).join('\n\n---\n\n');
  const user = `Model: ${model.name}
Purpose: ${model.description ?? model.name}
Window: ${rangeLabel(startTs, endTs)} (${sorted.length} tier-${childTier} summaries)

Summaries to compress, oldest first:
${body}

Write a ~${target}-character tier-${tier} summary of this window through the "${model.name}" lens.`;
  return { kind: 'rollup', tier, system: ROLLUP_SYSTEM, user, maxTokens: ceilingTokensForTier(tier), targetChars: target, startTs, endTs, sourceIds: sorted.map(s => s.id) };
}

/**
 * Deterministic stand-in for the LLM, used by tests (and available for dry
 * runs). Produces a short text that names the kind, tier, and source count and
 * quotes the first words of each source, so provenance and rendering can be
 * asserted without a model.
 */
export function stubSynthesize(job: SynthJob): string {
  const heads = job.user.split('\n').filter(l => l.startsWith('- [') || l.startsWith('[')).map(l => l.slice(0, 60));
  return `[stub ${job.kind} tier ${job.tier} · ${job.sourceIds.length} sources · ${rangeLabel(job.startTs, job.endTs)}] ${heads.join(' | ')}`.slice(0, job.targetChars);
}

// ---------- Rendering ----------

export interface RenderedView {
  summaries: SummaryRow[];     // chronological (by start), what fits
  observations: ObservationRow[]; // chronological, what fits
  droppedSummaries: number;
  droppedObservations: number;
}

/**
 * Apply a per-model render budget to the cover + tail. Fill-down priority: the
 * top tier always, then the newest lower-tier summaries, then the newest raw
 * observations. Output is chronological. Anything dropped is still in the
 * store and embedded — this only shapes the view.
 */
export function renderWithBudget(cover: SummaryRow[], tail: ObservationRow[], budgetChars: number): RenderedView {
  const topTier = cover.reduce((mx, s) => Math.max(mx, s.tier), -1);
  const top = cover.filter(s => s.tier === topTier);
  const lower = cover.filter(s => s.tier !== topTier).sort((a, b) => b.startTimestamp - a.startTimestamp); // newest first
  const obsNewest = [...tail].sort((a, b) => b.timestamp - a.timestamp);

  let used = 0;
  const keptS: SummaryRow[] = [];
  const keptO: ObservationRow[] = [];
  for (const s of top) { keptS.push(s); used += s.text.length; } // top tier always
  for (const s of lower) {
    if (used + s.text.length > budgetChars) break;
    keptS.push(s); used += s.text.length;
  }
  for (const o of obsNewest) {
    if (used + o.text.length > budgetChars && keptO.length > 0) break;
    keptO.push(o); used += o.text.length;
  }
  return {
    summaries: keptS.sort((a, b) => a.startTimestamp - b.startTimestamp || a.tier - b.tier),
    observations: keptO.sort((a, b) => a.timestamp - b.timestamp),
    droppedSummaries: cover.length - keptS.length,
    droppedObservations: tail.length - keptO.length,
  };
}
