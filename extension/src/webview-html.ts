/**
 * Pure webview HTML rendering helpers (no `vscode` import).
 *
 * Security posture: the iframe parent document runs exactly one nonce-gated
 * script — the Phase 2A bridge that forwards `dsh:openInEditor` messages from
 * the loopback iframe to the extension host. Reconnect and sidebar-empty pages
 * also carry a single nonce-gated script for their buttons.
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

/**
 * Fill the iframe template: `{{DSH_URL}}` with a safely escaped URL and
 * `{{NONCE}}` with a per-render CSP nonce (the panel's bridge script is the
 * only script in the parent document).
 */
export function renderIframeHtml(template: string, url: string, nonce: string): string {
  const withUrl = template.replace('{{DSH_URL}}', escapeHtmlAttribute(url));
  return withUrl.split('{{NONCE}}').join(escapeHtmlAttribute(nonce));
}

/** Fill every `{{NONCE}}` placeholder (CSP meta + inline script tag) in a template. */
export function renderNonceTemplate(template: string, nonce: string): string {
  const safe = escapeHtmlAttribute(nonce);
  return template.split('{{NONCE}}').join(safe);
}

/** Fill every `{{NONCE}}` (CSP meta + inline script tag) in the reconnect template. */
export function renderReconnectHtml(template: string, nonce: string): string {
  return renderNonceTemplate(template, nonce);
}
