import express from 'express';
import path from 'path';
import viewRoutes from './routes/view.routes.js';
import engineRoutes from './routes/engine.routes.js';
import { proxyHandler, validateProxyNavigation } from './proxy/proxy.handler.js';
import { errorHandler } from './middlewares/error.middleware.js';
import { envConfig } from './config/env.config.js';
import { isBlockedAdUrl } from './utils/ad-blocker.js';
import { isDocumentRequest, renderGatewayError } from './utils/gateway-error.js';

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(process.cwd(), 'views'));

app.use('/__static', express.static(path.join(process.cwd(), 'public')));

app.use('/__p', (req, res, next) => {
    if (isBlockedAdUrl(req.originalUrl.slice('/__p/'.length))) return res.status(204).end();
    next();
}, validateProxyNavigation, proxyHandler);

app.use((req, res, next) => {
    const referer = req.headers.referer || '';
    let targetOrigin = '';
    
    if (referer.includes('/__p/')) {
        const match = referer.match(/\/__p\/(https?:\/\/[^\/\s?#]+)/);
        if (match) targetOrigin = match[1];
    }
    
    if (!targetOrigin && req.path === '/' && req.query.q) {
        targetOrigin = new URL(envConfig.defaultEngine).origin;
    }

    const isSystemRoute = req.path.startsWith('/__engine') || req.path.startsWith('/__newtab');
    if (targetOrigin && !isSystemRoute && !req.originalUrl.startsWith('/__p/')) {
        return res.redirect(307, `/__p/${targetOrigin}${req.originalUrl}`);
    }

    next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use('/', viewRoutes);
app.use('/__engine', engineRoutes);

app.use((req, res, next) => {
    if (!isDocumentRequest(req)) return next();
    renderGatewayError(res, 404, {
        title: 'این صفحه در Gateway پیدا نشد',
        description: 'آدرس به Gateway رسید، اما چنین صفحه‌ای در برنامه وجود ندارد.',
        hint: 'به صفحهٔ شروع Gateway برگرد و آدرس سایت را دوباره وارد کن.',
        code: 'GATEWAY_HTTP_404'
    });
});

app.use(errorHandler);

export default app;
