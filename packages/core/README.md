<p align="center">
  <a href="https://fillo.so">
    <img src="https://fillo.so/brand/readme-banner.png" alt="Fillo — forms inside your product, with your UI." />
  </a>
</p>

<p align="center">
  <a href="https://fillo.so/docs">Docs</a> ·
  <a href="https://fillo.so/guides">Guides</a> ·
  <a href="https://fillo.so/examples">Examples</a> ·
  <a href="https://fillo.so/changelog">Changelog</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@usefillo/core"><img src="https://img.shields.io/npm/v/@usefillo/core" alt="npm version" /></a>
  <img src="https://img.shields.io/npm/l/@usefillo/core" alt="MIT license" />
</p>

The framework-agnostic core of [Fillo](https://fillo.so) — forms that render **inside your own product**, with your UI, no iframe.

This package holds the shared foundation: the form schema, validation, the conditional-logic engine, response prefill/piping, and a JS client for provider-aware browser-direct uploads, with resume support where the storage provider offers it. It has **zero framework dependencies**.

Most apps don't install this directly — you install a renderer (**[@usefillo/react](https://www.npmjs.com/package/@usefillo/react)** or **[@usefillo/dom](https://www.npmjs.com/package/@usefillo/dom)**), which re-exports everything here you need for embedding. Reach for `@usefillo/core` when you're building your own renderer or working with forms on the server.

```sh
npm i @usefillo/core
```

```ts
import { createClient, defineForm, validateResponse, visibleBlocks } from "@usefillo/core";

const client = createClient({ key: "pk_…" }); // for syncing code-defined forms

const form = defineForm({
  id: "cust-feedback",
  pages: [{ id: "p1", blocks: [
    { id: "email", kind: "email", label: "Work email", required: true },
    { id: "msg", kind: "long_text", label: "What should we know?" },
  ] }],
});
```

Published renderer embeds can fetch by `formId` without a key. Use a client object for custom API origins, uploads, or submissions from your own renderer; add a publishable key only when syncing `defineForm()` schemas from code.

The full export surface — client methods, schema types, validation, conditional logic, appearance and localization contracts — is documented in the [API reference](https://fillo.so/docs/reference).

## Links

- **Docs:** [fillo.so/docs](https://fillo.so/docs)
- **Website:** [fillo.so](https://fillo.so)

MIT licensed.
