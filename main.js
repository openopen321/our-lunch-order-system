// main.js - 前台主邏輯 (v12.0 個人化與優化提示)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, doc, onSnapshot, collection, addDoc, query, orderBy, serverTimestamp, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// --- DOM 元素參考 ---
const mainBody = document.getElementById('main-body');
const menuContainer = document.getElementById('menu-list-container');
const restaurantNameDisplay = document.getElementById('restaurant-name-display');
const menuTimeInfoDisplay = document.getElementById('menu-time-info');
const restaurantPhoneDisplay = document.getElementById('restaurant-phone');
const usernameInput = document.getElementById('username-input');
const submitBtn = document.getElementById('submit-btn');
const liveStatusList = document.getElementById('live-status-list');
const totalPeopleCountSpan = document.getElementById('total-people-count');
const mapLinkContainer = document.getElementById('map-link-container');
const deadlineBanner = document.getElementById('deadline-banner');
const deadlineFullDateDisplay = document.getElementById('deadline-full-date');
const countdownTimerDisplay = document.getElementById('countdown-timer');
const cartFab = document.getElementById('cart-fab');
const cartCountBadge = document.getElementById('cart-count-badge');
const cartPanel = document.getElementById('cart-panel');
const closeCartBtn = document.getElementById('close-cart-btn');
const cartItemsList = document.getElementById('cart-items-list');
const cartTotalPriceSpan = document.getElementById('cart-total-price');
const cartConfirmBtn = document.getElementById('cart-confirm-btn');
const cartOverlay = document.getElementById('cart-overlay');
// v12.0 新增
const toastContainer = document.getElementById('toast-container');

// --- 狀態變數 ---
let selectedAvatarChar = null;
let cartItems = []; 
let currentSessionId = null;
let unsubscribeOrders = null;
let isManualClosed = false;
let deadlineDate = null;
let checkTimeInterval = null;
let countdownInterval = null;
let priceChangeMap = new Map(); 
let globalItemIndex = 0;

// --- v12.0 新增：Toast 提示訊息函數 ---
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.classList.add('toast', type);
    
    let icon = 'ℹ️';
    if (type === 'success') icon = '✅';
    if (type === 'error') icon = '❌';

    toast.innerHTML = `
        <span class="toast-icon">${icon}</span>
        <span class="toast-message">${message}</span>
    `;
    
    toastContainer.appendChild(toast);

    // 3秒後自動消失
    setTimeout(() => {
        toast.classList.add('hide');
        // 動畫結束後從 DOM 移除
        toast.addEventListener('animationend', () => {
            toast.remove();
        });
    }, 3000);
}

// --- v12.0 新增：LocalStorage 用戶設定存取 ---
function loadUserSettings() {
    const savedName = localStorage.getItem('lunchOrder_username');
    const savedAvatar = localStorage.getItem('lunchOrder_avatar');
    
    if (savedName) {
        usernameInput.value = savedName;
    }
    if (savedAvatar) {
        const avatarEl = Array.from(document.querySelectorAll('.avatar-option'))
            .find(el => el.textContent.includes(savedAvatar));
        if (avatarEl) {
            selectAvatar(avatarEl, savedAvatar);
        }
    }
    checkSubmitButtonState(); // 載入後檢查按鈕狀態
}

function saveUserSettings(name, avatar) {
    localStorage.setItem('lunchOrder_username', name);
    localStorage.setItem('lunchOrder_avatar', avatar);
}


