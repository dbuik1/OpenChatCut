// Evaluating an untrusted template outside the app's origin.
//
// A plugin pack or an agent-written motion graphic is checked before it is
// stored, and that check used to be an evaluation in the renderer: the same
// realm as the project, its IndexedDB, its API credentials and the desktop
// bridge. The static blocklist and the shadowed scope in template-host are
// hardening, not a boundary — their own header says so — and installing a
// plugin should not be the moment a boundary is needed.
//
// So the pre-acceptance evaluation happens here instead, in an iframe with
// sandbox="allow-scripts" and no allow-same-origin: an opaque origin with no
// access to the app's storage, cookies, DOM or same-origin network. It is
// driven by postMessage with a versioned message shape, replies are matched
// to the request id and accepted only from that iframe's own window, and a
// probe that never answers times out rather than hanging the caller.
//
// Templates already stored in a project are still evaluated in the renderer
// on the render path (see template-host) — that is a rendering change, not a
// validation one, and remains to do.
import {
  TEMPLATE_GLOBAL_NAMES,
  TEMPLATE_SHADOW_NAMES,
  templateName,
  transpileTemplate,
} from './template-host';

const PROBE_TYPE = 'openchatcut-template-probe';
const READY_TYPE = `${PROBE_TYPE}-ready`;
const RESULT_TYPE = `${PROBE_TYPE}-result`;
const PROBE_TIMEOUT_MS = 10_000;

/** allow-scripts and nothing else: allow-same-origin would return the app's origin to the template. */
export const TEMPLATE_SANDBOX_ATTRIBUTE = 'allow-scripts';

export interface TemplateProbeResult {
  readonly v: 1;
  readonly type: typeof RESULT_TYPE;
  readonly id: string;
  /** null when the template evaluated to a component function. */
  readonly error: string | null;
}

/** Accept only this exact shape from the sandbox; anything else is not our reply. */
export function templateProbeResult(data: unknown): TemplateProbeResult | null {
  if (!data || typeof data !== 'object') return null;
  const message = data as Record<string, unknown>;
  if (message.v !== 1 || message.type !== RESULT_TYPE) return null;
  if (typeof message.id !== 'string' || !message.id) return null;
  if (message.error !== null && typeof message.error !== 'string') return null;
  return { v: 1, type: RESULT_TYPE, id: message.id, error: message.error as string | null };
}

export function isTemplateSandboxReady(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const message = data as Record<string, unknown>;
  return message.v === 1 && message.type === READY_TYPE;
}

/**
 * Guest program: the evaluator plus a strict message contract, no imports and
 * no fetches. It is source text rather than a serialized function on purpose —
 * the bundler rewrites function bodies (name helpers, minified identifiers),
 * and none of those helpers exist inside the sandbox document.
 *
 * Injected globals are bound to a self-returning stub rather than to the real
 * React/Remotion values: a probe only needs to know that the module body runs
 * and yields a component function, and a stub keeps top-level references such
 * as `Easing.ease` working without carrying anything real into the sandbox.
 */
export function templateSandboxScript(): string {
  return `(function () {
'use strict';
function stub() {
  var proxy = new Proxy(function () {}, {
    get: function (target, key) { return key === 'then' ? undefined : proxy; },
    apply: function () { return proxy; },
    construct: function () { return proxy; },
  });
  return proxy;
}
function evaluateProbe(code, name, globals, shadow) {
  var names = globals.concat(shadow);
  var values = globals.map(function () { return stub(); }).concat(shadow.map(function () { return undefined; }));
  var factory = Function.apply(null, names.concat(['"use strict";\\n' + code + '\\n;return ' + name + ';']));
  var component = factory.apply(null, values);
  return typeof component === 'function' ? null : 'template: ' + name + ' \u4e0d\u662f\u7ec4\u4ef6\u51fd\u6570';
}
addEventListener('message', function (event) {
  if (event.source !== parent) return;
  var request = event.data;
  if (!request || request.v !== 1 || request.type !== ${JSON.stringify(PROBE_TYPE)}) return;
  if (typeof request.id !== 'string' || typeof request.code !== 'string') return;
  if (typeof request.name !== 'string') return;
  if (!Array.isArray(request.globals) || !Array.isArray(request.shadow)) return;
  var error;
  try {
    error = evaluateProbe(request.code, request.name, request.globals, request.shadow);
  } catch (failure) {
    error = (failure && failure.message) ? String(failure.message) : String(failure);
  }
  parent.postMessage({
    v: 1, type: ${JSON.stringify(RESULT_TYPE)}, id: request.id, error: error === undefined ? null : error,
  }, '*');
});
parent.postMessage({ v: 1, type: ${JSON.stringify(READY_TYPE)} }, '*');
})();`;
}

