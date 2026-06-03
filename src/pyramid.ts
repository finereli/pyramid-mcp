/**
 * Pyramid — per-model time-tiered summaries. Older windows compress harder
 * (concentric, non-overlapping). Recent verbatim observations are carried by
 * load_memory directly; summaries carry the arcs. Synthesis is focus-aware: the
 * model's description shapes the lens.
 *
 * This module is pure (tiering + prompt building) so it's unit-testable; the DO
 * calls synthesize() and stores the results.
 */
import type { ObservationRow, ModelRow } from './memory-do.js';

const DAY_MS = 86_400_000;
const MAX_OBS_CHARS = 14_000; // per-tier synthesis input budget

export interface Tier { idx: number; maxAgeDays: number; targetChars: number; label: string }

/** Cumulative upper bounds: tier 0 = (0,30d], 1 = (30,90d], 2 = (90,365d], 3 = 365d+. */
export const SUMMARY_TIERS: Tier[] = [
  { idx: 0, maxAgeDays: 30, targetChars: 1200, label: 'last 30 days' },
  { idx: 1, maxAgeDays: 90, targetChars: 900, label: '1–3 months ago' },
  { idx: 2, maxAgeDays: 365, targetChars: 700, label: '3–12 months ago' },
  { idx: 3, maxAgeDays: Infinity, targetChars: 500, label: 'over a year ago' },
];

export function tierForAgeDays(ageDays: number): number {
  for (const t of SUMMARY_TIERS) if (ageDays < t.maxAgeDays) return t.idx;
  return SUMMARY_TIERS.length - 1;
}

export interface TierBucket { tier: Tier; observations: ObservationRow[] }

/** Bucket a model's observations into non-empty tiers by age from `now`. */
export function bucketObservations(obs: ObservationRow[], now: number): TierBucket[] {
  const byTier = new Map<number, ObservationRow[]>();
  for (const o of obs) {
    const ageDays = (now - o.timestamp) / DAY_MS;
    const t = tierForAgeDays(ageDays);
    (byTier.get(t) ?? byTier.set(t, []).get(t)!).push(o);
  }
  return SUMMARY_TIERS
    .filter(t => byTier.has(t.idx))
    .map(t => ({ tier: t, observations: byTier.get(t.idx)!.sort((a, b) => a.timestamp - b.timestamp) }));
}

function isoDate(ts: number): string { return new Date(ts).toISOString().slice(0, 10); }

const SYNTH_SYSTEM = `You synthesize a personal AI assistant's memory observations into one compact narrative for a SINGLE mental model, written from that model's lens. Preserve names, decisions, numbers, dates, and the participants' own voice and phrasing — keep the specifics, they are what makes a memory verifiable later. Trace the arc with causal connective tissue (what developed, what shifted because of what, what's still open) — narrative, NOT a flat list of facts and NOT a generic "overall, things evolved" closer. Output ONLY the synthesis prose, no preamble or headers. Hold to the target length: it is a hard ceiling, and older windows must compress HARDER — be ruthless about cutting in the oldest tiers, keeping only the load-bearing facts and the shape of the arc.`;

export interface SynthJob { system: string; user: string; maxTokens: number; startTs: number; endTs: number; sourceCount: number; tier: number }

/**
 * Build the focus-aware synthesis prompt for one tier of one model. Caps the
 * observation input by character budget (newest-first), noting any omitted.
 */
export function buildSynthJob(model: ModelRow, bucket: TierBucket): SynthJob {
  const obs = bucket.observations;
  // newest-first selection within the char budget, then present oldest-first
  const selected: ObservationRow[] = [];
  let used = 0;
  for (let i = obs.length - 1; i >= 0; i--) {
    const line = `- [${isoDate(obs[i]!.timestamp)}] ${obs[i]!.text}`;
    if (used + line.length > MAX_OBS_CHARS && selected.length > 0) break;
    selected.push(obs[i]!);
    used += line.length + 1;
  }
  selected.reverse();
  const omitted = obs.length - selected.length;
  const body = selected.map(o => `- [${isoDate(o.timestamp)}] ${o.text}`).join('\n');
  const omittedNote = omitted > 0 ? `\n(${omitted} older observations in this window omitted for length.)` : '';

  const startTs = obs[0]!.timestamp;
  const endTs = obs[obs.length - 1]!.timestamp;
  const user = `Model: ${model.name}\nLens: ${model.description ?? model.name}\nWindow: ${bucket.tier.label} (${isoDate(startTs)} – ${isoDate(endTs)})\n\nObservations (oldest first):\n${body}${omittedNote}\n\nWrite a ~${bucket.tier.targetChars}-character synthesis capturing the arc of this window through the "${model.name}" lens.`;

  return {
    system: SYNTH_SYSTEM,
    user,
    // Hard output ceiling ≈ targetChars worth of tokens with a small buffer.
    // Tight on purpose: 70B otherwise inflated the oldest tiers past their
    // target (it ignores a soft instruction, but respects a token cap).
    maxTokens: Math.ceil(bucket.tier.targetChars / 3.3) + 50,
    startTs,
    endTs,
    sourceCount: obs.length,
    tier: bucket.tier.idx,
  };
}
