/**
 * MemoryDO — one Durable Object per authenticated principal.
 *
 * Holds *all* of a user's memory in DO-SQLite: models, observations,
 * observation_tags, summaries, and embedding blobs. DOs serialize access, so
 * there's no cross-conversation locking to worry about. Vectors are stored
 * inline as blobs and searched by brute-force cosine in JS (see vector-search,
 * Task #3) — no external store, so 100% of a user's data lives in this object.
 *
 * This module owns the storage layer (schema + CRUD). The MCP transport,
 * embeddings, recall, summarization, and load_memory build on top of it in
 * later tasks.
 */
import { DurableObject } from 'cloudflare:workers';
import { handleMcpRequest } from './mcp.js';
import { synthesize } from './synth.js';
import { embed, embedOne, EMBEDDING_DIM } from './embeddings.js';
import { batchTier0, batchRollup, buildTier0Job, buildRollupJob, stubSynthesize, type SynthJob } from './pyramid.js';

export interface Env {
  MEMORY_DO: DurableObjectNamespace<MemoryDO>;
  AI: Ai;
}

/** The five seed models, protected from archive/rename. Cold-start scaffold. */
export const SEED_MODELS: ReadonlyArray<{ name: string; description: string }> = [
  { name: 'self', description: "The agent's own self-model — its voice, dispositions, and evolving sense of who it is." },
  { name: 'user', description: 'The human it primarily serves — who they are, what they care about, the central column of memory.' },
  { name: 'system', description: 'The operating substrate — how the agent works, what it knows about itself as software, its tools and constraints.' },
  { name: 'world', description: 'Everything else, until it differentiates into specific models. An escape valve, not a destination.' },
  { name: 'memory', description: 'The meta-model: how memory is organized in this instance — when to fold vs. split, what counts as stale, how this agent carves up its life.' },
];

export const PROTECTED_SEED_NAMES: ReadonlySet<string> = new Set(SEED_MODELS.map(m => m.name));

export function isProtectedSeed(name: string): boolean {
  return PROTECTED_SEED_NAMES.has(name);
}

// ---------- Row shapes ----------

export interface ModelRow {
  id: string;
  name: string;
  description: string | null;
  isSeed: boolean;
  archived: boolean;
  createdAt: number;
}

export interface ObservationRow {
  id: string;
  text: string;
  timestamp: number;
  source: string;
  /** Set on view rows only: this observation is already inside a tier-0 summary shown above (resolution ramp). */
  covered?: boolean;
}

export interface SummaryRow {
  id: string;
  tier: number;
  text: string;
  startTimestamp: number;
  endTimestamp: number;
  sourceCount: number;
  /** Transitive: raw observations behind this summary through all tiers below. */
  obsCount?: number;
  /** Transitive: total chars of those raw observations — the numerator of the compression ratio. */
  sourceChars?: number;
  /** Set on view rows only: this summary is already rolled into a higher tier shown above (resolution ramp). */
  covered?: boolean;
}

export type AddObservationResult =
  | { ok: true; id: string; tagged: string[]; deduped?: boolean }
  | { ok: false; unknown: string[] };

export interface ObservationMatch {
  id: string;
  text: string;
  timestamp: number;     // observation timestamp, or a summary's end timestamp
  score: number;         // lower = better (cosine distance blended with time penalty)
  kind: 'observation' | 'summary';
  tier?: number;         // summaries only
  startTimestamp?: number; // summaries only
  obsCount?: number;     // summaries only: transitive raw observations behind the arc
}

export interface SummarySource { type: 'observation' | 'summary'; id: string }

export interface AdvanceResult { tier0: number; rollups: number; remaining: boolean }

/**
 * Summaries are immutable once written, so a degenerate synthesis result
 * (empty, a refusal, a couple of words) must be treated as a failure — thrown
 * here, caught by the trigger, retried next time — rather than stored forever.
 */
const MIN_SUMMARY_CHARS = 40;
export function checkSynthOutput(text: string): string {
  const t = text.trim();
  if (t.length < MIN_SUMMARY_CHARS) throw new Error(`synthesis returned degenerate output (${t.length} chars)`);
  return t;
}

const DEDUP_WINDOW_MS = 24 * 3600 * 1000;
const DEDUP_PREFIX_CHARS = 80;

/** 30-day half-life recency penalty, mirroring Glopus recall.ts. */
const TIME_DECAY_HALF_LIFE_DAYS = 30;

