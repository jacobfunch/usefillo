// Module-scoped ambient: browser bundles have no @types/node, and consumer
// bundlers statically replace the literal `process.env.NODE_ENV` at build time.
declare const process: { env?: Record<string, string | undefined> } | undefined;

/**
 * Hostnames that only ever point at the developer's own machine: `localhost`
 * (and `*.localhost`), any IPv4 loopback address (`127.0.0.0/8`), IPv6
 * loopback (`::1`, which `location.hostname` reports bracketed as `[::1]`),
 * and the `0.0.0.0` all-interfaces address dev servers print. mDNS `*.local`
 * names are deliberately NOT local: Bonjour advertises every macOS machine as
 * `<name>.local` and intranet kiosks resolve those names, so they are a real
 * production serving surface. Private-LAN ranges (`192.168.*`, `10.*`) are
 * likewise NOT treated as local: kiosks and intranet deployments serve real
 * respondents from those addresses, and calling them "development" would swap
 * production fail-closed states for dev banners on live forms.
 */
function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    // Loopback ADDRESSES only — anchored so `127.0.0.1.example.com` stays a
    // real (production) hostname.
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    host === "::1" ||
    host === "[::1]" ||
    host === "0.0.0.0"
  );
}

/**
 * The build-time half of the dev check: `NODE_ENV` alone, no hostname
 * inspection. It evaluates identically on the server and in the browser for
 * the same bundle, which is what SSR hydration needs — the server has no
 * `window`, so a hostname-aware check would disagree with the client's first
 * paint. Renderers use this as the server/hydration snapshot and upgrade to
 * {@link isLikelyDevEnv} after hydration.
 */
export function isBuildTimeDevEnv(): boolean {
  return typeof process !== "undefined" && process.env?.NODE_ENV !== "production";
}

/**
 * Whether this runtime looks like local development, so renderers can show
 * actionable dev surfaces (draft banner, missing-client warning, local schema
 * render) instead of the deliberately quiet production states.
 *
 * The build-time `NODE_ENV` signal alone misses real local setups: the
 * standalone `<script>` bundle has no `process` at all (so it always read as
 * production), `vite preview` / `next start` serve a production build on
 * localhost, and some bundlers never define `NODE_ENV`. So a browser whose
 * hostname is localhost/loopback also counts as development. Real
 * deployments keep production semantics because they serve from real
 * hostnames — see {@link isLocalHostname} for why mDNS `*.local` names and
 * private-LAN addresses are deliberately excluded.
 *
 * SSR-safe to CALL (with no `window`, only the `NODE_ENV` check applies), but
 * NOT hydration-safe for render output: the server pass can't see the page
 * hostname, so under `next start` on localhost it disagrees with the client.
 * Render paths should hydrate from {@link isBuildTimeDevEnv} and upgrade to
 * this check after hydration (see the React renderer's useIsDevEnv()).
 */
export function isLikelyDevEnv(): boolean {
  if (isBuildTimeDevEnv()) return true;
  if (typeof window === "undefined") return false;
  const hostname = window.location?.hostname;
  return typeof hostname === "string" && isLocalHostname(hostname);
}