// --- A. 監聽菜單資訊與狀態 ---
onSnapshot(doc(db, "dailyData", "menu"), (docSnap) => {
    if (docSnap.exists()) {
        const data = docSnap.data();
        restaurantNameDisplay.textContent = data.restaurantName || '今日餐廳';
        restaurantPhoneDisplay.textContent = data.restaurantPhone ? `📞 電話: ${data.restaurantPhone}` : '';
        
        if (data.restaurantMapUrl) {
            mapLinkContainer.innerHTML = `<a href="${data.restaurantMapUrl}" target="_blank" class="map-link-btn">🗺️ 去 Google Maps 看照片</a>`;
        } else {
            mapLinkContainer.innerHTML = '';
        }

        let timeInfoHtml = '';
        if (data.updatedAt) {
            const updateTime = new Date(data.updatedAt.seconds * 1000).toLocaleString('zh-TW', {hour: '2-digit', minute:'2-digit'});
            timeInfoHtml += `菜單更新於: ${updateTime}`;
        }
        menuTimeInfoDisplay.innerHTML = timeInfoHtml;

        if (data.deadlineTimestamp) {
            deadlineDate = data.deadlineTimestamp.toDate();
            deadlineFullDateDisplay.textContent = deadlineDate.toLocaleString('zh-TW', {year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false});
            deadlineBanner.style.display = 'block';
        } else {
            deadlineDate = null;
            deadlineFullDateDisplay.textContent = '(未設定)';
            deadlineBanner.style.display = 'none';
        }

        isManualClosed = data.isOrderClosed === true;
        
        startCountdown();
        checkFormLockState();
        
        if (checkTimeInterval) clearInterval(checkTimeInterval);
        checkTimeInterval = setInterval(checkFormLockState, 30000);

        processPriceChanges(data.comparisonSummary);
        renderMenu(data);
        
        currentSessionId = data.sessionId;
        if (currentSessionId) {
            setupOrderListener(currentSessionId);
        }
        
        cartItems = [];
        updateCartUI();

        // v12.0: 菜單載入完成後，嘗試讀取使用者設定
        loadUserSettings();

    } else {
        menuContainer.innerHTML = '<p style="text-align: center;">今日尚未發布菜單...</p>';
        deadlineBanner.style.display = 'none';
        mapLinkContainer.innerHTML = '';
        if (checkTimeInterval) clearInterval(checkTimeInterval);
        if (countdownInterval) clearInterval(countdownInterval);
    }
});

// 倒數計時功能 (維持不變)
function startCountdown() {
    if (countdownInterval) clearInterval(countdownInterval);
    if (!deadlineDate) { countdownTimerDisplay.textContent = '---'; return; }
    const updateTimer = () => {
        const now = new Date();
        const diff = deadlineDate - now;
        if (diff <= 0) {
            countdownTimerDisplay.textContent = '⛔ 已截止';
            countdownTimerDisplay.classList.add('countdown-ended');
            clearInterval(countdownInterval);
            checkFormLockState();
        } else {
            const hours = Math.floor(diff / (1000 * 60 * 60));
            const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
            const seconds = Math.floor((diff % (1000 * 60)) / 1000);
            countdownTimerDisplay.textContent = `剩餘 ${hours.toString().padStart(2, '0')}小時 ${minutes.toString().padStart(2, '0')}分 ${seconds.toString().padStart(2, '0')}秒`;
            countdownTimerDisplay.classList.remove('countdown-ended');
        }
    };
    updateTimer();
    countdownInterval = setInterval(updateTimer, 1000);
}

function processPriceChanges(summary) {
    priceChangeMap.clear();
    if (summary && summary.changedItems) {
        summary.changedItems.forEach(item => {
            priceChangeMap.set(item.name, item.newPrice - item.oldPrice);
        });
    }
}

function checkFormLockState() {
    let isTimeUp = false;
    if (deadlineDate) {
        const now = new Date();
        if (now >= deadlineDate) isTimeUp = true;
    }
    const shouldLock = isManualClosed || isTimeUp;
    updateFormState(shouldLock, isTimeUp);
}

function updateFormState(isLocked, isTimeUp) {
    if (isLocked) {
        mainBody.classList.add('order-closed');
        if (isTimeUp) submitBtn.textContent = '⛔ 時間已到，停止點餐';
        else submitBtn.textContent = '⛔ 已手動結單，停止點餐';
        submitBtn.disabled = true;
        usernameInput.disabled = true;
        closeCart();
    } else {
        mainBody.classList.remove('order-closed');
        checkSubmitButtonState();
        usernameInput.disabled = false;
    }
}

