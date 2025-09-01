/**
 * CBON 自動派碼系統 - 完整版本
 * 包含：庫存檢查、派碼、積分系統
 * 
 * Script Properties 需設定：
 * STRIPE_SECRET_KEY: sk_live_xxx... (或用更具體的 STRIPE_LIVE_SECRET_KEY / STRIPE_TEST_SECRET_KEY)
 * 
 * Google Sheet 欄位：
 * codes 表: code | status | session_id | assigned_to | product_sku | assigned_at | redeemed_at | note
 * logs 表: timestamp | action | session_id | details
 * points 表: session_id | uid | amount | points | awarded_at | status | note
 */

// ========== CONFIG ==========
const CONFIG = {
  SHEET_ID: '1TmjBjGb0fvI5ZmXNvLj24eV0-BlBj3IY6T45Fb3Er1E',
  STRIPE_SECRET_KEY: '', // 已移至 Script Properties
  
  ALLOWED_ORIGINS: [
    'https://c----b.web.app',
    'https://c----b.firebaseapp.com',
    'http://localhost:61110',
    'http://127.0.0.1:61110',
    'http://localhost:8000',
    'http://127.0.0.1:8000',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'http://localhost:5007',
    'http://127.0.0.1:5007'
  ],
  
  ALLOWED_PRODUCT_IDS: ['55', '110', 'abc'],
  PRODUCT_PRICES: {
    '55': 4200,    // 42港幣 = 4200分
    '110': 8200,   // 82港幣 = 8200分  
    'abc': 900     // 9港幣 = 900分
  },
  
  CODES_SHEET_NAME: 'codes',
  LOG_SHEET_NAME: 'logs',
  POINTS_SHEET_NAME: 'points',
  MEMBERS_SHEET_NAME: 'members',
  ORDERS_SHEET_NAME: 'orders',
  MEMBER_MERGE_SHEET_NAME: 'member_merges'
};

// ========== 主要處理函數 ==========
function doGet(e) {
  return handleRequest(e);
}

function doPost(e) {
  return handleRequest(e);
}

function doOptions(e) {
  return ContentService.createTextOutput('')
    .setMimeType(ContentService.MimeType.TEXT);
}

