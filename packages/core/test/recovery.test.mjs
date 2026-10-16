import assert from "node:assert/strict";
import test from "node:test";
import { createFormController, FilloError, localDateString } from "../dist/index.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const form = {
  version: 1,
  title: "Recovery",
  settings: { saveProgress: true },
  pages: [{ id: "p1", blocks: [{ id: "name", kind: "short_text", label: "Name" }] }],
};
function client(overrides = {}) {
  return {
    startSession: async () => null,
    reportProgress() {},
    createDraft: async () => ({ id: "draft", token: "token" }),
    getDraft: async () => ({ data: { name: "Saved" } }),
    saveDraft: async () => {},
    deleteDraft: async () => {},
    submit: async () => ({ ok: true, responseId: "response" }),
    ...overrides,
  };
}
const groupForm = {
  ...form,
  settings: {},
  pages: [
    {
      id: "p1",
      blocks: [
        {
          id: "guests",
          kind: "repeating_group",
          label: "Guests",
          minInstances: 1,
          maxInstances: 3,
          fields: [{ id: "name", kind: "short_text", label: "Name", required: true }],
        },
      ],
    },
    { id: "p2", blocks: [{ id: "other", kind: "short_text", label: "Other" }] },
  ],
};

test("Next validates group children, and local submit returns to their page", async () => {
  const ctl = createFormController({ form: groupForm, initialData: { guests: [{}] } });
  ctl.next();
  assert.equal(ctl.getState().pageIndex, 0);
  assert.ok(ctl.getState().errors["guests.0.name"]);
  ctl.setValue("guests", [{ name: "Ada" }]);
  assert.deepEqual(ctl.getState().errors, {});
  ctl.next();
  assert.equal(ctl.getState().pageIndex, 1);
  ctl.setValue("guests", [{}]);
  await ctl.submit();
  assert.equal(ctl.getState().pageIndex, 0);
  assert.ok(ctl.getState().errors["guests.0.name"]);
  ctl.destroy();
});

test("server child validation returns to the group's page", async () => {
  const ctl = createFormController({
    form: groupForm,
    formId: "server-group",
    initialData: { guests: [{ name: "Ada" }] },
    client: client({
      submit: async () => ({ ok: false, errors: { "guests.0.name": "Correct this name" } }),
    }),
  });
  ctl.next();
  await ctl.submit();
  assert.equal(ctl.getState().pageIndex, 0);
  assert.equal(ctl.getState().errors["guests.0.name"], "Correct this name");
  ctl.destroy();
});

for (const action of ["reset", "submit"]) {
  test(`pending draft creation cannot resurrect after ${action}`, async () => {
    const pending = deferred();
    const deleted = [];
    const c = client({
      createDraft: () => pending.promise,
      deleteDraft: async (...args) => deleted.push(args),
    });
    const fid = `pending-create-${action}`;
    const ctl = createFormController({ form, formId: fid, client: c });
    await settle();
    ctl.setValue("name", "Old");
    ctl.flushDraft();
    await settle();
    if (action === "reset") ctl.resetDraft();
    if (action === "submit") await ctl.submit();
    pending.resolve({ id: `late-${action}`, token: "late-token" });
    await settle();
    assert.deepEqual(deleted, [[`late-${action}`, "late-token"]]);
    const restored = [];
    const next = createFormController({
      form,
      formId: fid,
      client: client({
        getDraft: async (...args) => {
          restored.push(args);
          return { data: { name: "Old" } };
        },
      }),
    });
    await settle();
    assert.deepEqual(restored, []);
    assert.equal(next.getState().data.name, undefined);
    ctl.destroy();
    next.destroy();
  });
}

test("a stale save failure cannot recreate a draft after reset", async () => {
  const pending = deferred();
  let creates = 0;
  const c = client({
    createDraft: async () => ({ id: `saved-${++creates}`, token: "token" }),
    saveDraft: () => pending.promise,
  });
  const ctl = createFormController({ form, formId: "pending-save-reset", client: c });
  await settle();
  ctl.setValue("name", "Old");
  ctl.flushDraft();
  await settle();
  ctl.setValue("name", "Changed");
  ctl.flushDraft();
  await settle();
  ctl.resetDraft();
  pending.reject(new FilloError("Gone", 404));
  await settle();
  assert.equal(creates, 1);
  ctl.setValue("name", "New");
  ctl.flushDraft();
  await settle();
  assert.equal(creates, 2, "a new fill can create its own draft");
  ctl.destroy();
});

test("late restore cannot overwrite a reset fill", async () => {
  const fid = "pending-restore-reset";
  const seed = createFormController({ form, formId: fid, client: client() });
  await settle();
  seed.setValue("name", "Saved");
  seed.flushDraft();
  await settle();
  seed.destroy();
  const pending = deferred();
  const ctl = createFormController({
    form,
    formId: fid,
    client: client({ getDraft: () => pending.promise }),
  });
  await settle();
  ctl.resetDraft();
  pending.resolve({ data: { name: "Old" } });
  await settle();
  assert.equal(ctl.getState().data.name, undefined);
  assert.equal(ctl.getState().resumedDraft, false);
  ctl.destroy();
});

test("malformed resume encoding reports failure and restores remembered progress", async () => {
  const fid = "malformed-resume";
  const seed = createFormController({ form, formId: fid, client: client() });
  await settle();
  seed.setValue("name", "Saved");
  seed.flushDraft();
  await settle();
  seed.destroy();
  globalThis.location = { hash: "#fillo-draft=%", search: "", pathname: "/" };
  try {
    const ctl = createFormController({ form, formId: fid, client: client() });
    await settle();
    assert.equal(ctl.getState().resumeLinkFailed, true);
    assert.equal(ctl.getState().data.name, "Saved");
    assert.equal(ctl.getState().resumedDraft, true);
    ctl.destroy();
  } finally {
    delete globalThis.location;
  }
});

test("failed storage writes/read/removal retain current draft state in memory", async () => {
  const disk = new Map();
  let failWrite = false,
    failRead = false;
  globalThis.localStorage = {
    getItem: (key) => {
      if (failRead) throw new Error("blocked");
      return disk.get(key) ?? null;
    },
    setItem: (key, value) => {
      if (failWrite) throw new Error("quota");
      disk.set(key, value);
    },
    removeItem: (key) => {
      if (failWrite) throw new Error("quota");
      disk.delete(key);
    },
  };
  try {
    const fid = "quota-ref";
    const c = client();
    const seed = createFormController({ form, formId: fid, client: c });
    await settle();
    seed.setValue("name", "Saved");
    seed.flushDraft();
    await settle();
    seed.destroy();
    failWrite = true;
    const reset = createFormController({ form, formId: fid, client: c });
    await settle();
    reset.resetDraft();
    reset.destroy();
    const reads = [];
    const next = createFormController({
      form,
      formId: fid,
      client: client({
        createDraft: async () => ({ id: "replacement", token: "replacement-token" }),
        getDraft: async (...args) => {
          reads.push(args);
          return { data: {} };
        },
      }),
    });
    await settle();
    assert.deepEqual(reads, [], "failed removal shadows stale disk ref");
    next.setValue("name", "New");
    next.flushDraft();
    await settle();
    next.destroy();
    failRead = true;
    const resumed = createFormController({
      form,
      formId: fid,
      client: client({
        getDraft: async (...args) => {
          reads.push(args);
          return { data: { name: "New" } };
        },
      }),
    });
    await settle();
    assert.deepEqual(
      reads,
      [["replacement", "replacement-token"]],
      "failed write shadows the old disk ref",
    );
    assert.equal(resumed.getState().resumedDraft, true);
    resumed.destroy();
  } finally {
    delete globalThis.localStorage;
  }
});

