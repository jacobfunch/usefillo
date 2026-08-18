import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// Minimal DOM for the renderer (it uses the global `document`, and the module
// declares a web-component class `extends HTMLElement` at load) — so globals
// must exist before the module is imported.
const dom = new JSDOM("<!DOCTYPE html><body></body>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
// The renderer preserves caret/selection across re-renders via
// `active instanceof HTMLInputElement | HTMLTextAreaElement`, so those subclasses
// must exist as globals too (a browser always has them).
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
globalThis.Event = dom.window.Event;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.Node = dom.window.Node;
globalThis.File = dom.window.File;
globalThis.customElements = dom.window.customElements;
// Bare `getComputedStyle`/`KeyboardEvent`/`MouseEvent` calls (RTL detection,
// signature canvas color, keyboard-vs-pointer click detection) resolve
// against jsdom's window in a real browser (window IS the global object
// there) but not here, where `window` is just a property pointing at a
// separate jsdom object — wire them through explicitly, same as every other
// DOM global above.
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
globalThis.MouseEvent = dom.window.MouseEvent;
// jsdom doesn't implement scrollIntoView at all (layout-dependent, out of
// scope for its DOM-only simulation) — the phone popover's active-option
// scroll calls it unconditionally. Unpolyfilled, the TypeError aborts the
// rest of openPopover() mid-function (event listeners never attached, the
// rAF-scheduled focus() never scheduled), silently breaking far more than
// just this one un-asserted nicety. No-op is enough for tests.
dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};
// Neither plain Node nor jsdom ships requestAnimationFrame — the phone
// country popover uses it (real browsers always have it) to focus the
// search box after opening. A setTimeout(0) polyfill is enough for tests:
// it's enqueued before `tick()`'s own setTimeout(0) (same-delay timers run
// in scheduling order), so `await tick()` after opening the popover still
// observes the focus move.
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);

const { FilloError, registerFilloElement, renderForm } = await import("../dist/index.js");
// The popover positioner and the picker's display-order country list now
// live in @usefillo/core so the vanilla renderer and @usefillo/react share
// one implementation instead of drifting copies. DEFAULT_STRINGS/
// DEFAULT_FIELD_STRINGS let announcement assertions match the shipped copy
// instead of duplicating (and risking drifting from) literal strings.
const { positionPhonePopover, PHONE_PICKER_COUNTRIES, DEFAULT_STRINGS, DEFAULT_FIELD_STRINGS } =
  await import("@usefillo/core");

const tick = () => new Promise((r) => setTimeout(r, 0)); // flush the queueMicrotask render
const dispatch = (el, type) =>
  el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
const keydown = (el, key, opts = {}) =>
  el.dispatchEvent(
    new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts }),
  );
// The two persistent live-region channels (audit P2.1) — hoisted as siblings
// of the re-rendered root, so they're found on `target` itself, not inside
// any particular render.
const statusChannel = (target) => target.querySelector('[data-fillo="announce"]');
const alertChannel = (target) => target.querySelector('[data-fillo="announce-alert"]');
const localClient = {
  submit: async () => ({ ok: true, responseId: "r-test" }),
  startSession: async () => null,
  reportProgress: () => {},
  uploadFile: async (_formId, file) => ({
    fileId: `local:${file.name}:${file.size}`,
    name: file.name,
    size: file.size,
    mime: file.type || "application/octet-stream",
  }),
};

function mount(form, opts = {}) {
  const target = document.createElement("div");
  document.body.appendChild(target);
  renderForm(target, {
    form,
    ...(!opts.formId && !opts.client && !opts.renderOnly
      ? { formId: "f-test", client: localClient }
      : {}),
    ...opts,
  });
  return target;
}

const oneField = {
  version: 1,
  title: "T",
  settings: {},
  pages: [
    { id: "p1", blocks: [{ id: "name", kind: "short_text", label: "Name", required: true }] },
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

const phoneField = {
  version: 1,
  title: "T",
  settings: {},
  pages: [{ id: "p1", blocks: [{ id: "phone", kind: "phone", label: "Phone" }] }],
};

test("DOM rejects a plain schema without formId before rendering a half-connected form", async () => {
  const target = document.createElement("div");
  document.body.appendChild(target);
  let observed;
  renderForm(target, {
    form: oneField,
    client: localClient,
    onError: (error) => {
      observed = error;
    },
    renderError: (error) => {
      const output = document.createElement("output");
      output.dataset.code = error.code;
      output.textContent = error.message;
      return output;
    },
  });
  await tick();

  assert.equal(target.querySelector("form"), null);
  assert.equal(target.querySelector("output")?.dataset.code, "form_target_required");
  assert.match(target.textContent, /Pass formId with the schema/);
  assert.equal(observed?.code, "form_target_required");
});

test("DOM exposes the resolved form id for embed verification", () => {
  const target = mount(oneField);
  assert.equal(
    target.querySelector('[data-fillo="root"]')?.getAttribute("data-fillo-form-id"),
    "f-test",
  );
});

function withBrowserTimeZone(timeZone, fn) {
  const original = Intl.DateTimeFormat;
  Object.defineProperty(Intl, "DateTimeFormat", {
    configurable: true,
    value: () => ({ resolvedOptions: () => ({ timeZone }) }),
  });
  try {
    return fn();
  } finally {
    Object.defineProperty(Intl, "DateTimeFormat", { configurable: true, value: original });
  }
}

test("positionPhonePopover is shared from @usefillo/core and picks a placement", () => {
  // Nothing to anchor to → the SSR/detached-safe default.
  assert.equal(positionPhonePopover(null, null), "below");

  const anchor = document.createElement("div");
  const popover = document.createElement("div");
  document.body.append(anchor, popover);
  const restore = [];
  const stub = (obj, prop, value) => {
    const prev = Object.getOwnPropertyDescriptor(obj, prop);
    Object.defineProperty(obj, prop, { configurable: true, value });
    restore.push(() => (prev ? Object.defineProperty(obj, prop, prev) : delete obj[prop]));
  };
  try {
    stub(document.documentElement, "clientWidth", 320);
    stub(document.documentElement, "clientHeight", 760);
    stub(popover, "scrollHeight", 400);
    stub(popover, "offsetWidth", 200);

    // Anchor near the bottom: little room below, lots above → opens "above".
    anchor.getBoundingClientRect = () => ({
      top: 700,
      bottom: 720,
      left: 10,
      right: 100,
      width: 90,
      height: 20,
    });
    assert.equal(positionPhonePopover(anchor, popover), "above");

    // Anchor near the top: plenty of room below → opens "below".
    anchor.getBoundingClientRect = () => ({
      top: 10,
      bottom: 30,
      left: 10,
      right: 100,
      width: 90,
      height: 20,
    });
    assert.equal(positionPhonePopover(anchor, popover), "below");
  } finally {
    restore.forEach((fn) => fn());
    anchor.remove();
    popover.remove();
  }
});

test("phone field uses browser timezone as a privacy-light country hint", () => {
  const target = withBrowserTimeZone("Europe/Copenhagen", () => mount(phoneField));
  assert.match(target.querySelector(".fillo-phone-flag").getAttribute("aria-label"), /Denmark/);
});

test("phone defaultCountry overrides browser timezone", () => {
  const target = withBrowserTimeZone("Europe/Copenhagen", () =>
    mount({
      ...phoneField,
      pages: [
        {
          id: "p1",
          blocks: [{ id: "phone", kind: "phone", label: "Phone", defaultCountry: "US" }],
        },
      ],
    }),
  );
  assert.match(
    target.querySelector(".fillo-phone-flag").getAttribute("aria-label"),
    /United States/,
  );
});

test("typing keeps focus and does NOT re-render the input per keystroke", () => {
  const target = mount(oneField);
  const input = target.querySelector(".fillo-field--short_text input");
  assert.ok(input, "text input rendered");
  input.focus();
  assert.equal(document.activeElement, input);
  for (const ch of "hello") {
    input.value += ch;
    dispatch(input, "input");
    assert.equal(document.activeElement, input, "focus stays on the input while typing");
    assert.equal(
      target.querySelector(".fillo-field--short_text input"),
      input,
      "the input element is not recreated on each keystroke",
    );
  }
  assert.equal(input.value, "hello");
});

test("conditional field reveals on change, not on keystroke", async () => {
  const target = mount({
    version: 1,
    title: "T",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [
          { id: "kind", kind: "short_text", label: "Kind" },
          {
            id: "detail",
            kind: "short_text",
            label: "Detail",
            visibleIf: [{ fieldId: "kind", op: "eq", value: "bug" }],
          },
        ],
      },
    ],
  });
  assert.equal(
    target.querySelectorAll(".fillo-field--short_text").length,
    1,
    "only 'kind' visible initially",
  );
  const kind = target.querySelector(".fillo-field--short_text input");
  kind.value = "bug";
  dispatch(kind, "input");
  await tick();
  assert.equal(
    target.querySelectorAll(".fillo-field--short_text").length,
    1,
    "still hidden after keystroke (renderer doesn't redraw mid-type)",
  );
  dispatch(kind, "change");
  await tick();
  assert.equal(
    target.querySelectorAll(".fillo-field--short_text").length,
    2,
    "'detail' revealed on change",
  );
});

test("multi-page: submit-event advances only after the page validates", async () => {
  const target = mount({
    version: 1,
    title: "T",
    settings: {},
    pages: [
      { id: "p1", blocks: [{ id: "name", kind: "short_text", label: "Name", required: true }] },
      { id: "p2", blocks: [{ id: "email", kind: "email", label: "Email" }] },
    ],
  });
  dispatch(target.querySelector("form"), "submit"); // invalid → blocked
  await tick();
  assert.ok(target.querySelector(".fillo-field--short_text"), "still on page 1");
  const name = target.querySelector(".fillo-field--short_text input");
  name.value = "Ada";
  dispatch(name, "change");
  await tick();
  dispatch(target.querySelector("form"), "submit"); // valid → advance
  await tick();
  assert.ok(target.querySelector(".fillo-field--email"), "advanced to page 2");
});

test("submit posts through the client and renders the success screen", async () => {
  let received = null;
  const client = {
    startSession: async () => null,
    reportProgress() {},
    submit: async (_formId, data) => {
      received = data;
      return { ok: true, responseId: "r1" };
    },
  };
  const target = mount(oneField, { formId: "f1", client });
  const input = target.querySelector(".fillo-field--short_text input");
  input.value = "Ada";
  dispatch(input, "change");
  await tick();
  dispatch(target.querySelector("form"), "submit");
  await tick();
  await tick();
  assert.deepEqual(received, { name: "Ada" });
  assert.ok(target.querySelector(".fillo-form--success"), "success screen rendered");
  assert.equal(target.querySelector(".fillo-success-mark").textContent, "");
});

test("honeypot reads a programmatic DOM value without relying on an input event", async () => {
  let meta = null;
  const client = {
    startSession: async () => null,
    reportProgress() {},
    submit: async (_formId, _data, submittedMeta) => {
      meta = submittedMeta;
      return { ok: true, responseId: "r1" };
    },
  };
  const target = mount(oneField, { formId: "f1", client });
  const input = target.querySelector(".fillo-field--short_text input");
  input.value = "Ada";
  dispatch(input, "change");
  await tick();
  target.querySelector('input[name="fillo_hp_field"]').value = "bot-filled";
  dispatch(target.querySelector("form"), "submit");
  await tick();
  await tick();
  assert.equal(meta?.hp, "bot-filled");
});

test("multi-page progress uses a named, one-based ARIA range", () => {
  const target = mount({
    ...oneField,
    title: "Account survey",
    pages: [oneField.pages[0], { id: "p2", blocks: [] }],
  });
  const progress = target.querySelector('[role="progressbar"]');
  assert.equal(progress.getAttribute("aria-valuemin"), "1");
  assert.equal(progress.getAttribute("aria-valuenow"), "1");
  assert.equal(progress.getAttribute("aria-label"), "Account survey");
});

test("renderer exposes stable slot and state attributes", async () => {
  const target = mount({
    version: 1,
    title: "Feedback",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [
          {
            id: "vote",
            kind: "select",
            label: "Helpful?",
            required: true,
            options: [
              { id: "yes", label: "Yes" },
              { id: "no", label: "No" },
            ],
          },
        ],
      },
    ],
  });

  const root = target.querySelector('[data-fillo="root"]');
  assert.equal(root.getAttribute("data-state"), "idle");
  assert.equal(root.getAttribute("data-page"), "1");
  assert.ok(root.hasAttribute("data-last-page"));
  assert.equal(target.querySelector('[data-fillo="title"]')?.textContent, "Feedback");

  let field = target.querySelector('[data-fillo="field"]');
  assert.equal(field.getAttribute("data-field"), "vote");
  assert.equal(field.getAttribute("data-kind"), "select");
  assert.ok(field.hasAttribute("data-required"));
  assert.equal(field.querySelector('[data-fillo="label"]')?.textContent, "Helpful?");
  assert.equal(field.querySelector('[data-fillo="options"]')?.getAttribute("role"), "radiogroup");

  dispatch(root, "submit");
  await tick();
  field = target.querySelector('[data-field="vote"]');
  assert.ok(field.hasAttribute("data-invalid"));
  // Per-field messages are describedby text; failed submit focuses this
  // invalid control so the linked guidance is announced in context.
  assert.equal(field.querySelector('[data-fillo="error"]')?.getAttribute("role"), null);

  const yes = target.querySelector('[data-option="yes"] input');
  yes.checked = true;
  dispatch(yes, "change");
  await tick();
  assert.ok(target.querySelector('[data-option="yes"]').hasAttribute("data-selected"));
  assert.equal(target.querySelector('[data-field="vote"]').hasAttribute("data-invalid"), false);
});

test("composite controls expose labeled groups and native radio keyboard semantics", async () => {
  const target = mount({
    version: 1,
    title: "Composite fields",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [
          { id: "rating", kind: "rating", label: "Rating", required: true, max: 5 },
          {
            id: "scale",
            kind: "linear_scale",
            label: "Scale",
            min: 1,
            max: 3,
            minLabel: "Low",
            maxLabel: "High",
          },
          {
            id: "rank",
            kind: "ranking",
            label: "Rank",
            required: true,
            options: [
              { id: "a", label: "A" },
              { id: "b", label: "B" },
            ],
          },
          {
            id: "matrix",
            kind: "matrix",
            label: "Matrix",
            required: true,
            rows: [{ id: "r", label: "Row" }],
            columns: [{ id: "c", label: "Column" }],
          },
        ],
      },
    ],
  });

  const ratingField = target.querySelector('[data-field="rating"]');
  const rating = ratingField.querySelector('[role="radiogroup"]');
  assert.equal(rating.id, ratingField.querySelector('[data-fillo="label"]').getAttribute("for"));
  assert.equal(rating.getAttribute("aria-required"), "true");
  assert.equal(rating.querySelectorAll('[role="radio"][tabindex="0"]').length, 1);
  rating.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  await tick();
  assert.equal(
    target
      .querySelector('[data-field="rating"] [role="radio"][aria-checked="true"]')
      ?.getAttribute("aria-label"),
    "1 of 5",
  );

  const scale = target.querySelector('[data-field="scale"] [role="radiogroup"]');
  assert.match(scale.getAttribute("aria-describedby"), /-min/);
  assert.match(scale.getAttribute("aria-describedby"), /-max/);
  assert.equal(scale.querySelectorAll('[role="radio"][tabindex="0"]').length, 1);

  for (const fieldId of ["rank", "matrix"]) {
    const field = target.querySelector(`[data-field="${fieldId}"]`);
    const group = field.querySelector('[role="group"]');
    const label = field.querySelector('[data-fillo="label"]');
    assert.equal(group.id, label.getAttribute("for"));
    assert.equal(group.getAttribute("aria-labelledby"), label.id);
    // Unlike the radiogroups above, role="group" doesn't support
    // aria-required (ARIA 1.2 aria-allowed-attr, ledger #1) — it must NOT
    // land here even though both fields are required.
    assert.equal(group.hasAttribute("aria-required"), false);
  }
});

test("auto submit mode hides the final button and submits a discrete answer", async () => {
  let received = null;
  const client = {
    startSession: async () => null,
    reportProgress() {},
    submit: async (_formId, data) => {
      received = data;
      return { ok: true, responseId: "r1" };
    },
  };
  const target = mount(
    {
      version: 1,
      title: "Article feedback",
      settings: { submitMode: "auto" },
      pages: [
        {
          id: "p1",
          blocks: [
            {
              id: "vote",
              kind: "select",
              label: "Was this helpful?",
              required: true,
              options: [
                { id: "up", label: "Thumbs up" },
                { id: "down", label: "Thumbs down" },
              ],
            },
          ],
        },
      ],
    },
    { formId: "f1", client },
  );

  assert.equal(
    target.querySelector(".fillo-button--primary"),
    null,
    "final submit button is hidden",
  );
  const up = target.querySelector('[data-option="up"] input');
  up.checked = true;
  dispatch(up, "change");
  await tick();
  await tick();
  assert.deepEqual(received, { vote: "up" });
  assert.ok(target.querySelector(".fillo-form--success"), "success screen rendered");
});

test("auto submit ignores hidden fields — a single visible question still one-taps", async () => {
  let received = null;
  const client = {
    startSession: async () => null,
    reportProgress() {},
    submit: async (_formId, data) => {
      received = data;
      return { ok: true, responseId: "r1" };
    },
  };
  const target = mount(
    {
      version: 1,
      title: "Docs feedback",
      settings: { submitMode: "auto" },
      pages: [
        {
          id: "p1",
          blocks: [
            {
              id: "vote",
              kind: "select",
              label: "Helpful?",
              required: true,
              options: [
                { id: "up", label: "Yes" },
                { id: "down", label: "No" },
              ],
            },
            // Hidden metadata (e.g. the article path) must NOT count as a second
            // question — the form is still a single tap.
            { id: "page", kind: "hidden", label: "Page", defaultValue: "/docs/intro" },
          ],
        },
      ],
    },
    { formId: "f1", client },
  );

  assert.equal(
    target.querySelector(".fillo-button--primary"),
    null,
    "no submit button — a hidden field must not force one",
  );
  const up = target.querySelector('[data-option="up"] input');
  up.checked = true;
  dispatch(up, "change");
  await tick();
  await tick();
  assert.ok(received && received.vote === "up", "auto-submitted on the single visible question");
});