function handleRequest(e) {
  const params = (e && e.parameter) || {};
  const headers = (e && e.headers) || {};
  const origin = params.origin || headers.origin || headers.Origin || '';
  const action = params.action;

  try {
    console.log('Request received:', { action, origin, params });

    // 處理 OPTIONS 預檢請求
    if (e && e.requestMethod === 'OPTIONS') {
      return ContentService.createTextOutput('')
        .setMimeType(ContentService.MimeType.TEXT);
    }

    switch (action) {
      case 'redeem':
      case 'redeem_code':
        return handleRedeemCode(e, origin);
      case 'award_points':
        return handleAwardPoints(e, origin);
      case 'get_points':
        return handleGetPoints(e, origin);
      case 'check_stock':
        return handleCheckStock(e, origin);
      case 'import_user':
        return handleImportUser(e, origin);
      case 'import_order':
        return handleImportOrder(e, origin);
      case 'import_points':
        return handleImportPoints(e, origin);
      case 'merge_accounts':
        return handleMergeAccounts(e, origin);
      case 'get_member_stats':
        return handleGetMemberStats(e, origin);
      case 'find_member_by_number':
        return handleFindMemberByNumber(e, origin);
      case 'validate_member_numbers':
        return handleValidateMemberNumbers(e, origin);
      case 'bind_member_number':
        return handleBindMemberNumber(e, origin);
      case 'unbind_member_number':
        return handleUnbindMemberNumber(e, origin);
      case 'get_member_binding':
        return handleGetMemberBinding(e, origin);
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
    logActivity('ERROR', params.session_id || 'unknown', error.toString());
    return createJsonResponse({
      ok: false,
      error: 'Internal server error',
      details: String(error)
    }, origin, params && params.callback);
  }
}

// ========== 派碼處理 ==========
function handleRedeemCode(e, origin) {
  try {
    const sessionId = e.parameter.session_id || e.parameter.sid;
    const productId = e.parameter.productId;
    
    if (!sessionId) {
      return createJsonResponse({ ok: false, error: 'Missing session_id' }, origin, e.parameter && e.parameter.callback);
    }

    // 檢驗 productId（如有提供）
    if (productId && !CONFIG.ALLOWED_PRODUCT_IDS.includes(String(productId))) {
      return createJsonResponse({ ok: false, error: 'Invalid productId' }, origin, e.parameter && e.parameter.callback);
    }

    const lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);

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

      // 測試 session fallback
      let paymentStatus;
      if (String(sessionId).indexOf('cs_test_') === 0) {
        paymentStatus = {
          success: true,
          status: 'paid',
          customerEmail: 'test@example.com',
          amount: productId ? CONFIG.PRODUCT_PRICES[productId] : 900,
          currency: 'hkd'
        };
        logActivity('TEST_SESSION', sessionId, `Using synthetic payment for product ${productId || 'default'}`);
      } else {
        paymentStatus = verifyStripePayment(sessionId);
      }

      if (!paymentStatus.success) {
        logActivity('PAYMENT_VERIFY_FAILED', sessionId, paymentStatus.error);
        return createJsonResponse({
          ok: false,
          error: paymentStatus.error || '付款驗證失敗'
        }, origin, e.parameter && e.parameter.callback);
      }

      if (paymentStatus.status !== 'paid') {
        logActivity('PAYMENT_PENDING', sessionId, `Status: ${paymentStatus.status}`);
        return createJsonResponse({
          ok: false,
          status: 'pending',
          reason: 'payment_pending',
          message: '付款仍在處理中，請稍後再試'
        }, origin, e.parameter && e.parameter.callback);
      }

      // 金額檢驗（如有指定產品）
      if (productId && CONFIG.PRODUCT_PRICES[productId] && paymentStatus.amount !== CONFIG.PRODUCT_PRICES[productId]) {
        logActivity('AMOUNT_MISMATCH', sessionId, `Expected: ${CONFIG.PRODUCT_PRICES[productId]}, Got: ${paymentStatus.amount}, Product: ${productId}`);
        return createJsonResponse({
          ok: false,
          error: 'Payment amount mismatch'
        }, origin, e.parameter && e.parameter.callback);
      }

      // 分配新的充值碼
      const newCode = assignNewCode(sessionId, paymentStatus.customerEmail, productId);
      if (!newCode) {
        logActivity('NO_CODES_AVAILABLE', sessionId, `Stock empty for product ${productId || 'all'}`);
        return createJsonResponse({
          ok: false,
          error: `暫無可用充值碼${productId ? '（產品 ' + productId + '）' : ''}，請聯絡客服`
        }, origin, e.parameter && e.parameter.callback);
      }

      logActivity('CODE_ASSIGNED', sessionId, `Code: ${newCode}, Product: ${productId || 'all'}`);
      return createJsonResponse({
        ok: true,
        code: newCode,
        status: 'success',
        productId: productId || 'all',
        message: '充值碼發放成功'
      }, origin, e.parameter && e.parameter.callback);

    } finally {
      lock.releaseLock();
    }

  } catch (error) {
    console.error('Redeem code error:', error);
    return createJsonResponse({
      ok: false,
      error: '服務暫時不可用，請稍後重試'
    }, origin, e.parameter && e.parameter.callback);
  }
}

// ========== 積分處理 ==========
function handleAwardPoints(e, origin) {
  const sessionId = e.parameter.session_id;
  const uid = e.parameter.uid || '';
  const productId = e.parameter.productId || '';
  
  if (!sessionId) {
    return createJsonResponse({ ok: false, error: 'Missing session_id' }, origin, e.parameter && e.parameter.callback);
  }
  if (!uid) {
    return createJsonResponse({ ok: false, error: 'Missing uid' }, origin, e.parameter && e.parameter.callback);
  }

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);

    // 檢查是否已獎勵過
    if (hasAwardedForSession(sessionId)) {
      const total = getTotalPoints(uid);
      return createJsonResponse({ 
        ok: true, 
        status: 'already_awarded', 
        totalPoints: total,
        points: 0
      }, origin, e.parameter && e.parameter.callback);
    }

    // 測試 session fallback
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
      return createJsonResponse({ 
        ok: false, 
        error: paymentStatus.error || 'Payment verification failed' 
      }, origin, e.parameter && e.parameter.callback);
    }
    
    if (paymentStatus.status !== 'paid') {
      return createJsonResponse({ 
        ok: false, 
        status: 'pending', 
        reason: 'payment_pending' 
      }, origin, e.parameter && e.parameter.callback);
    }

    const points = calcPoints(paymentStatus.amount, paymentStatus.currency);

    const sheet = getPointsSheet();
    const now = new Date();
    sheet.appendRow([sessionId, uid, paymentStatus.amount, points, now, 'done', '']);

    const total = getTotalPoints(uid);
    logActivity('POINTS_AWARDED', sessionId, `uid=${uid}, points=${points}, total=${total}`);

    return createJsonResponse({ 
      ok: true, 
      points, 
      totalPoints: total 
    }, origin, e.parameter && e.parameter.callback);
    
  } catch (error) {
    console.error('Award points error:', error);
    return createJsonResponse({ 
      ok: false, 
      error: 'Internal server error' 
    }, origin, e.parameter && e.parameter.callback);
  } finally {
    lock.releaseLock();
  }
}

