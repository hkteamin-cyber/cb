/**
 * CBON 自動派碼系統 - Google Apps Script 後端
 * 
 * 設置步驟：
 * 1. 在 Google Sheets 創建一個名為「CBON充值碼庫」的表格
 * 2. 在第一個工作表中設置以下欄位（A1-H1）：
 *    code | status | session_id | assigned_to | product_sku | assigned_at | redeemed_at | note
 * 3. 將此代碼貼到 Apps Script 編輯器
 * 4. 設置配置變量（見下方 CONFIG 區域）
 * 5. 部署為 Web App，權限設為「任何人」
 */

// ========== 配置區域 ==========
const CONFIG = {
  // Google Sheet ID（從 URL 複製）
  SHEET_ID: '1TmjBjGb0fvI5ZmXNvLj24eV0-BlBj3IY6T45Fb3Er1E',
  
  // Stripe 密鑰（從 Stripe Dashboard 獲取）
  STRIPE_SECRET_KEY: '', // Moved to Script Properties. Use STRIPE_LIVE_SECRET_KEY / STRIPE_TEST_SECRET_KEY
  
  // 允許的來源域名（CORS 安全設置）
  ALLOWED_ORIGINS: [
    'https://c----b.web.app',
    'https://c----b.firebaseapp.com',
    'http://localhost:61213',
    'http://127.0.0.1:61213',
    'http://localhost:63060',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'http://localhost:8000',
    'http://127.0.0.1:8000'
  ],
  
  // 僅允許的產品ID（三種充值碼）
  ALLOWED_PRODUCT_IDS: ['55', '110', 'abc', '20'],
  
  // 產品價格（Stripe 最小單位，如 HKD 以分計算）
  PRODUCT_PRICES: {
    '55': 4200,    // 42港幣 = 4200分（特價）
    '110': 8200,   // 82港幣 = 8200分（特價）
    'abc': 900,    // 9港幣 = 900分
    '20': 1900     // 19港幣 = 1900分
  },
  
  // 工作表名稱
  CODES_SHEET_NAME: 'codes',
  LOG_SHEET_NAME: 'logs',
  POINTS_SHEET_NAME: 'points'
};

// ========== 主要處理函數 ==========
function doGet(e) {
  return handleRequest(e);
}

function doPost(e) {
  return handleRequest(e);
}

function handleRequest(e) {
  const origin = e.parameter.origin || e.headers?.origin || '';
  const callback = e.parameter.callback || e.parameter.cb || ''; // JSONP callback 參數
  
  // CORS 預檢
  if (e.parameter.method === 'OPTIONS') {
    return createCorsResponse({}, origin, callback);
  }
  
  try {
    const action = e.parameter.action;
    
    if (action === 'redeem' || action === 'redeem_code') {
      return handleRedeemCode(e, origin, callback);
    } else if (action === 'award_points') {
      return handleAwardPoints(e, origin, callback);
    } else if (action === 'get_points') {
      return handleGetPoints(e, origin, callback);
    } else if (action === 'health') {
      return createCorsResponse({ ok: true, message: 'Service healthy' }, origin, callback);
    } else if (action === 'check_stock') {
      const productId = e.parameter.productId; // 新增產品ID參數
      const stock = checkStock(productId); // 傳遞產品ID給checkStock函式
      return createCorsResponse({ 
        ok: true, 
        available: stock.available > 0,
        count: stock.available,
        productId: productId || 'all' // 回傳查詢的產品ID
      }, origin, callback);
    } else {
      return createCorsResponse({ ok: false, error: 'Invalid action' }, origin, callback);
    }
    
  } catch (error) {
    console.error('Request error:', error);
    logActivity('ERROR', e.parameter.session_id || 'unknown', error.toString());
    return createCorsResponse({ ok: false, error: 'Internal server error' }, origin, callback);
  }
}

