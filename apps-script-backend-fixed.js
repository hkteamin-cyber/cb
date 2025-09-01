// ========== CONFIG ==========
const CONFIG = {
  // Google Sheet ID（改為你自己的 Google Sheet ID）
  SHEET_ID: '1TmjBjGb0fvI5ZmXNvLj24eV0-BlBj3IY6T45Fb3Er1E',
  
  // Stripe Secret Key（改為你的 Stripe 測試金鑰）
  STRIPE_SECRET_KEY: '', // Moved to Script Properties. Use STRIPE_LIVE_SECRET_KEY / STRIPE_TEST_SECRET_KEY
  
  // CORS 允許的來源
  ALLOWED_ORIGINS: [
    'https://c----b.web.app',
    'https://c----b.firebaseapp.com',
    'http://localhost:61110',
    'http://127.0.0.1:61110',
    'http://localhost:8000',
    'http://127.0.0.1:8000'
  ],
  
  // 工作表名稱
  CODES_SHEET_NAME: 'codes',
  LOG_SHEET_NAME: 'logs'
};

// 根據 session_id 自動選擇 Stripe 金鑰（支援 live/test）
function getStripeSecretKeyForSession(sessionId) {
  try {
    var props = PropertiesService.getScriptProperties && PropertiesService.getScriptProperties();
    if (!props) return null;

    var isLive = typeof sessionId === 'string' && sessionId.indexOf('cs_live_') === 0;

    // Prefer explicit live key when session is live
    if (isLive) {
      var liveKey = props.getProperty('STRIPE_LIVE_SECRET_KEY');
      if (liveKey && liveKey.indexOf('sk_live_') === 0) {
        return liveKey;
      }
    }

    // Prefer explicit test key when not live
    if (!isLive) {
      var testKey = props.getProperty('STRIPE_TEST_SECRET_KEY');
      if (testKey && testKey.indexOf('sk_test_') === 0) {
        return testKey;
      }
    }

    // Generic fallback if provided
    var generic = props.getProperty('STRIPE_SECRET_KEY');
    if (generic && (generic.indexOf('sk_live_') === 0 || generic.indexOf('sk_test_') === 0)) {
      return generic;
    }
  } catch (e) {
    // ignore and return null
  }
  return null;
}

// ========== 主要處理函數 ==========
function doGet(e) {
  return handleRequest(e);
}

function doPost(e) {
  return handleRequest(e);
}

function doOptions(e) {
  // 簡單的 OPTIONS 回應，Google Apps Script 會自動處理基本 CORS
  return ContentService.createTextOutput('')
    .setMimeType(ContentService.MimeType.TEXT);
}

function handleRequest(e) {
  // 將參數、標頭與 origin 提前宣告，避免在 catch 中出現未定義問題
  const params = (e && e.parameter) || {};
  const headers = (e && e.headers) || {};
  const origin = params.origin || headers.origin || headers.Origin || '';
  const action = params.action;

  try {
    console.log('Request received:', { params, origin });

    // 處理 OPTIONS 預檢請求
    if (e && e.requestMethod === 'OPTIONS') {
      return ContentService.createTextOutput('')
        .setMimeType(ContentService.MimeType.TEXT);
    }

    switch (action) {
      case 'redeem':
        return handleRedeemCode(e, origin);
      case 'check_stock':
        return handleCheckStock(e, origin); // 支援 ?productId=xxx，將僅計算該產品的 available 數量
      case 'health':
        return createJsonResponse({
          ok: true,
          message: 'Service healthy',
          timestamp: new Date().toISOString()
        }, origin, params.callback);
      default:
        return createJsonResponse({
          ok: false,
          error: 'Invalid action',
          received_action: action || 'none'
        }, origin, params.callback);
    }

  } catch (error) {
    console.error('Request handling error:', error);
    return createJsonResponse({
      ok: false,
      error: 'Internal server error',
      details: String(error)
    }, origin, params && params.callback);
  }
}