// ========== 庫存檢查 ==========
function handleCheckStock(e, origin) {
  try {
    const productId = e.parameter.productId;
    
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
      const sku = (row[4] || '').toString().trim(); // product_sku 欄位
      
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
      productId: productId || 'all'
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

// ========== 積分查詢 ==========
function handleGetPoints(e, origin) {
  const uid = e.parameter.uid;
  const limitParam = e.parameter.limit;
  const limitCount = limitParam ? Math.max(1, Math.min(200, Number(limitParam))) : 20;
  
  if (!uid) {
    return createJsonResponse({ ok: false, error: 'Missing uid' }, origin, e.parameter && e.parameter.callback);
  }
  
  try {
    const total = getTotalPoints(uid);
    const history = getPointsHistory(uid, limitCount);
    return createJsonResponse({ ok: true, totalPoints: total, history }, origin, e.parameter && e.parameter.callback);
  } catch (error) {
    console.error('Get points error:', error);
    return createJsonResponse({ ok: false, error: 'Internal server error' }, origin, e.parameter && e.parameter.callback);
  }
}

// ========== Stripe 驗證 ==========
function getStripeSecretKeyForSession(sessionId) {
  try {
    var props = PropertiesService.getScriptProperties && PropertiesService.getScriptProperties();
    if (!props) return null;

    var isLive = typeof sessionId === 'string' && sessionId.indexOf('cs_live_') === 0;

    // 優先使用明確的 live/test 金鑰
    if (isLive) {
      var liveKey = props.getProperty('STRIPE_LIVE_SECRET_KEY');
      if (liveKey && liveKey.indexOf('sk_live_') === 0) return liveKey;
    }

    if (!isLive) {
      var testKey = props.getProperty('STRIPE_TEST_SECRET_KEY');
      if (testKey && testKey.indexOf('sk_test_') === 0) return testKey;
    }

    // 通用回退
    var generic = props.getProperty('STRIPE_SECRET_KEY');
    if (generic && (generic.indexOf('sk_live_') === 0 || generic.indexOf('sk_test_') === 0)) return generic;
  } catch (e) {
    console.error('Error getting Stripe key:', e);
  }
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
      status: session.payment_status,
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
function getSheet(sheetName) {
  try {
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    return spreadsheet.getSheetByName(sheetName);
  } catch (error) {
    console.error('Error accessing sheet:', sheetName, error);
    return null;
  }
}

function findExistingCode(sessionId) {
  try {
    const sheet = getSheet(CONFIG.CODES_SHEET_NAME);
    if (!sheet) return null;
    
    const dataRange = sheet.getDataRange();
    const values = dataRange.getValues();
    
    for (let i = 1; i < values.length; i++) {
      const row = values[i];
      if (row[2] === sessionId) { // session_id 在第3欄（索引2）
        return row[0]; // code 在第1欄（索引0）
      }
    }
    return null;
  } catch (error) {
    console.error('Error finding existing code:', error);
    return null;
  }
}

function assignNewCode(sessionId, customerEmail, productId) {
  try {
    const sheet = getSheet(CONFIG.CODES_SHEET_NAME);
    if (!sheet) return null;
    
    const dataRange = sheet.getDataRange();
    const values = dataRange.getValues();
    
    for (let i = 1; i < values.length; i++) {
      const row = values[i];
      const status = (row[1] || '').toString().toLowerCase().trim();
      const sku = (row[4] || '').toString().trim();
      
      // 如果指定了產品ID，只從對應產品池選擇
      if (productId && sku !== productId) {
        continue;
      }
      
      if (status === 'available') {
        const code = row[0];
        const now = new Date();
        
        // 一次性更新狀態到多個欄位：status, session_id, assigned_to, product_sku, assigned_at
        sheet.getRange(i + 1, 2, 1, 5).setValues([[
          'assigned',        // 第2欄 status
          sessionId,         // 第3欄 session_id
          customerEmail,     // 第4欄 assigned_to
          productId || sku,  // 第5欄 product_sku
          now                // 第6欄 assigned_at
        ]]);
        
        return code;
      }
    }
    return null;
  } catch (error) {
    console.error('Error assigning new code:', error);
    return null;
  }
}

function getPointsSheet() {
  const sheet = getSheet(CONFIG.POINTS_SHEET_NAME);
  if (!sheet) {
    // 創建積分表
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    const newSheet = spreadsheet.insertSheet(CONFIG.POINTS_SHEET_NAME);
    newSheet.getRange(1, 1, 1, 7).setValues([[
      'session_id', 'uid', 'amount', 'points', 'awarded_at', 'status', 'note'
    ]]);
    return newSheet;
  }
  return sheet;
}

function calcPoints(amount, currency) {
  try {
    const amt = Math.floor(Number(amount) / 100); // Stripe amount 以分為單位
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
  rows.sort((a, b) => new Date(b.awarded_at) - new Date(a.awarded_at));
  return typeof limitCount === 'number' && limitCount > 0 ? rows.slice(0, limitCount) : rows;
}

function logActivity(action, sessionId, details) {
  try {
    const sheet = getSheet(CONFIG.LOG_SHEET_NAME);
    if (sheet) {
      const now = new Date();
      sheet.appendRow([now, action, sessionId || '', details || '']);
    }
  } catch (error) {
    console.error('Error logging activity:', error);
  }
}

// ========== 輔助函數 ==========
function createJsonResponse(data, origin, callback) {
  try {
    // JSONP 支援
    if (callback && typeof callback === 'string') {
      const sanitized = callback.replace(/[^a-zA-Z0-9_$.]/g, '');
      return ContentService
        .createTextOutput(`${sanitized}(${JSON.stringify(data)});`)
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
  } catch (_) {
    // 退回純 JSON
  }
  
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ========== 會員整合功能 ==========

// 導入用戶
function handleImportUser(e, origin) {
  try {
    const postData = e.postData ? JSON.parse(e.postData.contents) : null;
    const user = postData ? postData.user : null;
    
    if (!user || !user.external_id) {
      return createJsonResponse({ 
        ok: false, 
        error: 'Missing user data or external_id' 
      }, origin, e.parameter && e.parameter.callback);
    }

    const lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);
      
      // 檢查是否已存在
      const existingUser = findUserByExternalId(user.external_id, user.external_source);
      if (existingUser) {
        return createJsonResponse({ 
          ok: true, 
          status: 'already_exists',
          user_id: existingUser.id
        }, origin, e.parameter && e.parameter.callback);
      }

      // 插入新用戶
      const userId = insertUser(user);
      logActivity('USER_IMPORTED', user.external_id, `Source: ${user.external_source}, ID: ${userId}`);
      
      return createJsonResponse({ 
        ok: true, 
        status: 'imported',
        user_id: userId
      }, origin, e.parameter && e.parameter.callback);
      
    } finally {
      lock.releaseLock();
    }
    
  } catch (error) {
    console.error('Import user error:', error);
    return createJsonResponse({ 
      ok: false, 
      error: 'Internal server error',
      details: error.toString()
    }, origin, e.parameter && e.parameter.callback);
  }
}

// 導入訂單
function handleImportOrder(e, origin) {
  try {
    const postData = e.postData ? JSON.parse(e.postData.contents) : null;
    const order = postData ? postData.order : null;
    
    if (!order || !order.external_id) {
      return createJsonResponse({ 
        ok: false, 
        error: 'Missing order data or external_id' 
      }, origin, e.parameter && e.parameter.callback);
    }

    const lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);
      
      const existingOrder = findOrderByExternalId(order.external_id, order.external_source);
      if (existingOrder) {
        return createJsonResponse({ 
          ok: true, 
          status: 'already_exists',
          order_id: existingOrder.id
        }, origin, e.parameter && e.parameter.callback);
      }

      const orderId = insertOrder(order);
      logActivity('ORDER_IMPORTED', order.external_id, `Source: ${order.external_source}, ID: ${orderId}`);
      
      return createJsonResponse({ 
        ok: true, 
        status: 'imported',
        order_id: orderId
      }, origin, e.parameter && e.parameter.callback);
      
    } finally {
      lock.releaseLock();
    }
    
  } catch (error) {
    console.error('Import order error:', error);
    return createJsonResponse({ 
      ok: false, 
      error: 'Internal server error'
    }, origin, e.parameter && e.parameter.callback);
  }
}

// 導入積分
function handleImportPoints(e, origin) {
  try {
    const postData = e.postData ? JSON.parse(e.postData.contents) : null;
    const points = postData ? postData.points : null;
    
    if (!points || !points.external_id) {
      return createJsonResponse({ 
        ok: false, 
        error: 'Missing points data or external_id' 
      }, origin, e.parameter && e.parameter.callback);
    }

    const lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);
      
      const existingPoints = findPointsByExternalId(points.external_id, points.external_source);
      if (existingPoints) {
        return createJsonResponse({ 
          ok: true, 
          status: 'already_exists'
        }, origin, e.parameter && e.parameter.callback);
      }

      insertImportedPoints(points);
      logActivity('POINTS_IMPORTED', points.external_id, `Source: ${points.external_source}, Points: ${points.points}`);
      
      return createJsonResponse({ 
        ok: true, 
        status: 'imported'
      }, origin, e.parameter && e.parameter.callback);
      
    } finally {
      lock.releaseLock();
    }
    
  } catch (error) {
    console.error('Import points error:', error);
    return createJsonResponse({ 
      ok: false, 
      error: 'Internal server error'
    }, origin, e.parameter && e.parameter.callback);
  }
}

