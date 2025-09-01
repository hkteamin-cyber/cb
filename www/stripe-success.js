// 最小可用版本：Stripe + Google Sheet 付款後自動派碼（前端對接）
// 流程：
// 1) Stripe 成功回調將帶上 session_id 或 訂單標識；
// 2) 前端呼叫我們的臨時後端（Google Apps Script Web App）以 session_id 兌換充值碼；
// 3) 後端：
//    - 用 Stripe API 驗證付款狀態（必须在後端，避免暴露密鑰）
//    - 從 Google Sheet 取第一條「未使用」的充值碼，標記為已發出，並回傳
// 4) 前端接收後即時顯示、可複製
//
// 注意：此文件只包含前端最小對接；你需要提供 Google Apps Script 端點 URL（DEPLOYED_WEB_APP_URL）
// 並於 Apps Script 內實作 Stripe 驗證 + Google Sheet 派碼邏輯。

(function(){
  const $ = (id) => document.getElementById(id);
  const codeValueEl = $('codeValue');
  const copyBtn = $('copyBtn');
  const refreshBtn = $('refreshBtn');
  const statusLine = $('statusLine');
  const statusPill = $('statusPill');
  const pillSpinner = $('pillSpinner');
  const pillText = $('pillText');

  // 請在 Firebase Hosting 的環境中，將成功頁設為 Stripe Checkout 的 success_url
  // success_url 需帶上 {CHECKOUT_SESSION_ID} 例如：
  // https://your-domain/success.html?session_id={CHECKOUT_SESSION_ID}

  const params = new URLSearchParams(location.search);
  const sessionId = params.get('session_id') || params.get('sid') || '';

  // === 產品ID自動偵測 ===
  // 優先從 URL 參數讀取 productId；若無則嘗試從金額推斷
  let productId = params.get('productId');
  if (!productId) {
    const amountFromUrl = params.get('amount'); // 前端可能帶上金額參數
    if (amountFromUrl) {
      // 依金額推斷產品：4200 = 42港幣，8200 = 82港幣（Stripe 以分為單位）
      if (amountFromUrl === '4200' || amountFromUrl === '42') productId = '55';
      else if (amountFromUrl === '8200' || amountFromUrl === '82') productId = '110';
    }
  }
  // 新增：若仍無 productId，從 localStorage 讀取最後一次選購的產品
  if (!productId) {
    try {
      const last = localStorage.getItem('CBON_LAST_PRODUCT_ID');
      if (last) productId = last;
    } catch (_) {}
  }

  // 端點來源優先級：URL 參數 > localStorage > 預設
  // 已改為同源 API，僅保留以備除錯
  const endpointFromUrl = params.get('endpoint');
  const endpointFromStorage = localStorage.getItem('CBON_APPS_SCRIPT_URL');
  const DEFAULT_ENDPOINT = '/api';
  const APPS_SCRIPT_ENDPOINT = endpointFromUrl || endpointFromStorage || DEFAULT_ENDPOINT;
  // 若以絕對 URL 指定 endpoint（例如直接填入 Apps Script Web App URL），則強制走直連（CORS）
  const FORCE_DIRECT = !!(endpointFromUrl && /^https?:\/\//i.test(endpointFromUrl));
  
  // 已不再需要 use_proxy，本地與線上都走同源 API
  const useProxy = false; // 保留變數避免其他位置引用報錯，但實際不使用
  const PROXY_PREFIX = ''; // 同上
  if (endpointFromUrl) {
    // 如使用 URL 覆寫，順便寫入 storage，便於之後重用
    localStorage.setItem('CBON_APPS_SCRIPT_URL', endpointFromUrl);
  }

  // ===== Debug 面板（?debug=1 啟用） =====
  const debugEnabled = params.get('debug') === '1';
  let debug = {
    box: null,
    endpointInput: null,
    sessionEl: null,
    urlEl: null,
    respEl: null,
    init() {
      if (!debugEnabled) return;
      this.box = document.createElement('div');
      Object.assign(this.box.style, {
        position: 'fixed', right: '12px', bottom: '12px', width: '360px', maxHeight: '60vh',
        overflow: 'auto', background: '#fff', border: '1px solid #e2e2e2', boxShadow: '0 6px 20px rgba(0,0,0,0.15)',
        borderRadius: '10px', zIndex: 9999, fontSize: '12px', padding: '12px', color: '#222',
      });
      this.box.innerHTML = `
        <div style="font-weight:600;margin-bottom:8px;">Debug Panel</div>
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;">
          <span style="flex:0 0 auto;color:#555;">Endpoint</span>
          <input id="debugEndpointInput" type="text" style="flex:1 1 auto;padding:6px 8px;border:1px solid #ddd;border-radius:6px;" />
        </div>
        <div style="display:flex;gap:8px;margin-bottom:10px;">
          <button id="debugSaveEndpoint" style="flex:1 1 auto;padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#f5f5f5;cursor:pointer;">Save & Reload</button>
          <button id="debugHealth" style="flex:1 1 auto;padding:6px 8px;border:1px solid #ccc;border-radius:6px;background:#f5f5f5;cursor:pointer;">Health Check</button>
        </div>
        <div style="margin-bottom:4px;color:#555;">Session ID</div>
        <div id="debugSession" style="word-break:break-all;background:#fafafa;border:1px solid #eee;border-radius:6px;padding:6px 8px;margin-bottom:8px;">-</div>
        <div style="margin-bottom:4px;color:#555;">Final Request URL</div>
        <div id="debugUrl" style="word-break:break-all;background:#fafafa;border:1px solid #eee;border-radius:6px;padding:6px 8px;margin-bottom:8px;">-</div>
        <div style="margin-bottom:4px;color:#555;">Raw Response</div>
        <pre id="debugResp" style="white-space:pre-wrap;word-break:break-word;background:#0b1020;color:#d7e2ff;border-radius:8px;padding:8px 10px;max-height:26vh;overflow:auto;">-</pre>
      `;
      document.body.appendChild(this.box);
      this.endpointInput = document.getElementById('debugEndpointInput');
      this.endpointInput.value = APPS_SCRIPT_ENDPOINT;
      this.sessionEl = document.getElementById('debugSession');
      this.urlEl = document.getElementById('debugUrl');
      this.respEl = document.getElementById('debugResp');

      document.getElementById('debugSaveEndpoint').addEventListener('click', () => {
        const v = this.endpointInput.value.trim();
        if (!v) return;
        localStorage.setItem('CBON_APPS_SCRIPT_URL', v);
        location.href = updateQuery({ endpoint: v });
      });
      document.getElementById('debugHealth').addEventListener('click', async () => {
        if (!this.endpointInput.value) return;
        const healthUrl = `${this.endpointInput.value}?action=health&origin=${encodeURIComponent(window.location.origin)}&_=${Date.now()}`;
        this.urlEl.textContent = healthUrl;
        try {
          const r = await fetch(healthUrl, { method: 'GET', mode: 'cors', cache: 'no-cache' });
          const t = await r.text();
          this.respEl.textContent = t || '(empty response)';
        } catch (e) {
          this.respEl.textContent = 'Health fetch error: ' + (e && e.message ? e.message : e);
        }
      });
      this.sessionEl.textContent = sessionId || '(none)';
    }
  };

  function updateQuery(kv){
    const u = new URL(location.href);
    Object.keys(kv).forEach(k => {
      if (kv[k] === undefined || kv[k] === null) return;
      u.searchParams.set(k, kv[k]);
    });
    return u.toString();
  }

  debug.init();

  // === JSONP 輔助函數 ===
  function makeJsonpRequest(url, callback) {
    return new Promise((resolve, reject) => {
      const callbackName = 'jsonp_callback_' + Date.now() + '_' + Math.random().toString(36).substring(2);
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error('JSONP timeout'));
      }, 15000);
      function cleanup() { /* ... */ }
      window[callbackName] = function(data) { /* ... */ };
      const script = document.createElement('script');
      script.id = callbackName;
      script.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + callbackName;
      script.onerror = function() { /* ... */ };
      document.head.appendChild(script);
    });
  }
  // JSONP 與代理輔助已移除，統一走同源 fetch

  // === 代理模式的 fetch 請求函數 ===
  async function makeProxyRequest(url) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        mode: 'cors',
        cache: 'no-cache',
        headers: {
          'Content-Type': 'application/json',
        }
      });
      if (!response.ok) { throw new Error(`HTTP ${response.status}: ${response.statusText}`); }
      return await response.json();
    } catch (error) {
      console.error('Proxy request failed:', error);
      throw error;
    }
  }
  // 代理請求函數已移除

  // 直連 Apps Script（CORS）的輔助函式
  async function fetchDirectFromAppsScript(paramsObj) {
    const qs = new URLSearchParams(paramsObj).toString();
    const joiner = APPS_SCRIPT_ENDPOINT.includes('?') ? '&' : '?';
    const url = `${APPS_SCRIPT_ENDPOINT}${joiner}${qs}`;
    if (debugEnabled && debug.urlEl) debug.urlEl.textContent = url;
    const resp = await fetch(url, { method: 'GET', mode: 'cors', cache: 'no-cache' });
    const text = await resp.text();
    try {
      return JSON.parse(text);
    } catch (_) {
      // 嘗試 JSONP 格式
      const m = text.match(/^[a-zA-Z_$][\w$]*\((.*)\);?\s*$/s);
      if (m) { try { return JSON.parse(m[1]); } catch (_) {} }
      throw new Error(`Upstream non-JSON (HTTP ${resp.status})`);
    }
  }

  async function fetchCodeOnce() {
    if (!APPS_SCRIPT_ENDPOINT || APPS_SCRIPT_ENDPOINT.includes('YOUR_APPS_SCRIPT')) {
      setPending('未設定派碼服務端 URL，請聯絡管理員配置');
      setErrorUI('未設定派碼服務端');
      return;
    }
    if (!sessionId) {
      setPending('未獲得 Stripe session_id，請確認付款流程');
      setErrorUI('缺少 session_id');
      return;
    }

    try {
      setLoadingUI();
      const currentOrigin = window.location.origin;
      const productParam = productId ? `&productId=${encodeURIComponent(productId)}` : '';

      let data = null;

      if (FORCE_DIRECT) {
        // 使用者明確指定 endpoint（多半為 Apps Script Web App），優先直連
        if (debugEnabled && debug.urlEl) debug.urlEl.textContent = '(Direct) redeem';
        data = await fetchDirectFromAppsScript({ action: 'redeem', session_id: sessionId, productId, origin: currentOrigin, _: Date.now() });
      } else {
        // 先走同源 Functions 代理
        if (debugEnabled && debug.urlEl) debug.urlEl.textContent = `/api/redeem (POST)`;
        const r = await fetch('/api/redeem', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, productId })
        });
        try { data = await r.json(); } catch(_) { data = { ok: false, error: `Invalid JSON from /api/redeem (HTTP ${r.status})` }; }

        // 若代理回傳錯誤，且我們有 endpoint 配置，嘗試直連 Apps Script 作為後備
        const hasEndpointConfig = !!(endpointFromUrl || endpointFromStorage);
        if ((!data || data.ok === false) && hasEndpointConfig) {
          console.warn('Redeem via /api failed, trying direct Apps Script...');
          try {
            const d2 = await fetchDirectFromAppsScript({ action: 'redeem', session_id: sessionId, productId, origin: currentOrigin, _: Date.now() });
            // Apps Script 成功通常回傳 { ok: true, code: 'xxxx' }
            if (d2 && d2.ok && (d2.code || d2.redeem_code)) {
              data = { ok: true, code: d2.code || d2.redeem_code };
            } else {
              data = d2;
            }
          } catch (e2) {
            console.error('Direct Apps Script redeem fallback failed:', e2);
            // 保留原本 data 錯誤
          }
        }
      }

      if (debugEnabled && debug.respEl) debug.respEl.textContent = JSON.stringify(data, null, 2) || '(empty response)';

      if (!data) { throw new Error('服務端錯誤'); }

      if (data.ok && data.code) {
        codeValueEl.textContent = data.code;
        statusLine.textContent = '付款確認成功，充值碼已派發';
        pillSpinner.classList.add('hidden');
        pillText.textContent = '已派發';
        statusPill.classList.remove('hidden');
        copyBtn.disabled = false;

        // ===== 積分入帳（在派碼成功後進行） =====
        try {
          const uid = window.CBON_UID || localStorage.getItem('CBON_UID') || '';
          if (uid) {
            const r2 = await fetch('/api/award_points', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ session_id: sessionId, productId, uid })
            });
            const awardData = await r2.json();
            if (awardData && awardData.ok) {
              const pts = awardData.points || awardData.totalPoints || 0;
              showPointsToast(awardData.points || 0, awardData.totalPoints);
            }
          }
        } catch (e) {
          console.warn('Award points failed:', e);
        }
        // ===== 積分入帳結束 =====
        return;
      }

      // 常見狀態處理
      if (data.status === 'pending' || data.reason === 'payment_pending') {
        statusLine.textContent = '付款尚在確認中，將於確認後自動派碼…';
        pillText.textContent = '等待付款確認';
        statusPill.classList.remove('hidden');
        return;
      }

      // 將常見錯誤訊息轉為更友善的中文
      const rawErr = (data && (data.error || data.message)) || '未知錯誤';
      let friendly = rawErr;
      if (/Payment verification failed/i.test(rawErr)) {
        friendly = '付款驗證失敗，請稍後再試或聯絡客服（可能為後端 Stripe 金鑰未配置或網絡暫時問題）';
      } else if (/Missing Stripe secret key/i.test(rawErr)) {
        friendly = '後端未配置 Stripe 金鑰，請聯絡管理員';
      } else if (/Invalid session ID/i.test(rawErr)) {
        friendly = '回傳的 session_id 無效，請確認是否從付款成功頁跳轉';
      }

      throw new Error(friendly);
    } catch (err) {
      console.error('派碼失敗：', err);
      console.error('Endpoint in use:', APPS_SCRIPT_ENDPOINT);
      const msg = err && err.message ? err.message : '派碼失敗';
      setErrorUI(msg);
    }
  }

  function setLoadingUI(){
    statusLine.textContent = '正在確認付款並派發充值碼，請稍候…';
    statusPill.classList.remove('hidden');
    pillSpinner.classList.remove('hidden');
    pillText.textContent = '處理中';
    copyBtn.disabled = true;
  }
  function setErrorUI(msg){
    statusLine.textContent = `派碼遇到問題：${msg}`;
    pillSpinner.classList.add('hidden');
    pillText.textContent = '需重試';
    statusPill.classList.remove('hidden');
    copyBtn.disabled = true;
  }
  function setPending(msg){
    statusLine.textContent = msg;
    statusPill.classList.remove('hidden');
    pillSpinner.classList.add('hidden');
    pillText.textContent = '等待配置';
  }

  copyBtn.addEventListener('click', async () => {
    const text = codeValueEl.textContent.trim();
    if (!text || text === '———') return;
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = '已複製！';
      setTimeout(()=> copyBtn.textContent = '複製充值碼', 1500);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
      copyBtn.textContent = '已複製！';
      setTimeout(()=> copyBtn.textContent = '複製充值碼', 1500);
    }
  });

  refreshBtn.addEventListener('click', fetchCodeOnce);

  // 首次自動拉取
  fetchCodeOnce();
  function showPointsToast(points, total) {
    const toast = document.createElement('div');
    Object.assign(toast.style, {
      position: 'fixed', left: '50%', bottom: '88px', transform: 'translateX(-50%)',
      background: 'linear-gradient(135deg, #16a34a 0%, #22c55e 100%)', color: '#fff', padding: '10px 14px',
      borderRadius: '999px', fontWeight: '700', boxShadow: '0 10px 30px rgba(0,0,0,.25)', zIndex: 9999,
    });
    toast.textContent = `已入帳 +${points} 分` + (total ? `（總計 ${total}）` : '');
    document.body.appendChild(toast);
    setTimeout(()=>{ toast.style.opacity = '0'; toast.style.transition = 'opacity .35s'; }, 1600);
    setTimeout(()=>{ toast.remove(); }, 2100);
  }
})();