test("auto mode keeps a submit button when no field can trigger auto-submit", () => {
  const target = mount({
    version: 1,
    title: "Notice",
    settings: { submitMode: "auto" },
    pages: [{ id: "p1", blocks: [{ id: "copy", kind: "paragraph", text: "Continue" }] }],
  });
  assert.ok(target.querySelector(".fillo-button--primary"));
});

test("auto submit waits and shows a button when a discrete answer reveals text", async () => {
  let received = null;
  const client = {
    startSession: async () => null,
    reportProgress() {},
    submit: async (_formId, data) => {
      received = data;
      return { ok: true, responseId: "r1" };
    },
  };
  const target = mount(
    {
      version: 1,
      title: "Article feedback",
      settings: { submitMode: "auto" },
      pages: [
        {
          id: "p1",
          blocks: [
            {
              id: "vote",
              kind: "select",
              label: "Was this helpful?",
              required: true,
              options: [
                { id: "up", label: "Yes" },
                { id: "down", label: "No" },
              ],
            },
            {
              id: "unclear",
              kind: "long_text",
              label: "What was unclear?",
              required: true,
              visibleIf: [{ fieldId: "vote", op: "eq", value: "down" }],
            },
          ],
        },
      ],
    },
    { formId: "f1", client },
  );

  assert.equal(target.querySelector(".fillo-button--primary"), null, "initial button is hidden");
  const down = target.querySelector('[data-option="down"] input');
  down.checked = true;
  dispatch(down, "change");
  await tick();
  await tick();
  assert.equal(received, null, "not submitted before the required text answer");
  assert.ok(target.querySelector(".fillo-field--long_text textarea"), "follow-up text rendered");
  assert.ok(
    target.querySelector(".fillo-button--primary"),
    "submit button returns for text follow-up",
  );

  const textarea = target.querySelector(".fillo-field--long_text textarea");
  textarea.value = "The install step was unclear.";
  dispatch(textarea, "input");
  dispatch(textarea, "change");
  await tick();
  dispatch(target.querySelector("form"), "submit");
  await tick();
  await tick();
  assert.deepEqual(received, { vote: "down", unclear: "The install step was unclear." });
});

test("dropdown Other sentinel cannot shadow a real option id", async () => {
  const changes = [];
  const target = mount(
    {
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
              options: [{ id: "__fillo_other__", label: "Real option" }],
            },
          ],
        },
      ],
    },
    { onChange: (data) => changes.push(data.pick) },
  );
  const select = target.querySelector("select");
  select.value = "__fillo_other__";
  dispatch(select, "change");
  await tick();
  assert.equal(changes.at(-1), "__fillo_other__");
  assert.equal(target.querySelector(".fillo-other-input"), null);
});

test("a genuine upload failure renders its own failed row and announces via the alert channel", async () => {
  const diagnostic = new FilloError("Box upload failed: 403 xoxb-secret", 403);
  const observed = [];
  const client = {
    uploadFile: async () => {
      throw diagnostic;
    },
  };
  const target = mount(
    {
      version: 1,
      title: "T",
      settings: {},
      pages: [{ id: "p1", blocks: [{ id: "files", kind: "file_upload", label: "Files" }] }],
    },
    { formId: "f1", client, onError: (error) => observed.push(error) },
  );
  const input = target.querySelector('input[type="file"]');
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [new File(["a"], "a.txt")],
  });
  dispatch(input, "change");
  await tick();
  await tick();
  assert.ok(target.querySelector("form"), "form remains available for retry");
  // Ported per-file row structure (audit P0.3) — no more aggregate
  // .fillo-upload-notice for a genuine per-file failure.
  const row = target.querySelector(".fillo-file--failed");
  assert.ok(row, "the failed file gets its own row");
  const error = row.querySelector(".fillo-file-error");
  assert.match(error.textContent, /Upload failed/u);
  assert.doesNotMatch(error.textContent, /Box|403|xoxb-secret/u);
  assert.equal(observed.at(-1), diagnostic);
  // Visible row text carries no live role of its own — the persistent alert
  // channel does (audit P2.1/P1.7 — hoisted outside the re-rendered tree).
  assert.equal(error.getAttribute("role"), null);
  assert.equal(row.getAttribute("role"), null);
  assert.match(alertChannel(target).textContent, /Upload failed/u);
  assert.ok(
    row.querySelector(".fillo-file-retry"),
    "retry is offered — there's room to retry into",
  );
  assert.deepEqual(
    [...row.children].map((child) => child.className),
    ["fillo-file-state fillo-file-state--failed", "fillo-file-content", "fillo-file-actions"],
    "failed uploads keep state, content, and actions in the shared row anatomy",
  );
  assert.ok(row.querySelector('button[aria-label="Retry a.txt"]'));
  assert.ok(row.querySelector('button[aria-label="Dismiss a.txt"]'));
});

test("upload capacity notice (too many files) has no live role — announced via the persistent status channel", async () => {
  const target = mount({
    version: 1,
    title: "T",
    settings: {},
    pages: [
      { id: "p1", blocks: [{ id: "files", kind: "file_upload", label: "Files", maxFiles: 1 }] },
    ],
  });
  const input = target.querySelector('input[type="file"]');
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [new File(["a"], "a.txt"), new File(["b"], "b.txt")],
  });
  dispatch(input, "change");
  await tick();
  await tick();
  const notice = target.querySelector(".fillo-upload-notice");
  assert.match(notice?.textContent ?? "", /You can attach up to 1 file/);
  // Soft capacity notice — visible text, no role (audit P2.1/P2.8); the
  // persistent polite channel carries the announcement instead.
  assert.equal(notice.getAttribute("role"), null);
  assert.match(statusChannel(target).textContent, /You can attach up to 1 file/);
});