// 合併帳戶
function handleMergeAccounts(e, origin) {
  try {
    const postData = e.postData ? JSON.parse(e.postData.contents) : null;
    const mergeData = postData ? postData.merge : null;
    
    if (!mergeData || !mergeData.primary_user_id || !mergeData.duplicate_user_ids) {
      return createJsonResponse({ 
        ok: false, 
        error: 'Missing merge data' 
      }, origin, e.parameter && e.parameter.callback);
    }

    const lock = LockService.getScriptLock();
    try {
      lock.waitLock(15000);
      
      const results = mergeUserAccounts(mergeData.primary_user_id, mergeData.duplicate_user_ids, mergeData.merge_rules || {});
      logActivity('ACCOUNTS_MERGED', mergeData.primary_user_id, `Merged ${mergeData.duplicate_user_ids.length} accounts`);
      
      return createJsonResponse({ 
        ok: true, 
        status: 'merged',
        results: results
      }, origin, e.parameter && e.parameter.callback);
      
    } finally {
      lock.releaseLock();
    }
    
  } catch (error) {
    console.error('Merge accounts error:', error);
    return createJsonResponse({ 
      ok: false, 
      error: 'Internal server error'
    }, origin, e.parameter && e.parameter.callback);
  }
}

// 獲取會員統計
function handleGetMemberStats(e, origin) {
  try {
    const stats = getMemberStatistics();
    return createJsonResponse({ 
      ok: true, 
      stats: stats
    }, origin, e.parameter && e.parameter.callback);
    
  } catch (error) {
    console.error('Get member stats error:', error);
    return createJsonResponse({ 
      ok: false, 
      error: 'Internal server error'
    }, origin, e.parameter && e.parameter.callback);
  }
}