test("quota storage still gates repeated browser submissions", async () => {
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota");
    },
    removeItem() {},
  };
  try {
    const limited = { ...form, settings: { responseLimit: { by: "browser" } } };
    const ctl = createFormController({ form: limited, formId: "quota-browser", client: client() });
    await settle();
    await ctl.submit();
    assert.equal(ctl.getState().status, "submitted");
    ctl.destroy();
    const revisit = createFormController({
      form: limited,
      formId: "quota-browser",
      client: client(),
    });
    await settle();
    assert.equal(revisit.getState().status, "submitted");
    revisit.destroy();
  } finally {
    delete globalThis.localStorage;
  }
});

for (const accepted of [true, false]) {
  test(`draft created during an in-flight submit is ${accepted ? "removed on success" : "retained on failure"}`, async () => {
    const pendingCreate = deferred(),
      pendingSubmit = deferred(),
      deleted = [],
      reads = [];
    const fid = `create-during-submit-${accepted}`;
    const c = client({
      createDraft: () => pendingCreate.promise,
      submit: () => pendingSubmit.promise,
      deleteDraft: async (...args) => deleted.push(args),
    });
    const ctl = createFormController({ form, formId: fid, client: c });
    await settle();
    ctl.setValue("name", "Saved");
    ctl.flushDraft();
    await settle();
    const submitting = ctl.submit();
    pendingCreate.resolve({ id: "during", token: "token" });
    await settle();
    pendingSubmit.resolve({
      ok: accepted,
      errors: accepted ? undefined : { name: "Review this" },
      responseId: accepted ? "response" : undefined,
    });
    await submitting;
    await settle();
    ctl.destroy();
    assert.deepEqual(deleted, accepted ? [["during", "token"]] : []);
    const next = createFormController({
      form,
      formId: fid,
      client: client({
        getDraft: async (...args) => {
          reads.push(args);
          return { data: { name: "Saved" } };
        },
      }),
    });
    await settle();
    assert.equal(reads.length, accepted ? 0 : 1);
    next.destroy();
  });
}

for (const action of ["reset", "destroy"]) {
  test(`late existing affinity draft is ${action === "reset" ? "deleted after reset" : "preserved after unmount"}`, async () => {
    const pending = deferred(),
      deleted = [];
    const ctl = createFormController({
      form,
      formId: `late-affinity-${action}`,
      respondent: { id: "user", hash: "a".repeat(64) },
      client: client({
        createDraft: () => pending.promise,
        deleteDraft: async (...args) => deleted.push(args),
      }),
    });
    await settle();
    if (action === "reset") ctl.resetDraft();
    else ctl.destroy();
    pending.resolve({ id: "existing", token: "token", existing: true });
    await settle();
    assert.deepEqual(deleted, action === "reset" ? [["existing", "token"]] : []);
    ctl.destroy();
  });
}

test("a context switch fences old-form drafts without blocking a fresh save", async () => {
  const pending = deferred(),
    deleted = [],
    created = [];
  const old = client({
    createDraft: () => pending.promise,
    deleteDraft: async (...args) => deleted.push(args),
  });
  const fresh = client({
    createDraft: async (fid) => {
      created.push(fid);
      return { id: "fresh", token: "token" };
    },
  });
  const ctl = createFormController({ form, formId: "old-form", client: old });
  await settle();
  ctl.setValue("name", "Old");
  ctl.flushDraft();
  await settle();
  ctl.setContext({ formId: "fresh-form", client: fresh });
  ctl.setValue("name", "New");
  ctl.flushDraft();
  pending.resolve({ id: "old", token: "old-token" });
  await settle();
  assert.deepEqual(deleted, []);
  assert.deepEqual(created, ["fresh-form"]);
  const restored = [];
  const oldMount = createFormController({
    form,
    formId: "old-form",
    client: client({
      getDraft: async (...args) => {
        restored.push(args);
        return { data: { name: "Old" } };
      },
    }),
  });
  await settle();
  assert.deepEqual(restored, [["old", "old-token"]]);
  assert.equal(oldMount.getState().data.name, "Old");
  oldMount.destroy();
  ctl.destroy();
});

test("reset starts a fresh save without waiting for an obsolete request", async () => {
  const pending = deferred(),
    deleted = [];
  let creates = 0;
  const ctl = createFormController({
    form,
    formId: "reset-hung-save",
    client: client({
      createDraft: () =>
        ++creates === 1 ? pending.promise : Promise.resolve({ id: "fresh", token: "token" }),
      deleteDraft: async (...args) => deleted.push(args),
    }),
  });
  await settle();
  ctl.setValue("name", "Old");
  ctl.flushDraft();
  await settle();
  ctl.resetDraft();
  ctl.setValue("name", "New");
  ctl.flushDraft();
  await settle();
  assert.equal(creates, 2);
  pending.resolve({ id: "old", token: "token" });
  await settle();
  assert.deepEqual(deleted, [["old", "token"]]);
  assert.equal(ctl.getState().data.name, "New");
  ctl.destroy();
});

test("binding a context before boot still applies URL prefill", async () => {
  globalThis.location = { search: "?name=Ada", hash: "", pathname: "/" };
  try {
    const ctl = createFormController({ form });
    ctl.setContext({ formId: "early-bound", client: client() });
    await settle();
    assert.equal(ctl.getState().data.name, "Ada");
    ctl.destroy();
  } finally {
    delete globalThis.location;
  }
});

test("successful storage writes continue to respect external removal", async () => {
  const disk = new Map();
  globalThis.localStorage = {
    getItem: (key) => disk.get(key) ?? null,
    setItem: (key, value) => disk.set(key, value),
    removeItem: (key) => disk.delete(key),
  };
  try {
    const fid = "healthy-storage-removal",
      reads = [];
    const seed = createFormController({ form, formId: fid, client: client() });
    await settle();
    seed.setValue("name", "Saved");
    seed.flushDraft();
    await settle();
    seed.destroy();
    disk.clear();
    const next = createFormController({
      form,
      formId: fid,
      client: client({
        getDraft: async (...args) => {
          reads.push(args);
          return { data: {} };
        },
      }),
    });
    await settle();
    assert.deepEqual(reads, []);
    next.destroy();
  } finally {
    delete globalThis.localStorage;
  }
});

test("a server error on a hidden group child shows review guidance instead of an empty error page", async () => {
  const conditional = structuredClone(groupForm);
  conditional.pages[0].blocks[0].fields = [
    { id: "kind", kind: "short_text", label: "Kind" },
    {
      id: "name",
      kind: "short_text",
      label: "Name",
      visibleIf: [{ fieldId: "kind", op: "eq", value: "show" }],
    },
  ];
  const ctl = createFormController({
    form: conditional,
    formId: "hidden-group-error",
    initialData: { guests: [{ kind: "hide" }] },
    client: client({ submit: async () => ({ ok: false, errors: { "guests.0.name": "Review" } }) }),
  });
  ctl.next();
  await ctl.submit();
  assert.equal(ctl.getState().pageIndex, 1);
  assert.ok(ctl.getState().submitError);
  ctl.destroy();
});

