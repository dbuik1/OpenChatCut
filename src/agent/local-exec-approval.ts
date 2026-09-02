import { digestAgentToolArgs } from './runtime-ledger';
import { formatToolApprovalDetails, type ApprovalDetail } from './approval-details';

/**
 * Tools whose side effect is code from outside the app running on this
 * machine: install_skill writes a third-party repository — scripts and all —
 * into the skill directory, and run_skill_script executes a binary against
 * that directory with no sandbox. Both take their arguments from model output,
 * which carries transcript text, scraped pages and skill files, so the person
 * at the keyboard is the only party that can tell a wanted install from an
 * injected one.
 */
const LOCAL_CODE_EXECUTION_TOOLS = new Set(['install_skill', 'run_skill_script']);

export const LOCAL_CODE_EXECUTION_TOOL_NAMES: readonly string[] = [...LOCAL_CODE_EXECUTION_TOOLS];

export function isLocalCodeExecutionTool(name: string): boolean {
  return LOCAL_CODE_EXECUTION_TOOLS.has(name);
}

export interface LocalExecApprovalRequest {
  readonly id: string;
  readonly tool: string;
  readonly summary: string;
  readonly details: readonly ApprovalDetail[];
  readonly argsDigest: string;
}

interface QueuedApproval {
  readonly request: LocalExecApprovalRequest;
  readonly settle: (allow: boolean) => void;
}

export const LOCAL_EXEC_DENIED_MESSAGE =
  'Local code execution was not confirmed. install_skill and run_skill_script run '
  + 'third-party code on this machine and need a per-call confirmation from the user; '
  + 'ask them to run it themselves or to confirm the card in OpenChatCut.';

export const LOCAL_EXEC_NO_SURFACE_MESSAGE =
  'Local code execution is unavailable here: this runtime has no confirmation surface, '
  + 'and install_skill / run_skill_script never run unconfirmed.';

/**
 * One-shot confirmation for local code execution, one pending request at a
 * time. Approvals are never remembered: each call carries its own argument
 * digest and settles exactly one invocation, so there is no "always allow"
 * state for an injected instruction to inherit. With no confirmation surface
 * attached the gate denies rather than falling open — a runtime that cannot
 * ask cannot execute.
 */
class LocalExecApprovalGate {
  private readonly queue: QueuedApproval[] = [];
  private readonly listeners = new Set<() => void>();
  private snapshot: LocalExecApprovalRequest | null = null;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Stable snapshot for useSyncExternalStore: the identity only changes with the head of the queue. */
  pending(): LocalExecApprovalRequest | null {
    return this.snapshot;
  }

  hasConfirmationSurface(): boolean {
    return this.listeners.size > 0;
  }

  async request(
    tool: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!this.hasConfirmationSurface()) return false;
    if (signal?.aborted) return false;
    const presentation = formatToolApprovalDetails(tool, args);
    const request: LocalExecApprovalRequest = {
      id: crypto.randomUUID(),
      tool,
      summary: presentation.summary,
      details: presentation.details,
      argsDigest: await digestAgentToolArgs({ ...args }),
    };
    return new Promise<boolean>((resolvePromise) => {
      let settled = false;
      const settle = (allow: boolean) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        resolvePromise(allow);
      };
      const onAbort = () => { this.drop(request.id); settle(false); };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push({ request, settle });
      this.publish();
    });
  }

  resolve(id: string, allow: boolean): boolean {
    const index = this.queue.findIndex((entry) => entry.request.id === id);
    if (index < 0) return false;
    const [entry] = this.queue.splice(index, 1);
    this.publish();
    entry!.settle(allow);
    return true;
  }

  private drop(id: string): void {
    const index = this.queue.findIndex((entry) => entry.request.id === id);
    if (index < 0) return;
    this.queue.splice(index, 1);
    this.publish();
  }

  private publish(): void {
    const head = this.queue[0]?.request ?? null;
    if (head === this.snapshot) return;
    this.snapshot = head;
    for (const listener of this.listeners) listener();
  }
}

export const localExecApprovalGate = new LocalExecApprovalGate();

/**
 * Approval outcome for one local-execution invocation. Callers that reach the
 * gate with no surface attached get the distinct message so the model stops
 * retrying an approval nobody can see.
 */
export async function approveLocalExecution(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<{ readonly allowed: boolean; readonly message: string }> {
  if (!localExecApprovalGate.hasConfirmationSurface()) {
    return { allowed: false, message: LOCAL_EXEC_NO_SURFACE_MESSAGE };
  }
  const allowed = await localExecApprovalGate.request(tool, args, signal);
  return { allowed, message: allowed ? '' : LOCAL_EXEC_DENIED_MESSAGE };
}
