/*
 * Firebase Functions: Same-origin API Gateway for CB
 * Endpoints:
 *   GET  /api/stock?productId=abc
 *   POST /api/redeem { session_id, productId }
 *   POST /api/award_points { session_id, productId, uid }
 *
 * This proxies to the existing Apps Script backend, normalizing all responses to JSON.
 */

// 在本機/模擬器環境讀取 .env.* 檔，優先 .env.local -> .env -> .env.production
let __loadedEnvFile = null; // for diagnostics only
try {
  const path = require('path');
  const fs = require('fs');
  const dotenv = require('dotenv');
  const candidates = ['.env.local', '.env', '.env.production'];
  for (const name of candidates) {
    const p = path.join(__dirname, name);
    if (fs.existsSync(p)) { dotenv.config({ path: p }); __loadedEnvFile = name; break; }
  }
} catch (e) {
  // ignore dotenv errors in production
}

const { onRequest } = require('firebase-functions/v2/https');
// 顶部：Secret 定义（文件顶层）
const { defineSecret } = require('firebase-functions/params');
const STRIPE_SECRET = defineSecret('STRIPE_SECRET_KEY');

// Keep only these three Wepayez secrets
const WEPAYEZ_MCH_ID = defineSecret('WEPAYEZ_MCH_ID');
const WEPAYEZ_API_KEY = defineSecret('WEPAYEZ_API_KEY');
const WEPAYEZ_PUBLIC_KEY = defineSecret('WEPAYEZ_PUBLIC_KEY'); // for RSA verify if needed

// XML parsing/building
const { parseStringPromise, Builder } = require('xml2js');
const WEPAYEZ_MERCHANT_ID = defineSecret('WEPAYEZ_MCH_ID');
const WEPAYEZ_STORE_ID = defineSecret('WEPAYEZ_STORE_ID'); // 如文档不需要可忽略
const WEPAYEZ_STORE_PASSWORD = defineSecret('WEPAYEZ_STORE_PASSWORD'); // 如文档不需要可忽略
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL || 'https://script.google.com/macros/s/AKfycbxm2K-W_-T1UO7LCKSIaoeSFmfShIz71zRL0C4rVRo19HEVlHUrEvf-H3jJ-7JhxQev6Q/exec';

// Add Stripe SDK
const Stripe = require('stripe');

// Initialize Firebase Admin (for optional App Check verification)
const admin = require('firebase-admin');
try { if (!admin.apps.length) { admin.initializeApp(); } } catch (_) {}

// Diagnostics: log masked keys and source once at cold start
(function(){
  function mask(v){ return (typeof v === 'string' && v.length >= 12) ? (v.slice(0,7) + '...' + v.slice(-4)) : (v ? '(set)' : '(none)'); }
  try {
    console.log('[BOOT] Env file:', __loadedEnvFile || '(none, using process env)');
    // 僅顯示 .env / process.env 中是否有設定（Secrets 將於執行時讀取）
    console.log('[BOOT] Stripe keys (process.env only):', {
      STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ? mask(process.env.STRIPE_SECRET_KEY) : '(none)',
      STRIPE_TEST_SECRET_KEY: process.env.STRIPE_TEST_SECRET_KEY ? mask(process.env.STRIPE_TEST_SECRET_KEY) : '(none)'
    });
    // 可選：打印 Wepayez base url 來源（不打印敏感值）
    console.log('[BOOT] Wepayez base url:', process.env.WEPAYEZ_BASE_URL ? '(set)' : '(none)');
  } catch(_) {}
})();

async function callAppsScript(params) {
  const qs = new URLSearchParams(params).toString();
  const url = `${APPS_SCRIPT_URL}?${qs}`;
  // Follow redirects (Apps Script uses 302 redirects)
  const resp = await fetch(url, { 
    method: 'GET',
    redirect: 'follow'
  });
  const text = await resp.text();
  // Apps Script (fixed version) returns JSON when no callback is provided
  try {
    return JSON.parse(text);
  } catch (_) {
    // Fallback: handle accidental JSONP or HTML
    const m = text.match(/^[a-zA-Z_$][\w$]*\((.*)\);?\s*$/s);
    if (m) {
      try { return JSON.parse(m[1]); } catch (_) {}
    }
    return { ok: false, error: 'Upstream returned non-JSON', status: resp.status, body: text.slice(0, 300) };
  }
}

