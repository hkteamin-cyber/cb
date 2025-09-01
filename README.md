# Kimi AI Web 应用

一个现代化的Kimi AI聊天应用，使用Firebase Hosting部署。

## 功能特性

- 💬 智能对话界面
- 🎨 响应式设计，支持移动端
- 🌙 深色/浅色主题切换
- 💾 本地对话历史存储
- ⚙️ 可配置API密钥
- 🔒 匿名认证

## 快速开始

### 1. 安装Firebase CLI

```bash
npm install -g firebase-tools
```

### 2. 配置Firebase项目

1. 创建新的Firebase项目：https://console.firebase.google.com
2. 替换 `js/firebase-config.js` 中的配置信息
3. 更新 `.firebaserc` 中的项目ID

### 3. 本地开发

```bash
# 安装依赖
npm install

# 启动本地服务器
firebase serve
```

### 4. 部署到Firebase

```bash
firebase deploy
```

## 集成Kimi AI API

要集成真实的Kimi AI API，请：

1. 在设置中输入你的Kimi AI API密钥
2. 修改 `js/app.js` 中的 `callKimiAPI` 方法
3. 使用实际的API端点替换模拟响应

## 项目结构