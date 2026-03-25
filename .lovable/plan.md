

## Implement SEO Prerendering

### Changes

**1. `index.html`** — Add `<noscript>` block before `<div id="root">` with a text description of TableFinder including key SEO terms (restaurant reservations, Resy, OpenTable, Yelp, search).

**2. `src/pages/Index.tsx`** — Add internal navigation links in the footer to `/about` and `/how-it-works` using React Router `Link` components.

**3. `vite.config.ts`** — Add `vite-plugin-prerender` to prerender `/`, `/about`, `/how-it-works` at build time so crawlers get full static HTML.

### Impact
- Zero runtime performance impact — prerendering happens at build time only
- Users see no difference — the SPA works identically
- Build time increases by a few seconds