// 根據會員號碼查找會員
function handleFindMemberByNumber(e, origin) {
  try {
    const memberNumber = e.parameter.member_number;
    
    if (!memberNumber) {
      return createJsonResponse({ 
        ok: false, 
        error: 'Missing member_number parameter' 
      }, origin, e.parameter && e.parameter.callback);
    }

    // 標準化會員號碼
    const normalizedNumber = normalizeMemberNumber(memberNumber);
    if (!normalizedNumber) {
      return createJsonResponse({ 
        ok: false, 
        error: 'Invalid member number format' 
      }, origin, e.parameter && e.parameter.callback);
    }

    const member = findUserByMemberNumber(normalizedNumber);
    
    if (member) {
      return createJsonResponse({ 
        ok: true, 
        found: true,
        member: {
          id: member.id,
          member_number: member.member_number,
          name: member.name,
          email: member.email,
          phone: member.phone,
          external_source: member.external_source
        }
      }, origin, e.parameter && e.parameter.callback);
    } else {
      return createJsonResponse({ 
        ok: true, 
        found: false,
        message: '找不到該會員號碼'
      }, origin, e.parameter && e.parameter.callback);
    }
    
  } catch (error) {
    console.error('Find member by number error:', error);
    return createJsonResponse({ 
      ok: false, 
      error: 'Internal server error'
    }, origin, e.parameter && e.parameter.callback);
  }
}