test("pending autosave survives destroy and restores on the next mount", async () => {
  const pending = deferred(),
    deleted = [],
    restored = [];
  const c = client({
    createDraft: () => pending.promise,
    deleteDraft: async (...args) => deleted.push(args),
    getDraft: async (...args) => {
      restored.push(args);
      return { data: { name: "Saved before leaving" } };
    },
  });
  const ctl = createFormController({ form, formId: "destroy-preserve-autosave", client: c });
  await settle();
  ctl.setValue("name", "Saved before leaving");
  ctl.flushDraft();
  await settle();
  ctl.destroy();
  pending.resolve({ id: "saved-on-leave", token: "token" });
  await settle();
  assert.deepEqual(deleted, []);
  const next = createFormController({ form, formId: "destroy-preserve-autosave", client: c });
  await settle();
  assert.deepEqual(restored, [["saved-on-leave", "token"]]);
  assert.equal(next.getState().data.name, "Saved before leaving");
  next.destroy();
});

test("a late unmounted create cannot replace a newer controller's pointer", async () => {
  const pending = deferred(),
    deleted = [],
    restored = [];
  const fid = "unmounted-older-pointer";
  const old = createFormController({
    form,
    formId: fid,
    client: client({
      createDraft: () => pending.promise,
      deleteDraft: async (...args) => deleted.push(args),
    }),
  });
  await settle();
  old.setValue("name", "Old");
  old.flushDraft();
  await settle();
  old.destroy();
  const fresh = createFormController({
    form,
    formId: fid,
    client: client({ createDraft: async () => ({ id: "newer", token: "newer-token" }) }),
  });
  await settle();
  fresh.setValue("name", "New");
  fresh.flushDraft();
  await settle();
  fresh.destroy();
  pending.resolve({ id: "older", token: "older-token" });
  await settle();
  assert.deepEqual(deleted, [], "unmount never discards saved server progress");
  const next = createFormController({
    form,
    formId: fid,
    client: client({
      getDraft: async (...args) => {
        restored.push(args);
        return { data: { name: "New" } };
      },
    }),
  });
  await settle();
  assert.deepEqual(restored, [["newer", "newer-token"]]);
  next.destroy();
});

for (const action of ["reset", "submit"]) {
  test(`a different controller's ${action} prevents an unmounted create from becoming resumable`, async () => {
    const pending = deferred(),
      deleted = [],
      restored = [];
    const fid = `unmounted-discard-${action}`;
    const c = client({
      createDraft: () => pending.promise,
      deleteDraft: async (...args) => deleted.push(args),
    });
    const old = createFormController({ form, formId: fid, client: c });
    await settle();
    old.setValue("name", "Old");
    old.flushDraft();
    await settle();
    old.destroy();
    const current = createFormController({ form, formId: fid, client: client() });
    await settle();
    if (action === "reset") current.resetDraft();
    else await current.submit();
    current.destroy();
    pending.resolve({ id: "discarded", token: "token" });
    await settle();
    assert.deepEqual(deleted, [["discarded", "token"]]);
    const next = createFormController({
      form,
      formId: fid,
      client: client({
        getDraft: async (...args) => {
          restored.push(args);
          return { data: {} };
        },
      }),
    });
    await settle();
    assert.deepEqual(restored, []);
    next.destroy();
  });
}

test("late identity binding keeps an already scheduled debounce save", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const saved = [];
  const c = client({
    createDraft: async (_fid, body) => {
      saved.push(body);
      return { id: "identified-draft", token: "token" };
    },
  });
  const ctl = createFormController({ form, formId: "identify-debounce", client: c });
  await settle();
  ctl.setValue("name", "Typed before identify");
  ctl.setContext({ respondent: { id: "person" } });
  t.mock.timers.tick(1500);
  await settle();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].data.name, "Typed before identify");
  ctl.destroy();
});

test("old-person affinity callbacks do not install a pointer after identity changes", async () => {
  const oldRequest = deferred(),
    newRequest = deferred(),
    deleted = [],
    restored = [];
  const c = client({
    createDraft: (_fid, body) =>
      body.respondent.id === "old-person" ? oldRequest.promise : newRequest.promise,
    deleteDraft: async (...args) => deleted.push(args),
    getDraft: async (...args) => {
      restored.push(args);
      return { data: { name: "New person's saved fill" } };
    },
  });
  const ctl = createFormController({
    form,
    formId: "identity-pending-pointer",
    client: c,
    respondent: { id: "old-person", hash: "a".repeat(64) },
  });
  await settle();
  ctl.setContext({ respondent: { id: "new-person", hash: "b".repeat(64) } });
  oldRequest.resolve({ id: "old-person-draft", token: "old-token", existing: true });
  await settle();
  assert.deepEqual(restored, []);
  assert.equal(ctl.getState().data.name, undefined);
  newRequest.resolve({ id: "new-person-draft", token: "new-token", existing: true });
  await settle();
  assert.deepEqual(restored, [["new-person-draft", "new-token"]]);
  assert.equal(ctl.getState().data.name, "New person's saved fill");
  assert.deepEqual(
    deleted,
    [],
    "identity changes do not discard the previous person's server draft",
  );
  ctl.destroy();
});

test("same-id affinity rotations verify token freshness before updating the pointer", async () => {
  const requests = [deferred(), deferred()],
    restored = [],
    deleted = [];
  let creates = 0,
    validToken = "first-token";
  const c = client({
    createDraft: () => requests[creates++].promise,
    getDraft: async (id, token) => {
      restored.push([id, token]);
      if (token !== validToken) throw new FilloError("Foreign token", 403);
      return { data: { name: "Existing saved fill" } };
    },
    deleteDraft: async (...args) => deleted.push(args),
  });
  const options = {
    form,
    formId: "rotating-affinity",
    client: c,
    respondent: { id: "same-person", hash: "a".repeat(64) },
  };
  const first = createFormController(options),
    second = createFormController(options);
  await settle();
  requests[0].resolve({ id: "same-draft", token: "first-token", existing: true });
  await settle();
  validToken = "latest-token";
  requests[1].resolve({ id: "same-draft", token: "latest-token", existing: true });
  await settle();
  assert.equal(second.getState().data.name, "Existing saved fill");
  first.destroy();
  second.destroy();
  restored.length = 0;
  const next = createFormController(options);
  await settle();
  assert.deepEqual(restored, [["same-draft", "latest-token"]]);
  assert.equal(next.getState().data.name, "Existing saved fill");
  assert.deepEqual(deleted, []);
  next.destroy();
});

test("an older same-id affinity response cannot replace a verified newer token", async () => {
  const requests = [deferred(), deferred()],
    restored = [];
  let creates = 0;
  const c = client({
    createDraft: () => requests[creates++].promise,
    getDraft: async (id, token) => {
      restored.push([id, token]);
      if (token !== "latest-token") throw new FilloError("Foreign token", 403);
      return { data: { name: "Saved" } };
    },
  });
  const options = {
    form,
    formId: "out-of-order-affinity",
    client: c,
    respondent: { id: "same-person", hash: "a".repeat(64) },
  };
  const first = createFormController(options),
    second = createFormController(options);
  await settle();
  requests[1].resolve({ id: "same-draft", token: "latest-token", existing: true });
  await settle();
  requests[0].resolve({ id: "same-draft", token: "old-token", existing: true });
  await settle();
  first.destroy();
  second.destroy();
  restored.length = 0;
  const next = createFormController(options);
  await settle();
  assert.deepEqual(restored, [["same-draft", "latest-token"]]);
  next.destroy();
});

