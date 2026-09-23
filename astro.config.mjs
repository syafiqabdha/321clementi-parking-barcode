import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import vercel from '@astrojs/vercel';

// https://astro.build/config
export default defineConfig({
  // The five API routes under src/pages/api/** are request-time handlers (DB
  // access, Turnstile siteverify, Gemini Vision). Without `output: 'server'`
  // plus an adapter Astro prerenders them at build time and Vercel serves the
  // frozen build-time response instead of running the handler.
  output: 'server',
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
