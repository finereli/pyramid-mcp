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
import { bucketObservations, buildSynthJob } from './pyramid.js';

export interface Env {
  MEMORY_DO: DurableObjectNamespace<MemoryDO>;
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
}

export interface SummaryRow {
  id: string;
  tier: number;
  text: string;
  startTimestamp: number;
  endTimestamp: number;
  sourceCount: number;
}

export type AddObservationResult =
  | { ok: true; id: string; tagged: string[]; deduped?: boolean }
  | { ok: false; unknown: string[] };

export interface ObservationMatch {
  id: string;
  text: string;
  timestamp: number;
  score: number; // lower = better (cosine distance blended with time penalty)
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
    `);
    // Add columns introduced after the initial schema, for DOs created earlier.
    try { this.sql.exec('ALTER TABLE models ADD COLUMN last_summarized_count INTEGER NOT NULL DEFAULT 0'); } catch { /* already present */ }
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
  searchObservations(query: number[], limit = 20, timeWeight = 0.3): ObservationMatch[] {
    const q = normalizeVec(query);
    const now = Date.now();
    const rows = this.sql
      .exec('SELECT id, text, timestamp, embedding FROM observations WHERE embedding IS NOT NULL')
      .toArray() as Array<{ id: string; text: string; timestamp: number; embedding: ArrayBuffer }>;

    const scored: ObservationMatch[] = rows.map(r => {
      const v = blobToFloats(r.embedding);
      const sim = dot(q, v); // both unit-length → cosine similarity
      const distance = 1 - sim;
      const timePenalty = computeTimePenalty(r.timestamp, now);
      const score = distance * (1 - timeWeight) + timePenalty * timeWeight;
      return { id: r.id, text: r.text, timestamp: r.timestamp, score };
    });
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

  listObservationsForModel(modelId: string, limit = 200): ObservationRow[] {
    const rows = this.sql.exec(
      `SELECT o.id, o.text, o.timestamp, o.source
       FROM observations o
       JOIN observation_tags t ON t.observation_id = o.id
       WHERE t.model_id = ?
       ORDER BY o.timestamp DESC
       LIMIT ?`,
      modelId, limit,
    ).toArray() as Array<Record<string, unknown>>;
    return rows.map(toObservationRow);
  }

  /** Tiered summaries for a model, oldest tier first (populated by Task #6). */
  listSummariesForModel(modelId: string): SummaryRow[] {
    const rows = this.sql.exec(
      `SELECT id, tier, text, start_timestamp, end_timestamp, source_count
       FROM summaries WHERE model_id = ? ORDER BY tier ASC, start_timestamp ASC`,
      modelId,
    ).toArray() as Array<Record<string, unknown>>;
    return rows.map(r => ({
      id: r.id as string,
      tier: r.tier as number,
      text: r.text as string,
      startTimestamp: r.start_timestamp as number,
      endTimestamp: r.end_timestamp as number,
      sourceCount: r.source_count as number,
    }));
  }

  private getModelById(id: string): ModelRow | undefined {
    const row = this.sql
      .exec('SELECT id, name, description, is_seed, archived, created_at FROM models WHERE id = ?', id)
      .toArray()[0] as Record<string, unknown> | undefined;
    return row ? toModelRow(row) : undefined;
  }

  /**
   * Rebuild a model's tiered summaries from its observations (focus-aware
   * synthesis, older tiers compress harder). Replaces the model's summaries in
   * place. Returns the number of tiers written.
   */
  async rebuildModelSummaries(modelId: string, apiKey: string, now: number = Date.now()): Promise<number> {
    const model = this.getModelById(modelId);
    if (!model) return 0;
    const obs = this.listObservationsForModel(modelId, 5000);
    const buckets = bucketObservations(obs, now);
    const jobs = buckets.map(b => buildSynthJob(model, b));
    const texts = await Promise.all(jobs.map(j => synthesize(j.system, j.user, apiKey, { maxTokens: j.maxTokens })));

    this.sql.exec('DELETE FROM summaries WHERE model_id = ?', modelId);
    jobs.forEach((j, i) => {
      this.sql.exec(
        'INSERT INTO summaries (id, model_id, tier, text, start_timestamp, end_timestamp, source_count, is_dirty) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
        crypto.randomUUID(), modelId, j.tier, texts[i], j.startTs, j.endTs, j.sourceCount,
      );
    });
    this.sql.exec('UPDATE models SET last_summarized_count = ? WHERE id = ?', obs.length, modelId);
    return jobs.length;
  }

  /** Rebuild summaries for every active model (concurrency-bounded). */
  async rebuildAllSummaries(apiKey: string): Promise<{ models: number; summaries: number }> {
    const models = this.listModels();
    let idx = 0;
    const pool = Math.min(4, models.length);
    await Promise.all(Array.from({ length: pool }, async () => {
      while (idx < models.length) {
        await this.rebuildModelSummaries(models[idx++]!.id, apiKey);
      }
    }));
    // Count from the DB — accumulating across the concurrent pool would race.
    const summaries = (this.sql.exec('SELECT COUNT(*) AS c FROM summaries').one() as { c: number }).c;
    return { models: models.length, summaries };
  }

  /**
   * Resummarize trigger (called from record_observation). For each tagged model,
   * rebuild its pyramid only once it has accumulated `threshold` new observations
   * since the last build — a no-op in the common case. Failures are swallowed so
   * recording never fails on synthesis.
   */
  async maybeResummarize(modelNames: string[], apiKey: string, threshold = 8): Promise<string[]> {
    if (!apiKey) return [];
    const rebuilt: string[] = [];
    for (const name of modelNames) {
      const m = this.getModel(name);
      if (!m) continue;
      const last = (this.sql.exec('SELECT last_summarized_count AS c FROM models WHERE id = ?', m.id).one() as { c: number }).c;
      const obsCount = this.getModelConfidence(m.id).obsCount;
      if (obsCount - last >= threshold) {
        try { await this.rebuildModelSummaries(m.id, apiKey); rebuilt.push(name); }
        catch (e) { console.error(`[resummarize] ${name} failed:`, e); }
      }
    }
    return rebuilt;
  }

  /** Recency-first across all models — the short-term continuity substitute. */
  recentObservations(limit = 30): ObservationRow[] {
    const rows = this.sql
      .exec('SELECT id, text, timestamp, source FROM observations ORDER BY timestamp DESC LIMIT ?', limit)
      .toArray() as Array<Record<string, unknown>>;
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

  getStats(): { models: number; observations: number; summaries: number; embedded: number } {
    return {
      models: this.sql.exec('SELECT COUNT(*) AS c FROM models WHERE archived = 0').one().c as number,
      observations: this.sql.exec('SELECT COUNT(*) AS c FROM observations').one().c as number,
      summaries: this.sql.exec('SELECT COUNT(*) AS c FROM summaries').one().c as number,
      embedded: this.sql.exec('SELECT COUNT(*) AS c FROM observations WHERE embedding IS NOT NULL').one().c as number,
    };
  }
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