function handleRedeemCode(e, origin) {
  try {
    const sessionId = e.parameter.session_id || e.parameter.sid;
    
    if (!sessionId) {
      return createJsonResponse({ ok: false, error: 'Missing session_id' }, origin, e.parameter && e.parameter.callback);
    }

    // 先檢查是否已存在兌換記錄
    const existingCode = findExistingCode(sessionId);
    if (existingCode) {
      console.log('Session already redeemed:', sessionId);
      return createJsonResponse({
        ok: true,
        code: existingCode,
        status: 'already_redeemed',
        message: '此付款已兌換過充值碼'
      }, origin, e.parameter && e.parameter.callback);
    }

    // 驗證 Stripe 付款
    const stripeVerification = verifyStripePayment(sessionId);
    if (!stripeVerification.success) {
      if (stripeVerification.status === 'payment_pending') {
        return createJsonResponse({
          ok: false,
          status: 'pending',
          reason: 'payment_pending',
          message: '付款仍在處理中，請稍後再試'
        }, origin, e.parameter && e.parameter.callback);
      }
      
      console.error('Stripe verification failed:', stripeVerification.error);
      return createJsonResponse({
        ok: false,
        error: stripeVerification.error || '付款驗證失敗'
      }, origin, e.parameter && e.parameter.callback);
    }

    // 分配新的充值碼（若前端帶有 productId，僅從對應產品池派發）
    const productId = e.parameter.productId;
    const newCode = assignNewCode(sessionId, stripeVerification.customer_email, productId);
    if (!newCode) {
      return createJsonResponse({
        ok: false,
        error: `暫無可用充值碼${productId ? '（產品 ' + productId + '）' : ''}，請聯絡客服`
      }, origin, e.parameter && e.parameter.callback);
    }

    return createJsonResponse({
      ok: true,
      code: newCode,
      status: 'success',
      productId: productId || 'all',
      message: '充值碼發放成功'
    }, origin, e.parameter && e.parameter.callback);

  } catch (error) {
    console.error('Redeem code error:', error);
    return createJsonResponse({
      ok: false,
      error: '服務暫時不可用，請稍後重試'
    }, origin, e.parameter && e.parameter.callback);
  }
}

// ========== 庫存檢查 ==========
function handleCheckStock(e, origin) {
  try {
    const productId = e.parameter.productId; // 新增：讀取 productId 參數
    
    const sheet = getSheet(CONFIG.CODES_SHEET_NAME);
    if (!sheet) {
      return createJsonResponse({
        ok: false,
        error: '無法存取資料表'
      }, origin, e.parameter && e.parameter.callback);
    }

    const dataRange = sheet.getDataRange();
    const values = dataRange.getValues();
    
    let availableCount = 0;
    
    // 跳過標題行，從第2行開始統計
    for (let i = 1; i < values.length; i++) {
      const row = values[i];
      const status = (row[1] || '').toString().toLowerCase().trim();
      const sku = (row[4] || '').toString().trim(); // product_sku 欄位（第5欄，索引4）
      
      // 如果指定了 productId，只計算匹配的產品
      if (productId && sku !== productId) {
        continue;
      }
      
      if (status === 'available') {
        availableCount++;
      }
    }

    console.log(`Stock check for product '${productId || 'all'}':`, { totalRows: values.length - 1, availableCount });

    return createJsonResponse({
      ok: true,
      available: availableCount > 0,
      count: availableCount,
      productId: productId || 'all' // 回傳查詢的產品ID
    }, origin, e.parameter && e.parameter.callback);

  } catch (error) {
    console.error('Check stock error:', error);
    return createJsonResponse({
      ok: false,
      error: '庫存檢查失敗',
      details: error.toString()
    }, origin, e.parameter && e.parameter.callback);
  }
}

// ========== 輔助函數 ==========
function getSheet(sheetName) {
  try {
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    return spreadsheet.getSheetByName(sheetName);
  } catch (error) {
    console.error('Error accessing sheet:', sheetName, error);
    return null;
  }
}

// ========== Stripe 驗證 ==========
function verifyStripePayment(sessionId) {
  try {
    const url = `https://api.stripe.com/v1/checkout/sessions/${sessionId}`;
    var secretKey = getStripeSecretKeyForSession(sessionId);
    if (!secretKey) {
      return { success: false, error: 'Missing Stripe secret key (configure Script Properties)' };
    }
    const options = {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    };

    const response = UrlFetchApp.fetch(url, options);
    const data = JSON.parse(response.getContentText());

    if (response.getResponseCode() !== 200) {
      return { success: false, error: 'Stripe API 錯誤', details: data };
    }

    if (data.payment_status === 'paid' && data.status === 'complete') {
      return {
        success: true,
        customer_email: data.customer_details?.email || 'unknown@example.com'
      };
    } else {
      return { success: false, status: 'payment_pending', error: '付款尚未完成' };
    }

  } catch (error) {
    console.error('Stripe verification error:', error);
    return { success: false, error: '付款驗證異常' };
  }
}

