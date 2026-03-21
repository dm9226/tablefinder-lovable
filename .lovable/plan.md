

## SEO Improvements for TableFinder

### Changes Overview

**1. Structured Data (JSON-LD) in `index.html`**
- Add `WebApplication` schema with name, URL, description, category
- Add `WebSite` schema with `SearchAction` for potential sitelinks search box
- Add `manifest.json` link and `apple-touch-icon` meta tag

**2. Create `public/sitemap.xml`**
- List all pages: `/`, `/about`, `/how-it-works`
- Static file served directly by Vite

**3. Update `public/robots.txt`**
- Add `Sitemap: https://tablefinder.ai/sitemap.xml` directive

**4. Create `public/manifest.json`**
- App name, short name, theme color matching the warm dark palette, display standalone

**5. Install `react-helmet-async` and wrap app**
- Add `HelmetProvider` in `src/App.tsx`
- Each page sets its own `<title>` and `<meta description>`

**6. Create `/about` page (`src/pages/About.tsx`)**
- Explains what TableFinder is, which platforms it searches
- SEO-targeted title: "About TableFinder — Search Resy, OpenTable & Yelp Together"
- Clean content page with consistent branding, link back to search

**7. Create `/how-it-works` page (`src/pages/HowItWorks.tsx`)**
- 3-step explanation: Enter search → We check platforms → See results
- SEO-targeted title: "How TableFinder Works — Find Restaurant Reservations in Seconds"
- Visual step cards, CTA to try a search

**8. Add routes in `src/App.tsx`**
- `/about` → lazy-loaded About page
- `/how-it-works` → lazy-loaded HowItWorks page

**9. Add `<Helmet>` to `src/pages/Index.tsx`**
- Sets page-specific title and description on the home page

### Files

| Action | File |
|--------|------|
| Modify | `index.html` — JSON-LD, manifest link |
| Modify | `public/robots.txt` — sitemap directive |
| Create | `public/sitemap.xml` |
| Create | `public/manifest.json` |
| Modify | `src/main.tsx` — wrap with HelmetProvider |
| Modify | `src/App.tsx` — add routes |
| Modify | `src/pages/Index.tsx` — add Helmet |
| Create | `src/pages/About.tsx` |
| Create | `src/pages/HowItWorks.tsx` |

### Design
- Both content pages use the same dark warm theme, Outfit/Playfair fonts
- Minimal nav: TableFinder logo links home, footer matches Index
- Pages are static content — no API calls, instant load

