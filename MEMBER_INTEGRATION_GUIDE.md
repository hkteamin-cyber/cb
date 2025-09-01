# CBON 會員整合配置指南

## 整合方案概述

CBON 會員整合系統支持從多個外部網站同步會員數據到統一平台，實現：

- 📊 統一會員管理
- 🔄 自動數據同步
- 🤝 重複帳戶合併
- 📈 統一積分系統
- 📱 一站式服務體驗

## 支持的數據源類型

### 1. REST API 接口
適用於現代 Web 應用程序

**配置範例：**
```json
{
  "name": "商城 API",
  "type": "rest",
  "endpoint": "https://your-ecommerce.com/api/v1",
  "apiKey": "your-api-key-here",
  "credentials": {
    "authorization": "Bearer"
  }
}
```

**API 端點要求：**
- `GET /users` - 獲取用戶列表
- `GET /orders` - 獲取訂單列表  
- `GET /points` - 獲取積分記錄
- `GET /health` - 健康檢查

### 2. 數據庫直連
適用於傳統應用程序

**配置範例：**
```json
{
  "name": "舊版資料庫",
  "type": "database",
  "endpoint": "postgresql://user:pass@host:port/dbname",
  "credentials": {
    "host": "database.example.com",
    "port": 5432,
    "database": "legacy_shop",
    "username": "readonly_user",
    "password": "secure_password"
  }
}
```

### 3. CSV 文件導入
適用於一次性遷移或小型系統

**配置範例：**
```json
{
  "name": "WhatsApp 商城",
  "type": "csv",
  "endpoint": "https://example.com/export/members.csv",
  "credentials": {
    "encoding": "utf-8"
  }
}
```

## 數據映射配置

### 用戶數據映射
```javascript
const userMapping = {
  // 必需字段
  id: 'customer_id',           // 外部系統的用戶ID
  email: 'email_address',      // 郵箱
  name: 'full_name',           // 姓名
  
  // 可選字段
  phone: 'phone_number',       // 電話
  created_at: 'register_date', // 註冊日期
  
  // 自定義字段映射
  customFields: {
    'vip_level': 'membership.level',
    'source_channel': 'utm_source'
  },
  
  // 數據來源標識
  source_name: '舊版商城'
};
```

### 訂單數據映射
```javascript
const orderMapping = {
  id: 'order_number',
  user_id: 'customer_id',
  amount: 'total_amount',
  currency: 'currency_code',
  status: 'order_status',
  created_at: 'order_date',
  source_name: '舊版商城'
};
```

### 積分數據映射
```javascript
const pointsMapping = {
  id: 'transaction_id',
  user_id: 'customer_id', 
  points: 'point_amount',
  type: 'transaction_type',
  description: 'memo',
  created_at: 'transaction_date',
  source_name: '舊版商城'
};
```

## 快速開始

### 1. 管理員設置
1. 確保您有管理員權限（在代碼中配置管理員郵箱）
2. 訪問 `member-integration.html` 管理頁面
3. 配置三個外部網站的連接信息

### 2. 數據源配置
```javascript
// 在前端 JavaScript 中配置
import { MemberDataSync, DEFAULT_MAPPING_TEMPLATES } from './js/member-sync.js';

const sync = new MemberDataSync();

// 配置網站 1 - REST API
sync.configureSite('site1', {
  name: '舊版商城',
  endpoint: 'https://old-shop.example.com/api',
  apiKey: 'your-api-key',
  type: 'rest'
});

// 設置映射規則
sync.setMappingRules('site1', DEFAULT_MAPPING_TEMPLATES.ecommerce);

// 配置網站 2 - CSV 文件
sync.configureSite('site2', {
  name: 'WhatsApp 商城',
  endpoint: 'https://example.com/whatsapp-export.csv',
  type: 'csv'
});

sync.setMappingRules('site2', DEFAULT_MAPPING_TEMPLATES.whatsapp);
```

