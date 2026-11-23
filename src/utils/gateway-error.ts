import type { Request, Response } from 'express';

export interface GatewayIssue {
    title: string;
    description: string;
    hint: string;
    code: string;
}

export const invalidAddress: GatewayIssue = {
    title: 'آدرس معتبر نیست',
    description: 'Gateway نتوانست آدرس واردشده را به یک نشانی وب تبدیل کند.',
    hint: 'املای آدرس را بررسی کن و دوباره واردش کن.',
    code: 'INVALID_URL'
};

export const internalError: GatewayIssue = {
    title: 'Gateway با خطا روبه‌رو شد',
    description: 'خود Gateway نتوانست درخواست را پردازش کند.',
    hint: 'دوباره تلاش کن. اگر خطا تکرار شد، کد زیر را گزارش کن.',
    code: 'GATEWAY_ERROR'
};

export function isDocumentRequest(req: Request): boolean {
    const destination = req.get('sec-fetch-dest');
    const mode = req.get('sec-fetch-mode');
    if (destination) return ['document', 'iframe', 'frame'].includes(destination);
    return mode ? mode === 'navigate' : /\btext\/html\b/i.test(req.get('accept') ?? '');
}

export function upstreamIssue(status: number): GatewayIssue {
    const messages: Record<number, [string, string]> = {
        401: ['سایت ورود می‌خواهد', 'برای دیدن این صفحه باید ابتدا وارد حساب کاربری‌ات شوی.'],
        403: ['سایت اجازهٔ دسترسی نداد', 'ممکن است سایت دسترسی به این صفحه یا اتصال از طریق Gateway را محدود کرده باشد.'],
        404: ['صفحه در سایت مقصد پیدا نشد', 'آدرس را بررسی کن یا صفحهٔ اصلی سایت را باز کن.'],
        408: ['مهلت پاسخ‌گویی سایت تمام شد', 'کمی صبر کن و دوباره تلاش کن.'],
        410: ['این صفحه دیگر در دسترس نیست', 'برای پیدا کردن جایگزین، صفحهٔ اصلی سایت را بررسی کن.'],
        429: ['سایت درخواست‌های زیادی دریافت کرده', 'کمی صبر کن و دوباره تلاش کن.'],
        451: ['دسترسی به این صفحه محدود است', 'سایت مقصد این صفحه را به دلایل قانونی در دسترس قرار نداده است.']
    };
    const [title, hint] = messages[status] ?? (status >= 500
        ? ['سایت مقصد با خطا روبه‌رو شد', 'کمی صبر کن و دوباره تلاش کن.']
        : ['سایت مقصد درخواست را نپذیرفت', 'آدرس و شرایط دسترسی به صفحه را بررسی کن.']);
    return { title, description: 'این کد را سایت مقصد در پاسخ به درخواست برگرداند.', hint, code: `HTTP ${status}` };
}

export function connectionIssue(code?: string): { status: number; issue: GatewayIssue } {
    const safeCode = code && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'UPSTREAM_CONNECTION';
    let title = 'اتصال به سایت مقصد برقرار نشد';
    let description = 'Gateway نتوانست پاسخ معتبری از سایت مقصد دریافت کند.';
    let hint = 'دوباره تلاش کن یا بررسی کن که سایت مستقیم باز می‌شود.';
    let status = 502;
    if (safeCode === 'ENOTFOUND' || safeCode === 'EAI_AGAIN') {
        title = 'نشانی سایت پیدا نشد';
        description = 'Gateway نتوانست دامنهٔ سایت مقصد را از طریق DNS پیدا کند.';
        hint = 'املای دامنه را بررسی کن و دوباره تلاش کن.';
    } else if (safeCode === 'ETIMEDOUT' || safeCode === 'ESOCKETTIMEDOUT') {
        title = 'سایت در مهلت تعیین‌شده پاسخ نداد';
        description = 'Gateway منتظر پاسخ سایت مقصد ماند، اما پاسخی دریافت نکرد.';
        status = 504;
    } else if (safeCode === 'ECONNREFUSED') {
        description = 'سرور مقصد اتصال را نپذیرفت.';
    } else if (safeCode === 'ECONNRESET') {
        description = 'اتصال پیش از دریافت پاسخ کامل قطع شد.';
    } else if (/^(ERR_(SSL|TLS)_|CERT_|DEPTH_ZERO_|UNABLE_TO_VERIFY_)/.test(safeCode)) {
        title = 'ارتباط امن با سایت برقرار نشد';
        description = 'هنگام برقرار کردن اتصال TLS با سایت مقصد خطا رخ داد.';
    }
    return { status, issue: { title, description, hint, code: safeCode } };
}

export function renderGatewayError(res: Response, status: number, issue: GatewayIssue, target?: URL): void {
    res.status(status).set('Cache-Control', 'no-store').render('error', {
        issue,
        address: target ? target.origin + target.pathname + target.search : '',
        retryUrl: target ? '/__p/' + target.href : '',
    });
}