// ========== 充值碼管理 ==========
function findExistingCode(sessionId) {
  try {
    const sheet = getCodesSheet();
    const data = sheet.getDataRange().getValues();
    
    for (let i = 1; i < data.length; i++) {
      if (data[i][2] === sessionId && data[i][1] === 'assigned') {
        return data[i][0]; // 返回充值碼
      }
    }
    return null;
  } catch (error) {
    console.error('Find existing code error:', error);
    return null;
  }
}

function assignNewCode(sessionId, customerEmail, productId) {
  try {
    const sheet = getCodesSheet();
    const data = sheet.getDataRange().getValues();
    
    // 找到第一個未使用的充值碼（若指定產品，需匹配 product_sku 在第5欄）
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const status = (row[1] || '').toString().toLowerCase().trim();
      const sku = (row[4] || '').toString().trim(); // product_sku 欄位
      
      if (status !== 'available') continue;
      if (productId && sku !== productId) continue; // 僅派發指定產品
      
      const code = row[0];
      const now = new Date();
      
      // 一次性更新狀態到多個欄位：status, session_id, assigned_to, product_sku, assigned_at
      sheet.getRange(i + 1, 2, 1, 4).setValues([[
        'assigned',        // 第2欄 status
        sessionId,         // 第3欄 session_id
        customerEmail,     // 第4欄 assigned_to
        productId || sku   // 第5欄 product_sku
      ]]);
      sheet.getRange(i + 1, 6).setValue(now); // 第6欄 assigned_at（修正：原先錯誤地寫到第5欄）
      
      // 記錄日誌
      logActivity('code_assigned', sessionId, `Code: ${code}, Product: ${productId || sku}, Email: ${customerEmail}`);
      
      return code;
    }
    
    console.error('No available codes for product', productId || 'all');
    return null;
  } catch (error) {
    console.error('Assign new code error:', error);
    return null;
  }
}

function getCodesSheet() {
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const sheet = ss.getSheetByName(CONFIG.CODES_SHEET_NAME);
  if (sheet) {
    try {
      const expected = ['code','status','session_id','assigned_to','product_sku','assigned_at','redeemed_at','note'];
      const header = sheet.getRange(1, 1, 1, expected.length).getValues()[0]
        .map(v => String(v || '').toLowerCase().trim());
      let needs = false;
      for (let i = 0; i < expected.length; i++) {
        if (!header[i] || header[i] !== expected[i]) { needs = true; break; }
      }
      if (needs) {
        sheet.getRange(1, 1, 1, expected.length).setValues([expected]);
      }
    } catch (e) {
      // ignore header check errors
    }
  }
  return sheet;
}

function getLogSheet() {
  try {
    const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    let sheet = ss.getSheetByName(CONFIG.LOG_SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(CONFIG.LOG_SHEET_NAME);
      sheet.getRange(1, 1, 1, 4).setValues([['Timestamp', 'Action', 'Session ID', 'Details']]);
    }
    return sheet;
  } catch (error) {
    console.error('Get log sheet error:', error);
    return null;
  }
}

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
function createJsonResponse(data, origin, callback) {
  // JSONP 支援：若帶有 callback 參數，回傳 JavaScript
  try {
    if (callback && typeof callback === 'string') {
      const sanitized = callback.replace(/[^a-zA-Z0-9_$.]/g, '');
      return ContentService
        .createTextOutput(`${sanitized}(${JSON.stringify(data)});`)
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
  } catch (e) {
    // 忽略，退回純 JSON
  }

  // 純 JSON 回應（注意：Apps Script 的 ContentService 不支援自訂 CORS 標頭）
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ========== 輔助函數（可選，用於管理） ==========

/**
 * 批量添加充值碼（手動執行）
 * 使用方法：在 Apps Script 編輯器中運行此函數
 */
function batchAddCodes() {
  const codes = [
    // 在這裡添加你的充值碼
    'CB-TEST-001',
    'CB-TEST-002',
    'CB-TEST-003'
  ];
  
  const sheet = getCodesSheet();
  
  codes.forEach(code => {
    sheet.appendRow([code, 'available', '', '', '']);
  });
  
  console.log(`Added ${codes.length} codes to sheet`);
}

/**
 * 檢查庫存（手動執行）
 */
function checkStock() {
  const sheet = getCodesSheet();
  const data = sheet.getDataRange().getValues();
  
  let available = 0;
  let assigned = 0;
  
  for (let i = 1; i < data.length; i++) {
    if (data[i][1] === 'available') available++;
    if (data[i][1] === 'assigned') assigned++;
  }
  
  console.log(`Available codes: ${available}, Assigned codes: ${assigned}`);
  return { available, assigned };
}