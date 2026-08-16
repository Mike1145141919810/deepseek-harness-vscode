/**
 * Pure webview HTML rendering helpers (no `vscode` import).
 *
 * Security posture: the iframe parent document runs NO scripts. The reconnect
 * page is the one exception — it needs a button, so it carries a single inline
 * script gated by a per-render CSP nonce.
 */
import * as crypto from 'node:crypto';

/** HTML-attribute escaping (template placeholders are the only dynamic input). */
export function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function newNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

/** Fill `{{DSH_URL}}` in the iframe template with a safely escaped URL. */
export function renderIframeHtml(template: string, url: string): string {
  return template.replace('{{DSH_URL}}', escapeHtmlAttribute(url));
}

/** Fill every `{{NONCE}}` (CSP meta + inline script tag) in the reconnect template. */
export function renderReconnectHtml(template: string, nonce: string): string {
  const safe = escapeHtmlAttribute(nonce);
  return template.split('{{NONCE}}').join(safe);
}
