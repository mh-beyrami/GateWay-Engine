import { Router } from 'express';
import { parseTargetUrl } from '../utils/url.parser.js';
import { envConfig } from '../config/env.config.js';
import { invalidAddress } from '../utils/gateway-error.js';

const router = Router();

router.post('/set-target', (req, res) => {
    const target = req.body?.target;
    
    if (typeof target !== 'string' || !target.trim() || target === 'MAIN') {
        return res.json({ success: true, url: '/__newtab' });
    }
    
    let finalUrl: string;
    try {
        const url = new URL(parseTargetUrl(target, envConfig.defaultEngine));
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Unsupported protocol');
        finalUrl = url.href;
    } catch {
        return res.status(400).json({ success: false, error: invalidAddress });
    }
    
    res.json({ 
        success: true, 
        url: `/__p/${finalUrl}`,
        displayUrl: finalUrl 
    });
});

export default router;
