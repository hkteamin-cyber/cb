/**
 * 本地開發模擬API服務
 * 用於測試會員號碼綁定功能，避免CORS問題
 */

class MockAPIService {
  constructor() {
    // 模擬數據庫
    this.users = new Map();
    this.bindings = new Map(); // uid -> member_number
    this.memberBindings = new Map(); // member_number -> uid
    
    // 初始化一些測試數據
    this.initTestData();
  }

  initTestData() {
    // 添加一些測試用戶
    this.users.set('demo-user-12345', {
      uid: 'demo-user-12345',
      email: 'demo@example.com',
      displayName: 'Demo User'
    });
    
    // 添加一些測試綁定（可選）
    // this.bindings.set('demo-user-12345', '0001');
    // this.memberBindings.set('0001', 'demo-user-12345');
  }

  // 標準化會員號碼
  normalizeMemberNumber(number) {
    if (!number) return null;
    const numStr = number.toString().replace(/\D/g, '');
    if (numStr.length === 0) return null;
    if (numStr.length <= 4) {
      return numStr.padStart(4, '0');
    }
    return numStr.slice(-4);
  }

  // 處理API請求
  async handleRequest(action, params) {
    console.log(`🔧 [Mock API] 處理請求:`, { action, params });

    switch (action) {
      case 'health':
        return {
          ok: true,
          message: 'Mock API Service healthy',
          timestamp: new Date().toISOString(),
          mode: 'development'
        };

      case 'get_member_binding':
        return this.handleGetMemberBinding(params);

      case 'bind_member_number':
        return this.handleBindMemberNumber(params);

      case 'unbind_member_number':
        return this.handleUnbindMemberNumber(params);

      case 'find_member_by_number':
        return this.handleFindMemberByNumber(params);

      default:
        return {
          ok: false,
          error: `Unknown action: ${action}`,
          available_actions: ['health', 'get_member_binding', 'bind_member_number', 'unbind_member_number', 'find_member_by_number']
        };
    }
  }

  handleGetMemberBinding(params) {
    const { uid } = params;
    
    if (!uid) {
      return {
        ok: false,
        error: 'Missing uid parameter'
      };
    }

    const memberNumber = this.bindings.get(uid);
    
    if (memberNumber) {
      return {
        ok: true,
        bound: true,
        member_number: memberNumber,
        bound_at: new Date().toISOString()
      };
    } else {
      return {
        ok: true,
        bound: false
      };
    }
  }

  handleBindMemberNumber(params) {
    const { uid, member_number, force } = params;
    
    if (!uid || !member_number) {
      return {
        ok: false,
        error: 'Missing uid or member_number parameter'
      };
    }

    const normalizedNumber = this.normalizeMemberNumber(member_number);
    if (!normalizedNumber) {
      return {
        ok: false,
        error: 'Invalid member number format'
      };
    }

    // 檢查該會員號碼是否已被其他用戶綁定
    const existingUid = this.memberBindings.get(normalizedNumber);
    if (existingUid && existingUid !== uid && force !== 'true') {
      return {
        ok: false,
        error: 'Member number already bound to another user',
        code: 'ALREADY_BOUND'
      };
    }

    // 檢查用戶是否已綁定其他會員號碼
    const currentBinding = this.bindings.get(uid);
    if (currentBinding && currentBinding !== normalizedNumber && force !== 'true') {
      return {
        ok: false,
        error: 'User already bound to another member number',
        code: 'USER_ALREADY_BOUND',
        current_number: currentBinding
      };
    }

    // 執行綁定
    if (force === 'true') {
      // 清除舊綁定
      if (existingUid) {
        this.bindings.delete(existingUid);
      }
      if (currentBinding) {
        this.memberBindings.delete(currentBinding);
      }
    }

    this.bindings.set(uid, normalizedNumber);
    this.memberBindings.set(normalizedNumber, uid);

    console.log(`✅ [Mock API] 綁定成功: ${uid} -> ${normalizedNumber}`);

    return {
      ok: true,
      member_number: normalizedNumber,
      message: 'Member number bound successfully'
    };
  }

  handleUnbindMemberNumber(params) {
    const { uid } = params;
    
    if (!uid) {
      return {
        ok: false,
        error: 'Missing uid parameter'
      };
    }

    const memberNumber = this.bindings.get(uid);
    
    if (memberNumber) {
      this.bindings.delete(uid);
      this.memberBindings.delete(memberNumber);
      
      console.log(`✅ [Mock API] 解綁成功: ${uid} -> ${memberNumber}`);
      
      return {
        ok: true,
        message: 'Member number unbound successfully'
      };
    } else {
      return {
        ok: false,
        error: 'No active binding found'
      };
    }
  }

  handleFindMemberByNumber(params) {
    const { member_number } = params;
    
    if (!member_number) {
      return {
        ok: false,
        error: 'Missing member_number parameter'
      };
    }

    const normalizedNumber = this.normalizeMemberNumber(member_number);
    if (!normalizedNumber) {
      return {
        ok: false,
        error: 'Invalid member number format'
      };
    }

    const uid = this.memberBindings.get(normalizedNumber);
    
    if (uid) {
      const user = this.users.get(uid);
      return {
        ok: true,
        found: true,
        member: {
          id: uid,
          member_number: normalizedNumber,
          name: user?.displayName || '測試用戶',
          email: user?.email || 'test@example.com',
          external_source: 'mock_system'
        }
      };
    } else {
      return {
        ok: true,
        found: false,
        message: '找不到該會員號碼'
      };
    }
  }

  // 獲取當前狀態（用於調試）
  getStatus() {
    return {
      users: Array.from(this.users.entries()),
      bindings: Array.from(this.bindings.entries()),
      memberBindings: Array.from(this.memberBindings.entries())
    };
  }
}

// 創建全局模擬API實例
window.mockAPI = new MockAPIService();

// 包裝fetch函數以攔截API調用
const originalFetch = window.fetch;

window.fetch = function(url, options = {}) {
  // 檢查是否是API調用
  if (typeof url === 'string' && url.includes('script.google.com')) {
    console.log('🔄 [Mock API] 攔截Google Apps Script API調用:', url);
    
    try {
      // 解析URL參數
      const urlObj = new URL(url);
      const params = {};
      urlObj.searchParams.forEach((value, key) => {
        params[key] = value;
      });
      
      const action = params.action;
      
      if (action && window.mockAPI) {
        // 使用模擬API處理請求
        return window.mockAPI.handleRequest(action, params).then(data => {
          console.log('✅ [Mock API] 模擬響應:', data);
          
          // 創建模擬響應對象
          return {
            ok: true,
            status: 200,
            json: () => Promise.resolve(data),
            text: () => Promise.resolve(JSON.stringify(data))
          };
        });
      }
    } catch (error) {
      console.error('❌ [Mock API] 處理錯誤:', error);
      return Promise.reject(new Error('Mock API error: ' + error.message));
    }
  }
  
  // 對於其他請求，使用原始fetch
  return originalFetch.call(this, url, options);
};

console.log('🚀 [Mock API] 本地模擬API服務已啟動');
console.log('📋 [Mock API] 可用操作:', [
  'health', 
  'get_member_binding', 
  'bind_member_number', 
  'unbind_member_number', 
  'find_member_by_number'
]);

// 導出給其他腳本使用
export { MockAPIService };