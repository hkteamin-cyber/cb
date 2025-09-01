import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getFirestore, collection, addDoc, query, orderBy, limit, onSnapshot, doc, setDoc, serverTimestamp, increment, getDoc, getDocs, where } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged, signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';

// Firebase 配置 - 開發模式
const firebaseConfig = {
  apiKey: "AIzaSyBumSkh6otaE9kdCFU4_--CXq-N7yxZgSw",
  authDomain: "c----b.firebaseapp.com",
  projectId: "c----b",
  storageBucket: "c----b.firebasestorage.app",
  messagingSenderId: "182172071762",
  appId: "1:182172071762:web:f368f7616107561b56ac8b",
  measurementId: "G-8NR2EXP511"
};

// 開發模式警告
if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
  console.warn('🔧 開發模式：請在 Firebase 控制台獲取真實配置');
  console.log('訪問 https://console.firebase.google.com/ 獲取真實 API 密鑰');
}

// 初始化 Firebase 服務
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const googleProvider = new GoogleAuthProvider();
// 強制顯示帳戶選擇（解決 iOS Safari 直接返回不出現帳戶選擇的情況）
googleProvider.setCustomParameters({ prompt: 'select_account' });

// 認證用戶
let currentUser = null;
let authStateReady = false;

// 嘗試處理重導後的登入結果（避免彈窗被封鎖時無反應）
(async () => {
  try {
    const result = await getRedirectResult(auth);
    if (result && result.user) {
      // 讓 onAuthStateChanged 接手，這裡僅紀錄
      console.log('[Auth] redirect 登入完成:', result.user.uid);
    }
  } catch (e) {
    // 忽略無效狀態
  }
})();

// 檢測是否為移動設備
function isMobileDevice() {
  const userAgent = navigator.userAgent || navigator.vendor || window.opera;
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent) ||
         (navigator.maxTouchPoints > 1 && /MacIntel/.test(navigator.platform));
}

// 檢測是否支持彈窗登錄
function supportsPopupLogin() {
  // 移動設備通常不支持彈窗登錄
  if (isMobileDevice()) {
    return false;
  }
  
  // 檢查是否在iframe中
  if (window.self !== window.top) {
    return false;
  }
  
  return true;
}

// Google 登入函數
async function signInWithGoogle() {
  try {
    // 開發模式下返回模擬用戶，並主動同步狀態給 UI
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      console.log('開發模式：模擬 Google 登入');
      currentUser = {
        uid: 'demo-user',
        email: 'demo@example.com',
        displayName: '測試用戶',
        photoURL: null,
        isDemo: true
      };
      // 標記認證狀態已就绪
      authStateReady = true;
      // 同步全域狀態與本地存儲
      try {
        window.CBON_UID = currentUser.uid;
        localStorage.setItem('CBON_UID', currentUser.uid);
        localStorage.setItem('CBON_USER_EMAIL', currentUser.email || '');
        localStorage.setItem('CBON_USER_NAME', currentUser.displayName || '');
      } catch (_) {}
      
      // 手動觸發認證狀態改變事件
      setTimeout(() => {
        // 通知頁面（若有自定義監聽）
        if (window.onAuthStateChanged) {
          try { window.onAuthStateChanged(currentUser); } catch (_) {}
        }
        // 派發 DOM 事件，供頁面監聽
        try { 
          window.dispatchEvent(new CustomEvent('cbon-auth-changed', { 
            detail: { user: currentUser } 
          })); 
        } catch(_) {}
      }, 100);
      
      return currentUser;
    }

    // 針對移動設備或不支持彈窗的環境，直接使用重定向登錄
    if (!supportsPopupLogin()) {
      console.log('[Auth] 移動設備或不支持彈窗環境，使用重定向登錄');
      await signInWithRedirect(auth, googleProvider);
      return null; // 重定向後會離開當前頁面
    }

    // 桌面設備嘗試彈窗登入，失敗則回退到重導登入
    try {
      console.log('[Auth] 嘗試彈窗登入');
      const result = await signInWithPopup(auth, googleProvider);
      console.log('[Auth] 彈窗登入成功');
      return result.user;
    } catch (popupErr) {
      console.warn('[Auth] 彈窗登入失敗:', popupErr.code, popupErr.message);
      
      if (popupErr && (popupErr.code === 'auth/popup-blocked' || 
                       popupErr.code === 'auth/operation-not-supported-in-this-environment' || 
                       popupErr.code === 'auth/popup-closed-by-user' ||
                       popupErr.code === 'auth/cancelled-popup-request')) {
        console.log('[Auth] 改用重定向登錄');
        await signInWithRedirect(auth, googleProvider);
        return null; // 重定向後會離開當前頁面
      }
      
      // 其他錯誤直接拋出
      throw popupErr;
    }
  } catch (error) {
    console.error('Google 登入失敗:', error);
    throw error;
  }
}

