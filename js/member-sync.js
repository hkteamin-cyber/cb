/**
 * CBON 會員整合系統
 * 負責從多個外部網站同步會員數據到統一平台
 */

export class MemberDataSync {
  constructor() {
    this.apiEndpoints = new Map();
    this.mappingRules = new Map();
    this.syncQueues = new Map();
  }

  /**
   * 配置外部網站數據源
   */
  configureSite(siteId, config) {
    this.apiEndpoints.set(siteId, {
      name: config.name,
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      type: config.type || 'rest', // rest, graphql, database
      credentials: config.credentials
    });
  }

  /**
   * 設定數據映射規則
   */
  setMappingRules(siteId, rules) {
    this.mappingRules.set(siteId, {
      userMapping: rules.userMapping || {},
      orderMapping: rules.orderMapping || {},
      pointsMapping: rules.pointsMapping || {},
      customFields: rules.customFields || {}
    });
  }

  /**
   * 測試外部網站連接
   */
  async testConnection(siteId) {
    const config = this.apiEndpoints.get(siteId);
    if (!config) {
      throw new Error(`網站 ${siteId} 未配置`);
    }

    try {
      switch (config.type) {
        case 'rest':
          return await this.testRestConnection(config);
        case 'database':
          return await this.testDatabaseConnection(config);
        case 'csv':
          return await this.testCsvConnection(config);
        default:
          throw new Error(`不支持的連接類型: ${config.type}`);
      }
    } catch (error) {
      console.error(`連接測試失敗 (${siteId}):`, error);
      throw error;
    }
  }

  async testRestConnection(config) {
    const response = await fetch(`${config.endpoint}/health`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return { success: true, message: 'REST API 連接正常' };
  }

  async testDatabaseConnection(config) {
    // 這裡可以實現數據庫連接測試
    // 由於瀏覽器環境限制，實際應該通過後端 API 代理
    return { success: true, message: '數據庫連接正常（模擬）' };
  }

  async testCsvConnection(config) {
    try {
      const response = await fetch(config.endpoint);
      const csvText = await response.text();
      const lines = csvText.split('\n');
      
      if (lines.length < 2) {
        throw new Error('CSV 文件格式無效');
      }

      return { 
        success: true, 
        message: `CSV 文件讀取成功，包含 ${lines.length - 1} 條記錄` 
      };
    } catch (error) {
      throw new Error(`CSV 讀取失敗: ${error.message}`);
    }
  }

  /**
   * 同步用戶數據
   */
  async syncUsers(siteId, options = {}) {
    const config = this.apiEndpoints.get(siteId);
    const mapping = this.mappingRules.get(siteId);
    
    if (!config || !mapping) {
      throw new Error(`網站 ${siteId} 配置不完整`);
    }

    console.log(`開始同步用戶數據: ${config.name}`);
    
    try {
      // 1. 獲取外部用戶數據
      const externalUsers = await this.fetchUsersFromSite(config, options);
      
      // 2. 數據映射和清理
      const mappedUsers = this.mapUserData(externalUsers, mapping.userMapping);
      
      // 3. 檢查重複和合併
      const processedUsers = await this.deduplicateUsers(mappedUsers, options.mergeAccounts);
      
      // 4. 批量導入到本地系統
      const results = await this.importUsers(processedUsers);
      
      console.log(`用戶同步完成: ${results.success}/${results.total}`);
      return results;
      
    } catch (error) {
      console.error(`用戶同步失敗 (${siteId}):`, error);
      throw error;
    }
  }

  /**
   * 同步訂單數據
   */
  async syncOrders(siteId, options = {}) {
    const config = this.apiEndpoints.get(siteId);
    const mapping = this.mappingRules.get(siteId);
    
    console.log(`開始同步訂單數據: ${config.name}`);
    
    try {
      const externalOrders = await this.fetchOrdersFromSite(config, options);
      const mappedOrders = this.mapOrderData(externalOrders, mapping.orderMapping);
      const results = await this.importOrders(mappedOrders);
      
      console.log(`訂單同步完成: ${results.success}/${results.total}`);
      return results;
      
    } catch (error) {
      console.error(`訂單同步失敗 (${siteId}):`, error);
      throw error;
    }
  }

  /**
   * 同步積分數據
   */
  async syncPoints(siteId, options = {}) {
    const config = this.apiEndpoints.get(siteId);
    const mapping = this.mappingRules.get(siteId);
    
    console.log(`開始同步積分數據: ${config.name}`);
    
    try {
      const externalPoints = await this.fetchPointsFromSite(config, options);
      const mappedPoints = this.mapPointsData(externalPoints, mapping.pointsMapping);
      const results = await this.importPoints(mappedPoints);
      
      console.log(`積分同步完成: ${results.success}/${results.total}`);
      return results;
      
    } catch (error) {
      console.error(`積分同步失敗 (${siteId}):`, error);
      throw error;
    }
  }

  /**
   * 從外部網站獲取用戶數據
   */
  async fetchUsersFromSite(config, options) {
    switch (config.type) {
      case 'rest':
        return await this.fetchUsersFromRest(config, options);
      case 'database':
        return await this.fetchUsersFromDatabase(config, options);
      case 'csv':
        return await this.fetchUsersFromCsv(config, options);
      default:
        throw new Error(`不支持的數據源類型: ${config.type}`);
    }
  }

  async fetchUsersFromRest(config, options) {
    const params = new URLSearchParams({
      page: options.page || 1,
      limit: options.limit || 100,
      since: options.since || ''
    });

    const response = await fetch(`${config.endpoint}/users?${params}`, {
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`API 調用失敗: ${response.status}`);
    }

    const data = await response.json();
    return data.users || data.data || data;
  }

  async fetchUsersFromCsv(config, options) {
    const response = await fetch(config.endpoint);
    const csvText = await response.text();
    return this.parseCsvUsers(csvText);
  }

  parseCsvUsers(csvText) {
    const lines = csvText.trim().split('\n');
    const headers = lines[0].split(',').map(h => h.trim());
    const users = [];

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map(v => v.trim());
      const user = {};
      headers.forEach((header, index) => {
        user[header] = values[index] || '';
      });
      users.push(user);
    }

    return users;
  }

