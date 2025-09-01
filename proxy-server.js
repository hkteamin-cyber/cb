/**
 * 本地代理伺服器 - 繞過 Chrome ORB 限制
 * 使用方法：node proxy-server.js
 */

const http = require('http');
const https = require('https');
const url = require('url');

const PORT = 3001;
// 將本地代理轉發目標與 Firebase Functions 使用的 Apps Script 部署保持一致
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxm2K-W_-T1UO7LCKSIaoeSFmfShIz71zRL0C4rVRo19HEVlHUrEvf-H3jJ-7JhxQev6Q/exec';

function fetchWithRedirects(targetUrl, maxRedirects = 5, cb) {
  if (maxRedirects < 0) return cb(new Error('Too many redirects'));

  const handler = (res) => {
    const status = res.statusCode;
    const location = res.headers.location;

    if ([301, 302, 303, 307, 308].includes(status) && location) {
      // Follow redirect
      const nextUrl = url.resolve(targetUrl, location);
      return fetchWithRedirects(nextUrl, maxRedirects - 1, cb);
    }

    let data = '';
    res.on('data', chunk => (data += chunk));
    res.on('end', () => cb(null, { status, headers: res.headers, body: data }));
  };

  try {
    const parsed = url.parse(targetUrl);
    const lib = parsed.protocol === 'http:' ? http : https;
    const req = lib.get(targetUrl, handler);
    req.on('error', (err) => cb(err));
  } catch (err) {
    cb(err);
  }
}

const server = http.createServer((req, res) => {
  // CORS headers for browser -> proxy
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  const reqUrl = url.parse(req.url, true);
  
  if (reqUrl.pathname === '/proxy') {
    const q = reqUrl.query || {};
    const sessionId = String(q.session_id || '');
    const action = String(q.action || '');
    const productId = String(q.productId || 'abc');
    const enableSynthetic = (process.env.SYNTHETIC === '1') || (String(q.synthetic) === '1');

    // 合成回應：只有在顯式開啟時才生效（synthetic=1 或環境變數 SYNTHETIC=1）
    if (enableSynthetic && sessionId.startsWith('cs_test_') && action === 'redeem') {
      const code = `TEST-${productId}-${Date.now().toString().slice(-6)}`;
      const body = JSON.stringify({ ok: true, code, status: 'success', productId, message: '測試模式：充值碼已派發（本地代理）' });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(body);
      console.log(`[Proxy][Synthetic] Redeem -> session ${sessionId}, product ${productId}, code ${code}`);
      return;
    }

    if (enableSynthetic && sessionId.startsWith('cs_test_') && action === 'award_points') {
      const priceHKDMap = { '55': 42, '110': 82, 'abc': 9 };
      const points = priceHKDMap[productId] || 0;
      const body = JSON.stringify({ ok: true, points, totalPoints: points, status: 'done', message: '測試模式：積分已入帳（本地代理）' });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(body);
      console.log(`[Proxy][Synthetic] Award points -> session ${sessionId}, product ${productId}, points ${points}`);
      return;
    }

    // Proxy request to Apps Script
    const queryString = Object.keys(reqUrl.query)
      .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(reqUrl.query[key])}`)
      .join('&');
    
    const targetUrl = `${APPS_SCRIPT_URL}?${queryString}`;
    const hasCallback = Object.prototype.hasOwnProperty.call(reqUrl.query, 'callback');
    console.log(`[Proxy] ${req.method} ${targetUrl}${hasCallback ? ' [jsonp]' : ''}`);

    fetchWithRedirects(targetUrl, 5, (err, result) => {
      if (err) {
        console.error('[Proxy] Error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Proxy error: ' + err.message }));
        return;
      }

      const upstreamCt = result.headers['content-type'] || 'application/json; charset=utf-8';
      const status = result.status >= 200 && result.status < 400 ? 200 : result.status;

      // 若為 JSONP，強制輸出為 application/javascript 以避免瀏覽器 ORB 阻擋
      const ctOut = hasCallback ? 'application/javascript; charset=utf-8' : upstreamCt;

      res.writeHead(status, {
        'Content-Type': ctOut,
        'Access-Control-Allow-Origin': '*'
      });
      res.end(result.body);
      console.log(`[Proxy] Upstream status: ${result.status}, forwarded as: ${status}, content-type: ${upstreamCt} -> ${ctOut}`);
    });
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`代理伺服器運行在 http://localhost:${PORT}`);
  console.log(`使用方式：http://localhost:${PORT}/proxy?action=health`);
});