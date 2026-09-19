export interface ChatMessage { role: 'user' | 'assistant' | 'system'; content: string }
export function aiStatus() {
  const provider = process.env.AI_PROVIDER ?? 'zai';
  return { enabled: Boolean(process.env.AI_API_KEY && process.env.AI_MODEL && (provider !== 'azure' || process.env.AI_ENDPOINT)), provider,
    model: process.env.AI_MODEL || null, maxOutputTokens: Math.min(2400, Math.max(200, Number(process.env.AI_MAX_OUTPUT_TOKENS) || 1200)) };
}
export async function askAssistant(messages: ChatMessage[]): Promise<{ text: string; model: string; provider: string; tokens: number | null }> {
  const status = aiStatus();
  if (!status.enabled) throw new Error('The AI assistant is not configured yet. You can still practise and run your code.');
  const endpoints: Record<string,string> = { zai:'https://api.z.ai/api/paas/v4/chat/completions', gemini:'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions' };
  const endpoint = status.provider === 'azure' ? process.env.AI_ENDPOINT! : endpoints[status.provider];
  if (!endpoint || new URL(endpoint).protocol !== 'https:') throw new Error('AI provider configuration is invalid.');
  const headers: Record<string,string> = { 'content-type':'application/json' };
  headers[status.provider === 'azure' ? 'api-key' : 'authorization'] = status.provider === 'azure' ? process.env.AI_API_KEY! : `Bearer ${process.env.AI_API_KEY}`;
  const payload:Record<string,unknown> = { model:status.model,
    messages:messages.map(m => ({role:m.role,content:m.content.slice(0,14000)})), max_tokens:status.maxOutputTokens };
  if(status.provider==='gemini')payload.reasoning_effort='low';
  const response = await fetch(endpoint, { method:'POST', headers, signal:AbortSignal.timeout(45000), redirect:'error', body:JSON.stringify(payload) });
  if (!response.ok) throw new Error(response.status === 429 ? 'The AI provider is at its usage limit. Please try later.' : 'The AI provider could not complete this request. Your work is saved.');
  const body = await response.json() as any;
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('The AI provider returned an empty answer.');
  return { text:content.slice(0,18000), provider:status.provider, model:status.model!, tokens: typeof body.usage?.total_tokens === 'number' ? body.usage.total_tokens : null };
}
