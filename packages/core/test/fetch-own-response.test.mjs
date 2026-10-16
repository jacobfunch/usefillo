import test from "node:test";
import assert from "node:assert/strict";
import { FilloClient } from "../dist/index.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("fetchOwnResponse serializes scopeValue into the POST body", async () => {
  const calls = [];
  const client = new FilloClient({
    baseUrl: "https://x.test",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ responseId: "r1", data: { name: "Ada" } });
    },
  });
  const out = await client.fetchOwnResponse("f1", { id: "u1", hash: "h" }, "articleA");
  assert.deepEqual(out, { responseId: "r1", data: { name: "Ada" } });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/forms\/f1\/respondent-response$/);
  assert.equal(calls[0].init.method, "POST");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.respondent, { id: "u1", hash: "h" });
  assert.equal(body.scopeValue, "articleA");
});

test("fetchOwnResponse omits scopeValue for unscoped forms (back-compatible)", async () => {
  const calls = [];
  const client = new FilloClient({
    baseUrl: "https://x.test",
    fetch: async (_url, init) => {
      calls.push({ init });
      return jsonResponse({ responseId: "r1", data: {} });
    },
  });
  await client.fetchOwnResponse("f1", { id: "u1", hash: "h" });
  const body = JSON.parse(calls[0].init.body);
  assert.equal("scopeValue" in body, false, "undefined scopeValue is not serialized");
});

test("fetchOwnResponse returns null on 404 (a scope mismatch or nothing to prefill)", async () => {
  const client = new FilloClient({
    baseUrl: "https://x.test",
    fetch: async () => jsonResponse({ error: "Not found" }, 404),
  });
  const out = await client.fetchOwnResponse("f1", { id: "u1", hash: "h" }, "articleB");
  assert.equal(out, null);
});
