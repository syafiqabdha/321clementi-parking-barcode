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
    // Default to https — these are real deployment hostnames. An explicit
    // scheme is honoured so a plain-http staging host stays possible.
    const [scheme, host] = entry.includes('://') ? entry.split('://') : ['https', entry];
    return { hostname: host, protocol: scheme };
  });

const allowedDomains = [
  // Production + preview hosts behind Cloudflare Tunnel / Coolify's proxy.
  { hostname: '*.pancatz.com', protocol: 'https' },
  { hostname: 'pancatz.com', protocol: 'https' },
  // Vercel preview aliases, kept so the Vercel build target still works.
  { hostname: '*.vercel.app', protocol: 'https' },
  // `bun run dev` / `astro preview` on http://localhost:4321 and a plain
  // `docker compose up` smoke test — left protocol-agnostic so local http
  // keeps working.
  { hostname: 'localhost' },
  { hostname: '127.0.0.1' },
  ...extraDomains,
];

// The five API routes under src/pages/api/** are request-time handlers (DB
// access, Turnstile siteverify, Gemini Vision). Without `output: 'server'` plus
// an adapter Astro prerenders them at build time: `astro build` emits empty
// response bodies for `/api/v1/redemptions` and friends, and the deployment
// then serves those frozen build-time responses instead of running the handler.
//
// The container build uses the Node standalone adapter (DEPLOY_TARGET=node, the
// Dockerfile default). DEPLOY_TARGET=vercel uses the Vercel adapter when
// `@astrojs/vercel` is installed, so one config serves both targets.
const target = process.env.DEPLOY_TARGET ?? 'node';

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
