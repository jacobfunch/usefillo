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
const { FilloForm, FilloProvider } = await import("../dist/index.js");

/** The Rotato shape: the same field id twice, so the definition can't render. */
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

const published = {
  version: 1,
  title: "Published",
  settings: {},
  pages: [{ id: "p1", blocks: [{ id: "vote", kind: "short_text", label: "Published question" }] }],
};

function publishedForm(id) {
  return { id, slug: id, schema: published, theme: null, closed: false, accepting: true };
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
  await act(async () => new Promise((r) => setTimeout(r, 20)));
  return target;
}

async function inProduction(run) {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    await run(errors);
  } finally {
    console.error = originalError;
    process.env.NODE_ENV = prev;
  }
}

test("production shows the published version when the page's definition is invalid", async () => {
  await inProduction(async (errors) => {
    const reports = [];
    const fetched = [];
    const submitted = [];
    const definition = brokenDefinition("Feedback A");
    const client = fakeClient({
      reportInvalidDefinition: async (target, schema) => {
        reports.push({ target, schema });
        return null;
      },
      getForm: async (id) => {
        fetched.push(id);
        return publishedForm(id);
      },
      submit: async (formId) => {
        submitted.push(formId);
        return { ok: true, responseId: "r1" };
      },
    });
    const target = await mount(
      React.createElement(FilloForm, { form: definition, formId: "f-live-a", client }),
    );

    assert.match(target.textContent, /Published question/, "the published form renders");
    assert.doesNotMatch(
      target.textContent,
      /could not be rendered|invalid/i,
      "no error for visitors",
    );
    assert.deepEqual(fetched, ["f-live-a"]);
    assert.deepEqual(reports, [{ target: { formId: "f-live-a" }, schema: definition }]);
    assert.ok(
      errors.some((line) => line.includes("Duplicate block id: email")),
      "the console names the fault",
    );

    const input = target.querySelector("input[type=text], input:not([type])");
    assert.ok(input, "the published field is fillable");
    await act(async () => {
      target
        .querySelector("form")
        .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
    assert.deepEqual(submitted, ["f-live-a"], "answers go to the published form");
  });
});

test("a broken defineForm() finds its published form through the key, without syncing", async () => {
  await inProduction(async () => {
    let synced = 0;
    const reports = [];
    const client = fakeClient({
      syncForm: async () => {
        synced += 1;
        throw new Error("sync must not run for a broken definition");
      },
      reportInvalidDefinition: async (target) => {
        reports.push(target);
        return "f-live-b";
      },
      getForm: async (id) => publishedForm(id),
    });
    const codeForm = {
      id: "feedback-b",
      schema: brokenDefinition("Feedback B"),
      __filloCodeForm: true,
    };
    const target = await mount(React.createElement(FilloForm, { form: codeForm, client }));

    assert.match(target.textContent, /Published question/);
    assert.deepEqual(reports, [{ handle: "feedback-b" }]);
    assert.equal(synced, 0);
  });
});

test("with nothing published to show, visitors see nothing at all", async () => {
  await inProduction(async () => {
    const client = fakeClient({ reportInvalidDefinition: async () => null });
    const codeForm = {
      id: "feedback-c",
      schema: brokenDefinition("Feedback C"),
      __filloCodeForm: true,
    };
    const target = await mount(
      React.createElement(FilloForm, { form: codeForm, client, className: "flex" }),
    );

    const root = target.querySelector('[data-fillo="root"]');
    assert.equal(root.getAttribute("data-state"), "unavailable");
    assert.equal(root.hidden, true);
    assert.equal(root.className, "", "no class whose display rule could unhide it");
    assert.equal(target.textContent, "");
  });
});

test("a builder preview of a broken draft still says why, even in production", async () => {
  await inProduction(async () => {
    const target = await mount(
      React.createElement(FilloForm, { form: brokenDefinition("Draft"), skipValidation: true }),
    );
    const alert = target.querySelector('[role="alert"]');
    assert.ok(alert, "the person editing sees a message, not a blank card");
    assert.match(alert.textContent, /Duplicate block id: email/);
  });
});

test("development shows the reason instead of falling back", async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  try {
    let calls = 0;
    const client = fakeClient({
      reportInvalidDefinition: async () => {
        calls += 1;
        return "f-live-d";
      },
      getForm: async (id) => {
        calls += 1;
        return publishedForm(id);
      },
    });
    const target = await mount(
      React.createElement(FilloForm, {
        form: brokenDefinition("Feedback D"),
        formId: "f-live-d",
        client,
      }),
    );

    const alert = target.querySelector('[role="alert"]');
    assert.ok(alert);
    assert.match(alert.textContent, /Duplicate block id: email/);
    assert.equal(alert.getAttribute("data-error-code"), "invalid_form_definition");
    assert.equal(calls, 0, "nothing is fetched or reported while developing");
  } finally {
    process.env.NODE_ENV = prev;
  }
});

test("the headless provider renders nothing in production and reports once", async () => {
  await inProduction(async () => {
    const reports = [];
    const client = fakeClient({
      reportInvalidDefinition: async (target) => {
        reports.push(target);
        return null;
      },
    });
    const target = await mount(
      React.createElement(
        FilloProvider,
        { form: brokenDefinition("Feedback E"), formId: "f-live-e", client },
        React.createElement("p", null, "custom layout"),
      ),
    );

    assert.equal(target.textContent, "", "no custom layout and no error");
    assert.deepEqual(reports, [{ formId: "f-live-e" }]);
  });
});
