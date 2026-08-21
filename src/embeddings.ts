/**
 * Embeddings — Cloudflare Workers AI `bge-m3` (1024-dim). Two entry points: the
 * `env.AI` binding for the Worker/DO runtime, and a REST helper for offline
 * scripts (build-seed). No API key — Workers AI is billed to the account, so
 * recall works the moment a user signs in (no BYOK step).
 *
 * Vectors are L2-normalized at store time (memory-do), so cosine similarity
 * reduces to a dot product.
 */

export const EMBEDDING_MODEL = '@cf/baai/bge-m3';
export const EMBEDDING_DIM = 1024;

interface BgeResponse { data: number[][] }

const EMBED_TIMEOUT_MS = 8000;

/** Embed a batch via the Workers AI binding. Returns vectors in input order. */
export async function embed(ai: Ai, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const t0 = Date.now();
  try {
    const res = await Promise.race([
      ai.run(EMBEDDING_MODEL, { text: texts }) as unknown as Promise<BgeResponse>,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`embed timeout after ${EMBED_TIMEOUT_MS}ms`)), EMBED_TIMEOUT_MS)),
    ]);
    const ms = Date.now() - t0;
    if (ms > 3000) console.log('embed:slow', { count: texts.length, ms });
    return res.data;
  } catch (e) {
    const ms = Date.now() - t0;
    console.error('embed:error', { count: texts.length, ms, error: String(e) });
    throw e;
  }
}

/** Single-text helper. */
export async function embedOne(ai: Ai, text: string): Promise<number[]> {
  const [v] = await embed(ai, [text]);
  return v!;
}

/**
 * Embed a batch via the Workers AI REST API — for offline scripts (build-seed)
 * that run outside the Worker and so have no `env.AI` binding. Needs a token
 * with the "Workers AI" permission and the account id.
 */
export async function embedRest(token: string, accountId: string, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${EMBEDDING_MODEL}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: texts }),
    },
  );
  const json = (await res.json()) as { result?: BgeResponse; success: boolean; errors?: unknown };
  if (!res.ok || !json.success) {
    throw new Error(`Workers AI embeddings failed: ${res.status} ${JSON.stringify(json.errors ?? json)}`);
  }
  return json.result!.data;
}
