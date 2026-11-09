// Markdown pipeline shared by the React UI (<Markdown/>), built on marked + DOMPurify.
// marked parses GFM (tables, strikethrough, task lists, autolinks); DOMPurify
// sanitizes the generated HTML to prevent XSS (script / on* / javascript: are stripped).

import { marked } from 'marked';
import DOMPurify from 'dompurify';

export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

marked.use({
  gfm: true,
  renderer: {
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const t = title ? ` title="${escapeHtml(title)}"` : '';
      return `<a href="${href}" target="_blank" rel="noopener noreferrer"${t}>${text}</a>`;
    },
  },
});

/** Inner HTML of the markdown container (sanitized, no wrapper element). */
export function renderMarkdownHtml(text: string): string {
  const raw = marked.parse(text ?? '', { async: false }) as string;
  return DOMPurify.sanitize(raw, { ADD_ATTR: ['target', 'rel'] });
}

/** Legacy-shaped block: renderMarkdownHtml wrapped in `<div class="markdown">`. */
export function renderMarkdown(text: string): string {
  return `<div class="markdown">${renderMarkdownHtml(text)}</div>`;
}