function handleRedeemCode(e, origin, callback) {
  const sessionId = e.parameter.session_id;
  const productId = e.parameter.productId; // 新增：從請求讀取產品ID
  
  if (!sessionId) {
    return createCorsResponse({ ok: false, error: 'Missing session_id' }, origin, callback);
  }
  // 強制要求並校驗 productId 僅允許三種
  if (!productId) {
    return createCorsResponse({ ok: false, error: 'Missing productId' }, origin, callback);
  }
  if (!CONFIG.ALLOWED_PRODUCT_IDS.includes(String(productId))) {
    return createCorsResponse({ ok: false, error: 'Invalid productId' }, origin, callback);
  }
  
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);

    // 測試 session fallback：以 cs_test_ 開頭時，使用合成支付結果（僅供本地/測試用）
    let paymentStatus;
    if (String(sessionId).indexOf('cs_test_') === 0) {
      paymentStatus = {
        success: true,
        status: 'paid',
        customerEmail: 'test@example.com',
        amount: CONFIG.PRODUCT_PRICES[productId],
        currency: 'hkd'
      };
      logActivity('TEST_SESSION', sessionId, `Using synthetic payment for product ${productId}`);
    } else {
      paymentStatus = verifyStripePayment(sessionId);
    }

    if (!paymentStatus.success) {
      logActivity('PAYMENT_VERIFY_FAILED', sessionId, paymentStatus.error);
      return createCorsResponse({ 
        ok: false, 
        status: 'payment_failed',
        error: paymentStatus.error 
      }, origin, callback);
    }
    
    if (paymentStatus.status !== 'paid') {
      logActivity('PAYMENT_PENDING', sessionId, `Status: ${paymentStatus.status}`);
      return createCorsResponse({ 
        ok: false, 
        status: 'pending',
        reason: 'payment_pending'
      }, origin, callback);
    }
    
    const expectedAmount = CONFIG.PRODUCT_PRICES[productId];
    if (expectedAmount && paymentStatus.amount !== expectedAmount) {
      logActivity('AMOUNT_MISMATCH', sessionId, `Expected: ${expectedAmount}, Got: ${paymentStatus.amount}, Product: ${productId}`);
      return createCorsResponse({ 
        ok: false, 
        error: 'Payment amount mismatch'
      }, origin, callback);
    }
    
    const existingCode = findExistingCode(sessionId);
    if (existingCode) {
      logActivity('CODE_ALREADY_ASSIGNED', sessionId, `Code: ${existingCode}`);
      return createCorsResponse({ 
        ok: true, 
        code: existingCode,
        message: 'Code already assigned'
      }, origin, callback);
    }
    
    const newCode = assignNewCode(sessionId, paymentStatus.customerEmail, productId);
    if (!newCode) {
      logActivity('NO_CODES_AVAILABLE', sessionId, `Stock empty for product ${productId || 'all'}`);
      return createCorsResponse({ 
        ok: false, 
        error: 'No codes available, please contact support',
        productId: productId || 'all'
      }, origin, callback);
    }
    
    logActivity('CODE_ASSIGNED', sessionId, `Code: ${newCode}, Product: ${productId || 'all'}`);
    return createCorsResponse({ 
      ok: true, 
      code: newCode,
      productId: productId || 'all'
    }, origin, callback);
  } finally {
    lock.releaseLock();
  }
}

