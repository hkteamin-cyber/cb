// 全新的 AI Chat 應用程序 - 簡化且穩定
import { db, auth, currentUser, collection, addDoc, query, orderBy, limit, onSnapshot } from './firebase-config.js';

class CBONAIChat {
    constructor() {
        this.currentChatId = null;
        this.messages = [];
        this.isLoading = false;
        this.cbonData = null;
        this.apiKey = 'sk-ba95htgabZ13t65zDTwxWhRIo6eR6wgu0lx5b52P046YcASP'; // 請替換為您的Kimi API金鑰
        this.apiUrl = 'https://api.moonshot.cn/v1/chat/completions';
        this.emojis = ['😊', '🎉', '👍', '💡', '🎯', '✨', '🌟', '🔥'];
        this.messageCount = 0;
        
        this.init();
    }

    // 在init方法中添加檢查初始消息的邏輯
    async init() {
        try {
            await this.loadData();
            this.setupEventListeners();
            this.createNewChat();
            this.showWelcomeMessage();
            
            // 檢查並處理來自首頁的初始消息
            const initialMessage = sessionStorage.getItem('aiInitialMessage');
            if (initialMessage) {
                sessionStorage.removeItem('aiInitialMessage');
                setTimeout(() => {
                    this.sendMessage(initialMessage);
                }, 500);
            }
        } catch (error) {
            console.error('初始化失敗:', error);
        }
    }

    async loadData() {
        try {
            const response = await fetch('./data/cbon-data.json');
            this.cbonData = await response.json();
        } catch (error) {
            console.error('加載數據失敗:', error);
            this.cbonData = this.getBackupData();
        }
    }

    getBackupData() {
        return {
            store_info: {
                name: "施幫CBon",
                address: "香港旺角亞皆老街83號先達廣場1樓F88舖",
                business_hours: {
                    weekday: "星期一至六（13:30-19:30）",
                    sunday: "星期日及公眾假期（13:00-18:00）"
                },
                payment_methods: ["現金", "八達通", "WeChat pay", "Alipay", "轉數快"]
            },
            products: {
                hkmobile_annual_card: {
                    name: "香港移動年卡",
                    price: 88,
                    original_price: 248,
                    features: ["香港100GB數據", "2000分鐘通話", "有效期365日"]
                }
            }
        };
    }

    setupEventListeners() {
        const messageInput = document.getElementById('messageInput');
        const sendBtn = document.getElementById('sendBtn');
        // 清除按鈕已移除，不再查找與綁定
        const clearBtn = null;
    
        if (messageInput && sendBtn) {
            // iOS Safari 兼容性：統一使用 click，並阻止默認與冒泡
            sendBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.sendMessage();
            });
            
