import { Request, RequestHandler, Response } from 'express';
import { createProxyMiddleware, responseInterceptor } from 'http-proxy-middleware';
import { envConfig } from '../config/env.config.js';
import { isBlockedAdUrl } from '../utils/ad-blocker.js';
import { connectionIssue, invalidAddress, isDocumentRequest, renderGatewayError, upstreamIssue } from '../utils/gateway-error.js';

const proxiedPath = '/__p/';
const systemPrefixes = ['/__p/', '/__engine/', '/__static/'];
const browserUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const interactiveErrorStatuses = new Set([401, 403, 429]);
const documentResponseTimeout = 25_000;

const removedHeaders = [
    'content-security-policy',
    'content-security-policy-report-only',
    'x-frame-options',
    'x-content-type-options',
    'cross-origin-resource-policy',
    'cross-origin-embedder-policy',
    'cross-origin-opener-policy',
    'access-control-allow-origin',
    'attribution-reporting-register-source',
    'attribution-reporting-register-trigger',
    'attribution-reporting-info'
];

// لیست هدرهایی که ورسل اضافه می‌کند و باعث لو رفتن پروکسی می‌شود
const vercelProxyHeaders = [
    'x-forwarded-for', 
    'x-forwarded-host', 
    'x-forwarded-proto',
    'x-vercel-id', 
    'x-vercel-forwarded-for', 
    'x-real-ip', 
    'forwarded', 
    'via'
];

