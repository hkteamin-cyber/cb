// AI回答客户资料存储管理
class ChatStorage {
    constructor() {
        this.storageKey = 'cb_ai_chat_history';
        this.currentChatKey = 'cb_ai_current_chat';
    }

    // 保存完整的聊天记录
    saveChatHistory(chatData) {
        try {
            const dataToSave = {
                id: chatData.id || this.generateChatId(),
                title: chatData.title || '新对话',
                messages: chatData.messages || [],
                timestamp: chatData.timestamp || new Date().toISOString(),
                lastUpdated: new Date().toISOString()
            };
            
            let chatHistory = this.getChatHistory();
            const existingIndex = chatHistory.findIndex(chat => chat.id === dataToSave.id);
            
            if (existingIndex >= 0) {
                chatHistory[existingIndex] = dataToSave;
            } else {
                chatHistory.unshift(dataToSave);
            }
            
            // 限制保存的对话数量（最多50个）
            if (chatHistory.length > 50) {
                chatHistory = chatHistory.slice(0, 50);
            }
            
            localStorage.setItem(this.storageKey, JSON.stringify(chatHistory));
            return dataToSave.id;
        } catch (error) {
            console.error('保存聊天记录失败:', error);
            return null;
        }
    }

    // 获取所有聊天记录
    getChatHistory() {
        try {
            const stored = localStorage.getItem(this.storageKey);
            return stored ? JSON.parse(stored) : [];
        } catch (error) {
            console.error('获取聊天记录失败:', error);
            return [];
        }
    }

    // 获取特定对话
    getChatById(chatId) {
        const chatHistory = this.getChatHistory();
        return chatHistory.find(chat => chat.id === chatId) || null;
    }

    // 删除特定对话
    deleteChat(chatId) {
        let chatHistory = this.getChatHistory();
        chatHistory = chatHistory.filter(chat => chat.id !== chatId);
        localStorage.setItem(this.storageKey, JSON.stringify(chatHistory));
    }

    // 保存当前对话
    saveCurrentChat(messages) {
        const chatData = {
            messages: messages,
            timestamp: new Date().toISOString()
        };
        localStorage.setItem(this.currentChatKey, JSON.stringify(chatData));
    }

    // 获取当前对话
    getCurrentChat() {
        try {
            const stored = localStorage.getItem(this.currentChatKey);
            return stored ? JSON.parse(stored) : { messages: [] };
        } catch (error) {
            console.error('获取当前对话失败:', error);
            return { messages: [] };
        }
    }

    // 清除当前对话
    clearCurrentChat() {
        localStorage.removeItem(this.currentChatKey);
    }

    // 添加消息到当前对话
    addMessage(role, content, metadata = {}) {
        const currentChat = this.getCurrentChat();
        const message = {
            id: this.generateMessageId(),
            role: role, // 'user' or 'assistant'
            content: content,
            timestamp: new Date().toISOString(),
            metadata: metadata
        };
        
        currentChat.messages.push(message);
        this.saveCurrentChat(currentChat.messages);
        
        return message;
    }

    // 生成唯一对话ID
    generateChatId() {
        return 'chat_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }

    // 生成唯一消息ID
    generateMessageId() {
        return 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }

    // 导出聊天记录为JSON
    exportChat(chatId) {
        const chat = this.getChatById(chatId);
        if (chat) {
            const dataStr = JSON.stringify(chat, null, 2);
            const dataBlob = new Blob([dataStr], { type: 'application/json' });
            const url = URL.createObjectURL(dataBlob);
            
            const link = document.createElement('a');
            link.href = url;
            link.download = `cb_ai_chat_${chat.title}_${new Date().toISOString().split('T')[0]}.json`;
            link.click();
            
            URL.revokeObjectURL(url);
        }
    }

    // 获取统计数据
    getStats() {
        const chatHistory = this.getChatHistory();
        const totalChats = chatHistory.length;
        const totalMessages = chatHistory.reduce((sum, chat) => sum + chat.messages.length, 0);
        
        return {
            totalChats,
            totalMessages,
            lastActivity: totalChats > 0 ? chatHistory[0].lastUpdated : null
        };
    }
}

// 创建全局实例
const chatStorage = new ChatStorage();

// 导出供其他模块使用
export default chatStorage;