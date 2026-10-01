import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// Globals must exist before the module (which declares a web-component class
// `extends HTMLElement` at load) is imported — same shim set as this
// package's other jsdom suites (renderer.test.mjs, axe.test.mjs).
const dom = new JSDOM("<!DOCTYPE html><body></body>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
globalThis.Event = dom.window.Event;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.Node = dom.window.Node;
globalThis.File = dom.window.File;
globalThis.customElements = dom.window.customElements;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);

const { renderForm } = await import("../dist/index.js");

const tick = () => new Promise((r) => setTimeout(r, 0));
const dispatch = (el, type) =>
  el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
const localClient = {
  submit: async () => ({ ok: true, responseId: "r-test" }),
  startSession: async () => null,
  reportProgress: () => {},
};

function mount(form, opts = {}) {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = renderForm(target, {
    form,
    ...(!opts.formId && !opts.client && !opts.renderOnly
      ? { formId: "f-test", client: localClient }
      : {}),
    ...opts,
  });
  return { target, instance };
}

const challenge = { provider: "turnstile", siteKey: "sitekey-test" };

const oneField = {
  version: 1,
  title: "T",
  settings: {},
  pages: [
    { id: "p1", blocks: [{ id: "name", kind: "short_text", label: "Name", required: true }] },
  ],
};

function fakeClient(over = {}) {
  return {
    key: "pk_test",
    baseUrl: "",
    submit: async () => ({ ok: true, responseId: "r1" }),
    startSession: async () => null,
    reportProgress: () => {},
    ...over,
  };
}

/** Fake Cloudflare global: captures each render's options so tests can drive
 *  the widget callbacks (solve/expire/error) with no third-party script. With
 *  the global pre-set, the loader short-circuits and injects no <script>. */
function installFakeTurnstile() {
  const widgets = [];
  const resets = [];
  const removes = [];
  globalThis.turnstile = {
    render: (container, options) => {
      const id = `widget-${widgets.length + 1}`;
      widgets.push({ id, container, options });
      return id;
    },
    reset: (id) => resets.push(id),
    remove: (id) => removes.push(id),
  };
  return { widgets, resets, removes };
}

test("challenge-gated form shows the slot and gates the primary button", async () => {
  const fake = installFakeTurnstile();
  try {
    const { target } = mount(oneField, { formId: "f1", client: fakeClient(), challenge });
    await tick();

    assert.ok(target.querySelector('[data-fillo="turnstile-slot"]'), "widget slot rendered");
    assert.ok(target.querySelector(".fillo-turnstile"), "widget container rendered");
    assert.equal(fake.widgets.length, 1, "widget rendered once");
    assert.equal(fake.widgets[0].options.sitekey, "sitekey-test");
    assert.equal(
      target.querySelector(".fillo-button--primary").disabled,
      true,
      "submit waits for the human check",
    );

    const input = target.querySelector('[data-field="name"] input');
    input.value = "Ada";
    dispatch(input, "input");
    await tick();
    assert.equal(
      target.querySelector(".fillo-button--primary").disabled,
      true,
      "answers alone don't enable submit",
    );
  } finally {
    delete globalThis.turnstile;
  }
});