// 綁定會員號碼
function handleBindMemberNumber(e, origin) {
  try {
    const uid = e.parameter.uid;
    const memberNumber = e.parameter.member_number;
    const force = e.parameter.force === 'true';
    
    if (!uid || !memberNumber) {
      return createJsonResponse({ 
        ok: false, 
        error: 'Missing uid or member_number parameter' 
      }, origin, e.parameter && e.parameter.callback);
    }

    // 標準化會員號碼
    const normalizedNumber = normalizeMemberNumber(memberNumber);
    if (!normalizedNumber) {
      return createJsonResponse({ 
        ok: false, 
        error: 'Invalid member number format' 
      }, origin, e.parameter && e.parameter.callback);
    }

    const lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);
      
      // 檢查該會員號碼是否已被其他用戶綁定
      const existingBinding = findMemberBinding(normalizedNumber);
      if (existingBinding && existingBinding.uid !== uid && !force) {
        return createJsonResponse({ 
          ok: false, 
          error: 'Member number already bound to another user',
          code: 'ALREADY_BOUND'
        }, origin, e.parameter && e.parameter.callback);
      }
      
      // 檢查用戶是否已綁定其他會員號碼
      const userBinding = findUserBinding(uid);
      if (userBinding && userBinding.member_number !== normalizedNumber && !force) {
        return createJsonResponse({ 
          ok: false, 
          error: 'User already bound to another member number',
          code: 'USER_ALREADY_BOUND',
          current_number: userBinding.member_number
        }, origin, e.parameter && e.parameter.callback);
      }
      
      // 執行綁定
      const result = bindMemberNumber(uid, normalizedNumber, force);
      
      if (result.success) {
        logActivity('MEMBER_NUMBER_BOUND', uid, `Member number: ${normalizedNumber}`);
        return createJsonResponse({ 
          ok: true, 
          member_number: normalizedNumber,
          message: 'Member number bound successfully'
        }, origin, e.parameter && e.parameter.callback);
      } else {
        return createJsonResponse({ 
          ok: false, 
          error: result.error
        }, origin, e.parameter && e.parameter.callback);
      }
      
    } finally {
      lock.releaseLock();
    }
    
  } catch (error) {
    console.error('Bind member number error:', error);
    return createJsonResponse({ 
      ok: false, 
      error: 'Internal server error'
    }, origin, e.parameter && e.parameter.callback);
  }
}

// 解綁會員號碼
function handleUnbindMemberNumber(e, origin) {
  try {
    const uid = e.parameter.uid;
    
    if (!uid) {
      return createJsonResponse({ 
        ok: false, 
        error: 'Missing uid parameter' 
      }, origin, e.parameter && e.parameter.callback);
    }

    const lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);
      
      const result = unbindMemberNumber(uid);
      
      if (result.success) {
        logActivity('MEMBER_NUMBER_UNBOUND', uid, `Unbound member number: ${result.member_number}`);
        return createJsonResponse({ 
          ok: true, 
          message: 'Member number unbound successfully'
        }, origin, e.parameter && e.parameter.callback);
      } else {
        return createJsonResponse({ 
          ok: false, 
          error: result.error
        }, origin, e.parameter && e.parameter.callback);
      }
      
    } finally {
      lock.releaseLock();
    }
    
  } catch (error) {
    console.error('Unbind member number error:', error);
    return createJsonResponse({ 
      ok: false, 
      error: 'Internal server error'
    }, origin, e.parameter && e.parameter.callback);
  }
}

// 獲取會員綁定狀態
function handleGetMemberBinding(e, origin) {
  try {
    const uid = e.parameter.uid;
    
    if (!uid) {
      return createJsonResponse({ 
        ok: false, 
        error: 'Missing uid parameter' 
      }, origin, e.parameter && e.parameter.callback);
    }

    const binding = findUserBinding(uid);
    
    if (binding) {
      return createJsonResponse({ 
        ok: true, 
        bound: true,
        member_number: binding.member_number,
        bound_at: binding.bound_at
      }, origin, e.parameter && e.parameter.callback);
    } else {
      return createJsonResponse({ 
        ok: true, 
        bound: false
      }, origin, e.parameter && e.parameter.callback);
    }
    
  } catch (error) {
    console.error('Get member binding error:', error);
    return createJsonResponse({ 
      ok: false, 
      error: 'Internal server error'
    }, origin, e.parameter && e.parameter.callback);
  }
}
  try {
    const postData = e.postData ? JSON.parse(e.postData.contents) : null;
    const memberNumbers = postData ? postData.member_numbers : null;
    
    if (!memberNumbers || !Array.isArray(memberNumbers)) {
      return createJsonResponse({ 
        ok: false, 
        error: 'Missing or invalid member_numbers array' 
      }, origin, e.parameter && e.parameter.callback);
    }

    const results = [];
    
    memberNumbers.forEach(number => {
      const normalizedNumber = normalizeMemberNumber(number);
      const exists = normalizedNumber ? findUserByMemberNumber(normalizedNumber) : null;
      
      results.push({
        original_number: number,
        normalized_number: normalizedNumber,
        exists: !!exists,
        member_info: exists ? {
          id: exists.id,
          name: exists.name,
          external_source: exists.external_source
        } : null
      });
    });
    
    return createJsonResponse({ 
      ok: true, 
      results: results,
      summary: {
        total: memberNumbers.length,
        found: results.filter(r => r.exists).length,
        not_found: results.filter(r => !r.exists).length
      }
    }, origin, e.parameter && e.parameter.callback);
    
  } catch (error) {
    console.error('Validate member numbers error:', error);
    return createJsonResponse({ 
      ok: false, 
      error: 'Internal server error'
    }, origin, e.parameter && e.parameter.callback);
  }
}

// ========== 會員數據庫操作 ==========

