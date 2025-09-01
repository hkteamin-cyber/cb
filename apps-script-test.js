/**
 * 精簡測試版本 - 檢查基本功能
 * 在 Google Apps Script 中部署此版本進行測試
 */

function doGet(e) {
  try {
    const params = e.parameter || {};
    const action = params.action || 'none';
    
    // 測試基本響應
    const responseData = {
      ok: true,
      message: 'Test endpoint working',
      timestamp: new Date().toISOString(),
      received_action: action,
      received_params: params
    };
    
    // 直接回傳 JSON 或 JSONP（不再嘗試設置自訂 CORS 標頭）
    return createJsonResponse(responseData, params.callback);
    
  } catch (error) {
    // 即使出錯，也要回傳 JSON/JSONP
    const errorResponse = {
      ok: false,
      error: error.toString(),
      stack: error.stack || 'No stack trace'
    };
    
    return createJsonResponse(errorResponse, e && e.parameter && e.parameter.callback);
  }
}

function doPost(e) {
  return doGet(e); // 使用相同邏輯
}

function doOptions(e) {
  // 簡單處理 CORS 預檢請求（Apps Script 不支援自訂 header）
  return ContentService.createTextOutput('')
    .setMimeType(ContentService.MimeType.TEXT);
}

// 統一的 JSON / JSONP 回應輔助函數
function createJsonResponse(data, callback) {
  // JSONP：若帶入 callback 參數，回傳 JavaScript
  try {
    if (callback && typeof callback === 'string') {
      const sanitized = callback.replace(/[^a-zA-Z0-9_$.]/g, '');
      return ContentService
        .createTextOutput(`${sanitized}(${JSON.stringify(data)});`)
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
  } catch (_) {
    // 忽略，退回純 JSON
  }
  
  // 純 JSON 回應
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}