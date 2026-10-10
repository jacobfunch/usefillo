import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { startMock, startServer } from "./harness.mjs";

const catalog = JSON.parse(
  readFileSync(new URL("../src/capabilities.json", import.meta.url), "utf8"),
);

test("native catalogue schemas and permission hints match the shared reviewed manifest", async (t) => {
  const server = await startServer("http://127.0.0.1:1");
  t.after(() => server.close());
  const tools = await server.listTools();
  const local = catalog.capabilities.filter((capability) => capability.local);
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    local.map((capability) => capability.name).sort(),
  );
  for (const tool of tools) {
    const contract = local.find((capability) => capability.name === tool.name).local;
    assert.deepEqual(tool.inputSchema, contract.inputSchema, tool.name);
    assert.deepEqual(tool.annotations, contract.annotations, tool.name);
  }
});

test("discovery activates native tools without bypassing their confirmation gates", async (t) => {
  const mock = await startMock(() => ({ status: 200, json: { forms: [] } }));
  const server = await startServer(mock.origin, {
    FILLO_TOKEN: "fcli_test",
    FILLO_MCP_TOOLSET: "discovery",
  });
  t.after(() => server.close());
  t.after(() => mock.close());
  assert.deepEqual((await server.listTools()).map((tool) => tool.name).sort(), [
    "fillo_get_tool_schema",
    "fillo_search_tools",
  ]);
  const search = await server.callTool("fillo_search_tools", { query: "forms" });
  assert.ok(search.data.tools.some((tool) => tool.name === "fillo_list_forms"));
  assert.ok(search.data.tools.every((tool) => !tool.inputSchema));
  const diagnosis = await server.callTool("fillo_search_tools", {
    query: "diagnose failed delivery",
    limit: 3,
  });
  assert.ok(diagnosis.data.tools.some((tool) => tool.name === "fillo_delivery_status"));
  assert.equal((await server.callTool("fillo_list_forms")).isError, true);
  const schema = await server.callTool("fillo_get_tool_schema", { name: "fillo_list_forms" });
  assert.equal(schema.data.annotations.readOnlyHint, true);
  assert.equal((await server.callTool("fillo_list_forms")).isError, false);
  await server.callTool("fillo_get_tool_schema", { name: "fillo_add_webhook" });
  const outward = await server.callTool("fillo_add_webhook", {
    form: "f1",
    url: "https://example.com/hook",
  });
  assert.equal(outward.isError, true);
  assert.match(outward.text, /confirm|human/i);
  assert.equal(mock.requests.length, 1);
  await server.callTool("fillo_get_tool_schema", { name: "fillo_list_forms" });
  assert.equal(
    (await server.listTools()).filter((tool) => tool.name === "fillo_list_forms").length,
    1,
  );
  assert.equal(
    (await server.callTool("fillo_get_tool_schema", { name: "not_a_tool" })).isError,
    true,
  );
});

test("existing and discovery connections forward selected-answer notification settings", async (t) => {
  const settings = {
    notifyEmailIncludeAnswers: true,
    notifyEmailAnswerFields: ["name", "message"],
    notifyEmailReplyToField: "email",
  };
  for (const [config, mount] of [
    [{ FILLO_TOKEN: "fcli_test" }, "cli"],
    [{ FILLO_API_KEY: "fsk_test", FILLO_MCP_TOOLSET: "discovery" }, "manage"],
  ]) {
    const mock = await startMock(() => ({ status: 200, json: { settings } }));
    const server = await startServer(mock.origin, config);
    t.after(() => server.close());
    t.after(() => mock.close());
    if (config.FILLO_MCP_TOOLSET === "discovery") {
      await server.callTool("fillo_get_tool_schema", { name: "fillo_update_settings" });
    }
    const result = await server.callTool("fillo_update_settings", { form: "f1", settings });
    assert.equal(result.isError, false);
    assert.deepEqual(result.data.settings, settings);
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0].method, "PATCH");
    assert.equal(mock.requests[0].url, `/api/v1/${mount}/forms/f1/settings`);
    assert.deepEqual(mock.requests[0].body, settings);
  }
});

test("response selection reaches the API with the existing credential and cursor", async (t) => {
  const mock = await startMock(() => ({ status: 200, json: { data: [], nextCursor: "r2" } }));
  const server = await startServer(mock.origin, { FILLO_TOKEN: "fcli_test" });
  t.after(() => server.close());
  t.after(() => mock.close());
  const result = await server.callTool("fillo_list_responses", {
    form: "f1",
    includeFields: ["email", "plan,legacy"],
    includeMeta: false,
    cursor: "r1",
    limit: 5,
  });
  assert.equal(result.data.untrusted, true);
  assert.equal(result.data.data.nextCursor, "r2");
  const url = new URL(mock.requests[0].url, mock.origin);
  assert.deepEqual(url.searchParams.getAll("field"), ["email", "plan,legacy"]);
  assert.equal(url.searchParams.get("includeMeta"), "false");
  assert.equal(url.searchParams.get("cursor"), "r1");
  assert.equal(mock.requests[0].auth, "Bearer fcli_test");
  const invalid = await server.callTool("fillo_list_responses", {
    form: "f1",
    includeFields: [""],
  });
  assert.equal(invalid.isError, true);
  assert.equal(mock.requests.length, 1);
});
