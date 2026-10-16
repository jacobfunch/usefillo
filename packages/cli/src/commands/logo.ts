import { readFileSync, statSync } from "node:fs";
import { callApi, failed } from "../lib/api.js";
import type { Flags } from "../lib/flags.js";
import {
  bold,
  boldRaw,
  die,
  dim,
  dimRaw,
  emitResult,
  jsonMode,
  okMark,
  terminalText,
} from "../lib/output.js";
import type { Command } from "../lib/registry.js";

/**
 * `fillo logo <file|https-url>` — add an image to the workspace for a form
 * theme's `logo` (or `dark.logo`), the twin of the Design panel's upload. A
 * local file is sent as base64; an https URL is downloaded by Fillo. The
 * server sniffs the bytes and keeps only PNG, JPEG, or WebP up to 512 KB, so
 * the local size check below only saves a pointless upload.
 */

const LOGO_MAX_BYTES = 512 * 1024;

type ImageBody = {
  id: string;
  contentType: string;
  size: number;
  path: string;
  url?: string;
  error?: string;
};

function readLocalImage(path: string): Buffer {
  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) die(`${terminalText(path)} is not a file.`);
    size = stat.size;
  } catch {
    die(`Couldn't read ${terminalText(path)}.`);
  }
  if (size > LOGO_MAX_BYTES) {
    die(
      `${terminalText(path)} is ${Math.ceil(size / 1024)} KB — logos can be up to ${LOGO_MAX_BYTES / 1024} KB.`,
    );
  }
  try {
    return readFileSync(path);
  } catch {
    die(`Couldn't read ${terminalText(path)}.`);
  }
}

async function logo(source: string | undefined, flags: Flags) {
  if (source === "help") return logoHelp();
  if (source === undefined) die("Usage: fillo logo <file|https-url>");

  let body: { url: string } | { data: string };
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(source)) {
    if (!/^https:\/\//iu.test(source)) die("Logo URLs must be https.");
    body = { url: source };
  } else {
    body = { data: readLocalImage(source).toString("base64") };
  }

  const image = await callApi<ImageBody>(
    "/cli/assets",
    { method: "POST", body: JSON.stringify(body) },
    { fallback: failed("logo"), expect: (b) => typeof b.id === "string" },
  );
  if (jsonMode(flags)) return emitResult(image);
  console.log("");
  // The id comes from the server: strip terminal control sequences like every
  // other server-supplied string the CLI prints.
  const id = terminalText(image.id);
  console.log(`  ${okMark()} Logo added: ${bold(id)}`);
  console.log(
    dim(
      `  Set "logo": "${id}" in the form's theme (or "dark": { "logo": … } for dark mode), then run \`fillo push\`.`,
    ),
  );
  console.log("");
}

function logoHelp() {
  console.log(`
  ${boldRaw("fillo logo")} — add a logo image for a form's hosted page

  ${boldRaw("Usage")}
    logo <file>        Upload a local PNG, JPEG, or WebP (up to 512 KB)
    logo <https-url>   Let Fillo download it from a public https URL

  ${dimRaw('Prints an image id. Put it in the form\'s theme as "logo" (or')}
  ${dimRaw('"dark": { "logo": … } for dark mode) and run fillo push.')}
  ${dimRaw("SVG is not accepted. The same image twice returns the same id.")}
  ${dimRaw("--json prints the raw server response on stdout.")}
`);
}

export const logoCommand: Command = {
  name: "logo",
  flags: [],
  run: (args, flags) => logo(args[0], flags),
  help: logoHelp,
};
