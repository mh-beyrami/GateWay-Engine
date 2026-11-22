const adHosts = ['juicyads.com', 'juicyads.rocks', 'jads.co', 'onclckmn.com', 'rapidfire.cc'];

export const isBlockedAdUrl = (value: string): boolean => {
    try {
        const url = new URL(value);
        const host = url.hostname.toLowerCase();
        return adHosts.some((domain) => host === domain || host.endsWith(`.${domain}`)) ||
            (host === 'tooti.to' && url.pathname === '/wp-content/uploads/tooti_ad.js');
    } catch {
        return false;
    }
};
