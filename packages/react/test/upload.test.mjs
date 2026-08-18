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
const { FilloForm } = await import("../dist/index.js");

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

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

function selectFile(target, file) {
  const input = target.querySelector('input[type="file"]');
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  return act(async () => {
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
}

function uploadForm(maxFiles = 1) {
  return {
    version: 1,
    title: "T",
    settings: {},
    pages: [{ id: "p1", blocks: [{ id: "files", kind: "file_upload", label: "Files", maxFiles }] }],
  };
}

function filloError(message) {
  const err = new Error(message);
  err.name = "FilloError";
  return err;
}

test("a render-only upload explains that transport is deliberately unavailable", async () => {
  const { target } = await mount(
    React.createElement(FilloForm, { form: uploadForm(1), renderOnly: true }),
  );

  const dropzone = target.querySelector(".fillo-dropzone");
  assert.equal(dropzone.getAttribute("aria-disabled"), "true");
  assert.match(dropzone.textContent, /Uploads are unavailable in this render-only preview/);
});

test("hosted forms show and enforce the active storage lane's lower file limit", async () => {
  let uploadCalls = 0;
  const form = uploadForm(1);
  form.pages[0].blocks[0].maxFileSizeMb = 25;
  const client = fakeClient({
    getForm: async () => ({
      id: "f-transit",
      slug: "transit",
      schema: form,
      theme: null,
      accepting: true,
      uploadsAvailable: true,
      uploadFileSizeLimitMb: 10,
    }),
    uploadFile: async () => {
      uploadCalls += 1;
      throw new Error("oversized file should be rejected locally");
    },
  });
  const { target } = await mount(React.createElement(FilloForm, { formId: "f-transit", client }));
  await flush();

  assert.match(target.textContent, /Up to 10 MB per file/);
  await selectFile(target, new File([new Uint8Array(11 * 1024 * 1024)], "large.pdf"));
  await flush();
  assert.equal(uploadCalls, 0, "oversized file is rejected before creating an upload session");
  assert.match(target.textContent, /Larger than 10 MB limit/);
});

test("inline hosted forms keep the server-owned file limit without a fetch", async () => {
  let uploadCalls = 0;
  const form = uploadForm(1);
  form.pages[0].blocks[0].maxFileSizeMb = 25;
  const client = fakeClient({
    uploadFile: async () => {
      uploadCalls += 1;
      throw new Error("oversized file should be rejected locally");
    },
  });
  const { target } = await mount(
    React.createElement(FilloForm, {
      form,
      formId: "f-inline-transit",
      client,
      uploadFileSizeLimitMb: 10,
    }),
  );

  assert.match(target.textContent, /Up to 10 MB per file/);
  await selectFile(target, new File([new Uint8Array(11 * 1024 * 1024)], "large.pdf"));
  await flush();
  assert.equal(uploadCalls, 0, "oversized file is rejected before creating an upload session");
  assert.match(target.textContent, /Larger than 10 MB limit/);
});

test("an in-flight upload keeps its cancel control in the header above the progress bar", async () => {
  const client = fakeClient({
    uploadFile: async () => new Promise(() => {}),
  });
  const { target } = await mount(
    React.createElement(FilloForm, { form: uploadForm(1), formId: "f1", client }),
  );

  await selectFile(target, new File(["a"], "a.txt"));
  await flush();

  const row = target.querySelector(".fillo-file");
  const progress = row.querySelector('.fillo-progress[role="progressbar"]');
  assert.equal(row.getAttribute("role"), null, "the list item keeps its native listitem role");
  assert.equal(progress.getAttribute("aria-label"), "Uploading a.txt");
  assert.equal(progress.getAttribute("aria-valuemin"), "0");
  assert.equal(progress.getAttribute("aria-valuemax"), "100");
  assert.equal(progress.getAttribute("aria-valuenow"), "0");
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
  const cancel = row.querySelector('button[aria-label="Cancel a.txt"]');
  assert.equal(progress.contains(cancel), false, "Cancel stays outside the progressbar subtree");
  const actionIcon = cancel.querySelector(".fillo-file-action-icon");
  assert.equal(actionIcon.getAttribute("width"), "16", "action icon is bounded without CSS");
  assert.equal(actionIcon.getAttribute("height"), "16", "action icon is bounded without CSS");
  assert.equal(cancel.textContent, "", "no raw × glyph is exposed as button content");
});

test("a valid upload start clears required validation before the file completes", async () => {
  const form = uploadForm(1);
  form.pages[0].blocks[0].required = true;
  let changes = 0;
  const client = fakeClient({ uploadFile: async () => new Promise(() => {}) });
  const { target } = await mount(
    React.createElement(FilloForm, {
      form,
      formId: "f-required-upload",
      client,
      onChange: () => {
        changes += 1;
      },
    }),
  );

  await act(async () => {
    target
      .querySelector("form")
      .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  assert.match(target.querySelector('[data-fillo="error"]').textContent, /Add a file/);

  await selectFile(target, new File(["a"], "a.txt"));
  await flush();
  assert.ok(target.querySelector('[role="progressbar"]'), "accepted correction is in progress");
  assert.equal(target.querySelector('[data-fillo="error"]'), null);
  assert.equal(target.querySelector('[data-fillo="error-summary"]'), null);
  assert.equal(changes, 0, "progress does not masquerade as a completed answer");
});

test("an oversized selection does not clear required validation", async () => {
  const form = uploadForm(1);
  form.pages[0].blocks[0].required = true;
  form.pages[0].blocks[0].maxFileSizeMb = 1;
  const { target } = await mount(
    React.createElement(FilloForm, {
      form,
      formId: "f-required-oversized",
      client: fakeClient(),
    }),
  );

  await act(async () => {
    target
      .querySelector("form")
      .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  await selectFile(target, new File([new Uint8Array(2 * 1024 * 1024)], "large.pdf"));
  await flush();
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
});

test("a failed upload keeps the dropzone available (maxFiles=1)", async () => {
  const client = fakeClient({
    uploadFile: async () => {
      throw filloError("Storage is down");
    },
  });
  const { target } = await mount(
    React.createElement(FilloForm, { form: uploadForm(1), formId: "f1", client }),
  );
  await selectFile(target, new File(["a"], "a.txt"));
  await flush();
  assert.ok(target.querySelector(".fillo-file--failed"), "failed row shown");
  assert.ok(
    target.querySelector('.fillo-dropzone[role="button"]'),
    "dropzone still present after a failure — a failed row must not consume the slot",
  );
  const row = target.querySelector(".fillo-file--failed");
  assert.deepEqual(
    [...row.children].map((child) => child.className),
    ["fillo-file-state fillo-file-state--failed", "fillo-file-content", "fillo-file-actions"],
  );
  assert.equal(row.querySelector(".fillo-file-error").getAttribute("role"), "alert");
  assert.ok(row.querySelector('button[aria-label="Retry a.txt"]'));
  assert.ok(row.querySelector('button[aria-label="Dismiss a.txt"]'));
});

test("a failed upload can be retried and completes", async () => {
  let attempts = 0;
  const client = fakeClient({
    uploadFile: async (_formId, file) => {
      attempts += 1;
      if (attempts === 1) throw filloError("blip");
      return { fileId: "ok", name: file.name, size: file.size, mime: "text/plain" };
    },
  });
  let latest = [];
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: uploadForm(1),
      formId: "f1",
      client,
      onChange: (d) => {
        latest = d.files ?? [];
      },
    }),
  );
  await selectFile(target, new File(["a"], "a.txt"));
  await flush();
  const retry = target.querySelector(".fillo-file-retry");
  assert.ok(retry, "retry control present on the failed row");
  await act(async () => {
    retry.click();
  });
  await flush();
  assert.equal(attempts, 2, "retry re-invoked uploadFile with the same file");
  assert.equal(latest.length, 1, "the retried upload completed into the value");
  assert.equal(latest[0].fileId, "ok");
  assert.equal(
    target.querySelector(".fillo-file--failed"),
    null,
    "no failed row after a successful retry",
  );
  const done = target.querySelector(".fillo-file--done");
  assert.equal(done.querySelector(".fillo-file-meta").textContent, "Uploaded · 1 B");
  assert.ok(done.querySelector(".fillo-file-state--done"));
  assert.ok(done.querySelector('button[aria-label="Remove a.txt"] .fillo-file-action-icon'));
});

test("strings override localizes upload failures and the required message", async () => {
  const client = fakeClient({
    uploadFile: async () => {
      throw filloError("");
    },
  });
  const strings = { uploadFailed: "Échec du téléversement", required: "Champ obligatoire" };
  const form = {
    version: 1,
    title: "T",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [
          { id: "files", kind: "file_upload", label: "Files", maxFiles: 1 },
          { id: "name", kind: "short_text", label: "Name", required: true },
        ],
      },
    ],
  };
  const { target } = await mount(
    React.createElement(FilloForm, { form, formId: "f1", client, strings }),
  );
  // Force the required error (empty required field) and confirm it's localized.
  await act(async () => {
    target
      .querySelector("form")
      .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  assert.match(
    target.querySelector('[data-field="name"] [data-fillo="error"]').textContent,
    /Champ obligatoire/,
  );
  // Force an upload failure with no server message → the localized fallback.
  await selectFile(target, new File(["a"], "a.txt"));
  await flush();
  assert.match(
    target.querySelector(".fillo-file--failed .fillo-file-error").textContent,
    /Échec du téléversement/,
  );
});

test("storage service failures use concise localized copy in a separate error row", async () => {
  const client = fakeClient({
    uploadFile: async () => {
      const error = filloError("Couldn't start the upload — file storage is unavailable");
      error.status = 502;
      throw error;
    },
  });
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: uploadForm(1),
      formId: "f1",
      client,
      strings: { uploadUnavailable: "Attachments are unavailable. Please try again." },
    }),
  );
  await selectFile(target, new File(["a"], "a.txt"));
  await flush();

  const failed = target.querySelector(".fillo-file--failed");
  assert.match(
    failed.querySelector(".fillo-file-error").textContent,
    /Attachments are unavailable/,
  );
  assert.doesNotMatch(failed.textContent, /file storage is unavailable/);
  assert.ok(failed.querySelector(".fillo-file-actions .fillo-file-retry"));
});

