import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

/** Fresh isolated DO per test — unique name → fresh SQLite + seed. */
function freshUser() {
  const id = env.MEMORY_DO.idFromName('user-' + crypto.randomUUID());
  return env.MEMORY_DO.get(id);
}

describe('MemoryDO storage', () => {
  it('seeds the five base models on first use, all marked seed', async () => {
    const u = freshUser();
    const models = await u.listModels();
    expect(models.map(m => m.name).sort()).toEqual(['memory', 'self', 'system', 'user', 'world']);
    expect(models.every(m => m.isSeed)).toBe(true);
  });

  it('upserts models by name (same id, updated description)', async () => {
    const u = freshUser();
    const id1 = await u.createModel('client-cristi', 'Cristi engagement');
    const id2 = await u.createModel('client-cristi', 'Cristi engagement — updated terms');
    expect(id1).toBe(id2);
    const m = await u.getModel('client-cristi');
    expect(m?.description).toContain('updated');
  });

  it('records multi-tag observations and rejects unknown model names', async () => {
    const u = freshUser();
    await u.createModel('coaching', 'coaching practice');

    const bad = await u.addObservation('should fail', ['coaching', 'does-not-exist']);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.unknown).toEqual(['does-not-exist']);

    const ok = await u.addObservation('Eli closed the Cristi deal at $4k/mo + 10% rev share', ['user', 'coaching']);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.tagged.sort()).toEqual(['coaching', 'user']);
      const user = await u.getModel('user');
      const obs = await u.listObservationsForModel(user!.id);
      expect(obs.length).toBe(1);
      expect(obs[0]!.text).toContain('$4k/mo');
    }
  });

  it('dedups identical-prefix observations recorded within 24h', async () => {
    const u = freshUser();
    const text = 'A sufficiently long observation prefix that should be caught by the deduper on repeat';
    const a = await u.addObservation(text, ['user']);
    const b = await u.addObservation(text, ['user']);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.deduped).toBe(true);
    const user = await u.getModel('user');
    const obs = await u.listObservationsForModel(user!.id);
    expect(obs.length).toBe(1);
  });

  it('reports confidence and stats', async () => {
    const u = freshUser();
    await u.addObservation('first thing worth remembering about Eli', ['user']);
    await u.addObservation('second distinct thing worth remembering', ['user']);
    const user = await u.getModel('user');
    const conf = await u.getModelConfidence(user!.id);
    expect(conf.obsCount).toBe(2);
    expect(conf.earliest).not.toBeNull();

    const stats = await u.getStats();
    expect(stats.models).toBe(5);
    expect(stats.observations).toBe(2);
    expect(stats.observationSize.count).toBe(2);
    expect(stats.observationSize.minChars).toBe('first thing worth remembering about Eli'.length);
    expect(stats.observationSize.maxChars).toBe('second distinct thing worth remembering'.length);
    expect(stats.observationSize.meanTokens).toBe(Math.round(stats.observationSize.meanChars / 4));
    expect(stats.summarySize.count).toBe(0);
    const userRow = stats.perModel.find(m => m.name === 'user')!;
    expect(userRow.observations).toBe(2);
    expect(userRow.seed).toBe(true);
    expect(userRow.observationChars).toBe(stats.observationSize.totalChars);
    expect(userRow.summaries).toBe(0);
    expect(userRow.topTier).toBe(-1);
    expect(stats.perModel[0]!.name).toBe('user');
  });

  it('recentObservations returns newest-first across all models', async () => {
    const u = freshUser();
    await u.addObservation('older note', ['world']);
    await u.addObservation('newer note', ['world']);
    const recent = await u.recentObservations(10);
    expect(recent[0]!.text).toBe('newer note');
    expect(recent[1]!.text).toBe('older note');
  });
});