// Split so the closing tag never appears as a literal in this source: an
// inline script ends at the first </script> the HTML parser sees, wherever it
// came from.
const SCRIPT_CLOSE = `</${'script'}>`;

/** The sandbox document. It loads nothing: everything it runs is inline. */
export function templateSandboxSrcdoc(): string {
  return `<!doctype html><meta charset="utf-8"><script>${templateSandboxScript()}${SCRIPT_CLOSE}`;
}

interface SandboxHandle {
  readonly frame: HTMLIFrameElement;
  readonly ready: Promise<void>;
}

let sandbox: SandboxHandle | null = null;
const waiting = new Map<string, (result: TemplateProbeResult) => void>();

function openSandbox(): SandboxHandle {
  if (sandbox) return sandbox;
  const frame = document.createElement('iframe');
  // No allow-same-origin: the guest must stay on an opaque origin, which is
  // the whole point. Adding it back would hand the template the app's origin.
  frame.setAttribute('sandbox', TEMPLATE_SANDBOX_ATTRIBUTE);
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('tabindex', '-1');
  frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('template sandbox: 初始化超时')), PROBE_TIMEOUT_MS);
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return;
      if (!isTemplateSandboxReady(event.data)) return;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve();
    };
    window.addEventListener('message', onMessage);
  });
  frame.srcdoc = templateSandboxSrcdoc();
  document.body.appendChild(frame);
  sandbox = { frame, ready };
  return sandbox;
}

function sandboxResultListener(frame: HTMLIFrameElement): (event: MessageEvent) => void {
  return (event: MessageEvent) => {
    if (event.source !== frame.contentWindow) return;
    const result = templateProbeResult(event.data);
    if (!result) return;
    waiting.get(result.id)?.(result);
  };
}

async function probeInSandbox(transpiled: string, name: string): Promise<void> {
  const handle = openSandbox();
  await handle.ready;
  const id = crypto.randomUUID();
  const listener = sandboxResultListener(handle.frame);
  window.addEventListener('message', listener);
  try {
    const error = await new Promise<string | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('template sandbox: 编译探测超时')), PROBE_TIMEOUT_MS);
      waiting.set(id, (result) => { clearTimeout(timer); resolve(result.error); });
      handle.frame.contentWindow?.postMessage({
        v: 1, type: PROBE_TYPE, id, name, code: transpiled,
        globals: [...TEMPLATE_GLOBAL_NAMES], shadow: [...TEMPLATE_SHADOW_NAMES],
      }, '*');
    });
    if (error) throw new Error(error);
  } finally {
    waiting.delete(id);
    window.removeEventListener('message', listener);
  }
}

/**
 * Syntax check for runtimes with no DOM (tests, server-side tool execution).
 * Constructing the Function parses the template without running its body, so
 * this path evaluates strictly less than the renderer used to.
 */
function parseOnly(transpiled: string, name: string): void {
  const names = [...TEMPLATE_GLOBAL_NAMES, ...TEMPLATE_SHADOW_NAMES];
  // eslint-disable-next-line no-new-func
  new Function(...names, `"use strict";\n${transpiled}\n;return ${name};`);
}

export function templateSandboxAvailable(): boolean {
  return typeof document !== 'undefined' && typeof window !== 'undefined';
}

/**
 * Accept-or-reject one untrusted template without evaluating it in the app's
 * realm. Throws with the sandbox's own message when the template is rejected.
 */
export async function probeTemplate(code: string): Promise<void> {
  const name = templateName(code);
  const transpiled = await transpileTemplate(code);
  if (!templateSandboxAvailable()) {
    parseOnly(transpiled, name);
    return;
  }
  await probeInSandbox(transpiled, name);
}
