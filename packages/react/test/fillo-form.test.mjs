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
globalThis.File = dom.window.File;
// React act() opt-in — updates are driven manually below.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { FilloError, FilloForm, FilloProvider, FormField, useFillo } = await import(
  "../dist/index.js"
);

const form = {
  version: 1,
  title: "T",
  settings: {},
  pages: [
    {
      id: "p1",
      blocks: [
        { id: "name", kind: "short_text", label: "Name", required: true },
        {
          id: "detail",
          kind: "short_text",
          label: "Detail",
          visibleIf: [{ fieldId: "name", op: "eq", value: "bug" }],
        },
      ],
    },
  ],
};

const uploadForm = {
  version: 1,
  title: "Upload",
  settings: {},
  pages: [
    {
      id: "p1",
      blocks: [
        { id: "message", kind: "short_text", label: "Message" },
        { id: "attachment", kind: "file_upload", label: "Attachment", required: true },
      ],
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

test("a plain schema without formId fails before rendering a half-connected form", async () => {
  let observed;
  const { target } = await mount(
    React.createElement(FilloForm, {
      form,
      client: fakeClient(),
      onError: (error) => {
        observed = error;
      },
      renderError: (error) =>
        React.createElement("output", { "data-code": error.code }, error.message),
    }),
  );

  assert.equal(target.querySelector("form"), null);
  assert.equal(target.querySelector("output")?.getAttribute("data-code"), "form_target_required");
  assert.match(target.textContent, /Pass formId with the schema/);
  assert.equal(observed?.code, "form_target_required");
});

test("a targeted inline form exposes its resolved id for embed verification", async () => {
  const { target } = await mount(
    React.createElement(FilloForm, { form, formId: "f-visible-target", client: fakeClient() }),
  );
  assert.equal(
    target.querySelector('[data-fillo="root"]')?.getAttribute("data-fillo-form-id"),
    "f-visible-target",
  );
});

test("changing renderer strings updates later submit failures without remounting", async () => {
  const failure = new FilloError("internal server detail", 503);
  const client = fakeClient({
    submit: async () => {
      throw failure;
    },
  });
  const oldProps = {
    form,
    formId: "f-locale-update",
    client,
    strings: { submitFailed: "Old locale" },
    onError: () => {},
  };
  const { target, rerender } = await mount(React.createElement(FilloForm, oldProps));
  await type(target.querySelector('[data-field="name"] input'), "Ada");
  await rerender(
    React.createElement(FilloForm, {
      ...oldProps,
      strings: { submitFailed: "Nouvelle copie sûre" },
    }),
  );

  await act(async () => {
    target
      .querySelector("form")
      .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
  });

  assert.equal(target.querySelector(".fillo-submit-error").textContent, "Nouvelle copie sûre");
  assert.doesNotMatch(target.textContent, /internal server detail|Old locale/u);
});

test("FilloProvider reports the same missing-target error before exposing children", async () => {
  let observed;
  const { target } = await mount(
    React.createElement(
      FilloProvider,
      {
        form,
        client: fakeClient(),
        onError: (error) => {
          observed = error;
        },
        renderError: (error) =>
          React.createElement("output", { "data-code": error.code }, error.message),
      },
      React.createElement("span", { "data-child": "" }, "unsafe child"),
    ),
  );
  assert.equal(target.querySelector("[data-child]"), null);
  assert.equal(target.querySelector("output")?.getAttribute("data-code"), "form_target_required");
  assert.equal(observed?.code, "form_target_required");
});

test("honeypot is hidden inline — no stylesheet required", async () => {
  const { target } = await mount(
    React.createElement(FilloForm, { form, formId: "f-test", client: fakeClient() }),
  );
  const hp = target.querySelector('input[name="fillo_hp_field"]');
  assert.ok(hp, "honeypot rendered");
  assert.equal(hp.style.position, "absolute");
  assert.equal(hp.style.left, "-9999px");
  assert.notEqual(hp.style.display, "none", "display:none would tip off bots");
  assert.equal(hp.getAttribute("aria-hidden"), "true");
});

test("honeypot reads the live DOM value even when a bot dispatches no input event", async () => {
  let meta = null;
  const client = fakeClient({
    submit: async (_formId, _data, submittedMeta) => {
      meta = submittedMeta;
      return { ok: true, responseId: "r1" };
    },
  });
  const { target } = await mount(React.createElement(FilloForm, { form, formId: "f1", client }));
  await type(target.querySelector('[data-field="name"] input'), "Ada");
  target.querySelector('input[name="fillo_hp_field"]').value = "bot-filled";
  await act(async () => {
    target
      .querySelector("form")
      .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  assert.equal(meta?.hp, "bot-filled");
});

test("failed submit renders a visible alert and keeps the answers", async () => {
  const client = fakeClient({
    submit: async () => {
      const err = new Error("Form not found — check the form id");
      err.name = "FilloError";
      err.status = 404;
      throw err;
    },
  });
  const { target } = await mount(React.createElement(FilloForm, { form, formId: "f1", client }));
  const input = target.querySelector(".fillo-blocks input");
  await type(input, "Ada");
  const formEl = target.querySelector("form");
  await act(async () => {
    formEl.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  const alert = target.querySelector(".fillo-submit-error");
  assert.ok(alert, "inline alert rendered");
  assert.match(alert.textContent, /Form not found/);
  assert.equal(target.querySelector(".fillo-blocks input").value, "Ada", "answers intact");
});

test("FormField does not render logic-hidden fields", async () => {
  const { target } = await mount(
    React.createElement(
      FilloProvider,
      { form, formId: "f-test", client: fakeClient(), surface: "headless" },
      React.createElement(FormField, { id: "name" }),
      React.createElement(FormField, { id: "detail" }),
    ),
  );
  assert.equal(target.querySelectorAll("input:not([name=fillo_hp_field])").length, 1);
  const input = target.querySelector("input");
  await type(input, "bug");
  assert.equal(
    target.querySelectorAll("input:not([name=fillo_hp_field])").length,
    2,
    "revealed once the condition holds",
  );
});

// Everything a keyboard or pointer could reach. :disabled (not [disabled])
// so controls disabled through the fieldset ancestor count as disabled too.
const FOCUSABLE =
  'a[href], [tabindex]:not([tabindex="-1"]), ' +
  "input:not(:disabled), button:not(:disabled), select:not(:disabled), textarea:not(:disabled)";

test("production draft renders a safe display-only form behind the not-open state", async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    let submitCalls = 0;
    const codeForm = { id: "contact", schema: form, __filloCodeForm: true };
    const client = fakeClient({
      syncForm: async () => ({ formId: "f9", slug: "contact-f9", status: "draft" }),
      submit: async () => {
        submitCalls += 1;
        return { ok: true, responseId: "never" };
      },
    });
    const { target } = await mount(React.createElement(FilloForm, { form: codeForm, client }));
    // Sync resolves async — flush the effect + state update.
    await act(async () => new Promise((r) => setTimeout(r, 10)));

    // Honest chrome: the default stylesheet presents the friendly state while
    // the real form remains safely display-only in the DOM.
    assert.ok(target.querySelector(".fillo-form--not-open"), "not-open state shown");
    const card = target.querySelector(".fillo-not-open-card");
    assert.match(card.querySelector(".fillo-not-open-title").textContent, /isn't open yet/);
    assert.match(
      card.querySelector(".fillo-not-open-body").textContent,
      /form owner is still setting things up/,
    );
    assert.equal(card.getAttribute("role"), "status");
    assert.match(target.textContent, /Name/, "the real schema renders in the preview");

    // Impossible to fill: no form element exists at all, the preview is inert
    // and aria-hidden, every control sits in a natively disabled fieldset, and
    // nothing inside is focusable.
    assert.equal(target.querySelector("form"), null, "no submittable form element");
    const preview = target.querySelector(".fillo-not-open-preview");
    assert.equal(preview.getAttribute("aria-hidden"), "true");
    assert.ok(preview.hasAttribute("inert"), "preview wrapper is inert");
    const controls = preview.querySelectorAll("input, button, select, textarea");
    assert.ok(controls.length > 0, "the preview really renders the fields");
    for (const control of controls) {
      assert.ok(control.closest("fieldset[disabled]"), `${control.tagName} natively disabled`);
    }
    assert.equal(preview.querySelectorAll(FOCUSABLE).length, 0, "zero focusable elements");
    assert.equal(preview.querySelector('input[name="fillo_hp_field"]'), null, "no honeypot trap");

    // The submit path stays unreachable even for a synthetic click.
    const button = preview.querySelector('button[type="submit"]');
    await act(async () => {
      button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    assert.equal(submitCalls, 0, "no submit can ever fire from the preview");
  } finally {
    process.env.NODE_ENV = prev;
  }
});

test("a published code form the server marks expired shows the closed-flavor card", async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const codeForm = { id: "expired-overlay-react", schema: form, __filloCodeForm: true };
    const client = fakeClient({
      syncForm: async () => ({
        formId: "f-expired-react",
        slug: "expired-overlay-react",
        status: "published",
        accepting: false,
        acceptingReason: "expired",
      }),
    });
    const { target } = await mount(React.createElement(FilloForm, { form: codeForm, client }));
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    assert.ok(target.querySelector(".fillo-form--not-open"));
    assert.match(target.querySelector(".fillo-not-open-title").textContent, /Responses are closed/);
    assert.match(
      target.querySelector(".fillo-not-open-body").textContent,
      /no longer accepting responses/,
    );
    assert.equal(target.querySelector("form"), null, "no fillable form");
    assert.equal(
      target.querySelector(".fillo-not-open-preview").querySelectorAll(FOCUSABLE).length,
      0,
    );
  } finally {
    process.env.NODE_ENV = prev;
  }
});

test("a capped verdict also closes; renderError still wins over the overlay", async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    let rendered = null;
    const codeForm = { id: "capped-overlay-react", schema: form, __filloCodeForm: true };
    const client = fakeClient({
      syncForm: async () => ({
        formId: "f-capped-react",
        slug: "capped-overlay-react",
        status: "published",
        accepting: false,
        acceptingReason: "capped",
      }),
    });
    const { target } = await mount(
      React.createElement(FilloForm, {
        form: codeForm,
        client,
        renderError: (error) => {
          rendered = error;
          return React.createElement("div", { id: "host-not-accepting" }, "Host-owned state");
        },
      }),
    );
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    assert.equal(target.querySelector(".fillo-form--not-open"), null, "renderError wins");
    assert.equal(target.querySelector("#host-not-accepting").textContent, "Host-owned state");
    assert.equal(rendered?.status, 403);
    assert.equal(rendered?.code, "capped");
    assert.match(rendered?.message, /no longer accepting/);
  } finally {
    process.env.NODE_ENV = prev;
  }
});

test("renderError also wins over the draft overlay with the unchanged 403 error", async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    let rendered = null;
    const codeForm = { id: "draft-render-error-overlay", schema: form, __filloCodeForm: true };
    const client = fakeClient({
      syncForm: async () => ({
        formId: "f-dre",
        slug: "draft-render-error-overlay",
        status: "draft",
      }),
    });
    const { target } = await mount(
      React.createElement(FilloForm, {
        form: codeForm,
        client,
        renderError: (error) => {
          rendered = error;
          return React.createElement("div", { id: "host-draft" }, "Host draft UI");
        },
      }),
    );
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    assert.equal(target.querySelector(".fillo-form--not-open"), null, "renderError wins");
    assert.equal(target.querySelector("#host-draft").textContent, "Host draft UI");
    assert.equal(rendered?.status, 403);
    assert.match(rendered?.message, /isn't published yet/);
  } finally {
    process.env.NODE_ENV = prev;
  }
});

test("a hosted form whose envelope says accepting:false gets the same overlay", async () => {
  const client = fakeClient({
    getForm: async () => ({
      id: "f-hosted-not-accepting",
      slug: "hosted-not-accepting",
      schema: form,
      theme: null,
      accepting: false,
      acceptingReason: "storage_full",
    }),
  });
  const { target } = await mount(
    React.createElement(FilloForm, { formId: "f-hosted-not-accepting", client }),
  );
  await act(async () => new Promise((r) => setTimeout(r, 10)));
  assert.ok(target.querySelector(".fillo-form--not-open"));
  assert.match(target.querySelector(".fillo-not-open-title").textContent, /Responses are closed/);
  assert.equal(target.querySelector("form"), null, "no fillable form");
  assert.equal(
    target.querySelector(".fillo-not-open-preview").querySelectorAll(FOCUSABLE).length,
    0,
  );
  assert.equal(target.querySelector(".fillo-report-abuse"), null, "no report link is injected");
});

test("a hosted not-accepting envelope honors renderError like a code form", async () => {
  let rendered = null;
  const client = fakeClient({
    getForm: async () => ({
      id: "f-hosted-render-error",
      slug: "hosted-render-error",
      schema: form,
      theme: null,
      accepting: false,
      acceptingReason: "expired",
    }),
  });
  const { target } = await mount(
    React.createElement(FilloForm, {
      formId: "f-hosted-render-error",
      client,
      renderError: (error) => {
        rendered = error;
        return React.createElement("div", { id: "hosted-render-error" }, "Host-owned state");
      },
    }),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));

  assert.equal(target.querySelector(".fillo-form--not-open"), null);
  assert.equal(target.querySelector("#hosted-render-error").textContent, "Host-owned state");
  assert.equal(rendered?.status, 403);
  assert.equal(rendered?.code, "expired");
});

test("a hosted optional-upload form disables only uploads when storage is unavailable", async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const optionalUpload = {
    version: 1,
    title: "Support",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [
          { id: "message", kind: "short_text", label: "Message" },
          { id: "attachment", kind: "file_upload", label: "Attachment" },
        ],
      },
    ],
  };
  try {
    const client = fakeClient({
      getForm: async () => ({
        id: "f-hosted-optional-upload",
        slug: "hosted-optional-upload",
        schema: optionalUpload,
        theme: null,
        accepting: true,
        uploadsAvailable: false,
      }),
    });
    const { target } = await mount(
      React.createElement(FilloForm, { formId: "f-hosted-optional-upload", client }),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));

    assert.ok(target.querySelector("form"), "ordinary answers remain fillable");
    assert.equal(target.querySelector('input[type="text"]').disabled, false);
    assert.equal(target.querySelector('input[type="file"]').disabled, true);
    assert.match(target.textContent, /Uploads are temporarily unavailable/);
  } finally {
    process.env.NODE_ENV = prev;
  }
});

