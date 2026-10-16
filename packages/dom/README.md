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
  <a href="https://www.npmjs.com/package/@usefillo/dom"><img src="https://img.shields.io/npm/v/@usefillo/dom" alt="npm version" /></a>
  <img src="https://img.shields.io/npm/l/@usefillo/dom" alt="MIT license" />
</p>

Framework-agnostic DOM renderer, web component, and standalone browser bundle for [Fillo](https://fillo.so) — forms that render **inside your own product**, no iframe. Use it with Vue, Svelte, Astro, or plain browser JavaScript.

```sh
npm i @usefillo/dom
```

```ts
import { renderForm } from "@usefillo/dom";
import "@usefillo/dom/styles.css"; // optional default theme — or bring your own

renderForm("#fillo-form", {
  formId: "cust-feedback",
  onSubmitted: (id) => console.log("response", id),
});
```

Published `formId` embeds can fetch and submit without a publishable key. Use `createClient({ key })` only when syncing code-defined schemas, or when you need to point the SDK at a custom API origin.

```ts
import { createClient, defineForm, renderForm } from "@usefillo/dom";

const client = createClient({ key: "pk_…" }); // Settings → Code-defined forms
const form = defineForm({
  id: "cust-feedback",
  pages: [{ id: "p1", blocks: [
    { id: "email", kind: "email", label: "Work email", required: true },
    { id: "msg", kind: "long_text", label: "What should we know?" },
  ] }],
});

renderForm("#fillo-form", {
  form,
  client,
  onSubmitted: (id) => console.log("response", id),
});
```

Or drop it in with a single script tag — the bundle exposes a global `Fillo`:

```html
<div id="fillo-form"></div>
<script src="https://unpkg.com/@usefillo/dom/dist/standalone.global.js"></script>
<script>
  const client = Fillo.createClient({ key: "pk_…" });
  const form = Fillo.defineForm({ id: "cust-feedback", pages: [/* … */] });
  Fillo.renderForm("#fillo-form", { form, client });
</script>
```

The default stylesheet inherits the host page's CSS `color-scheme` and font. If your theme switch only toggles a class or data attribute, pass its resolved mode as `theme: { colorScheme: "light" | "dark" }`. Use `"auto"` only for a deliberately system-driven page. A fixed hex `background` automatically selects a readable palette unless you explicitly choose one.

Every rendered part carries `data-*` state attributes (`data-selected`, `data-invalid`, …) for utility CSS, and the default stylesheet is cascade-layered so your own styles win. On Tailwind v3 or reset-heavy sites import `@usefillo/dom/styles.unlayered.css` instead. Styling contract: [fillo.so/docs/styling](https://fillo.so/docs/styling).

## Links

- **Docs:** [fillo.so/docs](https://fillo.so/docs)
- **Website:** [fillo.so](https://fillo.so)

MIT licensed.
