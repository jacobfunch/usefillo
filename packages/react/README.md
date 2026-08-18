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
  <a href="https://www.npmjs.com/package/@usefillo/react"><img src="https://img.shields.io/npm/v/@usefillo/react" alt="npm version" /></a>
  <img src="https://img.shields.io/npm/l/@usefillo/react" alt="MIT license" />
</p>

React components and hooks for embedding [Fillo](https://fillo.so) forms **natively inside your product** — rendered in your own DOM, with your styles, on your route. No iframe.

```sh
npm i @usefillo/react
```

`react` and `react-dom` (18 or 19) are peer dependencies.

The default stylesheet inherits the host page's CSS `color-scheme` and font. If your theme provider only toggles a class or data attribute, pass its resolved mode as `theme={{ colorScheme: "light" | "dark" }}`. Use `"auto"` only for a deliberately system-driven page. A fixed hex `background` automatically selects a readable palette unless you explicitly choose one.

## Write forms as components

```tsx
"use client";
import { Fillo, when, createClient } from "@usefillo/react";
import "@usefillo/react/styles.css"; // optional default theme — or bring your own

const client = createClient({ key: process.env.NEXT_PUBLIC_FILLO_KEY });

export function ContactForm() {
  return (
    <Fillo.Form id="contact" title="Talk to us" client={client}>
      <Fillo.Text id="name" label="Your name" required />
      <Fillo.Email id="email" label="Work email" required />
      <Fillo.Select id="topic" label="Topic" required>
        <Fillo.Option id="sales" label="Sales" />
        <Fillo.Option id="support" label="Support" />
      </Fillo.Select>
      <Fillo.LongText id="message" label="How can we help?"
                      visibleIf={when("topic").eq("support")} />
    </Fillo.Form>
  );
}
```

The first time this runs, the form appears in your Fillo workspace as a draft —
publish it there and responses, exports, webhooks, and integrations all work.
Prefer config over JSX? `defineForm({ id, pages })` is first-class — JSX
compiles to it exactly. Authoring guide:
[fillo.so/docs/authoring](https://fillo.so/docs/authoring).

## Or embed a form built in the dashboard

```tsx
import { FilloForm } from "@usefillo/react";

<FilloForm formId="cust-feedback" onSubmitted={(r) => confetti()} />
```

## Style it with your own classes

```tsx
<Fillo.Form
  id="contact"
  client={client}
  appearance={{
    theme: { primary: "#4f46e5", radius: "12px" }, // also themes your hosted page
    classNames: {
      control: "rounded-xl border-zinc-200 data-[invalid]:border-red-400",
      option: "rounded-lg border p-3 data-[selected]:border-indigo-600",
      button: (s) => (s.variant === "primary" ? "bg-indigo-600 text-white" : ""),
    },
    fields: { nps: { control: "grid grid-cols-11 gap-1" } },
  }}
>
```

Every rendered part carries a named slot and state attributes
(`data-invalid`, `data-selected`, …), and the default stylesheet is
cascade-layered so your utilities always win. Styling contract:
[fillo.so/docs/styling](https://fillo.so/docs/styling).

## Go fully headless

Every part is replaceable — and every embed method is free:

- `components` / `customComponents` — swap any field kind for your own
- `<FilloProvider>` + `<FormField>` / `useField()` — your layout, Fillo's engine
- `useFilloController()` — the bare engine for total control

Headless guide: [fillo.so/docs/custom-ui](https://fillo.so/docs/custom-ui).

## Links

- **Docs:** [fillo.so/docs](https://fillo.so/docs)
- **Authoring guide:** [fillo.so/docs/authoring](https://fillo.so/docs/authoring)
- **Website:** [fillo.so](https://fillo.so)

MIT licensed.