describe('summary coverage — verbatim tails exclude summarized observations', () => {
  const DAY = 86_400_000;

  it('listObservationsForModel with afterTs returns only the unsummarized tail', async () => {
    const u = freshUser();
    const now = Date.now();
    await u.bulkLoad(
      [{ name: 'proj', description: 'a project' }],
      [
        { text: 'old obs one', timestamp: now - 10 * DAY, models: ['proj'] },
        { text: 'old obs two', timestamp: now - 8 * DAY, models: ['proj'] },
        { text: 'fresh obs', timestamp: now - DAY, models: ['proj'] },
      ],
    );
    const m = await u.getModel('proj');
    const all = await u.listObservationsForModel(m!.id);
    expect(all.length).toBe(3);
    const old = all.filter(o => o.text.startsWith('old'));
    await u.insertSummary(m!.id, { tier: 0, text: 'the compressed arc', startTimestamp: now - 10 * DAY, endTimestamp: now - 8 * DAY, sourceCount: 2 },
      old.map(o => ({ type: 'observation' as const, id: o.id })));

    // Read path: only what no summary has consumed — by provenance, not timestamps.
    const tail = await u.listTailForModel(m!.id, 15);
    expect(tail.map(o => o.text)).toEqual(['fresh obs']);
    // Export sees every summary with its sources.
    const exp = (await u.exportModel('proj'))!;
    expect(exp.summaries[0]!.sources.map(x => x.id).sort()).toEqual(old.map(o => o.id).sort());
  });

  it('recentObservations is simply the newest across models, covered or not', async () => {
    const u = freshUser();
    const now = Date.now();
    await u.bulkLoad(
      [{ name: 'a', description: 'A' }, { name: 'b', description: 'B' }],
      [
        { text: 'covered everywhere', timestamp: now - 10 * DAY, models: ['a'] },
        { text: 'covered in a but not b', timestamp: now - 9 * DAY, models: ['a', 'b'] },
        { text: 'not covered at all', timestamp: now - DAY, models: ['a'] },
      ],
    );
    const a = await u.getModel('a');
    const aObs = await u.listObservationsForModel(a!.id);
    const covered = aObs.filter(o => o.text.startsWith('covered'));
    await u.insertSummary(a!.id, { tier: 0, text: 'arc of a', startTimestamp: now - 10 * DAY, endTimestamp: now - 9 * DAY, sourceCount: 2 },
      covered.map(o => ({ type: 'observation' as const, id: o.id })));

    const texts = (await u.recentObservations(10)).map(o => o.text);
    expect(texts).toEqual(['not covered at all', 'covered in a but not b', 'covered everywhere']); // newest first, coverage irrelevant
  });
});