  /**
   * 數據映射
   */
  mapUserData(users, mapping) {
    return users.map(user => {
      const mapped = {
        // 標準字段映射
        external_id: user[mapping.id] || user.id,
        email: user[mapping.email] || user.email,
        name: user[mapping.name] || user.name || user.username,
        phone: user[mapping.phone] || user.phone,
        created_at: user[mapping.created_at] || user.created_at,
        
        // 4位數會員號碼特殊處理
        member_number: this.extractMemberNumber(user, mapping),
        
        // 擴展字段
        external_source: mapping.source_name,
        raw_data: JSON.stringify(user)
      };

      // 應用自定義映射規則
      if (mapping.customFields) {
        Object.keys(mapping.customFields).forEach(key => {
          const sourcePath = mapping.customFields[key];
          mapped[key] = this.getNestedValue(user, sourcePath);
        });
      }

      return mapped;
    });
  }

  mapOrderData(orders, mapping) {
    return orders.map(order => ({
      external_id: order[mapping.id] || order.id,
      user_external_id: order[mapping.user_id] || order.user_id,
      amount: order[mapping.amount] || order.total || order.amount,
      currency: order[mapping.currency] || order.currency || 'HKD',
      status: order[mapping.status] || order.status,
      created_at: order[mapping.created_at] || order.created_at,
      external_source: mapping.source_name,
      raw_data: JSON.stringify(order)
    }));
  }

  mapPointsData(points, mapping) {
    return points.map(point => ({
      external_id: point[mapping.id] || point.id,
      user_external_id: point[mapping.user_id] || point.user_id,
      points: point[mapping.points] || point.points || point.amount,
      type: point[mapping.type] || point.type || 'import',
      description: point[mapping.description] || point.description,
      created_at: point[mapping.created_at] || point.created_at,
      external_source: mapping.source_name,
      raw_data: JSON.stringify(point)
    }));
  }

