import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// Globals must exist before the renderer module loads (it defines a custom element).
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

const settle = () => new Promise((r) => setTimeout(r, 20));

/** The same field id twice, so the definition can't render. */
function brokenDefinition(title) {
  return {
    version: 1,
    title,
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [
          { id: "email", kind: "email", label: "Email address" },
          { id: "vote", kind: "short_text", label: "Was this helpful?" },
          { id: "email", kind: "email", label: "Email address" },
        ],
      },
    ],
  };
}

function publishedForm(id) {
  return {
    id,
    slug: id,
    schema: {
      version: 1,
      title: "Published",
      settings: {},
      pages: [
        { id: "p1", blocks: [{ id: "vote", kind: "short_text", label: "Published question" }] },
      ],
    },
    theme: null,
    closed: false,
    accepting: true,
  };
}

function mountTarget() {
  const target = document.createElement("div");
  document.body.appendChild(target);
  return target;
}

async function inProduction(run) {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args.join(" "));
  try {
    await run(errors);
  } finally {
    console.error = originalError;
    process.env.NODE_ENV = prev;
  }
}

test("production renders the published version when the page's definition is invalid", async () => {
  await inProduction(async (errors) => {
    const reports = [];
    const definition = brokenDefinition("DOM feedback A");
    const client = {
      baseUrl: "",
      reportInvalidDefinition: async (target, schema) => {
        reports.push({ target, schema });
        return null;
      },
      getForm: async (id) => publishedForm(id),
    };
    const target = mountTarget();
    const instance = renderForm(target, { form: definition, formId: "f-dom-a", client });
    await settle();

    assert.equal(instance.status, "idle");
    assert.match(target.textContent, /Published question/);
    assert.doesNotMatch(target.textContent, /could not be rendered|invalid/i);
    assert.deepEqual(reports, [{ target: { formId: "f-dom-a" }, schema: definition }]);
    assert.ok(errors.some((line) => line.includes("Duplicate block id: email")));
  });
});

test("a broken code form finds its published form through the key, without syncing", async () => {
  await inProduction(async () => {
    let synced = 0;
    const reports = [];
    const client = {
      key: "pk_dom_b",
      baseUrl: "",
      syncForm: async () => {
        synced += 1;
        throw new Error("sync must not run for a broken definition");
      },
      reportInvalidDefinition: async (target) => {
        reports.push(target);
        return "f-dom-b";
      },
      getForm: async (id) => publishedForm(id),
    };
    const target = mountTarget();
    renderForm(target, {
      form: {
        id: "dom-feedback-b",
        schema: brokenDefinition("DOM feedback B"),
        __filloCodeForm: true,
      },
      client,
    });
    await settle();

    assert.match(target.textContent, /Published question/);
    assert.deepEqual(reports, [{ handle: "dom-feedback-b" }]);
    assert.equal(synced, 0);
  });
});

test("with nothing published to show, visitors see nothing at all", async () => {
  await inProduction(async () => {
    const client = { key: "pk_dom_c", baseUrl: "", reportInvalidDefinition: async () => null };
    const target = mountTarget();
    renderForm(target, {
      form: {
        id: "dom-feedback-c",
        schema: brokenDefinition("DOM feedback C"),
        __filloCodeForm: true,
      },
      client,
      className: "flex",
    });
    await settle();

    const root = target.querySelector('[data-fillo="root"]');
    assert.equal(root.getAttribute("data-state"), "unavailable");
    assert.equal(root.hidden, true);
    assert.equal(root.className, "", "no class whose display rule could unhide it");
    assert.equal(target.textContent, "");
  });
});

test("development shows the reason instead of falling back", async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  try {
    let calls = 0;
    const client = {
      baseUrl: "",
      reportInvalidDefinition: async () => {
        calls += 1;
        return "f-dom-d";
      },
      getForm: async (id) => {
        calls += 1;
        return publishedForm(id);
      },
    };
    const target = mountTarget();
    renderForm(target, { form: brokenDefinition("DOM feedback D"), formId: "f-dom-d", client });
    await settle();

    const alert = target.querySelector('[role="alert"]');
    assert.ok(alert);
    assert.match(alert.textContent, /Duplicate block id: email/);
    assert.equal(alert.getAttribute("data-error-code"), "invalid_form_definition");
    assert.equal(calls, 0, "nothing is fetched or reported while developing");
  } finally {
    process.env.NODE_ENV = prev;
  }
});
