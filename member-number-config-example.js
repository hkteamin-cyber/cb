/**
 * 4位數會員號碼系統整合配置示例
 * 
 * 本文件展示如何配置和使用4位數會員號碼系統的整合功能
 */

import { MemberDataSync, DEFAULT_MAPPING_TEMPLATES } from './js/member-sync.js';

// 1. 初始化會員同步系統
const memberSync = new MemberDataSync();

// 2. 配置4位數會員號碼系統
const memberNumberSiteConfig = {
  name: '4位數會員系統',
  endpoint: 'https://your-legacy-system.com/api', // 您的API端點
  apiKey: 'your-api-key-here',
  type: 'rest', // 或 'database', 'csv'
  credentials: {
    // 如果需要額外認證信息
    username: 'api_user',
    password: 'api_pass'
  }
};

// 3. 配置數據映射規則
const memberNumberMapping = {
  userMapping: {
    id: 'customer_id',
    member_number: 'member_no',    // 關鍵：指定會員號碼字段
    email: 'email',
    name: 'customer_name',
    phone: 'phone_number',
    created_at: 'registration_date',
    source_name: '4位數會員系統',
    
    // 自定義字段映射
    customFields: {
      'membership_level': 'level',
      'last_purchase': 'last_order_date'
    }
  },
  
  orderMapping: {
    id: 'order_id',
    user_id: 'member_no',          // 使用會員號碼關聯用戶
    amount: 'total_amount',
    currency: 'currency',
    status: 'order_status',
    created_at: 'order_date',
    source_name: '4位數會員系統'
  },
  
  pointsMapping: {
    id: 'point_transaction_id',
    user_id: 'member_no',          // 使用會員號碼關聯用戶
    points: 'point_amount',
    type: 'transaction_type',
    description: 'memo',
    created_at: 'transaction_date',
    source_name: '4位數會員系統'
  }
};

// 4. 設置系統配置
memberSync.configureSite('legacy_member_system', memberNumberSiteConfig);
memberSync.setMappingRules('legacy_member_system', memberNumberMapping);

// 5. 使用方法示例

// 測試連接
async function testConnection() {
  try {
    const result = await memberSync.testConnection('legacy_member_system');
    console.log('連接測試結果:', result);
  } catch (error) {
    console.error('連接失敗:', error);
  }
}

// 同步會員數據
async function syncMemberData() {
  try {
    // 啟用會員號碼處理
    const options = {
      syncUsers: true,
      syncOrders: true,
      syncPoints: true,
      mergeAccounts: true,
      handleMemberNumbers: true // 重要：啟用會員號碼處理
    };
    
    const results = await memberSync.syncAllSites(options);
    console.log('同步結果:', results);
  } catch (error) {
    console.error('同步失敗:', error);
  }
}

// 查找特定會員號碼
async function findMemberByNumber(memberNumber) {
  try {
    const response = await fetch(`${APPS_SCRIPT_ENDPOINT}?action=find_member_by_number&member_number=${memberNumber}&origin=${window.location.origin}`);
    const result = await response.json();
    
    if (result.ok && result.found) {
      console.log('找到會員:', result.member);
    } else {
      console.log('未找到會員號碼:', memberNumber);
    }
  } catch (error) {
    console.error('查詢失敗:', error);
  }
}

// 批量驗證會員號碼
async function validateMemberNumbers(memberNumbers) {
  try {
    const response = await fetch(APPS_SCRIPT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'validate_member_numbers',
        member_numbers: memberNumbers,
        origin: window.location.origin
      })
    });
    
    const result = await response.json();
    
    if (result.ok) {
      console.log('驗證結果:', result.results);
      console.log('統計:', result.summary);
    }
  } catch (error) {
    console.error('驗證失敗:', error);
  }
}

// 6. 數據格式示例

