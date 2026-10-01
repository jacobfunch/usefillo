import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// Globals must exist before React DOM is imported.
const dom = new JSDOM("<!DOCTYPE html><body></body>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
globalThis.Event = dom.window.Event;
globalThis.Node = dom.window.Node;
// React act() opt-in — updates are driven manually below.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { FilloForm, createClient } = await import("../dist/index.js");

const challenge = { provider: "turnstile", siteKey: "sitekey-test" };

const form = {
  version: 1,
  title: "T",
  settings: {},
  pages: [
    {
      id: "p1",
      blocks: [{ id: "name", kind: "short_text", label: "Name", required: true }],
    },
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

async function mount(element) {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const root = createRoot(target);
  await act(async () => root.render(element));
  return { target, root, rerender: (el) => act(async () => root.render(el)) };
}

// The widget renders in an effect after the (already-resolved) loader promise —
// flush a macrotask so it lands before asserting.
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

// React dedupes direct .value writes via its value tracker — go through the
// native setter so the input event actually reaches onChange.
const nativeValueSetter = Object.getOwnPropertyDescriptor(
  dom.window.HTMLInputElement.prototype,
  "value",
).set;
async function type(input, value) {
  await act(async () => {
    nativeValueSetter.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

/** Fake Cloudflare global: captures each render's options so tests can drive
 * the widget callbacks (solve/expire/error) with no third-party script. With
 * the global pre-set, the loader short-circuits and injects no <script>. */
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

test("challenge happy path: solve → token rides meta.challengeToken → 201 success screen", async () => {
  const fake = installFakeTurnstile();
  try {
    const requests = [];
    const client = createClient({
      baseUrl: "https://challenge.test",
      fetch: async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ id: "r-challenge" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const { target } = await mount(
      React.createElement(FilloForm, { form, formId: "f-challenge", client, challenge }),
    );
    await flush();

    assert.ok(target.querySelector('[data-fillo="turnstile-slot"]'), "widget slot rendered");
    assert.equal(fake.widgets.length, 1, "widget rendered once");
    assert.equal(fake.widgets[0].options.sitekey, "sitekey-test");
    const submitBtn = target.querySelector('button[type="submit"]');
    assert.equal(submitBtn.disabled, true, "submit waits for the human check");

    await type(target.querySelector('[data-field="name"] input'), "Ada");
    assert.equal(submitBtn.disabled, true, "answers alone don't enable submit");
    await act(async () => fake.widgets[0].options.callback("tok-solved"));
    assert.equal(submitBtn.disabled, false, "solved challenge enables submit");

    await act(async () => {
      target.querySelector("form").dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await flush();
    // The client also opens a funnel session / reports progress — pick out the
    // one submission POST.
    const submits = requests.filter((r) => /\/api\/v1\/forms\/f-challenge\/responses$/.test(r.url));
    assert.equal(submits.length, 1);
    assert.equal(submits[0].body.meta.challengeToken, "tok-solved");
    assert.equal(submits[0].body.data.name, "Ada");
    assert.ok(target.querySelector(".fillo-form--success"), "201 shows the success screen");
  } finally {
    delete globalThis.turnstile;
  }
});

test("expired-callback clears the token: submit disables again and the widget resets", async () => {
  const fake = installFakeTurnstile();
  try {
    const { target } = await mount(
      React.createElement(FilloForm, { form, formId: "f1", client: fakeClient(), challenge }),
    );
    await flush();
    const submitBtn = target.querySelector('button[type="submit"]');
    await type(target.querySelector('[data-field="name"] input'), "Ada");
    await act(async () => fake.widgets[0].options.callback("tok-1"));
    assert.equal(submitBtn.disabled, false);

    await act(async () => fake.widgets[0].options["expired-callback"]());
    assert.equal(submitBtn.disabled, true, "an aged-out token no longer enables submit");
    assert.deepEqual(fake.resets, [fake.widgets[0].id], "widget re-armed for a fresh solve");
  } finally {
    delete globalThis.turnstile;
  }
});

test("script-load failure removes the dead <script>; a second mount injects a fresh one", async () => {
  // No fake global: the loader must inject the real script tag.
  delete globalThis.turnstile;
  const first = await mount(
    React.createElement(FilloForm, { form, formId: "f1", client: fakeClient(), challenge }),
  );
  const firstScript = document.getElementById("fillo-turnstile-script");
  assert.ok(firstScript, "loader injected the Cloudflare script");
  assert.equal(firstScript.parentNode, document.head);

  await act(async () => {
    firstScript.dispatchEvent(new dom.window.Event("error"));
  });
  assert.equal(
    document.getElementById("fillo-turnstile-script"),
    null,
    "dead script removed from <head>",
  );
  assert.match(
    first.target.querySelector(".fillo-turnstile-error").textContent,
    /verification check couldn't load/i,
  );
  await act(async () => first.root.unmount());

  // The cached promise was cleared with the dead node, so a later mount
  // injects a FRESH element and actually re-fetches — instead of re-finding
  // the corpse and hanging on listeners that never fire.
  const second = await mount(
    React.createElement(FilloForm, { form, formId: "f1", client: fakeClient(), challenge }),
  );
  const secondScript = document.getElementById("fillo-turnstile-script");
  assert.ok(secondScript, "second mount re-fetches the script");
  assert.notEqual(secondScript, firstScript, "a fresh node, not the removed one");
  // Fail this load too so the module-level cache is clean for later tests.
  await act(async () => {
    secondScript.dispatchEvent(new dom.window.Event("error"));
  });
  await act(async () => second.root.unmount());
});

test("navigating off the submit page clears the token — a removed widget can't arm submit", async () => {
  const fake = installFakeTurnstile();
  try {
    const twoPage = {
      ...form,
      pages: [
        form.pages[0],
        { id: "p2", blocks: [{ id: "notes", kind: "short_text", label: "Notes" }] },
      ],
    };
    const { target } = await mount(
      React.createElement(FilloForm, { form: twoPage, formId: "f1", client: fakeClient(), challenge }),
    );
    await flush();
    assert.equal(fake.widgets.length, 0, "no widget before the submit page");

    await type(target.querySelector('[data-field="name"] input'), "Ada");
    await act(async () => {
      target.querySelector("form").dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await flush();
    assert.equal(fake.widgets.length, 1, "widget mounts on the submit page");
    await act(async () => fake.widgets[0].options.callback("tok-stale"));
    assert.equal(target.querySelector('button[type="submit"]').disabled, false);

    // Back: the widget unmounts, and its token must go with it.
    await act(async () => {
      target.querySelector(".fillo-button--ghost").dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
    });
    assert.deepEqual(fake.removes, [fake.widgets[0].id], "unmount removed the widget");

    // Return to the submit page: a NEW widget instance renders and submit is
    // disabled until it is re-solved — never armed by the removed widget's token.
    await act(async () => {
      target.querySelector("form").dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await flush();
    assert.equal(fake.widgets.length, 2, "a fresh widget renders on return");
    assert.equal(
      target.querySelector('button[type="submit"]').disabled,
      true,
      "stale token cleared on unmount — the human must re-solve",
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
const bridgeMessage = (iframe, data, origin = BRIDGE_ORIGIN, source) =>
  act(async () => {
    window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        data,
        origin,
        source: source ?? iframe.contentWindow,
      }),
    );
  });

test("bridge mode: iframe with origin/theme/cdata params, zero host-page Cloudflare JS; only the frame's messages arm submit", async () => {
  const requests = [];
  const client = createClient({
    baseUrl: "https://challenge.test",
    fetch: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ id: "r-bridge" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const { target, root } = await mount(
    React.createElement(FilloForm, {
      form,
      formId: "f-bridge",
      client,
      challenge: bridgeChallenge,
      challengeTheme: "dark",
    }),
  );
  await flush();

  const iframe = target.querySelector("iframe.fillo-turnstile-frame");
  assert.ok(iframe, "bridge iframe rendered");
  const src = new URL(iframe.getAttribute("src"));
  assert.equal(src.origin, BRIDGE_ORIGIN);
  assert.equal(src.pathname, "/embed/challenge");
  assert.ok(src.searchParams.get("origin"), "embedder origin forwarded to the bridge");
  assert.equal(src.searchParams.get("theme"), "dark", "host-set theme forwarded");
  assert.equal(src.searchParams.get("cdata"), "f-bridge", "form id rides cdata for the server binding");
  assert.equal(iframe.getAttribute("title"), "Human verification");
  assert.equal(
    document.getElementById("fillo-turnstile-script"),
    null,
    "bridge mode injects no Cloudflare script into the host page",
  );

  const submitBtn = target.querySelector('button[type="submit"]');
  await type(target.querySelector('[data-field="name"] input'), "Ada");
  assert.equal(submitBtn.disabled, true, "submit waits for the human check");

  // Spoofed messages must not arm submit: wrong origin, then right origin
  // but wrong source window.
  await bridgeMessage(iframe, { type: "fillo:challenge:token", token: "tok-evil" }, "https://evil.test");
  assert.equal(submitBtn.disabled, true, "wrong-origin token ignored");
  await bridgeMessage(iframe, { type: "fillo:challenge:token", token: "tok-evil" }, BRIDGE_ORIGIN, window);
  assert.equal(submitBtn.disabled, true, "wrong-source token ignored");

  await bridgeMessage(iframe, { type: "fillo:challenge:ready" });
  await bridgeMessage(iframe, { type: "fillo:challenge:token", token: "tok-bridge" });
  assert.equal(submitBtn.disabled, false, "bridge token enables submit");

  await act(async () => {
    target.querySelector("form").dispatchEvent(
      new dom.window.Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  await flush();
  const submits = requests.filter((r) => /\/api\/v1\/forms\/f-bridge\/responses$/.test(r.url));
  assert.equal(submits.length, 1);
  assert.equal(submits[0].body.meta.challengeToken, "tok-bridge", "bridge token rides the submit");
  assert.ok(target.querySelector(".fillo-form--success"));
  await act(async () => root.unmount());
});

test("bridge mode: expired clears the token; error shows the unavailable state; a server 403 resets INTO the frame", async () => {
  let submitCount = 0;
  const client = createClient({
    baseUrl: "https://challenge.test",
    fetch: async (url, init) => {
      if (/\/responses$/.test(String(url))) {
        submitCount++;
        return new Response(
          JSON.stringify({ error: "Please complete the verification check.", code: "challenge_failed" }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ id: "x" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const { target, root } = await mount(
    React.createElement(FilloForm, {
      form,
      formId: "f-bridge-2",
      client,
      challenge: bridgeChallenge,
    }),
  );
  await flush();
  const iframe = target.querySelector("iframe.fillo-turnstile-frame");
  assert.equal(
    new URL(iframe.getAttribute("src")).searchParams.get("theme"),
    "auto",
    "theme defaults to auto",
  );
  const submitBtn = target.querySelector('button[type="submit"]');
  await type(target.querySelector('[data-field="name"] input'), "Ada");

  // expired: token no longer arms submit (the bridge re-arms its own widget).
  await bridgeMessage(iframe, { type: "fillo:challenge:token", token: "tok-1" });
  assert.equal(submitBtn.disabled, false);
  await bridgeMessage(iframe, { type: "fillo:challenge:expired" });
  assert.equal(submitBtn.disabled, true, "expired token cleared");

  // Server-side rejection: the renderer's reset must clear our token AND
  // tell the bridge frame to re-arm.
  const posted = [];
  iframe.contentWindow.postMessage = (data, targetOrigin) => posted.push({ data, targetOrigin });
  await bridgeMessage(iframe, { type: "fillo:challenge:token", token: "tok-2" });
  await act(async () => {
    target.querySelector("form").dispatchEvent(
      new dom.window.Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  await flush();
  assert.equal(submitCount, 1, "submit reached the server once");
  assert.deepEqual(
    posted,
    [{ data: { type: "fillo:challenge:reset" }, targetOrigin: BRIDGE_ORIGIN }],
    "403 challenge_failed posts a reset into the bridge frame",
  );
  assert.equal(submitBtn.disabled, true, "rejected token cleared — must re-solve");

  // Bridge reports an unrecoverable error: unavailable message, submit stays off.
  await bridgeMessage(iframe, { type: "fillo:challenge:error", code: "not_configured" });
  assert.match(
    target.querySelector(".fillo-turnstile-error").textContent,
    /verification check couldn't load/i,
  );
  await act(async () => root.unmount());
});

test("interaction-only (default): frame starts collapsed, expands when Cloudflare needs a click, folds after solve", async () => {
  const { target, root } = await mount(
    React.createElement(FilloForm, {
      form,
      formId: "f-inv",
      client: fakeClient(),
      challenge: bridgeChallenge,
    }),
  );
  await flush();
  const iframe = target.querySelector("iframe.fillo-turnstile-frame");
  assert.equal(
    new URL(iframe.getAttribute("src")).searchParams.get("appearance"),
    "interaction-only",
    "default appearance rides the bridge URL",
  );
  assert.equal(iframe.getAttribute("height"), "0", "collapsed while the check runs invisibly");
  assert.equal(iframe.getAttribute("aria-hidden"), "true");
  const container = target.querySelector('[data-fillo="turnstile"]');
  assert.equal(container.getAttribute("data-fillo-challenge-visible"), "false");

  // Cloudflare needs the visitor: the box appears.
  await bridgeMessage(iframe, { type: "fillo:challenge:interactive" });
  assert.equal(iframe.getAttribute("height"), "65", "expands for the interactive challenge");
  assert.equal(iframe.getAttribute("aria-hidden"), null);
  assert.equal(container.getAttribute("data-fillo-challenge-visible"), "true");

  // Solved: it folds away and the token still arms submit.
  await type(target.querySelector('[data-field="name"] input'), "Ada");
  await bridgeMessage(iframe, { type: "fillo:challenge:token", token: "tok-inv" });
  assert.equal(iframe.getAttribute("height"), "0", "folds away after the solve");
  assert.equal(
    target.querySelector('button[type="submit"]').disabled,
    false,
    "invisible solve still arms submit",
  );
  await act(async () => root.unmount());
});

test('challengeAppearance="always" keeps the classic visible box', async () => {
  const { target, root } = await mount(
    React.createElement(FilloForm, {
      form,
      formId: "f-vis",
      client: fakeClient(),
      challenge: bridgeChallenge,
      challengeAppearance: "always",
    }),
  );
  await flush();
  const iframe = target.querySelector("iframe.fillo-turnstile-frame");
  assert.equal(new URL(iframe.getAttribute("src")).searchParams.get("appearance"), "always");
  assert.equal(iframe.getAttribute("height"), "65", "visible from the start");
  assert.equal(iframe.getAttribute("aria-hidden"), null);
  await act(async () => root.unmount());
});