test("definitive code-form sync failures fail closed in production with generic copy", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  process.env.NODE_ENV = "production";
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const message = "Run `fillo forms push` with an fsync token, then try again.";
    const failure = new FilloError(message, 403, undefined, "trusted_sync_required");
    const observed = [];
    const client = {
      key: "pk_trusted_fatal_dom",
      baseUrl: "https://trusted-fatal-dom.test",
      syncForm: async () => {
        throw failure;
      },
    };
    const target = document.createElement("div");
    document.body.appendChild(target);
    const instance = renderForm(target, {
      form: { id: "trusted-fatal-dom", schema: oneField, __filloCodeForm: true },
      client,
      onError: (error) => observed.push(error),
    });
    await tick();

    assert.equal(instance.status, "error");
    assert.equal(target.querySelector("form"), null);
    assert.equal(
      target.querySelector('[data-state="error"]').textContent,
      "This form is unavailable.",
    );
    assert.doesNotMatch(target.textContent, /fillo forms push|fsync|trusted_sync_required/i);
    assert.equal(observed.at(-1), failure);
    assert.equal(observed.at(-1).code, "trusted_sync_required");
    assert.ok(
      warnings.some((line) => line.includes("trusted_sync_required") && line.includes(message)),
    );
  } finally {
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

test("DOM renderError receives the exact machine-coded sync failure", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  process.env.NODE_ENV = "production";
  console.warn = () => {};
  try {
    const failure = new FilloError(
      "Use a trusted deployment token.",
      403,
      undefined,
      "trusted_sync_required",
    );
    let rendered = null;
    const target = mount(
      { id: "trusted-render-error-dom", schema: oneField, __filloCodeForm: true },
      {
        client: {
          key: "pk_trusted_render_error_dom",
          baseUrl: "https://trusted-render-error-dom.test",
          syncForm: async () => {
            throw failure;
          },
        },
        renderError: (error) => {
          rendered = error;
          const node = document.createElement("div");
          node.id = "custom-sync-error";
          node.textContent = `${error.code}: ${error.message}`;
          return node;
        },
      },
    );
    await tick();
    assert.equal(rendered, failure);
    assert.match(target.querySelector("#custom-sync-error").textContent, /trusted_sync_required/);
  } finally {
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

// Everything a keyboard or pointer could reach. :disabled (not [disabled])
// so controls disabled through the fieldset ancestor count as disabled too.
const FOCUSABLE_PREVIEW =
  'a[href], [tabindex]:not([tabindex="-1"]), ' +
  "input:not(:disabled), button:not(:disabled), select:not(:disabled), textarea:not(:disabled)";

test("DOM production draft renders a safe display-only form behind the not-open state", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevInfo = console.info;
  process.env.NODE_ENV = "production";
  console.info = () => {};
  try {
    let submitCalls = 0;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const handle = renderForm(host, {
      form: { id: "draft-notlive-dom", schema: oneField, __filloCodeForm: true },
      client: {
        key: "pk_draft_notlive_dom",
        baseUrl: "https://draft-notlive-dom.test",
        syncForm: async () => ({ formId: "f-notlive", slug: "notlive", status: "draft" }),
        submit: async () => {
          submitCalls += 1;
          return { ok: true, responseId: "never" };
        },
      },
    });
    const target = handle.element;
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Honest chrome: the default stylesheet presents the friendly state while
    // the real form remains safely display-only in the DOM.
    assert.ok(target.querySelector(".fillo-form--not-open"), "not-open state shown");
    assert.match(target.querySelector(".fillo-not-open-title").textContent, /isn't open yet/);
    assert.match(
      target.querySelector(".fillo-not-open-body").textContent,
      /form owner is still setting things up/,
    );
    assert.match(target.textContent, /Name/, "the real schema renders in the preview");

    // Impossible to fill: no form element at all, the preview is inert and
    // aria-hidden, every control sits in a natively disabled fieldset, and
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
    assert.equal(preview.querySelectorAll(FOCUSABLE_PREVIEW).length, 0, "zero focusable elements");
    assert.equal(preview.querySelector('input[name="fillo_hp_field"]'), null, "no honeypot trap");

    // The submit path stays unreachable by construction — even programmatic
    // calls through the public handle are no-ops.
    await handle.submit();
    handle.setValue("name", "Ada");
    handle.next();
    await handle.submit();
    assert.equal(submitCalls, 0, "no submit can ever fire from the preview");
    assert.deepEqual(handle.data, {}, "the display-only preview accepts no writes");
  } finally {
    console.info = prevInfo;
    process.env.NODE_ENV = prevEnv;
  }
});

test("DOM published code form the server marks expired shows the closed-flavor card", async () => {
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const target = mount(
      { id: "expired-overlay-dom", schema: oneField, __filloCodeForm: true },
      {
        client: {
          key: "pk_expired_overlay_dom",
          baseUrl: "https://expired-overlay-dom.test",
          syncForm: async () => ({
            formId: "f-expired-dom",
            slug: "expired-overlay-dom",
            status: "published",
            accepting: false,
            acceptingReason: "expired",
          }),
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(target.querySelector(".fillo-form--not-open"));
    assert.match(target.querySelector(".fillo-not-open-title").textContent, /Responses are closed/);
    assert.match(
      target.querySelector(".fillo-not-open-body").textContent,
      /no longer accepting responses/,
    );
    assert.equal(target.querySelector("form"), null, "no fillable form");
    assert.equal(
      target.querySelector(".fillo-not-open-preview").querySelectorAll(FOCUSABLE_PREVIEW).length,
      0,
    );
  } finally {
    process.env.NODE_ENV = prevEnv;
  }
});

test("DOM hosted accepting:false gets the not-open state; a legacy closed flag keeps the panel", async () => {
  // Newer envelope: accepting:false + reason renders the not-open state.
  const capped = mount(undefined, {
    formId: "f-hosted-capped-dom",
    client: {
      getForm: async () => ({
        id: "f-hosted-capped-dom",
        slug: "hosted-capped-dom",
        schema: oneField,
        theme: null,
        accepting: false,
        acceptingReason: "storage_full",
      }),
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(capped.querySelector(".fillo-form--not-open"));
  assert.match(capped.querySelector(".fillo-not-open-title").textContent, /Responses are closed/);
  assert.equal(capped.querySelector("form"), null);
  assert.equal(capped.querySelector(".fillo-report-abuse"), null, "no report link is injected");

  // Older server (no accepting field): today's closed panel, exactly.
  const legacy = mount(undefined, {
    formId: "f-hosted-closed-legacy-dom",
    client: {
      getForm: async () => ({
        id: "f-hosted-closed-legacy-dom",
        slug: "hosted-closed-legacy-dom",
        schema: oneField,
        theme: null,
        closed: true,
      }),
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(legacy.querySelector(".fillo-form--closed"), "legacy closed panel unchanged");
  assert.equal(legacy.querySelector(".fillo-form--not-open"), null);
  assert.match(legacy.textContent, /no longer accepting responses/);
});

test("DOM hosted not-accepting envelopes honor renderError", async () => {
  let rendered = null;
  const target = mount(undefined, {
    formId: "f-hosted-render-error-dom",
    client: {
      getForm: async () => ({
        id: "f-hosted-render-error-dom",
        slug: "hosted-render-error-dom",
        schema: oneField,
        theme: null,
        accepting: false,
        acceptingReason: "expired",
      }),
    },
    renderError: (error) => {
      rendered = error;
      const node = document.createElement("div");
      node.id = "hosted-render-error-dom";
      node.textContent = "Host-owned state";
      return node;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(target.querySelector(".fillo-form--not-open"), null);
  assert.equal(target.querySelector("#hosted-render-error-dom").textContent, "Host-owned state");
  assert.equal(rendered?.status, 403);
  assert.equal(rendered?.code, "expired");
});

test("DOM hosted optional uploads disable only the file control", async () => {
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
  const target = mount(undefined, {
    formId: "f-hosted-optional-upload-dom",
    client: {
      getForm: async () => ({
        id: "f-hosted-optional-upload-dom",
        slug: "hosted-optional-upload-dom",
        schema: optionalUpload,
        theme: null,
        accepting: true,
        uploadsAvailable: false,
      }),
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.ok(target.querySelector("form"), "ordinary answers remain fillable");
  assert.equal(target.querySelector('input[type="text"]').disabled, false);
  assert.equal(target.querySelector('input[type="file"]').disabled, true);
  assert.match(target.textContent, /Uploads are temporarily unavailable/);
});

test("DOM hosted advisory storage warnings do not disable uploads", async () => {
  const target = mount(undefined, {
    formId: "f-hosted-upload-advisory-dom",
    client: {
      getForm: async () => ({
        id: "f-hosted-upload-advisory-dom",
        slug: "hosted-upload-advisory-dom",
        schema: uploadForm,
        theme: null,
        accepting: true,
        uploadsAvailable: true,
        warningCode: "transit_approaching_cap",
      }),
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(target.querySelector('input[type="file"]').disabled, false);
  assert.doesNotMatch(target.textContent, /Uploads are temporarily unavailable/);
});

test("DOM hosted forms enforce the active storage lane's lower file limit", async () => {
  let uploadCalls = 0;
  const schema = {
    ...uploadForm,
    pages: [
      {
        ...uploadForm.pages[0],
        blocks: uploadForm.pages[0].blocks.map((field) =>
          field.kind === "file_upload" ? { ...field, maxFileSizeMb: 25 } : field,
        ),
      },
    ],
  };
  const target = mount(undefined, {
    formId: "f-hosted-transit-limit-dom",
    client: {
      getForm: async () => ({
        id: "f-hosted-transit-limit-dom",
        slug: "hosted-transit-limit-dom",
        schema,
        theme: null,
        accepting: true,
        uploadsAvailable: true,
        uploadFileSizeLimitMb: 10,
      }),
      uploadFile: async () => {
        uploadCalls += 1;
        throw new Error("oversized file should be rejected locally");
      },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const input = target.querySelector('input[type="file"]');
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [new File([new Uint8Array(11 * 1024 * 1024)], "large.pdf")],
  });
  dispatch(input, "change");
  await tick();

  assert.equal(uploadCalls, 0, "oversized file is rejected before creating an upload session");
  assert.match(
    target.querySelector(".fillo-file--failed .fillo-file-error").textContent,
    /Larger than 10 MB limit/,
  );
  assert.equal(target.querySelector(".fillo-file--failed .fillo-file-retry"), null);
});

test("DOM code forms disable only new uploads when storage is hard-unavailable", async () => {
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const target = mount(
      { id: "upload-hard-full-dom", schema: uploadForm, __filloCodeForm: true },
      {
        client: {
          key: "pk_upload_hard_full_dom",
          baseUrl: "https://upload-hard-full-dom.test",
          syncForm: async () => ({
            formId: "f-upload-hard-full-dom",
            slug: "upload-hard-full-dom",
            status: "published",
            accepting: true,
            uploadsAvailable: false,
          }),
        },
      },
    );
    await tick();

    assert.ok(target.querySelector("form"), "the response remains fillable");
    assert.equal(target.querySelector('input[type="text"]').disabled, false);
    assert.equal(target.querySelector('input[type="file"]').disabled, true);
  } finally {
    process.env.NODE_ENV = prevEnv;
  }
});

test("DOM production build on localhost keeps a draft rendered and logs the storage link", async () => {
  // Standalone <script> tags and vite preview / next start have no dev
  // NODE_ENV — hostname detection must keep the local dev path working.
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  const prevInfo = console.info;
  process.env.NODE_ENV = "production";
  const infos = [];
  console.warn = () => {};
  console.info = (...args) => infos.push(args.join(" "));
  dom.reconfigure({ url: "http://localhost:3000/" });
  try {
    const target = mount(
      { id: "draft-localhost-dom", schema: oneField, __filloCodeForm: true },
      {
        client: {
          key: "pk_draft_localhost_dom",
          baseUrl: "https://draft-localhost-dom.test",
          syncForm: async () => ({
            formId: "f-localhost-dom",
            slug: "draft-localhost",
            status: "draft",
            warning: "The form stays a draft until a storage destination is connected.",
            warningCode: "storage_required",
            warningUrl: "https://fillo.so/settings/storage",
          }),
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(target.querySelector("form"), "the draft still renders locally");
    assert.equal(target.querySelector(".fillo-form--closed"), null, "no dead not-live panel");
    assert.ok(
      infos.some(
        (line) =>
          line.includes("is a draft") &&
          line.includes("connect storage to publish: https://fillo.so/settings/storage"),
      ),
      `draft notice carries the storage link (got: ${JSON.stringify(infos)})`,
    );
  } finally {
    dom.reconfigure({ url: "about:blank" });
    console.warn = prevWarn;
    console.info = prevInfo;
    process.env.NODE_ENV = prevEnv;
  }
});

test("development keeps transient mount failure fillable and resolves again at submit", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  process.env.NODE_ENV = "development";
  console.warn = () => {};
  try {
    let syncCalls = 0;
    const submits = [];
    const client = {
      key: "pk_transient_dom",
      baseUrl: "https://transient-dom.test",
      syncForm: async () => {
        syncCalls += 1;
        if (syncCalls <= 3) throw new FilloError("Temporarily busy", 503, 0.001);
        return { formId: "f-transient-dom", slug: "transient-dom", status: "published" };
      },
      startSession: async () => null,
      reportProgress: () => {},
      submit: async (formId, data) => {
        submits.push({ formId, data });
        return { ok: true, responseId: "r-transient-dom" };
      },
    };
    const target = mount(
      { id: "transient-dom", schema: oneField, __filloCodeForm: true },
      { client },
    );
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.ok(target.querySelector("form"));

    const input = target.querySelector('[data-field="name"] input');
    input.value = "Ada";
    dispatch(input, "input");
    dispatch(target.querySelector("form"), "submit");
    await tick();
    await tick();
    assert.equal(syncCalls, 4);
    assert.deepEqual(submits, [{ formId: "f-transient-dom", data: { name: "Ada" } }]);
  } finally {
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

test("DOM production gates local interaction until canonical sync resolves", async () => {
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    let resolveSync;
    const target = mount(
      { id: "canonical-loading-dom", schema: oneField, __filloCodeForm: true },
      {
        client: {
          key: "pk_canonical_loading_dom",
          baseUrl: "https://canonical-loading-dom.test",
          syncForm: () =>
            new Promise((resolve) => {
              resolveSync = resolve;
            }),
        },
      },
    );
    assert.ok(target.querySelector(".fillo-form--loading"));
    assert.equal(target.querySelector("form"), null);

    resolveSync({
      formId: "f-canonical-loading-dom",
      slug: "canonical-loading-dom",
      status: "published",
    });
    await tick();
    assert.ok(target.querySelector("form"));
  } finally {
    process.env.NODE_ENV = prevEnv;
  }
});

test("DOM production shows generic unavailable after bounded transient retries exhaust", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  process.env.NODE_ENV = "production";
  console.warn = () => {};
  try {
    let calls = 0;
    const failures = [];
    const target = mount(
      { id: "transient-exhausted-dom", schema: oneField, __filloCodeForm: true },
      {
        client: {
          key: "pk_transient_exhausted_dom",
          baseUrl: "https://transient-exhausted-dom.test",
          syncForm: async () => {
            calls += 1;
            throw new FilloError("Temporary upstream outage", 503, 0.001);
          },
        },
        onError: (error) => failures.push(error),
      },
    );
    assert.ok(target.querySelector(".fillo-form--loading"));
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(calls, 3);
    assert.equal(target.querySelector("form"), null);
    assert.equal(
      target.querySelector('[data-state="error"]').textContent,
      "This form is unavailable.",
    );
    assert.doesNotMatch(target.textContent, /upstream outage/i);
    assert.equal(failures.at(-1)?.status, 503);
  } finally {
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

test("DOM renders a resolved live snapshot and reports syncError without taking it offline", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  process.env.NODE_ENV = "production";
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const localDraft = {
      ...oneField,
      title: "Local draft",
      pages: [{ id: "p1", blocks: [{ id: "draftOnly", kind: "short_text", label: "Draft only" }] }],
    };
    const live = {
      ...oneField,
      title: "Live form",
      pages: [{ id: "p1", blocks: [{ id: "liveName", kind: "short_text", label: "Live name" }] }],
    };
    const observed = [];
    let renderedError = false;
    let submitCalls = 0;
    const target = mount(
      { id: "resolved-warning-dom", schema: localDraft, __filloCodeForm: true },
      {
        client: {
          key: "pk_resolved_warning_dom",
          baseUrl: "https://resolved-warning-dom.test",
          syncForm: async () => ({
            formId: "f-resolved-warning-dom",
            slug: "resolved-warning-dom",
            status: "published",
            staged: false,
            resolvedSchema: live,
            resolvedTheme: null,
            syncError: {
              code: "sync_origin_denied",
              message: "Use an allowed deployment origin; live remains available.",
            },
          }),
          startSession: async () => null,
          reportProgress: () => {},
          submit: async () => {
            submitCalls += 1;
            return { ok: true, responseId: "r-resolved-warning-dom" };
          },
        },
        onError: (error) => observed.push(error),
        renderError: () => {
          renderedError = true;
          const node = document.createElement("div");
          node.textContent = "should not replace live form";
          return node;
        },
      },
    );
    await tick();
    assert.ok(target.querySelector("form"));
    assert.match(target.textContent, /Live form|Live name/);
    assert.doesNotMatch(target.textContent, /Local draft|Draft only/);
    assert.equal(renderedError, false);
    assert.equal(observed.at(-1)?.code, "sync_origin_denied");
    assert.ok(warnings.some((line) => /sync_origin_denied/.test(line)));
    const input = target.querySelector('[data-field="liveName"] input');
    input.value = "Ada";
    dispatch(input, "input");
    dispatch(target.querySelector("form"), "submit");
    await tick();
    await tick();
    assert.equal(submitCalls, 1, "an equal submit-time live snapshot remains valid");
  } finally {
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

test("DOM submit-time live schema drift aborts before sending and preserves answers", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  process.env.NODE_ENV = "production";
  console.warn = () => {};
  try {
    const liveBeforePublish = {
      ...oneField,
      title: "New live version",
      pages: [
        { id: "p1", blocks: [{ id: "email", kind: "email", label: "Email", required: true }] },
      ],
    };
    let syncCalls = 0;
    let submitCalls = 0;
    const observed = [];
    const client = {
      key: "pk_submit_drift_dom",
      baseUrl: "https://submit-drift-dom.test",
      syncForm: async () => {
        syncCalls += 1;
        if (syncCalls === 1) {
          return {
            formId: "f-submit-drift-dom",
            slug: "submit-drift-dom",
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
          formId: "f-submit-drift-dom",
          slug: "submit-drift-dom",
          status: "published",
        };
      },
      startSession: async () => null,
      reportProgress: () => {},
      submit: async () => {
        submitCalls += 1;
        return { ok: true, responseId: "should-not-send" };
      },
    };
    const target = document.createElement("div");
    document.body.appendChild(target);
    const instance = renderForm(target, {
      form: { id: "submit-drift-dom", schema: oneField, __filloCodeForm: true },
      client,
      onError: (error) => observed.push(error),
    });
    await tick();
    const input = target.querySelector('[data-field="email"] input');
    input.value = "ada@example.com";
    dispatch(input, "input");
    dispatch(target.querySelector("form"), "submit");
    await tick();
    await tick();

    assert.equal(syncCalls, 2);
    assert.equal(submitCalls, 0);
    assert.equal(instance.data.email, "ada@example.com");
    assert.equal(target.querySelector('[data-field="email"] input').value, "ada@example.com");
    assert.match(target.querySelector(".fillo-submit-error").textContent, /unavailable/i);
    assert.equal(observed.at(-1)?.code, "form_schema_changed");
    assert.equal(
      observed.filter((error) => error.code === "form_schema_changed").length,
      1,
      "submit-time resolver failure calls onError exactly once",
    );
  } finally {
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

test("DOM submit-time unpublish race stops before sending and preserves answers", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  process.env.NODE_ENV = "production";
  console.warn = () => {};
  try {
    let syncCalls = 0;
    let submitCalls = 0;
    const observed = [];
    const client = {
      key: "pk_submit_unpublished_dom",
      baseUrl: "https://submit-unpublished-dom.test",
      syncForm: async () => ({
        formId: "f-submit-unpublished-dom",
        slug: "submit-unpublished-dom",
        status: ++syncCalls === 1 ? "published" : "draft",
      }),
      startSession: async () => null,
      reportProgress: () => {},
      submit: async () => {
        submitCalls += 1;
        return { ok: true, responseId: "should-not-send" };
      },
    };
    const target = document.createElement("div");
    document.body.appendChild(target);
    const instance = renderForm(target, {
      form: { id: "submit-unpublished-dom", schema: oneField, __filloCodeForm: true },
      client,
      onError: (error) => observed.push(error),
    });
    await tick();
    const input = target.querySelector('[data-field="name"] input');
    input.value = "Ada";
    dispatch(input, "input");
    dispatch(target.querySelector("form"), "submit");
    await tick();
    await tick();
    assert.equal(submitCalls, 0);
    assert.equal(instance.data.name, "Ada");
    assert.equal(target.querySelector('[data-field="name"] input').value, "Ada");
    assert.match(target.querySelector(".fillo-submit-error").textContent, /unavailable/i);
    assert.equal(observed.at(-1)?.code, "form_not_published");
    assert.equal(observed.length, 1, "unpublish resolver failure calls onError exactly once");
  } finally {
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

test("DOM submit-time accepting closure stops before sending and preserves answers", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  process.env.NODE_ENV = "production";
  console.warn = () => {};
  try {
    let syncCalls = 0;
    let submitCalls = 0;
    const observed = [];
    const client = {
      key: "pk_submit_closed_dom",
      baseUrl: "https://submit-closed-dom.test",
      syncForm: async () => ({
        formId: "f-submit-closed-dom",
        slug: "submit-closed-dom",
        status: "published",
        accepting: ++syncCalls === 1,
        ...(syncCalls === 1 ? {} : { acceptingReason: "storage_full" }),
      }),
      startSession: async () => null,
      reportProgress: () => {},
      submit: async () => {
        submitCalls += 1;
        return { ok: true, responseId: "should-not-send" };
      },
    };
    const target = document.createElement("div");
    document.body.appendChild(target);
    const instance = renderForm(target, {
      form: { id: "submit-closed-dom", schema: oneField, __filloCodeForm: true },
      client,
      onError: (error) => observed.push(error),
    });
    await tick();
    const input = target.querySelector('[data-field="name"] input');
    input.value = "Ada";
    dispatch(input, "input");
    dispatch(target.querySelector("form"), "submit");
    await tick();
    await tick();
    assert.equal(syncCalls, 2);
    assert.equal(submitCalls, 0);
    assert.equal(instance.data.name, "Ada");
    assert.equal(target.querySelector('[data-field="name"] input').value, "Ada");
    assert.match(target.querySelector(".fillo-submit-error").textContent, /unavailable/i);
    assert.equal(observed.at(-1)?.code, "storage_full");
    assert.equal(observed.length, 1, "accepting resolver failure calls onError exactly once");
  } finally {
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

test("DOM submits a completed required file when submit-time resync reports uploads full", async () => {
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    let syncCalls = 0;
    const submissions = [];
    const completed = {
      fileId: "file_completed_at_cap_dom",
      name: "receipt.pdf",
      size: 128,
      mime: "application/pdf",
    };
    const client = {
      key: "pk_completed_file_at_cap_dom",
      baseUrl: "https://completed-file-at-cap-dom.test",
      syncForm: async () => ({
        formId: "f-completed-file-at-cap-dom",
        slug: "completed-file-at-cap-dom",
        status: "published",
        accepting: true,
        uploadsAvailable: ++syncCalls === 1,
        ...(syncCalls === 1
          ? {}
          : { warningCode: "storage_required", warningUrl: "https://fillo.test/storage" }),
      }),
      startSession: async () => null,
      reportProgress: () => {},
      submit: async (_formId, data) => {
        submissions.push(data);
        return { ok: true, responseId: "r-completed-file-at-cap-dom" };
      },
    };
    const target = mount(
      { id: "completed-file-at-cap-dom", schema: uploadForm, __filloCodeForm: true },
      { client, initialData: { attachment: [completed] } },
    );
    await tick();
    dispatch(target.querySelector("form"), "submit");
    await tick();
    await tick();

    assert.equal(syncCalls, 2, "submit re-checks the current upload envelope");
    assert.equal(submissions.length, 1, "upload unavailability does not reject completed files");
    assert.equal(submissions[0].attachment[0].fileId, completed.fileId);
  } finally {
    process.env.NODE_ENV = prevEnv;
  }
});

test("DOM production preserves intentional render-only code forms without a client", () => {
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const target = mount(
      { id: "render-only-dom", schema: oneField, __filloCodeForm: true },
      { renderOnly: true },
    );
    assert.ok(target.querySelector("form"));
    assert.equal(target.querySelector(".fillo-form--error"), null);
  } finally {
    process.env.NODE_ENV = prevEnv;
  }
});

test("development preserves local code-form rendering and shows the exact setup error", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  process.env.NODE_ENV = "development";
  console.warn = () => {};
  try {
    const target = mount(
      { id: "trusted-dev-dom", schema: oneField, __filloCodeForm: true },
      {
        client: {
          key: "pk_trusted_dev_dom",
          baseUrl: "https://trusted-dev-dom.test",
          syncForm: async () => {
            throw new FilloError(
              "Run `fillo forms push` before deploying this schema.",
              403,
              undefined,
              "trusted_sync_required",
            );
          },
        },
      },
    );
    await tick();
    assert.ok(target.querySelector("form"));
    assert.match(target.querySelector(".fillo-devwarning").textContent, /trusted_sync_required/);
    assert.match(target.querySelector(".fillo-devwarning").textContent, /fillo forms push/);
  } finally {
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

test("DOM development keeps staged local changes visible with a preview notice", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevInfo = console.info;
  process.env.NODE_ENV = "development";
  console.info = () => {};
  try {
    const localDraft = {
      ...oneField,
      title: "Local staged preview",
      pages: [{ id: "p1", blocks: [{ id: "local", kind: "short_text", label: "Local field" }] }],
    };
    const live = {
      ...oneField,
      title: "Published live form",
      pages: [{ id: "p1", blocks: [{ id: "live", kind: "short_text", label: "Live field" }] }],
    };
    const target = mount(
      { id: "staged-dev-dom", schema: localDraft, __filloCodeForm: true },
      {
        client: {
          key: "pk_staged_dev_dom",
          baseUrl: "https://staged-dev-dom.test",
          syncForm: async () => ({
            formId: "f-staged-dev-dom",
            slug: "staged-dev-dom",
            status: "published",
            staged: true,
            resolvedSchema: live,
            resolvedTheme: null,
            manageUrl: "https://fillo.so/forms/f-staged-dev-dom",
          }),
        },
      },
    );
    await tick();
    assert.match(target.textContent, /Local staged preview|Local field/);
    assert.doesNotMatch(target.textContent, /Published live form|Live field/);
    assert.match(target.querySelector(".fillo-devwarning").textContent, /changes are staged/i);
    assert.equal(
      target.querySelector(".fillo-devwarning a")?.getAttribute("href"),
      "https://fillo.so/forms/f-staged-dev-dom",
      "the server-owned dashboard URL wins over an app-owned API base URL",
    );
  } finally {
    console.info = prevInfo;
    process.env.NODE_ENV = prevEnv;
  }
});

test("a DOM code form without a sync key fails closed in production", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  process.env.NODE_ENV = "production";
  console.warn = () => {};
  try {
    const observed = [];
    const target = document.createElement("div");
    document.body.appendChild(target);
    const instance = renderForm(target, {
      form: { id: "missing-key-dom", schema: oneField, __filloCodeForm: true },
      client: { baseUrl: "" },
      onError: (error) => observed.push(error),
    });
    await tick();
    assert.equal(instance.status, "error");
    assert.equal(target.querySelector("form"), null);
    assert.equal(observed.at(-1)?.code, "sync_key_required");
    assert.doesNotMatch(target.textContent, /pk_/);
  } finally {
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

test("destroy prevents a late hosted-form fetch from resurrecting the renderer", async () => {
  let resolveForm;
  const client = {
    getForm: () =>
      new Promise((resolve) => {
        resolveForm = resolve;
      }),
  };
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = renderForm(target, { formId: "f-late", client });
  instance.destroy();
  resolveForm({ id: "f-late", slug: "late", schema: oneField, theme: null });
  await tick();
  assert.equal(target.childElementCount, 0);
});

test("destroy ignores a late code-form sync result", async () => {
  let resolveSync;
  const client = {
    key: "pk_late_result",
    baseUrl: "https://late-result.test",
    syncForm: () =>
      new Promise((resolve) => {
        resolveSync = resolve;
      }),
  };
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = renderForm(target, {
    form: { id: "late-result", schema: oneField, __filloCodeForm: true },
    client,
  });
  instance.destroy();
  resolveSync({
    formId: "f-late-result",
    slug: "late-result",
    status: "draft",
    branding: { poweredBy: false },
  });
  await tick();
  assert.equal(target.childElementCount, 0);
});

test("destroy ignores a late code-form sync failure", async () => {
  let rejectSync;
  let errors = 0;
  const client = {
    key: "pk_late_error",
    baseUrl: "https://late-error.test",
    syncForm: () =>
      new Promise((_resolve, reject) => {
        rejectSync = reject;
      }),
  };
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = renderForm(target, {
    form: { id: "late-error", schema: oneField, __filloCodeForm: true },
    client,
    onError: () => {
      errors += 1;
    },
  });
  instance.destroy();
  rejectSync(new FilloError("sync rejected", 400));
  await tick();
  assert.equal(errors, 0);
  assert.equal(target.childElementCount, 0);
});

// ---------------------------------------------------------------------------
// First-render experience: visible draft banner, preview chrome, notice
// precedence, verbose dev submit errors, and upload pre-emption. These mirror
// the React renderer's dev-chrome contract (see packages/react/test/
// dev-chrome.test.mjs) so the two renderers cannot drift.
// ---------------------------------------------------------------------------

test("DOM dev chrome shows a visible draft banner with the storage deep-link", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevInfo = console.info;
  process.env.NODE_ENV = "development";
  console.info = () => {};
  try {
    const target = mount(
      { id: "draft-banner-dom", schema: oneField, __filloCodeForm: true },
      {
        client: {
          key: "pk_draft_banner_dom",
          baseUrl: "https://draft-banner-dom.test",
          syncForm: async () => ({
            formId: "f-draft-banner-dom",
            slug: "draft-banner-dom",
            status: "draft",
            warning: "The form stays a draft until a storage destination is connected.",
            warningCode: "storage_required",
            warningUrl: "https://fillo.so/settings/storage",
          }),
        },
      },
    );
    await tick();
    assert.ok(target.querySelector("form"), "the draft still renders locally");
    const notices = target.querySelectorAll(".fillo-devwarning");
    assert.equal(notices.length, 1, "single-notice precedence: exactly one banner");
    assert.match(notices[0].textContent, /Draft form/);
    assert.equal(
      notices[0].querySelector("a")?.getAttribute("href"),
      "https://fillo.so/settings/storage",
      "the banner deep-links to the storage settings, not console-only",
    );
  } finally {
    console.info = prevInfo;
    process.env.NODE_ENV = prevEnv;
  }
});

test("DOM dev chrome links a plain draft directly to Publish", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevInfo = console.info;
  process.env.NODE_ENV = "development";
  console.info = () => {};
  try {
    const target = mount(
      { id: "plain-draft-dom", schema: oneField, __filloCodeForm: true },
      {
        client: {
          key: "pk_plain_draft_dom",
          baseUrl: "https://plain-draft-dom.test",
          syncForm: async () => ({
            formId: "f-plain-draft-dom",
            slug: "plain-draft-dom",
            status: "draft",
            manageUrl: "https://fillo.so/forms/f-plain-draft-dom",
          }),
        },
      },
    );
    await tick();
    const notice = target.querySelector(".fillo-devwarning");
    assert.match(notice.textContent, /save no response until you publish/i);
    assert.equal(
      notice.querySelector("a")?.getAttribute("href"),
      "https://fillo.so/forms/f-plain-draft-dom",
    );
  } finally {
    console.info = prevInfo;
    process.env.NODE_ENV = prevEnv;
  }
});

test("preview forces the dev chrome in production, renders the badge, and warns once", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  const prevInfo = console.info;
  process.env.NODE_ENV = "production";
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  console.info = () => {};
  try {
    const makeClient = () => ({
      key: "pk_preview_prod_dom",
      baseUrl: "https://preview-prod-dom.test",
      syncForm: async () => ({
        formId: "f-preview-prod-dom",
        slug: "preview-prod-dom",
        status: "draft",
        warningCode: "storage_required",
        warningUrl: "https://fillo.so/settings/storage",
      }),
    });
    const target = mount(
      { id: "preview-prod-dom", schema: oneField, __filloCodeForm: true },
      { client: makeClient(), preview: true },
    );
    await tick();
    assert.ok(target.querySelector("form"), "preview keeps the draft fillable off-localhost");
    assert.equal(target.querySelector(".fillo-form--closed"), null, "no dead not-live panel");
    const badge = target.querySelector(".fillo-preview-badge");
    assert.equal(badge?.textContent, "Preview");
    assert.equal(badge?.getAttribute("data-fillo"), "preview-badge");
    assert.match(target.querySelector(".fillo-devwarning").textContent, /Draft form/);
    assert.equal(
      warnings.filter((line) => line.includes("cosmetic only")).length,
      1,
      "preview in a production build warns",
    );

    // Once per process: a second preview mount must not warn again.
    mount(
      { id: "preview-prod-dom-2", schema: oneField, __filloCodeForm: true },
      { client: makeClient(), preview: true },
    );
    await tick();
    assert.equal(warnings.filter((line) => line.includes("cosmetic only")).length, 1);
  } finally {
    console.warn = prevWarn;
    console.info = prevInfo;
    process.env.NODE_ENV = prevEnv;
  }
});

test("preview is cosmetic only: submissions still target the canonical synced form", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  process.env.NODE_ENV = "production";
  console.warn = () => {};
  try {
    const submitted = [];
    const client = {
      key: "pk_preview_submit_dom",
      baseUrl: "https://preview-submit-dom.test",
      syncForm: async () => ({
        formId: "f-canonical-target",
        slug: "preview-submit-dom",
        status: "published",
      }),
      startSession: async () => null,
      reportProgress: () => {},
      submit: async (formId, data) => {
        submitted.push({ formId, data });
        return { ok: true, responseId: "r-preview-submit" };
      },
    };
    const target = mount(
      { id: "preview-submit-dom", schema: oneField, __filloCodeForm: true },
      { client, preview: true },
    );
    await tick();
    const input = target.querySelector('[data-field="name"] input');
    input.value = "Ada";
    dispatch(input, "input");
    dispatch(target.querySelector("form"), "submit");
    await tick();
    await tick();
    assert.deepEqual(submitted, [{ formId: "f-canonical-target", data: { name: "Ada" } }]);
    assert.ok(target.querySelector(".fillo-form--success"), "success screen rendered");
  } finally {
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

test("<fillo-form data-preview> renders the Preview badge under the same contract", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  process.env.NODE_ENV = "production";
  console.warn = () => {};
  try {
    registerFilloElement();
    const node = document.createElement("fillo-form");
    node.setAttribute("data-preview", "");
    node.setAttribute("form-id", "f-test");
    node.client = localClient;
    node.form = oneField;
    document.body.appendChild(node);
    await tick();
    await tick();
    assert.ok(node.querySelector("form"), "the form renders");
    assert.ok(node.querySelector(".fillo-preview-badge"), "the attribute forces the badge");
    node.remove();
  } finally {
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

test('<fillo-form data-preview="false"> stays production for real respondents', async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  process.env.NODE_ENV = "production";
  console.warn = () => {};
  try {
    registerFilloElement();
    const node = document.createElement("fillo-form");
    // Frameworks stringify booleans onto data-* attributes instead of omitting
    // them; a stringified `false` must never enable dev chrome for respondents.
    node.setAttribute("data-preview", "false");
    node.setAttribute("form-id", "f-test");
    node.client = localClient;
    node.form = oneField;
    document.body.appendChild(node);
    await tick();
    await tick();
    assert.ok(node.querySelector("form"), "the form renders");
    assert.equal(node.querySelector(".fillo-preview-badge"), null, 'value "false" means off');
    node.setAttribute("data-preview", "0");
    await tick();
    await tick();
    assert.equal(node.querySelector(".fillo-preview-badge"), null, 'value "0" means off');
    node.remove();
  } finally {
    console.warn = prevWarn;
    process.env.NODE_ENV = prevEnv;
  }
});

test("dev chrome precedence renders only the most relevant notice (sync-error wins)", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevWarn = console.warn;
  const prevInfo = console.info;
  process.env.NODE_ENV = "development";
  console.warn = () => {};
  console.info = () => {};
  try {
    const target = mount(
      { id: "precedence-dom", schema: oneField, __filloCodeForm: true },
      {
        client: {
          key: "pk_precedence_dom",
          baseUrl: "https://precedence-dom.test",
          syncForm: async () => ({
            formId: "f-precedence-dom",
            slug: "precedence-dom",
            status: "published",
            staged: true,
            resolvedSchema: oneField,
            resolvedTheme: null,
            syncError: {
              code: "trusted_sync_required",
              message: "Local code is still awaiting publication.",
            },
          }),
        },
      },
    );
    await tick();
    const notices = target.querySelectorAll(".fillo-devwarning");
    assert.equal(notices.length, 1, "staged + sync-error render one notice, not a stack");
    assert.match(notices[0].textContent, /needs attention \(trusted_sync_required\)/);
    assert.doesNotMatch(notices[0].textContent, /Code changes are staged/);
  } finally {
    console.warn = prevWarn;
    console.info = prevInfo;
    process.env.NODE_ENV = prevEnv;
  }
});

test("devNotices: false hides the notices but keeps the explicit Preview badge", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevInfo = console.info;
  process.env.NODE_ENV = "development";
  console.info = () => {};
  try {
    const target = mount(
      { id: "notices-optout-dom", schema: oneField, __filloCodeForm: true },
      {
        client: {
          key: "pk_notices_optout_dom",
          baseUrl: "https://notices-optout-dom.test",
          syncForm: async () => ({
            formId: "f-notices-optout-dom",
            slug: "notices-optout-dom",
            status: "published",
            staged: true,
            resolvedSchema: oneField,
            resolvedTheme: null,
          }),
        },
        preview: true,
        devNotices: false,
      },
    );
    await tick();
    assert.equal(target.querySelector(".fillo-devwarning"), null, "notices opted out");
    assert.ok(
      target.querySelector(".fillo-preview-badge"),
      "the explicit Preview badge survives the notice opt-out",
    );
  } finally {
    console.info = prevInfo;
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
    const submits = [];
    const client = {
      key: "pk_verbose_submit_dom",
      baseUrl: "https://verbose-submit-dom.test",
      syncForm: async () => ({
        formId: "f-verbose-submit-dom",
        slug: "verbose-submit-dom",
        status: "draft",
        warningCode: "storage_required",
        warningUrl: "https://fillo.so/settings/storage",
      }),
      startSession: async () => null,
      reportProgress: () => {},
      submit: async () => {
        submits.push(1);
        return { ok: true, responseId: "should-not-send" };
      },
    };
    const target = mount(
      { id: "verbose-submit-dom", schema: oneField, __filloCodeForm: true },
      { client },
    );
    await tick();
    const input = target.querySelector('[data-field="name"] input');
    input.value = "Ada";
    dispatch(input, "input");
    dispatch(target.querySelector("form"), "submit");
    await tick();
    await tick();
    assert.equal(submits.length, 0, "no answers were sent to a draft form");
    const alert = target.querySelector(".fillo-submit-error");
    assert.match(alert.textContent, /no longer published/, "the real reason, not 'unavailable'");
    assert.match(alert.textContent, /\(form_not_published\)/, "machine code included");
    assert.equal(
      alert.querySelector("a")?.getAttribute("href"),
      "https://fillo.so/settings/storage",
      "the connect-storage deep-link rides the submit failure",
    );
    assert.equal(
      target.querySelector('[data-field="name"] input').value,
      "Ada",
      "answers survive for a safe retry",
    );
  } finally {
    console.warn = prevWarn;
    console.info = prevInfo;
    process.env.NODE_ENV = prevEnv;
  }
});

test("storage-blocked upload field pre-empts uploads with the connect-storage link", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevInfo = console.info;
  process.env.NODE_ENV = "development";
  console.info = () => {};
  try {
    let uploads = 0;
    const fileForm = {
      ...oneField,
      pages: [{ id: "p1", blocks: [{ id: "files", kind: "file_upload", label: "Files" }] }],
    };
    const target = mount(
      { id: "storage-blocked-dom", schema: fileForm, __filloCodeForm: true },
      {
        client: {
          key: "pk_storage_blocked_dom",
          baseUrl: "https://storage-blocked-dom.test",
          syncForm: async () => ({
            formId: "f-storage-blocked-dom",
            slug: "storage-blocked-dom",
            status: "draft",
            warningCode: "storage_required",
            warningUrl: "https://fillo.so/settings/storage",
            uploadsAvailable: false,
          }),
          uploadFile: async () => {
            uploads += 1;
            return { fileId: "should-not-upload", name: "a.txt", size: 1, mime: "text/plain" };
          },
        },
      },
    );
    await tick();
    const input = target.querySelector('input[type="file"]');
    assert.ok(input.disabled, "the input is disabled while storage is unconnected");
    // The pre-emption message lives inside the dropzone now (react parity,
    // ledger #3) — not the old standalone .fillo-upload-notice paragraph.
    const dropzone = target.querySelector(".fillo-dropzone");
    assert.ok(dropzone.classList.contains("fillo-dropzone--disabled"));
    assert.equal(dropzone.getAttribute("aria-disabled"), "true");
    const hint = [...dropzone.querySelectorAll(".fillo-dropzone-hint")].find((node) =>
      /Connect file storage to enable uploads/.test(node.textContent),
    );
    assert.ok(hint, "the pre-emption message replaces a doomed attempt");
    assert.equal(
      hint.querySelector("a")?.getAttribute("href"),
      "https://fillo.so/settings/storage",
    );

    // Even a forced change event must not start an upload the server refuses.
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new File(["a"], "a.txt")],
    });
    dispatch(input, "change");
    await tick();
    await tick();
    assert.equal(uploads, 0, "no upload attempt reached the client");
    assert.equal(target.querySelector(".fillo-upload-progress"), null);
  } finally {
    console.info = prevInfo;
    process.env.NODE_ENV = prevEnv;
  }
});

// ---------- Upload dropzone (ledger #3, docs/decisions/input-quality.md):
// react/dom renderer parity — the entry point used to be a bare native input
// in this package; it's now an activatable dropzone forwarding to a hidden
// input, matching react's upload.tsx ~200-249. ----------

test("render-only DOM uploads explain that transport is deliberately unavailable", () => {
  const target = mount(uploadForm, { renderOnly: true });
  const dropzone = target.querySelector(".fillo-dropzone");
  assert.equal(dropzone.getAttribute("aria-disabled"), "true");
  assert.match(dropzone.textContent, /Uploads are unavailable in this render-only preview/);
});

test("upload dropzone is labelled by the field label, exposes role=button/tabIndex 0, and gets no aria-required even when the field is required", async () => {
  const target = mount({
    version: 1,
    title: "T",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [{ id: "files", kind: "file_upload", label: "Attachments", required: true }],
      },
    ],
  });
  const dropzone = target.querySelector(".fillo-dropzone");
  const label = target.querySelector('[data-field="files"] .fillo-label');
  assert.equal(dropzone.getAttribute("role"), "button");
  assert.equal(dropzone.getAttribute("tabindex"), "0");
  assert.equal(dropzone.getAttribute("aria-labelledby"), label.id);
  assert.equal(
    dropzone.hasAttribute("aria-required"),
    false,
    "role=button doesn't support aria-required (ledger #1) even though the field is required",
  );
  // The hidden input carries no aria of its own — the dropzone is the
  // operable, accessible-name-bearing control (react's exact pattern).
  const input = target.querySelector('input[type="file"]');
  assert.equal(input.hidden, true);
  assert.equal(input.hasAttribute("aria-labelledby"), false);
});

test("upload dropzone forwards Enter/Space activation to the hidden input's click, preventDefault-ing Space", async () => {
  const target = mount({
    version: 1,
    title: "T",
    settings: {},
    pages: [{ id: "p1", blocks: [{ id: "files", kind: "file_upload", label: "Attachments" }] }],
  });
  const dropzone = target.querySelector(".fillo-dropzone");
  const input = target.querySelector('input[type="file"]');
  let clicks = 0;
  input.addEventListener("click", () => clicks++);

  keydown(dropzone, "Enter");
  assert.equal(clicks, 1, "Enter forwards activation to the hidden input");

  const space = new window.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
  dropzone.dispatchEvent(space);
  assert.equal(clicks, 2, "Space forwards activation to the hidden input");
  assert.ok(space.defaultPrevented, "Space is preventDefault-ed so the page doesn't scroll");

  // A stray key does nothing.
  keydown(dropzone, "a");
  assert.equal(clicks, 2);
});

test("upload dropzone click forwards to the hidden input, and drag-over toggles the --over class + data-drag-over", async () => {
  const target = mount({
    version: 1,
    title: "T",
    settings: {},
    pages: [{ id: "p1", blocks: [{ id: "files", kind: "file_upload", label: "Attachments" }] }],
  });
  const dropzone = target.querySelector(".fillo-dropzone");
  const input = target.querySelector('input[type="file"]');
  let clicks = 0;
  input.addEventListener("click", () => clicks++);
  dispatch(dropzone, "click");
  assert.equal(clicks, 1, "clicking the dropzone opens the native picker");

  dropzone.dispatchEvent(new window.Event("dragover", { bubbles: true, cancelable: true }));
  assert.ok(dropzone.classList.contains("fillo-dropzone--over"));
  assert.equal(dropzone.getAttribute("data-drag-over"), "");
  dropzone.dispatchEvent(new window.Event("dragleave", { bubbles: true, cancelable: true }));
  assert.equal(dropzone.classList.contains("fillo-dropzone--over"), false);
  assert.equal(dropzone.hasAttribute("data-drag-over"), false);
});

test("a full upload field (maxFiles reached) hides the dropzone entirely — react parity", async () => {
  const target = mount(
    {
      version: 1,
      title: "T",
      settings: {},
      pages: [
        {
          id: "p1",
          blocks: [{ id: "files", kind: "file_upload", label: "Attachments", maxFiles: 1 }],
        },
      ],
    },
    { initialData: { files: [{ fileId: "f1", name: "a.txt", size: 1, mime: "text/plain" }] } },
  );
  assert.equal(target.querySelector(".fillo-dropzone"), null);
  assert.equal(target.querySelector('input[type="file"]'), null);
  assert.ok(target.querySelector(".fillo-file--done"), "the completed file row still renders");
});

test("hosted-form load failures render status-aware copy, not raw server text", async () => {
  const notFound = mount(undefined, {
    formId: "missing-form",
    client: {
      getForm: async () => {
        throw new FilloError("SELECT failed on forms table", 404);
      },
    },
    onError: () => {},
  });
  const offline = mount(undefined, {
    formId: "unreachable-form",
    client: {
      getForm: async () => {
        throw new FilloError("fetch failed", 0);
      },
    },
    onError: () => {},
  });
  await tick();
  await tick();
  const notFoundView = notFound.querySelector('[data-state="error"]');
  assert.match(notFoundView.textContent, /Form not found/);
  assert.doesNotMatch(notFoundView.textContent, /SELECT failed/);
  const offlineView = offline.querySelector('[data-state="error"]');
  assert.match(offlineView.textContent, /Couldn't reach the server/);
  assert.doesNotMatch(offlineView.textContent, /fetch failed/);
});

// Two number sources feeding a calculated subtotal — decimals/prefix/suffix
// prove the row formats through core's formatAnswer, not its own arithmetic.
const calcForm = {
  version: 1,
  title: "Quote",
  settings: {},
  pages: [
    {
      id: "p1",
      blocks: [
        { id: "seats", kind: "number", label: "Seats" },
        { id: "addons", kind: "number", label: "Add-ons" },
        {
          id: "total",
          kind: "calculated",
          label: "Subtotal",
          description: "Updates as you pick seats.",
          calc: {
            op: "add",
            args: [
              { op: "value", fieldId: "seats" },
              { op: "value", fieldId: "addons" },
            ],
          },
          decimals: 2,
          prefix: "$",
          suffix: "/mo",
        },
      ],
    },
  ],
};

test("calculated field renders a read-only row with the slot/data contract", async () => {
  const target = mount(calcForm);
  await tick();
  const row = target.querySelector('[data-fillo="calculated"]');
  assert.ok(row, "the calculated row renders");
  assert.equal(row.getAttribute("data-field"), "total");
  assert.equal(row.getAttribute("data-kind"), "calculated");
  for (const cls of ["fillo-field", "fillo-field--calculated", "fillo-calculated"]) {
    assert.ok(row.classList.contains(cls), `row carries ${cls}`);
  }

  // Accessible name: the label points at the <output>, so screen readers
  // announce "Subtotal: —" / "Subtotal: $12.50/mo" as one thing.
  const label = row.querySelector("label.fillo-label");
  const output = row.querySelector("output.fillo-calculated-value");
  assert.ok(label && output, "label + output value present");
  assert.equal(label.getAttribute("for"), output.id);
  assert.equal(label.textContent, "Subtotal", 'no "(optional)" marker on a computed line');
  assert.match(row.querySelector(".fillo-description").textContent, /Updates as you pick/);
  assert.equal(output.getAttribute("aria-describedby"), row.querySelector(".fillo-description").id);

  // Unanswered → em dash, muted modifier — and never an input: nothing
  // focusable, no tab stop, no form-control semantics.
  assert.equal(output.textContent, "—");
  assert.ok(output.classList.contains("fillo-calculated-value--empty"));
  const focusable =
    'a[href], [tabindex]:not([tabindex="-1"]), ' +
    "input:not(:disabled), button:not(:disabled), select:not(:disabled), textarea:not(:disabled)";
  assert.equal(row.querySelectorAll(focusable).length, 0, "nothing focusable inside the row");
  assert.equal(output.getAttribute("tabindex"), null);
});

test("calculated row live-updates as sources change and formats via formatAnswer", async () => {
  const target = mount(calcForm);
  await tick();
  const output = () => target.querySelector("output.fillo-calculated-value");

  const seats = target.querySelector('[data-field="seats"] input');
  seats.value = "7.5";
  dispatch(seats, "change");
  await tick();
  assert.equal(output().textContent, "—", "one unanswered source keeps the result null");

  const addons = target.querySelector('[data-field="addons"] input');
  addons.value = "5";
  dispatch(addons, "change");
  await tick();
  assert.equal(output().textContent, "$12.50/mo", "decimals pad + prefix/suffix, same as grid/CSV");
  assert.ok(!output().classList.contains("fillo-calculated-value--empty"));

  // Clearing a source flows back to unanswered on the next render.
  const addonsAgain = target.querySelector('[data-field="addons"] input');
  addonsAgain.value = "";
  dispatch(addonsAgain, "change");
  await tick();
  assert.equal(output().textContent, "—");
  assert.ok(output().classList.contains("fillo-calculated-value--empty"));
});

test("plain number field keeps today's exact DOM — no wrapper, type=number (zero-diff guard)", () => {
  const target = mount({
    version: 1,
    title: "T",
    settings: {},
    pages: [{ id: "p1", blocks: [{ id: "qty", kind: "number", label: "Qty" }] }],
  });
  const input = target.querySelector('[data-field="qty"] input');
  assert.equal(input.type, "number");
  assert.equal(
    target.querySelector(".fillo-number"),
    null,
    "no adornment wrapper for a plain number field",
  );
});

test("number prefix/suffix wrap the input in plain visible affix spans", () => {
  const target = mount({
    version: 1,
    title: "T",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [
          {
            id: "price",
            kind: "number",
            label: "Price",
            prefix: "$",
            suffix: " kg",
            min: 0,
            max: 500,
          },
        ],
      },
    ],
  });
  const wrap = target.querySelector('[data-field="price"] .fillo-number');
  assert.ok(wrap, "adornment wrapper rendered");
  assert.equal(wrap.querySelector(".fillo-number-prefix").textContent, "$");
  assert.equal(
    wrap.querySelector(".fillo-number-suffix").textContent,
    " kg",
    "suffix space is preserved",
  );
  assert.equal(
    wrap.querySelector(".fillo-number-suffix").getAttribute("aria-hidden"),
    null,
    "affixes are plain visible text",
  );
  const input = wrap.querySelector("input");
  assert.equal(input.type, "text", "affix-only is a formatted field — text, not native number");
  assert.equal(input.getAttribute("inputmode"), "decimal");
  assert.equal(
    input.getAttribute("min"),
    null,
    "min/max are inert on text — dropped, core validation enforces them",
  );
  assert.equal(input.getAttribute("max"), null);
});

test("notation:grouped keeps data canonical while typing and shows grouped text after change", async () => {
  const schema = {
    version: 1,
    title: "T",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [{ id: "amount", kind: "number", label: "Amount", notation: "grouped" }],
      },
    ],
  };
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = renderForm(target, { form: schema, formId: "f-test", client: localClient });
  const input = target.querySelector('[data-field="amount"] input');
  assert.equal(input.type, "text");
  assert.equal(input.getAttribute("inputmode"), "decimal");

  input.value = "1234567";
  dispatch(input, "input");
  assert.equal(instance.data.amount, "1234567", "typing keeps canonical (ungrouped) text in data");

  dispatch(input, "change");
  await tick();
  const reRendered = target.querySelector('[data-field="amount"] input');
  assert.equal(
    reRendered.value,
    "1,234,567",
    "the recreated, unfocused input displays grouped text (node's default locale is en-US)",
  );

  dispatch(reRendered, "focus");
  assert.equal(reRendered.value, "1,234,567", "focus changes nothing — no unformat-on-focus");
});

test("notation:grouped + decimals formats the initial render and stays formatted through focus/blur with no edit", () => {
  const target = mount(
    {
      version: 1,
      title: "T",
      settings: {},
      pages: [
        {
          id: "p1",
          blocks: [{ id: "cost", kind: "number", label: "Cost", notation: "grouped", decimals: 2 }],
        },
      ],
    },
    { initialData: { cost: "1234.5" } },
  );
  const input = target.querySelector('[data-field="cost"] input');
  assert.equal(
    input.value,
    "1,234.50",
    "a freshly created, unfocused input shows the grouped + padded value",
  );

  dispatch(input, "focus");
  assert.equal(input.value, "1,234.50", "focus changes nothing — no unformat-on-focus");

  dispatch(input, "blur"); // no edit at all → no "change" → the blur listener re-applies the same grouped text
  assert.equal(input.value, "1,234.50", "still grouped + padded");
});

test("notation:grouped: a mid-session edit parses the full stale-separator text, not a diff under the caret", () => {
  const schema = {
    version: 1,
    title: "T",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [{ id: "amt", kind: "number", label: "Amount", notation: "grouped", decimals: 2 }],
      },
    ],
  };
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = renderForm(target, {
    form: schema,
    formId: "f-test",
    client: localClient,
    initialData: { amt: 1234567.89 },
  });
  const input = target.querySelector('[data-field="amt"] input');
  assert.equal(input.value, "1,234,567.89", "unfocused, prefilled display is grouped");

  dispatch(input, "focus");
  assert.equal(
    input.value,
    "1,234,567.89",
    "still grouped after focus — nothing unformats it first",
  );

  // The respondent edits the formatted text directly ("567" → "5679"),
  // leaving stale separators mid-string. Every change parses the FULL text,
  // not just what changed under the caret.
  input.value = "1,234,5679.89";
  dispatch(input, "input");
  assert.equal(
    instance.data.amt,
    "12345679.89",
    "parseGroupedNumber strips every group separator in the full text",
  );
});

// ---------- Keystroke filter (isValidPartialNumberText) ----------
// Letters/stray symbols never reach data at all now — a stray-letter edit is
// rejected at the keystroke level instead of flowing through as raw text for
// validation to flag later (the old contract, superseded by the input-quality
// keystroke filter). Superseded the old "leaves unparseable typed text raw in
// data" test, which asserted the pre-filter passthrough behavior.

test("notation:grouped: a stray letter or a mixed candidate is rejected wholesale — value/data stay unchanged", () => {
  const schema = {
    version: 1,
    title: "T",
    settings: {},
    pages: [
      { id: "p1", blocks: [{ id: "raw", kind: "number", label: "Raw", notation: "grouped" }] },
    ],
  };
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = renderForm(target, { form: schema, formId: "f-test", client: localClient });
  const input = target.querySelector('[data-field="raw"] input');

  input.value = "abc";
  dispatch(input, "input");
  assert.equal(
    input.value,
    "",
    "letters fail the keystroke filter — the DOM value reverts to empty",
  );
  assert.equal(instance.data.raw, undefined, "a rejected edit never reaches data");

  input.value = "12a";
  dispatch(input, "input");
  assert.equal(
    input.value,
    "",
    'a mixed candidate rejects WHOLESALE — not trimmed down to its valid "12" prefix',
  );
  assert.equal(instance.data.raw, undefined);
});

test("notation:grouped: a second decimal point is rejected, the last valid text and caret are kept", () => {
  const schema = {
    version: 1,
    title: "T",
    settings: {},
    pages: [
      { id: "p1", blocks: [{ id: "amt", kind: "number", label: "Amount", notation: "grouped" }] },
    ],
  };
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = renderForm(target, { form: schema, formId: "f-test", client: localClient });
  const input = target.querySelector('[data-field="amt"] input');

  input.value = "1,234.5";
  dispatch(input, "input");
  assert.equal(
    input.value,
    "1,234.5",
    "digits + group separator + one decimal are all valid keystrokes",
  );
  assert.equal(instance.data.amt, "1234.5");

  input.value = "1,234.5.";
  dispatch(input, "input");
  assert.equal(input.value, "1,234.5", 'a second "." is rejected — reverts to the last valid text');
  assert.equal(instance.data.amt, "1234.5", "data is untouched by the rejected edit");
  if (typeof input.selectionStart === "number") {
    assert.equal(
      input.selectionStart,
      "1,234.5".length,
      "caret restored to where it was after the last accepted edit (jsdom supports selectionStart on type=text)",
    );
  }
});

test("notation:grouped: a lone minus is accepted, then a digit completes it", () => {
  const schema = {
    version: 1,
    title: "T",
    settings: {},
    pages: [
      { id: "p1", blocks: [{ id: "amt", kind: "number", label: "Amount", notation: "grouped" }] },
    ],
  };
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = renderForm(target, { form: schema, formId: "f-test", client: localClient });
  const input = target.querySelector('[data-field="amt"] input');

  input.value = "-";
  dispatch(input, "input");
  assert.equal(input.value, "-");
  assert.equal(instance.data.amt, "-");

  input.value = "-5";
  dispatch(input, "input");
  assert.equal(input.value, "-5");
  assert.equal(instance.data.amt, "-5");
});

// ---------- Author-fixed notation styles ----------
// The mapped locale (core's localeForNotation) must beat the runtime's own
// default — node defaults to en-US, so a grouped-dot field proving
// dot-groups/comma-decimal here proves the style is really pinned.

test("notation:grouped-dot displays dot-grouped, comma-decimal text regardless of the runtime locale", () => {
  const target = mount(
    {
      version: 1,
      title: "T",
      settings: {},
      pages: [
        {
          id: "p1",
          blocks: [
            { id: "price", kind: "number", label: "Price", notation: "grouped-dot", decimals: 2 },
          ],
        },
      ],
    },
    { initialData: { price: "1234.5" } },
  );
  const input = target.querySelector('[data-field="price"] input');
  assert.equal(input.value, "1.234,50", "de-DE-style display even though node defaults en-US");

  dispatch(input, "focus");
  dispatch(input, "blur"); // no edit → the blur listener re-applies the fixed style
  assert.equal(input.value, "1.234,50", "still dot-grouped + comma-decimal after blur");
});

test("notation:grouped-dot: typing 1.234,56 keeps data canonical 1234.56; the filter follows the fixed locale", () => {
  const schema = {
    version: 1,
    title: "T",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [{ id: "price", kind: "number", label: "Price", notation: "grouped-dot" }],
      },
    ],
  };
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = renderForm(target, { form: schema, formId: "f-test", client: localClient });
  const input = target.querySelector('[data-field="price"] input');

  input.value = "1.234,56";
  dispatch(input, "input");
  assert.equal(input.value, "1.234,56", "the fixed style's separators pass the keystroke filter");
  assert.equal(
    instance.data.price,
    "1234.56",
    "data holds canonical dot-decimal text, never the styled one",
  );

  input.value = "1.234,56,";
  dispatch(input, "input");
  assert.equal(input.value, "1.234,56", 'a second "," — the fixed style\'s decimal — is rejected');
  assert.equal(instance.data.price, "1234.56", "data untouched by the rejected edit");
});

test("notation:grouped-comma: a lone-comma decimal reads as a decimal, never silently stripped", () => {
  const schema = {
    version: 1,
    title: "T",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [{ id: "amt", kind: "number", label: "Amount", notation: "grouped-comma" }],
      },
    ],
  };
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = renderForm(target, { form: schema, formId: "f-test", client: localClient });
  const input = target.querySelector('[data-field="amt"] input');

  input.value = "12,5";
  dispatch(input, "input");
  assert.equal(
    instance.data.amt,
    "12.5",
    "a comma-decimal respondent's 12,5 means 12.5 — not the old silent 125",
  );

  dispatch(input, "blur");
  assert.equal(
    input.value,
    "12.5",
    "blur reformats from the stored value in the fixed comma-group style",
  );
});

test("number prefix/suffix (affix-only, non-grouped): the keystroke filter still applies", () => {
  const schema = {
    version: 1,
    title: "T",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [{ id: "weight", kind: "number", label: "Weight", prefix: "$", suffix: " kg" }],
      },
    ],
  };
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = renderForm(target, { form: schema, formId: "f-test", client: localClient });
  const input = target.querySelector('[data-field="weight"] input');

  input.value = "12a";
  dispatch(input, "input");
  assert.equal(
    input.value,
    "",
    "affix-only fields are the formatted/text path too — same filter applies",
  );
  assert.equal(instance.data.weight, undefined);

  input.value = "42";
  dispatch(input, "input");
  assert.equal(input.value, "42", "valid input still flows straight through, unformatted");
  assert.equal(instance.data.weight, "42");
});

// ---------- Input-quality wave (docs/decisions/input-quality.md) ----------

test("email/url fields get their autocomplete token; short_text gets none", () => {
  const target = mount({
    version: 1,
    title: "T",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [
          { id: "e", kind: "email", label: "Email" },
          { id: "u", kind: "url", label: "Site" },
          { id: "s", kind: "short_text", label: "Name" },
        ],
      },
    ],
  });
  assert.equal(
    target.querySelector('[data-field="e"] input').getAttribute("autocomplete"),
    "email",
  );
  assert.equal(target.querySelector('[data-field="u"] input').getAttribute("autocomplete"), "url");
  assert.equal(target.querySelector('[data-field="s"] input').hasAttribute("autocomplete"), false);
});

test("rating star glyph is a shape signal: hollow ☆ unselected, filled ★ selected", async () => {
  const target = mount({
    version: 1,
    title: "T",
    settings: {},
    pages: [{ id: "p1", blocks: [{ id: "rating", kind: "rating", label: "Rating", max: 3 }] }],
  });
  const stars = () => [...target.querySelectorAll('[data-field="rating"] .fillo-star')];
  assert.deepEqual(
    stars().map((s) => s.textContent),
    ["☆", "☆", "☆"],
  );
  stars()[1].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  await tick();
  assert.deepEqual(
    stars().map((s) => s.textContent),
    ["★", "★", "☆"],
  );
});

test("icon-mode choice options get a decorative check marker when selected (non-color signal)", async () => {
  const target = mount({
    version: 1,
    title: "T",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [
          {
            id: "vote",
            kind: "select",
            label: "Vote",
            required: true,
            options: [
              { id: "yes", label: "Yes", icon: "thumbs_up" },
              { id: "no", label: "No", icon: "thumbs_down" },
            ],
          },
        ],
      },
    ],
  });
  assert.equal(
    target.querySelectorAll(".fillo-option-check").length,
    0,
    "no marker before selection",
  );
  const yes = target.querySelector('[data-option="yes"] input');
  yes.checked = true;
  dispatch(yes, "change");
  await tick();
  const check = target.querySelector('[data-option="yes"] .fillo-option-check');
  assert.ok(check, "selected icon option gets the check marker");
  assert.equal(check.getAttribute("aria-hidden"), "true");
  assert.equal(check.textContent, "✓");
  assert.equal(
    target.querySelector('[data-option="no"] .fillo-option-check'),
    null,
    "unselected option has none",
  );
});

test('"Other" free-text inputs are labeled (aria-label) so multiple choice/dropdown fields don\'t all read "Your answer"', async () => {
  const target = mount({
    version: 1,
    title: "T",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [
          {
            id: "pick",
            kind: "select",
            label: "Pick",
            allowOther: true,
            options: [{ id: "a", label: "A" }],
          },
        ],
      },
    ],
  });
  const otherRadio = target.querySelector('.fillo-option--other input[type="radio"]');
  otherRadio.checked = true;
  dispatch(otherRadio, "change");
  await tick();
  const otherInput = target.querySelector(".fillo-other-input");
  assert.equal(otherInput.getAttribute("aria-label"), "Other — please specify");
  assert.equal(otherInput.placeholder, "Your answer");
});

test("toggle-styled checkbox drops role=switch — native checkbox semantics, pill CSS class untouched", async () => {
  const target = mount({
    version: 1,
    title: "T",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [{ id: "agree", kind: "checkbox", label: "Agree", appearance: "toggle" }],
      },
    ],
  });
  const input = target.querySelector('[data-field="agree"] .fillo-toggle-input');
  assert.equal(input.hasAttribute("role"), false);
  assert.equal(input.hasAttribute("aria-checked"), false);
  assert.equal(input.type, "checkbox");
  assert.ok(target.querySelector('[data-field="agree"] .fillo-toggle'), "pill class untouched");
  input.checked = true;
  dispatch(input, "change");
  await tick();
  const after = target.querySelector('[data-field="agree"] .fillo-toggle-input');
  assert.equal(
    after.hasAttribute("aria-checked"),
    false,
    "still no aria-checked management post-toggle",
  );
  assert.equal(after.checked, true);
});

test("Space/Enter (keyboard click, detail 0) on an already-checked rating value is a no-op; pointer click-again still clears", async () => {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = renderForm(target, {
    form: {
      version: 1,
      title: "T",
      settings: {},
      pages: [{ id: "p1", blocks: [{ id: "rating", kind: "rating", label: "Rating", max: 5 }] }],
    },
    formId: "f-test",
    client: localClient,
  });
  const selector = '[data-field="rating"] [role="radio"][aria-label="3 of 5"]';
  let star = target.querySelector(selector);
  star.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  await tick();
  assert.equal(instance.data.rating, 3, "pointer click selects 3");

  star = target.querySelector(selector);
  star.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }));
  await tick();
  assert.equal(
    instance.data.rating,
    3,
    "keyboard activation (detail 0) on the checked value is a no-op",
  );

  star = target.querySelector(selector);
  star.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  await tick();
  assert.equal(instance.data.rating, null, "pointer click-again still clears");
});

test("rating keyboard adopts core's radioGroupStep: clamp (no wrap), Home/End, RTL-aware arrows", async () => {
  const target = mount({
    version: 1,
    title: "T",
    settings: {},
    pages: [{ id: "p1", blocks: [{ id: "rating", kind: "rating", label: "Rating", max: 5 }] }],
  });
  const group = () => target.querySelector('[data-field="rating"] [role="radiogroup"]');
  const checkedLabel = () =>
    target.querySelector('[data-field="rating"] [aria-checked="true"]')?.getAttribute("aria-label");

  // Nothing selected: both directions clamp to the first star — no wrap to
  // the last one (the old hand-rolled math's "nothing selected + backward"
  // case, before adopting core's shared, tested radioGroupStep).
  keydown(group(), "ArrowLeft");
  await tick();
  assert.equal(checkedLabel(), "1 of 5");

  keydown(group(), "End");
  await tick();
  assert.equal(checkedLabel(), "5 of 5");

  keydown(group(), "ArrowRight");
  await tick();
  assert.equal(checkedLabel(), "5 of 5", "clamps at the end instead of wrapping to the first");

  keydown(group(), "Home");
  await tick();
  assert.equal(checkedLabel(), "1 of 5");

  keydown(group(), "ArrowRight");
  await tick();
  keydown(group(), "ArrowRight");
  await tick();
  assert.equal(checkedLabel(), "3 of 5");

  // RTL direction is read fresh per keydown (getComputedStyle), so setting
  // it right before dispatching is enough.
  group().style.direction = "rtl";
  keydown(group(), "ArrowRight");
  await tick();
  assert.equal(checkedLabel(), "2 of 5", "RTL flips ArrowRight to move backward");
});

test("ranking move buttons get per-row aria-labels (Move «label» up/down)", () => {
  const target = mount({
    version: 1,
    title: "T",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [
          {
            id: "rank",
            kind: "ranking",
            label: "Rank",
            required: true,
            options: [
              { id: "a", label: "Apples" },
              { id: "b", label: "Bananas" },
            ],
          },
        ],
      },
    ],
  });
  const up = target.querySelector('[data-fillo-rank-opt="a"][data-fillo-rank-dir="up"]');
  const down = target.querySelector('[data-fillo-rank-opt="a"][data-fillo-rank-dir="down"]');
  assert.equal(up.getAttribute("aria-label"), "Move Apples up");
  assert.equal(down.getAttribute("aria-label"), "Move Apples down");
});

test("ranking: moving an item to an extreme disables that button — focus moves to its other move button, not <body>", async () => {
  const target = mount({
    version: 1,
    title: "T",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [
          {
            id: "rank",
            kind: "ranking",
            label: "Rank",
            required: true,
            options: [
              { id: "a", label: "A" },
              { id: "b", label: "B" },
              { id: "c", label: "C" },
            ],
          },
        ],
      },
    ],
  });
  const upB = target.querySelector('[data-fillo-rank-opt="b"][data-fillo-rank-dir="up"]');
  upB.focus();
  assert.equal(document.activeElement, upB);
  dispatch(upB, "click");
  await tick();

  // "b" moved from index 1 to index 0 — its "up" button is now disabled.
  const upBAfter = target.querySelector('[data-fillo-rank-opt="b"][data-fillo-rank-dir="up"]');
  const downBAfter = target.querySelector('[data-fillo-rank-opt="b"][data-fillo-rank-dir="down"]');
  assert.ok(upBAfter.disabled, "the pressed direction is now disabled at the extreme");
  assert.equal(
    document.activeElement,
    downBAfter,
    "focus moved to b's other move button, not stranded on body",
  );
});

test("matrix: per-row radiogroup labelled by field+row, cell label wrapper, data-label, per-cell required/invalid", async () => {
  const schema = {
    version: 1,
    title: "T",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [
          {
            id: "matrix",
            kind: "matrix",
            label: "Grid",
            required: true,
            rows: [
              { id: "r1", label: "Row One" },
              { id: "r2", label: "Row Two" },
            ],
            columns: [
              { id: "c1", label: "Col One" },
              { id: "c2", label: "Col Two" },
            ],
          },
        ],
      },
    ],
  };
  const target = document.createElement("div");
  document.body.appendChild(target);
  renderForm(target, { form: schema, formId: "f-test", client: localClient });

  const fieldLabel = target.querySelector('[data-field="matrix"] [data-fillo="label"]');
  const rowGroups = [...target.querySelectorAll('[data-field="matrix"] [role="radiogroup"]')];
  assert.equal(rowGroups.length, 2, "one radiogroup per row");
  const rowSpecs = [
    ["r1", "Row One"],
    ["r2", "Row Two"],
  ];
  rowSpecs.forEach(([, rowLabelText], i) => {
    const group = rowGroups[i];
    const labelledBy = group.getAttribute("aria-labelledby").split(" ");
    assert.equal(labelledBy[0], fieldLabel.id, "labelled by the field label first");
    const rowLabelEl = document.getElementById(labelledBy[1]);
    assert.equal(rowLabelEl.textContent, rowLabelText);
    const owns = group.getAttribute("aria-owns").split(" ");
    assert.equal(owns.length, 2);
    for (const id of owns)
      assert.ok(document.getElementById(id), `aria-owns references a real input (${id})`);
  });

  // Cell structure: label wrapper (pointer target) + data-label for the
  // narrow-viewport stacked CSS. Scoped to tbody: the thead corner cell
  // above the row-label column is also a <td> now (empty-table-header fix,
  // ledger #2), and it carries no data-label — querying bare "td" would
  // sweep it in alongside the four real data cells below.
  const cells = [...target.querySelectorAll('[data-field="matrix"] tbody td')];
  assert.equal(cells.length, 4);
  for (const td of cells) {
    assert.ok(td.hasAttribute("data-label"));
    const cellLabel = td.querySelector("label.fillo-matrix-cell");
    assert.ok(cellLabel, "input is wrapped in a .fillo-matrix-cell label");
    assert.ok(cellLabel.querySelector("input"));
  }

  // Answer row 1 only, then fail submit (required, incomplete) — only the
  // unanswered row's cells should pick up aria-invalid.
  const r1c1 = target.querySelector('[data-field="matrix"] input[aria-label="Row One: Col One"]');
  r1c1.checked = true;
  dispatch(r1c1, "change");
  await tick();
  dispatch(target.querySelector("form"), "submit");
  await tick();

  const rows = [...target.querySelectorAll('[data-field="matrix"] tbody tr')];
  const r1Inputs = [...rows[0].querySelectorAll("input")];
  const r2Inputs = [...rows[1].querySelectorAll("input")];
  for (const input of r1Inputs) {
    assert.equal(input.getAttribute("aria-required"), "true");
    assert.equal(input.hasAttribute("aria-invalid"), false, "answered row stays valid");
  }
  for (const input of r2Inputs) {
    assert.equal(
      input.getAttribute("aria-invalid"),
      "true",
      "unanswered required row is flagged invalid",
    );
  }
});