function getMembersSheet() {
  const sheet = getSheet(CONFIG.MEMBERS_SHEET_NAME);
  if (!sheet) {
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    const newSheet = spreadsheet.insertSheet(CONFIG.MEMBERS_SHEET_NAME);
    newSheet.getRange(1, 1, 1, 11).setValues([[
      'id', 'external_id', 'external_source', 'member_number', 'email', 'name', 'phone', 
      'created_at', 'imported_at', 'status', 'raw_data'
    ]]);
    return newSheet;
  }
  return sheet;
}

function getOrdersSheet() {
  const sheet = getSheet(CONFIG.ORDERS_SHEET_NAME);
  if (!sheet) {
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    const newSheet = spreadsheet.insertSheet(CONFIG.ORDERS_SHEET_NAME);
    newSheet.getRange(1, 1, 1, 11).setValues([[
      'id', 'external_id', 'external_source', 'user_id', 'user_external_id', 
      'amount', 'currency', 'status', 'created_at', 'imported_at', 'raw_data'
    ]]);
    return newSheet;
  }
  return sheet;
}

function findUserByExternalId(externalId, source) {
  const sheet = getMembersSheet();
  const data = sheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[1] === externalId && row[2] === source) {
      return {
        id: row[0],
        external_id: row[1],
        external_source: row[2],
        member_number: row[3],
        email: row[4],
        name: row[5]
      };
    }
  }
  return null;
}

// 新增：根據會員號碼查找用戶
function findUserByMemberNumber(memberNumber) {
  const sheet = getMembersSheet();
  const data = sheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[3] === memberNumber) { // member_number 在第4欄
      return {
        id: row[0],
        external_id: row[1],
        external_source: row[2],
        member_number: row[3],
        email: row[4],
        name: row[5],
        phone: row[6]
      };
    }
  }
  return null;
}

function insertUser(user) {
  const sheet = getMembersSheet();
  const userId = generateUserId();
  const now = new Date();
  
  sheet.appendRow([
    userId,
    user.external_id,
    user.external_source,
    user.member_number || '', // 會員號碼
    user.email || '',
    user.name || '',
    user.phone || '',
    user.created_at || now,
    now,
    'active',
    user.raw_data || ''
  ]);
  
  return userId;
}

function findOrderByExternalId(externalId, source) {
  const sheet = getOrdersSheet();
  const data = sheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[1] === externalId && row[2] === source) {
      return { id: row[0] };
    }
  }
  return null;
}

function insertOrder(order) {
  const sheet = getOrdersSheet();
  const orderId = generateOrderId();
  const now = new Date();
  
  sheet.appendRow([
    orderId,
    order.external_id,
    order.external_source,
    order.user_id || '',
    order.user_external_id || '',
    order.amount || 0,
    order.currency || 'HKD',
    order.status || 'completed',
    order.created_at || now,
    now,
    order.raw_data || ''
  ]);
  
  return orderId;
}

function findPointsByExternalId(externalId, source) {
  const sheet = getPointsSheet();
  const data = sheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const note = (row[6] || '').toString();
    if (note.includes(externalId) && note.includes(source)) {
      return { found: true };
    }
  }
  return null;
}

function insertImportedPoints(points) {
  const sheet = getPointsSheet();
  const now = new Date();
  
  sheet.appendRow([
    points.external_id, // session_id 使用 external_id
    points.user_external_id || points.uid || '',
    0, // amount (imported points don't have payment amount)
    points.points || 0,
    points.created_at || now,
    'imported',
    `Imported from ${points.external_source}: ${points.description || ''}`
  ]);
}

function mergeUserAccounts(primaryUserId, duplicateUserIds, mergeRules) {
  // 實現帳戶合併邏輯
  const results = {
    merged_users: 0,
    merged_orders: 0,
    merged_points: 0,
    errors: []
  };
  
  try {
    // 這裡可以實現具體的合併邏輯
    // 1. 更新訂單的用戶關聯
    // 2. 合併積分記錄
    // 3. 標記重複用戶為已合併
    
    results.merged_users = duplicateUserIds.length;
    logActivity('MERGE_COMPLETED', primaryUserId, `Merged ${duplicateUserIds.length} accounts`);
    
  } catch (error) {
    results.errors.push(error.toString());
  }
  
  return results;
}

