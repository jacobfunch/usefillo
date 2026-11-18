import assert from "node:assert/strict";
import test from "node:test";
import { startMock, startServer } from "./harness.mjs";

test("local MCP feedback emails through either credential lane without a confirmation step", async (t) => {
  for (const [config, lane] of [
    [{ FILLO_TOKEN: "fcli_test" }, "cli"],
    [{ FILLO_API_KEY: "fsk_test" }, "manage"],
  ]) {
    const mock = await startMock(() => ({ status: 200, json: { status: "sent" } }));
    const server = await startServer(mock.origin, config);
    t.after(() => server.close());
    t.after(() => mock.close());
    const input = {
      category: "idea",
      message: "Make expired approvals resumable",
      context: "An overnight run",
    };
    const result = await server.callTool("fillo_send_feedback", input);
    assert.equal(result.isError, false);
    assert.deepEqual(result.data, { status: "sent" });
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0].url, `/api/v1/${lane}/feedback`);
    assert.equal(mock.requests[0].method, "POST");
    assert.deepEqual(mock.requests[0].body, input);
  }
});

test("local MCP feedback surfaces delivery errors and validates size before a request", async (t) => {
  const mock = await startMock(() => ({
    status: 503,
    json: { error: "Feedback could not be delivered. Try again later." },
  }));
  const server = await startServer(mock.origin, { FILLO_TOKEN: "fcli_test" });
  t.after(() => server.close());
  t.after(() => mock.close());
  const failed = await server.callTool("fillo_send_feedback", { message: "Feedback" });
  assert.equal(failed.isError, true);
  assert.match(failed.text, /could not be delivered/);
  const tooLarge = await server.callTool("fillo_send_feedback", { message: "x".repeat(6001) });
  assert.equal(tooLarge.isError, true);
  const forged = await server.callTool("fillo_send_feedback", {
    message: "Feedback",
    to: "elsewhere@example.test",
  });
  assert.equal(forged.isError, true);
  assert.equal(mock.requests.length, 1);
});

test("local feedback requires an explicit sent acknowledgment even on a successful HTTP status", async (t) => {
  for (const response of [
    { status: 200, text: "<html>Sign in</html>" },
    { status: 200, json: {} },
    { status: 202, json: { status: "queued" } },
  ]) {
    const mock = await startMock(() => response);
    const server = await startServer(mock.origin, { FILLO_TOKEN: "fcli_test" });
    t.after(() => server.close());
    t.after(() => mock.close());
    const result = await server.callTool("fillo_send_feedback", { message: "Feedback" });
    assert.equal(result.isError, true);
    assert.match(result.text, /could not be verified/);
  }
});
