/**
 * Synthesis — OpenAI chat completion (single BYOK; a GPT-mini stands in for the
 * Haiku-class synthesizer Glopus uses). Used only for pyramid summaries; the
 * agent itself does the smart integration at read time. Pure fetch helper.
 *
 * Phase 2 swaps this for MCP sampling (the host's own model) when hosts support it.
 */

export const SYNTH_MODEL = 'gpt-4o-mini';
const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

export async function synthesize(
  system: string,
  user: string,
  apiKey: string,
  opts: { model?: string; maxTokens?: number } = {},
): Promise<string> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: opts.model ?? SYNTH_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.4,
      max_tokens: opts.maxTokens ?? 700,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI synthesis failed: ${res.status} ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  return (json.choices[0]?.message?.content ?? '').trim();
}
