import { writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { api, readJson, requireToken } from "../lib/api.js";
import { type Flags, flagString } from "../lib/flags.js";
import { bold, die, dim, emitResult, jsonMode, okMark, terminalText } from "../lib/output.js";
import type { Command } from "../lib/registry.js";

/**
 * `fillo pull <form> [--out file]` — read a form's current definition back out
 * of Fillo in the exact shape `fillo push` accepts, so a form built or edited in
 * the dashboard can be taken into code (and reviewed in a diff) without copying
 * JSON out of a browser.
 *
 * What comes back is the newest editable revision: the staged draft when one is
 * waiting, otherwise the published definition — the same thing the dashboard
 * would open in the builder.
 */

type PulledForm = {
  id: string;
  handle: string | null;
  name: string;
  slug: string;
  status: "draft" | "published";
  managed: "builder" | "code";
  purpose: "file_request" | null;
  storage: "gdrive" | "box" | "s3" | "r2" | null;
  schema: unknown;
  theme: unknown;
  draftSchema: unknown;
  draftTheme: unknown;
  revision: "draft" | "published";
};

/** The `fillo push` item: exactly the keys that lane reads back. */
function pushItem(form: PulledForm) {
  const staged = form.revision === "draft";
  return {
    // `push` addresses forms by their code handle; a form that has never been
    // code-managed has none, so its id seeds one.
    id: form.handle ?? form.id,
    schema: staged ? form.draftSchema : form.schema,
    theme: (staged ? form.draftTheme : form.theme) ?? null,
    ...(form.storage ? { storage: form.storage } : {}),
    ...(form.purpose ? { purpose: form.purpose } : {}),
  };
}

async function pull(handle: string | undefined, flags: Flags) {
  const json = jsonMode(flags);
  if (!handle) die("Usage: fillo pull <form> [--out form.json]");
  const out = flagString(flags, "out");
  if (out !== undefined && !out.endsWith(".json")) {
    die("--out must be a .json path — `fillo push` reads JSON schemas.");
  }

  const res = await api(`/cli/forms/${encodeURIComponent(handle)}?include=schema`, {
    token: requireToken(),
  });
  if (res.status === 401) die("Token invalid — run `fillo login` again.");
  if (res.status === 410) die("This form is being deleted.");
  if (res.status === 404) {
    // An older deployment without `include=schema` serves Next's HTML 404 for
    // an unknown route — don't read that as "the form doesn't exist".
    try {
      JSON.parse(await res.text());
    } catch {
      die(
        "This Fillo server does not support `fillo pull` yet. Update the deployment, then retry.",
      );
    }
    die(
      `No form matches "${terminalText(handle)}" in this workspace. Run \`fillo list\` to see its forms.`,
    );
  }
  const body = (await readJson(res)) as Partial<PulledForm> & { error?: string };
  const form = res.ok && body.id ? (body as PulledForm) : undefined;
  if (!form?.schema) die(body.error ?? `pull failed (${res.status}).`);
  const item = pushItem(form);
  const document = `${JSON.stringify(item, null, 2)}\n`;

  let file: string | null = null;
  if (out) {
    file = isAbsolute(out) ? out : resolve(process.cwd(), out);
    try {
      writeFileSync(file, document);
    } catch (error) {
      die(`Couldn't write ${terminalText(out)}: ${(error as Error).message}`);
    }
  }

  if (json) {
    return emitResult({
      file,
      revision: form.revision,
      managed: form.managed,
      form: item,
    });
  }
  if (!out) {
    // No destination named: the document itself is the output, so
    // `fillo pull <form> > form.json` works and nothing else pollutes stdout.
    process.stdout.write(document);
    return;
  }
  console.log(`\n  ${okMark()} Wrote ${bold(terminalText(out))}  ${dim(form.id)}`);
  console.log(
    `  ${dim(
      form.revision === "draft"
        ? "The staged revision (newer than what is live)."
        : "The published revision.",
    )}`,
  );
  if (form.managed === "builder") {
    // Pushing this file creates a SEPARATE code-managed form, because push
    // addresses forms by code handle and this one has none yet. Say so before
    // an agent discovers it as a duplicate in the dashboard.
    console.log(
      `  ${bold("Note:")} This form is managed in the dashboard. Move it to code from its Overview page` +
        " before pushing, or `fillo push` will create a second, code-managed form.",
    );
  } else {
    console.log(`  ${dim(`Push it back with: fillo push ${terminalText(out)}`)}`);
  }
  console.log("");
}

export const pullCommand: Command = {
  name: "pull",
  flags: ["out"],
  run: (args, flags) => pull(args[0], flags),
};