test("4xx upload diagnostics stay with onError and never render to respondents", async () => {
  const diagnostic = filloError("Box upload failed: 403 xoxb-secret");
  diagnostic.status = 403;
  const observed = [];
  const client = fakeClient({
    uploadFile: async () => {
      throw diagnostic;
    },
  });
  const { target } = await mount(
    React.createElement(FilloForm, {
      form: uploadForm(1),
      formId: "f1",
      client,
      onError: (error) => observed.push(error),
    }),
  );
  await selectFile(target, new File(["a"], "a.txt"));
  await flush();

  const rendered = target.querySelector(".fillo-file--failed .fillo-file-error").textContent;
  assert.match(rendered, /Upload failed/u);
  assert.doesNotMatch(rendered, /Box|403|xoxb-secret/u);
  assert.equal(observed.at(-1), diagnostic);
});

test("matrix rows keep native row semantics with the radiogroup on an inner element", async () => {
  const form = {
    version: 1,
    title: "T",
    settings: {},
    pages: [
      {
        id: "p1",
        blocks: [
          {
            id: "grid",
            kind: "matrix",
            label: "Grid",
            rows: [{ id: "r1", label: "Row 1" }],
            columns: [
              { id: "c1", label: "Col 1" },
              { id: "c2", label: "Col 2" },
            ],
          },
        ],
      },
    ],
  };
  const { target } = await mount(
    React.createElement(FilloForm, { form, formId: "f-test", client: fakeClient() }),
  );
  const bodyRow = target.querySelector("table.fillo-matrix tbody tr");
  assert.ok(bodyRow, "matrix row rendered");
  assert.equal(bodyRow.getAttribute("role"), null, "the <tr> keeps its native row role");
  const group = bodyRow.querySelector('[role="radiogroup"]');
  assert.ok(group, "radiogroup moved onto an inner element");
  assert.equal(group.tagName.toLowerCase(), "div");
  // The radiogroup must actually own its radios (else it's an empty group).
  const owned = (group.getAttribute("aria-owns") ?? "").split(/\s+/).filter(Boolean);
  const radioIds = [...bodyRow.querySelectorAll('input[type="radio"]')].map((r) => r.id);
  assert.equal(radioIds.length, 2);
  assert.deepEqual(
    [...owned].sort(),
    [...radioIds].sort(),
    "radiogroup owns exactly the row's radios",
  );
});
