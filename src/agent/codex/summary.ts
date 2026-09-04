import { runCodexOneShot } from './one-shot';

export interface CodexSummaryRequest {
  readonly system: string;
  readonly prompt: string;
  readonly projectId: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly maxOutputTokens: number;
  readonly signal?: AbortSignal;
}

export async function runCodexSummary(request: CodexSummaryRequest): Promise<string> {
  return runCodexOneShot({ label: 'context summary', ...request });
}
