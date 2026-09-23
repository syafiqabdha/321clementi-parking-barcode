import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import vercel from '@astrojs/vercel';

/**
 * Hostnames the deployment is served from. Astro only trusts the
 * `x-forwarded-host` header (which Vercel sets to the real host) when the
 * hostname appears here; with the default empty list it silently falls back to
 * the literal `localhost` as the request origin.
 *
 * That matters because turning on `output: 'server'` also turns on Astro's
 * `security.checkOrigin` CSRF middleware, which compares the browser's `Origin`
 * header against that derived origin. With an empty list every same-origin
 * `POST /api/v1/redemptions` from a real domain is rejected with
 * `403 Cross-site POST form submissions are forbidden`.
 *
 * Verified against the built function: with this list empty only
 * `Origin: https://localhost` is accepted; every real origin 403s.
 *
 * Extend without a code change by setting ALLOWED_SITE_DOMAINS at build time,
 * e.g. ALLOWED_SITE_DOMAINS="321clementi.example.com,staging.example.com".
 */
const extraDomains = (process.env.ALLOWED_SITE_DOMAINS ?? '')
  .split(',')
  .map((d) => d.trim())
  .filter(Boolean)
  .map((hostname) => ({ hostname }));

const allowedDomains = [
  // Production + preview deployments (*.vercel.app matches a single subdomain
  // label, which is what Vercel assigns).
  { hostname: '*.vercel.app' },
  // PandaTZ self-hosted services; covers a custom 321clementi.<domain> later.
  { hostname: '*.pancatz.com' },
  { hostname: 'pancatz.com' },
  // `bun run dev` / `astro preview` on http://localhost:4321
  { hostname: 'localhost' },
  { hostname: '127.0.0.1' },
  ...extraDomains,
];

// https://astro.build/config
export default defineConfig({
  // The five API routes under src/pages/api/** are request-time handlers (DB
  // access, Turnstile siteverify, Gemini Vision). Without `output: 'server'`
  // plus an adapter Astro prerenders them at build time and Vercel serves the
  // frozen build-time response instead of running the handler.
  output: 'server',
  security: {
    // Keep the CSRF origin check on (the redemption, unclaim and admin
    // endpoints are form/JSON POSTs) — it just needs to know its own hostnames.
    checkOrigin: true,
    allowedDomains,
  },
  adapter: vercel({
    // Gemini Vision receipt verification on a full-size receipt photo can take
    // longer than the Vercel default function timeout.
    maxDuration: 30,
  }),
  integrations: [
    tailwind({
      applyBaseStyles: false,
    }),
  ],
  vite: {
    build: {
      rollupOptions: {
        // scripts/migrate.ts imports Bun's SQL client. It is a local/CI
        // migration runner, not part of the web app — keep it out of the
        // Vercel function bundle.
        external: ['bun'],
      },
    },
  },
});