// 登出函數
async function signOutUser() {
  try {
    // 開發模式下清除模擬用戶
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      console.log('開發模式：模擬登出');
      currentUser = null;
      // 觸發狀態變更事件
      if (window.onAuthStateChanged) {
        try { window.onAuthStateChanged(null); } catch(_) {}
      }
      try { window.dispatchEvent(new CustomEvent('cbon-auth-changed', { detail: { user: null } })); } catch(_) {}
      try {
        localStorage.removeItem('CBON_UID');
        localStorage.removeItem('CBON_USER_EMAIL');
        localStorage.removeItem('CBON_USER_NAME');
      } catch (_) {}
      return;
    }

    await signOut(auth);
  } catch (error) {
    console.error('登出失敗:', error);
    throw error;
  }
}

// 檢查登入狀態
function isUserLoggedIn() {
  return currentUser !== null;
}

// 獲取當前用戶 UID
function getCurrentUID() {
  return currentUser?.uid || null;
}

// 認證狀態監聽
onAuthStateChanged(auth, (user) => {
  currentUser = user;
  authStateReady = true;

  if (user) {
    console.log('用戶已登入:', user.email || user.uid);
    // 儲存 UID 到全域變數和 localStorage
    window.CBON_UID = user.uid;
    try {
      localStorage.setItem('CBON_UID', user.uid);
      localStorage.setItem('CBON_USER_EMAIL', user.email || '');
      localStorage.setItem('CBON_USER_NAME', user.displayName || '');
    } catch (_) {}
  } else {
    console.log('用戶未登入');
    // 清除儲存的用戶資訊
    window.CBON_UID = null;
    try {
      localStorage.removeItem('CBON_UID');
      localStorage.removeItem('CBON_USER_EMAIL');
      localStorage.removeItem('CBON_USER_NAME');
    } catch (_) {}
  }

  // 觸發自定義回調
  if (window.onAuthStateChanged) {
    try { window.onAuthStateChanged(user); } catch(_) {}
  }
  // 同時派發 DOM 事件
  try { window.dispatchEvent(new CustomEvent('cbon-auth-changed', { detail: { user } })); } catch(_) {}
});

// 等待認證狀態就绪
function waitForAuth() {
  return new Promise((resolve) => {
    if (authStateReady) {
      resolve(currentUser);
    } else {
      const unsubscribe = onAuthStateChanged(auth, (user) => {
        unsubscribe();
        resolve(user);
      });
    }
  });
}

// 導出供其他模塊使用
export {
  db,
  auth,
  currentUser,
  googleProvider,
  signInWithGoogle,
  signOutUser,
  isUserLoggedIn,
  getCurrentUID,
  waitForAuth,
  collection,
  addDoc,
  query,
  orderBy,
  limit,
  onSnapshot,
  doc,
  setDoc,
  serverTimestamp,
  increment,
  getDoc,
  getDocs,
  where,
  signInAnonymously,
  onAuthStateChanged
};