test("signature: canvas is role=img with a live aria-label (signatureSigned/signatureEmpty); type-to-sign gets a persistent visible label", () => {
  const target = mount(
    {
      version: 1,
      title: "T",
      settings: {},
      pages: [{ id: "p1", blocks: [{ id: "sig", kind: "signature", label: "Sign" }] }],
    },
    { initialData: { sig: "data:image/png;base64,AAAA" } },
  );
  const canvas = target.querySelector('[data-field="sig"] canvas');
  assert.equal(canvas.getAttribute("role"), "img");
  assert.equal(canvas.hasAttribute("aria-hidden"), false);
  assert.equal(
    canvas.getAttribute("aria-label"),
    "Signature saved",
    "signed on mount from a restored value",
  );

  const typed = target.querySelector('[data-field="sig"] .fillo-signature-type-input');
  const label = target.querySelector('[data-field="sig"] label.fillo-signature-type-label');
  assert.ok(label, "persistent visible instructional label exists (not just a placeholder)");
  assert.equal(label.getAttribute("for"), typed.id);
  assert.equal(label.textContent, "Or type your full name to sign");

  target.querySelector('[data-field="sig"] .fillo-signature-clear').click();
  assert.equal(
    canvas.getAttribute("aria-label"),
    "No signature yet",
    "aria-label live-updates back to empty after Clear",
  );
});

