// main.js - 前台主邏輯 (v11.0 浮動購物車版)
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
// v11.0 移除 personalTotalDisplay
const liveStatusList = document.getElementById('live-status-list');
const totalPeopleCountSpan = document.getElementById('total-people-count');
const mapLinkContainer = document.getElementById('map-link-container');
const deadlineBanner = document.getElementById('deadline-banner');
const deadlineFullDateDisplay = document.getElementById('deadline-full-date');
const countdownTimerDisplay = document.getElementById('countdown-timer');

// v11.0 新增購物車相關 DOM
const cartFab = document.getElementById('cart-fab');
const cartCountBadge = document.getElementById('cart-count-badge');
const cartPanel = document.getElementById('cart-panel');
const closeCartBtn = document.getElementById('close-cart-btn');
const cartItemsList = document.getElementById('cart-items-list');
const cartTotalPriceSpan = document.getElementById('cart-total-price');
const cartConfirmBtn = document.getElementById('cart-confirm-btn');
const cartOverlay = document.getElementById('cart-overlay');


// --- 狀態變數 ---
let selectedAvatarChar = null;
// v11.0 修改: cartItems 改為儲存完整的商品物件陣列，不再是 Map
// 格式: [{ name, price, quantity, note, icon }, ...]
let cartItems = []; 
let currentSessionId = null;
let unsubscribeOrders = null;
let isManualClosed = false;
let deadlineDate = null;
let checkTimeInterval = null;
let countdownInterval = null;
let priceChangeMap = new Map(); 
let globalItemIndex = 0;

// --- A. 監聽菜單資訊與狀態 (維持不變) ---
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
        
        // v11.0: 菜單更新時清空購物車
        cartItems = [];
        updateCartUI();

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
        closeCart(); // 結單時關閉購物車
    } else {
        mainBody.classList.remove('order-closed');
        checkSubmitButtonState(); // 按鈕狀態由購物車決定
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

// --- v11.0 核心：購物車邏輯 ---

// 1. 建立菜單項目 (點擊加入購物車)
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
    
    // v11.0 修改點擊事件：加入購物車並打開面板
    el.addEventListener('click', () => {
        if (mainBody.classList.contains('order-closed')) return;
        addToCart(item, dishIcon);
        openCart(); // 加入後自動打開購物車讓使用者確認
    });
    return el;
}

// 2. 加入購物車
function addToCart(item, icon) {
    // 檢查是否已存在 (這裡簡單比對名稱，若要支援同品項不同備註需更複雜的邏輯)
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
    updateMenuSelectionState(); // 更新菜單上的選中狀態
}

// 3. 更新購物車介面 (Badge, Total, List)
function updateCartUI() {
    // 更新角標數量
    const totalCount = cartItems.reduce((sum, item) => sum + item.quantity, 0);
    cartCountBadge.textContent = totalCount;
    cartCountBadge.setAttribute('data-count', totalCount);

    // 更新總金額
    const totalPrice = cartItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    cartTotalPriceSpan.textContent = totalPrice;

    // 重新渲染購物車清單
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

            // 綁定事件
            itemEl.querySelector('.minus').addEventListener('click', () => updateCartItemQuantity(index, -1));
            itemEl.querySelector('.plus').addEventListener('click', () => updateCartItemQuantity(index, 1));
            itemEl.querySelector('.cart-item-remove').addEventListener('click', () => removeFromCart(index));
            itemEl.querySelector('.cart-item-note-input').addEventListener('input', (e) => { item.note = e.target.value.trim(); });
            
            cartItemsList.appendChild(itemEl);
        });
    }
    checkSubmitButtonState();
}

// 4. 更新購物車商品數量
function updateCartItemQuantity(index, delta) {
    const item = cartItems[index];
    item.quantity += delta;
    if (item.quantity <= 0) {
        removeFromCart(index);
    } else {
        updateCartUI();
    }
}

// 5. 從購物車移除
function removeFromCart(index) {
    cartItems.splice(index, 1);
    updateCartUI();
    updateMenuSelectionState();
}

// 6. 更新菜單卡片的選中狀態 (視覺回饋)
function updateMenuSelectionState() {
    const menuCards = document.querySelectorAll('.menu-item-checkbox');
    menuCards.forEach(card => {
        const itemName = card.querySelector('.food-info span').textContent;
        // 檢查這個品項是否在購物車裡
        const isInCart = cartItems.some(item => item.name === itemName);
        if (isInCart) {
            card.classList.add('selected');
        } else {
            card.classList.remove('selected');
        }
    });
}

// 7. 開啟/關閉購物車面板
function openCart() {
    cartPanel.classList.add('open');
    cartOverlay.classList.add('show');
    document.body.style.overflow = 'hidden'; // 防止背景滾動
}
function closeCart() {
    cartPanel.classList.remove('open');
    cartOverlay.classList.remove('show');
    document.body.style.overflow = ''; // 恢復背景滾動
}

// 綁定購物車開關事件
cartFab.addEventListener('click', openCart);
closeCartBtn.addEventListener('click', closeCart);
cartOverlay.addEventListener('click', closeCart);
cartConfirmBtn.addEventListener('click', closeCart); // 確認後關閉


// --- B. 用戶輸入互動 (維持 v10) ---
window.selectAvatar = (element, char) => {
    if (mainBody.classList.contains('order-closed')) return;
    document.querySelectorAll('.avatar-option').forEach(e => e.classList.remove('selected'));
    element.classList.add('selected');
    selectedAvatarChar = char;
    checkSubmitButtonState();
}

// v11.0 修改：按鈕狀態檢查邏輯
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

// --- C. 送出訂單 (v11.0 修改：從 cartItems 讀取資料) ---
submitBtn.addEventListener('click', async () => {
    if (submitBtn.disabled || mainBody.classList.contains('order-closed')) return;
    if (!currentSessionId) { alert('系統錯誤：無場次 ID'); return; }
    
    const userName = usernameInput.value.trim();
    submitBtn.textContent = '正在送出...';
    submitBtn.disabled = true;

    // v11.0: 直接使用 cartItems 陣列
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
        alert(`✅ ${userName}，訂單送出成功！`);
        // 送出成功後清空購物車與輸入
        cartItems = [];
        updateCartUI();
        updateMenuSelectionState();
        usernameInput.value = '';
        document.querySelectorAll('.avatar-option').forEach(e => e.classList.remove('selected'));
        selectedAvatarChar = null;
        checkSubmitButtonState();
        // 不用 reload，體驗更好
    } catch (e) {
        alert('❌ 訂購失敗：' + e.message);
        checkSubmitButtonState(); // 恢復按鈕狀態
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