test("an expired remembered bearer retries verified affinity and restores saved answers", async () => {
  const fid = "expired-bearer-affinity",
    restored = [];
  const seed = createFormController({
    form,
    formId: fid,
    client: client({ createDraft: async () => ({ id: "existing", token: "old-token" }) }),
  });
  await settle();
  seed.setValue("name", "Saved");
  seed.flushDraft();
  await settle();
  seed.destroy();
  const c = client({
    createDraft: async () => ({ id: "existing", token: "new-token", existing: true }),
    getDraft: async (id, token) => {
      restored.push([id, token]);
      if (token === "old-token") throw new FilloError("Rotated token", 403);
      return { data: { name: "Saved" } };
    },
  });
  const ctl = createFormController({
    form,
    formId: fid,
    client: c,
    respondent: { id: "same-person", hash: "a".repeat(64) },
  });
  await settle();
  assert.deepEqual(restored, [
    ["existing", "old-token"],
    ["existing", "new-token"],
  ]);
  assert.equal(ctl.getState().data.name, "Saved");
  ctl.destroy();
});

test("reset during same-id token verification does not retain the rotated bearer", async () => {
  const requests = [deferred(), deferred()],
    verification = deferred(),
    deleted = [];
  let creates = 0;
  const c = client({
    createDraft: () => requests[creates++].promise,
    getDraft: async (_id, token) =>
      token === "new-token" ? verification.promise : { data: { name: "Saved" } },
    deleteDraft: async (_id, token) => {
      deleted.push(token);
      if (token === "first-token") throw new FilloError("Rotated", 403);
    },
  });
  const options = {
    form,
    formId: "reset-token-verification",
    client: c,
    respondent: { id: "same-person", hash: "a".repeat(64) },
  };
  const first = createFormController(options),
    second = createFormController(options);
  await settle();
  requests[0].resolve({ id: "same-draft", token: "first-token", existing: true });
  await settle();
  requests[1].resolve({ id: "same-draft", token: "new-token", existing: true });
  await settle();
  second.resetDraft();
  verification.resolve({ data: { name: "Discarded" } });
  await settle();
  assert.deepEqual(deleted, ["first-token", "new-token"]);
  assert.equal(second.getState().data.name, undefined);
  first.destroy();
  second.destroy();
  const restored = [];
  const next = createFormController({
    form,
    formId: options.formId,
    client: client({
      getDraft: async (...args) => {
        restored.push(args);
        return { data: {} };
      },
    }),
  });
  await settle();
  assert.deepEqual(restored, []);
  next.destroy();
});

for (const departure of ["destroy", "context"]) {
  for (const existing of [false, true]) {
    test(`queued ${existing ? "save" : "create"} survives immediate ${departure}`, async () => {
      const fid = `queued-${departure}-${existing}`,
        writes = [],
        restored = [];
      const c = client({
        createDraft: async (_fid, payload) => {
          writes.push(payload.data.name);
          return { id: fid, token: "token" };
        },
        saveDraft: async (_id, _token, payload) => {
          writes.push(payload.data.name);
        },
        getDraft: async (...args) => {
          restored.push(args);
          return { data: { name: writes.at(-1) } };
        },
      });
      const ctl = createFormController({ form, formId: fid, client: c });
      await settle();
      if (existing) {
        ctl.setValue("name", "Earlier");
        ctl.flushDraft();
        await settle();
      }
      ctl.setValue("name", "Last answer");
      ctl.flushDraft();
      if (departure === "destroy") ctl.destroy();
      else {
        ctl.setContext({ formId: "other-" + fid });
        ctl.setValue("name", "Other answer");
      }
      await settle();
      assert.equal(writes.at(-1), "Last answer");
      ctl.destroy();
      const next = createFormController({ form, formId: fid, client: c });
      await settle();
      assert.equal(next.getState().data.name, "Last answer");
      assert.deepEqual(restored.at(-1), [fid, "token"]);
      next.destroy();
    });
  }
}

for (const outcome of ["reset", "accepted", "rejected", "transport"]) {
  test(`queued save is ${outcome === "reset" || outcome === "accepted" ? "discarded" : "retained"} after ${outcome}`, async () => {
    const writes = [],
      deleted = [],
      fid = "queued-submit-" + outcome;
    const c = client({
      createDraft: async (_fid, payload) => {
        writes.push(payload.data.name);
        return { id: fid, token: "token" };
      },
      deleteDraft: async (...args) => deleted.push(args),
      submit: async () => {
        if (outcome === "transport") throw new Error("Offline");
        return { ok: outcome !== "rejected", errors: { name: "Review" } };
      },
    });
    const ctl = createFormController({ form, formId: fid, client: c });
    await settle();
    ctl.setValue("name", "Unsaved answer");
    ctl.flushDraft();
    if (outcome === "reset") ctl.resetDraft();
    else if (outcome === "transport") await assert.rejects(ctl.submit(), /Offline/);
    else await ctl.submit();
    await settle();
    if (outcome === "reset") assert.deepEqual(writes, []);
    else assert.deepEqual(writes, ["Unsaved answer"]);
    assert.equal(deleted.length, outcome === "accepted" ? 1 : 0);
    const gets = [];
    const next = createFormController({
      form,
      formId: fid,
      client: client({
        getDraft: async (...args) => {
          gets.push(args);
          return { data: { name: "Unsaved answer" } };
        },
      }),
    });
    await settle();
    assert.equal(gets.length, outcome === "rejected" || outcome === "transport" ? 1 : 0);
    ctl.destroy();
    next.destroy();
  });
}

test("another controller's reset cancels departed queued writes before I/O", async () => {
  const writes = [],
    fid = "queued-cross-reset";
  const ctl = createFormController({
    form,
    formId: fid,
    client: client({
      createDraft: async () => {
        writes.push(true);
        return { id: fid, token: "token" };
      },
    }),
  });
  await settle();
  ctl.setValue("name", "Discarded");
  ctl.flushDraft();
  ctl.destroy();
  const other = createFormController({ form, formId: fid, client: client() });
  other.resetDraft();
  await settle();
  assert.deepEqual(writes, []);
  other.destroy();
});

for (const legacy of [false, true]) {
  test(`known-person switch isolates ${legacy ? "legacy" : "identified"} draft`, async () => {
    const fid = "identity-switch-" + legacy,
      calls = [];
    const c = client({
      createDraft: async (_fid, payload) => {
        const id = payload.respondent?.id ?? "anonymous";
        calls.push(["create", id]);
        return { id: "draft-" + id, token: "token" };
      },
      getDraft: async (id) => {
        calls.push(["get", id]);
        return { data: { name: "Alice answer" } };
      },
      saveDraft: async (id, _token, payload) => calls.push(["save", id, payload.data.name]),
    });
    if (legacy) {
      const seed = createFormController({ form, formId: fid, client: c });
      await settle();
      seed.setValue("name", "Alice answer");
      seed.flushDraft();
      await settle();
      seed.destroy();
    }
    const ctl = createFormController({
      form,
      formId: fid,
      client: c,
      respondent: { id: "Alice", hash: "a".repeat(64) },
    });
    await settle();
    ctl.setValue("name", "Alice last");
    ctl.flushDraft();
    ctl.setContext({ respondent: { id: "Bob", hash: "b".repeat(64) } });
    assert.equal(ctl.getState().data.name, undefined);
    await settle();
    ctl.setValue("name", "Bob answer");
    ctl.flushDraft();
    await settle();
    assert.ok(calls.some((call) => call[0] === "create" && call[1] === "Bob"));
    assert.deepEqual(
      calls.filter((call) => call[0] === "save" && call[2] === "Bob answer"),
      [["save", "draft-Bob", "Bob answer"]],
    );
    ctl.destroy();
  });
}

