import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

function freshUser() {
  return env.MEMORY_DO.get(env.MEMORY_DO.idFromName('maint-' + crypto.randomUUID()));
}

describe('maintenance ops', () => {
  it('archives a normal model but protects seeds', async () => {
    const u = freshUser();
    await u.createModel('tangent', 'a tangent');
    expect((await u.archiveModel('tangent')).ok).toBe(true);
    expect((await u.listModels()).some(m => m.name === 'tangent')).toBe(false);

    const seed = await u.archiveModel('self');
    expect(seed.ok).toBe(false);
    expect(seed.reason).toContain('protected');
  });

  it('renames a model (obs follow) and rejects seed/colliding renames', async () => {
    const u = freshUser();
    await u.createModel('cristian', 'partnership');
    await u.addObservation('signed the deal', ['cristian']);
    expect((await u.renameModel('cristian', 'cristi')).ok).toBe(true);
    const m = await u.getModel('cristi');
    const obs = await u.listObservationsForModel(m!.id);
    expect(obs.length).toBe(1); // tag followed the rename

    expect((await u.renameModel('user', 'eli')).ok).toBe(false);        // seed protected
    await u.createModel('taken', 'x');
    expect((await u.renameModel('cristi', 'taken')).ok).toBe(false);    // collision
  });

  it('folds a model into another: synthesis lands in target, source archived', async () => {
    const u = freshUser();
    await u.createModel('finances', 'money stuff');
    const r = await u.foldModel('finances', 'user', 'Finances folded into user: LOC, austerity, tax bureaucracy.');
    expect(r.ok).toBe(true);
    expect((await u.listModels()).some(m => m.name === 'finances')).toBe(false); // archived
    const user = await u.getModel('user');
    const obs = await u.listObservationsForModel(user!.id);
    expect(obs.some(o => o.text.includes('Finances folded'))).toBe(true);

    expect((await u.foldModel('self', 'user', 'x')).ok).toBe(false); // seed source protected
  });

  it('fold carries the source\'s notes into the target by default, and can leave them behind', async () => {
    const u = freshUser();
    await u.createModel('kali', 'martial art');
    await u.createModel('hobbies', 'hobbies');
    await u.addObservation('Kali training twice a week with sticks', ['kali']);
    await u.addObservation('Kali drill: heaven six, sinawali pattern', ['kali', 'hobbies']); // already on both
    const r = await u.foldModel('kali', 'hobbies', 'Kali folded into hobbies: stick training, drills.');
    expect(r.ok).toBe(true);
    expect(r.carried).toBe(1); // the doubly-tagged note was already there
    const hobbies = await u.getModel('hobbies');
    const texts = (await u.listObservationsForModel(hobbies!.id)).map(o => o.text);
    expect(texts).toContain('Kali training twice a week with sticks');
    expect(texts).toContain('Kali folded into hobbies: stick training, drills.');

    await u.createModel('chess', 'chess');
    await u.addObservation('Learned the London system opening', ['chess']);
    const keep = await u.foldModel('chess', 'hobbies', 'Chess folded in.', undefined, false);
    expect(keep.carried).toBe(0);
    expect((await u.listObservationsForModel(hobbies!.id)).map(o => o.text)).not.toContain('Learned the London system opening');

    await u.createModel('solo', 'x');
    expect((await u.foldModel('solo', 'solo', 'x')).ok).toBe(false); // not into itself
  });

  it('suggest_folds ranks each sparse model\'s closest models by content', async () => {
    const u = freshUser();
    for (const [name, desc] of [['dnd-maps', 'map app'], ['dnd-campaign', 'campaign'], ['geometry', 'math'], ['empty', 'nothing yet']] as Array<[string, string]>) await u.createModel(name, desc);
    const dnd = [1, 0.1, 0, 0], dnd2 = [0.9, 0.2, 0, 0], math = [0, 0, 1, 0.1];
    await u.bulkLoad([], [
      { text: 'tokens on the tactical map', timestamp: Date.now() - 3000, models: ['dnd-maps'], embedding: dnd },
      { text: 'the party met the bandit captain', timestamp: Date.now() - 2000, models: ['dnd-campaign'], embedding: dnd2 },
      { text: 'angle relationships in proofs', timestamp: Date.now() - 1000, models: ['geometry'], embedding: math },
    ]);
    const rows = await u.suggestFolds();
    const maps = rows.find(r => r.name === 'dnd-maps')!;
    expect(maps.obsCount).toBe(1);
    expect(maps.closest[0]!.name).toBe('dnd-campaign');
    expect(maps.closest[0]!.similarity).toBeGreaterThan(0.9);
    const geo = rows.find(r => r.name === 'geometry')!;
    expect(geo.closest[0]!.similarity).toBeLessThan(0.2);
    expect(rows.find(r => r.name === 'empty')!.closest).toEqual([]);
    expect(rows.some(r => r.name === 'user')).toBe(false); // seeds are never fold candidates
    expect(rows[0]!.name.startsWith('dnd-')).toBe(true);   // strongest match first

    const frag = await u.computeFragmentation();
    expect(frag.sparse).toEqual(expect.arrayContaining(['dnd-maps', 'dnd-campaign', 'geometry', 'empty']));
  });

  it('flags fragmentation when many sparse models accumulate', async () => {
    const u = freshUser();
    let frag = await u.computeFragmentation();
    expect(frag.fragmented).toBe(false);
    for (let i = 0; i < 7; i++) await u.createModel(`sparse-${i}`, 'tiny'); // 0 obs each
    frag = await u.computeFragmentation();
    expect(frag.underPopulated).toBeGreaterThanOrEqual(6);
    expect(frag.fragmented).toBe(true);
  });
});