test("a hosted advisory storage warning does not disable uploads", async () => {
  const client = fakeClient({
    getForm: async () => ({
      id: "f-hosted-upload-advisory",
      slug: "hosted-upload-advisory",
      schema: uploadForm,
      theme: null,
      accepting: true,
      uploadsAvailable: true,
      warningCode: "transit_approaching_cap",
    }),
  });
  const { target } = await mount(
    React.createElement(FilloForm, { formId: "f-hosted-upload-advisory", client }),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));

  assert.equal(target.querySelector('input[type="file"]').disabled, false);
  assert.doesNotMatch(target.textContent, /Uploads are temporarily unavailable/);
});

test("a code form disables only new uploads when storage is hard-unavailable", async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const codeForm = { id: "upload-hard-full", schema: uploadForm, __filloCodeForm: true };
    const client = fakeClient({
      syncForm: async () => ({
        formId: "f-upload-hard-full",
        slug: "upload-hard-full",
        status: "published",
        accepting: true,
        uploadsAvailable: false,
      }),
    });
    const { target } = await mount(React.createElement(FilloForm, { form: codeForm, client }));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));

    assert.ok(target.querySelector("form"), "the response remains fillable");
    assert.equal(target.querySelector('input[type="text"]').disabled, false);
    assert.equal(target.querySelector('input[type="file"]').disabled, true);
  } finally {
    process.env.NODE_ENV = prev;
  }
});

test("an older server without the accepting field keeps the plain closed panel", async () => {
  const client = fakeClient({
    getForm: async () => ({
      id: "f-hosted-closed-legacy",
      slug: "hosted-closed-legacy",
      schema: form,
      theme: null,
      closed: true,
    }),
  });
  const { target } = await mount(
    React.createElement(FilloForm, { formId: "f-hosted-closed-legacy", client }),
  );
  await act(async () => new Promise((r) => setTimeout(r, 10)));
  assert.ok(target.querySelector(".fillo-form--closed"), "legacy closed panel unchanged");
  assert.equal(target.querySelector(".fillo-form--not-open"), null);
  assert.match(target.textContent, /no longer accepting responses/);
});

test("a production build on localhost keeps a draft rendered with the storage link", async () => {
  // vite preview / next start: NODE_ENV says production, but the page is
  // served from localhost — hostname detection must keep the dev path.
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  const prevInfo = console.info;
  process.env.NODE_ENV = "production";
  console.warn = () => {};
  console.info = () => {};
  dom.reconfigure({ url: "http://localhost:3000/" });
  try {
    const codeForm = { id: "contact-localhost", schema: form, __filloCodeForm: true };
    const client = fakeClient({
      syncForm: async () => ({
        formId: "f-localhost",
        slug: "contact-localhost",
        status: "draft",
        warning: "The form stays a draft until a storage destination is connected.",
        warningCode: "storage_required",
        warningUrl: "https://fillo.so/settings/storage",
      }),
    });
    const { target } = await mount(React.createElement(FilloForm, { form: codeForm, client }));
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    assert.ok(target.querySelector("form"), "the draft still renders locally");
    assert.equal(target.querySelector(".fillo-form--closed"), null, "no dead not-live panel");
    const notice = target.querySelector(".fillo-devwarning");
    assert.match(notice.textContent, /Draft form/);
    assert.match(notice.textContent, /Connect storage to publish/);
    assert.equal(
      notice.querySelector("a").getAttribute("href"),
      "https://fillo.so/settings/storage",
      "the notice links to the dashboard storage step",
    );
  } finally {
    dom.reconfigure({ url: "about:blank" });
    console.warn = prevWarn;
    console.info = prevInfo;
    process.env.NODE_ENV = prevEnv;
  }
});

test("the dev draft notice links to Publish when sync reports no storage warning", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevInfo = console.info;
  process.env.NODE_ENV = "development";
  console.info = () => {};
  try {
    const codeForm = { id: "contact-plain-draft", schema: form, __filloCodeForm: true };
    const client = fakeClient({
      baseUrl: "/api/fillo-proxy",
      syncForm: async () => ({
        formId: "f-plain",
        slug: "contact-plain",
        status: "draft",
        manageUrl: "https://fillo.so/forms/f-plain",
      }),
    });
    const { target } = await mount(React.createElement(FilloForm, { form: codeForm, client }));
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    const notice = target.querySelector(".fillo-devwarning");
    assert.match(notice.textContent, /Draft form/);
    assert.doesNotMatch(notice.textContent, /Connect storage/);
    assert.match(notice.textContent, /save no response until you publish/i);
    assert.equal(
      notice.querySelector("a")?.getAttribute("href"),
      "https://fillo.so/forms/f-plain",
      "a plain draft links directly to the dashboard Publish action",
    );
  } finally {
    console.info = prevInfo;
    process.env.NODE_ENV = prevEnv;
  }
});