const getTargetUrl = (req: Request): URL | null => {
    const encodedTarget = (req.originalUrl || req.url || '').replace(/^\/__p\//, '');
    try {
        const target = new URL(encodedTarget);
        if (target.protocol === 'http:' || target.protocol === 'https:') return target;
    } catch {}
    
    const referer = req.headers.referer ?? '';
    const match = referer.match(/\/__p\/(https?:\/\/[^/\s?#]+)/i);
    if (!match) return null;
    
    try {
        return new URL(match[1]);
    } catch {
        return null;
    }
};

export const validateProxyNavigation: RequestHandler = (req, res, next) => {
    if (isDocumentRequest(req) && !getTargetUrl(req)) {
        renderGatewayError(res, 400, invalidAddress);
        return;
    }
    next();
};

const getInjectedScript = (currentUrl: string): string => `
<script>
(function () {
    const initialUrl = ${JSON.stringify(currentUrl)};
    const systemPrefixes = ${JSON.stringify(systemPrefixes)};
    if (window.parent !== window) {
        window.parent.postMessage({ type: 'ENGINE_PAGE_START', url: location.href }, location.origin);
    }

    // Script-created windows are frequently pop-under ads, including when a
    // site launches them during a genuine click. Explicit link gestures are
    // handled separately below and remain available.
    window.open = function () { return null; };

    function unwrap(value) {
        let result = String(value);
        for (let i = 0; i < 20; i++) {
            if (result.startsWith('/__p/')) {
                result = result.slice(5);
            } else {
                let parsed;
                try { parsed = new URL(result); } catch { break; }
                if (parsed.origin !== location.origin || !parsed.pathname.startsWith('/__p/')) break;
                result = parsed.pathname.slice(5) + parsed.search + parsed.hash;
            }
            if (result.startsWith('https:/') && !result.startsWith('https://')) result = 'https://' + result.slice(7);
            if (result.startsWith('http:/') && !result.startsWith('http://')) result = 'http://' + result.slice(6);
        }
        return result;
    }

    function currentUrl() {
        const target = unwrap(location.href);
        return (target.startsWith('http://') || target.startsWith('https://')) && target !== location.href ? target : initialUrl;
    }

    function resolveUrl(value) {
        try {
            const resolved = new URL(unwrap(value), currentUrl());
            // Request objects and site libraries can turn root-relative paths into
            // absolute gateway URLs before fetch/XHR sees them.
            if (resolved.origin === location.origin && !systemPrefixes.some((prefix) => resolved.pathname.startsWith(prefix))) {
                return new URL(resolved.pathname + resolved.search + resolved.hash, new URL(currentUrl()).origin).href;
            }
            return resolved.href;
        } catch { return null; }
    }

    function isIgnored(value) {
        return typeof value !== 'string' || /^(data:|blob:|javascript:|#)/i.test(value);
    }

    function proxify(value) {
        if (isIgnored(value)) return value;
        if (value.startsWith('/__p/')) return '/__p/' + unwrap(value);
        if (systemPrefixes.some((prefix) => value.startsWith(prefix))) return value;
        if (value.startsWith('//')) return '/__p/https:' + value;
        const resolved = resolveUrl(value);
        return resolved ? '/__p/' + resolved : value;
    }

    function navigate(value) {
        const resolved = resolveUrl(value);
        if (resolved) window.parent.postMessage({ type: 'ENGINE_NAV', target: resolved }, '*');
    }

    window.addEventListener('keydown', function (event) {
        if ((event.ctrlKey || event.metaKey) && ['t', 'w', 'Tab'].includes(event.key)) {
            event.preventDefault();
            window.parent.postMessage({ type: 'ENGINE_SHORTCUT', key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey }, '*');
        }
    });

    let linkPress;
    let heldLink;

    function cancelLinkPress() {
        if (linkPress) clearTimeout(linkPress.timer);
        linkPress = null;
    }

    function showLinkActions() {
        if (!linkPress) return;
        const { link, pointerId } = linkPress;
        cancelLinkPress();
        const href = link.getAttribute('href')?.trim();
        if (!link.isConnected || !href || /^(data:|blob:|javascript:)/i.test(href)) return;
        const target = resolveUrl(href);
        if (!target || !(target.startsWith('https://') || target.startsWith('http://'))) return;
        heldLink = { link, pointerId };
        window.parent.postMessage({ type: 'ENGINE_LINK_ACTIONS', target }, location.origin);
    }

    document.addEventListener('pointerdown', function (event) {
        cancelLinkPress();
        heldLink = null;
        if (event.pointerType !== 'touch' || !event.isPrimary) return;
        const link = event.target.closest?.('a[href]:not([download])');
        if (!link) return;
        linkPress = { link, pointerId: event.pointerId, x: event.clientX, y: event.clientY, timer: setTimeout(showLinkActions, 500) };
    }, true);

    document.addEventListener('pointermove', function (event) {
        if (linkPress?.pointerId === event.pointerId &&
            Math.hypot(event.clientX - linkPress.x, event.clientY - linkPress.y) > 10) cancelLinkPress();
    }, true);

    for (const type of ['pointerup', 'pointercancel']) {
        document.addEventListener(type, function (event) {
            if (linkPress?.pointerId === event.pointerId) cancelLinkPress();
        }, true);
    }

    document.addEventListener('contextmenu', function (event) {
        const link = event.target.closest?.('a[href]');
        if (!link || (linkPress?.link !== link && heldLink?.link !== link)) return;
        if (event.pointerType && event.pointerType !== 'touch') return;
        showLinkActions();
        if (heldLink?.link === link) event.preventDefault();
    }, true);

    // Some browsers still send a click on release after a long press.
    document.addEventListener('click', function (event) {
        if (!heldLink || !event.detail || event.target.closest?.('a') !== heldLink.link) return;
        if (event.pointerType && (event.pointerType !== 'touch' || event.pointerId !== heldLink.pointerId)) return;
        heldLink = null;
        event.preventDefault();
        event.stopImmediatePropagation();
    }, true);

    // Do not let a script manufacture a new-tab link click to evade the
    // popup blocker. User clicks and keyboard activation are trusted events.
    document.addEventListener('click', function (event) {
        if (event.isTrusted) return;
        const link = event.target.closest?.('a[href]');
        if (link && (link.target.toLowerCase() === '_blank' || event.ctrlKey || event.metaKey || event.shiftKey)) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }, true);

    document.addEventListener('click', function (event) {
        if (event.defaultPrevented || event.button !== 0 || event.altKey) return;
        const link = event.target.closest('a');
        if (!link || !link.hasAttribute('href') || link.hasAttribute('download')) return;
        const href = link.getAttribute('href');
        if (isIgnored(href)) return;
        
        event.preventDefault();
        if (event.ctrlKey || event.metaKey || event.shiftKey || link.target === '_blank') {
            const target = resolveUrl(href);
            if (target) window.parent.postMessage({ type: 'ENGINE_NEW_TAB', target, activate: event.shiftKey || (!event.ctrlKey && !event.metaKey) }, '*');
        } else {
            navigate(href);
        }
    });

    document.addEventListener('auxclick', function (event) {
        if (event.defaultPrevented || event.button !== 1) return;
        const link = event.target.closest('a[href]');
        if (!link || link.hasAttribute('download') || isIgnored(link.getAttribute('href'))) return;
        const target = resolveUrl(link.getAttribute('href'));
        if (target) { event.preventDefault(); window.parent.postMessage({ type: 'ENGINE_NEW_TAB', target, activate: event.shiftKey }, '*'); }
    });

    document.addEventListener('submit', function (event) {
        const form = event.target.closest('form');
        if (!form || event.defaultPrevented || (form.method || 'get').toLowerCase() !== 'get') return;
        
        event.preventDefault();
        
        try {
            const action = new URL(unwrap(form.getAttribute('action') || ''), currentUrl());
            const params = new URLSearchParams(new FormData(form));
            params.forEach((value, key) => action.searchParams.set(key, value));
            if (form.target === '_blank') window.parent.postMessage({ type: 'ENGINE_NEW_TAB', target: action.href, activate: true }, '*');
            else navigate(action.href);
        } catch {}
    });

    const nativeSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
        const nextValue = ['src', 'href', 'action', 'poster'].includes(name.toLowerCase())
            ? proxify(value)
            : value;
        return nativeSetAttribute.call(this, name, nextValue);
    };

    const originalCreateElement = document.createElement.bind(document);
    document.createElement = function(tagName, options) {
        const el = originalCreateElement(tagName, options);
        const tag = String(tagName).toLowerCase();
        
        if (['script', 'img', 'iframe', 'link', 'source', 'video', 'audio'].includes(tag)) {
            try {
                let srcVal = '', hrefVal = '';
                Object.defineProperty(el, 'src', {
                    configurable: true,
                    get: function() { return srcVal || this.getAttribute('src') || ''; },
                    set: function(v) { srcVal = proxify(v); nativeSetAttribute.call(this, 'src', srcVal); }
                });
                Object.defineProperty(el, 'href', {
                    configurable: true,
                    get: function() { return hrefVal || this.getAttribute('href') || ''; },
                    set: function(v) { hrefVal = proxify(v); nativeSetAttribute.call(this, 'href', hrefVal); }
                });
            } catch(err) {}
        }
        return el;
    };

    const originalPushState = history.pushState;
    history.pushState = function(state, unused, url) {
        if (url) url = proxify(url.toString());
        const result = originalPushState.call(this, state, unused, url);
        window.parent.postMessage({ type: 'ENGINE_URL', target: currentUrl() }, '*');
        return result;
    };

    const originalReplaceState = history.replaceState;
    history.replaceState = function(state, unused, url) {
        if (url) url = proxify(url.toString());
        const result = originalReplaceState.call(this, state, unused, url);
        window.parent.postMessage({ type: 'ENGINE_URL', target: currentUrl() }, '*');
        return result;
    };

    window.addEventListener('popstate', function () {
        window.parent.postMessage({ type: 'ENGINE_URL', target: currentUrl() }, '*');
    });

    const originalXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        if (typeof url === 'string') {
            url = proxify(url);
        }
        return originalXHROpen.call(this, method, url, ...rest);
    };

    const originalFetch = window.fetch;
    window.fetch = function (...args) {
        if (typeof args[0] === 'string') {
            args[0] = proxify(args[0]);
        } else if (args[0] instanceof URL) {
            args[0] = proxify(args[0].href);
        } else if (args[0] && args[0] instanceof Request) {
            try {
                args[0] = new Request(proxify(args[0].url), args[0]);
            } catch(e) {}
        }
        return originalFetch.apply(this, args);
    };
})();
</script>`;

const proxifyResource = (value: string, base: URL): string => {
    if (!value || /^(?:data:|blob:|javascript:|#)/i.test(value) ||
        systemPrefixes.some((prefix) => value.startsWith(prefix))) return value;
    try {
        const resolved = new URL(value, base);
        return resolved.protocol === 'http:' || resolved.protocol === 'https:'
            ? `${proxiedPath}${resolved.href}`
            : value;
    } catch { return value; }
};

const rewriteCssUrls = (css: string, target: URL): string => css
    .replace(/url\(\s*(['"]?)([^'"\)]*)\1\s*\)/gi,
        (match, quote: string, value: string) => {
            const path = value.trim();
            return path ? `url(${quote}${proxifyResource(path, target)}${quote})` : match;
        })
    .replace(/(@import\s+)(['"])([^'"]+)\2/gi,
        (_match, prefix: string, quote: string, value: string) =>
            `${prefix}${quote}${proxifyResource(value, target)}${quote}`);

const rewriteHtmlPaths = (html: string, targetOrigin: string): string => {
    let result = html
        .replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '')
        .replace(/<meta[^>]+name\s*=\s*["']?referrer["']?[^>]*>/gi, '')
        .replace(/\bping\s*=\s*(["']).*?\1/gi, '');
        
    result = result.replace(
        /(\s(?:src|href|action|poster|data-src)\s*=\s*)(["'])\s*\/(?!\/|__p\/|__engine\/|__static\/)([^"']*?)\s*\2/gi,
        `$1$2${proxiedPath}${targetOrigin}/$3$2`
    );
    
    result = result.replace(
        /(\s(?:src|href|action|poster|data-src)\s*=\s*)(["'])\s*\/\/([^"']+?)\s*\2/gi,
        `$1$2${proxiedPath}https://$3$2`
    );

    // Server-rendered absolute asset URLs bypass the dynamic DOM hooks.
    // Route them through the gateway just like root-relative URLs.
    result = result.replace(
        /(\s(?:src|href|action|poster|data-src)\s*=\s*)(["'])\s*(https?:\/\/[^"']*?)\s*\2/gi,
        (_match, prefix: string, quote: string, value: string) =>
            `${prefix}${quote}${proxiedPath}${value}${quote}`
    );
    
    // React Server Components include a second list of chunk URLs inside
    // inline Flight data. Keep those URLs identical to the proxied script
    // elements, otherwise Turbopack waits forever for the original URL.
    result = result.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, (script) => {
        if (!script.includes('self.__next_f.push')) return script;
        return script.replace(/(["'])\/_next\/static\/chunks\//g,
            `$1${proxiedPath}${targetOrigin}/_next/static/chunks/`);
    });

    result = result.replace(
        /([;,\s]url\s*=\s*["']?)\/(?!\/|__p\/|__engine\/|__static\/)/gi,
        `$1${proxiedPath}${targetOrigin}/`
    );

    return result;
};

const rewriteResponse = (html: string, target: URL): string => {
    const withoutAdScripts = html.replace(/<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>\s*<\/script\s*>/gi,
        (tag, _quote: string, src: string) => {
            try { return isBlockedAdUrl(new URL(src, target).href) ? '' : tag; } catch { return tag; }
        });
    const rewritten = rewriteHtmlPaths(withoutAdScripts.replace(/integrity=(['"]).*?\1/gi, ''), target.origin);
    const fontInjection = `
<style>
#myAdBanner, ins.adsbygoogle, ins[id="1085018"], [data-ad-slot] { display: none !important; }
@media (any-pointer: coarse) {
    a[href]:not([download], [href=""], [href^="mailto:" i], [href^="tel:" i], [href^="data:" i], [href^="blob:" i], [href^="javascript:" i]) {
        -webkit-touch-callout: none;
    }
}
@font-face {
    font-family: 'Gateway Vazirmatn';
    src: url('/__static/fonts/vazirmatn-arabic-wght-normal.woff2') format('woff2');
    font-style: normal;
    font-weight: 100 900;
    font-display: swap;
    unicode-range: U+0600-06FF, U+0750-077F, U+0870-0891, U+0897-08FF, U+FB50-FDFF, U+FE70-FEFC;
}
</style>
<script src="/__static/js/persian-font.js"></script>`;
    const injection = fontInjection + getInjectedScript(target.href);

    if (/<head\b[^>]*>/i.test(rewritten)) return rewritten.replace(/(<head\b[^>]*>)/i, `$1\n${injection}`);
    if (/<html\b[^>]*>/i.test(rewritten)) return rewritten.replace(/(<html\b[^>]*>)/i, `$1\n<head>${injection}</head>`);
    return `${injection}\n${rewritten}`;
};

const isTurbopackRuntime = (target: URL): boolean =>
    /^\/_next\/static\/chunks\/turbopack-[\w.-]+\.js$/.test(target.pathname);

const rewriteTurbopackRuntime = (script: string, target: URL): string => {
    if (!script.includes('TURBOPACK') || !script.includes('registerChunk')) return script;
    const assetBase = JSON.stringify(proxiedPath + target.origin + '/_next/');
    return script.replace(/(["'])\/_next\/\1(?=\s*,\s*[\w$]+\s*=)/, () => assetBase);
};

const interceptTextResponse = responseInterceptor(async (responseBuffer, proxyRes, req: Request, res) => {
    const target = getTargetUrl(req);
    if (!target) return responseBuffer;

    const expressRes = res as Response;
    removedHeaders.forEach((header) => expressRes.removeHeader(header));
    expressRes.setHeader('Access-Control-Allow-Origin', '*');
    // responseInterceptor's own domain rewriting can corrupt cookie attributes.
    // Use the original upstream values for intercepted HTML, CSS and scripts.
    if (proxyRes.headers['set-cookie']) {
        expressRes.setHeader('set-cookie', rewriteCookies(proxyRes.headers['set-cookie']));
    }

    const contentType = String(proxyRes.headers['content-type'] ?? '').toLowerCase();
    if (contentType.includes('text/html')) {
        // The real page URL is encoded in the gateway path. An upstream
        // origin-only policy strips it before same-gateway resource requests.
        expressRes.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        return Buffer.from(rewriteResponse(responseBuffer.toString('utf8'), target), 'utf8');
    }
    if (isTurbopackRuntime(target) && /javascript|ecmascript/.test(contentType)) {
        return Buffer.from(rewriteTurbopackRuntime(responseBuffer.toString('utf8'), target), 'utf8');
    }
    return Buffer.from(rewriteCssUrls(responseBuffer.toString('utf8'), target), 'utf8');
});

const rewriteCookies = (value: string | string[]): string[] =>
    (Array.isArray(value) ? value : [value]).map((cookie) => cookie.replace(/;\s*domain=[^;]*/ig, ''));

export const proxyHandler = createProxyMiddleware({
    router: (req: Request) => getTargetUrl(req)?.origin ?? envConfig.defaultEngine,
    changeOrigin: true,
    secure: false,
    selfHandleResponse: true,
    ws: true,
    pathRewrite: (path, req) => {
        const target = getTargetUrl(req);
        return target ? target.pathname + target.search : path;
    },
    on: {
        proxyReq: (proxyReq, req: Request) => {
            const target = getTargetUrl(req);
            if (!target) return;

            if (isDocumentRequest(req)) {
                // Bound the wait for headers, including connection and DNS time.
                const deadline = setTimeout(() => {
                    proxyReq.destroy(Object.assign(new Error('Upstream response timed out'), { code: 'ETIMEDOUT' }));
                }, documentResponseTimeout);
                proxyReq.once('response', () => clearTimeout(deadline));
                proxyReq.once('close', () => clearTimeout(deadline));
            }
            
            // خنثی کردن سیستم تشخیص ربات داک‌داک‌گو
            proxyReq.removeHeader('accept-encoding');
            vercelProxyHeaders.forEach(h => proxyReq.removeHeader(h));
            
            // Recover the original referring page for cross-domain assets.
            // Media servers often require the website's origin, not their own.
            let upstreamReferer = `${target.origin}/`;
            try {
                const referer = new URL(req.headers.referer ?? '');
                if (referer.host === req.headers.host && referer.pathname.startsWith(proxiedPath)) {
                    const original = new URL(referer.pathname.slice(proxiedPath.length) + referer.search);
                    if (original.protocol === 'http:' || original.protocol === 'https:') {
                        upstreamReferer = original.href;
                    }
                }
            } catch {}
            proxyReq.setHeader('Referer', upstreamReferer);
            proxyReq.setHeader('Origin', new URL(upstreamReferer).origin);
            proxyReq.setHeader('Host', target.host);
            proxyReq.setHeader('User-Agent', browserUserAgent);
        },
        proxyRes: (proxyRes, req: Request, res) => {
            const target = getTargetUrl(req);
            const expressRes = res as Response;
            const status = proxyRes.statusCode ?? 200;
            const contentType = String(proxyRes.headers['content-type'] ?? '').toLowerCase();
            // Keep upstream sign-in and verification pages usable.
            const interactiveError = proxyRes.headers['www-authenticate'] || proxyRes.headers['cf-mitigated'] === 'challenge' ||
                (contentType.includes('text/html') && interactiveErrorStatuses.has(status));
            if (target && status >= 400 && status < 600 && !interactiveError && !req.headers.range &&
                req.method !== 'HEAD' && isDocumentRequest(req)) {
                proxyRes.on('error', () => {});
                proxyRes.resume();
                const cookies = proxyRes.headers['set-cookie'];
                const retryAfter = proxyRes.headers['retry-after'];
                if (cookies) expressRes.setHeader('set-cookie', rewriteCookies(cookies));
                if (retryAfter) expressRes.setHeader('retry-after', retryAfter);
                renderGatewayError(expressRes, status, upstreamIssue(status), target);
                return;
            }
            if (target && status === 200 && req.method !== 'HEAD' && !req.headers.range &&
                (contentType.includes('text/html') || contentType.includes('text/css') ||
                    (isTurbopackRuntime(target) && /javascript|ecmascript/.test(contentType)))) {
                void interceptTextResponse(proxyRes, req, res);
                return;
            }

            expressRes.statusCode = status;
            for (const [name, value] of Object.entries(proxyRes.headers)) {
                if (value === undefined || removedHeaders.includes(name) || name === 'transfer-encoding') continue;
                if (name === 'set-cookie') {
                    expressRes.setHeader(name, rewriteCookies(value));
                } else {
                    expressRes.setHeader(name, value);
                }
            }
            expressRes.setHeader('Access-Control-Allow-Origin', '*');
            const location = proxyRes.headers.location;
            if (target && redirectStatuses.has(status) && location && !location.startsWith(proxiedPath)) {
                try { expressRes.setHeader('location', `${proxiedPath}${new URL(location, target.href).href}`); } catch {}
            }
            proxyRes.on('error', () => expressRes.destroy());
            proxyRes.pipe(expressRes);
        },
        error: (error, req, res) => {
            if (!('status' in res)) {
                res.destroy();
                return;
            }
            const expressRes = res as Response;
            if (expressRes.headersSent || expressRes.destroyed) return;
            const { status, issue } = connectionIssue((error as NodeJS.ErrnoException).code);
            if (isDocumentRequest(req as Request)) {
                renderGatewayError(expressRes, status, issue, getTargetUrl(req as Request) ?? undefined);
            } else {
                expressRes.status(status).type('text').send(`Gateway: ${issue.code}`);
            }
        }
    }
});
