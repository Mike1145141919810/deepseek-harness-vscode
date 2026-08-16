import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { escapeHtmlAttribute, newNonce, renderIframeHtml, renderNonceTemplate, renderReconnectHtml } from '../src/webview-html';

const iframeTemplate = '<iframe src="{{DSH_URL}}"></iframe>';
const reconnectTemplate =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'nonce-{{NONCE}}\';" />' +
  '<script nonce="{{NONCE}}">const vscode = acquireVsCodeApi();</script>';
const sidebarEmptyTemplate =
  '<button id="open">Open</button><script nonce="{{NONCE}}">' +
  "document.getElementById('open').addEventListener('click', () => vscode.postMessage({ type: 'dsh.open' }));</script>";

describe('webview-html', () => {
  it('renders the iframe URL escaped as an attribute', () => {
    assert.equal(
      renderIframeHtml(iframeTemplate, 'http://127.0.0.1:1234'),
      '<iframe src="http://127.0.0.1:1234"></iframe>',
    );
    const rendered = renderIframeHtml(iframeTemplate, 'http://x/"><script>alert(1)</script>');
    assert.ok(!rendered.includes('<script>'));
    assert.ok(rendered.includes('&quot;'));
  });

  it('fills the nonce into the CSP meta and the inline script tag', () => {
    const nonce = newNonce();
    const rendered = renderReconnectHtml(reconnectTemplate, nonce);
    assert.ok(rendered.includes(`script-src 'nonce-${nonce}'`));
    assert.ok(rendered.includes(`<script nonce="${nonce}">`));
    assert.ok(!rendered.includes('{{NONCE}}'));
  });

  it('fills the nonce into any nonce-gated template (sidebar placeholder)', () => {
    const nonce = newNonce();
    const rendered = renderNonceTemplate(sidebarEmptyTemplate, nonce);
    assert.ok(rendered.includes(`<script nonce="${nonce}">`));
    assert.ok(rendered.includes("vscode.postMessage({ type: 'dsh.open' })"));
    assert.ok(!rendered.includes('{{NONCE}}'));
  });

  it('produces unique nonces and escapes attribute values', () => {
    assert.notEqual(newNonce(), newNonce());
    assert.equal(escapeHtmlAttribute('a"<&>'), 'a&quot;&lt;&amp;&gt;');
  });
});
