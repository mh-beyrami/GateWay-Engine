import { Request, Response, NextFunction } from 'express';
import { internalError, isDocumentRequest, renderGatewayError } from '../utils/gateway-error.js';

export const errorHandler = (err: Error & { status?: number }, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    const issue = status >= 500 ? internalError : {
        title: 'Gateway نتوانست درخواست را بپذیرد',
        description: 'درخواست به Gateway رسید، اما پردازش نشد.',
        hint: 'به صفحهٔ قبلی برگرد و دوباره تلاش کن.',
        code: `GATEWAY_HTTP_${status}`
    };
    if (status >= 500) console.error('[-] Gateway Core Exception:', err.message);
    if (req.path.startsWith('/__engine/') || !isDocumentRequest(req)) {
        return res.status(status).json({ success: false, error: issue });
    }
    renderGatewayError(res, status, issue);
};
