import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Atomically replace an output only after the entire bounded stream succeeds. */
export async function writeExport(
  body: ReadableStream<Uint8Array>,
  path?: string,
  policy: { idleMs?: number; totalMs?: number } = {},
): Promise<number> {
  const idleMs = policy.idleMs ?? 60_000;
  const totalMs = policy.totalMs ?? 10 * 60_000;
  const temporary = path ? `${path}.fillo-export-${randomUUID()}.tmp` : undefined;
  const target = temporary
    ? createWriteStream(temporary, { flags: "wx", mode: 0o600 })
    : process.stdout;
  const reader = body.getReader();
  const controller = new AbortController();
  const total = setTimeout(
    () => controller.abort(new Error("Response export exceeded its total time limit.")),
    totalMs,
  );
  const cancel = () => {
    void reader.cancel(controller.signal.reason).catch(() => {});
  };
  controller.signal.addEventListener("abort", cancel, { once: true });
  let bytes = 0;
  async function* chunks() {
    for (;;) {
      let idle: ReturnType<typeof setTimeout> | undefined;
      try {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) => {
            idle = setTimeout(
              () => reject(new Error("Response export stopped sending data.")),
              idleMs,
            );
          }),
        ]);
        if (chunk.done) return;
        bytes += chunk.value.byteLength;
        yield Buffer.from(chunk.value);
      } finally {
        clearTimeout(idle);
      }
    }
  }
  try {
    await pipeline(Readable.from(chunks()), target, {
      signal: controller.signal,
      end: Boolean(path),
    });
    if (temporary && path) await rename(temporary, path);
    return bytes;
  } finally {
    clearTimeout(total);
    controller.signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => {});
    if (temporary) await rm(temporary, { force: true });
  }
}
