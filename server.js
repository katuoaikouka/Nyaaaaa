const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const querystring = require('querystring');
const WebSocket = require('ws');
const { JSDOM } = require('jsdom');

// --- ユーティリティ関数 ---
const btoa = str => Buffer.from(str).toString('base64');
const atob = str => Buffer.from(str, 'base64').toString('utf-8');

// --- 設定 ---
const config = {
    prefix: "/web/",
    port: process.env.PORT || 8080
};

// --- クライアント側注入スクリプト (window.js) ---
const WINDOW_JS = `
(function() {
    var alloy = JSON.parse(atob(document.currentScript.getAttribute('data-config')));
    alloy.url = new URL(alloy.url);

    window.alloyLocation = new Proxy({}, {
        set(obj, prop, value) {
            if (['assign', 'reload', 'replace', 'toString'].includes(prop)) return true;
            return location[prop] = proxify.url(alloy.url.href.replace(alloy.url[prop], value));
        },
        get(obj, prop) {
            if (prop == 'assign' || prop == 'reload' || prop == 'replace' || prop == 'toString') return {
                assign: arg => window.location.assign(proxify.url(arg)),
                replace: arg => window.location.replace(proxify.url(arg)),
                reload: () => window.location.reload(),
                toString: () => alloy.url.href
            }[prop];
            return alloy.url[prop];
        }
    });

    window.document.alloyLocation = window.alloyLocation;

    var proxify = {
        url: (url, type) => {
            if (!url || url.match(/^(#|about:|data:|blob:|mailto:|javascript:)/)) return url;
            if (url.startsWith('//')) url = 'http:' + url;
            if (url.startsWith('/') && !url.startsWith(alloy.prefix)) url = alloy.url.origin + url;
            try {
                var u = new URL(url, alloy.url.href);
                return alloy.prefix + '_' + btoa(u.origin) + '_' + "/" + u.pathname + u.search + u.hash;
            } catch(e) { return url; }
        }
    };

    // Fetch / XHR / WebSocket Proxying
    let oldFetch = window.fetch;
    window.fetch = function(url, options) {
        if (typeof url === 'string') url = proxify.url(url);
        return oldFetch.apply(this, arguments);
    };

    let oldOpen = window.XMLHttpRequest.prototype.open;
    window.XMLHttpRequest.prototype.open = function(method, url) {
        if (typeof url === 'string') url = proxify.url(url);
        return oldOpen.apply(this, arguments);
    };

    window.WebSocket = new Proxy(window.WebSocket, {
        construct(target, args) {
            var protocol = location.protocol === 'https:' ? 'wss://' : 'ws://';
            var wsUrl = args;
            args = protocol + location.host + alloy.prefix + '?ws=' + btoa(wsUrl) + '&origin=' + btoa(alloy.url.origin);
            return Reflect.construct(target, args);
        }
    });

    document.currentScript.remove();
})();
`;

// --- プロキシコアクラス ---
class AlloyProxy {
    constructor(prefix) {
        this.prefix = prefix;
    }

    // URLのエンコード・デコード
    proxifyRequestURL(url, decode) {
        if (decode) {
            // フォーマット: _BASE64ORIGIN_/PATH
            const parts = url.split('_');
            if (parts.length < 3) throw new Error("Invalid Proxy URL");
            const origin = atob(parts);
            const rest = parts.slice(2).join('_');
            return origin + rest;
        }
        const u = new URL(url);
        return `_${btoa(u.origin)}_${u.pathname}${u.search}${u.hash}`;
    }