  /**
   * 去重和合併帳戶
   */
  async deduplicateUsers(users, mergeEnabled = false) {
    if (!mergeEnabled) return users;

    const emailMap = new Map();
    const phoneMap = new Map();
    const mergedUsers = [];

    users.forEach(user => {
      let existingUser = null;
      
      // 按郵箱查找重複
      if (user.email && emailMap.has(user.email)) {
        existingUser = emailMap.get(user.email);
      }
      // 按電話查找重複
      else if (user.phone && phoneMap.has(user.phone)) {
        existingUser = phoneMap.get(user.phone);
      }

      if (existingUser) {
        // 合併用戶數據
        existingUser.external_sources = existingUser.external_sources || [];
        existingUser.external_sources.push(user.external_source);
        existingUser.merged_data = existingUser.merged_data || [];
        existingUser.merged_data.push(user.raw_data);
      } else {
        // 新用戶
        if (user.email) emailMap.set(user.email, user);
        if (user.phone) phoneMap.set(user.phone, user);
        mergedUsers.push(user);
      }
    });

    return mergedUsers;
  }

  /**
   * 導入數據到本地系統
   */
  async importUsers(users) {
    const APPS_SCRIPT_ENDPOINT = localStorage.getItem('CBON_APPS_SCRIPT_URL') || 
      'https://script.google.com/macros/s/AKfycbwhdaWJHQV9sEbcNUP9bQmjjxYTk0HdNif_QKEqunp6fQfyufGiax14l2H36kpBssvyPQ/exec';

    let success = 0;
    let errors = [];

    for (const user of users) {
      try {
        const response = await fetch(APPS_SCRIPT_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'import_user',
            user: user,
            origin: window.location.origin
          })
        });

        const result = await response.json();
        if (result.success) {
          success++;
        } else {
          errors.push({ user: user.email, error: result.error });
        }
      } catch (error) {
        errors.push({ user: user.email, error: error.message });
      }
    }

    return {
      total: users.length,
      success: success,
      errors: errors
    };
  }

  async importOrders(orders) {
    // 類似的訂單導入邏輯
    return { total: orders.length, success: orders.length, errors: [] };
  }

  async importPoints(points) {
    // 類似的積分導入邏輯
    return { total: points.length, success: points.length, errors: [] };
  }

  /**
   * 工具函數
   */
  getNestedValue(obj, path) {
    return path.split('.').reduce((current, key) => {
      return current && current[key] !== undefined ? current[key] : null;
    }, obj);
  }

  /**
   * 提取4位數會員號碼
   */
  extractMemberNumber(user, mapping) {
    // 如果映射中指定了會員號碼字段
    if (mapping.member_number) {
      const memberNum = user[mapping.member_number];
      return this.normalizeMemberNumber(memberNum);
    }
    
    // 從用戶ID中提取數字
    const userId = user[mapping.id] || user.id;
    if (userId) {
      const numbers = userId.toString().match(/\d+/);
      if (numbers && numbers[0]) {
        return this.normalizeMemberNumber(numbers[0]);
      }
    }
    
    // 從其他字段搜索4位數字
    const searchFields = ['username', 'account_number', 'customer_id', 'member_id'];
    for (const field of searchFields) {
      const value = user[field];
      if (value) {
        const match = value.toString().match(/\b\d{4}\b/);
        if (match) {
          return this.normalizeMemberNumber(match[0]);
        }
      }
    }
    
    return null;
  }

  /**
   * 標準化會員號碼為4位數格式
   */
  normalizeMemberNumber(number) {
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

  /**
   * 根據4位數會員號碼查找重複用戶
   */
  async deduplicateUsersByMemberNumber(users, mergeEnabled = false) {
    if (!mergeEnabled) return users;

    const memberNumberMap = new Map();
    const emailMap = new Map();
    const phoneMap = new Map();
    const mergedUsers = [];

    users.forEach(user => {
      let existingUser = null;
      
      // 優先按會員號碼查找重複
      if (user.member_number && memberNumberMap.has(user.member_number)) {
        existingUser = memberNumberMap.get(user.member_number);
      }
      // 按郵箱查找重複
      else if (user.email && emailMap.has(user.email)) {
        existingUser = emailMap.get(user.email);
      }
      // 按電話查找重複
      else if (user.phone && phoneMap.has(user.phone)) {
        existingUser = phoneMap.get(user.phone);
      }

      if (existingUser) {
        // 合併用戶數據
        existingUser.external_sources = existingUser.external_sources || [];
        existingUser.external_sources.push(user.external_source);
        existingUser.merged_data = existingUser.merged_data || [];
        existingUser.merged_data.push(user.raw_data);
        
        // 如果新用戶有會員號碼但舊用戶沒有，更新會員號碼
        if (user.member_number && !existingUser.member_number) {
          existingUser.member_number = user.member_number;
        }
      } else {
        // 新用戶
        if (user.member_number) memberNumberMap.set(user.member_number, user);
        if (user.email) emailMap.set(user.email, user);
        if (user.phone) phoneMap.set(user.phone, user);
        mergedUsers.push(user);
      }
    });

    return mergedUsers;
  }

  /**
   * 重寫去重方法以支持會員號碼
   */
  async deduplicateUsers(users, mergeEnabled = false) {
    return this.deduplicateUsersByMemberNumber(users, mergeEnabled);
  }

  /**
   * 批量同步所有配置的網站
   */
  async syncAllSites(options = {}) {
    const results = new Map();
    
    for (const [siteId, config] of this.apiEndpoints) {
      try {
        console.log(`開始同步網站: ${config.name}`);
        
        const siteResults = {
          users: { total: 0, success: 0, errors: [] },
          orders: { total: 0, success: 0, errors: [] },
          points: { total: 0, success: 0, errors: [] }
        };

        if (options.syncUsers) {
          siteResults.users = await this.syncUsers(siteId, options);
        }

        if (options.syncOrders) {
          siteResults.orders = await this.syncOrders(siteId, options);
        }

        if (options.syncPoints) {
          siteResults.points = await this.syncPoints(siteId, options);
        }

        results.set(siteId, siteResults);
        console.log(`網站 ${config.name} 同步完成`);
        
      } catch (error) {
        console.error(`網站 ${config.name} 同步失敗:`, error);
        results.set(siteId, { error: error.message });
      }
    }

    return results;
  }
}