function sendJson(res, data, status = 200) {
  res.set('Cache-Control', 'no-store');
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.status(status).send(JSON.stringify(data));
}

// --- Security helpers ---
const APP_CHECK_REQUIRED = String(process.env.APP_CHECK_REQUIRED || '').toLowerCase() === '1';

function getClientKey(req) {
  const fwdFor = (req.get('x-forwarded-for') || '').split(',')[0].trim();
  const ip = fwdFor || req.ip || '';
  const ua = req.get('user-agent') || '';
  return `${ip}|${ua.slice(0, 120)}`;
}

function isFromHosting(req) {
  const fwdHost = req.get('x-forwarded-host') || '';
  const host = req.get('host') || '';
  const isLocal = /^(localhost|127\.0\.0\.1)(:\\d+)?$/i.test(fwdHost || host);
  if (isLocal) return true;
  // Reject direct Cloud Functions/Run access when not proxied via Hosting (no x-forwarded-host)
  const isCloudHost = /cloudfunctions\.net|run\.app/i.test(host);
  if (isCloudHost && !fwdHost) return false;
  // When proxied by Hosting, x-forwarded-host should be the site domain.
  return !!fwdHost;
}

// very small in-memory rate limiter (per instance, best-effort)
const rateBuckets = new Map();
function checkRateLimit(key, limit, windowMs) {
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || (now - b.start) > windowMs) {
    b = { start: now, count: 0 };
    rateBuckets.set(key, b);
  }
  b.count++;
  return { allowed: b.count <= limit, remaining: Math.max(0, limit - b.count), reset: b.start + windowMs };
}

