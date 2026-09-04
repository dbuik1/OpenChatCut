export interface DescribedError {
  readonly message: string;
  readonly stack?: string;
}

export function describeRendererError(error: unknown): DescribedError {
  if (error instanceof Error) {
    return { message: `${error.name}: ${error.message}`, ...(error.stack ? { stack: error.stack } : {}) };
  }
  if (typeof error === 'string') return { message: error };
  try { return { message: JSON.stringify(error) ?? String(error) }; } catch { return { message: String(error) }; }
}
