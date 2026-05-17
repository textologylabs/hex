import type { CataloguePackage } from './store.js';

/**
 * The marketplace website (M9.9) — minimum-viable search / browse /
 * detail pages, server-rendered HTML with live search.
 *
 * Progressive enhancement: every page works as plain HTML with forms
 * and links and no JavaScript. HTMX (the `htmx.org` dependency, served
 * from `/assets/htmx.min.js` — never a third-party CDN) upgrades search
 * to update results without a full reload; the search endpoint returns
 * a fragment to `HX-Request` calls and a full page otherwise.
 *
 * These functions are pure: data in, HTML string out.
 */

/** Escape a string for safe interpolation into HTML text / attributes. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
  :root { color-scheme: light dark; --fg: #1a1a1a; --dim: #6b7280; --accent: #b8860b; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e5e5e5; --dim: #9ca3af; } }
  * { box-sizing: border-box; }
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; color: var(--fg);
         max-width: 820px; margin: 0 auto; padding: 2rem 1.25rem; }
  header { display: flex; align-items: baseline; gap: 1rem; margin-bottom: 1.5rem; }
  header h1 { margin: 0; font-size: 1.4rem; }
  header h1 a { color: var(--accent); text-decoration: none; }
  nav a { color: var(--dim); text-decoration: none; margin-right: 1rem; }
  nav a:hover { color: var(--fg); }
  input[type=search] { width: 100%; padding: .55rem .7rem; font-size: 1rem;
                       border: 1px solid var(--dim); border-radius: 6px; background: transparent;
                       color: var(--fg); }
  ul.entries { list-style: none; padding: 0; }
  ul.entries li { padding: .7rem 0; border-bottom: 1px solid color-mix(in srgb, var(--dim) 30%, transparent); }
  .name { font-weight: 600; }
  .name a { color: var(--fg); text-decoration: none; }
  .name a:hover { color: var(--accent); }
  .ver { color: var(--dim); font-variant-numeric: tabular-nums; }
  .meta, .desc { color: var(--dim); font-size: .9rem; }
  .tag { display: inline-block; font-size: .75rem; color: var(--dim);
         border: 1px solid var(--dim); border-radius: 999px; padding: 0 .5rem; margin-right: .3rem; }
  pre { background: color-mix(in srgb, var(--dim) 18%, transparent); padding: .7rem .9rem;
        border-radius: 6px; overflow-x: auto; }
  .empty { color: var(--dim); }
`;

/** Wrap a page body in the shared HTML skeleton. */
export function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Hex marketplace</title>
<style>${STYLE}</style>
<script src="/assets/htmx.min.js" defer></script>
</head>
<body>
<header>
<h1><a href="/">⬡ Hex</a></h1>
<nav><a href="/">search</a><a href="/browse">browse</a></nav>
</header>
${body}
</body>
</html>
`;
}

function entryRow(p: CataloguePackage): string {
  const tags = p.categories.map((c) => `<span class="tag">${escapeHtml(c)}</span>`).join('');
  const desc = p.description ? `<div class="desc">${escapeHtml(p.description)}</div>` : '';
  return `<li>
<div class="name"><a href="/p/${encodeURIComponent(p.name)}">${escapeHtml(p.name)}</a>
<span class="ver">@${escapeHtml(p.latest)}</span></div>
<div class="meta">${escapeHtml(p.type)}${p.kind ? ` · ${escapeHtml(p.kind)}` : ''} ${tags}</div>
${desc}
</li>`;
}

/** The search-results fragment — also the HTMX swap target. */
export function renderResults(results: CataloguePackage[]): string {
  if (results.length === 0) {
    return '<ul class="entries" id="results"><li class="empty">No matching packages.</li></ul>';
  }
  return `<ul class="entries" id="results">${results.map(entryRow).join('')}</ul>`;
}

/** The full search page. */
export function renderSearchPage(query: string, results: CataloguePackage[]): string {
  const body = `<form method="get" action="/search" role="search">
<input type="search" name="q" value="${escapeHtml(query)}" placeholder="Search components and recipes…"
  autofocus aria-label="Search"
  hx-get="/search" hx-target="#results" hx-trigger="input changed delay:250ms"
  hx-push-url="true">
</form>
${renderResults(results)}`;
  return layout('Search', body);
}

/** The browse page — every category with a count. */
export function renderBrowsePage(categories: Array<{ name: string; count: number }>): string {
  if (categories.length === 0) {
    return layout('Browse', '<p class="empty">No categories yet.</p>');
  }
  const items = categories
    .map(
      (c) =>
        `<li><div class="name"><a href="/browse?category=${encodeURIComponent(c.name)}">${escapeHtml(c.name)}</a></div>
<div class="meta">${c.count} package${c.count === 1 ? '' : 's'}</div></li>`,
    )
    .join('');
  return layout('Browse', `<ul class="entries">${items}</ul>`);
}

/** A single category's packages. */
export function renderCategoryPage(category: string, packages: CataloguePackage[]): string {
  const heading = `<p><a href="/browse">browse</a> / <strong>${escapeHtml(category)}</strong></p>`;
  const body =
    packages.length === 0
      ? `${heading}<p class="empty">No packages in this category.</p>`
      : `${heading}<ul class="entries">${packages.map(entryRow).join('')}</ul>`;
  return layout(`Browse: ${category}`, body);
}

/** A package detail page. */
export function renderDetailPage(pkg: CataloguePackage, versions: string[]): string {
  const tags = pkg.categories.map((c) => `<span class="tag">${escapeHtml(c)}</span>`).join('');
  const versionList = versions.map((v) => `<li class="ver">${escapeHtml(v)}</li>`).join('');
  const body = `<h2>${escapeHtml(pkg.name)} <span class="ver">@${escapeHtml(pkg.latest)}</span></h2>
<p class="meta">${escapeHtml(pkg.type)}${pkg.kind ? ` · ${escapeHtml(pkg.kind)}` : ''} ${tags}</p>
${pkg.description ? `<p>${escapeHtml(pkg.description)}</p>` : ''}
<h3>Install</h3>
<pre>hex new hex/${escapeHtml(pkg.name)}</pre>
<h3>Versions</h3>
<ul class="entries">${versionList}</ul>`;
  return layout(pkg.name, body);
}

/** A 404 page. */
export function renderNotFound(message: string): string {
  return layout('Not found', `<p class="empty">${escapeHtml(message)}</p>`);
}