describe('pyramid — exact-once provenance, rollups, immutability (stub synthesis)', () => {
  const DAY = 86_400_000;

  /** A fresh DO with stub synthesis and `n` observations on model `proj`, one per day, oldest first. */
  async function seeded(n: number, extraModels: string[] = []) {
    const u = freshUser();
    await u.enableStubSynthesis();
    const now = Date.now();
    const models = [{ name: 'proj', description: 'a project' }, ...extraModels.map(m => ({ name: m, description: m }))];
    const observations = Array.from({ length: n }, (_, i) => ({ text: `obs ${i} about the project`, timestamp: now - (n - i) * DAY, models: ['proj'] }));
    await u.bulkLoad(models, observations);
    const m = await u.getModel('proj');
    return { u, m: m!, now };
  }

  it('advancePyramid summarizes full tier-0 batches only and records every source exactly once', async () => {
    const { u, m } = await seeded(23);
    const r = await u.advancePyramid(m.id);
    expect(r.tier0).toBe(2);
    expect(r.rollups).toBe(0);
    expect(r.remaining).toBe(false);

    const all = await u.listAllSummariesForModel(m.id);
    expect(all.length).toBe(2);
    expect(all.every(s => s.tier === 0 && s.sourceCount === 10)).toBe(true);

    // Exact-once: 20 distinct observation ids across the two summaries; 3 left in the tail.
    const srcs = (await Promise.all(all.map(s => u.listSummarySources(s.id)))).flat();
    expect(srcs.length).toBe(20);
    expect(new Set(srcs.map(s => s.id)).size).toBe(20);
    expect(srcs.every(s => s.type === 'observation')).toBe(true);
    const tail = await u.unsummarizedObservations(m.id);
    expect(tail.length).toBe(3);
    expect(tail.map(o => o.text)).toEqual(['obs 20 about the project', 'obs 21 about the project', 'obs 22 about the project']);

    // Summary windows are contiguous and chronological.
    expect(all[0]!.endTimestamp).toBeLessThan(all[1]!.startTimestamp);
  });

  it('rolls up at exactly ROLLUP_FAN_IN and builds tier N+1 only from tier N', async () => {
    const { u, m } = await seeded(55); // 5 full tier-0 batches + 5 tail
    const r = await u.advancePyramid(m.id);
    expect(r.tier0).toBe(5);
    expect(r.rollups).toBe(1);
    const all = await u.listAllSummariesForModel(m.id);
    const t1 = all.filter(s => s.tier === 1);
    expect(t1.length).toBe(1);
    const srcs = await u.listSummarySources(t1[0]!.id);
    expect(srcs.length).toBe(5);
    expect(srcs.every(s => s.type === 'summary')).toBe(true);
    expect(t1[0]!.sourceCount).toBe(5);
    expect(t1[0]!.startTimestamp).toBe(Math.min(...all.filter(s => s.tier === 0).map(s => s.startTimestamp)));

    // The cover is the tier-1 summary alone (tier-0s are rolled up), plus the 5-obs tail.
    const cover = await u.listSummariesForModel(m.id);
    expect(cover.map(s => s.tier)).toEqual([1]);
    expect((await u.listTailForModel(m.id, 15)).length).toBe(5);
  });

  it('is incremental and immutable: advancing again never rewrites existing summaries', async () => {
    const { u, m } = await seeded(12);
    await u.advancePyramid(m.id);
    const before = await u.listAllSummariesForModel(m.id);
    expect(before.length).toBe(1);

    // Nothing new → nothing happens, nothing changes.
    const r0 = await u.advancePyramid(m.id);
    expect(r0.tier0 + r0.rollups).toBe(0);
    expect(await u.listAllSummariesForModel(m.id)).toEqual(before);

    // 8 more observations complete a second batch; the first summary is untouched.
    for (let i = 0; i < 8; i++) await u.addObservation(`later note ${i} distinct enough to pass dedup`, ['proj']);
    const r1 = await u.advancePyramid(m.id);
    expect(r1.tier0).toBe(1);
    const after = await u.listAllSummariesForModel(m.id);
    expect(after.length).toBe(2);
    expect(after.find(s => s.id === before[0]!.id)).toEqual(before[0]);
  });

  it('honours maxCalls and reports remaining, resuming on the next call', async () => {
    const { u, m } = await seeded(35);
    const r1 = await u.advancePyramid(m.id, { maxCalls: 2 });
    expect(r1.tier0).toBe(2);
    expect(r1.remaining).toBe(true);
    const r2 = await u.advancePyramid(m.id);
    expect(r2.tier0).toBe(1);
    expect(r2.remaining).toBe(false);
    expect((await u.listAllSummariesForModel(m.id)).length).toBe(3);
  });

  it('an observation tagged to two models is summarized once per model', async () => {
    const { u, m } = await seeded(10, ['other']);
    const other = (await u.getModel('other'))!;
    // Tag the same 10 observations to `other` as well.
    const obs = await u.listObservationsForModel(m.id, 100);
    await u.bulkLoad([], []); // no-op, keeps the API honest
    for (const o of obs) await u.tagObservation(o.id, other.id);
    await u.advancePyramid(m.id);
    await u.advancePyramid(other.id);
    const a = await u.listAllSummariesForModel(m.id);
    const b = await u.listAllSummariesForModel(other.id);
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
    expect((await u.unsummarizedObservations(m.id)).length).toBe(0);
    expect((await u.unsummarizedObservations(other.id)).length).toBe(0);
  });

  it('rejects a summary without sources — provenance is mandatory', async () => {
    const { u, m, now } = await seeded(3);
    await expect(u.insertSummary(m.id, { tier: 0, text: 'orphan', startTimestamp: now - 3 * DAY, endTimestamp: now - DAY, sourceCount: 0 }, [])).rejects.toThrow();
    expect((await u.listAllSummariesForModel(m.id)).length).toBe(0);
  });

  it('100-observation regression: every observation is a source of exactly one tier-0 of its model, except the trailing partial batch', async () => {
    const { u, m } = await seeded(100);
    const r = await u.advancePyramid(m.id);
    expect(r.tier0).toBe(10);
    expect(r.rollups).toBe(2);
    const exp = (await u.exportModel('proj'))!;
    const t0 = exp.summaries.filter(s => s.tier === 0);
    const count = new Map<string, number>();
    for (const s of t0) for (const src of s.sources) count.set(src.id, (count.get(src.id) ?? 0) + 1);
    for (const o of exp.observations) {
      const n = count.get(o.id) ?? 0;
      if (exp.unsummarized.includes(o.id)) expect(n).toBe(0); else expect(n).toBe(1);
    }
    expect(exp.unsummarized.length).toBeLessThan(10);
    // Cover = 2 tier-1 (10 tier-0s rolled into 2) and 0 tier-0 left unrolled.
    const cover = await u.listSummariesForModel(m.id);
    expect(cover.map(s => s.tier)).toEqual([1, 1]);
    // Stats agree.
    const st = await u.getStats();
    const row = st.perModel.find(x => x.name === 'proj')!;
    expect(row.unsummarized).toBe(0);
    expect(row.summaries).toBe(12);
    expect(row.topTier).toBe(1);
    // Cover: the 2 tier-1 summaries, no tail. View = cover + ramp (2 newest tier-0 + 5 newest obs).
    expect(row.coverSummaries).toBe(2);
    expect(row.coverChars).toBe(cover.reduce((n, s) => n + s.text.length, 0));
    expect(row.tailChars).toBe(0);
    expect(row.viewSummaries).toBe(4);
    expect(row.viewObservations).toBe(5);
    expect(row.viewChars).toBeGreaterThan(row.coverChars);
  });

  it('recall returns summaries as well as observations, labeled', async () => {
    const u = freshUser();
    // Observations with synthetic vectors; a summary inserted with its own vector via setSummaryEmbedding.
    await u.addObservation('aligned receipt', ['world'], 'direct', [1, 0, 0, 0]);
    const world = (await u.getModel('world'))!;
    await u.enableStubSynthesis(); // insertSummary skips embedding in stub mode; set it explicitly
    const sid = await u.insertSummary(world.id, { tier: 0, text: 'the arc of the world', startTimestamp: 1, endTimestamp: 2, sourceCount: 1 }, [{ type: 'observation', id: 'x' }]);
    await u.setSummaryEmbedding(sid, [0.9, 0.1, 0, 0]);
    const hits = await u.searchObservations([1, 0, 0, 0], 10, 0);
    expect(hits.length).toBe(2);
    expect(hits.map(h => h.kind).sort()).toEqual(['observation', 'summary']);
    const s = hits.find(h => h.kind === 'summary')!;
    expect(s.tier).toBe(0);
    expect(s.startTimestamp).toBe(1);
    const only = await u.searchObservations([1, 0, 0, 0], 10, 0, false);
    expect(only.every(h => h.kind === 'observation')).toBe(true);
  });
});

