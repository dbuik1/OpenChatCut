// install_skill clones a third-party repository (scripts included) into the
// skill directory and run_skill_script executes binaries against it, with the
// arguments coming from model output. This pins the confirmation that stands
// between prompt-injected text and code running on the user's machine.
import assert from 'node:assert/strict';
import type { AgentContext } from './context';
import type { AgentSettings } from './settings/agentSettings';
import { TOOL_SCHEMAS } from './tools';
import { executeOpenChatCutTool } from './codex/runtime';
import {
  LOCAL_CODE_EXECUTION_TOOL_NAMES,
  isLocalCodeExecutionTool,
  localExecApprovalGate,
} from './local-exec-approval';
import { policyForTool } from './execution-policy';
import { isExternalRealTool } from './external-tool-policy';

const ctx = {
  getProjectId: () => 'local-exec-approval-verify',
  getState: () => ({ items: [], transitions: [] }),
} as unknown as AgentContext;
const settings = {} as AgentSettings;

function schemaFor(name: string) {
  const schema = TOOL_SCHEMAS.find((candidate) => candidate.name === name);
  assert.ok(schema, `${name} must exist in the tool catalog`);
  return schema;
}

interface RunOutcome {
  readonly executions: number;
  readonly success: boolean;
  readonly result: unknown;
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<RunOutcome> {
  let executions = 0;
  const schema = schemaFor(name);
  const execution = await executeOpenChatCutTool(schema, args, {
    ctx, settings, toolCallId: crypto.randomUUID(), signal,
    toolCatalog: TOOL_SCHEMAS, activeToolCatalog: [schema],
    onEvent: () => undefined,
    executeTool: async () => { executions += 1; return { ok: true }; },
  });
  return { executions, success: execution.success, result: execution.result };
}

/** Stand in for the confirmation card: answer the head of the queue with `allow`. */
function attachApprover(allow: boolean, seen: string[]): () => void {
  return localExecApprovalGate.subscribe(() => {
    const pending = localExecApprovalGate.pending();
    if (!pending) return;
    seen.push(`${pending.tool}:${pending.summary}`);
    queueMicrotask(() => localExecApprovalGate.resolve(pending.id, allow));
  });
}

function verifyClassification(): void {
  assert.deepEqual([...LOCAL_CODE_EXECUTION_TOOL_NAMES].sort(), ['install_skill', 'run_skill_script']);
  for (const name of LOCAL_CODE_EXECUTION_TOOL_NAMES) {
    assert.ok(isLocalCodeExecutionTool(name));
    assert.equal(policyForTool(name).effect, 'persistent_local');
    // External sessions reach these through the real-tool path, which is what
    // carries the confirmation card for a connected agent.
    assert.equal(isExternalRealTool(name), true, `${name} must stay a real tool for external agents`);
  }
  assert.equal(isLocalCodeExecutionTool('read_timeline'), false);
}

async function verifyNoSurfaceDenies(): Promise<void> {
  assert.equal(localExecApprovalGate.hasConfirmationSurface(), false);
  const outcome = await runTool('install_skill', { repo: 'attacker/skill' });
  assert.equal(outcome.executions, 0, 'a runtime with no confirmation surface must not install');
  assert.equal(outcome.success, false);
  assert.match(JSON.stringify(outcome.result), /confirmation surface/);
}

async function verifyDenialBlocksExecution(): Promise<void> {
  const seen: string[] = [];
  const detach = attachApprover(false, seen);
  try {
    const outcome = await runTool('run_skill_script', {
      skill: 'demo', command: 'bash scripts/exfiltrate.sh',
    });
    assert.equal(outcome.executions, 0, 'a refused command must never reach the server');
    assert.equal(outcome.success, false);
    assert.equal(seen.length, 1);
    assert.match(seen[0]!, /exfiltrate\.sh/, 'the card shows the exact command');
  } finally {
    detach();
  }
}

async function verifyApprovalIsPerCall(): Promise<void> {
  const seen: string[] = [];
  const detach = attachApprover(true, seen);
  try {
    const first = await runTool('install_skill', { repo: 'owner/skill' });
    assert.equal(first.executions, 1);
    assert.equal(first.success, true);
    const second = await runTool('install_skill', { repo: 'owner/skill' });
    assert.equal(second.executions, 1);
    assert.equal(seen.length, 2, 'an identical repeat asks again — approvals are never remembered');
    assert.match(seen[0]!, /owner\/skill/, 'the card names the repository');
  } finally {
    detach();
  }
  assert.equal(localExecApprovalGate.pending(), null, 'the queue drains with the run');
}

async function verifyAbortDropsTheCard(): Promise<void> {
  const controller = new AbortController();
  const detach = localExecApprovalGate.subscribe(() => {
    if (localExecApprovalGate.pending()) queueMicrotask(() => controller.abort());
  });
  try {
    const outcome = await runTool('install_skill', { repo: 'owner/skill' }, controller.signal);
    assert.equal(outcome.executions, 0, 'stopping the run cancels the pending confirmation');
    assert.equal(localExecApprovalGate.pending(), null, 'no card survives the stopped run');
  } finally {
    detach();
  }
}

await (async () => {
  verifyClassification();
  await verifyNoSurfaceDenies();
  await verifyDenialBlocksExecution();
  await verifyApprovalIsPerCall();
  await verifyAbortDropsTheCard();
  console.log('local-exec-approval.verify: ALL PASSED');
})();