export class MemoryDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.migrate();
    this.ensureSeedModels();
  }

  /** MCP JSON-RPC endpoint — the server is hosted in this DO (see mcp.ts). */
  override fetch(request: Request): Promise<Response> {
    return handleMcpRequest(this, request);
  }

  // ---------- Schema ----------

  private migrate(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS models (
        id                    TEXT PRIMARY KEY,
        name                  TEXT UNIQUE NOT NULL,
        description           TEXT,
        is_seed               INTEGER NOT NULL DEFAULT 0,
        archived              INTEGER NOT NULL DEFAULT 0,
        created_at            INTEGER NOT NULL,
        last_summarized_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS observations (
        id         TEXT PRIMARY KEY,
        text       TEXT NOT NULL,
        timestamp  INTEGER NOT NULL,
        source     TEXT NOT NULL DEFAULT 'direct',
        embedding  BLOB
      );
      CREATE INDEX IF NOT EXISTS idx_obs_ts ON observations(timestamp);
      CREATE TABLE IF NOT EXISTS observation_tags (
        observation_id TEXT NOT NULL,
        model_id       TEXT NOT NULL,
        PRIMARY KEY (observation_id, model_id)
      );
      CREATE INDEX IF NOT EXISTS idx_tags_model ON observation_tags(model_id);
      CREATE TABLE IF NOT EXISTS summaries (
        id              TEXT PRIMARY KEY,
        model_id        TEXT NOT NULL,
        tier            INTEGER NOT NULL,
        text            TEXT NOT NULL,
        start_timestamp INTEGER NOT NULL,
        end_timestamp   INTEGER NOT NULL,
        source_count    INTEGER NOT NULL DEFAULT 0,
        is_dirty        INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sum_model ON summaries(model_id);
      CREATE TABLE IF NOT EXISTS summary_sources (
        summary_id  TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id   TEXT NOT NULL,
        PRIMARY KEY (summary_id, source_id)
      );
      CREATE INDEX IF NOT EXISTS idx_ss_source ON summary_sources(source_type, source_id);
      CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);
    `);
    // Add columns introduced after the initial schema, for DOs created earlier.
    try { this.sql.exec('ALTER TABLE models ADD COLUMN last_summarized_count INTEGER NOT NULL DEFAULT 0'); } catch { /* already present */ }
    try { this.sql.exec('ALTER TABLE summaries ADD COLUMN embedding BLOB'); } catch { /* already present */ }
    try { this.sql.exec('ALTER TABLE summaries ADD COLUMN obs_count INTEGER'); } catch { /* already present */ }
    try { this.sql.exec('ALTER TABLE summaries ADD COLUMN source_chars INTEGER'); } catch { /* already present */ }
    // Migration from the time-window pyramid (pre Aug 2026): a summary without
    // provenance rows is invalid in this design — nothing can be covered by it
    // and nothing can roll it up. Drop any such rows; the pyramid regrows
    // incrementally from the observations. Idempotent and cheap.
    this.sql.exec('DELETE FROM summaries WHERE NOT EXISTS (SELECT 1 FROM summary_sources ss WHERE ss.summary_id = summaries.id)');
    this.backfillProvenanceStats();
  }

  /**
   * One-time backfill of the transitive provenance stats (obs_count,
   * source_chars) for summaries created before those columns existed. Tier 0
   * counts straight from summary_sources; higher tiers sum their children, so
   * the walk goes tier-ascending. New summaries get the values at insert;
   * re-running touches nothing (obs_count IS NULL filter). Cheap and idempotent.
   */
  private backfillProvenanceStats(): void {
    const missing = (this.sql.exec('SELECT COUNT(*) AS c FROM summaries WHERE obs_count IS NULL').one() as { c: number }).c;
    if (missing === 0) return;
    this.sql.exec(
      `UPDATE summaries SET
         obs_count = (SELECT COUNT(*) FROM summary_sources ss WHERE ss.summary_id = summaries.id),
         source_chars = (SELECT COALESCE(SUM(LENGTH(o.text)), 0) FROM summary_sources ss JOIN observations o ON o.id = ss.source_id WHERE ss.summary_id = summaries.id)
       WHERE tier = 0 AND obs_count IS NULL`,
    );
    const maxTier = (this.sql.exec('SELECT COALESCE(MAX(tier), 0) AS t FROM summaries').one() as { t: number }).t;
    for (let tier = 1; tier <= maxTier; tier++) {
      this.sql.exec(
        `UPDATE summaries SET
           obs_count = (SELECT COALESCE(SUM(c.obs_count), 0) FROM summary_sources ss JOIN summaries c ON c.id = ss.source_id WHERE ss.summary_id = summaries.id),
           source_chars = (SELECT COALESCE(SUM(c.source_chars), 0) FROM summary_sources ss JOIN summaries c ON c.id = ss.source_id WHERE ss.summary_id = summaries.id)
         WHERE tier = ? AND obs_count IS NULL`,
        tier,
      );
    }
  }

  private getConfig(key: string): string | undefined {
    const row = this.sql.exec('SELECT value FROM config WHERE key = ?', key).toArray()[0] as { value: string } | undefined;
    return row?.value;
  }

  private setConfig(key: string, value: string): void {
    this.sql.exec('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }

  /**
   * Route synthesis through a deterministic stub instead of Workers AI. For
   * tests and dry runs; persisted in config so it survives across RPC calls to
   * the same DO. Never set in production paths.
   */
  enableStubSynthesis(mode: 'ok' | 'fail' | 'slow' = 'ok'): void { this.setConfig('synth_stub', mode); }

  private async runSynth(job: SynthJob): Promise<string> {
    const mode = this.getConfig('synth_stub');
    if (mode === 'fail') throw new Error('stub synthesis failure');
    if (mode === 'slow') { await new Promise(r => setTimeout(r, 20)); return stubSynthesize(job); } // yields like a real call
    if (mode) return stubSynthesize(job);
    return synthesize(this.env.AI, job.system, job.user, { maxTokens: job.maxTokens });
  }

  /**
   * Remember the user's IANA timezone for render-time labels ("today 14:30" /
   * "yesterday"), supplied by the host agent via load_memory. Validated here so
   * an invalid name never enters config. Returns whether it was accepted.
   */
  setTimezone(tz: string): boolean {
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { return false; }
    this.setConfig('timezone', tz);
    return true;
  }

  getTimezone(): string | undefined {
    return this.getConfig('timezone');
  }

  private ensureSeedModels(): void {
    const count = this.sql.exec('SELECT COUNT(*) AS c FROM models').one().c as number;
    if (count > 0) return; // already seeded (or migrated) — don't re-create
    const now = Date.now();
    for (const m of SEED_MODELS) {
      this.sql.exec(
        'INSERT INTO models (id, name, description, is_seed, created_at) VALUES (?, ?, ?, 1, ?)',
        crypto.randomUUID(), m.name, m.description, now,
      );
    }
  }

  // ---------- Embeddings (Workers AI bge-m3, via the env.AI binding) ----------

  /** Embed one text. Throws on failure; callers decide whether that's fatal. */
  embed(text: string): Promise<number[]> {
    return embedOne(this.env.AI, text);
  }

  /** Embed multiple texts in one round trip. */
  embedMany(texts: string[]): Promise<number[][]> {
    return embed(this.env.AI, texts);
  }

  /** Schedule async work that outlives the current request. */
  background(fn: Promise<unknown>): void {
    this.ctx.waitUntil(fn);
  }

  /**
   * Re-embed observations whose stored vector isn't the current bge-m3
   * dimension (or is missing) — the in-place migration off OpenAI's 1536-dim
   * space. Processes up to `limit` per call so the caller can loop and stay
   * within per-request subrequest limits. Idempotent: re-running only touches
   * vectors not yet at EMBEDDING_DIM.
   */
  async reembedBatch(limit = 20): Promise<{ done: number; remaining: number; dim: number }> {
    const targetBytes = EMBEDDING_DIM * 4; // Float32
    const rows = this.sql.exec(
      'SELECT id, text FROM observations WHERE embedding IS NULL OR LENGTH(embedding) != ? LIMIT ?',
      targetBytes, limit,
    ).toArray() as Array<{ id: string; text: string }>;
    if (rows.length > 0) {
      const vecs = await embed(this.env.AI, rows.map(r => r.text));
      rows.forEach((r, i) => this.setObservationEmbedding(r.id, vecs[i]!));
    }
    // Summaries are embedded too (recall returns arcs as well as receipts).
    const srows = this.sql.exec(
      'SELECT id, text FROM summaries WHERE embedding IS NULL OR LENGTH(embedding) != ? LIMIT ?',
      targetBytes, Math.max(0, limit - rows.length),
    ).toArray() as Array<{ id: string; text: string }>;
    if (srows.length > 0) {
      const vecs = await embed(this.env.AI, srows.map(r => r.text));
      srows.forEach((r, i) => this.sql.exec('UPDATE summaries SET embedding = ? WHERE id = ?', floatsToBlob(normalizeVec(vecs[i]!)), r.id));
    }
    const remaining = (this.sql.exec(
      `SELECT (SELECT COUNT(*) FROM observations WHERE embedding IS NULL OR LENGTH(embedding) != ?)
            + (SELECT COUNT(*) FROM summaries WHERE embedding IS NULL OR LENGTH(embedding) != ?) AS c`,
      targetBytes, targetBytes,
    ).one() as { c: number }).c;
    return { done: rows.length + srows.length, remaining, dim: EMBEDDING_DIM };
  }

  // ---------- Models ----------

  /** Upsert by name. Returns the model id; updates description if it changed. */
  createModel(name: string, description: string): string {
    const existing = this.sql
      .exec('SELECT id, description FROM models WHERE name = ?', name)
      .toArray()[0] as { id: string; description: string | null } | undefined;
    if (existing) {
      if (existing.description !== description) {
        this.sql.exec('UPDATE models SET description = ? WHERE id = ?', description, existing.id);
      }
      return existing.id;
    }
    const id = crypto.randomUUID();
    this.sql.exec(
      'INSERT INTO models (id, name, description, is_seed, created_at) VALUES (?, ?, ?, 0, ?)',
      id, name, description, Date.now(),
    );
    return id;
  }

  updateModelDescription(name: string, description: string): boolean {
    const cursor = this.sql.exec('UPDATE models SET description = ? WHERE name = ?', description, name);
    return cursor.rowsWritten > 0;
  }

  listModels(includeArchived = false): ModelRow[] {
    const rows = this.sql
      .exec(`SELECT id, name, description, is_seed, archived, created_at FROM models${includeArchived ? '' : ' WHERE archived = 0'} ORDER BY name`)
      .toArray() as Array<Record<string, unknown>>;
    return rows.map(toModelRow);
  }

  getModel(name: string): ModelRow | undefined {
    const row = this.sql
      .exec('SELECT id, name, description, is_seed, archived, created_at FROM models WHERE name = ?', name)
      .toArray()[0] as Record<string, unknown> | undefined;
    return row ? toModelRow(row) : undefined;
  }

  // ---------- Observations ----------

  /**
   * Agent-authored multi-tag observation. Validates every model name exists,
   * dedups against recent identical-prefix observations, inserts one tag row
   * per model. Embedding (if provided) is stored inline as a blob; otherwise
   * the caller embeds asynchronously and calls setObservationEmbedding.
   */
  addObservation(
    text: string,
    modelNames: string[],
    source = 'direct',
    embedding?: number[],
  ): AddObservationResult {
    if (modelNames.length === 0) return { ok: false, unknown: [] };

    const found = this.sql
      .exec(`SELECT id, name FROM models WHERE name IN (${placeholders(modelNames.length)})`, ...modelNames)
      .toArray() as Array<{ id: string; name: string }>;
    const idByName = new Map(found.map(m => [m.name, m.id]));
    const unknown = modelNames.filter(n => !idByName.has(n));
    if (unknown.length > 0) return { ok: false, unknown };

    if (this.hasSimilarRecentObservation(text)) {
      return { ok: true, id: '', tagged: [], deduped: true };
    }

    const id = crypto.randomUUID();
    const timestamp = Date.now();
    const blob = embedding ? floatsToBlob(normalizeVec(embedding)) : null;
    this.sql.exec(
      'INSERT INTO observations (id, text, timestamp, source, embedding) VALUES (?, ?, ?, ?, ?)',
      id, text, timestamp, source, blob,
    );
    for (const name of modelNames) {
      this.sql.exec(
        'INSERT OR IGNORE INTO observation_tags (observation_id, model_id) VALUES (?, ?)',
        id, idByName.get(name)!,
      );
    }
    return { ok: true, id, tagged: modelNames };
  }

  /**
   * Bulk import for seeding/migration. Preserves each observation's ORIGINAL
   * timestamp (unlike addObservation, which stamps now) and skips dedup. Upserts
   * models, inserts observations with normalized embeddings, and applies tags.
   */
  bulkLoad(
    models: Array<{ name: string; description: string }>,
    observations: Array<{ text: string; timestamp: number; models: string[]; embedding?: number[] }>,
  ): { models: number; observations: number; tags: number } {
    for (const m of models) this.createModel(m.name, m.description);
    const idByName = new Map(this.listModels(true).map(m => [m.name, m.id]));
    let oCount = 0, tCount = 0;
    for (const o of observations) {
      const id = crypto.randomUUID();
      const blob = o.embedding ? floatsToBlob(normalizeVec(o.embedding)) : null;
      this.sql.exec('INSERT INTO observations (id, text, timestamp, source, embedding) VALUES (?, ?, ?, ?, ?)', id, o.text, o.timestamp, 'direct', blob);
      oCount++;
      for (const name of o.models) {
        const mid = idByName.get(name);
        if (mid) { this.sql.exec('INSERT OR IGNORE INTO observation_tags (observation_id, model_id) VALUES (?, ?)', id, mid); tCount++; }
      }
    }
    return { models: models.length, observations: oCount, tags: tCount };
  }

  setObservationEmbedding(observationId: string, embedding: number[]): void {
    this.sql.exec('UPDATE observations SET embedding = ? WHERE id = ?', floatsToBlob(normalizeVec(embedding)), observationId);
  }

  setSummaryEmbedding(summaryId: string, embedding: number[]): void {
    this.sql.exec('UPDATE summaries SET embedding = ? WHERE id = ?', floatsToBlob(normalizeVec(embedding)), summaryId);
  }

  /** Add a model tag to an existing observation (no-op if already tagged). */
  tagObservation(observationId: string, modelId: string): void {
    this.sql.exec('INSERT OR IGNORE INTO observation_tags (observation_id, model_id) VALUES (?, ?)', observationId, modelId);
  }

  /** Observation ids that still need an embedding (for backfill / seeding). */
  idsMissingEmbedding(limit = 500): Array<{ id: string; text: string }> {
    return this.sql
      .exec('SELECT id, text FROM observations WHERE embedding IS NULL ORDER BY timestamp ASC LIMIT ?', limit)
      .toArray() as Array<{ id: string; text: string }>;
  }

  /**
   * Brute-force cosine search over all embedded observations, blended with a
   * 30-day-half-life recency penalty (lower score = better). Vectors are stored
   * pre-normalized, so cosine similarity is a plain dot product. Fine for the
   * single-DO scale we target; revisit with Vectorize only if it gets slow.
   */
  searchObservations(query: number[], limit = 20, timeWeight = 0.3, includeSummaries = true): ObservationMatch[] {
    const q = normalizeVec(query);
    const now = Date.now();
    const score = (v: ArrayBuffer, ts: number) => {
      const sim = dot(q, blobToFloats(v)); // both unit-length → cosine similarity
      return (1 - sim) * (1 - timeWeight) + computeTimePenalty(ts, now) * timeWeight;
    };
    const obs = this.sql
      .exec('SELECT id, text, timestamp, embedding FROM observations WHERE embedding IS NOT NULL')
      .toArray() as Array<{ id: string; text: string; timestamp: number; embedding: ArrayBuffer }>;
    const scored: ObservationMatch[] = obs.map(r => ({ id: r.id, text: r.text, timestamp: r.timestamp, score: score(r.embedding, r.timestamp), kind: 'observation' as const }));

    if (includeSummaries) {
      // Arcs, not just receipts: summaries are searchable too. Recency uses the
      // summary's end timestamp — the newest material it covers.
      const sums = this.sql
        .exec('SELECT id, text, tier, start_timestamp, end_timestamp, obs_count, embedding FROM summaries WHERE embedding IS NOT NULL')
        .toArray() as Array<{ id: string; text: string; tier: number; start_timestamp: number; end_timestamp: number; obs_count: number | null; embedding: ArrayBuffer }>;
      for (const s of sums) {
        scored.push({ id: s.id, text: s.text, timestamp: s.end_timestamp, score: score(s.embedding, s.end_timestamp), kind: 'summary', tier: s.tier, startTimestamp: s.start_timestamp, obsCount: s.obs_count ?? undefined });
      }
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, limit);
  }

  /** Prefix-match dedup against observations from the last 24h. */
  private hasSimilarRecentObservation(text: string): boolean {
    const cutoff = Date.now() - DEDUP_WINDOW_MS;
    const prefix = text.substring(0, DEDUP_PREFIX_CHARS).toLowerCase().trim();
    const recent = this.sql
      .exec('SELECT text FROM observations WHERE timestamp >= ? ORDER BY timestamp DESC', cutoff)
      .toArray() as Array<{ text: string }>;
    return recent.some(o => o.text.substring(0, DEDUP_PREFIX_CHARS).toLowerCase().trim() === prefix);
  }

  /**
   * A model's observations, newest first. `afterTs` (exclusive) restricts to
   * observations newer than that timestamp. (The read path's verbatim tail is
   * provenance-based — see listTailForModel; this is the plain listing.)
   */
  listObservationsForModel(modelId: string, limit = 200, afterTs = 0): ObservationRow[] {
    const rows = this.sql.exec(
      `SELECT o.id, o.text, o.timestamp, o.source
       FROM observations o
       JOIN observation_tags t ON t.observation_id = o.id
       WHERE t.model_id = ? AND o.timestamp > ?
       ORDER BY o.timestamp DESC, o.rowid DESC
       LIMIT ?`,
      modelId, afterTs, limit,
    ).toArray() as Array<Record<string, unknown>>;
    return rows.map(toObservationRow);
  }

  // ---------- Pyramid: provenance queries ----------

  /**
   * The model's COVER: summaries (any tier) that have not been rolled into a
   * higher summary. Together with the unsummarized tail this partitions the
   * model's history exactly, by provenance. Chronological by start.
   */
  listSummariesForModel(modelId: string): SummaryRow[] {
    const cover = this.sql.exec(
      `SELECT s.id, s.tier, s.text, s.start_timestamp, s.end_timestamp, s.source_count, s.obs_count, s.source_chars
       FROM summaries s
       WHERE s.model_id = ?
         AND NOT EXISTS (SELECT 1 FROM summary_sources up WHERE up.source_type = 'summary' AND up.source_id = s.id)
       ORDER BY s.start_timestamp ASC, s.tier ASC`,
      modelId,
    ).toArray() as Array<Record<string, unknown>>;
    return cover.map(toSummaryRow);
  }

  /** Every summary of a model, all tiers, whether or not rolled up. For export and stats. */
  listAllSummariesForModel(modelId: string): SummaryRow[] {
    const rows = this.sql.exec(
      `SELECT id, tier, text, start_timestamp, end_timestamp, source_count, obs_count, source_chars FROM summaries WHERE model_id = ? ORDER BY tier ASC, start_timestamp ASC`,
      modelId,
    ).toArray() as Array<Record<string, unknown>>;
    return rows.map(toSummaryRow);
  }

  /** Sources of one summary (observation ids for tier 0, summary ids above). */
  listSummarySources(summaryId: string): SummarySource[] {
    return (this.sql.exec('SELECT source_type AS type, source_id AS id FROM summary_sources WHERE summary_id = ?', summaryId)
      .toArray() as unknown as SummarySource[]);
  }

  /**
   * Observations tagged to the model that no tier-0 summary OF THIS MODEL has
   * consumed. Oldest first. Exact by provenance — an observation tagged to two
   * models is unsummarized for each independently.
   */
  unsummarizedObservations(modelId: string, limit = 100_000): ObservationRow[] {
    const rows = this.sql.exec(
      `SELECT o.id, o.text, o.timestamp, o.source
       FROM observations o
       JOIN observation_tags t ON t.observation_id = o.id
       WHERE t.model_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM summary_sources ss JOIN summaries s ON s.id = ss.summary_id
           WHERE ss.source_type = 'observation' AND ss.source_id = o.id AND s.model_id = ?
         )
       ORDER BY o.timestamp ASC, o.rowid ASC
       LIMIT ?`,
      modelId, modelId, limit,
    ).toArray() as Array<Record<string, unknown>>;
    return rows.map(toObservationRow);
  }

  /** Tier-N summaries of the model not yet rolled into tier N+1. Oldest first. */
  unrolledSummaries(modelId: string, tier: number): SummaryRow[] {
    const rows = this.sql.exec(
      `SELECT s.id, s.tier, s.text, s.start_timestamp, s.end_timestamp, s.source_count, s.obs_count, s.source_chars
       FROM summaries s
       WHERE s.model_id = ? AND s.tier = ?
         AND NOT EXISTS (SELECT 1 FROM summary_sources up WHERE up.source_type = 'summary' AND up.source_id = s.id)
       ORDER BY s.start_timestamp ASC`,
      modelId, tier,
    ).toArray() as Array<Record<string, unknown>>;
    return rows.map(toSummaryRow);
  }

  /** The verbatim tail for the read path: the model's newest unsummarized observations, newest first. */
  listTailForModel(modelId: string, limit: number): ObservationRow[] {
    return this.unsummarizedObservations(modelId).slice(-limit).reverse();
  }

  /**
   * What load_memory renders for a model: the cover, plus a RESOLUTION RAMP so
   * the recent past is never flatter than `ramp` tiles per tier and the last
   * `verbatim` observations are always shown raw — even when a higher tile
   * already covers them. Without the ramp the view collapses at a clean batch
   * boundary (250 observations = one tier-2 summary and nothing else) and
   * oscillates with count; the ramp is deliberate duplication at render time,
   * the way Angel's stream pyramid does it. Storage stays exact-once. Ramp rows
   * carry `covered: true` so the formatter can say so.
   */
  listViewForModel(modelId: string, opts: { ramp?: number; verbatim?: number; tailLimit?: number } = {}): { summaries: SummaryRow[]; observations: ObservationRow[] } {
    const ramp = opts.ramp ?? 2, verbatim = opts.verbatim ?? 5, tailLimit = opts.tailLimit ?? 15;
    const cover = this.listSummariesForModel(modelId);
    const top = cover.reduce((mx, s) => Math.max(mx, s.tier), -1);
    const summaries: SummaryRow[] = [...cover];
    for (let tier = 0; tier < top; tier++) {
      const rows = this.sql.exec(
        `SELECT s.id, s.tier, s.text, s.start_timestamp, s.end_timestamp, s.source_count, s.obs_count, s.source_chars
         FROM summaries s
         WHERE s.model_id = ? AND s.tier = ?
           AND EXISTS (SELECT 1 FROM summary_sources up WHERE up.source_type = 'summary' AND up.source_id = s.id)
         ORDER BY s.start_timestamp DESC LIMIT ?`,
        modelId, tier, ramp,
      ).toArray() as Array<Record<string, unknown>>;
      summaries.push(...rows.map(r => ({ ...toSummaryRow(r), covered: true })));
    }
    const tail = this.listTailForModel(modelId, tailLimit); // newest first
    const observations: ObservationRow[] = [...tail];
    const need = verbatim - tail.length;
    if (top >= 0 && need > 0) {
      const rows = this.sql.exec(
        `SELECT o.id, o.text, o.timestamp, o.source
         FROM observations o JOIN observation_tags t ON t.observation_id = o.id
         WHERE t.model_id = ?
           AND EXISTS (SELECT 1 FROM summary_sources ss JOIN summaries s ON s.id = ss.summary_id
                       WHERE ss.source_type = 'observation' AND ss.source_id = o.id AND s.model_id = ?)
         ORDER BY o.timestamp DESC, o.rowid DESC LIMIT ?`,
        modelId, modelId, need,
      ).toArray() as Array<Record<string, unknown>>;
      observations.push(...rows.map(r => ({ ...toObservationRow(r), covered: true })));
    }
    return { summaries, observations };
  }

  /**
   * Insert one summary with its provenance rows (required — a summary without
   * sources is invalid). Embeds the text (best effort) so it's recallable; a
   * failed embed is backfilled by reembedBatch.
   */
  async insertSummary(
    modelId: string,
    s: { tier: number; text: string; startTimestamp: number; endTimestamp: number; sourceCount: number },
    sources: SummarySource[],
  ): Promise<string> {
    if (sources.length === 0) throw new Error('insertSummary: a summary must have at least one source');
    const id = crypto.randomUUID();
    let blob: Uint8Array | null = null;
    if (!this.getConfig('synth_stub')) {
      try { blob = floatsToBlob(normalizeVec(await this.embed(s.text))); }
      catch (e) { console.error('[insertSummary] embed failed, storing without vector:', e); }
    }
    // Transitive provenance stats: raw observations (and their chars) behind
    // this summary through all tiers. Summaries are immutable, so compute once.
    const ids = sources.map(src => src.id);
    let obsCount = sources.length;
    let sourceChars = 0;
    if (sources[0]!.type === 'observation') {
      sourceChars = (this.sql.exec(
        `SELECT COALESCE(SUM(LENGTH(text)), 0) AS c FROM observations WHERE id IN (${placeholders(ids.length)})`, ...ids,
      ).one() as { c: number }).c;
    } else {
      const row = this.sql.exec(
        `SELECT COALESCE(SUM(obs_count), 0) AS n, COALESCE(SUM(source_chars), 0) AS c FROM summaries WHERE id IN (${placeholders(ids.length)})`, ...ids,
      ).one() as { n: number; c: number };
      obsCount = row.n;
      sourceChars = row.c;
    }
    this.sql.exec(
      'INSERT INTO summaries (id, model_id, tier, text, start_timestamp, end_timestamp, source_count, is_dirty, embedding, obs_count, source_chars) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)',
      id, modelId, s.tier, s.text, s.startTimestamp, s.endTimestamp, s.sourceCount, blob, obsCount, sourceChars,
    );
    for (const src of sources) {
      this.sql.exec('INSERT OR IGNORE INTO summary_sources (summary_id, source_type, source_id) VALUES (?, ?, ?)', id, src.type, src.id);
    }
    return id;
  }

  private getModelById(id: string): ModelRow | undefined {
    const row = this.sql
      .exec('SELECT id, name, description, is_seed, archived, created_at FROM models WHERE id = ?', id)
      .toArray()[0] as Record<string, unknown> | undefined;
    return row ? toModelRow(row) : undefined;
  }

  // ---------- Pyramid: growth ----------

  /** In-flight advance per model. A second caller awaits the running one and reports `remaining` — no double work, no hot loop. */
  private advancing = new Map<string, Promise<AdvanceResult>>();

  /**
   * Grow a model's pyramid incrementally: summarize FULL tier-0 batches of
   * unsummarized observations, rolling up as soon as any tier has
   * ROLLUP_FAN_IN unrolled summaries (so the cover stays narrow even while a
   * backlog is being worked off). At most `maxCalls` LLM calls per invocation
   * so a request-path trigger stays bounded; returns whether work remains.
   * Each summary is inserted with its provenance before the next call starts,
   * so a failure mid-run leaves a valid (partially advanced) state and the next
   * trigger resumes. Never rewrites existing summaries.
   */
  async advancePyramid(modelId: string, opts: { maxCalls?: number } = {}): Promise<AdvanceResult> {
    const inflight = this.advancing.get(modelId);
    if (inflight) {
      await inflight.catch(() => undefined);
      return { tier0: 0, rollups: 0, remaining: true };
    }
    const run = this.advanceInner(modelId, opts);
    this.advancing.set(modelId, run);
    try { return await run; } finally { this.advancing.delete(modelId); }
  }

  private async advanceInner(modelId: string, opts: { maxCalls?: number }): Promise<AdvanceResult> {
    const maxCalls = opts.maxCalls ?? Number.POSITIVE_INFINITY;
    const result: AdvanceResult = { tier0: 0, rollups: 0, remaining: false };
    const model = this.getModelById(modelId);
    if (!model) return result;
    let calls = 0;

    // Roll up every tier that has a full batch, climbing. Returns true if the
    // call budget ran out with work still pending.
    const rollupPass = async (): Promise<boolean> => {
      for (let tier = 0; tier < 50; tier++) {
        const groups = batchRollup(this.unrolledSummaries(modelId, tier));
        if (groups.length === 0) {
          if (!this.hasSummariesAtTier(modelId, tier + 1)) return false; // no tier above — done
          continue;
        }
        for (const children of groups) {
          if (calls >= maxCalls) return true;
          const job = buildRollupJob(model, children);
          const text = checkSynthOutput(await this.runSynth(job)); calls++;
          await this.insertSummary(modelId, { tier: job.tier, text, startTimestamp: job.startTs, endTimestamp: job.endTs, sourceCount: children.length },
            job.sourceIds.map(id => ({ type: 'summary' as const, id })));
          result.rollups++;
        }
      }
      return false;
    };

    // Tier 0: full batches only; the trailing partial batch stays verbatim.
    const { batches } = batchTier0(this.unsummarizedObservations(modelId));
    for (const batch of batches) {
      if (calls >= maxCalls) { result.remaining = true; return result; }
      const job = buildTier0Job(model, batch);
      const text = checkSynthOutput(await this.runSynth(job)); calls++;
      await this.insertSummary(modelId, { tier: 0, text, startTimestamp: job.startTs, endTimestamp: job.endTs, sourceCount: job.sourceIds.length },
        job.sourceIds.map(id => ({ type: 'observation' as const, id })));
      result.tier0++;
      if (await rollupPass()) { result.remaining = true; return result; }
    }
    if (await rollupPass()) { result.remaining = true; return result; }
    return result;
  }

  private hasSummariesAtTier(modelId: string, tier: number): boolean {
    return (this.sql.exec('SELECT COUNT(*) AS c FROM summaries WHERE model_id = ? AND tier = ?', modelId, tier).one() as { c: number }).c > 0;
  }

  /**
   * Advance every model, archived included (their observations are still part
   * of the record), sequentially — one DO, one LLM at a time is plenty. For the
   * admin catch-up loop. A synthesis failure on one model is reported in
   * `perModel[name].error` and the sweep continues; `remaining` stays true so
   * the loop retries it.
   */
  async advanceAll(opts: { maxCalls?: number; model?: string } = {}): Promise<{ models: number; tier0: number; rollups: number; remaining: boolean; perModel: Record<string, AdvanceResult & { error?: string }> }> {
    const models = opts.model ? [this.getModel(opts.model)].filter((m): m is ModelRow => !!m) : this.listModels(true);
    let budget = opts.maxCalls ?? Number.POSITIVE_INFINITY;
    const out = { models: models.length, tier0: 0, rollups: 0, remaining: false, perModel: {} as Record<string, AdvanceResult & { error?: string }> };
    for (const m of models) {
      if (budget <= 0) { out.remaining = true; break; }
      try {
        const r = await this.advancePyramid(m.id, { maxCalls: budget });
        budget -= r.tier0 + r.rollups;
        out.tier0 += r.tier0; out.rollups += r.rollups;
        out.remaining = out.remaining || r.remaining;
        out.perModel[m.name] = r;
      } catch (e) {
        console.error(`[advanceAll] ${m.name} failed:`, e);
        out.perModel[m.name] = { tier0: 0, rollups: 0, remaining: true, error: String(e) };
        out.remaining = true;
      }
    }
    return out;
  }

  /**
   * Delete one model's summaries and their provenance so its pyramid regrows
   * from the observations. The surgical undo for a bad synthesis run; the
   * observations are untouched. Admin-only, requires confirm at the endpoint.
   */
  unsummarizeModel(name: string): { ok: boolean; reason?: string; summaries?: number } {
    const m = this.getModel(name);
    if (!m) return { ok: false, reason: `No model named "${name}".` };
    const n = (this.sql.exec('SELECT COUNT(*) AS c FROM summaries WHERE model_id = ?', m.id).one() as { c: number }).c;
    this.sql.exec('DELETE FROM summary_sources WHERE summary_id IN (SELECT id FROM summaries WHERE model_id = ?)', m.id);
    this.sql.exec('DELETE FROM summaries WHERE model_id = ?', m.id);
    return { ok: true, summaries: n };
  }

  /**
   * Request-path trigger (record_observation / load_memory). Advances each
   * named model a bounded number of LLM calls in the background; a no-op in
   * the common case (two indexed queries). Failures are swallowed so recording
   * and loading never fail on synthesis.
   */
  async maybeResummarize(modelNames: string[], maxCalls = 4): Promise<string[]> {
    const advanced: string[] = [];
    for (const name of modelNames) {
      const m = this.getModel(name);
      if (!m) continue;
      try {
        const r = await this.advancePyramid(m.id, { maxCalls });
        if (r.tier0 + r.rollups > 0) advanced.push(name);
      } catch (e) { console.error(`[advance] ${name} failed:`, e); }
    }
    return advanced;
  }

  /**
   * Recency-first across all models — the short-term continuity substitute:
   * simply the newest observations, whether or not a pyramid has covered them.
   * (It used to exclude covered ones, which made the block thin whenever
   * several models had just crossed a batch boundary — the same cliff the
   * per-model ramp fixes. The block is capped by characters at render time.)
   */
  recentObservations(limit = 30): ObservationRow[] {
    const rows = this.sql.exec(
      'SELECT id, text, timestamp, source FROM observations ORDER BY timestamp DESC, rowid DESC LIMIT ?',
      limit,
    ).toArray() as Array<Record<string, unknown>>;
    return rows.map(toObservationRow);
  }

  // ---------- Confidence / stats ----------

  getModelConfidence(modelId: string): { obsCount: number; earliest: number | null; latest: number | null } {
    const row = this.sql.exec(
      `SELECT COUNT(*) AS c, MIN(o.timestamp) AS earliest, MAX(o.timestamp) AS latest
       FROM observation_tags t JOIN observations o ON o.id = t.observation_id
       WHERE t.model_id = ?`,
      modelId,
    ).one() as { c: number; earliest: number | null; latest: number | null };
    return { obsCount: row.c, earliest: row.earliest, latest: row.latest };
  }

  // ---------- Maintenance (cron-less; the agent calls these in-conversation) ----------

  /** Archive a model (drops from the index; observations + summaries frozen). Seeds protected. */
  archiveModel(name: string): { ok: boolean; reason?: string } {
    if (isProtectedSeed(name)) return { ok: false, reason: `"${name}" is a protected seed model and can't be archived.` };
    const m = this.getModel(name);
    if (!m) return { ok: false, reason: `No model named "${name}".` };
    this.sql.exec('UPDATE models SET archived = 1 WHERE id = ?', m.id);
    return { ok: true };
  }

  /** Rename a model (observations follow via model_id). Seeds protected; target must be free. */
  renameModel(oldName: string, newName: string): { ok: boolean; reason?: string } {
    if (isProtectedSeed(oldName)) return { ok: false, reason: `"${oldName}" is a protected seed model and can't be renamed.` };
    const m = this.getModel(oldName);
    if (!m) return { ok: false, reason: `No model named "${oldName}".` };
    if (this.getModel(newName)) return { ok: false, reason: `A model named "${newName}" already exists.` };
    this.sql.exec('UPDATE models SET name = ? WHERE id = ?', newName, m.id);
    return { ok: true };
  }

  /**
   * Fold one model into another: record a synthesis observation (timestamped now,
   * summarizing the source) tagged to the target, then archive the source. Source
   * seeds are protected. Reinforcement is intentional — the synthesis lands in the
   * target's recent tier.
   */
  foldModel(source: string, into: string, synthesis: string, embedding?: number[]): { ok: boolean; reason?: string } {
    if (isProtectedSeed(source)) return { ok: false, reason: `"${source}" is a protected seed model and can't be folded away.` };
    const s = this.getModel(source);
    const t = this.getModel(into);
    if (!s) return { ok: false, reason: `No model named "${source}".` };
    if (!t) return { ok: false, reason: `No model named "${into}".` };
    const id = crypto.randomUUID();
    const blob = embedding ? floatsToBlob(normalizeVec(embedding)) : null;
    this.sql.exec('INSERT INTO observations (id, text, timestamp, source, embedding) VALUES (?, ?, ?, ?, ?)', id, synthesis, Date.now(), 'fold', blob);
    this.sql.exec('INSERT OR IGNORE INTO observation_tags (observation_id, model_id) VALUES (?, ?)', id, t.id);
    this.sql.exec('UPDATE models SET archived = 1 WHERE id = ?', s.id);
    return { ok: true };
  }

  /**
   * Fragmentation signal for the defrag hint. Counts active models and how many
   * (non-seed) are under-populated. (Centroid-similarity dedup is a later
   * refinement; this cheap version drives the in-conversation nudge.)
   */
  computeFragmentation(): { activeModels: number; underPopulated: number; fragmented: boolean } {
    const FLOOR = 5;
    const models = this.listModels();
    let under = 0;
    for (const m of models) {
      if (isProtectedSeed(m.name)) continue;
      if (this.getModelConfidence(m.id).obsCount < FLOOR) under++;
    }
    return { activeModels: models.length, underPopulated: under, fragmented: under >= 6 || models.length > 40 };
  }

  getStats(): { models: number; observations: number; summaries: number; embedded: number; summariesEmbedded: number; embeddingDim: number; observationSize: SizeStats; summarySize: SizeStats; perModel: ModelStats[] } {
    // Blob byte length / 4 (Float32) = vector dimension. Lets a migration check
    // distinguish old 1536-dim (OpenAI) data from new 1024-dim (bge-m3).
    const dimRow = this.sql.exec('SELECT LENGTH(embedding) AS b FROM observations WHERE embedding IS NOT NULL LIMIT 1').toArray()[0] as { b: number } | undefined;
    return {
      models: this.sql.exec('SELECT COUNT(*) AS c FROM models WHERE archived = 0').one().c as number,
      observations: this.sql.exec('SELECT COUNT(*) AS c FROM observations').one().c as number,
      summaries: this.sql.exec('SELECT COUNT(*) AS c FROM summaries').one().c as number,
      embedded: this.sql.exec('SELECT COUNT(*) AS c FROM observations WHERE embedding IS NOT NULL').one().c as number,
      summariesEmbedded: this.sql.exec('SELECT COUNT(*) AS c FROM summaries WHERE embedding IS NOT NULL').one().c as number,
      embeddingDim: dimRow ? dimRow.b / 4 : 0,
      observationSize: this.sizeStats('observations'),
      summarySize: this.sizeStats('summaries'),
      perModel: this.perModelStats(),
    };
  }

  /**
   * Read-only export of one model: row, every summary (all tiers, with
   * provenance), every observation (oldest first, no embeddings), and the
   * unsummarized tail ids. The verification tool for the pyramid.
   */
  exportModel(name: string): { model: ModelRow; summaries: Array<SummaryRow & { sources: SummarySource[] }>; observations: ObservationRow[]; unsummarized: string[] } | undefined {
    const model = this.getModel(name);
    if (!model) return undefined;
    return {
      model,
      summaries: this.listAllSummariesForModel(model.id).map(s => ({ ...s, sources: this.listSummarySources(s.id) })),
      observations: this.listObservationsForModel(model.id, 100_000).reverse(),
      unsummarized: this.unsummarizedObservations(model.id).map(o => o.id),
    };
  }

  /** One row per model (active and archived), biggest first: observation + summary counts, sizes, tier depth, time span. */
  private perModelStats(): ModelStats[] {
    const rows = this.sql.exec(
      `SELECT m.id, m.name, m.is_seed, m.archived, m.created_at,
              (SELECT COUNT(*) FROM observation_tags t WHERE t.model_id = m.id) AS obs,
              (SELECT COALESCE(SUM(LENGTH(o.text)), 0) FROM observation_tags t JOIN observations o ON o.id = t.observation_id WHERE t.model_id = m.id) AS obs_chars,
              (SELECT MIN(o.timestamp) FROM observation_tags t JOIN observations o ON o.id = t.observation_id WHERE t.model_id = m.id) AS earliest,
              (SELECT MAX(o.timestamp) FROM observation_tags t JOIN observations o ON o.id = t.observation_id WHERE t.model_id = m.id) AS latest,
              (SELECT COUNT(*) FROM summaries s WHERE s.model_id = m.id) AS sums,
              (SELECT COALESCE(SUM(LENGTH(s.text)), 0) FROM summaries s WHERE s.model_id = m.id) AS sum_chars,
              (SELECT COALESCE(MAX(s.tier), -1) FROM summaries s WHERE s.model_id = m.id) AS top_tier,
              (SELECT COUNT(*) FROM observation_tags t WHERE t.model_id = m.id AND NOT EXISTS (
                 SELECT 1 FROM summary_sources ss JOIN summaries s ON s.id = ss.summary_id
                 WHERE ss.source_type = 'observation' AND ss.source_id = t.observation_id AND s.model_id = m.id)) AS unsummarized,
              (SELECT COALESCE(SUM(LENGTH(o.text)), 0) FROM observation_tags t JOIN observations o ON o.id = t.observation_id
                 WHERE t.model_id = m.id AND NOT EXISTS (
                 SELECT 1 FROM summary_sources ss JOIN summaries s ON s.id = ss.summary_id
                 WHERE ss.source_type = 'observation' AND ss.source_id = o.id AND s.model_id = m.id)) AS tail_chars,
              (SELECT COUNT(*) FROM summaries s WHERE s.model_id = m.id AND NOT EXISTS (
                 SELECT 1 FROM summary_sources up WHERE up.source_type = 'summary' AND up.source_id = s.id)) AS cover_count,
              (SELECT COALESCE(SUM(LENGTH(s.text)), 0) FROM summaries s WHERE s.model_id = m.id AND NOT EXISTS (
                 SELECT 1 FROM summary_sources up WHERE up.source_type = 'summary' AND up.source_id = s.id)) AS cover_chars
       FROM models m
       ORDER BY obs DESC, m.name`,
    ).toArray() as Array<{ id: string; name: string; is_seed: number; archived: number; created_at: number; obs: number; obs_chars: number; earliest: number | null; latest: number | null; sums: number; sum_chars: number; top_tier: number; unsummarized: number; tail_chars: number; cover_count: number; cover_chars: number }>;
    return rows.map(r => ({
      name: r.name,
      seed: r.is_seed === 1,
      archived: r.archived === 1,
      createdAt: r.created_at,
      observations: r.obs,
      observationChars: r.obs_chars,
      observationTokens: Math.round(r.obs_chars / 4),
      meanObservationChars: r.obs ? Math.round(r.obs_chars / r.obs) : 0,
      earliest: r.earliest,
      latest: r.latest,
      summaries: r.sums,
      summaryChars: r.sum_chars,
      summaryTokens: Math.round(r.sum_chars / 4),
      topTier: r.top_tier,
      unsummarized: r.unsummarized,
      coverSummaries: r.cover_count,
      coverChars: r.cover_chars,
      tailChars: r.tail_chars,
      ...this.viewSize(r.id),
    }));
  }

  /** What load_memory would render for a model (cover + ramp + tail), measured on the real view. */
  private viewSize(modelId: string): { viewSummaries: number; viewObservations: number; viewChars: number; viewTokens: number } {
    const v = this.listViewForModel(modelId);
    const chars = v.summaries.reduce((n, s) => n + s.text.length, 0) + v.observations.reduce((n, o) => n + o.text.length, 0);
    return { viewSummaries: v.summaries.length, viewObservations: v.observations.length, viewChars: chars, viewTokens: Math.round(chars / 4) };
  }

  /** Text-length distribution for a table with a `text` column. Tokens are a chars/4 estimate. */
  private sizeStats(table: 'observations' | 'summaries'): SizeStats {
    const lens = (this.sql.exec(`SELECT LENGTH(text) AS n FROM ${table} ORDER BY n`).toArray() as Array<{ n: number }>).map(r => r.n);
    if (lens.length === 0) return { count: 0, minChars: 0, maxChars: 0, meanChars: 0, medianChars: 0, totalChars: 0, minTokens: 0, maxTokens: 0, meanTokens: 0, medianTokens: 0, totalTokens: 0 };
    const total = lens.reduce((a, b) => a + b, 0);
    const mid = lens.length >> 1;
    const median = lens.length % 2 ? lens[mid]! : (lens[mid - 1]! + lens[mid]!) / 2;
    const tok = (c: number) => Math.round(c / 4);
    const mean = Math.round(total / lens.length);
    return {
      count: lens.length,
      minChars: lens[0]!, maxChars: lens[lens.length - 1]!, meanChars: mean, medianChars: Math.round(median), totalChars: total,
      minTokens: tok(lens[0]!), maxTokens: tok(lens[lens.length - 1]!), meanTokens: tok(mean), medianTokens: tok(median), totalTokens: tok(total),
    };
  }

  /**
   * Wipe ALL of this user's memory and restore the cold-start seed models.
   * Destructive and irreversible — used by the token-gated /admin/reset for the
   * embedding-space migration (old 1536-dim data can't be queried by 1024-dim
   * bge-m3 vectors, so it has to be cleared and re-seeded).
   */
  resetMemory(): { cleared: true } {
    this.sql.exec('DELETE FROM observation_tags');
    this.sql.exec('DELETE FROM observations');
    this.sql.exec('DELETE FROM summary_sources');
    this.sql.exec('DELETE FROM summaries');
    this.sql.exec('DELETE FROM models');
    this.sql.exec('DELETE FROM config');
    this.ensureSeedModels();
    return { cleared: true };
  }
}

