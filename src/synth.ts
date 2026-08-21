/**
 * Synthesis — Cloudflare Workers AI Llama 3.3 70B (fp8-fast), via the `env.AI`
 * binding. Used only for the pyramid tier summaries; the agent itself does the
 * smart integration at read time. No API key — billed to the Cloudflare account.
 *
 * Chosen over gpt-4o-mini after an A/B on real synth jobs (scripts/synth-ab.ts):
 * 70B retained more verified factual/numeric detail — which is what a memory
 * substrate needs — at comparable quality and no BYOK requirement.
 *
 * The signature is provider-agnostic (resolved text in, text out) so MCP
 * sampling — the host's own model writing its own memory, the higher-quality
 * end state — can slot in here unchanged once clients support it
 * (anthropics/claude-code#1785).
 */

export const SYNTH_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

interface ChatResponse { response?: string }

export async function synthesize(
  ai: Ai,
  system: string,
  user: string,
  opts: { model?: string; maxTokens?: number } = {},
): Promise<string> {
  const model = opts.model ?? SYNTH_MODEL;
  const t0 = Date.now();
  try {
    const res = (await ai.run(model, {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.4,
      max_tokens: opts.maxTokens ?? 700,
    })) as unknown as ChatResponse;
    const ms = Date.now() - t0;
    if (ms > 5000) console.log('synth:slow', { model, ms });
    return (res.response ?? '').trim();
  } catch (e) {
    const ms = Date.now() - t0;
    console.error('synth:error', { model, ms, error: String(e) });
    throw e;
  }
}