test("signature: canvas starts empty (aria-label='No signature yet') with no stored value", () => {
  const target = mount({
    version: 1,
    title: "T",
    settings: {},
    pages: [{ id: "p1", blocks: [{ id: "sig", kind: "signature", label: "Sign" }] }],
  });
  const canvas = target.querySelector('[data-field="sig"] canvas');
  assert.equal(canvas.getAttribute("aria-label"), "No signature yet");
});

test("fixed backgrounds infer a readable dark/light palette unless the scheme is explicit", () => {
  const dark = mount(oneField, { theme: { background: "#000000", text: "#ffffff" } });
  assert.equal(
    dark.querySelector('[data-fillo="root"]').getAttribute("data-fillo-color-scheme"),
    "dark",
  );

  const light = mount(oneField, { theme: { background: "#ffffff", text: "#000000" } });
  assert.equal(
    light.querySelector('[data-fillo="root"]').getAttribute("data-fillo-color-scheme"),
    "light",
  );

  const backgroundOnly = mount(oneField, { theme: { background: "#000000" } });
  assert.equal(
    backgroundOnly.querySelector('[data-fillo="root"]').getAttribute("data-fillo-color-scheme"),
    "dark",
  );

  const automatic = mount(oneField, {
    theme: { background: "#ffffff", colorScheme: "auto" },
  });
  assert.equal(
    automatic.querySelector('[data-fillo="root"]').getAttribute("data-fillo-color-scheme"),
    "light",
  );

  // Explicit colorScheme always wins over inference.
  const explicit = mount(oneField, {
    theme: { background: "#000000", text: "#ffffff", colorScheme: "light" },
  });
  assert.equal(
    explicit.querySelector('[data-fillo="root"]').getAttribute("data-fillo-color-scheme"),
    "light",
  );
});

