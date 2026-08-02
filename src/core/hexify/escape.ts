/**
 * Nunjucks-neutralising escape pass (Hex 2.0 / H1).
 *
 * Every text file of a template is rendered through Nunjucks — path AND
 * contents — so a plain repo being hexified may already contain
 * sequences the renderer would mangle: `{{` / `{%` / `{#` render-away
 * silently (throwOnUndefined is off), and a bare `#}` throws outright,
 * even with no opening `{#` before it. GitHub Actions' `${{ secrets.X }}`
 * is the everyday case.
 *
 * The escape emits ONLY variable tags (`{{ '{' }}`), never block tags,
 * so trimBlocks/lstripBlocks (which eat whitespace around `{% %}`) can
 * never disturb the surrounding bytes. It is pair-BREAKING rather than
 * pair-wrapping: escaping the first `{` of a hazardous pair and then
 * re-examining the next character survives brace runs (`{{{`, `{{{{`)
 * that defeat naive `{{`→wrapped replacement.
 *
 * Invariant (the round-trip gate leans on it):
 *   renderText(escapeNunjucks(s), anything) === s
 */
export function escapeNunjucks(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (c === '{' && (n === '{' || n === '%' || n === '#')) {
      out += "{{ '{' }}";
    } else if (c === '#' && n === '}') {
      out += "{{ '#' }}";
    } else {
      out += c;
    }
  }
  return out;
}