for (const outcome of ["accepted", "rejected", "transport", "resolver"]) {
  test(`departed ${outcome} submit cannot mutate or discard the new target`, async () => {
    const pending = deferred(),
      deleted = [],
      callbacks = [],
      fid = "old-submit-" + outcome,
      nextId = "new-submit-" + outcome;
    const c = client({
      createDraft: async (id) => ({ id: "draft-" + id, token: "token" }),
      deleteDraft: async (...args) => deleted.push(args),
      submit: () => pending.promise,
    });
    const seed = createFormController({ form, formId: nextId, client: c });
    await settle();
    seed.setValue("name", "New progress");
    seed.flushDraft();
    await settle();
    seed.destroy();
    const ctl = createFormController({
      form,
      formId: fid,
      client: c,
      onSubmitted: (...args) => callbacks.push(args),
      ...(outcome === "resolver" ? { resolveFormId: () => pending.promise } : {}),
    });
    await settle();
    ctl.setValue("name", "Old answer");
    const submission = ctl.submit();
    ctl.setContext({ formId: nextId });
    assert.equal(ctl.getState().status, "idle");
    if (outcome === "transport") {
      pending.reject(new Error("Offline"));
      await assert.rejects(submission, /Offline/);
    } else {
      pending.resolve(
        outcome === "resolver"
          ? fid
          : { ok: outcome === "accepted", errors: { name: "Old error" } },
      );
      await submission;
    }
    await settle();
    assert.equal(ctl.getState().status, "idle");
    assert.deepEqual(ctl.getState().errors, {});
    assert.deepEqual(callbacks, []);
    assert.deepEqual(deleted, []);
    ctl.destroy();
    const next = createFormController({ form, formId: nextId, client: c });
    await settle();
    assert.equal(next.getState().data.name, "Saved");
    next.destroy();
  });
}

test("accepted departed submit preserves another controller's replacement pointer", async () => {
  const pending = deferred(),
    fid = "old-submit-new-pointer",
    reads = [];
  const old = createFormController({
    form,
    formId: fid,
    client: client({ submit: () => pending.promise }),
  });
  await settle();
  old.setValue("name", "Old");
  const submitting = old.submit();
  old.setContext({ formId: "elsewhere" });
  const newer = createFormController({
    form,
    formId: fid,
    client: client({ createDraft: async () => ({ id: "newer", token: "new-token" }) }),
  });
  await settle();
  newer.setValue("name", "New");
  newer.flushDraft();
  await settle();
  newer.destroy();
  pending.resolve({ ok: true });
  await submitting;
  old.destroy();
  const restored = createFormController({
    form,
    formId: fid,
    client: client({
      getDraft: async (...args) => {
        reads.push(args);
        return { data: {} };
      },
    }),
  });
  await settle();
  assert.deepEqual(reads, [["newer", "new-token"]]);
  restored.destroy();
});

test("serialized queued saves keep the latest captured answers after departure", async () => {
  const first = deferred(),
    writes = [],
    fid = "multiple-departed-saves";
  const c = client({
    createDraft: async (_fid, payload) => {
      writes.push(payload.data.name);
      await first.promise;
      return { id: fid, token: "token" };
    },
    saveDraft: async (_id, _token, payload) => writes.push(payload.data.name),
    getDraft: async () => ({ data: { name: writes.at(-1) } }),
  });
  const ctl = createFormController({ form, formId: fid, client: c });
  await settle();
  ctl.setValue("name", "Earlier");
  ctl.flushDraft();
  ctl.setValue("name", "Latest");
  ctl.flushDraft();
  ctl.destroy();
  first.resolve();
  await settle();
  assert.deepEqual(writes, ["Earlier", "Latest"]);
  const next = createFormController({ form, formId: fid, client: c });
  await settle();
  assert.equal(next.getState().data.name, "Latest");
  next.destroy();
});

test("anonymous saved progress still resumes after identification", async () => {
  const fid = "anonymous-identify-compatible",
    reads = [];
  const c = client({
    getDraft: async (...args) => {
      reads.push(args);
      return { data: { name: "Anonymous answer" } };
    },
  });
  const seed = createFormController({ form, formId: fid, client: c });
  await settle();
  seed.setValue("name", "Anonymous answer");
  seed.flushDraft();
  await settle();
  seed.destroy();
  const next = createFormController({
    form,
    formId: fid,
    client: c,
    respondent: { id: "Now identified", hash: "a".repeat(64) },
  });
  await settle();
  assert.equal(next.getState().data.name, "Anonymous answer");
  assert.deepEqual(reads, [["draft", "token"]]);
  next.destroy();
});

test("departed empty submit cannot discard a post-reset pending draft from another controller", async () => {
  const submissionAck = deferred(),
    creation = deferred(),
    fid = "departed-empty-submit-reset",
    deleted = [],
    reads = [];
  const old = createFormController({
    form,
    formId: fid,
    client: client({ submit: () => submissionAck.promise }),
  });
  await settle();
  old.setValue("name", "Old");
  const submission = old.submit();
  old.setContext({ formId: "elsewhere-empty-submit" });
  const newer = createFormController({
    form,
    formId: fid,
    client: client({
      createDraft: () => creation.promise,
      deleteDraft: async (...args) => deleted.push(args),
    }),
  });
  newer.resetDraft();
  newer.setValue("name", "New progress");
  newer.flushDraft();
  await settle();
  submissionAck.resolve({ ok: true });
  await submission;
  creation.resolve({ id: "post-reset-draft", token: "post-reset-token" });
  await settle();
  old.destroy();
  newer.destroy();
  const restored = createFormController({
    form,
    formId: fid,
    client: client({
      getDraft: async (...args) => {
        reads.push(args);
        return { data: { name: "New progress" } };
      },
    }),
  });
  await settle();
  assert.deepEqual(deleted, []);
  assert.deepEqual(reads, [["post-reset-draft", "post-reset-token"]]);
  assert.equal(restored.getState().data.name, "New progress");
  restored.destroy();
});

for (const late of [false, true]) {
  test(`known-person switch cannot complete Alice's ${late ? "pending" : "started"} funnel session`, async () => {
    const aliceSession = deferred(),
      completed = [],
      fid = "session-person-" + late;
    let started = 0;
    const c = client({
      startSession: async () => (++started === 1 ? aliceSession.promise : "bob-session"),
      reportProgress: (id, payload) => {
        if (payload.completed) completed.push(id);
      },
    });
    const ctl = createFormController({
      form: { ...form, settings: {} },
      formId: fid,
      client: c,
      respondent: { id: "Alice" },
    });
    ctl.setValue("name", "Alice");
    if (!late) {
      aliceSession.resolve("alice-session");
      await settle();
    }
    ctl.setContext({ respondent: { id: "Bob" } });
    ctl.setValue("name", "Bob");
    await settle();
    if (late) {
      aliceSession.resolve("alice-session");
      await settle();
    }
    await ctl.submit();
    assert.deepEqual(completed, ["bob-session"]);
    ctl.destroy();
  });
}

test("a current submission completes the session that settles during its request", async () => {
  const session = deferred(),
    ack = deferred(),
    completed = [];
  const ctl = createFormController({
    form: { ...form, settings: {} },
    formId: "current-late-session",
    client: client({
      startSession: () => session.promise,
      submit: () => ack.promise,
      reportProgress: (id, payload) => {
        if (payload.completed) completed.push(id);
      },
    }),
  });
  ctl.setValue("name", "Answer");
  const submission = ctl.submit();
  session.resolve("current-session");
  await settle();
  ack.resolve({ ok: true });
  await submission;
  assert.deepEqual(completed, ["current-session"]);
  ctl.destroy();
});