test("the dev draft notice never linkifies a non-http(s) warning URL", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  const prevInfo = console.info;
  process.env.NODE_ENV = "development";
  console.warn = () => {};
  console.info = () => {};
  try {
    const codeForm = { id: "contact-bad-scheme", schema: form, __filloCodeForm: true };
    const client = fakeClient({
      syncForm: async () => ({
        formId: "f-bad-scheme",
        slug: "contact-bad-scheme",
        status: "draft",
        warning: "The form stays a draft until a storage destination is connected.",
        warningCode: "storage_required",
        // A compromised or misconfigured API must not put a javascript: URL
        // into a clickable href — the notice drops the link entirely.
        warningUrl: "javascript:alert(1)",
        manageUrl: "https://fillo.so/forms/f-bad-scheme",
      }),
    });
    const { target } = await mount(React.createElement(FilloForm, { form: codeForm, client }));
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    const notice = target.querySelector(".fillo-devwarning");
    assert.match(notice.textContent, /Draft form/);
    assert.equal(
      notice.querySelector("a")?.getAttribute("href"),
      "https://fillo.so/forms/f-bad-scheme",
      "the invalid blocker URL is replaced by the safe form overview",
    );
    assert.doesNotMatch(notice.textContent, /javascript:/);
  } finally {
    console.info = prevInfo;
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

test("SSR on localhost hydrates cleanly, then upgrades to the dev draft tree", async () => {
  // next start: the server pass can't see the hostname, so it must emit the
  // production tree (loading skeleton while sync is unresolved) and the client
  // must hydrate that SAME tree before upgrading to the dev path — otherwise
  // React reports a hydration mismatch and rebuilds the tree from scratch.
  //
  // Import the renderers BEFORE flipping NODE_ENV: react-dom picks its
  // development/production build at first require, and mixing a production
  // server renderer with the already-loaded development react crashes.
  const { renderToString } = await import("react-dom/server");
  const { hydrateRoot } = await import("react-dom/client");
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  const prevInfo = console.info;
  const prevError = console.error;
  process.env.NODE_ENV = "production";
  console.warn = () => {};
  console.info = () => {};
  const errors = [];
  console.error = (...args) => errors.push(args.join(" "));
  dom.reconfigure({ url: "http://localhost:3000/" });
  try {
    const codeForm = { id: "contact-hydrate", schema: form, __filloCodeForm: true };
    const client = fakeClient({
      syncForm: async () => ({ formId: "f-hydrate", slug: "contact-hydrate", status: "draft" }),
    });
    const element = React.createElement(FilloForm, { form: codeForm, client });

    const html = renderToString(element);
    assert.match(html, /fillo-form--loading/, "server pass renders the production tree");
    assert.doesNotMatch(html, /fillo-devwarning/, "no dev surfaces in server HTML");

    const target = document.createElement("div");
    document.body.appendChild(target);
    target.innerHTML = html;
    await act(async () => {
      hydrateRoot(target, element);
    });
    const mismatches = errors.filter((line) => /hydrat|did not match/i.test(line));
    assert.deepEqual(mismatches, [], "hydration pass matches the server HTML");

    // Post-hydration the check upgrades to the hostname-aware one, and once
    // sync resolves the draft keeps rendering locally with the dev notice.
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    assert.ok(target.querySelector("form"), "upgraded to the dev tree after hydration");
    assert.match(target.querySelector(".fillo-devwarning").textContent, /Draft form/);
  } finally {
    dom.reconfigure({ url: "about:blank" });
    console.error = prevError;
    console.info = prevInfo;
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

test("definitive code-form sync failures fail closed in production without leaking setup details", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  process.env.NODE_ENV = "production";
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const message = "Run `fillo forms push` with an fsync token, then try again.";
    const failure = new FilloError(message, 403, undefined, "trusted_sync_required");
    const observed = [];
    const codeForm = { id: "trusted-fatal-react", schema: form, __filloCodeForm: true };
    const client = fakeClient({
      key: "pk_trusted_fatal_react",
      baseUrl: "https://trusted-fatal-react.test",
      syncForm: async () => {
        throw failure;
      },
    });
    const { target } = await mount(
      React.createElement(FilloForm, {
        form: codeForm,
        client,
        onError: (error) => observed.push(error),
      }),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));

    assert.equal(target.querySelector("form"), null, "respondent cannot fill an unsyncable form");
    assert.ok(target.querySelector('.fillo-form--error[data-state="error"]'));
    assert.match(target.textContent, /could not be loaded/i);
    assert.doesNotMatch(target.textContent, /fillo forms push|fsync|trusted_sync_required/i);
    assert.equal(observed.at(-1), failure, "onError receives the exact error instance");
    assert.equal(observed.at(-1).code, "trusted_sync_required");
    assert.ok(
      warnings.some((line) => line.includes("trusted_sync_required") && line.includes(message)),
    );
  } finally {
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

test("renderError receives the full machine-coded sync failure", async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const failure = new FilloError(
      "Use a trusted deployment token.",
      403,
      undefined,
      "trusted_sync_required",
    );
    const codeForm = { id: "trusted-render-error-react", schema: form, __filloCodeForm: true };
    const client = fakeClient({
      key: "pk_trusted_render_error_react",
      baseUrl: "https://trusted-render-error-react.test",
      syncForm: async () => {
        throw failure;
      },
    });
    let rendered = null;
    const { target } = await mount(
      React.createElement(FilloForm, {
        form: codeForm,
        client,
        renderError: (error) => {
          rendered = error;
          return React.createElement(
            "div",
            { id: "custom-sync-error" },
            `${error.code}: ${error.message}`,
          );
        },
      }),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    assert.equal(rendered, failure);
    assert.match(target.querySelector("#custom-sync-error").textContent, /trusted_sync_required/);
  } finally {
    process.env.NODE_ENV = prev;
  }
});

test("development keeps transient mount failures fillable and retries successfully at submit", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  process.env.NODE_ENV = "development";
  console.warn = () => {};
  try {
    const observed = [];
    let syncCalls = 0;
    const submits = [];
    const codeForm = { id: "transient-react", schema: form, __filloCodeForm: true };
    const client = fakeClient({
      key: "pk_transient_react",
      baseUrl: "https://transient-react.test",
      syncForm: async () => {
        syncCalls += 1;
        if (syncCalls <= 3) throw new FilloError("Temporarily busy", 503, 0.001);
        return { formId: "f-transient-react", slug: "transient-react", status: "published" };
      },
      submit: async (formId, data) => {
        submits.push({ formId, data });
        return { ok: true, responseId: "r-transient" };
      },
    });
    const { target } = await mount(React.createElement(FilloForm, { form: codeForm, client }));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 15)));
    assert.ok(target.querySelector("form"), "transient failures do not fail closed");

    await type(target.querySelector('[data-field="name"] input'), "Ada");
    await act(async () => {
      target
        .querySelector("form")
        .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    });
    assert.equal(syncCalls, 4, "submit bypasses the failed mount cache and resolves again");
    assert.deepEqual(submits, [{ formId: "f-transient-react", data: { name: "Ada" } }]);
  } finally {
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

test("production gates local code-form interaction until canonical sync resolves", async () => {
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    let resolveSync;
    const codeForm = { id: "canonical-loading-react", schema: form, __filloCodeForm: true };
    const client = fakeClient({
      key: "pk_canonical_loading_react",
      baseUrl: "https://canonical-loading-react.test",
      syncForm: () =>
        new Promise((resolve) => {
          resolveSync = resolve;
        }),
    });
    const { target } = await mount(React.createElement(FilloForm, { form: codeForm, client }));
    assert.ok(target.querySelector(".fillo-form--loading"));
    assert.equal(
      target.querySelector("form"),
      null,
      "local schema is not interactive while unresolved",
    );

    resolveSync({
      formId: "f-canonical-loading-react",
      slug: "canonical-loading-react",
      status: "published",
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    assert.ok(target.querySelector("form"));
  } finally {
    process.env.NODE_ENV = prevEnv;
  }
});

test("production shows generic unavailable after bounded transient retries exhaust", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  process.env.NODE_ENV = "production";
  console.warn = () => {};
  try {
    let calls = 0;
    const failures = [];
    const codeForm = { id: "transient-exhausted-react", schema: form, __filloCodeForm: true };
    const client = fakeClient({
      key: "pk_transient_exhausted_react",
      baseUrl: "https://transient-exhausted-react.test",
      syncForm: async () => {
        calls += 1;
        throw new FilloError("Temporary upstream outage", 503, 0.001);
      },
    });
    const { target } = await mount(
      React.createElement(FilloForm, {
        form: codeForm,
        client,
        onError: (error) => failures.push(error),
      }),
    );
    assert.ok(target.querySelector(".fillo-form--loading"));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 15)));
    assert.equal(calls, 3, "bounded retry policy is unchanged");
    assert.equal(target.querySelector("form"), null);
    assert.match(target.textContent, /could not be loaded/i);
    assert.doesNotMatch(target.textContent, /upstream outage/i);
    assert.equal(failures.at(-1)?.status, 503);
  } finally {
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

test("a resolved sync warning renders the authoritative live snapshot without an outage", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  process.env.NODE_ENV = "production";
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const localDraft = {
      ...form,
      title: "Local draft",
      pages: [{ id: "p1", blocks: [{ id: "draftOnly", kind: "short_text", label: "Draft only" }] }],
    };
    const live = {
      ...form,
      title: "Live form",
      pages: [{ id: "p1", blocks: [{ id: "liveName", kind: "short_text", label: "Live name" }] }],
    };
    const observed = [];
    let renderedError = false;
    let submitCalls = 0;
    const codeForm = { id: "resolved-warning-react", schema: localDraft, __filloCodeForm: true };
    const client = fakeClient({
      key: "pk_resolved_warning_react",
      baseUrl: "https://resolved-warning-react.test",
      syncForm: async () => ({
        formId: "f-resolved-warning-react",
        slug: "resolved-warning-react",
        status: "published",
        staged: false,
        resolvedSchema: live,
        resolvedTheme: null,
        syncError: {
          code: "trusted_sync_required",
          message: "Run `fillo forms push`; the live form is shown meanwhile.",
        },
      }),
      submit: async () => {
        submitCalls += 1;
        return { ok: true, responseId: "r-resolved-warning" };
      },
    });
    const { target } = await mount(
      React.createElement(FilloForm, {
        form: codeForm,
        client,
        onError: (error) => observed.push(error),
        renderError: () => {
          renderedError = true;
          return React.createElement("div", null, "should not replace live form");
        },
      }),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    assert.ok(target.querySelector("form"), "resolved warning keeps the live form available");
    assert.match(target.textContent, /Live form|Live name/);
    assert.doesNotMatch(target.textContent, /Local draft|Draft only/);
    assert.equal(renderedError, false, "non-fatal syncError does not invoke renderError");
    assert.equal(observed.at(-1)?.code, "trusted_sync_required");
    assert.ok(warnings.some((line) => /trusted_sync_required/.test(line)));
    await type(target.querySelector('[data-field="liveName"] input'), "Ada");
    await act(async () => {
      target
        .querySelector("form")
        .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    });
    assert.equal(submitCalls, 1, "an equal submit-time live snapshot remains valid");
  } finally {
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

test("submit verification normalizes the raw code schema before exact comparison", async () => {
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const rawSchema = {
      version: 1,
      title: "  Contact  ",
      pages: [
        {
          id: "p1",
          blocks: [{ id: "name", kind: "short_text", label: "  Name  ", required: true }],
        },
      ],
      // settings intentionally omitted; normalization supplies {}.
    };
    let submitCalls = 0;
    const codeForm = { id: "normalized-submit-react", schema: rawSchema, __filloCodeForm: true };
    const client = fakeClient({
      key: "pk_normalized_submit_react",
      baseUrl: "https://normalized-submit-react.test",
      syncForm: async () => ({
        formId: "f-normalized-submit-react",
        slug: "normalized-submit-react",
        status: "published",
      }),
      submit: async () => {
        submitCalls += 1;
        return { ok: true, responseId: "r-normalized" };
      },
    });
    const { target } = await mount(React.createElement(FilloForm, { form: codeForm, client }));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    await type(target.querySelector('[data-field="name"] input'), "Ada");
    await act(async () => {
      target
        .querySelector("form")
        .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    });
    assert.equal(submitCalls, 1, "normalization differences do not false-block exact live content");
  } finally {
    process.env.NODE_ENV = prevEnv;
  }
});

test("submit-time live schema drift aborts before sending and preserves React answers", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  process.env.NODE_ENV = "production";
  console.warn = () => {};
  try {
    const liveBeforePublish = {
      ...form,
      title: "New live version",
      pages: [
        { id: "p1", blocks: [{ id: "email", kind: "email", label: "Email", required: true }] },
      ],
    };
    let syncCalls = 0;
    let submitCalls = 0;
    const observed = [];
    const codeForm = { id: "submit-drift-react", schema: form, __filloCodeForm: true };
    const client = fakeClient({
      key: "pk_submit_drift_react",
      baseUrl: "https://submit-drift-react.test",
      syncForm: async () => {
        syncCalls += 1;
        if (syncCalls === 1) {
          return {
            formId: "f-submit-drift-react",
            slug: "submit-drift-react",
            status: "published",
            resolvedSchema: liveBeforePublish,
            resolvedTheme: null,
            syncError: {
              code: "trusted_sync_required",
              message: "Local code is still awaiting publication.",
            },
          };
        }
        return {
          formId: "f-submit-drift-react",
          slug: "submit-drift-react",
          status: "published",
        };
      },
      submit: async () => {
        submitCalls += 1;
        return { ok: true, responseId: "should-not-send" };
      },
    });
    const { target } = await mount(
      React.createElement(FilloForm, {
        form: codeForm,
        client,
        onError: (error) => observed.push(error),
      }),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    const input = target.querySelector('[data-field="email"] input');
    await type(input, "ada@example.com");
    await act(async () => {
      target
        .querySelector("form")
        .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    });

    assert.equal(syncCalls, 2, "submit bypasses the exact-live mount cache");
    assert.equal(submitCalls, 0, "incompatible answers never reach the live endpoint");
    assert.equal(target.querySelector('[data-field="email"] input').value, "ada@example.com");
    assert.match(target.querySelector(".fillo-submit-error").textContent, /unavailable/i);
    assert.equal(observed.at(-1)?.code, "form_schema_changed");
  } finally {
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

test("React submit-time unpublish race stops before sending and preserves answers", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  process.env.NODE_ENV = "production";
  console.warn = () => {};
  try {
    let syncCalls = 0;
    let submitCalls = 0;
    const observed = [];
    const codeForm = { id: "submit-unpublished-react", schema: form, __filloCodeForm: true };
    const client = fakeClient({
      key: "pk_submit_unpublished_react",
      baseUrl: "https://submit-unpublished-react.test",
      syncForm: async () => ({
        formId: "f-submit-unpublished-react",
        slug: "submit-unpublished-react",
        status: ++syncCalls === 1 ? "published" : "draft",
      }),
      submit: async () => {
        submitCalls += 1;
        return { ok: true, responseId: "should-not-send" };
      },
    });
    const { target } = await mount(
      React.createElement(FilloForm, {
        form: codeForm,
        client,
        onError: (error) => observed.push(error),
      }),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    await type(target.querySelector('[data-field="name"] input'), "Ada");
    await act(async () => {
      target
        .querySelector("form")
        .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    });
    assert.equal(submitCalls, 0);
    assert.equal(target.querySelector('[data-field="name"] input').value, "Ada");
    assert.match(target.querySelector(".fillo-submit-error").textContent, /unavailable/i);
    assert.equal(observed.at(-1)?.code, "form_not_published");
  } finally {
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

test("React submit-time accepting closure stops before sending and preserves answers", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  process.env.NODE_ENV = "production";
  console.warn = () => {};
  try {
    let syncCalls = 0;
    let submitCalls = 0;
    const observed = [];
    const codeForm = { id: "submit-closed-react", schema: form, __filloCodeForm: true };
    const client = fakeClient({
      key: "pk_submit_closed_react",
      baseUrl: "https://submit-closed-react.test",
      syncForm: async () => ({
        formId: "f-submit-closed-react",
        slug: "submit-closed-react",
        status: "published",
        accepting: ++syncCalls === 1,
        ...(syncCalls === 1 ? {} : { acceptingReason: "storage_full" }),
      }),
      submit: async () => {
        submitCalls += 1;
        return { ok: true, responseId: "should-not-send" };
      },
    });
    const { target } = await mount(
      React.createElement(FilloForm, {
        form: codeForm,
        client,
        onError: (error) => observed.push(error),
      }),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    await type(target.querySelector('[data-field="name"] input'), "Ada");
    await act(async () => {
      target
        .querySelector("form")
        .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    });
    assert.equal(syncCalls, 2);
    assert.equal(submitCalls, 0);
    assert.equal(target.querySelector('[data-field="name"] input').value, "Ada");
    assert.match(target.querySelector(".fillo-submit-error").textContent, /unavailable/i);
    assert.equal(observed.at(-1)?.code, "storage_full");
  } finally {
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

test("React submits a completed required file when submit-time resync reports uploads full", async () => {
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    let syncCalls = 0;
    const submissions = [];
    const completed = {
      fileId: "file_completed_at_cap",
      name: "receipt.pdf",
      size: 128,
      mime: "application/pdf",
    };
    const codeForm = {
      id: "completed-file-at-cap-react",
      schema: uploadForm,
      __filloCodeForm: true,
    };
    const client = fakeClient({
      key: "pk_completed_file_at_cap_react",
      baseUrl: "https://completed-file-at-cap-react.test",
      syncForm: async () => ({
        formId: "f-completed-file-at-cap-react",
        slug: "completed-file-at-cap-react",
        status: "published",
        accepting: true,
        uploadsAvailable: ++syncCalls === 1,
        ...(syncCalls === 1
          ? {}
          : { warningCode: "storage_required", warningUrl: "https://fillo.test/storage" }),
      }),
      submit: async (_formId, data) => {
        submissions.push(data);
        return { ok: true, responseId: "r-completed-file-at-cap-react" };
      },
    });
    const { target } = await mount(
      React.createElement(FilloForm, {
        form: codeForm,
        client,
        initialData: { attachment: [completed] },
      }),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    await act(async () => {
      target
        .querySelector("form")
        .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    });

    assert.equal(syncCalls, 2, "submit re-checks the current upload envelope");
    assert.equal(submissions.length, 1, "upload unavailability does not reject completed files");
    assert.equal(submissions[0].attachment[0].fileId, completed.fileId);
  } finally {
    process.env.NODE_ENV = prevEnv;
  }
});

test("production preserves explicit code-form render-only use without a client", async () => {
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const codeForm = { id: "render-only-react", schema: form, __filloCodeForm: true };
    const { target } = await mount(
      React.createElement(FilloForm, { form: codeForm, renderOnly: true }),
    );
    assert.ok(target.querySelector("form"));
    assert.equal(target.querySelector(".fillo-form--error"), null);
  } finally {
    process.env.NODE_ENV = prevEnv;
  }
});

test("a definitive sync error clears when the client changes and matching sync succeeds", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  process.env.NODE_ENV = "production";
  console.warn = () => {};
  try {
    const codeForm = { id: "fatal-clears-react", schema: form, __filloCodeForm: true };
    const shared = {
      key: "pk_fatal_clears_react",
      baseUrl: "https://fatal-clears-react.test",
    };
    const badClient = fakeClient({
      ...shared,
      syncForm: async () => {
        throw new FilloError("Bad origin", 403, undefined, "origin_not_allowed");
      },
    });
    const goodClient = fakeClient({
      ...shared,
      syncForm: async () => ({
        formId: "f-fatal-clears-react",
        slug: "fatal-clears-react",
        status: "published",
      }),
    });
    const { target, rerender } = await mount(
      React.createElement(FilloForm, { form: codeForm, client: badClient }),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    assert.equal(target.querySelector("form"), null);

    await rerender(React.createElement(FilloForm, { form: codeForm, client: goodClient }));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    assert.ok(target.querySelector("form"), "the stale fatal state was cleared");
  } finally {
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

test("development keeps a failed code form usable with an actionable setup notice", async () => {
  const prevWarn = console.warn;
  console.warn = () => {};
  try {
    const message = "Run `fillo forms push` before deploying this schema.";
    const codeForm = { id: "trusted-dev-react", schema: form, __filloCodeForm: true };
    const client = fakeClient({
      key: "pk_trusted_dev_react",
      baseUrl: "https://trusted-dev-react.test",
      syncForm: async () => {
        throw new FilloError(message, 403, undefined, "trusted_sync_required");
      },
    });
    const { target } = await mount(React.createElement(FilloForm, { form: codeForm, client }));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    assert.ok(target.querySelector("form"), "local development rendering is preserved");
    assert.match(target.querySelector(".fillo-devwarning").textContent, /trusted_sync_required/);
    assert.match(target.querySelector(".fillo-devwarning").textContent, /fillo forms push/);
  } finally {
    console.warn = prevWarn;
  }
});

test("development keeps staged local changes visible with an explicit preview notice", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevInfo = console.info;
  process.env.NODE_ENV = "development";
  const infos = [];
  console.info = (...args) => infos.push(args.join(" "));
  try {
    const localDraft = {
      ...form,
      title: "Local staged preview",
      pages: [{ id: "p1", blocks: [{ id: "local", kind: "short_text", label: "Local field" }] }],
    };
    const live = {
      ...form,
      title: "Published live form",
      pages: [{ id: "p1", blocks: [{ id: "live", kind: "short_text", label: "Live field" }] }],
    };
    const codeForm = { id: "staged-dev-react", schema: localDraft, __filloCodeForm: true };
    const client = fakeClient({
      key: "pk_staged_dev_react",
      baseUrl: "https://staged-dev-react.test",
      syncForm: async () => ({
        formId: "f-staged-dev-react",
        slug: "staged-dev-react",
        status: "published",
        staged: true,
        resolvedSchema: live,
        resolvedTheme: null,
        manageUrl: "https://fillo.so/forms/f-staged-dev-react",
      }),
    });
    const { target } = await mount(React.createElement(FilloForm, { form: codeForm, client }));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    assert.match(target.textContent, /Local staged preview|Local field/);
    assert.doesNotMatch(target.textContent, /Published live form|Live field/);
    assert.match(target.querySelector(".fillo-devwarning").textContent, /changes are staged/i);
    assert.equal(
      target.querySelector(".fillo-devwarning a")?.getAttribute("href"),
      "https://fillo.so/forms/f-staged-dev-react",
      "the server-owned dashboard URL wins over an app-owned API base URL",
    );
  } finally {
    console.info = prevInfo;
    process.env.NODE_ENV = prevEnv;
  }
});

test("a code form without a sync key fails closed in production", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  process.env.NODE_ENV = "production";
  console.warn = () => {};
  try {
    const errors = [];
    const codeForm = { id: "missing-key-react", schema: form, __filloCodeForm: true };
    const { target } = await mount(
      React.createElement(FilloForm, {
        form: codeForm,
        client: fakeClient({ key: undefined }),
        onError: (error) => errors.push(error),
      }),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    assert.equal(target.querySelector("form"), null);
    assert.equal(errors.at(-1)?.code, "sync_key_required");
    assert.doesNotMatch(target.textContent, /pk_/);
  } finally {
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

test("FilloProvider also fails closed after a definitive code-form sync error", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  process.env.NODE_ENV = "production";
  console.warn = () => {};
  try {
    const observed = [];
    const codeForm = { id: "provider-fatal-react", schema: form, __filloCodeForm: true };
    const client = fakeClient({
      key: "pk_provider_fatal_react",
      baseUrl: "https://provider-fatal-react.test",
      syncForm: async () => {
        throw new FilloError("Use trusted sync", 403, undefined, "trusted_sync_required");
      },
    });
    const { target } = await mount(
      React.createElement(
        FilloProvider,
        { form: codeForm, client, onError: (error) => observed.push(error) },
        React.createElement(FormField, { id: "name" }),
      ),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    assert.equal(target.childNodes.length, 0, "headless default adds no fallback layout");
    assert.equal(target.textContent, "");
    assert.equal(observed.at(-1)?.code, "trusted_sync_required");
  } finally {
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

test("FilloProvider withholds children while loading and reveals them after canonical sync", async () => {
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    let resolveSync;
    const codeForm = { id: "provider-loading", schema: form, __filloCodeForm: true };
    const client = fakeClient({
      key: "pk_provider_loading",
      baseUrl: "https://provider-loading.test",
      syncForm: () =>
        new Promise((resolve) => {
          resolveSync = resolve;
        }),
    });
    const { target } = await mount(
      React.createElement(
        FilloProvider,
        { form: codeForm, client },
        React.createElement(FormField, { id: "name" }),
      ),
    );
    assert.equal(target.childNodes.length, 0, "loading stays layout-free");
    resolveSync({ formId: "f-provider-loading", slug: "provider-loading", status: "published" });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    assert.ok(target.querySelector("input"));
  } finally {
    process.env.NODE_ENV = prevEnv;
  }
});

test("FilloProvider withholds unpublished draft children in production", async () => {
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const codeForm = { id: "provider-draft", schema: form, __filloCodeForm: true };
    const client = fakeClient({
      key: "pk_provider_draft",
      baseUrl: "https://provider-draft.test",
      syncForm: async () => ({
        formId: "f-provider-draft",
        slug: "provider-draft",
        status: "draft",
      }),
    });
    const { target } = await mount(
      React.createElement(
        FilloProvider,
        { form: codeForm, client },
        React.createElement(FormField, { id: "name" }),
      ),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    assert.equal(target.childNodes.length, 0);
  } finally {
    process.env.NODE_ENV = prevEnv;
  }
});

test("FilloProvider withholds children when initial sync says accepting:false", async () => {
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    let rendered = null;
    const codeForm = { id: "provider-closed", schema: form, __filloCodeForm: true };
    const client = fakeClient({
      key: "pk_provider_closed",
      baseUrl: "https://provider-closed.test",
      syncForm: async () => ({
        formId: "f-provider-closed",
        slug: "provider-closed",
        status: "published",
        accepting: false,
        acceptingReason: "storage_full",
      }),
    });
    const { target } = await mount(
      React.createElement(
        FilloProvider,
        {
          form: codeForm,
          client,
          renderError: (error) => {
            rendered = error;
            return React.createElement("div", { id: "provider-closed-state" }, "Responses closed");
          },
        },
        React.createElement(FormField, { id: "name" }),
      ),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    assert.equal(target.querySelector("input"), null);
    assert.equal(target.querySelector("#provider-closed-state").textContent, "Responses closed");
    assert.equal(rendered?.status, 403);
    assert.equal(rendered?.code, "storage_full");
  } finally {
    process.env.NODE_ENV = prevEnv;
  }
});

test("FilloProvider keeps ordinary fields active while hard-unavailable uploads are disabled", async () => {
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const codeForm = { id: "provider-upload-hard-full", schema: uploadForm, __filloCodeForm: true };
    const client = fakeClient({
      key: "pk_provider_upload_hard_full",
      baseUrl: "https://provider-upload-hard-full.test",
      syncForm: async () => ({
        formId: "f-provider-upload-hard-full",
        slug: "provider-upload-hard-full",
        status: "published",
        accepting: true,
        uploadsAvailable: false,
      }),
    });
    const { target } = await mount(
      React.createElement(
        FilloProvider,
        { form: codeForm, client },
        React.createElement(FormField, { id: "message" }),
        React.createElement(FormField, { id: "attachment" }),
      ),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));

    assert.equal(target.querySelector('input[type="text"]').disabled, false);
    assert.equal(target.querySelector('input[type="file"]').disabled, true);
  } finally {
    process.env.NODE_ENV = prevEnv;
  }
});

test("FilloProvider renderError opts into host-owned fatal UI", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  process.env.NODE_ENV = "production";
  console.warn = () => {};
  try {
    let rendered = null;
    const codeForm = { id: "provider-custom-error", schema: form, __filloCodeForm: true };
    const client = fakeClient({
      key: "pk_provider_custom_error",
      baseUrl: "https://provider-custom-error.test",
      syncForm: async () => {
        throw new FilloError("Use trusted sync", 403, undefined, "trusted_sync_required");
      },
    });
    const { target } = await mount(
      React.createElement(
        FilloProvider,
        {
          form: codeForm,
          client,
          renderError: (error) => {
            rendered = error;
            return React.createElement(
              "div",
              { id: "provider-owned-error" },
              "Host unavailable UI",
            );
          },
        },
        React.createElement(FormField, { id: "name" }),
      ),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    assert.equal(rendered?.code, "trusted_sync_required");
    assert.equal(target.querySelector("#provider-owned-error").textContent, "Host unavailable UI");
    assert.equal(target.querySelector("input"), null);
  } finally {
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

test("FilloProvider verifies cached code schemas at submit and preserves composed answers", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  process.env.NODE_ENV = "production";
  console.warn = () => {};
  try {
    const liveBeforePublish = {
      ...form,
      title: "Provider live update",
      pages: [
        { id: "p1", blocks: [{ id: "email", kind: "email", label: "Email", required: true }] },
      ],
    };
    let syncCalls = 0;
    let submitCalls = 0;
    const observed = [];
    const codeForm = { id: "provider-submit-drift", schema: form, __filloCodeForm: true };
    const client = fakeClient({
      key: "pk_provider_submit_drift",
      baseUrl: "https://provider-submit-drift.test",
      syncForm: async () => {
        syncCalls += 1;
        return syncCalls === 1
          ? {
              formId: "f-provider-submit-drift",
              slug: "provider-submit-drift",
              status: "published",
              resolvedSchema: liveBeforePublish,
              resolvedTheme: null,
              syncError: {
                code: "trusted_sync_required",
                message: "Provider code is still awaiting publication.",
              },
            }
          : {
              formId: "f-provider-submit-drift",
              slug: "provider-submit-drift",
              status: "published",
            };
      },
      submit: async () => {
        submitCalls += 1;
        return { ok: true, responseId: "should-not-send" };
      },
    });
    function Controls() {
      const api = useFillo();
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          "button",
          {
            id: "provider-submit",
            type: "button",
            onClick: () => void api.submit().catch(() => {}),
          },
          "Submit",
        ),
        React.createElement("div", { id: "provider-error" }, api.submitError ?? ""),
      );
    }
    const { target } = await mount(
      React.createElement(
        FilloProvider,
        { form: codeForm, client, onError: (error) => observed.push(error) },
        React.createElement(FormField, { id: "email" }),
        React.createElement(Controls),
      ),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    const input = target.querySelector("input");
    await type(input, "ada@example.com");
    await act(async () => {
      target
        .querySelector("#provider-submit")
        .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(syncCalls, 2);
    assert.equal(submitCalls, 0);
    assert.equal(target.querySelector("input").value, "ada@example.com");
    assert.match(target.querySelector("#provider-error").textContent, /unavailable/i);
    assert.equal(observed.at(-1)?.code, "form_schema_changed");
  } finally {
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

test("FilloProvider submit-time unpublish race preserves composed answers", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  process.env.NODE_ENV = "production";
  console.warn = () => {};
  try {
    let syncCalls = 0;
    let submitCalls = 0;
    const observed = [];
    const codeForm = { id: "provider-submit-unpublished", schema: form, __filloCodeForm: true };
    const client = fakeClient({
      key: "pk_provider_submit_unpublished",
      baseUrl: "https://provider-submit-unpublished.test",
      syncForm: async () => ({
        formId: "f-provider-submit-unpublished",
        slug: "provider-submit-unpublished",
        status: ++syncCalls === 1 ? "published" : "draft",
      }),
      submit: async () => {
        submitCalls += 1;
        return { ok: true, responseId: "should-not-send" };
      },
    });
    function Controls() {
      const api = useFillo();
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          "button",
          {
            id: "provider-unpublish-submit",
            type: "button",
            onClick: () => void api.submit().catch(() => {}),
          },
          "Submit",
        ),
        React.createElement("div", { id: "provider-unpublish-error" }, api.submitError ?? ""),
      );
    }
    const { target } = await mount(
      React.createElement(
        FilloProvider,
        { form: codeForm, client, onError: (error) => observed.push(error) },
        React.createElement(FormField, { id: "name" }),
        React.createElement(Controls),
      ),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    await type(target.querySelector("input"), "Ada");
    await act(async () => {
      target
        .querySelector("#provider-unpublish-submit")
        .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(submitCalls, 0);
    assert.equal(target.querySelector("input").value, "Ada");
    assert.match(target.querySelector("#provider-unpublish-error").textContent, /unavailable/i);
    assert.equal(observed.at(-1)?.code, "form_not_published");
  } finally {
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

test("FilloProvider submit-time accepting closure preserves composed answers", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  process.env.NODE_ENV = "production";
  console.warn = () => {};
  try {
    let syncCalls = 0;
    let submitCalls = 0;
    const observed = [];
    const codeForm = { id: "provider-submit-closed", schema: form, __filloCodeForm: true };
    const client = fakeClient({
      key: "pk_provider_submit_closed",
      baseUrl: "https://provider-submit-closed.test",
      syncForm: async () => ({
        formId: "f-provider-submit-closed",
        slug: "provider-submit-closed",
        status: "published",
        accepting: ++syncCalls === 1,
        ...(syncCalls === 1 ? {} : { acceptingReason: "storage_full" }),
      }),
      submit: async () => {
        submitCalls += 1;
        return { ok: true, responseId: "should-not-send" };
      },
    });
    function Controls() {
      const api = useFillo();
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          "button",
          {
            id: "provider-closed-submit",
            type: "button",
            onClick: () => void api.submit().catch(() => {}),
          },
          "Submit",
        ),
        React.createElement("div", { id: "provider-closed-error" }, api.submitError ?? ""),
      );
    }
    const { target } = await mount(
      React.createElement(
        FilloProvider,
        { form: codeForm, client, onError: (error) => observed.push(error) },
        React.createElement(FormField, { id: "name" }),
        React.createElement(Controls),
      ),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    await type(target.querySelector("input"), "Ada");
    await act(async () => {
      target
        .querySelector("#provider-closed-submit")
        .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(syncCalls, 2);
    assert.equal(submitCalls, 0);
    assert.equal(target.querySelector("input").value, "Ada");
    assert.match(target.querySelector("#provider-closed-error").textContent, /unavailable/i);
    assert.equal(observed.at(-1)?.code, "storage_full");
  } finally {
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

test("FilloProvider keeps staged local composition in development with a notice", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevInfo = console.info;
  process.env.NODE_ENV = "development";
  const infos = [];
  console.info = (...args) => infos.push(args.join(" "));
  try {
    const localDraft = {
      ...form,
      pages: [
        { id: "p1", blocks: [{ id: "local", kind: "short_text", label: "Provider local field" }] },
      ],
    };
    const live = {
      ...form,
      pages: [
        { id: "p1", blocks: [{ id: "live", kind: "short_text", label: "Provider live field" }] },
      ],
    };
    const codeForm = { id: "provider-staged-dev", schema: localDraft, __filloCodeForm: true };
    const client = fakeClient({
      key: "pk_provider_staged_dev",
      baseUrl: "https://provider-staged-dev.test",
      syncForm: async () => ({
        formId: "f-provider-staged-dev",
        slug: "provider-staged-dev",
        status: "published",
        staged: true,
        resolvedSchema: live,
        resolvedTheme: null,
      }),
    });
    const { target } = await mount(
      React.createElement(
        FilloProvider,
        { form: codeForm, client },
        React.createElement(FormField, { id: "local" }),
      ),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    assert.match(target.textContent, /Provider local field/);
    assert.doesNotMatch(target.textContent, /Provider live field/);
    assert.equal(
      target.querySelector(".fillo-devwarning"),
      null,
      "headless provider injects no layout",
    );
    assert.ok(infos.some((line) => /changes staged/i.test(line)));
  } finally {
    console.info = prevInfo;
    process.env.NODE_ENV = prevEnv;
  }
});

test("code-form sync applies server-owned branding", async () => {
  const codeForm = { id: "branding-test", schema: form, __filloCodeForm: true };
  const client = fakeClient({
    syncForm: async () => ({
      formId: "f-brand",
      slug: "branding-test",
      status: "published",
      branding: { poweredBy: false },
    }),
  });
  const { target } = await mount(React.createElement(FilloForm, { form: codeForm, client }));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  assert.equal(target.querySelector(".fillo-powered"), null);
});

test("progressbar exposes a valid one-based range and accessible name", async () => {
  const multiPage = {
    ...form,
    title: "Account survey",
    pages: [form.pages[0], { id: "p2", blocks: [] }],
  };
  const { target } = await mount(
    React.createElement(FilloForm, { form: multiPage, formId: "f-test", client: fakeClient() }),
  );
  const progress = target.querySelector('[role="progressbar"]');
  assert.equal(progress.getAttribute("aria-valuemin"), "1");
  assert.equal(progress.getAttribute("aria-valuenow"), "1");
  assert.equal(progress.getAttribute("aria-label"), "Account survey");
});

test("text and number constraints reach the native controls", async () => {
  const constrained = {
    version: 1,
    title: "T",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [
          { id: "email", kind: "email", label: "Email", maxLength: 64 },
          { id: "count", kind: "number", label: "Count", min: 2, max: 8 },
          { id: "notes", kind: "long_text", label: "Notes", maxLength: 120 },
          { id: "site", kind: "url", label: "Site" },
          { id: "name", kind: "short_text", label: "Name" },
        ],
      },
    ],
  };
  const { target } = await mount(
    React.createElement(FilloForm, { form: constrained, formId: "f-test", client: fakeClient() }),
  );
  assert.equal(target.querySelector('[data-field="email"] input').maxLength, 64);
  assert.equal(target.querySelector('[data-field="count"] input').min, "2");
  assert.equal(target.querySelector('[data-field="count"] input').max, "8");
  assert.equal(target.querySelector('[data-field="notes"] textarea').maxLength, 120);
  // Contract: email -> autocomplete="email", url -> "url"; no guessed token
  // for a generic short_text (P0.6).
  assert.equal(
    target.querySelector('[data-field="email"] input').getAttribute("autocomplete"),
    "email",
  );
  assert.equal(
    target.querySelector('[data-field="site"] input').getAttribute("autocomplete"),
    "url",
  );
  assert.equal(
    target.querySelector('[data-field="name"] input').hasAttribute("autocomplete"),
    false,
  );
});

test("appearance classNames land per slot; data-* state contract emitted", async () => {
  const { target } = await mount(
    React.createElement(FilloForm, {
      form,
      formId: "f-test",
      client: fakeClient(),
      appearance: {
        classNames: {
          root: "max-w-xl",
          label: "text-sm font-medium",
          field: "space-y-1",
          button: (s) => (s.variant === "primary" ? "bg-indigo-600" : "bg-zinc-100"),
        },
        fields: { name: { field: "col-span-2" } },
      },
    }),
  );
  const root = target.querySelector("form");
  assert.match(root.className, /max-w-xl/);
  assert.equal(root.getAttribute("data-fillo"), "root");
  assert.equal(root.getAttribute("data-state"), "idle");
  const field = target.querySelector('[data-field="name"]');
  assert.match(field.className, /fillo-field/);
  assert.match(field.className, /space-y-1/, "slot class appended");
  assert.match(field.className, /col-span-2/, "per-field override appended after");
  assert.equal(field.getAttribute("data-kind"), "short_text");
  assert.equal(field.getAttribute("data-required"), "");
  const label = field.querySelector('[data-fillo="label"]');
  assert.match(label.className, /text-sm font-medium/);
  const submitBtn = target.querySelector('button[type="submit"]');
  assert.match(submitBtn.className, /bg-indigo-600/, "function classNames receive variant");
  // Invalid state attribute appears after a failed submit.
  const formEl = target.querySelector("form");
  await act(async () => {
    formEl.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  assert.equal(
    target.querySelector('[data-field="name"]').getAttribute("data-invalid"),
    "",
    "data-invalid set on validation failure",
  );
});

test("checkbox chrome honors appearance slots and data attributes", async () => {
  const checkboxForm = {
    version: 1,
    title: "T",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [
          {
            id: "terms",
            kind: "checkbox",
            label: "Accept terms",
            description: "Required to continue",
            required: true,
          },
        ],
      },
    ],
  };
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: checkboxForm,
      formId: "f-test",
      client: fakeClient(),
      appearance: {
        classNames: {
          field: "field-slot",
          fieldDescription: "description-slot",
          error: "error-slot",
        },
      },
    }),
  );
  assert.match(target.querySelector('[data-field="terms"]').className, /field-slot/);
  assert.match(
    target.querySelector('[data-fillo="fieldDescription"]').className,
    /description-slot/,
  );
  await act(async () => {
    target
      .querySelector("form")
      .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  assert.match(target.querySelector('[data-fillo="error"]').className, /error-slot/);
});

test("options carry data-selected and the option slot", async () => {
  const selectForm = {
    version: 1,
    title: "T",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [
          {
            id: "topic",
            kind: "select",
            label: "Topic",
            options: [
              { id: "a", label: "A" },
              { id: "b", label: "B" },
            ],
          },
        ],
      },
    ],
  };
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: selectForm,
      formId: "f-test",
      client: fakeClient(),
      appearance: { classNames: { option: "rounded-lg", control: "gap-2" } },
    }),
  );
  const group = target.querySelector('[data-fillo="options"]');
  assert.ok(group, "options group marked");
  const rows = target.querySelectorAll('[data-fillo="option"]');
  assert.equal(rows.length, 2);
  assert.match(rows[0].className, /rounded-lg/, "option slot class lands");
  assert.equal(rows[0].getAttribute("data-selected"), null);
  const radio = rows[0].querySelector("input");
  await act(async () => {
    radio.click();
  });
  assert.equal(
    target.querySelector('[data-option="a"]').getAttribute("data-selected"),
    "",
    "data-selected set after picking",
  );
});

test("dropdown Other sentinel never shadows a real option id", async () => {
  const values = [];
  const sentinelForm = {
    version: 1,
    title: "T",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [
          {
            id: "pick",
            kind: "dropdown",
            label: "Pick",
            allowOther: true,
            options: [{ id: "__fillo_other__", label: "Real sentinel-looking option" }],
          },
        ],
      },
    ],
  };
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: sentinelForm,
      formId: "f-test",
      client: fakeClient(),
      onChange: (data) => values.push(data.pick),
    }),
  );
  const select = target.querySelector("select");
  await act(async () => {
    select.value = "__fillo_other__";
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  assert.equal(values.at(-1), "__fillo_other__");
  assert.equal(target.querySelector(".fillo-other-input"), null);
});

test("StrictMode replay keeps concurrent file completions and accumulates both", async () => {
  const pending = [];
  const client = fakeClient({
    uploadFile: async (_formId, file) => new Promise((resolve) => pending.push({ file, resolve })),
  });
  const uploadForm = {
    version: 1,
    title: "T",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [
          {
            id: "files",
            kind: "file_upload",
            label: "Files",
            maxFiles: 2,
          },
        ],
      },
    ],
  };
  let latest = [];
  const { target } = await mount(
    React.createElement(
      React.StrictMode,
      null,
      React.createElement(FilloForm, {
        form: uploadForm,
        formId: "f1",
        client,
        onChange: (data) => {
          latest = data.files ?? [];
        },
      }),
    ),
  );
  const input = target.querySelector('input[type="file"]');
  const files = [new File(["a"], "a.txt"), new File(["b"], "b.txt")];
  Object.defineProperty(input, "files", { configurable: true, value: files });
  await act(async () => {
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  assert.equal(pending.length, 2);
  await act(async () => {
    pending[0].resolve({ fileId: "a", name: "a.txt", size: 1, mime: "text/plain" });
    await Promise.resolve();
  });
  await act(async () => {
    pending[1].resolve({ fileId: "b", name: "b.txt", size: 1, mime: "text/plain" });
    await Promise.resolve();
  });
  assert.deepEqual(latest.map((file) => file.fileId).sort(), ["a", "b"]);
});

test("a field override re-renders when another observable API value changes", async () => {
  const overrideForm = {
    version: 1,
    title: "T",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [
          { id: "name", kind: "short_text", label: "Name" },
          { id: "email", kind: "email", label: "Email" },
        ],
      },
    ],
  };
  function EmailOverride({ api }) {
    return React.createElement(
      "output",
      { "data-testid": "seen-name" },
      String(api.data.name ?? ""),
    );
  }
  const components = { email: EmailOverride };
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: overrideForm,
      formId: "f-test",
      client: fakeClient(),
      components,
    }),
  );
  await type(target.querySelector('[data-field="name"] input'), "Ada");
  assert.equal(target.querySelector('[data-testid="seen-name"]').textContent, "Ada");
});

test("strings prop localizes every chrome string it touches", async () => {
  const localized = {
    version: 1,
    title: "T",
    settings: {},
    pages: [{ id: "p1", blocks: [{ id: "note", kind: "short_text", label: "Note" }] }],
  };
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: localized,
      formId: "f-test",
      client: fakeClient(),
      strings: { submit: "Absenden", optional: " (valgfrit)" },
    }),
  );
  assert.equal(target.querySelector('button[type="submit"]').textContent, "Absenden");
  assert.match(target.querySelector(".fillo-optional").textContent, /valgfrit/);
});

test("<Fillo.Form> compiles children, renders framed, and collects a response", async () => {
  const { Fillo } = await import("../dist/index.js");
  const submits = [];
  const client = fakeClient({
    submit: async (formId, data) => {
      submits.push({ formId, data });
      return { ok: true, responseId: "r1" };
    },
    syncForm: async () => ({ formId: "srv-1", slug: "contact", status: "published" }),
  });
  const { target } = await mount(
    React.createElement(
      Fillo.Form,
      { id: "contact", title: "Talk to us", client },
      React.createElement(Fillo.Text, { id: "name", label: "Your name", required: true }),
      React.createElement(
        Fillo.Select,
        { id: "topic", label: "Topic" },
        React.createElement(Fillo.Option, { id: "a", label: "A" }),
        React.createElement(Fillo.Option, { id: "b", label: "B" }),
      ),
    ),
  );
  // Framed chrome: title, fields, badge — the free surface.
  assert.match(target.querySelector(".fillo-title").textContent, /Talk to us/);
  assert.equal(target.querySelectorAll('[data-fillo="field"]').length, 2);
  assert.ok(target.querySelector(".fillo-powered"), "badge present on the framed JSX surface");

  await act(async () => new Promise((r) => setTimeout(r, 10))); // sync resolves
  await type(target.querySelector('[data-field="name"] input'), "Ada");
  const formEl = target.querySelector("form");
  await act(async () => {
    formEl.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  assert.equal(submits.length, 1);
  assert.equal(submits[0].formId, "srv-1", "submits to the synced id");
  assert.equal(submits[0].data.name, "Ada");
});

test("Fillo.defineForm(jsx) yields a CodeForm; rendering a field bare throws", async () => {
  const { Fillo, defineForm } = await import("../dist/index.js");
  const viaJsx = Fillo.defineForm(
    React.createElement(
      Fillo.Form,
      { id: "contact", title: "T" },
      React.createElement(Fillo.Email, { id: "email", label: "Email" }),
    ),
  );
  assert.equal(viaJsx.id, "contact");
  const twin = defineForm({
    id: "contact",
    title: "T",
    pages: [{ id: "main", blocks: [{ id: "email", kind: "email", label: "Email" }] }],
  });
  assert.equal(JSON.stringify(viaJsx.schema), JSON.stringify(twin.schema));

  // A field element rendered outside Fillo.Form must fail loudly, not blank.
  let threw = null;
  try {
    const { renderToStaticMarkup } = await import("react-dom/server");
    renderToStaticMarkup(React.createElement(Fillo.Email, { id: "x", label: "X" }));
  } catch (err) {
    threw = err;
  }
  assert.equal(threw?.code, "RENDERED_INERT");
});

test("<Fillo.Calculated> compiles to a valid calculated block (the JSX power path)", async () => {
  const { Fillo, defineForm } = await import("../dist/index.js");
  const { validateFormSchema } = await import("@usefillo/core");
  // Nested calc — deliberately deeper than the visual editor can author,
  // because JSX/defineForm is the documented home for that depth.
  const calc = {
    op: "round",
    arg: {
      op: "mul",
      args: [
        { op: "value", fieldId: "seats" },
        { op: "value", fieldId: "price" },
      ],
    },
    decimals: 2,
  };
  const viaJsx = Fillo.defineForm(
    React.createElement(
      Fillo.Form,
      { id: "quote", title: "Quote" },
      React.createElement(Fillo.Number, { id: "seats", label: "Seats" }),
      React.createElement(Fillo.Number, { id: "price", label: "Unit price" }),
      React.createElement(Fillo.Calculated, {
        id: "total",
        label: "Total",
        description: "Updates live.",
        calc,
        decimals: 2,
        prefix: "$",
        suffix: "/mo",
      }),
    ),
  );
  // Same CodeForm defineForm() emits for the identical declaration.
  const twin = defineForm({
    id: "quote",
    title: "Quote",
    pages: [
      {
        id: "main",
        blocks: [
          { id: "seats", kind: "number", label: "Seats" },
          { id: "price", kind: "number", label: "Unit price" },
          {
            id: "total",
            kind: "calculated",
            label: "Total",
            description: "Updates live.",
            calc,
            decimals: 2,
            prefix: "$",
            suffix: "/mo",
          },
        ],
      },
    ],
  });
  assert.equal(JSON.stringify(viaJsx.schema), JSON.stringify(twin.schema));

  // The compiled schema passes core validation (refs, kinds, cycle check) and
  // keeps the block a real calculated field with its AST intact.
  const validated = validateFormSchema(viaJsx.schema);
  assert.equal(validated.ok, true, validated.error);
  const block = validated.schema.pages[0].blocks.find((b) => b.id === "total");
  assert.equal(block.kind, "calculated");
  assert.deepEqual(block.calc, calc);
  assert.equal(block.required, false, "a derived value is never required");
});

// ---------- Inline validation focus + persistent announcement channel
// (input-quality, P2.8, P1.5, chrome #6/#11) -------------------------------

const errorSummaryForm = {
  version: 1,
  title: "T",
  settings: {},
  pages: [
    {
      id: "p1",
      blocks: [
        { id: "name", kind: "short_text", label: "Name", required: true },
        { id: "email", kind: "email", label: "Email", required: true },
      ],
    },
  ],
};

test("failed submit focuses the first invalid control and keeps field-aware errors inline", async () => {
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: errorSummaryForm,
      formId: "f-test",
      client: fakeClient(),
    }),
  );
  const formEl = target.querySelector("form");
  await act(async () => {
    formEl.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  await act(async () => new Promise((r) => setTimeout(r, 10)));

  assert.equal(target.querySelector(".fillo-error-summary"), null);
  const nameError = target.querySelector('[data-field="name"] [data-fillo="error"]');
  assert.equal(nameError.textContent, "Enter your answer");
  assert.equal(
    nameError.hasAttribute("role"),
    false,
    "per-field error is plain text, not role=alert",
  );
  const nameInput = target.querySelector('[data-field="name"] input');
  const emailError = target.querySelector('[data-field="email"] [data-fillo="error"]');
  assert.equal(emailError.textContent, "Enter an email address");
  assert.equal(document.activeElement, nameInput, "focus moved to the first invalid control");
  assert.equal(
    nameInput.getAttribute("aria-describedby"),
    nameError.id,
    "still wired via aria-describedby",
  );
});

test("inline validation clears field by field as answers are corrected", async () => {
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: errorSummaryForm,
      formId: "f-test",
      client: fakeClient(),
    }),
  );
  const formEl = target.querySelector("form");
  await act(async () => {
    formEl.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  await act(async () => new Promise((r) => setTimeout(r, 10)));
  assert.equal(target.querySelectorAll('[data-fillo="error"]').length, 2);

  await type(target.querySelector('[data-field="name"] input'), "Ada");
  assert.equal(
    target.querySelectorAll('[data-fillo="error"]').length,
    1,
    "fixed field drops its inline guidance",
  );

  await type(target.querySelector('[data-field="email"] input'), "ada@example.com");
  assert.equal(
    target.querySelectorAll('[data-fillo="error"]').length,
    0,
    "all inline guidance clears once the fields are valid",
  );
});

test("focus-first descends into the first operable control of an invalid composite", async () => {
  const compositeForm = {
    version: 1,
    title: "T",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [{ id: "rating", kind: "rating", label: "Rating", required: true, max: 5 }],
      },
    ],
  };
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: compositeForm,
      formId: "f-test",
      client: fakeClient(),
    }),
  );
  await act(async () => {
    target
      .querySelector("form")
      .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  await act(async () => new Promise((r) => setTimeout(r, 10)));

  const group = target.querySelector('[data-field="rating"] [role="radiogroup"]');
  const error = target.querySelector('[data-field="rating"] [data-fillo="error"]');
  const firstStar = group.querySelector('button[role="radio"]');
  assert.equal(group.getAttribute("aria-invalid"), "true");
  assert.equal(group.getAttribute("aria-describedby"), error.id);
  assert.equal(document.activeElement, firstStar);
});

test("focus-first covers compound and grouped validation controls", async () => {
  const cases = [
    {
      label: "affixed number",
      block: { id: "amount", kind: "number", label: "Amount", required: true, prefix: "$" },
      selector: ".fillo-number .fillo-input",
    },
    {
      label: "choice group",
      block: {
        id: "choice",
        kind: "select",
        label: "Choice",
        required: true,
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
      },
      selector: ".fillo-option-input",
    },
    {
      label: "checkbox",
      block: { id: "agree", kind: "checkbox", label: "Agree", required: true },
      selector: ".fillo-option-input",
    },
    {
      label: "toggle",
      block: {
        id: "toggle",
        kind: "checkbox",
        label: "Toggle",
        required: true,
        appearance: "toggle",
      },
      selector: ".fillo-toggle-input",
    },
    {
      label: "linear scale",
      block: {
        id: "scale",
        kind: "linear_scale",
        label: "Scale",
        required: true,
        min: 1,
        max: 3,
      },
      selector: ".fillo-scale-step",
    },
    {
      label: "matrix row",
      block: {
        id: "matrix",
        kind: "matrix",
        label: "Matrix",
        required: true,
        rows: [{ id: "r", label: "Row" }],
        columns: [{ id: "c", label: "Column" }],
      },
      selector: ".fillo-matrix-cell .fillo-option-input",
    },
  ];

  for (const scenario of cases) {
    const { target, root } = await mount(
      React.createElement(FilloForm, {
        form: {
          version: 1,
          title: "T",
          settings: {},
          pages: [{ id: "p1", blocks: [scenario.block] }],
        },
        formId: "f-test",
        client: fakeClient(),
      }),
    );
    const formEl = target.querySelector("form");
    assert.ok(formEl, `${scenario.label} fixture renders`);
    await act(async () => {
      formEl.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    });
    await act(async () => new Promise((r) => setTimeout(r, 10)));

    const expected = target.querySelector(scenario.selector);
    assert.ok(target.querySelector('[aria-invalid="true"]'), `${scenario.label} is marked invalid`);
    assert.equal(document.activeElement, expected, `${scenario.label} receives corrective focus`);

    await act(async () => root.unmount());
    target.remove();
  }
});

test("focus-first lands on the visible upload dropzone, never its hidden file input", async () => {
  const fileForm = {
    version: 1,
    title: "T",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [{ id: "attachment", kind: "file_upload", label: "Attachment", required: true }],
      },
    ],
  };
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: fileForm,
      formId: "f-test",
      client: fakeClient(),
    }),
  );
  await act(async () => {
    target
      .querySelector("form")
      .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  await act(async () => new Promise((r) => setTimeout(r, 10)));

  const dropzone = target.querySelector('[data-field="attachment"] .fillo-dropzone');
  const hiddenInput = target.querySelector('[data-field="attachment"] input[type="file"]');
  const error = target.querySelector('[data-field="attachment"] [data-fillo="error"]');
  assert.equal(dropzone.getAttribute("aria-invalid"), "true");
  assert.equal(dropzone.getAttribute("aria-describedby"), error.id);
  assert.equal(document.activeElement, dropzone);
  assert.notEqual(document.activeElement, hiddenInput);
});

test("persistent announce channel: announces the submitting text while a submit is in flight (auto-submit-no-footer silence)", async () => {
  let resolveSubmit;
  const client = fakeClient({
    submit: () =>
      new Promise((resolve) => {
        resolveSubmit = resolve;
      }),
  });
  const soloForm = {
    version: 1,
    title: "T",
    settings: {},
    pages: [{ id: "p1", blocks: [{ id: "name", kind: "short_text", label: "Name" }] }],
  };
  const { target } = await mount(
    React.createElement(FilloForm, { form: soloForm, formId: "f-announce-submitting", client }),
  );
  const channel = target.querySelector('[data-fillo="announce"]');
  assert.ok(channel, "the persistent announce channel is always mounted");
  assert.equal(channel.getAttribute("role"), "status");
  assert.equal(channel.getAttribute("aria-live"), "polite");
  assert.equal(channel.className, "fillo-sr-only");
  assert.equal(channel.textContent, "", "empty until something announces");

  const formEl = target.querySelector("form");
  await act(async () => {
    formEl.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  assert.equal(channel.textContent, "Submitting your response…");

  resolveSubmit({ ok: true, responseId: "r1" });
  await act(async () => new Promise((r) => setTimeout(r, 10)));
});
