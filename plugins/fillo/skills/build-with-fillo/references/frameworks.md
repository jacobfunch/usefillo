# Framework integration

Confirm imports and prop shapes against the installed package types. Use the
host framework's lifecycle and styling conventions.

## React and Next.js

Render an existing published form from a Client Component:

```tsx
"use client";

import { FilloForm } from "@usefillo/react";
import "@usefillo/react/styles.css";

export function CustomerIntake() {
  return <FilloForm formId="customer-intake" />;
}
```

Author a code-defined form with JSX when the app should own the schema:

```tsx
"use client";

import { createClient, Fillo } from "@usefillo/react";
import "@usefillo/react/styles.css";

const client = createClient({ key: process.env.NEXT_PUBLIC_FILLO_KEY! });

export function CustomerIntake() {
  return (
    <Fillo.Form id="customer-intake" title="Customer intake" client={client}>
      <Fillo.Email id="email" label="Work email" required />
      <Fillo.LongText id="goal" label="What should we know?" />
    </Fillo.Form>
  );
}
```

Keep Fillo JSX schema authoring in a `"use client"` module. `onSubmitted` is
for navigation, analytics, or another host-side follow-up after storage; it is
not the response transport.

The identity combinations are intentional and exhaustive:

```tsx
// Published/dashboard/CLI-owned schema.
<FilloForm formId={actualReturnedFormId} />

// Inline snapshot of that same published form.
<FilloForm form={schema} formId={actualReturnedFormId} />

// App-owned schema with a stable defineForm() identity.
<FilloForm form={codeForm} client={client} />

// Deliberately local UI preview: cannot submit, upload, or save progress.
<FilloForm form={schema} renderOnly />
```

Never use `<FilloForm form={plainSchema} client={client} />`. A plain schema
has no stable Fillo identity, so the client cannot know which form owns its
responses or uploads. Current SDK types reject this combination and the
runtime reports `form_target_required` for JavaScript callers.

## Vite apps

Vite exposes only `VITE_`-prefixed env vars to browser code, through
`import.meta.env` rather than `process.env`. Outside Next.js, skip the
`"use client"` directive:

```ts
const client = createClient({ key: import.meta.env.VITE_FILLO_KEY });
```

Under a strict tsconfig, declare the key once in `src/vite-env.d.ts`:

```ts
/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_FILLO_KEY: string;
}
```

Restart the dev server after changing `.env` values.

## DOM, Vue, Svelte, Astro, and browser apps

Mount after the target exists and destroy the instance on unmount:

```ts
import { renderForm } from "@usefillo/dom";
import "@usefillo/dom/styles.css";

const instance = renderForm("#customer-intake", {
  formId: "customer-intake",
  onSubmitted: (responseId) => console.log("response", responseId),
  onError: (error) => console.error(error.status, error.message),
});

// Call from onBeforeUnmount, onDestroy, or the host cleanup callback.
instance.destroy();
```

Use `defineForm()` plus a client for a code-owned schema. In a Svelte scoped
`<style>`, wrap renderer selectors with `:global(...)` so styles reach the
imperatively inserted DOM.

Register the custom element once in browser code when that fits the host:

```ts
import { registerFilloElement } from "@usefillo/dom";
import "@usefillo/dom/styles.css";

registerFilloElement();
```

```html
<fillo-form form-id="customer-intake"></fillo-form>
```

Listen for `fillo-change`, `fillo-submit`, and `fillo-error` when the host needs
custom event handling.

## Developer chrome on staging and tunnels

On localhost and dev builds the renderers show developer chrome automatically:
draft/staged/sync notices, developer-grade submit failures with the machine
code and connect-storage link, and upload-field pre-emption while storage is
unconnected. On a tunnel, staging deploy, or local production build that
chrome stays quiet; opt in with the cosmetic-only `preview` flag:

```tsx
<FilloForm form={feedbackCodeForm} client={client}
  preview={process.env.NEXT_PUBLIC_STAGE !== "production"} />
```

DOM equivalents: `renderForm(el, { form: feedbackCodeForm, client, preview: true })` or
`<fillo-form data-preview>`. `data-preview="false"` and `data-preview="0"`
count as off (frameworks stringify booleans onto data-* attributes); any other
presence is on. `preview` renders a visible "Preview" badge and
never changes where submissions go or whether they are accepted — test
submissions authenticate with a credential, never a prop. Remove it before
respondents see the page. Pass `devNotices={false}` (`devNotices: false` in
DOM) when the page provides its own context; the badge stays.

`preview` is only developer chrome; it does not make a transportless form
valid. Use `renderOnly` (or `<fillo-form data-render-only>`) when the surface is
intentionally local and must not submit or upload.

## Styling and custom UI

Use the lowest-control surface that satisfies the request:

1. Default CSS for a working accessible renderer.
2. `theme`, React `appearance`, and stable `.fillo-*` selectors to match the
   host product.
3. Custom fields for one specialized control.
4. `FilloProvider`, `FormField`, and hooks in React, or
   `createFormController()` elsewhere, only when the host will render every
   field, error, page action, loading state, and success state.

Keep CSS scoped to the embed. Do not add Tailwind or app-global assumptions to
the Fillo packages. Preserve visible focus, labels, descriptions, error
association, disabled states, and touch targets while restyling.

Set the renderer's color scheme from the surface it actually sits on:

```tsx
// Default: inherit the host's CSS color-scheme and font.
<FilloForm formId="customer-intake" />

// Class-based theme providers must pass their resolved state if they do not
// also set CSS color-scheme on the page.
<FilloForm
  formId="customer-intake"
  theme={{ colorScheme: resolvedTheme === "dark" ? "dark" : "light" }}
/>
```

Use `"auto"` only for a page that deliberately follows
`prefers-color-scheme`. A fixed hex `background` selects a matching readable
control palette. Color mode is only the first layer: map the host's semantic
surface, text, muted, border, control, accent, radius, font, and focus tokens
through `theme`, `appearance`, or scoped `.fillo-*` variables. Compare the
result beside an existing host form in every supported theme and at a narrow
width; do not sign off from an isolated renderer preview.