test("sign-out and next login isolate answers, pages, drafts, and funnel sessions", async () => {
  const writes = [],
    submissions = [],
    completed = [],
    fid = "logout-login-isolation";
  let sessions = 0;
  const c = client({
    createDraft: async (_fid, payload) => ({
      id: "draft-" + (payload.respondent?.id ?? "anonymous"),
      token: "token",
    }),
    getDraft: async (id) => ({
      data: { name: id === "draft-Alice" ? "Alice private" : undefined },
      page: 1,
    }),
    saveDraft: async (id, _token, payload) => writes.push([id, payload.data]),
    submit: async (_fid, data) => {
      submissions.push(data);
      return { ok: true };
    },
    startSession: async () => "session-" + ++sessions,
    reportProgress: (id, payload) => {
      if (payload.completed) completed.push(id);
    },
  });
  const pages = {
    ...form,
    pages: [
      ...form.pages,
      { id: "p2", blocks: [{ id: "note", kind: "short_text", label: "Note" }] },
    ],
  };
  const ctl = createFormController({
    form: pages,
    formId: fid,
    client: c,
    respondent: { id: "Alice", hash: "a".repeat(64) },
  });
  await settle();
  ctl.setValue("name", "Alice private");
  ctl.next();
  ctl.flushDraft();
  await settle();
  ctl.setContext({ respondent: undefined });
  await settle();
  assert.equal(ctl.getState().data.name, undefined);
  assert.equal(ctl.getState().pageIndex, 0);
  ctl.setValue("note", "Logged-out answer");
  ctl.flushDraft();
  await settle();
  ctl.setContext({ respondent: { id: "Bob", hash: "b".repeat(64) } });
  await settle();
  assert.deepEqual(ctl.getState().data, {});
  assert.equal(ctl.getState().pageIndex, 0);
  ctl.setValue("note", "Bob note");
  ctl.flushDraft();
  await settle();
  await ctl.submit();
  assert.deepEqual(submissions, [{ note: "Bob note" }]);
  assert.deepEqual(
    writes.filter(([id]) => id === "draft-Bob"),
    [["draft-Bob", { note: "Bob note" }]],
  );
  assert.deepEqual(completed, ["session-3"]);
  ctl.destroy();
});

for (const transition of ["identify", "hash"]) {
  test(`accepted submit survives same-fill ${transition}`, async () => {
    const ack = deferred(),
      callbacks = [],
      fid = "pending-same-fill-" + transition;
    const ctl = createFormController({
      form,
      formId: fid,
      client: client({ submit: () => ack.promise }),
      onSubmitted: (...args) => callbacks.push(args),
      ...(transition === "hash" ? { respondent: { id: "Alice", hash: "a".repeat(64) } } : {}),
    });
    await settle();
    ctl.setValue("name", "Answer");
    const submission = ctl.submit();
    ctl.setContext({ respondent: { id: "Alice", hash: "b".repeat(64) } });
    assert.equal(ctl.getState().status, "submitting");
    ack.resolve({ ok: true, responseId: "accepted" });
    await submission;
    assert.equal(ctl.getState().status, "submitted");
    assert.deepEqual(callbacks, [["accepted", { name: "Answer" }]]);
    ctl.destroy();
  });
}

for (const nextPerson of ["Alice", "Bob"]) {
  test(`anonymous remount waits for identity before restoring ${nextPerson === "Alice" ? "matching" : "another person's"} known bearer`, async () => {
    const fid = "known-remount-" + nextPerson,
      reads = [],
      created = [];
    const c = client({
      createDraft: async (_fid, payload) => {
        const id = payload.respondent?.id ?? "anonymous";
        created.push(id);
        return { id: "draft-" + id, token: "token" };
      },
      getDraft: async (id) => {
        reads.push(id);
        return { data: { name: "Alice private" } };
      },
    });
    const alice = createFormController({
      form,
      formId: fid,
      client: c,
      respondent: { id: "Alice", hash: "a".repeat(64) },
    });
    await settle();
    alice.setValue("name", "Alice private");
    alice.flushDraft();
    await settle();
    alice.destroy();
    const ctl = createFormController({ form, formId: fid, client: c });
    await settle();
    assert.deepEqual(reads, []);
    assert.equal(ctl.getState().data.name, undefined);
    ctl.setContext({ respondent: { id: nextPerson, hash: "a".repeat(64) } });
    await settle();
    assert.deepEqual(reads, nextPerson === "Alice" ? ["draft-Alice"] : []);
    assert.equal(ctl.getState().data.name, nextPerson === "Alice" ? "Alice private" : undefined);
    assert.deepEqual(created, nextPerson === "Alice" ? ["Alice"] : ["Alice", "Bob"]);
    ctl.destroy();
  });
}

for (const transition of ["identify", "hash"]) {
  for (const outcome of ["rejected", "transport", "challenge", "resolver"]) {
    test(`pending ${outcome} result remains current after same-fill ${transition}`, async () => {
      const pending = deferred(),
        callbacks = [],
        failures = [],
        submissions = [],
        fid = `pending-${outcome}-${transition}`;
      const ctl = createFormController({
        form,
        formId: fid,
        client: client({
          submit: async (...args) => {
            submissions.push(args);
            return outcome === "resolver" ? { ok: true, responseId: "resolved" } : pending.promise;
          },
        }),
        onSubmitted: (...args) => callbacks.push(args),
        onChallengeFailed: () => failures.push(true),
        ...(outcome === "resolver" ? { resolveFormId: () => pending.promise } : {}),
        ...(transition === "hash" ? { respondent: { id: "Alice", hash: "a".repeat(64) } } : {}),
      });
      await settle();
      ctl.setValue("name", "Answer");
      const submission = ctl.submit();
      ctl.setContext({ respondent: { id: "Alice", hash: "b".repeat(64) } });
      assert.equal(ctl.getState().status, "submitting");
      if (outcome === "transport") {
        pending.reject(new Error("Offline"));
        await assert.rejects(submission, /Offline/);
      } else if (outcome === "challenge") {
        pending.reject(new FilloError("Challenge failed", 400, undefined, "challenge_failed"));
        await submission;
      } else {
        pending.resolve(
          outcome === "resolver" ? fid : { ok: false, errors: { name: "Correct answer" } },
        );
        await submission;
      }
      assert.equal(ctl.getState().status, outcome === "resolver" ? "submitted" : "idle");
      assert.equal(ctl.getState().data.name, "Answer");
      if (outcome === "rejected")
        assert.deepEqual(ctl.getState().errors, { name: "Correct answer" });
      if (outcome === "transport" || outcome === "challenge") assert.ok(ctl.getState().submitError);
      assert.equal(callbacks.length, outcome === "resolver" ? 1 : 0);
      assert.equal(failures.length, outcome === "challenge" ? 1 : 0);
      ctl.destroy();
    });
  }
}

for (const nextPerson of ["Alice", "Bob"]) {
  test(`old accepted submit after sign-out cannot discard ${nextPerson}'s new fill`, async () => {
    const ack = deferred(),
      callbacks = [],
      writes = [],
      fid = "signout-pending-" + nextPerson;
    const c = client({
      createDraft: async (_fid, payload) => ({
        id: "draft-" + (payload.respondent?.id ?? "anonymous"),
        token: "token",
      }),
      saveDraft: async (id, _token, payload) => writes.push([id, payload.data]),
      getDraft: async () => ({ data: {} }),
      submit: () => ack.promise,
    });
    const ctl = createFormController({
      form,
      formId: fid,
      client: c,
      respondent: { id: "Alice", hash: "a".repeat(64) },
      onSubmitted: (...args) => callbacks.push(args),
    });
    await settle();
    ctl.setValue("name", "Old private");
    const submission = ctl.submit();
    ctl.setContext({ respondent: undefined });
    ctl.setValue("name", "New anonymous");
    ctl.flushDraft();
    await settle();
    ctl.setContext({ respondent: { id: nextPerson, hash: "b".repeat(64) } });
    await settle();
    ctl.setValue("name", "New " + nextPerson);
    ctl.flushDraft();
    await settle();
    ack.resolve({ ok: true });
    await submission;
    await settle();
    assert.equal(ctl.getState().status, "idle");
    assert.equal(ctl.getState().data.name, "New " + nextPerson);
    assert.deepEqual(callbacks, []);
    ctl.setValue("name", "After old ack");
    ctl.flushDraft();
    await settle();
    assert.equal(writes.at(-1)[1].name, "After old ack");
    ctl.destroy();
  });
}