// ---------- Phone country picker (audit P1.8/P2.7) ----------

test("phone picker list uses the Intl.Collator-sorted PHONE_PICKER_COUNTRIES, not curated dial-code order", async () => {
  const target = mount(phoneField);
  dispatch(target.querySelector(".fillo-phone-flag"), "click");
  await tick();
  const names = [...target.querySelectorAll(".fillo-phone-option-name")].map((n) => n.textContent);
  assert.deepEqual(
    names.slice(0, 5),
    PHONE_PICKER_COUNTRIES.slice(0, 5).map((c) => c.name),
  );
});

test("phone trigger keyboard: ArrowDown/Up open the popover (closed-state APG-adjacent map)", async () => {
  const target = mount(phoneField);
  const flag = target.querySelector(".fillo-phone-flag");
  assert.equal(flag.getAttribute("aria-expanded"), "false");
  keydown(flag, "ArrowDown");
  await tick();
  assert.equal(flag.getAttribute("aria-expanded"), "true");
});

test("phone trigger keyboard: a printable character opens the popover, seeds the filter, and focuses the search box", async () => {
  const target = mount(phoneField);
  const flag = target.querySelector(".fillo-phone-flag");
  keydown(flag, "f");
  await tick();
  assert.equal(flag.getAttribute("aria-expanded"), "true");
  const search = target.querySelector(".fillo-phone-search");
  assert.equal(search.value, "f");
  assert.equal(document.activeElement, search);
  // Space must not seed the filter with " " — it's the native button
  // activation key, not typeahead.
  const target2 = mount(phoneField);
  const flag2 = target2.querySelector(".fillo-phone-flag");
  keydown(flag2, " ");
  await tick();
  assert.equal(
    flag2.getAttribute("aria-expanded"),
    "false",
    "Space doesn't open via the typeahead path",
  );
});

test("phone trigger exposes aria-controls only while open; search box is labeled", async () => {
  const target = mount(phoneField);
  const flag = target.querySelector(".fillo-phone-flag");
  assert.equal(flag.hasAttribute("aria-controls"), false, "closed trigger has no aria-controls");
  dispatch(flag, "click");
  await tick();
  const controls = flag.getAttribute("aria-controls");
  assert.ok(controls);
  assert.equal(target.querySelector(`#${controls}`)?.getAttribute("role"), "listbox");
  assert.equal(
    target.querySelector(".fillo-phone-search").getAttribute("aria-label"),
    "Search country or code",
  );
  dispatch(flag, "click");
  await tick();
  assert.equal(flag.hasAttribute("aria-controls"), false, "removed again once closed");
});

test('phone search with zero matches renders a disabled role="option" and guards aria-activedescendant (no dangling/-1 reference)', async () => {
  const target = mount(phoneField);
  dispatch(target.querySelector(".fillo-phone-flag"), "click");
  await tick();
  const search = target.querySelector(".fillo-phone-search");
  assert.ok(search.getAttribute("aria-activedescendant"), "a match is active initially");

  search.value = "zzzzznotacountry";
  dispatch(search, "input");
  await tick();

  const empty = target.querySelector(".fillo-phone-empty");
  assert.equal(empty.getAttribute("role"), "option");
  assert.equal(empty.getAttribute("aria-disabled"), "true");
  assert.equal(
    search.hasAttribute("aria-activedescendant"),
    false,
    "cleared, not dangling, on empty results",
  );

  keydown(search, "ArrowDown");
  await tick();
  assert.equal(
    search.hasAttribute("aria-activedescendant"),
    false,
    "ArrowDown on an empty list doesn't resurrect a -1 reference",
  );
});

test("phone popover closes on Tab-away (focusout leaving the trigger+popover composite) without yanking focus back to the trigger", async () => {
  const target = mount({
    version: 1,
    title: "T",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [
          { id: "phone", kind: "phone", label: "Phone" },
          { id: "next_field", kind: "short_text", label: "Next" },
        ],
      },
    ],
  });
  const flag = target.querySelector(".fillo-phone-flag");
  dispatch(flag, "click");
  await tick();
  assert.equal(flag.getAttribute("aria-expanded"), "true");
  assert.ok(target.querySelector(".fillo-phone-popover"));

  const nextInput = target.querySelector('[data-field="next_field"] input');
  nextInput.focus(); // simulates Tab moving focus to the next field, outside the picker
  await tick();

  assert.equal(
    flag.getAttribute("aria-expanded"),
    "false",
    "popover closed once focus left the composite",
  );
  assert.equal(target.querySelector(".fillo-phone-popover"), null);
  assert.equal(
    document.activeElement,
    nextInput,
    "focus stays where the user sent it, not stolen back to the trigger",
  );
});