function getIconForDish(dishName) {
    const keywordMap = [
        { keywords: ['雞', 'G', '腿', '排', '翅'], icon: '🍗' },
        { keywords: ['牛', '牛排', '牛肉'], icon: '🥩' },
        { keywords: ['豬', '排骨', '肉絲', '培根', '叉燒', '控肉', '魯肉', '香腸', '肉'], icon: '🐷' },
        { keywords: ['魚', '鰻', '鯖', '鮭', '海鮮'], icon: '🐟' },
        { keywords: ['蝦', '蝦仁', '炸蝦', '捲'], icon: '🍤' },
        { keywords: ['麵', '米粉', '冬粉', '拉麵', '烏龍', '意麵'], icon: '🍜' },
        { keywords: ['飯', '丼', '便當', '粥', '米糕'], icon: '🍚' },
        { keywords: ['堡', '三明治', '吐司', '熱狗'], icon: '🥪' },
        { keywords: ['餃', '鍋貼', '小籠包', '餛飩', '包'], icon: '🥟' },
        { keywords: ['湯', '羹'], icon: '🥣' },
        { keywords: ['菜', '素', '沙拉', '豆', '茄'], icon: '🥬' },
        { keywords: ['炸', '薯條', '雞塊', '這'], icon: '🍟' },
        { keywords: ['咖哩'], icon: '🍛' },
        { keywords: ['蛋', '歐姆'], icon: '🍳' },
        { keywords: ['茶', '咖啡', '飲', '奶', '果汁', '紅茶', '綠茶'], icon: '🥤' },
        { keywords: ['甜', '蛋糕', '點心'], icon: '🍰' },
    ];
    for (const entry of keywordMap) {
        if (entry.keywords.some(keyword => dishName.includes(keyword))) return entry.icon;
    }
    return '🍽️';
}

// renderMenu (維持不變)
function renderMenu(data) {
    menuContainer.innerHTML = '';
    globalItemIndex = 0;
    if (data.menuCategories && Array.isArray(data.menuCategories)) {
        data.menuCategories.forEach(category => {
            const titleEl = document.createElement('div');
            titleEl.classList.add('category-title');
            titleEl.textContent = category.categoryName;
            menuContainer.appendChild(titleEl);
            const listEl = document.createElement('div');
            listEl.classList.add('menu-grid');
            category.items.forEach(item => { listEl.appendChild(createMenuItemElement(item)); });
            menuContainer.appendChild(listEl);
        });
    } else if (data.menuItems && Array.isArray(data.menuItems)) {
        const listEl = document.createElement('div');
        listEl.classList.add('menu-grid');
        data.menuItems.forEach(item => { listEl.appendChild(createMenuItemElement(item)); });
        menuContainer.appendChild(listEl);
    } else { menuContainer.innerHTML = '<p>菜單資料格式錯誤或為空。</p>'; }
    setupScrollAnimations();
}

function setupScrollAnimations() {
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('show');
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.1 });
    document.querySelectorAll('.menu-item-checkbox').forEach(item => observer.observe(item));
}

// --- 購物車邏輯 (維持 v11) ---
function createMenuItemElement(item) {
    const el = document.createElement('div');
    el.classList.add('menu-item-checkbox');
    el.style.transitionDelay = `${globalItemIndex * 0.025}s`;
    globalItemIndex++;

    let priceNoteHtml = '';
    if (priceChangeMap.has(item.name)) {
        const diff = priceChangeMap.get(item.name);
        priceNoteHtml = diff > 0 ? `<span class="price-note-up">(漲${diff})</span>` : `<span class="price-note-down">(降${Math.abs(diff)})</span>`;
    }
    const dishIcon = getIconForDish(item.name);

    el.innerHTML = `
        <div class="menu-item-header">
            <div class="food-icon-wrapper">${dishIcon}</div>
            <div class="food-info">
                <span>${item.name}</span>
                <div><b>$${item.price}</b>${priceNoteHtml}</div>
            </div>
        </div>
    `;
    
    el.addEventListener('click', () => {
        if (mainBody.classList.contains('order-closed')) return;
        addToCart(item, dishIcon);
        openCart();
    });
    return el;
}

