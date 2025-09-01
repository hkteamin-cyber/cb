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
// 新增：使用 Firebase Secrets 管理 Stripe 金鑰
const { defineSecret } = require('firebase-functions/params');
const STRIPE_SECRET = defineSecret('STRIPE_SECRET_KEY');

// Prefer env var; fallback to current Apps Script deployment used in the project
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

exports.api = onRequest({ region: 'asia-east2', secrets: [STRIPE_SECRET] }, async (req, res) => {
  try {
    const path = (req.path || '').replace(/^(\/api)*\/?/, '/');
    const method = (req.method || 'GET').toUpperCase();
    const origin = req.get('origin') || req.get('referer') || '';

    // Global: block direct Cloud Functions URL access (must come via Hosting or localhost)
    if (!isFromHosting(req)) {
      return sendJson(res, { ok: false, error: 'Forbidden: requests must come via Hosting' }, 403);
    }

    // Optional: enforce Firebase App Check for all API calls
    if (APP_CHECK_REQUIRED) {
      try {
        const appCheckToken = req.get('x-firebase-appcheck') || '';
        if (!appCheckToken) return sendJson(res, { ok: false, error: 'Missing App Check token' }, 401);
        await admin.appCheck().verifyToken(appCheckToken);
      } catch (e) {
        console.warn('App Check verification failed:', e && e.message || e);
        return sendJson(res, { ok: false, error: 'Invalid App Check token' }, 401);
      }
    }

    // Normalize inputs from either query or JSON body
    const q = Object.assign({}, req.query, (req.body && typeof req.body === 'object') ? req.body : {});

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

    // Fallback 404 for unknown routes
    return sendJson(res, { ok: false, error: 'Not Found' }, 404);
  } catch (err) {
    console.error(err);
    return sendJson(res, { ok: false, error: 'Internal Error', details: String(err && err.message || err) }, 500);
  }
});