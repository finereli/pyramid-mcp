/**
 * Embeddings — OpenAI `text-embedding-3-small` (1536-dim), the single-BYOK
 * provider. Pure fetch helpers used by the MCP tool layer (to embed the query
 * and new observations) and by the seed script. No state, no DO coupling — the
 * caller supplies the user's API key (captured in the OAuth flow, Task #8).
 *
 * OpenRouter is chat-only (no embeddings endpoint), so embeddings pin to
 * OpenAI; synthesis can ride the same key with a GPT-mini model.
 */

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIM = 1536;

const ENDPOINT = 'https://api.openai.com/v1/embeddings';

/** Embed a batch of texts. Returns vectors in input order. */
export async function embedTexts(texts: string[], apiKey: string): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI embeddings failed: ${res.status} ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as { data: Array<{ index: number; embedding: number[] }> };
  return json.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
}

export async function embedText(text: string, apiKey: string): Promise<number[]> {
  const [v] = await embedTexts([text], apiKey);
  return v!;
}