test("a server-delivered challenge (hosted fetch) renders the widget the same as an explicit prop", async () => {
  const fake = installFakeTurnstile();
  try {
    const target = document.createElement("div");
    document.body.appendChild(target);
    renderForm(target, {
      formId: "f-hosted-challenge",
      client: {
        getForm: async () => ({
          id: "f-hosted-challenge",
          slug: "hosted-challenge",
          schema: oneField,
          theme: null,
          challenge,
        }),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.ok(
      target.querySelector('[data-fillo="turnstile-slot"]'),
      "server-delivered challenge (PublishedForm.challenge) renders the slot",
    );
    assert.equal(fake.widgets.length, 1);
    assert.equal(fake.widgets[0].options.sitekey, "sitekey-test");
    assert.equal(target.querySelector(".fillo-button--primary").disabled, true);
  } finally {
    delete globalThis.turnstile;
  }
});

test("solved token rides submit meta.challengeToken through to the server", async () => {
  const fake = installFakeTurnstile();
  try {
    let received = null;
    const client = fakeClient({
      submit: async (formId, data, meta) => {
        received = { formId, data, meta };
        return { ok: true, responseId: "r-challenge" };
      },
    });
    const { target } = mount(oneField, { formId: "f-challenge", client, challenge });
    await tick();

    const input = target.querySelector('[data-field="name"] input');
    input.value = "Ada";
    dispatch(input, "input");
    await tick();

    fake.widgets[0].options.callback("tok-solved");
    await tick();
    assert.equal(
      target.querySelector(".fillo-button--primary").disabled,
      false,
      "solved challenge enables submit",
    );

    dispatch(target.querySelector("form"), "submit");
    await tick();
    await tick();
    assert.ok(received, "submit reached the client");
    assert.equal(received.formId, "f-challenge");
    assert.equal(received.meta.challengeToken, "tok-solved");
    assert.equal(received.data.name, "Ada");
    assert.ok(target.querySelector(".fillo-form--success"), "201 shows the success screen");
  } finally {
    delete globalThis.turnstile;
  }
});

test("expired-callback clears the token: submit disables again and the widget resets", async () => {
  const fake = installFakeTurnstile();
  try {
    const { target } = mount(oneField, { formId: "f1", client: fakeClient(), challenge });
    await tick();
    const input = target.querySelector('[data-field="name"] input');
    input.value = "Ada";
    dispatch(input, "input");
    await tick();

    fake.widgets[0].options.callback("tok-1");
    await tick();
    assert.equal(target.querySelector(".fillo-button--primary").disabled, false);

    fake.widgets[0].options["expired-callback"]();
    await tick();
    assert.equal(
      target.querySelector(".fillo-button--primary").disabled,
      true,
      "an aged-out token no longer enables submit",
    );
    assert.deepEqual(fake.resets, [fake.widgets[0].id], "widget re-armed for a fresh solve");
  } finally {
    delete globalThis.turnstile;
  }
});

test("script-load failure removes the dead <script>; a second mount injects a fresh one", async () => {
  // No fake global: the loader must inject the real script tag.
  delete globalThis.turnstile;
  const first = mount(oneField, { formId: "f1", client: fakeClient(), challenge });
  await tick();
  const firstScript = document.getElementById("fillo-turnstile-script");
  assert.ok(firstScript, "loader injected the Cloudflare script");
  assert.equal(firstScript.parentNode, document.head);

  dispatch(firstScript, "error");
  await tick();
  assert.equal(
    document.getElementById("fillo-turnstile-script"),
    null,
    "dead script removed from <head>",
  );
  // The script's "error" listener rejects loadTurnstileScript()'s promise
  // synchronously, but ensureTurnstileWidget()'s .catch() (where
  // handleChallengeError()'s queueRender() call lives) only runs as a
  // microtask continuation — one AFTER the tick() above already scheduled
  // its own macrotask. queueRender is now itself a macrotask (ledger #4:
  // scheduled via setTimeout, not queueMicrotask, so a same-gesture click
  // survives a text field's blur-triggered rebuild), so that .catch()'s
  // render lands one tick later than the dead-script removal above.
  await tick();
  assert.match(
    first.target.querySelector(".fillo-turnstile-error").textContent,
    /verification check couldn't load/i,
  );
  first.instance.destroy();

  // The cached promise was cleared with the dead node, so a later mount
  // injects a FRESH element and actually re-fetches — instead of re-finding
  // the corpse and hanging on listeners that never fire.
  const second = mount(oneField, { formId: "f1", client: fakeClient(), challenge });
  await tick();
  const secondScript = document.getElementById("fillo-turnstile-script");
  assert.ok(secondScript, "second mount re-fetches the script");
  assert.notEqual(secondScript, firstScript, "a fresh node, not the removed one");
  // Fail this load too so the module-level cache is clean for later tests.
  dispatch(secondScript, "error");
  await tick();
  second.instance.destroy();
});

test("widget container node identity survives a setValue re-render", async () => {
  const fake = installFakeTurnstile();
  try {
    const { target, instance } = mount(oneField, { formId: "f1", client: fakeClient(), challenge });
    await tick();
    const containerBefore = target.querySelector(".fillo-turnstile");
    assert.ok(containerBefore, "widget container rendered");
    assert.equal(fake.widgets.length, 1, "widget rendered once before any re-render");

    // The renderer's full-tree element.replaceChildren() rebuild, triggered
    // the same way a host's programmatic setValue() would (not the widget's
    // own callback) — the container must be the SAME node afterward, not a
    // fresh one Cloudflare's iframe would have to be re-fetched into.
    instance.setValue("name", "Ada");
    await tick();
    instance.setValue("name", "Ada Lovelace");
    await tick();

    const containerAfter = target.querySelector(".fillo-turnstile");
    assert.equal(
      containerAfter,
      containerBefore,
      "same container node — not recreated on each render",
    );
    assert.equal(fake.widgets.length, 1, "Cloudflare's render() was not called again");
  } finally {
    delete globalThis.turnstile;
  }
});

test("navigating off the submit page clears the token — a removed widget can't arm submit", async () => {
  const fake = installFakeTurnstile();
  try {
    const twoPage = {
      ...oneField,
      pages: [
        oneField.pages[0],
        { id: "p2", blocks: [{ id: "notes", kind: "short_text", label: "Notes" }] },
      ],
    };
    const { target } = mount(twoPage, { formId: "f1", client: fakeClient(), challenge });
    await tick();
    assert.equal(fake.widgets.length, 0, "no widget before the submit page");

    const input = target.querySelector('[data-field="name"] input');
    input.value = "Ada";
    dispatch(input, "input");
    await tick();
    dispatch(target.querySelector("form"), "submit"); // valid → advance to p2
    await tick();
    assert.equal(fake.widgets.length, 1, "widget mounts on the submit page");
    fake.widgets[0].options.callback("tok-stale");
    await tick();
    assert.equal(target.querySelector(".fillo-button--primary").disabled, false);

    // Back: the widget unmounts, and its token must go with it.
    dispatch(target.querySelector(".fillo-button--ghost"), "click");
    await tick();
    assert.deepEqual(fake.removes, [fake.widgets[0].id], "unmount removed the widget");

    // Return to the submit page: a NEW widget instance renders and submit is
    // disabled until it is re-solved — never armed by the removed widget's token.
    dispatch(target.querySelector("form"), "submit");
    await tick();
    assert.equal(fake.widgets.length, 2, "a fresh widget renders on return");
    assert.equal(
      target.querySelector(".fillo-button--primary").disabled,
      true,
      "stale token cleared on unmount — the human must re-solve",
    );
  } finally {
    delete globalThis.turnstile;
  }
});

test("destroy() removes the Cloudflare widget via the turnstile API", async () => {
  const fake = installFakeTurnstile();
  try {
    const { instance } = mount(oneField, { formId: "f1", client: fakeClient(), challenge });
    await tick();
    assert.equal(fake.widgets.length, 1);
    instance.destroy();
    assert.deepEqual(
      fake.removes,
      [fake.widgets[0].id],
      "destroy() removed the widget via the turnstile API",
    );
  } finally {
    delete globalThis.turnstile;
  }
});

// ---------------------------------------------------------------------------
// Bridge mode (challenge.bridgeUrl): the widget runs in a Fillo-hosted iframe
// and talks over postMessage — the host page loads ZERO Cloudflare JS.
// ---------------------------------------------------------------------------

const BRIDGE_ORIGIN = "https://bridge.fillo.test";
const bridgeChallenge = {
  provider: "turnstile",
  siteKey: "sitekey-test",
  bridgeUrl: `${BRIDGE_ORIGIN}/embed/challenge`,
};

/** Dispatch a message as if it came from the bridge frame. */
async function bridgeMessage(iframe, data, origin = BRIDGE_ORIGIN, source) {
  window.dispatchEvent(
    new dom.window.MessageEvent("message", {
      data,
      origin,
      source: source ?? iframe.contentWindow,
    }),
  );
  await tick();
  await tick(); // queueRender flushes on a micro/macro-task hop
}

test("bridge mode: iframe with origin/theme/cdata params, zero host-page Cloudflare JS; only the frame's messages arm submit", async () => {
  const submits = [];
  const client = fakeClient({
    submit: async (formId, data, meta) => {
      submits.push({ formId, data, meta });
      return { ok: true, responseId: "r-bridge" };
    },
  });
  const { target, instance } = mount(oneField, {
    formId: "f-bridge",
    client,
    challenge: bridgeChallenge,
    challengeTheme: "dark",
  });
  await tick();

  const iframe = target.querySelector("iframe.fillo-turnstile-frame");
  assert.ok(iframe, "bridge iframe rendered");
  const src = new URL(iframe.getAttribute("src"));
  assert.equal(src.origin, BRIDGE_ORIGIN);
  assert.equal(src.pathname, "/embed/challenge");
  assert.ok(src.searchParams.get("origin"), "embedder origin forwarded to the bridge");
  assert.equal(src.searchParams.get("theme"), "dark", "host-set theme forwarded");
  assert.equal(src.searchParams.get("cdata"), "f-bridge", "form id rides cdata");
  assert.equal(iframe.getAttribute("title"), "Human verification");
  assert.equal(
    document.getElementById("fillo-turnstile-script"),
    null,
    "bridge mode injects no Cloudflare script into the host page",
  );

  const nameInput = target.querySelector('[data-field="name"] input');
  nameInput.value = "Ada";
  dispatch(nameInput, "input");
  await tick();
  const primary = () => target.querySelector(".fillo-button--primary");
  assert.equal(primary().disabled, true, "submit waits for the human check");

  // Spoofed messages must not arm submit.
  await bridgeMessage(iframe, { type: "fillo:challenge:token", token: "tok-evil" }, "https://evil.test");
  assert.equal(primary().disabled, true, "wrong-origin token ignored");
  await bridgeMessage(iframe, { type: "fillo:challenge:token", token: "tok-evil" }, BRIDGE_ORIGIN, window);
  assert.equal(primary().disabled, true, "wrong-source token ignored");

  await bridgeMessage(iframe, { type: "fillo:challenge:ready" });
  await bridgeMessage(iframe, { type: "fillo:challenge:token", token: "tok-bridge" });
  assert.equal(primary().disabled, false, "bridge token enables submit");

  dispatch(target.querySelector("form"), "submit");
  await tick();
  await tick();
  assert.equal(submits.length, 1, "one submission");
  assert.equal(submits[0].meta.challengeToken, "tok-bridge", "bridge token rides the submit");
  instance.destroy();
});

test("bridge mode: expired clears the token; server 403 resets INTO the frame; error shows unavailable; destroy unwires", async () => {
  // The renderer re-attaches its persistent challenge container on every
  // render, and jsdom mints a NEW contentWindow per re-attach (real browsers
  // reload a moved iframe the same way — the bridge tolerates it by reading
  // contentWindow live and letting the frame re-post its state). Tests need a
  // STABLE window to spy on, so stub the accessor for this test's lifetime.
  const cwDescriptor = Object.getOwnPropertyDescriptor(
    dom.window.HTMLIFrameElement.prototype,
    "contentWindow",
  );
  const posted = [];
  const stubWindow = {
    postMessage: (data, targetOrigin) => posted.push({ data, targetOrigin }),
  };
  Object.defineProperty(dom.window.HTMLIFrameElement.prototype, "contentWindow", {
    configurable: true,
    get: () => stubWindow,
  });
  try {
  const err = new Error("Please complete the verification check.");
  err.name = "FilloError";
  err.status = 403;
  err.code = "challenge_failed";
  const client = fakeClient({
    submit: async () => {
      throw err;
    },
  });
  const { target, instance } = mount(oneField, {
    formId: "f-bridge-2",
    client,
    challenge: bridgeChallenge,
  });
  await tick();
  const iframe = target.querySelector("iframe.fillo-turnstile-frame");
  assert.equal(
    new URL(iframe.getAttribute("src")).searchParams.get("theme"),
    "auto",
    "theme defaults to auto",
  );
  const nameInput = target.querySelector('[data-field="name"] input');
  nameInput.value = "Ada";
  dispatch(nameInput, "input");
  await tick();
  const primary = () => target.querySelector(".fillo-button--primary");

  await bridgeMessage(iframe, { type: "fillo:challenge:token", token: "tok-1" });
  assert.equal(primary().disabled, false);
  await bridgeMessage(iframe, { type: "fillo:challenge:expired" });
  assert.equal(primary().disabled, true, "expired token cleared");

  // Server-side rejection: reset must clear our token AND re-arm the frame.
  posted.length = 0;
  await bridgeMessage(iframe, { type: "fillo:challenge:token", token: "tok-2" });
  dispatch(target.querySelector("form"), "submit");
  await tick();
  await tick();
  assert.deepEqual(
    posted,
    [{ data: { type: "fillo:challenge:reset" }, targetOrigin: BRIDGE_ORIGIN }],
    "403 challenge_failed posts a reset into the bridge frame",
  );
  assert.equal(primary().disabled, true, "rejected token cleared — must re-solve");

  await bridgeMessage(iframe, { type: "fillo:challenge:error", code: "not_configured" });
  assert.ok(
    target.querySelector(".fillo-turnstile-error"),
    "bridge error surfaces the unavailable state",
  );

  // destroy() unwires the message listener: a late token must not resurrect
  // state (nothing to assert visually — this guards against listener leaks
  // throwing after teardown).
  instance.destroy();
  await bridgeMessage(iframe, { type: "fillo:challenge:token", token: "tok-late" });
  } finally {
    Object.defineProperty(dom.window.HTMLIFrameElement.prototype, "contentWindow", cwDescriptor);
  }
});

test("interaction-only (default): frame starts collapsed, expands on interactive, folds after solve", async () => {
  const { target, instance } = mount(oneField, {
    formId: "f-inv",
    client: fakeClient(),
    challenge: bridgeChallenge,
  });
  await tick();
  const iframe = target.querySelector("iframe.fillo-turnstile-frame");
  assert.equal(
    new URL(iframe.getAttribute("src")).searchParams.get("appearance"),
    "interaction-only",
  );
  assert.equal(iframe.getAttribute("height"), "0", "collapsed while the check runs invisibly");
  assert.equal(iframe.getAttribute("aria-hidden"), "true");

  await bridgeMessage(iframe, { type: "fillo:challenge:interactive" });
  assert.equal(iframe.getAttribute("height"), "65", "expands for the interactive challenge");
  assert.equal(iframe.getAttribute("aria-hidden"), null);

  const nameInput = target.querySelector('[data-field="name"] input');
  nameInput.value = "Ada";
  dispatch(nameInput, "input");
  await tick();
  await bridgeMessage(iframe, { type: "fillo:challenge:token", token: "tok-inv" });
  assert.equal(iframe.getAttribute("height"), "0", "folds away after the solve");
  assert.equal(
    target.querySelector(".fillo-button--primary").disabled,
    false,
    "invisible solve still arms submit",
  );
  instance.destroy();
});

test('challengeAppearance="always" keeps the classic visible box', async () => {
  const { target, instance } = mount(oneField, {
    formId: "f-vis",
    client: fakeClient(),
    challenge: bridgeChallenge,
    challengeAppearance: "always",
  });
  await tick();
  const iframe = target.querySelector("iframe.fillo-turnstile-frame");
  assert.equal(new URL(iframe.getAttribute("src")).searchParams.get("appearance"), "always");
  assert.equal(iframe.getAttribute("height"), "65", "visible from the start");
  instance.destroy();
});
