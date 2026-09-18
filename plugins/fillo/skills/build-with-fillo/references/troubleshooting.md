# Troubleshooting

Confirm the exact error and installed package version before changing code.

| Symptom | First checks |
| --- | --- |
| Published-id embed returns 404 | Confirm the id or slug and that the form is published. Do not reveal whether an inaccessible draft exists. |
| Code-defined form renders but cannot save | Pass a client, keep a stable id, verify the key belongs to the intended project, and check expected-origin restrictions. |
| `form_target_required` or the embed renders unavailable while the hosted page works | The host app rendered a plain schema without a submission identity. Pass the actual returned `formId`, or use `defineForm()` plus a client. Use `renderOnly` only for a deliberate non-submitting preview. Verify the app route exposes the same id in `data-fillo-form-id`. |
| Publishable key is `undefined` in a Vite app | Read `import.meta.env.VITE_FILLO_KEY`, not `process.env`; declare it in `src/vite-env.d.ts` under strict TypeScript and restart the dev server after `.env` changes. |
| Schema write reports `trusted_sync_required` | Log in and use `fillo push --stage`, or use a server-held `FILLO_SYNC_TOKEN`. Do not weaken the project policy. |
| `fillo push --stage` has nothing to stage | The published schema already matches; do not create another form. |
| 429 response | Respect `FilloError.retryAfterSec`; do not loop immediate retries. |
| File form cannot publish | Connect supported storage and verify the provider before retrying publish. |
| Test submit only says "This form is unavailable." | Run on localhost, or set the cosmetic-only `preview` prop / `data-preview` attribute: dev chrome shows the real failure with its machine code (for example `form_not_published`) and the connect-storage link. |
| Upload field says "Connect file storage to enable uploads" | Expected dev-chrome pre-emption: sync reported `storage_required`. Open the linked storage settings, connect a destination, then publish. |
| Upload field says uploads are unavailable in a render-only preview | The embed explicitly disabled transport. Remove `renderOnly` and provide a real identity path before testing uploads. |
| DOM form duplicates after navigation | Mount after the target exists and call `destroy()` in cleanup. |
| React context or hook error | Keep hooks inside `FilloForm` or `FilloProvider` and check for two installed copies of `@usefillo/react`. |
| Fillo JSX fails in Next.js | Move schema JSX to a `"use client"` module; use object-form `defineForm()` for framework-neutral schema. |
| Conditional JSX causes repeated drafts | Keep every field in the stable schema and express logic through `visibleIf`. |
| Webhook signature never matches | Capture raw bytes before JSON middleware and compare the hex HMAC in constant time. |
| Verified identity remains anonymous | Hash the exact stable `respondent.id` string on the server with the secret from the same project. |

Do not claim a successful publish, upload, submission, webhook, or destination
delivery unless the environment produced direct evidence.
