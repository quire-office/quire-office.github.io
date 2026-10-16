// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Custom domain per brand plan; GitHub Pages serves the same build at
// quire-office.github.io/www (PM wires the Pages workflow after first merge).
export default defineConfig({
  site: 'https://www.quireoffice.dev',
  base: '/',
  trailingSlash: 'never',
  output: 'static',
  integrations: [sitemap()],
  build: {
    inlineStylesheets: 'auto',
  },
});