function getMemberStatistics() {
  const stats = {
    total_members: 0,
    total_orders: 0,
    total_points: 0,
    sources: {},
    recent_imports: []
  };
  
  try {
    // 統計會員數
    const membersSheet = getMembersSheet();
    const memberData = membersSheet.getDataRange().getValues();
    stats.total_members = memberData.length - 1; // 減去標題行
    
    // 按來源統計
    for (let i = 1; i < memberData.length; i++) {
      const source = memberData[i][2] || 'unknown';
      stats.sources[source] = (stats.sources[source] || 0) + 1;
    }
    
    // 統計訂單數
    const ordersSheet = getOrdersSheet();
    if (ordersSheet) {
      const orderData = ordersSheet.getDataRange().getValues();
      stats.total_orders = orderData.length - 1;
    }
    
    // 統計積分
    const pointsSheet = getPointsSheet();
    const pointsData = pointsSheet.getDataRange().getValues();
    for (let i = 1; i < pointsData.length; i++) {
      stats.total_points += Number(pointsData[i][3]) || 0;
    }
    
  } catch (error) {
    console.error('Get statistics error:', error);
  }
  
  return stats;
}

function generateUserId() {
  return 'user_' + Utilities.getUuid().replace(/-/g, '').substring(0, 12);
}

function generateOrderId() {
  return 'order_' + Utilities.getUuid().replace(/-/g, '').substring(0, 12);
}

// 會員號碼標準化函數
function normalizeMemberNumber(number) {
  if (!number) return null;
  
  const numStr = number.toString().replace(/\D/g, ''); // 移除非數字字符
  
  if (numStr.length === 0) return null;
  
  // 如果少於4位，前面補0
  if (numStr.length <= 4) {
    return numStr.padStart(4, '0');
  }
  
  // 如果多於4位，取最後4位
  return numStr.slice(-4);
}

// ========== 會員號碼綁定管理 ==========

function getMemberBindingsSheet() {
  const sheet = getSheet('member_bindings');
  if (!sheet) {
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    const newSheet = spreadsheet.insertSheet('member_bindings');
    newSheet.getRange(1, 1, 1, 6).setValues([[
      'uid', 'member_number', 'bound_at', 'status', 'notes', 'last_updated'
    ]]);
    return newSheet;
  }
  return sheet;
}

function findMemberBinding(memberNumber) {
  const sheet = getMemberBindingsSheet();
  const data = sheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[1] === memberNumber && row[3] === 'active') {
      return {
        uid: row[0],
        member_number: row[1],
        bound_at: row[2],
        status: row[3]
      };
    }
  }
  return null;
}

function findUserBinding(uid) {
  const sheet = getMemberBindingsSheet();
  const data = sheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[0] === uid && row[3] === 'active') {
      return {
        uid: row[0],
        member_number: row[1],
        bound_at: row[2],
        status: row[3]
      };
    }
  }
  return null;
}

function bindMemberNumber(uid, memberNumber, force = false) {
  try {
    const sheet = getMemberBindingsSheet();
    const now = new Date();
    
    // 如果是強制綁定，先清除舊綁定
    if (force) {
      // 清除該會員號碼的其他綁定
      clearMemberNumberBindings(memberNumber);
      // 清除該用戶的其他綁定
      clearUserBindings(uid);
    }
    
    // 新增綁定記錄
    sheet.appendRow([
      uid,
      memberNumber,
      now,
      'active',
      force ? 'Force bind' : 'User bind',
      now
    ]);
    
    return { success: true };
    
  } catch (error) {
    console.error('Bind member number error:', error);
    return { success: false, error: error.toString() };
  }
}

function unbindMemberNumber(uid) {
  try {
    const sheet = getMemberBindingsSheet();
    const data = sheet.getDataRange().getValues();
    const now = new Date();
    let unboundNumber = null;
    
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (row[0] === uid && row[3] === 'active') {
        // 更新狀態為非活躍
        sheet.getRange(i + 1, 4).setValue('unbound');
        sheet.getRange(i + 1, 6).setValue(now);
        unboundNumber = row[1];
        break;
      }
    }
    
    if (unboundNumber) {
      return { success: true, member_number: unboundNumber };
    } else {
      return { success: false, error: 'No active binding found' };
    }
    
  } catch (error) {
    console.error('Unbind member number error:', error);
    return { success: false, error: error.toString() };
  }
}

function clearMemberNumberBindings(memberNumber) {
  const sheet = getMemberBindingsSheet();
  const data = sheet.getDataRange().getValues();
  const now = new Date();
  
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[1] === memberNumber && row[3] === 'active') {
      sheet.getRange(i + 1, 4).setValue('replaced');
      sheet.getRange(i + 1, 6).setValue(now);
    }
  }
}

function clearUserBindings(uid) {
  const sheet = getMemberBindingsSheet();
  const data = sheet.getDataRange().getValues();
  const now = new Date();
  
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[0] === uid && row[3] === 'active') {
      sheet.getRange(i + 1, 4).setValue('replaced');
      sheet.getRange(i + 1, 6).setValue(now);
    }
  }
}