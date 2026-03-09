/**
 * Rewrite root-relative URLs in HTML to route through the preview proxy.
 * e.g. src="/_next/foo" → src="/session/{id}/preview/_next/foo"
 */
export function rewriteHtmlUrls(html: string, proxyBasePath: string): string {
  // Rewrite src, href, action attributes with root-relative paths
  return html.replace(
    /(src|href|action)="(\/[^"]*?)"/g,
    (_match, attr, path) => {
      // Don't rewrite protocol-relative URLs (//cdn.example.com/...)
      if (path.startsWith('//')) return `${attr}="${path}"`;
      // Don't rewrite if already prefixed
      if (path.startsWith(proxyBasePath)) return `${attr}="${path}"`;
      return `${attr}="${proxyBasePath}${path}"`;
    }
  );
}

/**
 * Rewrite Location header in redirect responses so the browser stays
 * within the proxy path (e.g. /login → /session/{id}/preview/login).
 */
export function rewriteLocationHeader(headers: Headers, proxyBasePath: string, upstreamBaseUrl: string): void {
  const location = headers.get('location');
  if (!location) return;

  // Absolute URL pointing at the upstream dev server → rewrite to proxy path
  if (location.startsWith(upstreamBaseUrl)) {
    const path = location.slice(upstreamBaseUrl.length); // e.g. "/login?next=/"
    headers.set('location', `${proxyBasePath}${path}`);
    return;
  }

  // Root-relative path (e.g. /login) → prefix with proxy base
  if (location.startsWith('/') && !location.startsWith(proxyBasePath)) {
    headers.set('location', `${proxyBasePath}${location}`);
  }
}