// 方法：exports.api（函数开头）
exports.api = onRequest({ region: 'asia-east2', secrets: [STRIPE_SECRET, WEPAYEZ_MCH_ID, WEPAYEZ_API_KEY, WEPAYEZ_PUBLIC_KEY] }, async (req, res) => {
  try {
    const path = (req.path || '').replace(/^(\/api)*\/?/, '/');
    const method = (req.method || 'GET').toUpperCase();
    const origin = req.get('origin') || req.get('referer') || '';

    // 允许第三方支付平台直接访问的回调路由（不会经过 Hosting）
    const allowExternal = (path === '/pay/wepayez/notify');

    // Global: block direct Cloud Functions URL access (must come via Hosting or localhost), but allow payment notify
    if (!allowExternal && !isFromHosting(req)) {
      return sendJson(res, { ok: false, error: 'Forbidden: requests must come via Hosting' }, 403);
    }

    // Optional: enforce Firebase App Check for all API calls
    if (APP_CHECK_REQUIRED && !allowExternal) {
      try {
        const appCheckToken = req.get('x-firebase-appcheck') || '';
        if (!appCheckToken) return sendJson(res, { ok: false, error: 'Missing App Check token' }, 401);
        await admin.appCheck().verifyToken(appCheckToken);
      } catch (e) {
        console.warn('App Check verification failed:', e && e.message || e);
        return sendJson(res, { ok: false, error: 'Invalid App Check token' }, 401);
      }
    }

    // 小工具：获取客户 IP（mch_create_ip）
    function getClientIp() {
      const xff = (req.get('x-forwarded-for') || '').split(',')[0].trim();
      return xff || req.ip || '127.0.0.1';
    }

    // 小工具：随机串
    function genNonceStr(len = 24) {
      const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      let s = '';
      for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
      return s;
    }

    // 参数排序 & 拼接：k1=v1&k2=v2（不包含 sign，忽略空值，不做 URL 编码）
    function sortAndJoin(obj) {
      return Object.keys(obj)
        .filter(k => obj[k] !== undefined && obj[k] !== null && obj[k] !== '' && k !== 'sign' && k !== 'signature')
        .sort()
        .map(k => `${k}=${obj[k]}`)
        .join('&');
    }

    // 签名：遵循文档
    // sign = SHA256( 原串 &key=商户密钥 ).toUpperCase()
    // RSA_1_256：对原串做 RSA-SHA256 签名（不追加 &key）
    function signParams(params, signType, apiKey, privateKeyPem) {
      const base = sortAndJoin(params);
      if (signType === 'SHA256') {
        const data = `${base}&key=${apiKey}`;
        const digest = require('crypto').createHash('sha256').update(data, 'utf8').digest('hex');
        return digest.toUpperCase();
      }
      if (signType === 'RSA_1_256' && privateKeyPem) {
        const signer = require('crypto').createSign('RSA-SHA256');
        signer.update(base, 'utf8');
        return signer.sign(privateKeyPem, 'base64');
      }
      return '';
    }

    // XML 构建/解析
    const xmlBuilder = new Builder({ headless: true, rootName: 'xml' });
    async function parseXml(text) {
      const obj = await parseStringPromise(text, { explicitArray: false, trim: true });
      return obj && obj.xml ? obj.xml : obj;
    }

    // Normalize inputs from either query or JSON body
    const q = Object.assign({}, req.query, (req.body && typeof req.body === 'object') ? req.body : {});

    // 新增：创建 Wepayez 支付订单（WAP）
    if (path === '/pay/wepayez/create' && method === 'POST') {
      // 价格映射（单位：分）
      const pricesHKD = { 'abc': 900, '55': 4200, '110': 8200 };
      const productId = String(q.productId || 'abc');
      const quantity = Math.max(1, Number(q.quantity || 1));
      const totalFee = (pricesHKD[productId] || pricesHKD['abc']) * quantity; // 分

      const host = req.get('x-forwarded-host') || req.get('host');
      const forwardedProto = req.get('x-forwarded-proto');
      const isLocal = host && /^(localhost|127\.0\.0\.1)(:\\d+)?$/.test(host);
      const proto = isLocal ? 'http' : (forwardedProto || req.protocol || 'https');
      const baseUrl = `${proto}://${host}`;

      const notify_url = `${baseUrl}/api/pay/wepayez/notify`;
      const callback_url = `${baseUrl}/success.html?pay=wepayez`; // 同步页仅作提示

      const mch_id = (WEPAYEZ_MCH_ID.value() || process.env.WEPAYEZ_MCH_ID || '').trim();
      const api_key = (WEPAYEZ_API_KEY.value() || process.env.WEPAYEZ_API_KEY || '').trim();
      const sign_type = 'SHA256'; // 如要切换 RSA_1_256，请调整此处并提供私钥

      if (!mch_id || !api_key) {
        return sendJson(res, { ok: false, error: 'Wepayez not configured: set WEPAYEZ_MCH_ID / WEPAYEZ_API_KEY secrets' }, 500);
      }

      const out_trade_no = `WEZ${Date.now()}${Math.floor(Math.random()*10000)}`;
      const params = {
        service: 'pay.alipay.wappay.intl',
        version: '2.0',
        charset: 'UTF-8',
        sign_type,
        mch_id,
        out_trade_no,
        body: q.body || `C BON 充值-${productId}`,
        attach: q.attach || encodeURIComponent(JSON.stringify({ productId, quantity })),
        total_fee: String(totalFee),
        mch_create_ip: getClientIp(),
        payment_inst: q.payment_inst || 'ALIPAYHK', // HKD: ALIPAYHK 或 ALIPAYCN
        notify_url,
        callback_url, // 仅本地钱包支持
        nonce_str: genNonceStr()
      };

      const sign = signParams(params, sign_type, api_key, /*privateKeyPem*/ null);
      const xml = xmlBuilder.buildObject({ ...params, sign });

      console.log('Wepayez request params:', params);
      console.log('Wepayez request XML:', xml);

      const resp = await fetch('https://gateway.wepayez.com/pay/gateway', {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset=utf-8' },
        body: xml
      });
      const text = await resp.text();
      console.log('Wepayez response:', text);
      
      let parsed = {};
      try { parsed = await parseXml(text); } catch (e) {
        console.error('Wepayez create parse XML error:', e, text);
        return sendJson(res, { ok: false, error: 'Bad XML from gateway', raw: text }, 502);
      }

      if (String(parsed.status) === '0' && String(parsed.result_code) === '0') {
        return sendJson(res, { 
          ok: true, 
          out_trade_no, 
          pay_info: parsed.pay_info || '', 
          pay_url: parsed.pay_url || '',
          raw: parsed 
        });
      }
      return sendJson(res, { ok: false, error: parsed.err_msg || parsed.message || 'Gateway error', raw: parsed }, 502);
    }

    // 新增：Wepayez 异步通知（XML）
    if (path === '/pay/wepayez/notify' && (method === 'POST')) {
      const ctype = (req.get('content-type') || '').toLowerCase();
      const xmlBody = (req.rawBody && req.rawBody.length) ? req.rawBody.toString('utf8') : (typeof req.body === 'string' ? req.body : '');
      if (!/xml/.test(ctype) && !xmlBody) {
        return res.status(400).set('Content-Type', 'text/plain; charset=utf-8').send('bad request');
      }
      let data = {};
      try { data = await parseXml(xmlBody); } catch (e) {
        console.error('notify parse error:', e, xmlBody);
        return res.status(400).set('Content-Type', 'text/plain; charset=utf-8').send('fail');
      }

      // 验签（若平台在“第4章签名规则”要求与下单一致，走同一签名规则）
      const api_key = WEPAYEZ_API_KEY.value() || process.env.WEPAYEZ_API_KEY || '';
      const sign_type = String(data.sign_type || 'SHA256').toUpperCase();
      const { sign, ...toVerify } = data;
      const base = sortAndJoin(toVerify);

      let verified = false;
      if (sign_type === 'SHA256') {
        const expect = require('crypto')
          .createHash('sha256')
          .update(`${base}&key=${api_key}`, 'utf8')
          .digest('hex')
          .toUpperCase();
        verified = (sign === expect);
      } else if (sign_type === 'RSA_1_256') {
        const publicKeyPem = (WEPAYEZ_PUBLIC_KEY && WEPAYEZ_PUBLIC_KEY.value && WEPAYEZ_PUBLIC_KEY.value()) || process.env.WEPAYEZ_PUBLIC_KEY || '';
        if (!publicKeyPem) {
          console.warn('notify missing public key for RSA_1_256');
          return res.status(200).set('Content-Type', 'text/plain; charset=utf-8').send('fail');
        }
        try {
          const verifier = require('crypto').createVerify('RSA-SHA256');
          verifier.update(base, 'utf8');
          verified = verifier.verify(publicKeyPem, String(sign), 'base64');
        } catch (e) {
          console.warn('notify RSA verify error:', e && e.message || e);
          verified = false;
        }
      }

      // 验签失败，返回协议级错误
      if (!verified) {
        console.warn('notify invalid sign', { data });
        return res.status(200).set('Content-Type', 'text/plain; charset=utf-8').send('fail');
      }

      // 检查 status 参数，0 表示调用成功，非 0 表示调用失败
      const status = String(data.status || '');
      
      // 协议级错误（status 非 0）
      if (status !== '0') {
        // 根据规范，协议级错误应返回 'success' 以确认收到通知
        return res.status(200).set('Content-Type', 'text/plain; charset=utf-8').send('success');
      }

      // 业务级检查：result_code 为 0 才视为支付成功
      if (String(data.result_code) !== '0') {
        // 业务级错误，同样返回 'success' 以确认收到通知
        return res.status(200).set('Content-Type', 'text/plain; charset=utf-8').send('success');
      }

      const out_trade_no = data.out_trade_no || '';
      let productId = '';
      try {
        const att = data.attach ? decodeURIComponent(data.attach) : '';
        if (att) { const j = JSON.parse(att); productId = j.productId || ''; }
      } catch (_) {}

      // TODO：此处对接“即买即发”发码逻辑（建议幂等控制）
      // 例如：
      // 使用 out_trade_no 作为 session_id
      if (out_trade_no) {
        await callAppsScript({ action: 'redeem', session_id: out_trade_no, productId, origin: 'wepayez' });
      }

      // 回应平台（大多数网关要求返回 success）
      return res.status(200).set('Content-Type', 'text/plain; charset=utf-8').send('success');
    }

    if (path === '/stock' && method === 'GET') {
      const productId = String(q.productId || 'abc');
      const data = await callAppsScript({ action: 'check_stock', productId, origin, _: Date.now() });
      if (data && data.ok) {
        return sendJson(res, { ok: true, sku: productId, count: Number(data.count) || 0, ts: Date.now() });
      }
      return sendJson(res, { ok: false, error: data && (data.error || data.message) || 'Stock check failed' }, 502);
    }

    if (path === '/redeem' && (method === 'POST' || method === 'GET')) {
      const sessionId = String(q.session_id || q.sessionId || '');
      const productId = String(q.productId || '');
      if (!sessionId) return sendJson(res, { ok: false, error: 'Missing session_id' }, 400);
      const data = await callAppsScript({ action: 'redeem', session_id: sessionId, productId, origin, _: Date.now() });
      if (data && data.ok) {
        return sendJson(res, { ok: true, sessionId, sku: productId, code: data.code || data.redeem_code || '' });
      }
      console.error('Redeem upstream error:', { status: data && data.status, error: data && data.error, body: data && data.body });
      return sendJson(res, { ok: false, error: data && (data.error || data.message) || 'Redeem failed' }, 502);
    }

    if (path === '/award_points' && (method === 'POST' || method === 'GET')) {
      const sessionId = String(q.session_id || q.sessionId || '');
      const productId = String(q.productId || '');
      const uid = q.uid ? String(q.uid) : '';
      if (!sessionId) return sendJson(res, { ok: false, error: 'Missing session_id' }, 400);

      // Try multiple action names to be compatible with different Apps Script deployments
      const tryActions = ['award_points', 'awardPoints'];
      for (const actionName of tryActions) {
        const data = await callAppsScript({ action: actionName, session_id: sessionId, productId, uid, origin, _: Date.now() });
        if (data && data.ok) {
          return sendJson(res, { ok: true, points: Number(data.points) || 0, totalPoints: Number(data.totalPoints) || 0 });
        }
        // If error is not simply "Invalid action", stop trying and return the error
        if (!(data && typeof data.error === 'string' && /invalid action/i.test(data.error))) {
          console.error('Award points upstream error:', { status: data && data.status, error: data && data.error, body: data && data.body });
          return sendJson(res, { ok: false, error: data && (data.error || data.message) || 'Award points failed' }, 502);
        }
      }

      // None of the action names worked
      return sendJson(res, { ok: false, error: 'Award points action not supported by upstream' }, 502);
    }

    // New: Create Checkout Session for WeChat Pay / Cards
    if (path === '/create_checkout_session' && method === 'POST') {
      // 從 Secrets 或環境變數取得 Stripe Key（Secrets 優先）
      const secretFromSM = STRIPE_SECRET.value();
      const STRIPE_SECRET_KEY = secretFromSM || process.env.STRIPE_SECRET_KEY || process.env.STRIPE_TEST_SECRET_KEY || '';
      const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

      if (!stripe) {
        // extra diagnostics to help trace env
        console.error('[ERROR] Stripe not configured. Keys presence:', {
          has_secret_manager: !!secretFromSM,
          has_STRIPE_SECRET_KEY: !!process.env.STRIPE_SECRET_KEY,
          has_STRIPE_TEST_SECRET_KEY: !!process.env.STRIPE_TEST_SECRET_KEY,
          env_file: __loadedEnvFile || '(none)'
        });
        return sendJson(res, { ok: false, error: 'Stripe not configured. Set STRIPE_SECRET_KEY.' }, 500);
      }
      try {
        const productId = String(q.productId || 'abc');
        const quantity = Math.max(1, Number(q.quantity || 1));
        // Map productId to amount (HKD cents)
        const pricesHKD = { 'abc': 900, '55': 4200, '110': 8200 };
        const amount = pricesHKD[productId] || pricesHKD['abc'];

        // Success/Cancel URLs on Hosting. We need session_id for success page.
        const host = req.get('x-forwarded-host') || req.get('host');
        const forwardedProto = req.get('x-forwarded-proto');
        const isLocal = host && /^(localhost|127\.0\.0\.1)(:\\d+)?$/.test(host);
        const proto = isLocal ? 'http' : (forwardedProto || req.protocol || 'https');
        const baseUrl = `${proto}://${host}`;
        const success_url = `${baseUrl}/success.html?session_id={CHECKOUT_SESSION_ID}&productId=${encodeURIComponent(productId)}&endpoint=${encodeURIComponent(APPS_SCRIPT_URL)}`;
        const cancel_url = `${baseUrl}/buy.html?productId=${encodeURIComponent(productId)}&cancelled=1`;

        const allowDashboardPMs = false; // force specific payment methods to pause WeChat Pay

        const sessionParams = {
          mode: 'payment',
          line_items: [
            {
              price_data: {
                currency: 'hkd',
                product_data: { name: `CBON 充值碼 ${productId}` },
                unit_amount: amount,
              },
              quantity,
            },
          ],
          success_url,
          cancel_url,
        };

        // Force Alipay + Cards; pause WeChat Pay explicitly
        if (!allowDashboardPMs) {
          sessionParams.payment_method_types = ['alipay', 'card'];
        }

        const session = await stripe.checkout.sessions.create(sessionParams);
        return sendJson(res, { ok: true, id: session.id, url: session.url });
      } catch (e) {
        console.error('Create Checkout Session error:', e);
        return sendJson(res, { ok: false, error: e.message || 'Create session failed' }, 500);
      }
    }

    if (path === '/ping' && method === 'GET') {
      // Rate limit for speedtest ping
      const key = 'ping:' + getClientKey(req);
      const rl = checkRateLimit(key, 200, 5 * 60 * 1000); // 200 per 5 minutes per IP+UA
      res.set('X-RateLimit-Limit', '200');
      res.set('X-RateLimit-Remaining', String(rl.remaining));
      res.set('X-RateLimit-Reset', String(rl.reset));
      if (!rl.allowed) return sendJson(res, { ok: false, error: 'Too Many Requests' }, 429);
      // Lightweight ping endpoint for RTT measurement
      return sendJson(res, { ok: true, ts: Date.now() });
    }

    // 超輕量 Ping：204 無內容，支援 GET/HEAD，避免 JSON 序列化與回應體開銷
    if (path === '/ping204' && (method === 'GET' || method === 'HEAD')) {
      const key = 'ping204:' + getClientKey(req);
      const rl = checkRateLimit(key, 200, 5 * 60 * 1000);
      res.set('X-RateLimit-Limit', '200');
      res.set('X-RateLimit-Remaining', String(rl.remaining));
      res.set('X-RateLimit-Reset', String(rl.reset));
      if (!rl.allowed) return sendJson(res, { ok: false, error: 'Too Many Requests' }, 429);
      res.set('Cache-Control', 'no-store');
      try { res.set('X-Server-Ts', String(Date.now())); } catch(_) {}
      return res.status(204).send();
    }

    // New: Download benchmark endpoint for measuring download speed
    if (path === '/speedtest_download' && method === 'GET') {
      // Rate limit
      const key = 'dl:' + getClientKey(req);
      const rl = checkRateLimit(key, 120, 5 * 60 * 1000); // 120 per 5 minutes per IP+UA
      res.set('X-RateLimit-Limit', '120');
      res.set('X-RateLimit-Remaining', String(rl.remaining));
      res.set('X-RateLimit-Reset', String(rl.reset));
      if (!rl.allowed) return sendJson(res, { ok: false, error: 'Too Many Requests' }, 429);
      try {
        const size = Math.max(1024, Math.min(50 * 1024 * 1024, Number(q.bytes) || (2 * 1024 * 1024))); // 1KB ~ 50MB
        const buf = Buffer.alloc(size, 0xaa);
        res.set('Cache-Control', 'no-store');
        res.set('Content-Type', 'application/octet-stream');
        res.set('Content-Length', String(buf.length));
        return res.status(200).send(buf);
      } catch (e) {
        console.error('Download bench error:', e);
        return sendJson(res, { ok: false, error: e.message || 'Download bench failed' }, 500);
      }
    }

    // 方法：exports.api（位于 /speedtest_upload 处理器之后）
    if (path === '/speedtest_upload' && method === 'POST') {
      // Rate limit
      const key = 'ul:' + getClientKey(req);
      const rl = checkRateLimit(key, 120, 5 * 60 * 1000); // 120 per 5 minutes per IP+UA
      res.set('X-RateLimit-Limit', '120');
      res.set('X-RateLimit-Remaining', String(rl.remaining));
      res.set('X-RateLimit-Reset', String(rl.reset));
      if (!rl.allowed) return sendJson(res, { ok: false, error: 'Too Many Requests' }, 429);
      // Consume request body to ensure full upload, then respond with received bytes
      try {
        let bytes = 0;
        if (req.rawBody) {
          bytes = req.rawBody.length;
        } else if (Buffer.isBuffer(req.body)) {
          bytes = req.body.length;
        } else if (typeof req.body === 'string') {
          bytes = Buffer.byteLength(req.body);
        } else {
          await new Promise((resolve) => {
            req.on('data', (chunk) => { bytes += chunk.length; });
            req.on('end', resolve);
          });
        }
        return sendJson(res, { ok: true, bytes, ts: Date.now() });
      } catch (e) {
        console.error('Upload bench error:', e);
        return sendJson(res, { ok: false, error: e.message || 'Upload bench failed' }, 500);
      }
    }

    // 仅保留同步返回（return）路由
    if (path === '/pay/wepayez/return' && method === 'GET') {
      return res.status(302).set('Location', '/success.html?pay=wepayez').end();
    }

    // Fallback 404 for unknown routes
    return sendJson(res, { ok: false, error: 'Not Found' }, 404);
  } catch (err) {
    console.error(err);
    return sendJson(res, { ok: false, error: 'Internal Error', details: String(err && err.message || err) }, 500);
  }
});

