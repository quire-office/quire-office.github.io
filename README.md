# www

Quire main site — static Astro (SSG) build, deployed to GitHub Pages with a custom
domain (`quireoffice.dev`, CNAME in `public/`).

## Commands

    npm install
    npm run dev        # astro dev server
    npm run build      # static build → dist/ (must be zero errors)
    npm run preview    # serve dist/ locally for walkthrough
    npm run check:local

`check:local` is the self-containment gate: it fails the build if anything in `dist/`
references a CDN (fonts, JS), links the still-private engine repository, or drops below
the expected page count. Fonts and brand assets are committed under `public/` — the site
renders fully offline.

## Structure

    src/layouts/Base.astro   # head/meta/OG, header, footer
    src/pages/index.astro    # hero + evidence stats + format road (DOCX → XLSX → PPTX)
    src/pages/roadmap.astro  # external-facing roadmap
    src/pages/playground.astro  # WASM playground skeleton (real render: separate task)
    src/styles/              # ink/paper/vermilion design tokens, self-hosted @font-face
    public/brand/            # logo/lockups/banner/social preview (from quire brand/)
    public/fonts/            # latin woff2 subsets, SIL OFL 1.1

## Design rules (from brand/README.md)

- Ink `#111111` / paper `#FAF8F4` / vermilion `#C43120` (accent only) / charcoal `#181A1E`.
- Dark mode follows `prefers-color-scheme`; text accents use the lightened vermilion
  variant `#E4574A` there (contrast), the logo fold keeps exact `#C43120`.
- Headings in Source Serif 4 (self-hosted), mono labels in IBM Plex Mono (self-hosted).
- No emoji, no AI-style illustration — geometry and typography only.
- Copy discipline: the engine repository is private until launch — never link
  `github.com/quire-office/quire`; positioning is "Private preview — opens when the
  foundations hold" (no ship-today claims).

## Publishing

GitHub Pages workflow is wired by the maintainer after the first merge
(`quire-office.github.io/www` → `quireoffice.dev` via CNAME). `astro.config.mjs`
`site` must match the live origin for canonical/OG/sitemap URLs.
