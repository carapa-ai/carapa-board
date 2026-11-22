import githubLightCss from 'highlight.js/styles/github.css?inline';
import githubDarkCss from 'highlight.js/styles/github-dark.css?inline';

/**
 * highlight.js syntax themes. Both themes style the bare `.hljs` classes, so
 * importing them as plain stylesheets would let whichever loads last win in
 * every theme. Instead both are bundled and scoped under the root theme class
 * (`light`/`dark` on <html>, see lib/theme.ts), so `.light .hljs` and
 * `.dark .hljs` never conflict. Injected at module-eval time so the very
 * first code render is already colored.
 */
if (typeof document !== 'undefined') {
  const style = document.createElement('style');
  style.dataset.hljsThemes = 'true';
  style.textContent = `.light {\n${githubLightCss}\n}\n.dark {\n${githubDarkCss}\n}`;
  document.head.appendChild(style);
}

export {};