    http(req, res) {
        const pathSuffix = req.url.replace(this.prefix, '');

        // クライアントスクリプトの配信
        if (pathSuffix.startsWith('client_hook')) {
            res.setHeader('Content-Type', 'application/javascript');
            return res.end(WINDOW_JS);
        }

        let targetUrl;
        try {
            targetUrl = this.proxifyRequestURL(pathSuffix, true);
        } catch (e) {
            res.writeHead(400);
            return res.end("Invalid Proxy URL Format");
        }

        const proxyUrl = new URL(targetUrl);
        const protocol = proxyUrl.protocol === 'https:' ? https : http;

        const options = {
            method: req.method,
            headers: { ...req.headers },
            rejectUnauthorized: false
        };

        // 不要なヘッダーの削除と調整
        delete options.headers['host'];
        options.headers['origin'] = proxyUrl.origin;
        options.headers['referer'] = proxyUrl.href;

        const proxyReq = protocol.request(targetUrl, options, (proxyRes) => {
            let body = [];
            proxyRes.on('data', chunk => body.push(chunk));
            proxyRes.on('end', () => {
                let data = Buffer.concat(body);
                const contentType = proxyRes.headers['content-type'] || '';

                // 圧縮解除
                const enc = proxyRes.headers['content-encoding'];
                if (enc === 'gzip') data = zlib.gunzipSync(data);
                else if (enc === 'deflate') data = zlib.inflateSync(data);
                else if (enc === 'br') data = zlib.brotliDecompressSync(data);

                // HTMLの書き換え
                if (contentType.includes('text/html')) {
                    const dom = new JSDOM(data.toString());
                    const doc = dom.window.document;

                    // スクリプト注入
                    const script = doc.createElement('script');
                    script.src = this.prefix + 'client_hook';
                    script.setAttribute('data-config', btoa(JSON.stringify({ 
                        prefix: this.prefix, 
                        url: targetUrl 
                    })));
                    doc.head.insertBefore(script, doc.head.firstChild);
                    
                    // 静的リソースの書き換え
                    const rewrite = (tag, attr) => {
                        doc.querySelectorAll(`${tag}[${attr}]`).forEach(el => {
                            try {
                                const raw = el.getAttribute(attr);
                                const absolute = new URL(raw, targetUrl).href;
                                el.setAttribute(attr, this.prefix + this.proxifyRequestURL(absolute, false));
                            } catch(e) {}
                        });
                    };

                    rewrite('a', 'href');
                    rewrite('link', 'href');
                    rewrite('script', 'src');
                    rewrite('img', 'src');
                    rewrite('iframe', 'src');
                    rewrite('form', 'action');

                    data = dom.serialize();
                }

                // レスポンスヘッダーのクリーンアップ
                delete proxyRes.headers['content-encoding'];
                delete proxyRes.headers['content-length'];
                delete proxyRes.headers['content-security-policy'];
                delete proxyRes.headers['x-frame-options'];

                // リダイレクトの処理
                if (proxyRes.headers['location']) {
                    try {
                        const loc = new URL(proxyRes.headers['location'], targetUrl).href;
                        proxyRes.headers['location'] = this.prefix + this.proxifyRequestURL(loc, false);
                    } catch(e) {}
                }

                res.writeHead(proxyRes.statusCode, proxyRes.headers);
                res.end(data);
            });
        });

        proxyReq.on('error', (err) => {
            res.writeHead(500);
            res.end("Proxy Error: " + err.message);
        });

        req.pipe(proxyReq);
    }

    ws(server) {
        const wss = new WebSocket.Server({ server });
        wss.on('connection', (cli, req) => {
            const query = querystring.parse(req.url.split('?'));
            if (!query.ws) return cli.close();

            const targetWsUrl = atob(query.ws);
            const proxy = new WebSocket(targetWsUrl, {
                headers: { origin: query.origin ? atob(query.origin) : '' }
            });

            cli.on('message', m => proxy.readyState === WebSocket.OPEN && proxy.send(m));
            proxy.on('message', m => cli.readyState === WebSocket.OPEN && cli.send(m));
            
            cli.on('close', () => proxy.close());
            proxy.on('close', () => cli.close());
            
            cli.on('error', () => proxy.terminate());
            proxy.on('error', () => cli.terminate());
        });
    }
}

// --- サーバー起動 ---
const proxy = new AlloyProxy(config.prefix);

const server = http.createServer((req, res) => {
    // プロキシリクエストのハンドリング
    if (req.url.startsWith(config.prefix)) {
        return proxy.http(req, res);
    }

    // UIからのジャンプ処理
    if (req.url.startsWith('/prox?url=')) {
        try {
            const target = atob(req.url.split('='));
            const finalTarget = target.startsWith('http') ? target : 'http://' + target;
            res.writeHead(302, { Location: config.prefix + proxy.proxifyRequestURL(finalTarget, false) });
            return res.end();
        } catch(e) {
            res.writeHead(400);
            return res.end("Invalid Request");
        }
    }

    // 静的ファイル (index.html) の配信
    const indexPath = path.join(__dirname, 'public', 'index.html');
    fs.readFile(indexPath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end("index.html not found in public directory.");
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
    });
});

// WebSocketの有効化
proxy.ws(server);

server.listen(config.port, () => {
    console.log(`Sennin Proxy is active on port ${config.port}`);
});