            // Enter 發送 - 同時監聽 keydown/keypress 提升兼容性
            messageInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this.sendMessage();
                }
            });
            messageInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this.sendMessage();
                }
            });
        }
    
        // 清除按鈕相關事件已移除
    
        // 快速按鈕事件 - 使用 closest 提升點擊命中率（特別是含表情/圖標時）
        document.addEventListener('click', (e) => {
            const btn = e.target.closest('.quick-btn-simple');
            if (btn) {
                e.preventDefault();
                e.stopPropagation();
                const message = btn.dataset.message;
                this.sendMessage(message);
            }
        });
    }

    createNewChat() {
        this.currentChatId = Date.now().toString();
        this.messages = [];
        this.clearMessages();
    }

    clearMessages() {
        const chatMessages = document.getElementById('chatMessages');
        const scrollToBottomBtn = document.getElementById('scrollToBottomBtn');

        if (chatMessages && scrollToBottomBtn) {
            chatMessages.addEventListener('scroll', () => {
                const isAtBottom = chatMessages.scrollHeight - chatMessages.scrollTop <= chatMessages.clientHeight + 100; // Add a threshold
                if (isAtBottom) {
                    scrollToBottomBtn.classList.remove('visible');
                    scrollToBottomBtn.classList.add('hidden');
                } else {
                    scrollToBottomBtn.classList.remove('hidden');
                    scrollToBottomBtn.classList.add('visible');
                }
            });

            scrollToBottomBtn.addEventListener('click', () => this.scrollToBottom());
        }
    }

    showWelcomeMessage() {
        // 為歡迎訊息添加動態效果
        const welcomeMsg = document.querySelector('.welcome-section');
        if (welcomeMsg) {
            // 互動提示已移除：不再顯示彈出文字
        }
    }

    addFloatingHint() {
        // 已停用：不再顯示彈出文字
    }

    async sendMessage(text = null) {
        const messageInput = document.getElementById('messageInput');
        const message = text || messageInput.value.trim();

        if (!message || this.isLoading) return;

        // 添加用戶訊息
        this.addMessage(message, 'user');
        
        if (!text) {
            messageInput.value = '';
            messageInput.focus();
        }

        // 顯示輸入指示器
        this.showTypingIndicator();
        this.isLoading = true;

        try {
            const response = await this.generateResponse(message);
            this.hideTypingIndicator();
            this.addMessage(response, 'bot');
        } catch (error) {
            console.error('生成回應失敗:', error);
            this.hideTypingIndicator();
            this.addMessage('抱歉，我暫時無法回答您的問題，請稍後再試。', 'bot');
        } finally {
            this.isLoading = false;
        }
    }

    addMessage(text, type) {
        const chatMessages = document.getElementById('chatMessages');
        if (!chatMessages) return;

        this.messageCount++;

        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${type}`;
        
        // 為機器人訊息添加隨機表情
        const emoji = type === 'bot' ? this.getRandomEmoji() : '';
        
        messageDiv.innerHTML = `
            <div class="message-bubble">
                ${emoji ? `<span class="message-emoji">${emoji}</span>` : ''}
                ${this.formatMessage(text)}
            </div>
        `;

        // 添加訊息動畫延遲
        messageDiv.style.animationDelay = `${Math.min(this.messageCount * 0.1, 0.5)}s`;

        chatMessages.appendChild(messageDiv);
        this.messages.push({ text, type, timestamp: Date.now() });
        
        // 如果是機器人訊息，添加打字效果
        if (type === 'bot') {
            this.addTypingEffect(messageDiv.querySelector('.message-bubble'));
        } else if (type === 'user') {
            // 僅在用戶發送訊息時檢查彩蛋
            this.checkForEasterEggs(text);
        }
        
        this.scrollToBottom();
    }

    getRandomEmoji() {
        return this.emojis[Math.floor(Math.random() * this.emojis.length)];
    }

    addTypingEffect(bubble) {
        const text = bubble.innerText;
        bubble.classList.add('typing');
        bubble.innerText = '';
        
        let index = 0;
        const typeInterval = setInterval(() => {
            if (index < text.length) {
                bubble.innerText += text.charAt(index);
                index++;
            } else {
                clearInterval(typeInterval);
                bubble.classList.remove('typing');
            }
        }, 30);
    }

    checkForEasterEggs(text) {
        const lowerText = text.toLowerCase();
        
        // 彩蛋觸發詞
        if (lowerText.includes('生日快樂') || lowerText.includes('happy birthday')) {
            this.showConfetti();
        }
        
        /*
        if (lowerText.includes('優惠') || lowerText.includes('折扣')) {
            this.showSpecialOffer();
        }
        */
    }

    showConfetti() {
        // 簡單的彩紙效果
        const colors = ['#FF8C00', '#FF6B6B', '#FFE66D', '#4ECDC4'];
        for (let i = 0; i < 50; i++) {
            const confetti = document.createElement('div');
            confetti.style.cssText = `
                position: fixed;
                top: -10px;
                left: ${Math.random() * 100}%;
                width: 10px;
                height: 10px;
                background: ${colors[Math.floor(Math.random() * colors.length)]};
                animation: fall ${3 + Math.random() * 2}s linear;
                z-index: 9999;
            `;
            document.body.appendChild(confetti);
            setTimeout(() => confetti.remove(), 5000);
        }
    }

    /*
    showSpecialOffer() {
        setTimeout(() => {
            this.addMessage('🎊 恭喜您！觸發了限時優惠！使用代碼 CBON2024 可享額外9折優惠！', 'bot');
        }, 1000);
    }
    */

    clearChat() {
        const chatMessages = document.getElementById('chatMessages');
        if (chatMessages) {
            // 添加清除動畫
            const messages = chatMessages.querySelectorAll('.message');
            messages.forEach((msg, index) => {
                msg.style.animation = `fadeOut 0.3s ${index * 0.05}s forwards`;
            });
            
            setTimeout(() => {
                this.createNewChat();
                this.showWelcomeMessage();
                
                // 顯示清除成功提示
                const toast = document.createElement('div');
                toast.className = 'toast';
                toast.innerHTML = '✨ 對話已清除，開始新的聊天！';
                toast.style.cssText = `
                    position: fixed;
                    top: 80px;
                    left: 50%;
                    transform: translateX(-50%);
                    background: var(--success-color);
                    color: white;
                    padding: 12px 24px;
                    border-radius: 20px;
                    animation: slideInOut 2s;
                    z-index: 1000;
                `;
                document.body.appendChild(toast);
                setTimeout(() => toast.remove(), 2000);
            }, messages.length * 50 + 300);
        }
    }

    scrollToBottom() {
        const chatMessages = document.getElementById('chatMessages');
        if (chatMessages) {
            setTimeout(() => {
                chatMessages.scrollTop = chatMessages.scrollHeight;
            }, 100); // A small delay to ensure DOM is updated
        }
    }

    formatMessage(text) {
        return text.replace(/\n/g, '<br>');
    }

    showTypingIndicator() {
        const chatMessages = document.getElementById('chatMessages');
        if (!chatMessages) return;

        // 優先使用現有的指示器（位於輸入區域 footer）
        const existing = document.getElementById('typingIndicator');
        if (existing) {
            existing.classList.add('active');
            this.scrollToBottom();
            return;
        }

        // 若不存在則動態建立於輸入區域
        const inputSection = document.querySelector('.input-section');
        const typingDiv = document.createElement('div');
        typingDiv.className = 'typing-simple active';
        typingDiv.innerHTML = `
            <span></span>
            <span></span>
            <span></span>
        `;
        typingDiv.id = 'typingIndicator';

        (inputSection || chatMessages).appendChild(typingDiv);
        this.scrollToBottom();
    }

    hideTypingIndicator() {
        const typingIndicator = document.getElementById('typingIndicator');
        if (typingIndicator) {
            // 僅移除 active，避免刪除既有的DOM結構
            typingIndicator.classList.remove('active');
        }
    }

    /*  <-- 這邊是重複的方法，我將其移除
    scrollToBottom() {
        const chatMessages = document.getElementById('chatMessages');
        if (chatMessages) {
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }
    }
    */

    async generateResponse(message) {
        try {
            const systemPrompt = `你是一位專業的CBON商店客服助手。請根據以下商店資訊回答顧客問題：

商店資訊：
- 名稱：施幫CBon
- 地址：香港旺角亞皆老街83號先達廣場1樓F88舖
- 營業時間：星期一至六（13:30-19:30），星期日及公眾假期（13:00-18:00）
- 付款方式：現金、八達通、WeChat pay、Alipay、轉數快
- 主要產品：CSl年卡（特價$88，原價$248，包含香港100GB數據、2000分鐘通話、有效期365日）

請以親切、專業的語氣回答，並提供實用的建議。如果問題超出範圍，請禮貌地說明。`;

            const response = await fetch(this.apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`
                },
                body: JSON.stringify({
                    model: 'moonshot-v1-8k',
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: message }
                    ],
                    temperature: 0.7,
                    max_tokens: 1000
                })
            });

            if (!response.ok) {
                throw new Error('API請求失敗');
            }

            const data = await response.json();
            return data.choices[0].message.content;
            
        } catch (error) {
            console.error('Kimi API調用失敗:', error);
            // 如果API失敗，退回使用關鍵字匹配
            return this.getFallbackResponse(message);
        }
    }

    getFallbackResponse(message) {
        const lowerMessage = message.toLowerCase();
        
        if (lowerMessage.includes('地址') || lowerMessage.includes('店舖')) {
            return `📍 **施幫CBon 實體店**
地址：${this.cbonData.store_info.address}

🕐 **營業時間：**
• ${this.cbonData.store_info.business_hours.weekday}
• ${this.cbonData.store_info.business_hours.sunday}`;
        }
        
        return '抱歉，我暫時無法連接到AI服務。請稍後再試，或聯繫我們的真人客服。';
    }
}

// 初始化應用
document.addEventListener('DOMContentLoaded', () => {
    new CBONAIChat();
});