// ========== Stripe 驗證 ==========
// Helper: choose Stripe secret key from Script Properties based on session type
function getStripeSecretKeyForSession(sessionId) {
  try {
    var props = PropertiesService.getScriptProperties && PropertiesService.getScriptProperties();
    if (!props) return null;

    var isLive = typeof sessionId === 'string' && sessionId.indexOf('cs_live_') === 0;

    if (isLive) {
      var liveKey = props.getProperty('STRIPE_LIVE_SECRET_KEY');
      if (liveKey && liveKey.indexOf('sk_live_') === 0) return liveKey;
    }

    if (!isLive) {
      var testKey = props.getProperty('STRIPE_TEST_SECRET_KEY');
      if (testKey && testKey.indexOf('sk_test_') === 0) return testKey;
    }

    var generic = props.getProperty('STRIPE_SECRET_KEY');
    if (generic && (generic.indexOf('sk_live_') === 0 || generic.indexOf('sk_test_') === 0)) return generic;
  } catch (e) {}
  return null;
}
function verifyStripePayment(sessionId) {
  try {
    const url = `https://api.stripe.com/v1/checkout/sessions/${sessionId}`;
    var secretKey = getStripeSecretKeyForSession(sessionId);
    if (!secretKey) {
      return { success: false, error: 'Missing Stripe secret key (configure Script Properties)' };
    }
    const response = UrlFetchApp.fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${secretKey}`
      }
    });
    
    if (response.getResponseCode() !== 200) {
      return { success: false, error: 'Invalid session ID' };
    }
    
    const session = JSON.parse(response.getContentText());
    
    return {
      success: true,
      status: session.payment_status, // 'paid', 'unpaid', 'no_payment_required'
      customerEmail: session.customer_details?.email || 'unknown',
      amount: session.amount_total,
      currency: session.currency
    };
    
  } catch (error) {
    console.error('Stripe verification error:', error);
    return { success: false, error: 'Payment verification failed' };
  }
}

// ========== Google Sheet 操作 ==========
function findExistingCode(sessionId) {
  const sheet = getCodesSheet();
  const data = sheet.getDataRange().getValues();
  
  // 跳過標題行，查找已分配的碼
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[2] === sessionId && row[1] === 'assigned') { // session_id 匹配且狀態為 assigned
      return row[0]; // 返回 code
    }
  }
  
  return null;
}

function assignNewCode(sessionId, customerEmail, productId) {
  const sheet = getCodesSheet();
  const data = sheet.getDataRange().getValues();
  
  // 查找第一個未使用的碼（若指定產品，需匹配 product_sku）
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const status = row[1];
    const sku = row[4]; // product_sku
    
    if (status !== 'available') continue;
    if (productId && sku !== productId) continue; // 僅派發目標產品的碼
    
    const code = row[0];
    
    // 更新這一行的狀態
    const now = new Date();
    sheet.getRange(i + 1, 2, 1, 6).setValues([[
      'assigned',           // status
      sessionId,           // session_id
      customerEmail,       // assigned_to
      productId || sku || 'HK_TOPUP', // product_sku
      now,                // assigned_at
      ''                  // redeemed_at (空白)
    ]]);
    
    return code;
  }
  
  return null; // 沒有可用的碼（此產品或全部）
}

function getCodesSheet() {
  const spreadsheet = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  return spreadsheet.getSheetByName(CONFIG.CODES_SHEET_NAME);
}

function getLogSheet() {
  const spreadsheet = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  let logSheet = spreadsheet.getSheetByName(CONFIG.LOG_SHEET_NAME);
  
  if (!logSheet) {
    // 如果日誌表不存在，創建它
    logSheet = spreadsheet.insertSheet(CONFIG.LOG_SHEET_NAME);
    logSheet.getRange(1, 1, 1, 4).setValues([['timestamp', 'action', 'session_id', 'details']]);
  }
  
  return logSheet;
}

// ========== 日誌記錄 ==========
function logActivity(action, sessionId, details) {
  try {
    const logSheet = getLogSheet();
    const now = new Date();
    logSheet.appendRow([now, action, sessionId, details]);
  } catch (error) {
    console.error('Logging error:', error);
  }
}

// ========== 響應處理 ==========
function createCorsResponse(data, origin, callback) {
  // 若提供了 callback（或 cb），以 JSONP 格式回傳（不再嘗試設置自訂 CORS 標頭）
  if (callback && String(callback).trim()) {
    const safeCallback = String(callback).replace(/[^a-zA-Z0-9_.]/g, '');
    if (safeCallback) {
      return ContentService
        .createTextOutput(`${safeCallback}(${JSON.stringify(data)});`)
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    // 若 callback 名稱不安全，回退純 JSON
  }
  
  // 純 JSON 回應（Apps Script 的 ContentService 不支援自訂 CORS 標頭）
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// 添加 CORS 標頭的輔助函數（在 GAS 中不可靠，改為空實作以避免 TypeError）
function addCorsHeaders(response, origin) {
  // no-op: 使用 JSONP 或前端代理處理跨域
}

// ========== 輔助函數（可選，用於管理） ==========

/**
 * 批量添加充值碼（手動執行）
 * 使用方法：在 Apps Script 編輯器中運行此函數
 */
function batchAddCodes() {
  const codes = [
    'CBHK100001', 'CBHK100002', 'CBHK100003', 'CBHK100004', 'CBHK100005',
    'CBHK200001', 'CBHK200002', 'CBHK200003', 'CBHK200004', 'CBHK200005'
    // 添加更多充值碼...
  ];
  
  const sheet = getCodesSheet();
  
  codes.forEach(code => {
    sheet.appendRow([code, 'available', '', '', '', '', '', '']);
  });
  
  console.log(`Added ${codes.length} codes to sheet`);
}

/**
 * 檢查庫存（支援按產品ID過濫）
 * @param {string} productId - 產品ID，如 '55'、'110'，若未提供則查詢所有產品
 */
function checkStock(productId) {
  const sheet = getCodesSheet();
  const data = sheet.getDataRange().getValues();
  
  let available = 0;
  let assigned = 0;
  
  const pid = productId !== undefined && productId !== null ? String(productId).trim().toLowerCase() : '';
  const pidNum = pid && !isNaN(Number(pid)) ? Number(pid) : NaN;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const statusRaw = String(row[1] || '').trim(); // 第2欄 status
    const skuRaw = String(row[4] || '').trim();    // 第5欄 product_sku

    const status = statusRaw.toLowerCase();
    const sku = skuRaw.toLowerCase();
    const skuNum = sku && !isNaN(Number(sku)) ? Number(sku) : NaN;

    // 僅在指定 productId 時過濫
    if (pid) {
      const match = (sku === pid) || (!isNaN(pidNum) && !isNaN(skuNum) && pidNum === skuNum);
      if (!match) continue;
    }

    if (status === 'available') available++;
    if (status === 'assigned') assigned++;
  }
  
  console.log(`Stock check for product '${productId || 'all'}': Available codes: ${available}, Assigned codes: ${assigned}`);
  return { available, assigned };
}

// ========== 積分系統 ==========
function handleCheckStock(productId) {
  const sheet = getCodesSheet();
  const data = sheet.getDataRange().getValues();
  let available = 0;
  
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[1] === 'available') {
      available++;
    }
  }
  
  return { ok: true, available };
}

function getPointsSheet() {
  const spreadsheet = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  let sheet = spreadsheet.getSheetByName(CONFIG.POINTS_SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(CONFIG.POINTS_SHEET_NAME);
    sheet.getRange(1, 1, 1, 7).setValues([[
      'session_id', 'uid', 'amount', 'points', 'awarded_at', 'status', 'note'
    ]]);
  }
  return sheet;
}

function calcPoints(amount, currency) {
  // 1 港元 = 1 分，其他幣別可按需要轉換；MVP 先直接使用金額單位
  // Stripe amount 是最小貨幣單位（如 HKD 以分為單位），需除以 100
  try {
    const amt = Math.floor(Number(amount) / 100);
    return Math.max(0, amt);
  } catch (_) {
    return 0;
  }
}

function getTotalPoints(uid) {
  const sheet = getPointsSheet();
  const data = sheet.getDataRange().getValues();
  let total = 0;
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[1] === uid && String(row[5]).toLowerCase() === 'done') {
      total += Number(row[3]) || 0;
    }
  }
  return total;
}

function hasAwardedForSession(sessionId) {
  const sheet = getPointsSheet();
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[0] === sessionId && String(row[5]).toLowerCase() === 'done') {
      return true;
    }
  }
  return false;
}

function handleAwardPoints(e, origin, callback) {
  const sessionId = e.parameter.session_id;
  const uid = e.parameter.uid || '';
  const productId = e.parameter.productId || '';
  if (!sessionId) {
    return createCorsResponse({ ok: false, error: 'Missing session_id' }, origin, callback);
  }
  if (!uid) {
    return createCorsResponse({ ok: false, error: 'Missing uid' }, origin, callback);
  }

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);

    if (hasAwardedForSession(sessionId)) {
      const total = getTotalPoints(uid);
      return createCorsResponse({ ok: true, status: 'already_awarded', totalPoints: total }, origin, callback);
    }

    // 測試 session fallback：以 cs_test_ 開頭時，使用合成支付結果（僅供本地/測試用）
    let paymentStatus;
    if (String(sessionId).indexOf('cs_test_') === 0 && productId && CONFIG.ALLOWED_PRODUCT_IDS.indexOf(String(productId)) !== -1) {
      paymentStatus = {
        success: true,
        status: 'paid',
        customerEmail: 'test@example.com',
        amount: CONFIG.PRODUCT_PRICES[productId],
        currency: 'hkd'
      };
      logActivity('TEST_SESSION', sessionId, `Using synthetic payment for award_points, product ${productId}`);
    } else {
      paymentStatus = verifyStripePayment(sessionId);
    }

    if (!paymentStatus.success) {
      return createCorsResponse({ ok: false, error: paymentStatus.error || 'Payment verification failed' }, origin, callback);
    }
    if (paymentStatus.status !== 'paid') {
      return createCorsResponse({ ok: false, status: 'pending', reason: 'payment_pending' }, origin, callback);
    }

    const points = calcPoints(paymentStatus.amount, paymentStatus.currency);

    const sheet = getPointsSheet();
    const now = new Date();
    sheet.appendRow([sessionId, uid, paymentStatus.amount, points, now, 'done', '']);

    const total = getTotalPoints(uid);
    logActivity('POINTS_AWARDED', sessionId, `uid=${uid}, points=${points}, total=${total}`);

    return createCorsResponse({ ok: true, points, totalPoints: total }, origin, callback);
  } catch (error) {
    console.error('Award points error:', error);
    return createCorsResponse({ ok: false, error: 'Internal server error' }, origin, callback);
  } finally {
    lock.releaseLock();
  }
}

// 取得指定用戶的積分流水
function getPointsHistory(uid, limitCount) {
  const sheet = getPointsSheet();
  const data = sheet.getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[1] === uid) {
      rows.push({
        session_id: row[0],
        uid: row[1],
        amount: Number(row[2]) || 0,
        points: Number(row[3]) || 0,
        awarded_at: row[4] instanceof Date ? row[4].toISOString() : row[4],
        status: String(row[5] || ''),
        note: String(row[6] || '')
      });
    }
  }
  // 依 awarded_at 倒序
  rows.sort((a, b) => new Date(b.awarded_at) - new Date(a.awarded_at));
  return typeof limitCount === 'number' && limitCount > 0 ? rows.slice(0, limitCount) : rows;
}

// API: get_points
function handleGetPoints(e, origin, callback) {
  const uid = e.parameter.uid;
  const limitParam = e.parameter.limit;
  const limitCount = limitParam ? Math.max(1, Math.min(200, Number(limitParam))) : 20;
  if (!uid) {
    return createCorsResponse({ ok: false, error: 'Missing uid' }, origin, callback);
  }
  try {
    const total = getTotalPoints(uid);
    const history = getPointsHistory(uid, limitCount);
    return createCorsResponse({ ok: true, totalPoints: total, history }, origin, callback);
  } catch (error) {
    console.error('Get points error:', error);
    return createCorsResponse({ ok: false, error: 'Internal server error' }, origin, callback);
  }
}