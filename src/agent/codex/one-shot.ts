import { estimateTextTokens } from '../context-compaction';
import { runCodexTurn } from './client';

export interface CodexOneShotRequest {
  /** Names the call in failure messages, so a caller's error says which one failed. */
  readonly label: string;
  readonly system: string;
  readonly prompt: string;
  readonly projectId: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly maxOutputTokens: number;
  readonly signal?: AbortSignal;
}

/**
 * One toolless, read-only Codex turn used as a plain text-generation call.
 * The Codex backend has no completions endpoint, so every non-conversational
 * generation the editor makes - context summaries, highlight selection,
 * generated component code, caption translation, prompt enhancement - goes
 * through a turn instead.
 */
export async function runCodexOneShot(request: CodexOneShotRequest): Promise<string> {
  let text = '';
  let done = false;
  await runCodexTurn({
    requestId: crypto.randomUUID(),
    system: request.system,
    prompt: request.prompt,
    projectId: request.projectId,
    tools: [],
    askOnly: true,
    ...(request.model?.trim() ? { model: request.model.trim() } : {}),
    reasoningEffort: request.reasoningEffort?.trim() || null,
  }, (event) => {
    if (event.type === 'text-delta') {
      const candidate = text + event.delta;
      if (estimateTextTokens(candidate) > request.maxOutputTokens) {
        throw new Error(`Codex ${request.label} exceeded its output limit.`);
      }
      text = candidate;
    } else if (event.type === 'error') {
      throw new Error(event.message);
    } else if (event.type === 'done') {
      done = true;
    }
  }, request.signal);
  if (!done) throw new Error(`Codex ${request.label} ended before completion.`);
  return text.trim();
}
