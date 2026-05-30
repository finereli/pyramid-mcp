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
