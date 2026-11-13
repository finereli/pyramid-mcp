/**
 * Synthesis - Cloudflare Workers AI, via the `env.AI` binding. Used for the
 * pyramid tier summaries; the agent itself does the smart integration at read
 * time. No API key - billed to the Cloudflare account.
 *
 * Qwen 3.8 27B since Nov 2026, the model Glopus has summarized with since
 * Oct 1 (through OpenRouter). Llama 3.3 70B before, which had won an A/B
 * against gpt-4o-mini. Qwen thinks by default and spends the whole output
 * budget on hidden reasoning, so thinking is turned off per request; even
 * then it can open with planning text, which `looksLikeReasoning` catches so
 * the caller refuses to store it (summaries are immutable).
 *
 * The signature is provider-agnostic (resolved text in, text out) so MCP
 * sampling - the host's own model writing its own memory, the higher-quality
 * end state - can slot in here unchanged once clients support it
 * (anthropics/claude-code#1785).
 */

export const SYNTH_MODELS = {
  qwen: '@cf/qwen/qwen3.8-27b',
  llama: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
} as const;

export const SYNTH_MODEL: string = SYNTH_MODELS.qwen;

/** The request body for one synthesis call: shared by the binding and the REST comparison script. */
export function synthRequestBody(model: string, system: string, user: string, maxTokens: number): Record<string, unknown> {
  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.4,
    max_tokens: maxTokens,
    ...(model.includes('qwen') ? { chat_template_kwargs: { enable_thinking: false } } : {}),
  };
}

/** Workers AI returns `{response}` for older models and an OpenAI-style `{choices}` for newer ones. */
export function extractText(res: unknown): string {
  const r = res as { response?: string; choices?: Array<{ message?: { content?: string | null } }> } | null;
  return (r?.response ?? r?.choices?.[0]?.message?.content ?? '').trim();
}

/**
 * True when the output opens like the model talking to itself instead of the
 * summary: "The user wants a summary...", "Okay, let me...", "We need to...".
 * Glopus has summaries stored with exactly this preamble.
 */
export function looksLikeReasoning(text: string): boolean {
  const head = text.trim().slice(0, 200).toLowerCase();
  return /^(okay|ok|alright|so|hmm|first|let me|let's|i need to|i'll|i will|we need|we have|the user|the task|the request|i should|now,? )/.test(head)
    || /\b(the user wants|the user is asking|i need to write|let me (start|draft|write)|target length|character count|~?\d{3,4}[- ]characters?\b)/.test(head);
}

export async function synthesize(
  ai: Ai,
  system: string,
  user: string,
  opts: { model?: string; maxTokens?: number } = {},
): Promise<string> {
  const model = opts.model ?? SYNTH_MODEL;
  const t0 = Date.now();
  try {
    const res = await ai.run(model as Parameters<Ai['run']>[0], synthRequestBody(model, system, user, opts.maxTokens ?? 700) as never);
    const ms = Date.now() - t0;
    if (ms > 5000) console.log('synth:slow', { model, ms });
    return extractText(res);
  } catch (e) {
    const ms = Date.now() - t0;
    console.error('synth:error', { model, ms, error: String(e) });
    throw e;
  }
}
