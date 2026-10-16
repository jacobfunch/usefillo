import test from "node:test";
import assert from "node:assert/strict";
import { createClient, FilloError } from "../dist/index.js";

test("submit keeps field-validation 422s as SubmitResult errors", async () => {
  const client = createClient({
    baseUrl: "https://api.test",
    fetch: async () => Response.json({ errors: { email: "Enter a valid email" } }, { status: 422 }),
  });

  assert.deepEqual(await client.submit("f1", {}), {
    ok: false,
    errors: { email: "Enter a valid email" },
  });
});

test("submit throws coded global 422s instead of returning errors: undefined", async () => {
  const client = createClient({
    baseUrl: "https://api.test",
    fetch: async () =>
      Response.json(
        {
          error: "We couldn't tell which entry this response belongs to.",
          code: "response_scope_missing",
        },
        { status: 422 },
      ),
  });

  await assert.rejects(
    () => client.submit("f1", {}),
    (error) =>
      error instanceof FilloError &&
      error.status === 422 &&
      error.code === "response_scope_missing",
  );
});
