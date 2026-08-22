/**
 * advance-prod.ts — drive a deployed user's pyramids to completion via the
 * token-gated /admin/advance endpoint, then verify exact-once provenance with
 * /admin/model. Idempotent and resumable: summaries are immutable and
 * provenance-tracked, so re-running never duplicates work.
 *
 * Reads ADMIN_TOKEN from .dev.vars.
 * Usage: npx tsx scripts/advance-prod.ts --user <google-sub> [--url https://pyramid.finereli.com] [--model <name>] [--max-calls 10] [--verify-only]
 */
import { readFileSync } from 'node:fs';

function arg(flag: string, def?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i >= 0) return process.argv[i + 1]!;
  return def;
}
function has(flag: string): boolean { return process.argv.includes(flag); }
function fromDevVars(key: string): string {
  for (const line of readFileSync('.dev.vars', 'utf8').split('\n')) {
    const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`));
    if (m) return m[1]!.replace(/^["']|["']$/g, '');
  }
  throw new Error(`${key} not in .dev.vars`);
}

const BASE = arg('--url', 'https://pyramid.finereli.com')!;
const USER = arg('--user');
if (!USER) throw new Error('--user <google-sub> required');
const MODEL = arg('--model');
const MAX_CALLS = Number(arg('--max-calls', '10'));
const ADMIN_TOKEN = fromDevVars('ADMIN_TOKEN');

async function admin(path: string, body: object): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN_TOKEN },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} ${res.status}: ${await res.text()}`);
  return res.json();
}

async function advance(): Promise<void> {
  let totalT0 = 0, totalRoll = 0;
  const t0 = Date.now();
  for (let round = 1; ; round++) {
    const r = await admin('/admin/advance', { userId: USER, model: MODEL, maxCalls: MAX_CALLS });
    totalT0 += r.tier0; totalRoll += r.rollups;
    const touched = Object.entries(r.perModel as Record<string, { tier0: number; rollups: number }>)
      .filter(([, v]) => v.tier0 + v.rollups > 0).map(([k, v]) => `${k}:+${v.tier0}/${v.rollups}`).join(' ');
    console.log(`round ${round} (${Math.round((Date.now() - t0) / 1000)}s): +${r.tier0} tier-0, +${r.rollups} rollups  ${touched}${r.remaining ? '' : '  — done'}`);
    if (!r.remaining) break;
  }
  console.log(`advanced: ${totalT0} tier-0 summaries, ${totalRoll} rollups in ${Math.round((Date.now() - t0) / 1000)}s`);
}

async function verify(): Promise<boolean> {
  const stats = await admin('/admin/stats', { userId: USER });
  let ok = true;
  console.log(`\nverify: ${stats.observations} obs, ${stats.summaries} summaries (${stats.summariesEmbedded} embedded)`);
  for (const m of stats.perModel as Array<{ name: string; observations: number; unsummarized: number; summaries: number; topTier: number }>) {
    if (MODEL && m.name !== MODEL) continue;
    const exp = await admin('/admin/model', { userId: USER, model: m.name });
    const t0 = (exp.summaries as Array<{ tier: number; sources: Array<{ type: string; id: string }> }>).filter(s => s.tier === 0);
    const count = new Map<string, number>();
    for (const s of t0) for (const src of s.sources) {
      if (src.type !== 'observation') { console.log(`  ✗ ${m.name}: tier-0 ${s} has a summary source`); ok = false; }
      count.set(src.id, (count.get(src.id) ?? 0) + 1);
    }
    const unsum = new Set<string>(exp.unsummarized);
    let bad = 0;
    for (const o of exp.observations as Array<{ id: string }>) {
      const n = count.get(o.id) ?? 0;
      if (unsum.has(o.id) ? n !== 0 : n !== 1) bad++;
    }
    // Higher tiers: every source is a summary of this model, each rolled at most once.
    const ids = new Set((exp.summaries as Array<{ id: string }>).map(s => s.id));
    const rolled = new Map<string, number>();
    for (const s of exp.summaries as Array<{ tier: number; sources: Array<{ type: string; id: string }> }>) {
      if (s.tier === 0) continue;
      for (const src of s.sources) {
        if (src.type !== 'summary' || !ids.has(src.id)) { bad++; }
        rolled.set(src.id, (rolled.get(src.id) ?? 0) + 1);
      }
    }
    for (const [, n] of rolled) if (n > 1) bad++;
    const tailOk = unsum.size < 10 || m.observations === 0;
    const line = `  ${bad === 0 && tailOk ? '✓' : '✗'} ${m.name}: ${m.observations} obs, ${m.summaries} summaries (top tier ${m.topTier}), tail ${unsum.size}${bad ? `, ${bad} provenance violations` : ''}`;
    console.log(line);
    if (bad || !tailOk) ok = false;
  }
  console.log(ok ? '\nverify: OK — every observation is a source of exactly one tier-0 of each model it is tagged to' : '\nverify: FAILED');
  return ok;
}

async function main() {
  if (!has('--verify-only')) await advance();
  const ok = await verify();
  process.exit(ok ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
