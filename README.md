<p align="center">
  <a href="https://fillo.so">
    <img src="https://fillo.so/brand/readme-banner.png" alt="Fillo — forms inside your product, with your UI." />
  </a>
</p>

<p align="center">
  <a href="https://fillo.so">Website</a> ·
  <a href="https://fillo.so/docs">Docs</a> ·
  <a href="https://fillo.so/agents">Agents</a> ·
  <a href="https://fillo.so/examples">Examples</a> ·
  <a href="https://fillo.so/changelog">Changelog</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@usefillo/react"><img src="https://img.shields.io/npm/v/@usefillo/react?label=%40usefillo%2Freact" alt="@usefillo/react npm version" /></a>
  <a href="https://www.npmjs.com/package/@usefillo/mcp"><img src="https://img.shields.io/npm/v/@usefillo/mcp?label=%40usefillo%2Fmcp" alt="@usefillo/mcp npm version" /></a>
  <img src="https://img.shields.io/npm/l/@usefillo/react" alt="MIT license" />
</p>

# Fillo SDKs

Fillo is headless form infrastructure. You build a form in the hosted editor or
define it in code, then render it **inside your own product** with your UI —
React, Vue, Svelte, Astro, or plain browser JavaScript — instead of dropping in
an iframe. One shared schema drives the builder, the renderers, API validation,
and the responses grid, so a form looks and behaves like part of your app.

Files go **browser-direct into storage you own** (Google Drive, Box, or an
S3-compatible bucket), resumable where the provider supports it. Responses land
in a schema-aware grid with search, file downloads, a detail drawer, and CSV
export, and can be delivered by signed webhooks, Google Sheets, Notion, Zapier,
or email.

This repository holds the public SDK packages and the coding-agent skill. The
product itself lives at **[fillo.so](https://fillo.so)**.

## Packages

| Package | npm | What it is |
| --- | --- | --- |
| `@usefillo/core` | [npm](https://www.npmjs.com/package/@usefillo/core) · [`packages/core`](packages/core) | Framework-agnostic form schema, validation, conditional-logic engine, prefill, formatting, JS client, and the browser-direct upload protocol. Zero framework dependencies. |
| `@usefillo/react` | [npm](https://www.npmjs.com/package/@usefillo/react) · [`packages/react`](packages/react) | Headless React renderer, hooks, upload UI, and an optional default stylesheet you can override or replace. |
| `@usefillo/dom` | [npm](https://www.npmjs.com/package/@usefillo/dom) · [`packages/dom`](packages/dom) | Framework-neutral DOM renderer, custom element, and a standalone browser bundle for Vue, Svelte, Astro, and vanilla apps. |
| `@usefillo/cli` | [npm](https://www.npmjs.com/package/@usefillo/cli) · [`packages/cli`](packages/cli) | `fillo` — start a workspace, stage and publish forms, and install the Agent Skill from your terminal. |
| `@usefillo/mcp` | [npm](https://www.npmjs.com/package/@usefillo/mcp) · [`packages/mcp`](packages/mcp) | MCP server — provision, scaffold, publish, and query forms from a coding agent. |

The canonical coding-agent skill (the same bundle the CLI installs) lives in
[`plugins/fillo/skills/build-with-fillo`](plugins/fillo/skills/build-with-fillo).
All packages are MIT licensed.

## Quickstart

Install a renderer and drop a published form into your app. `@usefillo/react`
and `@usefillo/dom` both re-export the parts of `@usefillo/core` you need, so you
rarely install core directly.

```tsx
// React / Next.js
import { FilloForm } from "@usefillo/react";
import "@usefillo/react/styles.css"; // optional default theme — or bring your own

<FilloForm formId="cust-feedback" onSubmitted={(responseId) => confetti()} />
```

```ts
// Vue, Svelte, Astro, or plain browser JavaScript
import { createClient, defineForm, renderForm } from "@usefillo/dom";
import "@usefillo/dom/styles.css";

const client = createClient({ key: "pk_live_…" });
const form = defineForm({
  id: "cust-feedback",
  pages: [{ id: "p1", blocks: [
    { id: "email", kind: "email", label: "Work email", required: true },
    { id: "message", kind: "long_text", label: "What should we know?" },
  ] }],
});

renderForm("#fillo-form", { form, client, onSubmitted: (id) => console.log(id) });
```

### Building with a coding agent

Fillo ships a provider-neutral Agent Skill that teaches your agent to build,
embed, style, sync, and verify a Fillo form. Install it into a project:

```sh
npx @usefillo/cli@latest skill install
```

Then point your agent at the setup flow. From a **Build with AI** handoff in the
product the CLI also prints a one-line `npx @usefillo/cli agent bootstrap …`
command that installs the skill and connects the live workspace in a single run.
See **[fillo.so/agents](https://fillo.so/agents)** for the full agent path and
**[fillo.so/docs](https://fillo.so/docs)** for the reference.

## Links

- Website — [fillo.so](https://fillo.so)
- Docs — [fillo.so/docs](https://fillo.so/docs)
- Agents — [fillo.so/agents](https://fillo.so/agents)
- Examples — [fillo.so/examples](https://fillo.so/examples)
- Changelog — [fillo.so/changelog](https://fillo.so/changelog)

## About this repository

This repo is a **read-only mirror** of the public SDK packages. They are
developed in a private monorepo and mirrored here on release, so the code you see
is the same code published to npm. History here is **disposable**: the mirror is
force-pushed by an automated job on every release, so don't fork from a specific
commit expecting it to stay put — depend on the npm packages instead.

Issues and questions are welcome here — see
[CONTRIBUTING.md](CONTRIBUTING.md). Pull requests against package code can't be
merged directly, since the source lives upstream; open an issue and we'll bring
the fix through the private repo.

> **Note on the account name.** This mirror currently lives at
> `github.com/jacobfunch/usefillo` while the `usefillo` GitHub organization is
> being claimed. Once it is, the repo will be transferred to the org; GitHub
> keeps the old path redirecting, so existing links and clones keep working.