export interface ModelStats {
  name: string; seed: boolean; archived: boolean; createdAt: number;
  observations: number; observationChars: number; observationTokens: number; meanObservationChars: number;
  earliest: number | null; latest: number | null;
  summaries: number; summaryChars: number; summaryTokens: number; topTier: number;
  unsummarized: number;
  coverSummaries: number; coverChars: number; tailChars: number;
  viewSummaries: number; viewObservations: number; viewChars: number; viewTokens: number;
}

function toSummaryRow(r: Record<string, unknown>): SummaryRow {
  return {
    id: r.id as string,
    tier: r.tier as number,
    text: r.text as string,
    startTimestamp: r.start_timestamp as number,
    endTimestamp: r.end_timestamp as number,
    sourceCount: r.source_count as number,
    obsCount: (r.obs_count as number | null) ?? undefined,
    sourceChars: (r.source_chars as number | null) ?? undefined,
  };
}

export interface SizeStats {
  count: number;
  minChars: number; maxChars: number; meanChars: number; medianChars: number; totalChars: number;
  minTokens: number; maxTokens: number; meanTokens: number; medianTokens: number; totalTokens: number;
}

// ---------- helpers ----------

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}

function toModelRow(r: Record<string, unknown>): ModelRow {
  return {
    id: r.id as string,
    name: r.name as string,
    description: (r.description as string | null) ?? null,
    isSeed: Boolean(r.is_seed),
    archived: Boolean(r.archived),
    createdAt: r.created_at as number,
  };
}

