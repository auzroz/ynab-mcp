# Documentation site

The source of <https://auzroz.github.io/ynab-mcp/>. It documents the released
version on `main`.

It is hand-written static HTML with one stylesheet (`assets/style.css`) and a
small script (`assets/site.js`). It has no dependencies, frameworks, CDNs, web
fonts, analytics or cookies, and makes no third-party requests. Every page
carries a Content-Security-Policy meta tag that allows only same-origin
scripts, styles and images, so don't add inline `<script>`, `<style>`,
`style="…"` or `on…=` handlers. The JavaScript is progressive enhancement:
every page works without it.

## Build and preview

```bash
npm run build && node scripts/build-site.mjs
python3 -m http.server -d _site 8080   # then open http://localhost:8080/
```

`scripts/build-site.mjs` imports the tool and prompt registries from `dist/`
(no YNAB token, network or native module needed), then:

- copies `site/` to `_site/` (this README is left out);
- writes `_site/tools.json` and pre-renders the tool and prompt lists into
  `_site/tools.html`, between the `BUILD:TOOLS` and `BUILD:PROMPTS` markers;
- fails if README's "Available Tools (N Total)" count, its analytics or prompt
  count, or any `data-count="…"` number on a page differs from the registry;
- fails if an internal link or `#fragment` doesn't resolve inside `_site/`,
  if an `aria-controls`/`aria-labelledby`/`for` points at a missing id, or if
  a page would load anything from another origin.

`_site/` is git-ignored. `.github/workflows/pages.yml` runs the same two
commands on pushes to `main` and deploys the result. The repository's Pages
source must be set to "GitHub Actions" (Settings, Pages).

## Tests

`tests/unit/site.test.ts` runs with `npm test`. It checks that every tool and
prompt name on the pages is registered, that every environment variable named
on the pages is read by the server (and that `install.html` documents all of
them), that every page has the shared structure and footer and nothing the CSP
would block, and that a full build from the TypeScript sources succeeds.

When you rename a tool or an environment variable, these tests point at the
page to update.

## Editing

- Pages share the header and footer by copy. Change all six together, and set
  `aria-current="page"` on the current page's nav link.
- Figures on `examples.html` are sample data and must stay labelled as such.
- Keep the independence notice in every footer. Don't use YNAB's logo or brand
  colours.
- Colour tokens are at the top of `assets/style.css`, for light and dark mode.
  Each text/background pair is at least 4.5:1 (WCAG AA), and control borders
  and the focus ring at least 3:1; recheck both themes if you change one.
- Layouts are checked down to 360 px wide with no horizontal page scroll; wide
  tables and code scroll inside their own box.