### 3. 執行同步
```javascript
// 測試連接
await sync.testConnection('site1');

// 同步特定網站
await sync.syncUsers('site1');
await sync.syncOrders('site1'); 
await sync.syncPoints('site1');

// 批量同步所有網站
const results = await sync.syncAllSites({
  syncUsers: true,
  syncOrders: true,
  syncPoints: true,
  mergeAccounts: true
});
```

## 重複帳戶處理

### 自動合併規則
系統會根據以下條件自動識別重複帳戶：

1. **郵箱匹配** - 相同郵箱地址
2. **電話匹配** - 相同電話號碼
3. **姓名+電話組合** - 姓名相似且電話相同

### 合併策略
- 保留最早註冊的帳戶作為主帳戶
- 合併所有訂單記錄到主帳戶
- 累加所有積分到主帳戶
- 保留完整的合併歷史記錄

## 數據庫表結構

### members 表
```sql
CREATE TABLE members (
  id VARCHAR(20) PRIMARY KEY,
  external_id VARCHAR(100),
  external_source VARCHAR(50),
  email VARCHAR(255),
  name VARCHAR(100),
  phone VARCHAR(20),
  created_at TIMESTAMP,
  imported_at TIMESTAMP,
  status VARCHAR(20),
  raw_data TEXT
);
```

### orders 表
```sql
CREATE TABLE orders (
  id VARCHAR(20) PRIMARY KEY,
  external_id VARCHAR(100),
  external_source VARCHAR(50),
  user_id VARCHAR(20),
  user_external_id VARCHAR(100),
  amount INTEGER,
  currency VARCHAR(5),
  status VARCHAR(20),
  created_at TIMESTAMP,
  imported_at TIMESTAMP,
  raw_data TEXT
);
```

## 安全考量

### API 金鑰管理
- 使用 Google Apps Script Properties 存儲敏感信息
- 定期輪換 API 金鑰
- 限制 API 金鑰的訪問權限

### 數據隱私
- 所有個人數據在傳輸過程中加密
- 遵循 GDPR 和當地隱私法規
- 提供數據刪除功能

### 訪問控制
- 僅授權管理員可訪問整合系統
- 記錄所有數據操作日誌
- 實施 IP 白名單（如需要）

## 故障排除

### 常見問題

**1. 連接測試失敗**
- 檢查 API 端點 URL 是否正確
- 驗證 API 金鑰是否有效
- 確認網絡連接正常

**2. 數據映射錯誤**
- 檢查字段名稱是否正確
- 驗證數據類型是否匹配
- 查看控制台錯誤信息

**3. 同步速度慢**
- 減少單次同步的數據量
- 檢查 Google Apps Script 執行時間限制
- 考慮分批處理大量數據

**4. 重複數據**
- 啟用自動去重功能
- 檢查唯一標識符設置
- 手動清理重複記錄

### 日誌查看
系統會記錄所有同步活動，可在以下位置查看：
- Google Sheets `logs` 表
- 瀏覽器控制台
- 整合管理頁面的同步日誌

## 高級功能

### 自定義數據轉換
```javascript
// 自定義數據轉換函數
sync.setCustomTransformer('site1', {
  transformUser: (user) => {
    // 自定義用戶數據轉換邏輯
    user.normalized_phone = normalizePhoneNumber(user.phone);
    return user;
  },
  
  transformOrder: (order) => {
    // 自定義訂單數據轉換邏輯
    order.amount_hkd = convertToHKD(order.amount, order.currency);
    return order;
  }
});
```

### 增量同步
```javascript
// 僅同步指定日期後的數據
await sync.syncUsers('site1', {
  since: '2024-01-01T00:00:00Z',
  limit: 1000
});
```

### 同步結果通知
```javascript
// 設置同步完成回調
sync.onSyncComplete = (results) => {
  console.log('同步完成:', results);
  // 發送郵件通知或其他操作
};
```

## 技術支持

如需技術支持，請聯繫：
- **郵箱**: tech-support@cbon.shop
- **WhatsApp**: [聯繫客服](https://chat.whatsapp.com/JiJ6SlwGVfrAl1YU6qonWC)
- **Telegram**: [CBON 技術群](https://t.me/cbonshare)

---

*最後更新: 2024年1月*