// 文件末尾：仅保留工具函数（删除重复的第二个 exports.api）
const crypto = require('crypto');

function sortParams(obj) {
  return Object.keys(obj)
    .filter(k => obj[k] !== undefined && obj[k] !== null && obj[k] !== '' && k !== 'sign' && k !== 'signature')
    .sort()
    .map(k => `${k}=${obj[k]}`)
    .join('&');
}

// TODO: 根据平台文档选择签名算法（例如 HMAC-SHA256 / MD5 / RSA2 等）
function wepayezSign(params, signType, apiKey, privateKeyPem) {
  const base = sortParams(params);
  if (!signType) return '';
  if (signType.toUpperCase() === 'HMAC-SHA256') {
    return crypto.createHmac('sha256', apiKey).update(base).digest('hex').toUpperCase();
  }
  if (signType.toUpperCase() === 'MD5') {
    return crypto.createHash('md5').update(base + '&key=' + apiKey).digest('hex').toUpperCase();
  }
  if (signType.toUpperCase() === 'RSA2') {
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(base);
    return signer.sign(privateKeyPem, 'base64');
  }
  return '';
}

// TODO: 按平台文档实现验签（回调）
function wepayezVerifySign(params, signType, apiKey, publicKeyPem) {
  const { sign, signature, ...rest } = params || {};
  const sig = sign || signature || '';
  const base = sortParams(rest);
  if (!sig) return false;
  if (signType.toUpperCase() === 'HMAC-SHA256') {
    const expect = crypto.createHmac('sha256', apiKey).update(base).digest('hex').toUpperCase();
    return sig === expect;
  }
  if (signType.toUpperCase() === 'MD5') {
    const expect = crypto.createHash('md5').update(base + '&key=' + apiKey).digest('hex').toUpperCase();
    return sig === expect;
  }
  if (signType.toUpperCase() === 'RSA2') {
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(base);
    try { return verifier.verify(publicKeyPem, sig, 'base64'); } catch { return false; }
  }
  return false;
}

// 兼容多种“成功态”字段（待按文档精确化）
function isPaySuccess(p) {
  const v = String(
    p.trade_status || p.pay_status || p.status || p.resultCode || p.result || ''
  ).toUpperCase();
  return ['SUCCESS', 'TRADE_SUCCESS', 'PAID', '2'].includes(v);
}

// 价格映射（HKD 分）
const pricesHKD = { 'abc': 900, '55': 4200, '110': 8200 };

// Fallback 404 for unknown routes
// return sendJson(res, { ok: false, error: 'Not Found' }, 404);
// } catch (err) {
// console.error(err);
// return sendJson(res, { ok: false, error: 'Internal Error', details: String(err && err.message || err) }, 500);
// }
// });