for (const discard of ["accepted", "reset"]) {
  test(`same-fill identity adoption ${discard} fences pending original draft creation`, async () => {
    const ack = deferred(),
      create = deferred(),
      deleted = [],
      fid = "identify-adoption-" + discard;
    const c = client({
      createDraft: () => create.promise,
      submit: () => ack.promise,
      deleteDraft: async (...args) => deleted.push(args),
    });
    const ctl = createFormController({ form, formId: fid, client: c });
    await settle();
    ctl.setValue("name", "Answer");
    ctl.flushDraft();
    await settle();
    const submission = ctl.submit();
    ctl.setContext({ respondent: { id: "Alice", hash: "a".repeat(64) } });
    if (discard === "accepted") {
      ack.resolve({ ok: true });
      await submission;
    } else {
      ack.resolve({ ok: false });
      await submission;
      ctl.resetDraft();
    }
    create.resolve({ id: "late-original", token: "late-token" });
    await settle();
    assert.deepEqual(deleted, [["late-original", "late-token"]]);
    const reads = [];
    const next = createFormController({
      form,
      formId: fid,
      client: client({
        getDraft: async (...args) => {
          reads.push(args);
          return { data: {} };
        },
      }),
    });
    await settle();
    assert.deepEqual(reads, []);
    ctl.destroy();
    next.destroy();
  });
}

test("accepted departed Alice submit cannot discard Bob's still-pending affinity draft", async () => {
  const ack = deferred(),
    bob = deferred(),
    deleted = [],
    reads = [],
    fid = "pending-bob-affinity-after-alice";
  const c = client({
    createDraft: async (_fid, payload) =>
      payload.respondent?.id === "Bob" ? bob.promise : { id: "draft-Alice", token: "alice-token" },
    getDraft: async (id) => {
      reads.push(id);
      return { data: {} };
    },
    deleteDraft: async (...args) => deleted.push(args),
    submit: () => ack.promise,
  });
  const ctl = createFormController({
    form,
    formId: fid,
    client: c,
    respondent: { id: "Alice", hash: "a".repeat(64) },
  });
  await settle();
  ctl.setValue("name", "Old answer");
  const submission = ctl.submit();
  ctl.setContext({ respondent: { id: "Bob", hash: "b".repeat(64) } });
  await settle();
  ack.resolve({ ok: true });
  await submission;
  bob.resolve({ id: "draft-Bob", token: "bob-token" });
  await settle();
  ctl.destroy();
  const next = createFormController({
    form,
    formId: fid,
    client: c,
    respondent: { id: "Bob", hash: "b".repeat(64) },
  });
  await settle();
  assert.deepEqual(deleted, []);
  assert.deepEqual(reads, ["draft-Bob"]);
  next.destroy();
});

for (const action of ["submit", "reset"]) {
  test(`anonymous ${action} cannot clear a filtered known person's pointer`, async () => {
    const fid = "anonymous-foreign-" + action,
      reads = [],
      deleted = [];
    const c = client({
      createDraft: async () => ({ id: "Alice-draft", token: "Alice-token" }),
      getDraft: async (...args) => {
        reads.push(args);
        return { data: { name: "Alice private" } };
      },
      deleteDraft: async (...args) => deleted.push(args),
    });
    const alice = createFormController({
      form,
      formId: fid,
      client: c,
      respondent: { id: "Alice", hash: "a".repeat(64) },
    });
    await settle();
    alice.destroy();
    const anon = createFormController({ form, formId: fid, client: c });
    await settle();
    anon.setValue("name", "Anonymous answer");
    if (action === "submit") await anon.submit();
    else anon.resetDraft();
    anon.destroy();
    assert.deepEqual(deleted, []);
    const restored = createFormController({
      form,
      formId: fid,
      client: c,
      respondent: { id: "Alice", hash: "a".repeat(64) },
    });
    await settle();
    assert.deepEqual(reads, [["Alice-draft", "Alice-token"]]);
    assert.equal(restored.getState().data.name, "Alice private");
    restored.destroy();
  });
}

test("Alice's accepted submit cannot discard another controller's pending Bob draft", async () => {
  const ack = deferred(),
    bobCreate = deferred(),
    deleted = [],
    reads = [],
    fid = "cross-person-pending-create";
  const c = client({
    createDraft: async (_fid, payload) =>
      payload.respondent?.id === "Bob"
        ? bobCreate.promise
        : { id: "Alice-draft", token: "Alice-token" },
    getDraft: async (id) => {
      reads.push(id);
      return { data: { name: "Bob saved" } };
    },
    deleteDraft: async (...args) => deleted.push(args),
    submit: () => ack.promise,
  });
  const alice = createFormController({
    form,
    formId: fid,
    client: c,
    respondent: { id: "Alice", hash: "a".repeat(64) },
  });
  await settle();
  alice.setValue("name", "Alice answer");
  const submitting = alice.submit();
  const bob = createFormController({
    form,
    formId: fid,
    client: c,
    respondent: { id: "Bob", hash: "b".repeat(64) },
  });
  await settle();
  ack.resolve({ ok: true });
  await submitting;
  bobCreate.resolve({ id: "Bob-draft", token: "Bob-token", existing: true });
  await settle();
  assert.deepEqual(deleted, []);
  assert.deepEqual(reads, ["Bob-draft"]);
  assert.equal(bob.getState().data.name, "Bob saved");
  alice.destroy();
  bob.destroy();
});

test("new person gets a separate receipt key while old submit remains pending", async () => {
  const aliceAck = deferred(),
    writes = [],
    receipts = new Map(),
    fid = "identity-receipt-isolation";
  const c = client({
    submit: async (_fid, data, meta) => {
      if (receipts.has(meta.submissionKey))
        return { ok: true, responseId: receipts.get(meta.submissionKey), duplicate: true };
      const id = meta.respondent?.id;
      receipts.set(meta.submissionKey, id);
      writes.push([id, meta.submissionKey, data]);
      return id === "Alice" ? aliceAck.promise : { ok: true, responseId: id };
    },
  });
  const ctl = createFormController({
    form: { ...form, settings: {} },
    formId: fid,
    client: c,
    respondent: { id: "Alice" },
  });
  ctl.setValue("name", "Alice answer");
  const oldSubmission = ctl.submit();
  ctl.setContext({ respondent: undefined });
  ctl.setContext({ respondent: { id: "Bob" } });
  ctl.setValue("name", "Bob answer");
  await ctl.submit();
  assert.equal(writes.length, 2);
  assert.notEqual(writes[0][1], writes[1][1]);
  assert.equal(ctl.getState().duplicateSubmission, false);
  aliceAck.resolve({ ok: true, responseId: "Alice" });
  await oldSubmission;
  ctl.destroy();
});

