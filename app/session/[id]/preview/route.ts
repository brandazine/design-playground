import { NextResponse } from 'next/server';
import { getSessionPreviewTarget } from '@/lib/session-store';
import { rewriteHtmlUrls, rewriteLocationHeader } from '@/lib/preview-rewrite';

const inspectorScript = `
<script>
(() => {
  if (window.__dpInspectorInstalled) return;
  window.__dpInspectorInstalled = true;
  function parseBox(value) {
    const nums = String(value || '').split(/\\s+/).map((part) => Number.parseFloat(part) || 0);
    if (nums.length === 1) return { top: nums[0], right: nums[0], bottom: nums[0], left: nums[0] };
    if (nums.length === 2) return { top: nums[0], right: nums[1], bottom: nums[0], left: nums[1] };
    if (nums.length === 3) return { top: nums[0], right: nums[1], bottom: nums[2], left: nums[1] };
    return { top: nums[0] || 0, right: nums[1] || 0, bottom: nums[2] || 0, left: nums[3] || 0 };
  }
  function selector(el) {
    if (!(el instanceof Element)) return 'unknown';
    if (el.id) return '#' + el.id;
    const className = (el.className || '').toString().trim().split(/\\s+/).filter(Boolean).slice(0, 2).join('.');
    return className ? (el.tagName.toLowerCase() + '.' + className) : el.tagName.toLowerCase();
  }
  function toPayload(el) {
    const computed = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      selector: selector(el),
      tagName: el.tagName.toLowerCase(),
      className: el.className ? String(el.className) : '',
      componentName: el.getAttribute('data-component') || undefined,
      componentPath: el.getAttribute('data-component-path') || undefined,
      computedStyles: {
        width: computed.width, height: computed.height,
        padding: computed.padding, margin: computed.margin,
        fontSize: computed.fontSize, fontWeight: computed.fontWeight,
        fontFamily: computed.fontFamily, lineHeight: computed.lineHeight,
        letterSpacing: computed.letterSpacing,
        color: computed.color, backgroundColor: computed.backgroundColor,
        borderRadius: computed.borderRadius, border: computed.border,
        display: computed.display, flexDirection: computed.flexDirection,
        gap: computed.gap, alignItems: computed.alignItems, justifyContent: computed.justifyContent
      },
      boxModel: {
        content: { width: rect.width, height: rect.height },
        padding: parseBox(computed.padding),
        margin: parseBox(computed.margin)
      },
      viewport: { width: window.innerWidth, height: window.innerHeight }
    };
  }
  let lastSent = 0;
  document.addEventListener('mousemove', (e) => {
    const now = Date.now();
    if (now - lastSent < 80) return;
    lastSent = now;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!(el instanceof Element)) return;
    window.parent.postMessage({ type: 'element-hover', data: toPayload(el) }, '*');
  }, { passive: true });
})();
</script>
`;

function buildNavInterceptor(proxyBase: string) {
  return `<script>
(() => {
  if (window.__dpNavInstalled) return;
  window.__dpNavInstalled = true;
  const B = ${JSON.stringify(proxyBase)};
  function rw(u) {
    try {
      const p = new URL(u, location.origin);
      if (p.origin === location.origin && !p.pathname.startsWith(B)) {
        p.pathname = B + p.pathname;
        return p.toString();
      }
    } catch {}
    return u;
  }
  if (window.navigation) {
    navigation.addEventListener('navigate', (e) => {
      const dest = new URL(e.destination.url);
      if (dest.origin === location.origin && !dest.pathname.startsWith(B) && e.cancelable) {
        e.preventDefault();
        location.href = B + dest.pathname + dest.search + dest.hash;
      }
    });
  }
  const _push = history.pushState.bind(history);
  const _replace = history.replaceState.bind(history);
  history.pushState = (s, t, u) => _push(s, t, u ? rw(String(u)) : u);
  history.replaceState = (s, t, u) => _replace(s, t, u ? rw(String(u)) : u);
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (href && href.startsWith('/') && !href.startsWith('//') && !href.startsWith(B)) {
      e.preventDefault();
      location.href = B + href;
    }
  }, true);
})();
</script>`;
}

function copyRequestHeaders(headers: Headers) {
  const out = new Headers(headers);
  out.delete('host');
  out.delete('connection');
  out.delete('content-length');
  out.delete('accept-encoding');
  return out;
}

async function proxy(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const target = await getSessionPreviewTarget(id);
  if (!target) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  const incoming = new URL(request.url);
  const targetUrl = new URL(target.baseUrl + '/');
  targetUrl.search = incoming.search;

  const init: RequestInit = {
    method: request.method,
    headers: copyRequestHeaders(request.headers),
    redirect: 'manual'
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') init.body = await request.arrayBuffer();

  try {
    const upstream = await fetch(targetUrl, init);
    const headers = new Headers(upstream.headers);
    headers.set('x-preview-proxy', 'design-playground');
    const proxyBase = `/session/${id}/preview`;
    rewriteLocationHeader(headers, proxyBase, target.baseUrl);
    const contentType = headers.get('content-type') || '';

    // Node fetch auto-decompresses responses, so always strip
    // content-encoding to prevent double-decompression in the browser.
    headers.delete('content-encoding');
    headers.delete('content-length');

    const canInject = request.method === 'GET' && contentType.includes('text/html');
    if (!canInject) return new NextResponse(upstream.body, { status: upstream.status, headers });

    const raw = await upstream.text();
    const rewritten = rewriteHtmlUrls(raw, proxyBase);
    const navScript = buildNavInterceptor(proxyBase);
    let patched = rewritten;
    if (patched.includes('<head>')) {
      patched = patched.replace('<head>', `<head>${navScript}`);
    } else if (patched.includes('<head ')) {
      patched = patched.replace(/<head\s[^>]*>/, `$&${navScript}`);
    } else {
      patched = `${navScript}${patched}`;
    }
    patched = patched.includes('</body>') ? patched.replace('</body>', `${inspectorScript}</body>`) : `${patched}${inspectorScript}`;
    return new NextResponse(patched, { status: upstream.status, headers });
  } catch (error) {
    return NextResponse.json({ error: 'preview proxy failed', detail: error instanceof Error ? error.message : 'unknown error' }, { status: 502 });
  }
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return proxy(request, context);
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return proxy(request, context);
}
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  return proxy(request, context);
}
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return proxy(request, context);
}
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return proxy(request, context);
}
export async function OPTIONS(request: Request, context: { params: Promise<{ id: string }> }) {
  return proxy(request, context);
}
