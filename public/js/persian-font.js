(function () {
    const persianText = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufefc]/;
    const ignored = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG']);
    const fontName = 'Gateway Vazirmatn';
    const replaceableFonts = new Set([
        'arial', 'tahoma', 'segoe ui', 'google sans', 'google sans text',
        'roboto', 'helvetica', 'helvetica neue', 'verdana', 'geneva',
        'times new roman', 'times', 'georgia', 'system-ui', '-apple-system',
        'blinkmacsystemfont', 'sans-serif', 'serif', 'monospace', 'ui-sans-serif',
        'ui-serif', 'ui-monospace', 'ddg_proximanova', 'ducksansdisplay',
        'ducksansproduct'
    ]);

    function applyFont(element) {
        if (!element || ignored.has(element.tagName) || element.closest('svg')) return;
        const current = getComputedStyle(element).fontFamily;
        const primaryFont = current.split(',')[0].trim().replace(/^['"]|['"]$/g, '').toLowerCase();
        if (replaceableFonts.has(primaryFont)) {
            element.style.setProperty('font-family', '"' + fontName + '", ' + current, 'important');
        }
    }

    function scan(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            if (persianText.test(node.nodeValue || '')) applyFont(node.parentElement);
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_NODE) return;
        if (node.nodeType === Node.ELEMENT_NODE && ignored.has(node.tagName)) return;
        if (node.matches && node.matches('input, textarea')) applyFont(node);
        if (node.querySelectorAll) node.querySelectorAll('input, textarea').forEach(applyFont);
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
            const text = walker.currentNode;
            if (persianText.test(text.nodeValue || '')) applyFont(text.parentElement);
        }
    }

    scan(document);
    new MutationObserver(function (mutations) {
        for (const mutation of mutations) {
            if (mutation.type === 'characterData') scan(mutation.target);
            else mutation.addedNodes.forEach(scan);
        }
    }).observe(document, { subtree: true, childList: true, characterData: true });
})();
