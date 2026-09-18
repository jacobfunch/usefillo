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
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { FilloForm, FilloProvider, FormField } = await import("../dist/index.js");

const form = {
  version: 1,
  title: "T",
  settings: {},
  pages: [{ id: "p1", blocks: [{ id: "name", kind: "short_text", label: "Name", required: true }] }],
};

const STORAGE_URL = "https://fillo.so/settings/storage";

/** Draft sync result with the storage_required warning, as the server sends
 * it for a code form with upload fields and no connected storage. */
function draftStorageSync(formId, slug) {
  return {
    formId,
    slug,
    status: "draft",
    warning: "The form stays a draft until a storage destination is connected.",
    warningCode: "storage_required",
    warningUrl: STORAGE_URL,
    uploadsAvailable: false,
  };
}

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
  return { target, root };
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

test("preview forces the dev chrome in production, renders the badge, and warns once", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  const prevInfo = console.info;
  process.env.NODE_ENV = "production";
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  console.info = () => {};
  try {
    const codeForm = { id: "preview-prod", schema: form, __filloCodeForm: true };
    const client = fakeClient({
      syncForm: async () => draftStorageSync("f-preview-prod", "preview-prod"),
    });
    const { target } = await mount(
      React.createElement(FilloForm, { form: codeForm, client, preview: true }),
    );
    await act(async () => new Promise((r) => setTimeout(r, 10)));

    // The hostname is NOT localhost and NODE_ENV is production — only the
    // preview prop keeps the draft rendered with the dev chrome.
    assert.ok(target.querySelector("form"), "preview keeps the draft fillable");
    assert.equal(target.querySelector(".fillo-form--closed"), null);
    assert.match(target.querySelector(".fillo-devwarning").textContent, /Draft form/);
    const badge = target.querySelector(".fillo-preview-badge");
    assert.equal(badge.textContent, "Preview");

    // The cosmetic-only guard fires once per process, even across remounts.
    const guardLines = () =>
      warnings.filter((line) => line.includes("`preview` is enabled in a production build"));
    assert.equal(guardLines().length, 1, "console guard warned");
    await mount(React.createElement(FilloForm, { form: codeForm, client, preview: true }));
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    assert.equal(guardLines().length, 1, "the guard does not repeat");
  } finally {
    console.info = prevInfo;
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

test("preview is cosmetic only: submissions still target the canonical synced form", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  process.env.NODE_ENV = "production";
  console.warn = () => {};
  try {
    const submits = [];
    const codeForm = { id: "preview-cosmetic", schema: form, __filloCodeForm: true };
    const client = fakeClient({
      syncForm: async () => ({
        formId: "f-preview-cosmetic",
        slug: "preview-cosmetic",
        status: "published",
      }),
      submit: async (formId, data) => {
        submits.push({ formId, data });
        return { ok: true, responseId: "r-preview" };
      },
    });
    const { target } = await mount(
      React.createElement(FilloForm, { form: codeForm, client, preview: true }),
    );
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    await type(target.querySelector('[data-field="name"] input'), "Ada");
    await act(async () => {
      target.querySelector("form").dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    assert.deepEqual(submits, [{ formId: "f-preview-cosmetic", data: { name: "Ada" } }]);
  } finally {
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

test("no badge and no dev chrome without the preview prop outside development", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  const prevInfo = console.info;
  process.env.NODE_ENV = "production";
  console.warn = () => {};
  console.info = () => {};
  try {
    const codeForm = { id: "no-preview-prod", schema: form, __filloCodeForm: true };
    const client = fakeClient({
      syncForm: async () => draftStorageSync("f-no-preview", "no-preview-prod"),
    });
    const { target } = await mount(React.createElement(FilloForm, { form: codeForm, client }));
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    assert.ok(target.querySelector(".fillo-form--not-open"), "production stays fail-closed");
    assert.equal(target.querySelector("form"), null, "no submittable form element");
    assert.equal(target.querySelector(".fillo-preview-badge"), null);
    assert.equal(target.querySelector(".fillo-devwarning"), null);
  } finally {
    console.info = prevInfo;
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

test("dev chrome surfaces the developer-grade submit failure with the storage deep-link", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  const prevInfo = console.info;
  process.env.NODE_ENV = "development";
  console.warn = () => {};
  console.info = () => {};
  try {
    let submitCalls = 0;
    const codeForm = { id: "verbose-error-dev", schema: form, __filloCodeForm: true };
    const client = fakeClient({
      syncForm: async () => draftStorageSync("f-verbose-error", "verbose-error-dev"),
      submit: async () => {
        submitCalls += 1;
        return { ok: true, responseId: "should-not-send" };
      },
    });
    const { target } = await mount(React.createElement(FilloForm, { form: codeForm, client }));
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    await type(target.querySelector('[data-field="name"] input'), "Ada");
    await act(async () => {
      target.querySelector("form").dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      );
    });

    assert.equal(submitCalls, 0, "the draft never receives answers");
    const alert = target.querySelector(".fillo-submit-error");
    // The real reason + machine code, not the visitor-facing "unavailable".
    assert.match(alert.textContent, /no longer published/i);
    assert.match(alert.textContent, /form_not_published/);
    assert.doesNotMatch(alert.textContent, /This form is unavailable/);
    // The fix rides along: the sync result's warningUrl as a real link.
    assert.match(alert.textContent, /Connect storage:/);
    assert.equal(alert.querySelector("a").getAttribute("href"), STORAGE_URL);
  } finally {
    console.info = prevInfo;
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

test("storage-blocked dropzone pre-empts uploads with the connect-storage link", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  const prevInfo = console.info;
  process.env.NODE_ENV = "development";
  console.warn = () => {};
  console.info = () => {};
  try {
    const uploadForm = {
      version: 1,
      title: "T",
      settings: {},
      pages: [{ id: "p1", blocks: [{ id: "files", kind: "file_upload", label: "Files" }] }],
    };
    let uploadCalls = 0;
    const codeForm = { id: "storage-blocked-zone", schema: uploadForm, __filloCodeForm: true };
    const client = fakeClient({
      syncForm: async () => draftStorageSync("f-storage-blocked", "storage-blocked-zone"),
      uploadFile: async () => {
        uploadCalls += 1;
        throw new Error("must not be attempted");
      },
    });
    const { target } = await mount(React.createElement(FilloForm, { form: codeForm, client }));
    await act(async () => new Promise((r) => setTimeout(r, 10)));

    const dropzone = target.querySelector(".fillo-dropzone");
    assert.match(dropzone.textContent, /Connect file storage to enable uploads/);
    assert.equal(dropzone.querySelector("a").getAttribute("href"), STORAGE_URL);
    assert.match(dropzone.className, /fillo-dropzone--disabled/);

    // Even a forced change event must not start an upload the server would
    // refuse — the field is pre-empted, not merely styled.
    const input = target.querySelector('input[type="file"]');
    assert.equal(input.disabled, true);
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new File(["a"], "a.txt")],
    });
    await act(async () => {
      input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.equal(uploadCalls, 0, "no upload attempt reaches the client");
  } finally {
    console.info = prevInfo;
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

test("chrome precedence renders only the most relevant notice (sync-error wins)", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  const prevInfo = console.info;
  process.env.NODE_ENV = "development";
  console.warn = () => {};
  console.info = () => {};
  try {
    const live = {
      ...form,
      pages: [{ id: "p1", blocks: [{ id: "liveName", kind: "short_text", label: "Live name" }] }],
    };
    const codeForm = { id: "precedence-dev", schema: form, __filloCodeForm: true };
    const client = fakeClient({
      syncForm: async () => ({
        formId: "f-precedence",
        slug: "precedence-dev",
        status: "published",
        staged: true,
        resolvedSchema: live,
        resolvedTheme: null,
        syncError: { code: "trusted_sync_required", message: "Run `fillo forms push` first." },
      }),
    });
    const { target } = await mount(React.createElement(FilloForm, { form: codeForm, client }));
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    const notices = target.querySelectorAll(".fillo-devwarning");
    assert.equal(notices.length, 1, "exactly one notice, not a stack");
    assert.match(notices[0].textContent, /needs attention \(trusted_sync_required\)/);
    assert.doesNotMatch(notices[0].textContent, /staged/i);
  } finally {
    console.info = prevInfo;
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

test("devNotices={false} hides the notices but keeps the explicit Preview badge", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  const prevInfo = console.info;
  process.env.NODE_ENV = "development";
  console.warn = () => {};
  console.info = () => {};
  try {
    const codeForm = { id: "optout-dev", schema: form, __filloCodeForm: true };
    const client = fakeClient({
      syncForm: async () => draftStorageSync("f-optout", "optout-dev"),
    });
    const { target } = await mount(
      React.createElement(FilloForm, {
        form: codeForm,
        client,
        preview: true,
        devNotices: false,
      }),
    );
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    assert.ok(target.querySelector("form"), "the draft still renders");
    assert.equal(target.querySelector(".fillo-devwarning"), null, "notices opted out");
    assert.ok(target.querySelector(".fillo-preview-badge"), "the explicit badge stays");
  } finally {
    console.info = prevInfo;
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

test("FilloProvider preview parity: draft children render in production, still layout-free", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  const prevInfo = console.info;
  process.env.NODE_ENV = "production";
  console.warn = () => {};
  console.info = () => {};
  try {
    const uploadForm = {
      version: 1,
      title: "T",
      settings: {},
      pages: [{ id: "p1", blocks: [{ id: "files", kind: "file_upload", label: "Files" }] }],
    };
    const codeForm = { id: "provider-preview", schema: uploadForm, __filloCodeForm: true };
    const client = fakeClient({
      syncForm: async () => draftStorageSync("f-provider-preview", "provider-preview"),
    });

    // Without preview: production withholds unpublished draft children.
    const withheld = await mount(
      React.createElement(
        FilloProvider,
        { form: codeForm, client },
        React.createElement(FormField, { id: "files" }),
      ),
    );
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    assert.equal(withheld.target.childNodes.length, 0, "no preview → unchanged null");

    // With preview: children render, the provider injects no chrome of its
    // own, and the composed dropzone still gets the storage pre-emption.
    const { target } = await mount(
      React.createElement(
        FilloProvider,
        { form: codeForm, client, preview: true },
        React.createElement(FormField, { id: "files" }),
      ),
    );
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    const dropzone = target.querySelector(".fillo-dropzone");
    assert.ok(dropzone, "preview reveals the composed field");
    assert.equal(target.querySelector(".fillo-preview-badge"), null, "headless injects no badge");
    assert.equal(target.querySelector(".fillo-devwarning"), null, "headless injects no notices");
    assert.match(dropzone.textContent, /Connect file storage to enable uploads/);
    assert.equal(dropzone.querySelector("a").getAttribute("href"), STORAGE_URL);
  } finally {
    console.info = prevInfo;
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

test("a stale storage link never rides an unrelated submit failure", async () => {
  // Mount sees a draft with the storage warning; by submit time storage was
  // connected and the form published — the submit then fails on transport.
  // The alert must show the transport failure alone: the resync refreshed the
  // warning snapshot, and the deep-link only renders with form_not_published.
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  const prevInfo = console.info;
  process.env.NODE_ENV = "development";
  console.warn = () => {};
  console.info = () => {};
  try {
    let syncCalls = 0;
    const codeForm = { id: "stale-warning-dev", schema: form, __filloCodeForm: true };
    const client = fakeClient({
      syncForm: async () => {
        syncCalls += 1;
        return syncCalls === 1
          ? draftStorageSync("f-stale-warning", "stale-warning-dev")
          : { formId: "f-stale-warning", slug: "stale-warning-dev", status: "published" };
      },
      submit: async () => {
        throw new Error("network down");
      },
    });
    const { target } = await mount(React.createElement(FilloForm, { form: codeForm, client }));
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    await type(target.querySelector('[data-field="name"] input'), "Ada");
    await act(async () => {
      target.querySelector("form").dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await act(async () => new Promise((r) => setTimeout(r, 10)));

    const alert = target.querySelector(".fillo-submit-error");
    assert.ok(alert, "the transport failure surfaces as a submit error");
    assert.doesNotMatch(
      alert.textContent,
      /Connect storage/,
      "the mount-time storage link must not decorate a transport failure",
    );
  } finally {
    console.info = prevInfo;
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});