test("completed person can switch to a fresh fill with fresh submission metadata", async () => {
  const submitted = [],
    ctl = createFormController({
      form: { ...form, settings: {} },
      formId: "completed-person-switch",
      respondent: { id: "Alice" },
      client: client({
        submit: async (_fid, _data, meta) => {
          submitted.push(meta.respondent.id);
          return { ok: true, duplicate: meta.respondent.id === "Alice" };
        },
      }),
    });
  ctl.setValue("name", "Alice");
  await ctl.submit();
  assert.equal(ctl.getState().duplicateSubmission, true);
  ctl.setContext({ respondent: { id: "Bob" } });
  assert.equal(ctl.getState().status, "idle");
  assert.equal(ctl.getState().duplicateSubmission, false);
  assert.equal(ctl.getState().restoredSubmission, false);
  ctl.setValue("name", "Bob");
  await ctl.submit();
  assert.deepEqual(submitted, ["Alice", "Bob"]);
  ctl.destroy();
});

for (const change of ["identify", "hash", "reset"]) {
  test(`receipt keys ${change === "reset" ? "rotate" : "remain stable"} after ${change}`, async () => {
    const keys = [],
      ctl = createFormController({
        form: { ...form, settings: {} },
        formId: "receipt-" + change,
        ...(change === "hash" ? { respondent: { id: "Alice", hash: "a".repeat(64) } } : {}),
        client: client({
          submit: async (_fid, _data, meta) => {
            keys.push(meta.submissionKey);
            return { ok: false, errors: { name: "Retry" } };
          },
        }),
      });
    ctl.setValue("name", "Answer");
    await ctl.submit();
    if (change === "reset") {
      ctl.resetDraft();
      ctl.setValue("name", "Fresh answer");
    } else ctl.setContext({ respondent: { id: "Alice", hash: "b".repeat(64) } });
    await ctl.submit();
    if (change === "reset") assert.notEqual(keys[0], keys[1]);
    else assert.equal(keys[0], keys[1]);
    ctl.destroy();
  });
}

test("switching people or resetting cannot bypass a browser response-limit gate", async () => {
  const ctl = createFormController({
    form: { ...form, settings: { responseLimit: { by: "browser", onRepeat: "keep" } } },
    formId: "browser-person-reset",
    respondent: { id: "Alice" },
    client: client(),
  });
  await settle();
  ctl.setValue("name", "Alice");
  await ctl.submit();
  ctl.setContext({ respondent: { id: "Bob" } });
  assert.equal(ctl.getState().status, "submitted");
  assert.equal(ctl.getState().restoredSubmission, true);
  ctl.resetDraft();
  assert.equal(ctl.getState().status, "submitted");
  assert.equal(ctl.getState().restoredSubmission, true);
  ctl.destroy();
});

for (const transition of ["signout", "person", "identify", "hash"]) {
  test(`reset ${transition === "signout" || transition === "person" ? "excludes departed" : "retains same-fill"} initial values after ${transition}`, () => {
    const ctl = createFormController({
      form: { ...form, settings: {} },
      initialData: { name: "Original prefill" },
      ...(transition !== "identify" ? { respondent: { id: "Alice", hash: "a".repeat(64) } } : {}),
    });
    ctl.setValue("name", "Edited");
    ctl.setContext({
      respondent:
        transition === "signout"
          ? undefined
          : { id: transition === "person" ? "Bob" : "Alice", hash: "b".repeat(64) },
    });
    ctl.resetDraft();
    assert.deepEqual(
      ctl.getState().data,
      transition === "signout" || transition === "person" ? {} : { name: "Original prefill" },
    );
    ctl.destroy();
  });
}

for (const change of ["person", "signout"]) {
  for (const limited of [false, true]) {
    test(`${change} rebuilds URL/date/calculated defaults ${limited ? "before the scoped browser gate" : "without departed prefill"}`, async () => {
      const previousLocation = globalThis.location;
      globalThis.location = { search: "?article=X&src=campaign&amount=3", hash: "", pathname: "/" };
      try {
        const configured = {
          ...form,
          settings: limited
            ? { responseLimit: { by: "browser", scopeField: "article", onRepeat: "keep" } }
            : {},
          pages: [
            {
              id: "p1",
              blocks: [
                ...form.pages[0].blocks,
                { id: "article", kind: "hidden", label: "Article", required: true },
                { id: "campaign", kind: "hidden", label: "Campaign", paramName: "src" },
                { id: "day", kind: "date", label: "Day", defaultToday: true },
                { id: "amount", kind: "number", label: "Amount" },
                {
                  id: "total",
                  kind: "calculated",
                  label: "Total",
                  calc: {
                    op: "mul",
                    args: [
                      { op: "value", fieldId: "amount" },
                      { op: "const", value: 2 },
                    ],
                  },
                },
              ],
            },
          ],
        };
        const ctl = createFormController({
          form: configured,
          formId: `default-${change}-${limited}`,
          client: client(),
          respondent: { id: "Alice" },
          initialData: { name: "Alice private", day: "2000-01-01" },
        });
        await settle();
        if (limited) await ctl.submit();
        ctl.setContext({ respondent: change === "signout" ? undefined : { id: "Bob" } });
        assert.deepEqual(ctl.getState().data, {
          article: "X",
          campaign: "campaign",
          day: localDateString(),
          amount: 3,
          total: 6,
        });
        assert.equal(ctl.getState().status, limited ? "submitted" : "idle");
        assert.equal(ctl.getState().restoredSubmission, limited);
        ctl.resetDraft();
        assert.equal(ctl.getState().data.article, "X");
        assert.equal(ctl.getState().data.name, undefined);
        ctl.destroy();
      } finally {
        if (previousLocation === undefined) delete globalThis.location;
        else globalThis.location = previousLocation;
      }
    });
  }
}

for (const transport of ["client", "formId"]) {
  test(`completed submission survives transport-only ${transport} update`, async () => {
    const submitted = [],
      c = client({
        submit: async (...args) => {
          submitted.push(args);
          return { ok: true, updated: true };
        },
      });
    const ctl = createFormController({
      form: { ...form, settings: {} },
      formId: "complete-transport-" + transport,
      client: c,
    });
    ctl.setValue("name", "Answer");
    await ctl.submit();
    ctl.setContext(
      transport === "client" ? { client: client() } : { formId: "changed-transport-target" },
    );
    assert.equal(ctl.getState().status, "submitted");
    assert.equal(ctl.getState().updatedSubmission, true);
    await ctl.submit();
    assert.equal(submitted.length, 1);
    ctl.destroy();
  });
}

test("client refresh preserves pending fill receipt key while fencing the old acknowledgment", async () => {
  const oldAck = deferred(),
    keys = [],
    callbacks = [];
  const ctl = createFormController({
    form: { ...form, settings: {} },
    formId: "pending-client-refresh-key",
    client: client({
      submit: async (_fid, _data, meta) => {
        keys.push(meta.submissionKey);
        return oldAck.promise;
      },
    }),
    onSubmitted: (...args) => callbacks.push(args),
  });
  ctl.setValue("name", "Answer");
  const old = ctl.submit();
  ctl.setContext({
    client: client({
      submit: async (_fid, _data, meta) => {
        keys.push(meta.submissionKey);
        return { ok: true, responseId: "received", duplicate: true };
      },
    }),
  });
  assert.equal(ctl.getState().status, "idle");
  await ctl.submit();
  assert.equal(keys[0], keys[1]);
  assert.deepEqual(callbacks, [["received", { name: "Answer" }]]);
  oldAck.resolve({ ok: true, responseId: "old" });
  await old;
  assert.equal(callbacks.length, 1);
  ctl.destroy();
});