function addToCart(item, icon) {
    const existingItem = cartItems.find(i => i.name === item.name);
    if (existingItem) {
        existingItem.quantity++;
    } else {
        cartItems.push({
            name: item.name,
            price: item.price,
            quantity: 1,
            note: '',
            icon: icon
        });
    }
    updateCartUI();
    updateMenuSelectionState();
}

function updateCartUI() {
    const totalCount = cartItems.reduce((sum, item) => sum + item.quantity, 0);
    cartCountBadge.textContent = totalCount;
    cartCountBadge.setAttribute('data-count', totalCount);

    const totalPrice = cartItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    cartTotalPriceSpan.textContent = totalPrice;

    cartItemsList.innerHTML = '';
    if (cartItems.length === 0) {
        cartItemsList.innerHTML = '<p class="empty-cart-msg">您還沒有選擇任何餐點喔！</p>';
    } else {
        cartItems.forEach((item, index) => {
            const itemEl = document.createElement('div');
            itemEl.classList.add('cart-item');
            itemEl.innerHTML = `
                <div class="cart-item-header">
                    <div><span style="font-size:1.2rem">${item.icon}</span> <span class="cart-item-name">${item.name}</span></div>
                    <div class="cart-item-price">$${item.price * item.quantity}</div>
                </div>
                <div class="cart-item-controls">
                    <div class="cart-qty-controls">
                        <button class="cart-qty-btn minus">-</button>
                        <span>${item.quantity}</span>
                        <button class="cart-qty-btn plus">+</button>
                    </div>
                    <span class="cart-item-remove">刪除</span>
                </div>
                <input type="text" class="cart-item-note-input" placeholder="備註 (例如: 加辣)" value="${item.note}">
            `;
            itemEl.querySelector('.minus').addEventListener('click', () => updateCartItemQuantity(index, -1));
            itemEl.querySelector('.plus').addEventListener('click', () => updateCartItemQuantity(index, 1));
            itemEl.querySelector('.cart-item-remove').addEventListener('click', () => removeFromCart(index));
            itemEl.querySelector('.cart-item-note-input').addEventListener('input', (e) => { item.note = e.target.value.trim(); });
            cartItemsList.appendChild(itemEl);
        });
    }
    checkSubmitButtonState();
}

function updateCartItemQuantity(index, delta) {
    const item = cartItems[index];
    item.quantity += delta;
    if (item.quantity <= 0) {
        removeFromCart(index);
    } else {
        updateCartUI();
    }
}

function removeFromCart(index) {
    cartItems.splice(index, 1);
    updateCartUI();
    updateMenuSelectionState();
}

function updateMenuSelectionState() {
    const menuCards = document.querySelectorAll('.menu-item-checkbox');
    menuCards.forEach(card => {
        const itemName = card.querySelector('.food-info span').textContent;
        const isInCart = cartItems.some(item => item.name === itemName);
        if (isInCart) {
            card.classList.add('selected');
        } else {
            card.classList.remove('selected');
        }
    });
}

function openCart() {
    cartPanel.classList.add('open');
    cartOverlay.classList.add('show');
    document.body.style.overflow = 'hidden';
}
function closeCart() {
    cartPanel.classList.remove('open');
    cartOverlay.classList.remove('show');
    document.body.style.overflow = '';
}

cartFab.addEventListener('click', openCart);
closeCartBtn.addEventListener('click', closeCart);
cartOverlay.addEventListener('click', closeCart);
cartConfirmBtn.addEventListener('click', closeCart);


// --- B. 用戶輸入互動 ---
window.selectAvatar = (element, char) => {
    if (mainBody.classList.contains('order-closed')) return;
    document.querySelectorAll('.avatar-option').forEach(e => e.classList.remove('selected'));
    element.classList.add('selected');
    selectedAvatarChar = char;
    checkSubmitButtonState();
}