test("phone: a lone '+' stays pending instead of corrupting the value", async () => {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = renderForm(target, { form: phoneField, formId: "f-test", client: localClient });
  const input = target.querySelector(".fillo-phone-input");
  input.value = "+";
  dispatch(input, "input");
  await tick();
  assert.equal(instance.data.phone, "+", "the bare + is held verbatim, not cleared");
  assert.equal(input.value, "+", "the input text is not rewritten while pending");
});

test("phone: prepending '+' to unchanged stale digits stays pending instead of hijacking the country (core P0.2)", async () => {
  const form = {
    version: 1,
    title: "T",
    settings: {},
    pages: [
      { id: "p1", blocks: [{ id: "phone", kind: "phone", label: "Phone", defaultCountry: "US" }] },
    ],
  };
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = renderForm(target, { form, formId: "f-test", client: localClient });
  const input = target.querySelector(".fillo-phone-input");
  for (const ch of "5551234") {
    input.value += ch;
    dispatch(input, "input");
    await tick();
  }
  assert.equal(instance.data.phone, "+15551234", "committed as a US national number");

  // Positioning the cursor at the start and typing "+" prepends it to the
  // SAME unchanged digits — "55" happens to be Brazil's dial code, so this
  // used to silently reassign the country the instant "+" landed. Note: a
  // hijacked-to-Brazil misread would produce the SAME "+5551234" text
  // (dial code "55" + national "51234" reassembles to the same digits) — the
  // digits alone can't tell "pending" apart from "resolved as Brazil"; the
  // country assertion below is the one that actually distinguishes them.
  input.value = `+${input.value}`;
  dispatch(input, "input");
  await tick();
  const digitsAndPlus = instance.data.phone.replace(/[^\d+]/g, "");
  assert.equal(
    digitsAndPlus,
    "+5551234",
    "held as pending raw text (same digits), not reinterpreted",
  );
  assert.match(
    target.querySelector(".fillo-phone-flag").getAttribute("aria-label"),
    /United States/,
    "country selection is unchanged while pending",
  );
});

test("phone: '+' followed by digits that resolve a real dial code assigns the country normally (pending fix doesn't break normal international entry)", async () => {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = renderForm(target, { form: phoneField, formId: "f-test", client: localClient });
  const input = target.querySelector(".fillo-phone-input");
  for (const ch of "+447400123456") {
    input.value += ch;
    dispatch(input, "input");
    await tick();
  }
  assert.equal(instance.data.phone, "+447400123456");
  assert.match(
    target.querySelector(".fillo-phone-flag").getAttribute("aria-label"),
    /United Kingdom/,
  );
});

// ---------- Live-region hoist, per-file upload UI, progress honesty, error
// summary, and channel announcements (audit P2.1/P0.3/P2.2/P2.8) ----------

test("the two persistent live-region channels are hoisted outside the re-rendered subtree and survive a re-render", async () => {
  const target = mount(oneField);
  const status1 = statusChannel(target);
  const alert1 = alertChannel(target);
  assert.ok(status1, "polite channel exists at mount");
  assert.ok(alert1, "alert channel exists at mount");
  assert.equal(status1.getAttribute("role"), "status");
  assert.equal(status1.getAttribute("aria-live"), "polite");
  assert.equal(alert1.getAttribute("role"), "alert");
  assert.ok(status1.classList.contains("fillo-sr-only"));
  assert.ok(alert1.classList.contains("fillo-sr-only"));
  // Siblings of the re-rendered root, not descendants of it — the whole
  // point of the hoist (a node inside .fillo-dom-root would be torn down by
  // element.replaceChildren() on every render()).
  assert.equal(status1.parentElement, target);
  assert.equal(status1.closest(".fillo-dom-root"), null);

  const input = target.querySelector(".fillo-field--short_text input");
  input.value = "Ada";
  dispatch(input, "change"); // setValue({render:true}) → queueRender → element.replaceChildren()
  await tick();
  assert.equal(
    statusChannel(target),
    status1,
    "same node identity — never recreated by a re-render",
  );
  assert.equal(alertChannel(target), alert1, "same node identity — never recreated by a re-render");
});

// ---------- First-click-after-edit swallow (ledger #4, docs/decisions/
// input-quality.md): a text field's blur commits via "change" -> setValue ->
// queueRender's full-tree rebuild. Rebuilding too early strands a pointer
// gesture already in flight on a DIFFERENT control: the click's mousedown
// target gets detached mid-gesture, and Chromium/WebKit then never fire
// "click" at all (github.com/w3c/uievents#141) — the respondent's first
// click after editing any text field silently does nothing. ----------

/**
 * jsdom dispatches whatever event you ask it to, on whatever node reference
 * you hand it, regardless of document connectivity — it does not model the
 * real-browser mechanism this regression guards (Chromium/WebKit refuse to
 * fire "click" when the element that received "mousedown" was removed from
 * the document before "mouseup" — w3c/uievents#141). Dispatching mousedown/
 * mouseup/click straight at a captured node with plain jsdom APIs would
 * "pass" identically whether or not the node survived the rebuild (a
 * detached node's own listeners still fire when you dispatch to it
 * directly), so it could never actually catch this bug either way. This
 * helper reproduces the browser's mousedown-target-connectivity check by
 * hand so the test honestly exercises the swallow instead of trivially
 * passing regardless of the fix — verified against the pre-fix
 * `queueMicrotask` scheduling to fail exactly as described before this
 * fix, and pass after.
 */
function simulateRealPointerClick(target) {
  target.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  if (!target.isConnected) return false; // Chromium/WebKit: click never fires
  target.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true, cancelable: true }));
  target.dispatchEvent(
    new window.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }),
  );
  return true;
}

test("editing a grouped number field, then clicking a rating star, does not swallow the click", async () => {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = renderForm(target, {
    form: {
      version: 1,
      title: "T",
      settings: {},
      pages: [
        {
          id: "p1",
          blocks: [
            { id: "amount", kind: "number", label: "Amount", notation: "grouped" },
            { id: "satisfaction", kind: "rating", label: "Satisfaction", max: 5 },
          ],
        },
      ],
    },
    formId: "f-test",
    client: localClient,
  });

  const input = target.querySelector('[data-field="amount"] input');
  input.value = "1234";
  dispatch(input, "input"); // {render:false} draft path — no rebuild yet

  // The star under the respondent's pointer, captured BEFORE the blur that's
  // about to fire — exactly like a real mousedown captures its target before
  // any of this render machinery runs.
  const star = target.querySelector('[data-field="satisfaction"] [aria-label="3 of 5"]');

  dispatch(input, "change"); // blur-path commit: schedules the deferred rebuild
  // A real mousedown on the star would trigger this SAME blur/change
  // synchronously as part of its own default action; the mouseup/click that
  // finish the gesture then arrive as later, separate tasks. Awaiting a bare
  // microtask here (not the full setTimeout-based tick()) reproduces exactly
  // that gap without also flushing the macrotask-scheduled render.
  await Promise.resolve();

  const registered = simulateRealPointerClick(star);
  assert.ok(
    registered,
    "the star survived the blur-triggered rebuild long enough for its click to fire",
  );

  await tick(); // let the deferred rebuild actually happen
  assert.equal(instance.data.satisfaction, 3, "the click landed and set the rating");
});

test("a valid upload start clears required validation before the file completes", async () => {
  let changes = 0;
  const client = {
    startSession: async () => null,
    reportProgress() {},
    uploadFile: async () => new Promise(() => {}),
  };
  const target = mount(
    {
      version: 1,
      title: "T",
      settings: {},
      pages: [
        {
          id: "p1",
          blocks: [{ id: "files", kind: "file_upload", label: "Files", required: true }],
        },
      ],
    },
    {
      formId: "f-required-upload",
      client,
      onChange: () => {
        changes += 1;
      },
    },
  );

  dispatch(target.querySelector("form"), "submit");
  await tick();
  assert.match(target.querySelector('[data-fillo="error"]').textContent, /Add a file/);

  const input = target.querySelector('input[type="file"]');
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [new File(["a"], "a.txt")],
  });
  dispatch(input, "change");
  await tick();

  assert.ok(target.querySelector('[role="progressbar"]'), "accepted correction is in progress");
  assert.equal(target.querySelector('[data-fillo="error"]'), null);
  assert.equal(target.querySelector('[data-fillo="error-summary"]'), null);
  assert.equal(changes, 0, "progress does not masquerade as a completed answer");
});

test("an oversized selection does not clear required validation", async () => {
  const target = mount({
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
            required: true,
            maxFileSizeMb: 1,
          },
        ],
      },
    ],
  });

  dispatch(target.querySelector("form"), "submit");
  await tick();
  const input = target.querySelector('input[type="file"]');
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [new File([new Uint8Array(2 * 1024 * 1024)], "large.pdf")],
  });
  dispatch(input, "change");
  await tick();

  assert.match(target.querySelector('[data-fillo="error"]').textContent, /Add a file/);
  const failed = target.querySelector(".fillo-file--failed");
  assert.match(failed.querySelector(".fillo-file-error").textContent, /Larger than 1 MB limit/);
  assert.ok(failed.querySelector(".fillo-file-state--failed"));
  assert.equal(
    failed.querySelector(".fillo-file-retry"),
    null,
    "a local size failure cannot retry",
  );
  assert.ok(failed.querySelector('button[aria-label="Dismiss large.pdf"]'));
  assert.equal(
    target.querySelector(".fillo-upload-notice"),
    null,
    "a size failure is per-file, not aggregate-only",
  );
});

test("in-flight upload row exposes progressbar + Cancel; a progress tick mutates the row in place", async () => {
  const calls = [];
  const client = {
    uploadFile: async (_formId, file, opts) =>
      new Promise((resolve, reject) => calls.push({ file, opts, resolve, reject })),
  };
  const target = mount(
    {
      version: 1,
      title: "T",
      settings: {},
      pages: [{ id: "p1", blocks: [{ id: "files", kind: "file_upload", label: "Files" }] }],
    },
    { formId: "f1", client },
  );
  const input = target.querySelector('input[type="file"]');
  Object.defineProperty(input, "files", { configurable: true, value: [new File(["a"], "ok.txt")] });
  dispatch(input, "change");
  await tick();

  const row = target.querySelector(".fillo-file");
  const progress = row.querySelector('.fillo-progress[role="progressbar"]');
  assert.equal(row.getAttribute("role"), null, "the list item keeps its native listitem role");
  assert.equal(progress.getAttribute("aria-label"), "Uploading ok.txt");
  assert.equal(progress.getAttribute("aria-valuemin"), "0");
  assert.equal(progress.getAttribute("aria-valuemax"), "100");
  assert.equal(progress.getAttribute("aria-valuenow"), "0");
  assert.equal(row.querySelector(".fillo-file-name").textContent, "ok.txt");
  const cancelBtn = row.querySelector('button[aria-label="Cancel ok.txt"]');
  assert.ok(cancelBtn, "labelled Cancel button");
  assert.equal(progress.contains(cancelBtn), false, "Cancel stays outside the progressbar subtree");
  assert.deepEqual(
    [...row.children].map((child) => child.className),
    [
      "fillo-file-state fillo-file-state--uploading",
      "fillo-file-content",
      "fillo-file-actions",
      "fillo-progress",
    ],
    "the row keeps state, content, and actions aligned above its progress track",
  );
  assert.equal(row.querySelector(".fillo-file-meta").textContent, "Uploading · 0% · 1 B");
  assert.equal(row.querySelector(".fillo-file-state").getAttribute("aria-hidden"), "true");
  const stateIcon = row.querySelector(".fillo-file-state-icon");
  assert.equal(stateIcon.getAttribute("width"), "22", "state icon is bounded without CSS");
  assert.equal(stateIcon.getAttribute("height"), "22", "state icon is bounded without CSS");
  const actionIcon = cancelBtn.querySelector(".fillo-file-action-icon");
  assert.equal(actionIcon.getAttribute("width"), "16", "action icon is bounded without CSS");
  assert.equal(actionIcon.getAttribute("height"), "16", "action icon is bounded without CSS");
  assert.equal(cancelBtn.textContent, "", "no raw × glyph is exposed as button content");

  // {render:false} discipline: an onProgress tick mutates the row rather than
  // rebuilding the field; queueRender() still reflects it on the next tick.
  calls[0].opts.onProgress({ fraction: 0.42 });
  await tick();
  assert.equal(target.querySelector(".fillo-progress").getAttribute("aria-valuenow"), "42");

  dispatch(cancelBtn, "click");
  await tick();
  assert.equal(target.querySelector(".fillo-file"), null, "cancel aborts and drops the row");
});

test("a completed upload becomes a done row with visible status + labelled Remove", async () => {
  const target = mount({
    version: 1,
    title: "T",
    settings: {},
    pages: [{ id: "p1", blocks: [{ id: "files", kind: "file_upload", label: "Files" }] }],
  });
  const input = target.querySelector('input[type="file"]');
  Object.defineProperty(input, "files", { configurable: true, value: [new File(["a"], "ok.txt")] });
  dispatch(input, "change");
  await tick();
  await tick();
  const row = target.querySelector(".fillo-file--done");
  assert.ok(row);
  assert.equal(row.querySelector(".fillo-file-name").textContent, "ok.txt");
  assert.equal(row.querySelector(".fillo-file-meta").textContent, "Uploaded · 1 B");
  assert.ok(row.querySelector(".fillo-file-state--done"));
  const removeBtn = row.querySelector('button[aria-label="Remove ok.txt"]');
  assert.ok(removeBtn);
  assert.ok(removeBtn.querySelector(".fillo-file-action-icon"));
  dispatch(removeBtn, "click");
  await tick();
  assert.equal(target.querySelector(".fillo-file--done"), null);
});

test("a failed upload row offers a labelled Retry that re-uploads, and a Dismiss", async () => {
  const calls = [];
  const client = {
    startSession: async () => null,
    reportProgress() {},
    uploadFile: async (_formId, file, opts) =>
      new Promise((resolve, reject) => calls.push({ file, opts, resolve, reject })),
  };
  const target = mount(
    {
      version: 1,
      title: "T",
      settings: {},
      pages: [{ id: "p1", blocks: [{ id: "files", kind: "file_upload", label: "Files" }] }],
    },
    { formId: "f1", client },
  );
  const input = target.querySelector('input[type="file"]');
  Object.defineProperty(input, "files", { configurable: true, value: [new File(["a"], "ok.txt")] });
  dispatch(input, "change");
  await tick();
  calls[0].reject(new Error("server hiccup"));
  await tick();
  await tick();

  const row = target.querySelector(".fillo-file--failed");
  assert.ok(row);
  assert.match(row.querySelector(".fillo-file-error").textContent, /couldn't upload/u);
  assert.doesNotMatch(row.querySelector(".fillo-file-error").textContent, /server hiccup/u);
  const retryBtn = row.querySelector(".fillo-file-retry");
  assert.equal(retryBtn.getAttribute("aria-label"), "Retry ok.txt");
  assert.equal(retryBtn.textContent, "Retry");
  assert.ok(row.querySelector('button[aria-label="Dismiss ok.txt"]'));

  dispatch(retryBtn, "click");
  await tick();
  assert.equal(calls.length, 2, "retry re-invoked the upload client with the retained file");
  assert.equal(
    target.querySelector(".fillo-file--failed"),
    null,
    "the failed row is gone once retrying",
  );
  assert.equal(
    target.querySelector(".fillo-progress").getAttribute("role"),
    "progressbar",
    "back to in-flight",
  );
  calls[1].resolve({ fileId: "f-ok", name: "ok.txt", size: 1, mime: "text/plain" });
  await tick();
  await tick();
  assert.ok(target.querySelector(".fillo-file--done"), "the retry completed successfully");
});

test("dismissing a failed upload row clears it without retrying", async () => {
  const calls = [];
  const client = {
    uploadFile: async (_formId, file, opts) =>
      new Promise((resolve, reject) => calls.push({ file, opts, resolve, reject })),
  };
  const target = mount(
    {
      version: 1,
      title: "T",
      settings: {},
      pages: [{ id: "p1", blocks: [{ id: "files", kind: "file_upload", label: "Files" }] }],
    },
    { formId: "f1", client },
  );
  const input = target.querySelector('input[type="file"]');
  Object.defineProperty(input, "files", { configurable: true, value: [new File(["a"], "ok.txt")] });
  dispatch(input, "change");
  await tick();
  calls[0].reject(new Error("nope"));
  await tick();
  await tick();
  const dismissBtn = target.querySelector(
    '.fillo-file--failed button[aria-label="Dismiss ok.txt"]',
  );
  dispatch(dismissBtn, "click");
  await tick();
  assert.equal(target.querySelector(".fillo-file"), null);
  assert.equal(calls.length, 1, "dismiss never re-invoked the client");
});

test("progress bar reflects the reachable page sequence, not raw pageIndex/pageCount, across a jump rule", async () => {
  const target = mount({
    version: 1,
    title: "T",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [
          {
            id: "mode",
            kind: "select",
            label: "Mode",
            required: true,
            options: [
              { id: "skip", label: "Skip" },
              { id: "stay", label: "Stay" },
            ],
          },
        ],
        next: [{ when: [{ fieldId: "mode", op: "eq", value: "skip" }], to: "p3" }],
      },
      { id: "p2", blocks: [{ id: "middle", kind: "short_text", label: "Middle" }] },
      { id: "p3", blocks: [{ id: "last", kind: "short_text", label: "Last" }] },
    ],
  });
  const skip = target.querySelector('[data-option="skip"] input');
  skip.checked = true;
  dispatch(skip, "change");
  await tick();
  dispatch(target.querySelector("form"), "submit"); // p1 isn't terminal (jumps to p3) — advances via next()
  await tick();
  assert.ok(target.querySelector('[data-field="last"]'), "landed on p3, skipping p2");

  const progress = target.querySelector('[role="progressbar"][data-fillo="progress"]');
  // Raw pageCount is 3 and raw pageIndex+1 would also be 3 (p3 is the 3rd
  // array entry) — but the jump rule makes the reachable sequence [p1, p3]
  // (length 2), and p3 is its 2nd (last) entry.
  assert.equal(
    progress.getAttribute("aria-valuemax"),
    "2",
    "jumped-over p2 is excluded from the denominator",
  );
  assert.equal(
    progress.getAttribute("aria-valuenow"),
    "2",
    "p3 is the 2nd reachable page, not the 3rd raw page",
  );
});

