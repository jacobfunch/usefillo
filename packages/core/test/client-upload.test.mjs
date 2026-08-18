import test from "node:test";
import assert from "node:assert/strict";
import { createClient, FilloError } from "../dist/index.js";

const S3_PART_SIZE = 8 * 1024 * 1024;

test("lost create responses retry one client-owned idempotency handle", async () => {
  const bodies = [];
  let creates = 0;
  const client = createClient({
    baseUrl: "https://api.test",
    fetch: async (url, init = {}) => {
      const target = String(url);
      if (target.endsWith("/api/v1/forms/f1/uploads")) {
        const body = JSON.parse(init.body);
        bodies.push(body);
        creates += 1;
        if (creates === 1) throw new TypeError("response lost");
        return Response.json({
          id: body.requestId,
          formId: "f1",
          fieldId: "files",
          fileName: "upload.bin",
          size: 0,
          mime: "application/octet-stream",
          chunkSize: S3_PART_SIZE,
          uploadedBytes: 0,
          status: "pending",
          transport: { type: "s3-multipart" },
          token: body.uploadToken,
        });
      }
      if (target.includes("/complete")) {
        return Response.json({
          id: bodies[0].requestId,
          formId: "f1",
          fieldId: "files",
          fileName: "upload.bin",
          size: 0,
          mime: "application/octet-stream",
          chunkSize: S3_PART_SIZE,
          uploadedBytes: 0,
          status: "complete",
          file: {
            fileId: "empty-file",
            name: "upload.bin",
            size: 0,
            mime: "application/octet-stream",
          },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
  });
  const file = await client.uploadFile("f1", new Blob([]), {
    fieldId: "files",
  });
  assert.equal(file.fileId, "empty-file");
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].requestId, bodies[1].requestId);
  assert.equal(bodies[0].uploadToken, bodies[1].uploadToken);
});

test("upload creation retries only explicitly temporary 409 responses", async () => {
  for (const retryAfter of [null, "1"]) {
    let creates = 0;
    const client = createClient({
      baseUrl: "https://api.test",
      fetch: async (url, init = {}) => {
        if (!String(url).endsWith("/api/v1/forms/f1/uploads")) {
          throw new Error(`unexpected fetch: ${url}`);
        }
        creates += 1;
        if (retryAfter === null || creates === 1) {
          return Response.json(
            { error: retryAfter === null ? "No file storage connected" : "Upload initialization is still in progress" },
            {
              status: 409,
              headers: retryAfter === null ? undefined : { "Retry-After": retryAfter },
            },
          );
        }
        const body = JSON.parse(init.body);
        return Response.json({
          id: body.requestId,
          formId: "f1",
          fieldId: "files",
          fileName: "upload.bin",
          size: 0,
          mime: "application/octet-stream",
          chunkSize: S3_PART_SIZE,
          uploadedBytes: 0,
          status: "complete",
          file: {
            fileId: "busy-recovered",
            name: "upload.bin",
            size: 0,
            mime: "application/octet-stream",
          },
        });
      },
    });
    if (retryAfter === null) {
      await assert.rejects(
        () => client.uploadFile("f1", new Blob([]), { fieldId: "files" }),
        (error) => error instanceof FilloError && error.status === 409,
      );
      assert.equal(creates, 1);
    } else {
      const file = await client.uploadFile("f1", new Blob([]), { fieldId: "files" });
      assert.equal(file.fileId, "busy-recovered");
      assert.equal(creates, 2);
    }
  }
});

test("lost completion responses reconcile the canonical file by status", async () => {
  let completionCalls = 0;
  const client = createClient({
    baseUrl: "https://api.test",
    fetch: async (url, init = {}) => {
      const target = String(url);
      if (target.endsWith("/api/v1/forms/f1/uploads")) {
        const body = JSON.parse(init.body);
        return Response.json({
          id: body.requestId,
          formId: "f1",
          fieldId: "files",
          fileName: "upload.bin",
          size: 0,
          mime: "application/octet-stream",
          chunkSize: S3_PART_SIZE,
          uploadedBytes: 0,
          status: "pending",
          transport: { type: "s3-multipart" },
          token: body.uploadToken,
        });
      }
      if (target.endsWith("/complete")) {
        completionCalls += 1;
        throw new TypeError("completion response lost");
      }
      if (target.includes("/api/v1/uploads/")) {
        return Response.json({
          id: "session",
          formId: "f1",
          fieldId: "files",
          fileName: "upload.bin",
          size: 0,
          mime: "application/octet-stream",
          chunkSize: S3_PART_SIZE,
          uploadedBytes: 0,
          status: "complete",
          file: {
            fileId: "canonical-file",
            name: "upload.bin",
            size: 0,
            mime: "application/octet-stream",
          },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
  });
  const file = await client.uploadFile("f1", new Blob([]), {
    fieldId: "files",
  });
  assert.equal(file.fileId, "canonical-file");
  assert.equal(completionCalls, 1);
});

test("resumed Blob uploads retain the caller's bearer through completion", async () => {
  const calls = [];
  let handle;
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/api/v1/uploads/u1")) {
      return Response.json({
        id: "u1",
        formId: "f1",
        fieldId: "files",
        fileName: "upload.bin",
        size: 3,
        mime: "APPLICATION/OCTET-STREAM",
        chunkSize: 3,
        uploadedBytes: 0,
        status: "uploading",
        transport: { type: "s3-put", uploadUrl: "https://storage.test/object" },
      });
    }
    if (String(url) === "https://storage.test/object") return new Response(null, { status: 200 });
    if (String(url).endsWith("/api/v1/uploads/u1/complete")) {
      return Response.json({
        id: "u1",
        formId: "f1",
        fieldId: "files",
        fileName: "upload.bin",
        size: 3,
        mime: "application/octet-stream",
        chunkSize: 3,
        uploadedBytes: 3,
        status: "complete",
        file: { fileId: "file1", name: "upload.bin", size: 3, mime: "application/octet-stream" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const client = createClient({ baseUrl: "https://api.test", fetch });
  const file = await client.uploadFile("f1", new Blob(["abc"]), {
    fieldId: "files",
    sessionId: "u1",
    uploadToken: "resume-secret",
    onSession: (value) => {
      handle = value;
    },
  });
  assert.equal(file.fileId, "file1");
  assert.deepEqual(handle, {
    sessionId: "u1",
    uploadToken: "resume-secret",
  });
  assert.equal(calls[0].init.headers["X-Fillo-Upload-Token"], "resume-secret");
  assert.equal(calls.at(-1).init.headers["X-Fillo-Upload-Token"], "resume-secret");
});

test("resume rejects a session from a different field before moving bytes", async () => {
  const client = createClient({
    baseUrl: "https://api.test",
    fetch: async () => Response.json({
      id: "u1",
      formId: "f1",
      fieldId: "other",
      fileName: "upload.bin",
      size: 3,
      mime: "application/octet-stream",
      chunkSize: 3,
      uploadedBytes: 0,
      status: "uploading",
      transport: { type: "s3-put", uploadUrl: "https://storage.test/object" },
    }),
  });
  await assert.rejects(
    () => client.uploadFile("f1", new Blob(["abc"]), {
      fieldId: "files",
      sessionId: "u1",
      uploadToken: "resume-secret",
    }),
    (error) => error instanceof FilloError && error.status === 400,
  );
});

test("resume rejects same-sized name or MIME mismatches, including completed sessions", async () => {
  for (const status of ["uploading", "complete"]) {
    let calls = 0;
    const client = createClient({
      baseUrl: `https://${status}.test`,
      fetch: async () => {
        calls += 1;
        return Response.json({
          id: "u1",
          formId: "f1",
          fieldId: "files",
          fileName: "original.txt",
          size: 3,
          mime: "text/plain",
          chunkSize: 3,
          uploadedBytes: status === "complete" ? 3 : 0,
          status,
          transport: { type: "s3-put", uploadUrl: "https://storage.test/object" },
          ...(status === "complete"
            ? { file: { fileId: "old", name: "original.txt", size: 3, mime: "text/plain" } }
            : {}),
        });
      },
    });
    const replacement = status === "complete"
      ? new File(["abc"], "original.txt", { type: "application/pdf" })
      : new File(["abc"], "replacement.txt", { type: "text/plain" });
    await assert.rejects(
      () => client.uploadFile("f1", replacement, {
        fieldId: "files",
        sessionId: "u1",
        uploadToken: "resume-secret",
      }),
      (error) => error instanceof FilloError && error.status === 400,
    );
    assert.equal(calls, 1, "only the status read ran; replacement bytes were not sent");
  }
});

test("S3 multipart uploads direct 8 MiB parts sequentially with the session bearer", async () => {
  const size = S3_PART_SIZE + 3;
  const partNumbers = [];
  const uploadedSizes = [];
  const progress = [];
  const timeoutDurations = [];
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = (milliseconds) => {
    timeoutDurations.push(milliseconds);
    return originalTimeout.call(AbortSignal, milliseconds);
  };

  const fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.endsWith("/api/v1/forms/f1/uploads")) {
      return Response.json({
        id: "mpu1",
        formId: "f1",
        fieldId: "files",
        fileName: "upload.bin",
        size,
        mime: "application/octet-stream",
        chunkSize: S3_PART_SIZE,
        uploadedBytes: 0,
        status: "pending",
        transport: { type: "s3-multipart" },
        token: "multipart-secret",
      });
    }
    if (target.endsWith("/api/v1/uploads/mpu1/parts")) {
      assert.equal(init.headers["X-Fillo-Upload-Token"], "multipart-secret");
      const { partNumber } = JSON.parse(init.body);
      partNumbers.push(partNumber);
      return Response.json({ uploadUrl: `https://storage.test/part-${partNumber}` });
    }
    if (target.startsWith("https://storage.test/part-")) {
      assert.equal(init.method, "PUT");
      uploadedSizes.push(init.body.size);
      return new Response(null, { status: 200 });
    }
    if (target.endsWith("/api/v1/uploads/mpu1/complete")) {
      assert.equal(init.headers["X-Fillo-Upload-Token"], "multipart-secret");
      return Response.json({
        id: "mpu1",
        formId: "f1",
        fieldId: "files",
        fileName: "upload.bin",
        size,
        mime: "application/octet-stream",
        chunkSize: S3_PART_SIZE,
        uploadedBytes: size,
        status: "complete",
        file: { fileId: "file-mpu1", name: "upload.bin", size, mime: "application/octet-stream" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const client = createClient({ baseUrl: "https://api.test", fetch });
    let handle;
    const file = await client.uploadFile("f1", new Blob([new Uint8Array(size)]), {
      fieldId: "files",
      onProgress: ({ uploadedBytes }) => progress.push(uploadedBytes),
      onSession: (value) => {
        handle = value;
      },
    });
    assert.equal(file.fileId, "file-mpu1");
    assert.deepEqual(handle, {
      sessionId: "mpu1",
      uploadToken: "multipart-secret",
    });
  } finally {
    AbortSignal.timeout = originalTimeout;
  }

  assert.deepEqual(partNumbers, [1, 2]);
  assert.deepEqual(uploadedSizes, [S3_PART_SIZE, 3]);
  assert.deepEqual(progress, [0, S3_PART_SIZE, size]);
  assert.ok(timeoutDurations.includes(5 * 60_000), "part PUT uses the five-minute timeout");
  assert.ok(
    timeoutDurations.includes(10 * 60_000),
    "server-owned upload control requests use the ten-minute timeout",
  );
});

test("S3 multipart resume starts at the server-authoritative contiguous offset", async () => {
  const size = S3_PART_SIZE + 5;
  const requestedParts = [];
  const uploadedSizes = [];
  const fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.endsWith("/api/v1/uploads/mpu-resume")) {
      return Response.json({
        id: "mpu-resume",
        formId: "f1",
        fieldId: "files",
        fileName: "upload.bin",
        size,
        mime: "APPLICATION/OCTET-STREAM",
        chunkSize: S3_PART_SIZE,
        uploadedBytes: S3_PART_SIZE,
        status: "uploading",
        transport: { type: "s3-multipart" },
      });
    }
    if (target.endsWith("/api/v1/uploads/mpu-resume/parts")) {
      assert.equal(init.headers["X-Fillo-Upload-Token"], "resume-secret");
      const { partNumber } = JSON.parse(init.body);
      requestedParts.push(partNumber);
      return Response.json({ uploadUrl: `https://storage.test/resume-${partNumber}` });
    }
    if (target.startsWith("https://storage.test/resume-")) {
      uploadedSizes.push(init.body.size);
      return new Response(null, { status: 200 });
    }
    if (target.endsWith("/api/v1/uploads/mpu-resume/complete")) {
      return Response.json({
        id: "mpu-resume",
        formId: "f1",
        fieldId: "files",
        fileName: "upload.bin",
        size,
        mime: "application/octet-stream",
        chunkSize: S3_PART_SIZE,
        uploadedBytes: size,
        status: "complete",
        file: { fileId: "resumed", name: "upload.bin", size, mime: "application/octet-stream" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const client = createClient({ baseUrl: "https://api.test", fetch });
  const file = await client.uploadFile("f1", new Blob([new Uint8Array(size)]), {
    fieldId: "files",
    sessionId: "mpu-resume",
    uploadToken: "resume-secret",
  });
  assert.equal(file.fileId, "resumed");
  assert.deepEqual(requestedParts, [2]);
  assert.deepEqual(uploadedSizes, [5]);
});

test("S3 multipart re-syncs an ambiguous failed PUT before uploading the next part", async () => {
  const size = S3_PART_SIZE + 1;
  const requestedParts = [];
  const storageCalls = [];
  let statusReads = 0;
  const fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.endsWith("/api/v1/forms/f1/uploads")) {
      return Response.json({
        id: "mpu-ambiguous",
        formId: "f1",
        fieldId: "files",
        fileName: "upload.bin",
        size,
        mime: "application/octet-stream",
        chunkSize: S3_PART_SIZE,
        uploadedBytes: 0,
        status: "pending",
        transport: { type: "s3-multipart" },
        token: "ambiguous-secret",
      });
    }
    if (target.endsWith("/api/v1/uploads/mpu-ambiguous/parts")) {
      const { partNumber } = JSON.parse(init.body);
      requestedParts.push(partNumber);
      return Response.json({ uploadUrl: `https://storage.test/ambiguous-${partNumber}` });
    }
    if (target === "https://storage.test/ambiguous-1") {
      storageCalls.push(1);
      throw new TypeError("connection closed after provider accepted the part");
    }
    if (target.endsWith("/api/v1/uploads/mpu-ambiguous")) {
      statusReads += 1;
      assert.equal(init.headers["X-Fillo-Upload-Token"], "ambiguous-secret");
      return Response.json({
        id: "mpu-ambiguous",
        formId: "f1",
        fieldId: "files",
        fileName: "upload.bin",
        size,
        mime: "application/octet-stream",
        chunkSize: S3_PART_SIZE,
        uploadedBytes: S3_PART_SIZE,
        status: "uploading",
        transport: { type: "s3-multipart" },
      });
    }
    if (target === "https://storage.test/ambiguous-2") {
      storageCalls.push(2);
      return new Response(null, { status: 200 });
    }
    if (target.endsWith("/api/v1/uploads/mpu-ambiguous/complete")) {
      return Response.json({
        id: "mpu-ambiguous",
        formId: "f1",
        fieldId: "files",
        fileName: "upload.bin",
        size,
        mime: "application/octet-stream",
        chunkSize: S3_PART_SIZE,
        uploadedBytes: size,
        status: "complete",
        file: { fileId: "ambiguous", name: "upload.bin", size, mime: "application/octet-stream" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const client = createClient({ baseUrl: "https://api.test", fetch });
  const file = await client.uploadFile("f1", new Blob([new Uint8Array(size)]), {
    fieldId: "files",
  });
  assert.equal(file.fileId, "ambiguous");
  assert.equal(statusReads, 1);
  assert.deepEqual(requestedParts, [1, 2], "the accepted first part was not overwritten");
  assert.deepEqual(storageCalls, [1, 2]);
});

test("zero-byte S3 multipart uploads skip part signing and finalize server-side", async () => {
  const calls = [];
  const progress = [];
  const fetch = async (url, init = {}) => {
    const target = String(url);
    calls.push(target);
    if (target.endsWith("/api/v1/forms/f1/uploads")) {
      return Response.json({
        id: "mpu-empty",
        formId: "f1",
        fieldId: "files",
        fileName: "upload.bin",
        size: 0,
        mime: "application/octet-stream",
        chunkSize: S3_PART_SIZE,
        uploadedBytes: 0,
        status: "pending",
        transport: { type: "s3-multipart" },
        token: "empty-secret",
      });
    }
    if (target.endsWith("/api/v1/uploads/mpu-empty/complete")) {
      assert.equal(init.headers["X-Fillo-Upload-Token"], "empty-secret");
      return Response.json({
        id: "mpu-empty",
        formId: "f1",
        fieldId: "files",
        fileName: "upload.bin",
        size: 0,
        mime: "application/octet-stream",
        chunkSize: S3_PART_SIZE,
        uploadedBytes: 0,
        status: "complete",
        file: { fileId: "empty", name: "upload.bin", size: 0, mime: "application/octet-stream" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const client = createClient({ baseUrl: "https://api.test", fetch });
  const file = await client.uploadFile("f1", new Blob([]), {
    fieldId: "files",
    onProgress: ({ uploadedBytes, fraction }) => progress.push({ uploadedBytes, fraction }),
  });
  assert.equal(file.fileId, "empty");
  assert.deepEqual(progress, [{ uploadedBytes: 0, fraction: 1 }]);
  assert.equal(calls.some((url) => url.endsWith("/parts")), false);
  assert.equal(calls.some((url) => url.startsWith("https://storage.test")), false);
});