function checkSubmitButtonState() {
    if (mainBody.classList.contains('order-closed')) {
        submitBtn.disabled = true;
        submitBtn.textContent = submitBtn.textContent.includes('時間到') ? '⛔ 時間已到，停止點餐' : '⛔ 已手動結單，停止點餐';
        return;
    }

    const isCartEmpty = cartItems.length === 0;
    const isUserReady = selectedAvatarChar && usernameInput.value.trim() !== '';
    
    if (isCartEmpty) {
        submitBtn.disabled = true;
        submitBtn.textContent = '請先選擇餐點';
    } else if (!isUserReady) {
        submitBtn.disabled = true;
        submitBtn.textContent = '請輸入名字並選擇頭像';
    } else {
        submitBtn.disabled = false;
        submitBtn.textContent = `✅ 送出訂單 ($${cartTotalPriceSpan.textContent})`;
    }
}
usernameInput.addEventListener('input', checkSubmitButtonState);

// --- C. 送出訂單 (v12.0 修改：使用 showToast 和 儲存設定) ---
submitBtn.addEventListener('click', async () => {
    if (submitBtn.disabled || mainBody.classList.contains('order-closed')) return;
    // v12.0: 改用 toast
    if (!currentSessionId) { showToast('系統錯誤：無場次 ID', 'error'); return; }
    
    const userName = usernameInput.value.trim();
    submitBtn.textContent = '正在送出...';
    submitBtn.disabled = true;

    const itemsToOrder = cartItems.map(item => ({
        name: item.name,
        price: item.price,
        note: item.note,
        quantity: item.quantity
    }));
    const totalCost = parseInt(cartTotalPriceSpan.textContent);

    try {
        await addDoc(collection(db, "todayOrders"), {
            sessionId: currentSessionId,
            userName: userName,
            userAvatar: selectedAvatarChar,
            items: itemsToOrder,
            totalCost: totalCost,
            paidAmount: 0,
            orderTime: serverTimestamp()
        });
        
        // v12.0: 成功後儲存使用者設定到 localStorage
        saveUserSettings(userName, selectedAvatarChar);

        // v12.0: 改用 toast 顯示成功訊息
        showToast(`✅ ${userName}，訂單送出成功！`, 'success');
        
        // 清空購物車，但不清空名字和頭像 (因為已經記住了)
        cartItems = [];
        updateCartUI();
        updateMenuSelectionState();
        checkSubmitButtonState();
        // 關閉購物車面板 (如果開著)
        closeCart();

    } catch (e) {
        // v12.0: 改用 toast 顯示錯誤訊息
        showToast('❌ 訂購失敗：' + e.message, 'error');
        checkSubmitButtonState();
    }
});

// --- D. 即時監聽點餐狀況 (維持 v10) ---
function setupOrderListener(sessionId) {
    if (unsubscribeOrders) unsubscribeOrders();
    const q = query(collection(db, "todayOrders"), where("sessionId", "==", sessionId), orderBy("orderTime", "desc"));
    unsubscribeOrders = onSnapshot(q, (querySnapshot) => {
        liveStatusList.innerHTML = '';
        totalPeopleCountSpan.textContent = querySnapshot.size;
        if (querySnapshot.empty) { liveStatusList.innerHTML = '<p style="text-align: center; opacity: 0.7;">目前還沒有人點餐...</p>'; return; }
        querySnapshot.forEach((doc) => {
            const order = doc.data();
            const li = document.createElement('li');
            li.classList.add('status-item');
            let itemsHtml = order.items.map(item => {
                const noteHtml = item.note ? `<span class="item-note">${item.note}</span>` : '';
                const qtyHtml = item.quantity > 1 ? ` <b>x${item.quantity}</b>` : '';
                return `<div>- ${item.name}${qtyHtml} ${noteHtml}</div>`;
            }).join('');
            li.innerHTML = `
                <div class="status-user-row">
                    <span class="status-avatar">${order.userAvatar}</span>
                    <span>${order.userName} (總計: $${order.totalCost})</span>
                </div>
                <div class="status-items-detail">${itemsHtml}</div>
            `;
            liveStatusList.appendChild(li);
        });
    });
}