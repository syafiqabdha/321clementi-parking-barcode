import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import node from '@astrojs/node';

/**
 * Hostnames this deployment is served from.
 *
 * Turning on `output: 'server'` also turns on Astro's `security.checkOrigin`
 * CSRF middleware, which compares the browser's `Origin` header against the
 * request origin Astro derives from `x-forwarded-host`. Astro only trusts that
 * header when the hostname appears in `security.allowedDomains`; with the list
 * empty it silently falls back to the literal `localhost`, and every same-origin
 * `POST /api/v1/redemptions` from the real domain is rejected with
 * `403 Cross-site POST form submissions are forbidden`.
 *
 * Extend without a code change by setting ALLOWED_SITE_DOMAINS at build time,
 * e.g. ALLOWED_SITE_DOMAINS="321clementi.example.com,staging.example.com".
 */
const extraDomains = (process.env.ALLOWED_SITE_DOMAINS ?? '')
  .split(',')
  .map((d) => d.trim())
  .filter(Boolean)
  .map((entry) => {
    // Protocol-agnostic by default. The proxy in front of this container
    // (cloudflared → Traefik → web) may present the request as plain http even
    // when the shopper used https, and Astro derives the CSRF origin from
    // `x-forwarded-proto`/`x-forwarded-host`. Pinning `protocol: 'https'` here
    // makes that comparison fail and returns
    // `403 Cross-site POST form submissions are forbidden` on every redemption.
    // An explicit scheme in the env value is still honoured.
    const [scheme, host] = entry.includes('://') ? entry.split('://') : [undefined, entry];
    return scheme ? { hostname: host, protocol: scheme } : { hostname: host };
  });

// Branch note (the `vercel` deployment branch): this branch IS the Vercel target,
// so the default flips to `vercel` — Vercel runs a bare `bun run build` and must
// not depend on a dashboard env var to pick the right adapter. `main` keeps
// `node` as its default (Coolify/Docker), and the Dockerfile pins
// DEPLOY_TARGET=node, so the container path is unaffected on either branch.
const target = process.env.DEPLOY_TARGET ?? 'vercel';

const allowedDomains = [
  // The exact production hostname(s) from ALLOWED_SITE_DOMAINS (§Pre-flight),
  // protocol-agnostic per the comment above.
  ...extraDomains,
  // Vercel preview aliases only when that target is actually being built. A
  // wildcard here would widen the CSRF allowlist of the production image.
  ...(target === 'vercel' ? [{ hostname: '*.vercel.app', protocol: 'https' }] : []),
  // `bun run dev` / `astro preview` on http://localhost:4321 and the
  // `docker compose` smoke test — protocol-agnostic so local http keeps working.
  { hostname: 'localhost' },
  { hostname: '127.0.0.1' },
];

// The five API routes under src/pages/api/** are request-time handlers (DB
// access, Gemini Vision). Without `output: 'server'` plus
// an adapter Astro prerenders them at build time: `astro build` emits empty
// response bodies for `/api/v1/redemptions` and friends, and the deployment
// then serves those frozen build-time responses instead of running the handler.
//
// The container build uses the Node standalone adapter (DEPLOY_TARGET=node, the
// Dockerfile default). DEPLOY_TARGET=vercel uses the Vercel adapter when
// `@astrojs/vercel` is installed, so one config serves both targets.
// (`target` is resolved above, before allowedDomains needs it.)
let adapter;
if (target === 'vercel') {
  const { default: vercel } = await import('@astrojs/vercel');
  // Gemini Vision receipt verification on a full-size receipt photo can take
  // longer than the Vercel default function timeout.
  adapter = vercel({ maxDuration: 30 });
} else if (target === 'node') {
  // Standalone emits dist/server/entry.mjs — a self-hosted HTTP server, which
  // is what the Dockerfile CMD runs.
  adapter = node({ mode: 'standalone' });
} else {
  throw new Error(
    `Unknown DEPLOY_TARGET "${target}". Use "node" (Coolify/Docker) or "vercel".`
  );
}

// https://astro.build/config
export default defineConfig({
  output: 'server',
  security: {
    // Keep the CSRF origin check on (the redemption, unclaim and admin
    // endpoints are form/JSON POSTs) — it just needs to know its own hostnames.
    checkOrigin: true,
    allowedDomains,
  },
  adapter,
  integrations: [
    tailwind({
      applyBaseStyles: false,
    }),
  ],
  vite: {
    build: {
      rollupOptions: {
        // src/db/connection.ts imports Bun's SQL client. The migration runner
        // and the container runtime both execute under Bun, so the specifier
        // stays external and is resolved at runtime.
        external: ['bun'],
      },
    },
  },
});