// CSV 文件格式示例
const csvExample = `
member_no,customer_name,email,phone_number,registration_date,level
0001,張三,zhang@example.com,12345678,2023-01-15,VIP
0002,李四,li@example.com,87654321,2023-02-20,普通
1234,王五,wang@example.com,11111111,2023-03-10,VIP
`;

// API 響應格式示例
const apiResponseExample = {
  users: [
    {
      customer_id: "001",
      member_no: "0001",
      customer_name: "張三",
      email: "zhang@example.com",
      phone_number: "12345678",
      registration_date: "2023-01-15T00:00:00Z",
      level: "VIP"
    },
    {
      customer_id: "002", 
      member_no: "0002",
      customer_name: "李四",
      email: "li@example.com",
      phone_number: "87654321",
      registration_date: "2023-02-20T00:00:00Z",
      level: "普通"
    }
  ]
};

// 資料庫查詢 SQL 示例
const sqlQueries = {
  users: `
    SELECT 
      customer_id,
      member_no,
      customer_name,
      email,
      phone_number,
      registration_date,
      membership_level as level
    FROM customers 
    WHERE status = 'active'
    ORDER BY registration_date DESC
  `,
  
  orders: `
    SELECT 
      order_id,
      member_no,
      total_amount,
      'HKD' as currency,
      order_status,
      order_date
    FROM orders 
    WHERE order_date >= '2023-01-01'
  `,
  
  points: `
    SELECT 
      point_transaction_id,
      member_no,
      point_amount,
      transaction_type,
      memo,
      transaction_date
    FROM point_transactions
    WHERE transaction_date >= '2023-01-01'
  `
};

// 7. 會員號碼處理函數示例

// 會員號碼標準化（前端版本）
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

// 從各種格式中提取會員號碼
function extractMemberNumber(userText) {
  // 查找4位數字模式
  const patterns = [
    /\b\d{4}\b/,           // 獨立的4位數字
    /會員(\d{4})/,         // "會員0001"
    /編號(\d{4})/,         // "編號1234"
    /NO\.?(\d{4})/i,       // "NO.0001" 或 "no1234"
    /#(\d{4})/             // "#0001"
  ];
  
  for (const pattern of patterns) {
    const match = userText.match(pattern);
    if (match) {
      return normalizeMemberNumber(match[1] || match[0]);
    }
  }
  
  return null;
}

// 8. 使用完整模板配置
export function setupLegacyMemberSystem() {
  // 使用預設模板
  memberSync.setMappingRules('legacy_system', DEFAULT_MAPPING_TEMPLATES.member_number_4digit);
  
  // 或使用舊版系統模板
  memberSync.setMappingRules('legacy_system', DEFAULT_MAPPING_TEMPLATES.legacy_system);
  
  return memberSync;
}

// 9. 導出配置供其他文件使用
export {
  memberSync,
  memberNumberSiteConfig,
  memberNumberMapping,
  testConnection,
  syncMemberData,
  findMemberByNumber,
  validateMemberNumbers,
  normalizeMemberNumber,
  extractMemberNumber
};

// 10. 使用說明
console.log(`
4位數會員號碼系統整合使用說明：

1. 配置數據源：
   - 設置 API 端點或資料庫連接
   - 指定會員號碼字段名稱
   - 配置數據映射規則

2. 數據映射重點：
   - member_number: 指定會員號碼字段
   - user_id: 在訂單和積分中使用會員號碼關聯

3. 會員號碼處理：
   - 自動標準化為4位格式 (0001, 0002, 1234)
   - 支持從文本中提取會員號碼
   - 優先使用會員號碼進行重複檢測

4. 支持的數據源格式：
   - REST API (JSON)
   - CSV 文件
   - 資料庫查詢結果
   
5. 同步功能：
   - 測試連接
   - 批量同步用戶、訂單、積分
   - 自動合併重複帳戶
   - 查詢和驗證會員號碼

使用前請先配置管理員權限並測試連接！
`);