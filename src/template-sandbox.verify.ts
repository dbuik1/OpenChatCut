// Installing a plugin, or letting the agent write a motion graphic, used to
// evaluate that untrusted code in the app's own realm before anyone had
// accepted it. This pins the replacement: the pre-acceptance evaluation
// happens on an opaque origin, and where there is no DOM it does not happen
// at all.
import assert from 'node:assert/strict';
import {
  TEMPLATE_SANDBOX_ATTRIBUTE,
  isTemplateSandboxReady,
  probeTemplate,
  templateProbeResult,
  templateSandboxAvailable,
  templateSandboxScript,
  templateSandboxSrcdoc,
} from './template-sandbox';

const GOOD = 'const Hello = ({ item }) => <AbsoluteFill>{String(item.width)}</AbsoluteFill>;';

function verifySandboxShape(): void {
  assert.equal(TEMPLATE_SANDBOX_ATTRIBUTE, 'allow-scripts');
  assert.doesNotMatch(
    TEMPLATE_SANDBOX_ATTRIBUTE,
    /allow-same-origin/,
    'allow-same-origin would put the template back on the app origin',
  );
  const srcdoc = templateSandboxSrcdoc();
  assert.match(srcdoc, /event\.source !== parent/, 'the guest answers its parent only');
  assert.match(srcdoc, /request\.v !== 1/, 'the guest checks the message version');
  assert.doesNotMatch(srcdoc, /<script[^>]*src=/, 'the sandbox document loads nothing');
}

function verifyMessageContract(): void {
  const good = { v: 1, type: 'openchatcut-template-probe-result', id: 'abc', error: null };
  assert.deepEqual(templateProbeResult(good)?.id, 'abc');
  assert.equal(templateProbeResult({ ...good, v: 2 }), null, 'a different version is not our reply');
  assert.equal(templateProbeResult({ ...good, type: 'something-else' }), null);
  assert.equal(templateProbeResult({ ...good, id: '' }), null);
  assert.equal(templateProbeResult({ ...good, error: { message: 'x' } }), null, 'error must be a string or null');
  assert.equal(templateProbeResult('openchatcut-template-probe-result'), null);
  assert.equal(templateProbeResult(null), null);
  assert.equal(isTemplateSandboxReady({ v: 1, type: 'openchatcut-template-probe-ready' }), true);
  assert.equal(isTemplateSandboxReady({ v: 1, type: 'openchatcut-template-probe-result' }), false);
}

async function verifyNoDomDoesNotExecute(): Promise<void> {
  assert.equal(templateSandboxAvailable(), false, 'this runtime has no DOM');
  const marker = '__templateSandboxVerifyProbe';
  const sideEffect = `Array.prototype.${marker} = 1;\nconst Payload = ({ item }) => <AbsoluteFill />;`;
  await probeTemplate(sideEffect);
  assert.equal(
    marker in Array.prototype,
    false,
    'a DOM-less runtime parses the template without running its body',
  );
  await assert.rejects(
    probeTemplate('const Broken = ({ item }) => <AbsoluteFill'),
    'malformed code is still rejected',
  );
  await assert.rejects(
    probeTemplate('const Sneaky = ({ item }) => fetch("https://example.test");'),
    /sandbox/,
    'the static blocklist still runs first',
  );
}

type Listener = (event: { data: unknown; source: unknown }) => void;

/**
 * A DOM stand-in that runs the real guest program behind the real message
 * plumbing: no browser here, so the frame, its window and the parent are
 * objects, but the script under test, the handshake, the id matching and the
 * source check are the shipped ones.
 */
function installFakeDom(): { attributes: Record<string, string>; deliver: (data: unknown, source: unknown) => void } {
  const hostListeners = new Set<Listener>();
  const guestListeners = new Set<Listener>();
  const attributes: Record<string, string> = {};
  const post = (listeners: Set<Listener>, data: unknown, source: unknown) => {
    queueMicrotask(() => { for (const listener of [...listeners]) listener({ data, source }); });
  };
  const guestWindow = { postMessage: (data: unknown) => post(guestListeners, data, parentWindow) };
  const parentWindow = { postMessage: (data: unknown) => post(hostListeners, data, guestWindow) };
  const frame = {
    setAttribute: (key: string, value: string) => { attributes[key] = value; },
    style: { cssText: '' },
    srcdoc: '',
    contentWindow: guestWindow,
  };
  const boot = () => {
    // eslint-disable-next-line no-new-func
    const run = new Function('addEventListener', 'parent', templateSandboxScript());
    run((_type: string, listener: Listener) => guestListeners.add(listener), parentWindow);
  };
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.document = { createElement: () => frame, body: { appendChild: () => boot() } };
  globals.window = {
    addEventListener: (_type: string, listener: Listener) => hostListeners.add(listener),
    removeEventListener: (_type: string, listener: Listener) => hostListeners.delete(listener),
  };
  return { attributes, deliver: (data, source) => post(hostListeners, data, source) };
}

async function verifySandboxRoundTrip(): Promise<void> {
  const fake = installFakeDom();
  assert.equal(templateSandboxAvailable(), true);
  await probeTemplate(GOOD);
  assert.equal(fake.attributes.sandbox, 'allow-scripts', 'the frame carries exactly the sandbox attribute');
  assert.equal(fake.attributes.sandbox.includes('allow-same-origin'), false);

  await assert.rejects(
    probeTemplate('const NotAComponent = (42);'),
    /不是组件函数/,
    'the guest verdict travels back to the caller',
  );
  await assert.rejects(
    probeTemplate('const T = navigator.userAgent;\nconst Boom = ({ item }) => <AbsoluteFill />;'),
    /Cannot read properties of undefined/,
    'the shadowed scope still applies inside the sandbox',
  );

  // A message from anywhere else, or one shaped almost right, must not settle
  // a probe: the reply is matched by frame, version, type and request id.
  const pending = probeTemplate(GOOD);
  fake.deliver({ v: 1, type: 'openchatcut-template-probe-result', id: 'not-my-id', error: 'spoofed' }, {});
  fake.deliver({ v: 1, type: 'openchatcut-template-probe-result', id: 'not-my-id', error: 'spoofed' }, null);
  await pending;
}

await (async () => {
  verifySandboxShape();
  verifyMessageContract();
  await verifyNoDomDoesNotExecute();
  await verifySandboxRoundTrip();
  console.log('template-sandbox.verify: ALL PASSED');
})();
