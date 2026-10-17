// Gate: the built site must be fully self-hosted and must not link the
// (still private, would-404) engine repository.
//   npm run build && npm run check:local
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const DIST = new URL('../dist/', import.meta.url).pathname;
const SITE_HOST = 'quireoffice.dev';

// Anything external the build is allowed to mention: none, by design.
const ALLOW = [
  // license metadata URLs are documentation, not runtime dependencies
  { what: 'apache license text', re: /https?:\/\/(www\.)?apache\.org\/licenses\/LICENSE-2\.0/g },
  { what: 'OFL license text', re: /https?:\/\/openfontlicense\.org/g },
  { what: 'OFL upstream attribution (font license files)', re: /https?:\/\/(fonts\.google\.com\/[a-z/]*|github\.com\/(adobe-fonts|IBM)\/[A-Za-z0-9._-]+|scripts\.sil\.org)\/?/g },
  // XML namespaces are identifiers, never fetched
  { what: 'sitemap schema namespaces', re: /https?:\/\/(www\.)?sitemaps\.org|https?:\/\/www\.google\.com\/schemas\//g },
  // GSAP banner-comment license URLs: self-hosted npm bundle, comment metadata only (no fetch)
  { what: 'GSAP license text', re: /https?:\/\/gsap\.com(\/standard-license)?/g },
  // public GitHub org root + public site repos (engine repo stays FORBIDDEN below)
  { what: 'GitHub org page (public)', re: /https:\/\/github\.com\/quire-office(\/(www|docs|\.github))?\/?(?=["')\s<]|$)/g },
];

const FORBIDDEN = [
  { why: 'private engine repo would 404', re: /github\.com\/quire-office\/quire(?![-/a-z0-9.-])/g },
  { why: 'CDN dependency (fonts)', re: /fonts\.(googleapis|gstatic)\.com/g },
  { why: 'CDN dependency (js)', re: /cdn\.(jsdelivr|cloudflare)\.com|unpkg\.com/g },
];

const TEXTUAL = /\.(html|css|js|xml|json|txt|svg|webmanifest)$/i;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(DIST);
let htmlCount = 0;
const problems = [];

for (const file of files) {
  if (!TEXTUAL.test(file)) continue;
  const text = readFileSync(file, 'utf8');
  const rel = relative(DIST, file);

  if (file.endsWith('.html')) htmlCount++;

  for (const rule of FORBIDDEN) {
    rule.re.lastIndex = 0;
    const m = rule.re.exec(text);
    if (m) {
      const line = text.slice(0, m.index).split('\n').length;
      problems.push(`${rel}:${line} — ${rule.why}: …${text.slice(Math.max(0, m.index - 40), m.index + 60).replace(/\s+/g, ' ')}…`);
    }
  }

  // every remaining absolute URL must be same-site or explicitly allowed
  for (const m of text.matchAll(/https?:\/\/[^"'()\s<]+/g)) {
    const url = m[0];
    if (url.includes(SITE_HOST)) continue;
    if (/^https?:\/\/(www\.)?w3\.org/.test(url)) continue; // xml namespaces / svg
    const bare = url.replace(/[>,.;"]+$/, '');
    if (ALLOW.some((a) => { a.re.lastIndex = 0; return a.re.test(bare); })) continue;
    problems.push(`${rel} — external reference not allowed: ${url}`);
  }
}

const pages = files.filter((f) => f.endsWith('.html'));
if (pages.length < 3) problems.push(`expected ≥3 built pages, found ${pages.length}`);
if (!files.some((f) => f.endsWith('sitemap-index.xml'))) problems.push('sitemap-index.xml missing');

if (problems.length) {
  console.error('check-local-assets: FAILED\n' + problems.map((p) => '  ' + p).join('\n'));
  process.exit(1);
}
console.log(`check-local-assets: OK — ${htmlCount} pages, ${files.length} files, no external runtime references`);