test("failed submit focuses the first invalid control with field-aware inline guidance", async () => {
  const target = mount({
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
  });
  dispatch(target.querySelector("form"), "submit");
  await tick();

  assert.equal(target.querySelector(".fillo-error-summary"), null);
  const nameError = target.querySelector('[data-field="name"] [data-fillo="error"]');
  assert.equal(nameError.textContent, "Enter your answer");
  assert.equal(nameError.getAttribute("role"), null);
  const emailError = target.querySelector('[data-field="email"] [data-fillo="error"]');
  assert.equal(emailError.textContent, "Enter an email address");
  const emailInput = target.querySelector('[data-field="email"] input');
  const nameInput = target.querySelector('[data-field="name"] input');
  assert.equal(document.activeElement, nameInput, "focus moved to the first invalid control");
  assert.equal(nameInput.getAttribute("aria-describedby"), nameError.id);
  assert.equal(emailInput.getAttribute("aria-describedby"), emailError.id);
});

test("focus-first descends into the first operable control of an invalid composite", async () => {
  const target = mount({
    version: 1,
    title: "T",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [{ id: "rating", kind: "rating", label: "Rating", required: true, max: 5 }],
      },
    ],
  });
  dispatch(target.querySelector("form"), "submit");
  await tick();

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
    const target = mount({
      version: 1,
      title: "T",
      settings: {},
      pages: [{ id: "p1", blocks: [scenario.block] }],
    });
    const formEl = target.querySelector("form");
    assert.ok(formEl, `${scenario.label} fixture renders`);
    dispatch(formEl, "submit");
    await tick();

    const expected = target.querySelector(scenario.selector);
    assert.ok(target.querySelector('[aria-invalid="true"]'), `${scenario.label} is marked invalid`);
    assert.equal(document.activeElement, expected, `${scenario.label} receives corrective focus`);
    target.remove();
  }
});

test("focus-first lands on the visible upload dropzone, never its hidden file input", async () => {
  const target = mount({
    version: 1,
    title: "T",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [{ id: "attachment", kind: "file_upload", label: "Attachment", required: true }],
      },
    ],
  });
  dispatch(target.querySelector("form"), "submit");
  await tick();

  const dropzone = target.querySelector('[data-field="attachment"] .fillo-dropzone');
  const hiddenInput = target.querySelector('[data-field="attachment"] input[type="file"]');
  const error = target.querySelector('[data-field="attachment"] [data-fillo="error"]');
  assert.equal(dropzone.getAttribute("aria-invalid"), "true");
  assert.equal(dropzone.getAttribute("aria-describedby"), error.id);
  assert.equal(document.activeElement, dropzone);
  assert.notEqual(document.activeElement, hiddenInput);
});

test("ordinary checkbox errors stay inline without a competing alert", async () => {
  const target = mount({
    version: 1,
    title: "T",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [{ id: "agree", kind: "checkbox", label: "Agree", required: true }],
      },
    ],
  });
  dispatch(target.querySelector("form"), "submit");
  await tick();

  const input = target.querySelector('[data-field="agree"] input[type="checkbox"]');
  const error = target.querySelector('[data-field="agree"] [data-fillo="error"]');
  assert.equal(error.getAttribute("role"), null);
  assert.equal(input.getAttribute("aria-describedby"), error.id);
  assert.equal(document.activeElement, input);
});

test("a ranking move announces the new position via the persistent live region", async () => {
  const target = mount({
    version: 1,
    title: "T",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [
          {
            id: "rank",
            kind: "ranking",
            label: "Rank",
            required: true,
            options: [
              { id: "a", label: "A" },
              { id: "b", label: "B" },
              { id: "c", label: "C" },
            ],
          },
        ],
      },
    ],
  });
  const upB = target.querySelector('[data-fillo-rank-opt="b"][data-fillo-rank-dir="up"]');
  dispatch(upB, "click");
  await tick();
  assert.equal(statusChannel(target).textContent, DEFAULT_FIELD_STRINGS.rankingPosition("B", 1, 3));
});

test("phone: picking a country announces via the live region; typing a filter announces the debounced result count", async () => {
  const target = mount(phoneField);
  dispatch(target.querySelector(".fillo-phone-flag"), "click");
  await tick();
  const search = target.querySelector(".fillo-phone-search");
  search.value = "Denmark";
  dispatch(search, "input");

  await new Promise((r) => setTimeout(r, 100));
  assert.equal(statusChannel(target).textContent, "", "still debouncing — no per-keystroke spam");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(statusChannel(target).textContent, DEFAULT_FIELD_STRINGS.phoneResultsCount(1));

  const option = target.querySelector(".fillo-phone-option");
  dispatch(option, "mousedown");
  await tick();
  assert.equal(
    statusChannel(target).textContent,
    DEFAULT_FIELD_STRINGS.phoneCountrySelected("Denmark"),
  );
});

test("submitting announces via the persistent live region (covers auto-submit-no-footer silence); success carries no forced role", async () => {
  let resolveSubmit;
  const client = {
    startSession: async () => null,
    reportProgress() {},
    submit: async () =>
      new Promise((resolve) => {
        resolveSubmit = () => resolve({ ok: true, responseId: "r1" });
      }),
  };
  const target = mount(
    {
      version: 1,
      title: "Article feedback",
      settings: { submitMode: "auto" },
      pages: [
        {
          id: "p1",
          blocks: [
            {
              id: "vote",
              kind: "select",
              label: "Was this helpful?",
              required: true,
              options: [
                { id: "up", label: "Thumbs up" },
                { id: "down", label: "Thumbs down" },
              ],
            },
          ],
        },
      ],
    },
    { formId: "f1", client },
  );
  assert.equal(
    target.querySelector(".fillo-button--primary"),
    null,
    "no footer — silence would otherwise be total",
  );
  const up = target.querySelector('[data-option="up"] input');
  up.checked = true;
  dispatch(up, "change");
  await tick();
  assert.equal(statusChannel(target).textContent, DEFAULT_FIELD_STRINGS.submittingAnnouncement);
  resolveSubmit();
  await tick();
  await tick();
  const success = target.querySelector(".fillo-form--success");
  assert.ok(success, "success screen rendered");
  assert.equal(
    success.getAttribute("role"),
    null,
    "no forced role=status — announce() above already narrated it",
  );
});

// ---------- Repeating groups (bet 08 P3, docs/decisions/repeating-groups.md
// decisions 8-9 + the wave-B shared spec) ----------

function groupField(overrides = {}) {
  return {
    id: "guests",
    kind: "repeating_group",
    label: "Guests",
    itemLabel: "Guest",
    minInstances: 1,
    maxInstances: 3,
    fields: [
      { id: "name", kind: "short_text", label: "Name", required: true },
      {
        id: "meal",
        kind: "select",
        label: "Meal",
        options: [
          { id: "veg", label: "Vegetarian" },
          { id: "reg", label: "Regular" },
        ],
      },
    ],
    ...overrides,
  };
}

function groupForm(overrides = {}) {
  return {
    version: 1,
    title: "T",
    settings: {},
    pages: [{ id: "p1", blocks: [groupField(overrides)] }],
  };
}

test("repeating group: minInstances 0 with no stored data renders zero cards, just Add", () => {
  const target = mount(groupForm({ minInstances: 0 }));
  assert.equal(target.querySelectorAll('[data-field="guests"] .fillo-group-instance').length, 0);
  assert.ok(target.querySelector('[data-field="guests"] .fillo-group-add'), "Add still renders");
});

test("repeating group: default minInstances (1) pads to one empty card with no stored data", () => {
  const target = mount(groupForm());
  const cards = target.querySelectorAll('[data-field="guests"] .fillo-group-instance');
  assert.equal(cards.length, 1);
  assert.equal(
    cards[0].getAttribute("aria-label"),
    DEFAULT_FIELD_STRINGS.groupInstanceLabel("Guest", 1, 1),
  );
});

test("repeating group: a stored length above minInstances renders every stored instance (no padding)", () => {
  const target = mount(groupForm({ minInstances: 1 }), {
    initialData: { guests: [{ name: "Ada" }, { name: "Grace" }, { name: "Alan" }] },
  });
  const cards = target.querySelectorAll('[data-field="guests"] .fillo-group-instance');
  assert.equal(cards.length, 3);
  assert.equal(
    cards[2].getAttribute("aria-label"),
    DEFAULT_FIELD_STRINGS.groupInstanceLabel("Guest", 3, 3),
  );
});

test("repeating group: Add appends + materializes the padded array through the group's own setValue, focuses the new card's first control, announces, disables at max", async () => {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = renderForm(target, {
    form: groupForm({ minInstances: 1, maxInstances: 2 }),
    formId: "f-test",
    client: localClient,
  });
  await tick();
  const add = () => target.querySelector('[data-field="guests"] .fillo-group-add');
  add().focus();
  dispatch(add(), "click");
  await tick();

  assert.deepEqual(
    instance.data.guests,
    [{}, {}],
    "instance 0 materialized empty, the new instance appended",
  );
  const cards = target.querySelectorAll('[data-field="guests"] .fillo-group-instance');
  assert.equal(cards.length, 2);
  const secondCardFirstControl = cards[1].querySelector("input, select, textarea");
  assert.equal(
    document.activeElement,
    secondCardFirstControl,
    "focus lands on the new card's first control",
  );
  assert.equal(
    statusChannel(target).textContent,
    DEFAULT_FIELD_STRINGS.groupInstanceAdded("Guest", 2, 2),
  );

  // Now at max (2 of 2) — Add disables with a reason.
  assert.ok(add().disabled, "Add disabled at max instances");
  assert.equal(add().getAttribute("aria-disabled"), "true");
  assert.ok(add().getAttribute("title"), "title conveys the max reason");
});

test("repeating group: Remove splices the instance, focuses the previous card's tabIndex=-1 wrapper, announces", async () => {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = renderForm(target, {
    form: groupForm({ minInstances: 1, maxInstances: 4 }),
    formId: "f-test",
    client: localClient,
    initialData: { guests: [{ name: "Ada" }, { name: "Grace" }, { name: "Alan" }] },
  });
  await tick();
  const cards = () => [...target.querySelectorAll('[data-field="guests"] .fillo-group-instance')];
  const removeAt1 = cards()[1].querySelector(".fillo-group-remove");
  removeAt1.focus();
  dispatch(removeAt1, "click");
  await tick();

  assert.deepEqual(instance.data.guests, [{ name: "Ada" }, { name: "Alan" }]);
  const after = cards();
  assert.equal(after.length, 2);
  assert.equal(
    document.activeElement,
    after[0],
    "focus lands on the previous card's wrapper, not a sibling control",
  );
  assert.equal(after[0].tabIndex, -1);
  assert.equal(
    statusChannel(target).textContent,
    DEFAULT_FIELD_STRINGS.groupInstanceRemoved("Guest", 2),
  );
});

test("repeating group: removing the first instance falls back to the Add button (no previous card) — never <body>", async () => {
  const target = document.createElement("div");
  document.body.appendChild(target);
  renderForm(target, {
    form: groupForm({ minInstances: 1, maxInstances: 4 }),
    formId: "f-test",
    client: localClient,
    initialData: { guests: [{ name: "Ada" }, { name: "Grace" }] },
  });
  await tick();
  const removeAt0 = target.querySelector(
    '[data-field="guests"] .fillo-group-instance .fillo-group-remove',
  );
  removeAt0.focus();
  dispatch(removeAt0, "click");
  await tick();
  assert.equal(
    document.activeElement,
    target.querySelector('[data-field="guests"] .fillo-group-add'),
  );
});

test("repeating group: Remove is disabled at the minInstances floor", () => {
  const target = mount(groupForm({ minInstances: 1, maxInstances: 4 }), {
    initialData: { guests: [{ name: "Solo" }] },
  });
  const removeBtn = target.querySelector('[data-field="guests"] .fillo-group-remove');
  assert.ok(removeBtn.disabled);
  assert.equal(removeBtn.getAttribute("aria-disabled"), "true");
  assert.ok(removeBtn.getAttribute("title"));
});

test("repeating group: a min-0 group can remove its way down to zero cards", async () => {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = renderForm(target, {
    form: groupForm({ minInstances: 0, maxInstances: 3 }),
    formId: "f-test",
    client: localClient,
    initialData: { guests: [{ name: "Solo" }] },
  });
  await tick();
  const removeBtn = target.querySelector('[data-field="guests"] .fillo-group-remove');
  assert.equal(removeBtn.disabled, false, "floor is 0 — one instance can still be removed");
  dispatch(removeBtn, "click");
  await tick();
  assert.deepEqual(instance.data.guests, []);
  assert.equal(target.querySelectorAll('[data-field="guests"] .fillo-group-instance').length, 0);
});

test("repeating group: editing a child writes the whole padded array through the group's setValue (indices align with materialized padding)", async () => {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = renderForm(target, {
    form: groupForm({ minInstances: 2, maxInstances: 3 }),
    formId: "f-test",
    client: localClient,
  });
  await tick();
  assert.equal(
    instance.data.guests,
    undefined,
    "display padding never writes until the first real edit",
  );

  const secondNameInput = target.querySelector('[data-field="guests.1.name"] input');
  secondNameInput.value = "Grace";
  dispatch(secondNameInput, "input");
  dispatch(secondNameInput, "change");
  await tick();
  assert.deepEqual(
    instance.data.guests,
    [{}, { name: "Grace" }],
    "instance 0 materialized empty, instance 1 patched — indices align with the padded array",
  );

  const firstNameInput = target.querySelector('[data-field="guests.0.name"] input');
  firstNameInput.value = "Ada";
  dispatch(firstNameInput, "input");
  dispatch(firstNameInput, "change");
  await tick();
  assert.deepEqual(instance.data.guests, [{ name: "Ada" }, { name: "Grace" }]);
});

test("repeating group: per-instance visibleIf scopes to that instance's own siblings (visibleGroupChildren)", () => {
  const target = mount(
    {
      version: 1,
      title: "T",
      settings: {},
      pages: [
        {
          id: "p1",
          blocks: [
            {
              id: "attendees",
              kind: "repeating_group",
              label: "Attendees",
              itemLabel: "Attendee",
              minInstances: 2,
              maxInstances: 3,
              fields: [
                { id: "bringing_guest", kind: "checkbox", label: "Bringing a guest?" },
                {
                  id: "guest_name",
                  kind: "short_text",
                  label: "Guest name",
                  visibleIf: [{ fieldId: "bringing_guest", op: "eq", value: true }],
                },
              ],
            },
          ],
        },
      ],
    },
    { initialData: { attendees: [{ bringing_guest: false }, { bringing_guest: true }] } },
  );
  const cards = target.querySelectorAll('[data-field="attendees"] .fillo-group-instance');
  assert.equal(cards.length, 2);
  assert.equal(
    cards[0].querySelector('[data-field="attendees.0.guest_name"]'),
    null,
    "hidden in instance 0 — that instance's own sibling is unchecked",
  );
  assert.ok(
    cards[1].querySelector('[data-field="attendees.1.guest_name"]'),
    "visible in instance 1 — that instance's own sibling is checked",
  );
});

test("repeating group: compound error keys map to the right child input (aria-invalid/aria-describedby)", async () => {
  const target = mount(groupForm({ minInstances: 1, maxInstances: 3 }), {
    initialData: { guests: [{}] },
  });
  dispatch(target.querySelector("form"), "submit");
  await tick();

  const nameInput = target.querySelector('[data-field="guests.0.name"] input');
  assert.equal(nameInput.getAttribute("aria-invalid"), "true");
  const describedBy = (nameInput.getAttribute("aria-describedby") ?? "").split(" ");
  const errorId = describedBy.find((id) => id.endsWith("-error"));
  assert.ok(errorId, "the required child input is described by its own error paragraph");
  const errorEl = document.getElementById(errorId);
  assert.equal(errorEl.textContent, DEFAULT_FIELD_STRINGS.required);

  // The "meal" child isn't required — no compound error, no aria-invalid.
  const mealField = target.querySelector('[data-field="guests.0.meal"]');
  assert.equal(mealField.hasAttribute("data-invalid"), false);
});

test("repeating group: the group-level count error renders in the field's own shell (not a per-child slot)", async () => {
  const target = mount(groupForm({ minInstances: 2, maxInstances: 4 }));
  dispatch(target.querySelector("form"), "submit");
  await tick();
  const groupError = target.querySelector('[data-field="guests"] > .fillo-error');
  assert.ok(groupError, "group-level error renders as a direct child of the field shell");
  assert.match(groupError.textContent, /at least 2/i);
});

test("repeating group: addLabel/itemLabel overrides flow through to the Add button text and instance headings", () => {
  const target = mount(groupForm({ addLabel: "Add a plus-one", itemLabel: "Plus-one" }));
  const add = target.querySelector('[data-field="guests"] .fillo-group-add');
  assert.equal(add.textContent, "Add a plus-one");
  const title = target.querySelector('[data-field="guests"] .fillo-group-instance-title');
  assert.equal(title.textContent, "Plus-one 1 of 1");
});