describe('pyramid — verifier-driven coverage (guard, failure, multi-tier, advanceAll, undo)', () => {
  const DAY = 86_400_000;
  async function seeded(n: number, model = 'proj') {
    const u = freshUser();
    await u.enableStubSynthesis();
    const now = Date.now();
    await u.bulkLoad([{ name: model, description: 'a project' }],
      Array.from({ length: n }, (_, i) => ({ text: `obs ${i} about the project`, timestamp: now - (n - i) * DAY, models: [model] })));
    return { u, m: (await u.getModel(model))!, now };
  }

  it('rolls up as soon as 5 tier-0s exist, even mid-backlog, so the top tier stays narrow', async () => {
    const { u, m } = await seeded(100);
    const r = await u.advancePyramid(m.id, { maxCalls: 6 }); // 5 tier-0 + the rollup they enable
    expect(r.tier0).toBe(5);
    expect(r.rollups).toBe(1);
    expect(r.remaining).toBe(true);
    expect((await u.listSummariesForModel(m.id)).map(s => s.tier)).toEqual([1]);
  });

  it('builds tier 2 from tier 1 only, across separate runs (repeat at every tier)', async () => {
    const { u, m } = await seeded(260); // exactly 26 tier-0 → 5 tier-1 → 1 tier-2, empty tail
    let rounds = 0, total = { tier0: 0, rollups: 0 };
    for (;;) {
      const r = await u.advancePyramid(m.id, { maxCalls: 7 });
      total.tier0 += r.tier0; total.rollups += r.rollups; rounds++;
      if (!r.remaining) break;
      if (rounds > 50) throw new Error('did not converge');
    }
    expect(total.tier0).toBe(26);
    expect(total.rollups).toBe(6); // 5 tier-1 + 1 tier-2
    const all = await u.listAllSummariesForModel(m.id);
    const t2 = all.filter(s => s.tier === 2);
    expect(t2.length).toBe(1);
    const srcs = await u.listSummarySources(t2[0]!.id);
    expect(srcs.every(x => x.type === 'summary')).toBe(true);
    expect(all.filter(s => s.tier === 1 && srcs.some(x => x.id === s.id)).length).toBe(5);
    expect((await u.listSummariesForModel(m.id)).map(s => s.tier)).toEqual([2, 0]); // 25 tier-0 rolled via 5 tier-1; 1 tier-0 unrolled
    expect((await u.unsummarizedObservations(m.id)).length).toBe(0);
  });

  it('a failed synthesis inserts nothing and the next run resumes', async () => {
    const { u, m } = await seeded(25);
    await u.enableStubSynthesis('fail');
    await expect(u.advancePyramid(m.id)).rejects.toThrow();
    expect((await u.listAllSummariesForModel(m.id)).length).toBe(0);
    expect((await u.unsummarizedObservations(m.id)).length).toBe(25);
    await u.enableStubSynthesis('ok');
    const r = await u.advancePyramid(m.id);
    expect(r.tier0).toBe(2);
  });

  it('maybeResummarize swallows failures; advanceAll reports them per model and continues', async () => {
    const { u, m } = await seeded(12);
    await u.createModel('other', 'other'); // no obs → nothing to do
    await u.enableStubSynthesis('fail');
    expect(await u.maybeResummarize(['proj'])).toEqual([]);
    const r = await u.advanceAll();
    expect(r.perModel['proj']!.error).toBeTruthy();
    expect(r.remaining).toBe(true);
    expect(r.models).toBeGreaterThanOrEqual(7); // 5 seeds + proj + other (archived included)
    expect((await u.listAllSummariesForModel(m.id)).length).toBe(0);
  });

  it('advanceAll honours a budget across models, includes archived models, and filters by name', async () => {
    const u = freshUser();
    await u.enableStubSynthesis();
    const now = Date.now();
    const mk = (model: string, n: number) => Array.from({ length: n }, (_, i) => ({ text: `${model} obs ${i} distinct text`, timestamp: now - (n - i) * DAY, models: [model] }));
    await u.bulkLoad([{ name: 'a', description: 'A' }, { name: 'b', description: 'B' }], [...mk('a', 20), ...mk('b', 20)]);
    await u.archiveModel('b');
    const r1 = await u.advanceAll({ maxCalls: 3 });
    expect(r1.tier0).toBe(3);
    expect(r1.remaining).toBe(true);
    const r2 = await u.advanceAll();
    expect(r2.tier0).toBe(1);
    expect(r2.remaining).toBe(false);
    const b = (await u.getModel('b'))!;
    expect((await u.listAllSummariesForModel(b.id)).length).toBe(2); // archived model advanced too
    const r3 = await u.advanceAll({ model: 'a' });
    expect(r3.models).toBe(1);
    expect(r3.tier0 + r3.rollups).toBe(0);
  });

  it('concurrent advances on one model do not double-summarize; the second reports remaining', async () => {
    const { u, m } = await seeded(30);
    await u.enableStubSynthesis('slow'); // yields between calls, so the two RPCs really overlap
    const [r1, r2] = await Promise.all([u.advancePyramid(m.id), u.advancePyramid(m.id)]);
    const work = [r1, r2].map(r => r.tier0 + r.rollups).sort();
    expect(work).toEqual([0, 3]);
    expect((await u.listAllSummariesForModel(m.id)).length).toBe(3);
    const guarded = r1.tier0 === 0 ? r1 : r2;
    expect(guarded.remaining).toBe(true);
  });

  it('unsummarizeModel drops one model\'s summaries + provenance and leaves observations intact', async () => {
    const { u, m } = await seeded(23);
    await u.advancePyramid(m.id);
    expect((await u.listAllSummariesForModel(m.id)).length).toBe(2);
    const r = await u.unsummarizeModel('proj');
    expect(r).toEqual({ ok: true, summaries: 2 });
    expect((await u.listAllSummariesForModel(m.id)).length).toBe(0);
    expect((await u.unsummarizedObservations(m.id)).length).toBe(23);
    expect((await u.getStats()).observations).toBe(23);
    const again = await u.advancePyramid(m.id);
    expect(again.tier0).toBe(2);
  });

  it('degenerate synthesis output is refused, not stored', async () => {
    const { checkSynthOutput } = await import('../src/memory-do.js');
    expect(() => checkSynthOutput('')).toThrow();
    expect(() => checkSynthOutput('  ok. ')).toThrow();
    expect(checkSynthOutput('  ' + 'a real summary sentence with enough substance to count.' + '  ')).toBe('a real summary sentence with enough substance to count.');
  });
});