// 預設映射規則模板
export const DEFAULT_MAPPING_TEMPLATES = {
  // 標準電商平台映射
  ecommerce: {
    userMapping: {
      id: 'user_id',
      email: 'email',
      name: 'full_name',
      phone: 'phone_number',
      created_at: 'registration_date',
      source_name: 'ECommerce'
    },
    orderMapping: {
      id: 'order_id',
      user_id: 'customer_id',
      amount: 'total_amount',
      currency: 'currency_code',
      status: 'order_status',
      created_at: 'order_date',
      source_name: 'ECommerce'
    }
  },

  // WhatsApp 商城映射
  whatsapp: {
    userMapping: {
      id: 'contact_id',
      name: 'contact_name',
      phone: 'phone_number',
      created_at: 'first_contact',
      source_name: 'WhatsApp'
    },
    orderMapping: {
      id: 'message_id',
      user_id: 'contact_id',
      amount: 'order_total',
      status: 'order_status',
      created_at: 'order_time',
      source_name: 'WhatsApp'
    }
  },

  // 4位數會員號碼系統映射
  member_number_4digit: {
    userMapping: {
      id: 'member_id',
      member_number: 'member_number', // 會員號碼字段
      email: 'email',
      name: 'member_name',
      phone: 'phone',
      created_at: 'join_date',
      source_name: '4位數會員系統'
    },
    orderMapping: {
      id: 'transaction_id',
      user_id: 'member_number', // 使用會員號碼關聯
      amount: 'amount',
      currency: 'currency',
      status: 'status',
      created_at: 'transaction_date',
      source_name: '4位數會員系統'
    },
    pointsMapping: {
      id: 'point_id',
      user_id: 'member_number', // 使用會員號碼關聯
      points: 'points',
      type: 'point_type',
      description: 'description',
      created_at: 'point_date',
      source_name: '4位數會員系統'
    }
  },

  // CSV 文件映射
  csv: {
    userMapping: {
      id: 'ID',
      email: 'Email',
      name: 'Name',
      phone: 'Phone',
      created_at: 'Created',
      source_name: 'CSV Import'
    }
  },

  // 舊版系統通用映射（可能包含會員號碼）
  legacy_system: {
    userMapping: {
      id: 'customer_id',
      member_number: 'account_no', // 帳號可能就是會員號碼
      email: 'email_address',
      name: 'customer_name',
      phone: 'telephone',
      created_at: 'created_date',
      source_name: '舊版系統'
    },
    orderMapping: {
      id: 'order_no',
      user_id: 'account_no',
      amount: 'order_amount',
      currency: 'currency',
      status: 'order_status',
      created_at: 'order_date',
      source_name: '舊版系統'
    }
  }
};