function toObservationRow(r: Record<string, unknown>): ObservationRow {
  return {
    id: r.id as string,
    text: r.text as string,
    timestamp: r.timestamp as number,
    source: r.source as string,
  };
}

/** L2-normalize a vector so cosine similarity reduces to a dot product. */
export function normalizeVec(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  if (n === 0) return v.slice();
  return v.map(x => x / n);
}

function dot(a: number[], b: Float32Array): number {
  let s = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) s += a[i]! * b[i]!;
  return s;
}

/** 0 (just now) → 1 (ancient). 30-day half-life. Null timestamp → 0.5. */
function computeTimePenalty(timestampMs: number | null, now: number): number {
  if (timestampMs === null) return 0.5;
  const ageDays = (now - timestampMs) / 86_400_000;
  const decayRate = Math.log(2) / TIME_DECAY_HALF_LIFE_DAYS;
  return 1 - Math.exp(-ageDays * decayRate);
}

/** Float vector → bytes for BLOB storage. */
export function floatsToBlob(v: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(v).buffer);
}

/** BLOB bytes → Float32Array (for cosine search in Task #3). */
export function blobToFloats(blob: ArrayBuffer | Uint8Array): Float32Array {
  const buf = blob instanceof Uint8Array ? blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength) : blob;
  return new Float32Array(buf);
}