describe('pyramid — resolution ramp (no cliff at batch boundaries)', () => {
  const DAY = 86_400_000;
  async function seeded(n: number) {
    const u = freshUser();
    await u.enableStubSynthesis();
    const now = Date.now();
    await u.bulkLoad([{ name: 'proj', description: 'a project' }],
      Array.from({ length: n }, (_, i) => ({ text: `obs ${i} about the project`, timestamp: now - (n - i) * DAY, models: ['proj'] })));
    return { u, m: (await u.getModel('proj'))! };
  }

  it('at an exact boundary the cover collapses to the apex but the view keeps a ramp', async () => {
    const { u, m } = await seeded(50); // 5 tier-0 → 1 tier-1, tail 0
    await u.advancePyramid(m.id);
    expect((await u.listSummariesForModel(m.id)).map(s => s.tier)).toEqual([1]); // the cliff, in storage terms
    const v = await u.listViewForModel(m.id, { ramp: 2, verbatim: 5 });
    expect(v.summaries.map(s => [s.tier, !!s.covered])).toEqual([[1, false], [0, true], [0, true]]);
    const t0 = (await u.listAllSummariesForModel(m.id)).filter(s => s.tier === 0).sort((a, b) => b.startTimestamp - a.startTimestamp);
    expect(v.summaries.filter(s => s.covered).map(s => s.id).sort()).toEqual(t0.slice(0, 2).map(s => s.id).sort());
    expect(v.observations.length).toBe(5);
    expect(v.observations.every(o => o.covered)).toBe(true);
    expect(v.observations.map(o => o.text)).toEqual(['obs 49 about the project', 'obs 48 about the project', 'obs 47 about the project', 'obs 46 about the project', 'obs 45 about the project']);
  });

  it('with a partial tail the ramp only tops verbatim up to V, and with no summaries there is no ramp', async () => {
    const { u, m } = await seeded(13); // 1 tier-0, tail 3
    await u.advancePyramid(m.id);
    const v = await u.listViewForModel(m.id, { ramp: 2, verbatim: 5 });
    expect(v.summaries.map(s => [s.tier, !!s.covered])).toEqual([[0, false]]); // top tier is 0: nothing below to ramp
    expect(v.observations.filter(o => !o.covered).length).toBe(3);
    expect(v.observations.filter(o => o.covered).length).toBe(2); // 3 tail + 2 covered = 5
    const { u: u2, m: m2 } = await seeded(4);
    const v2 = await u2.listViewForModel(m2.id);
    expect(v2.summaries).toEqual([]);
    expect(v2.observations.length).toBe(4);
    expect(v2.observations.every(o => !o.covered)).toBe(true);
  });
});
