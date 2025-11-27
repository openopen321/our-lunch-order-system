// main.js - 前台主邏輯 (v10.0)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, doc, onSnapshot, collection, addDoc, query, orderBy, serverTimestamp, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
// 引入獨立的設定檔
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// DOM
const mainBody = document.getElementById('main-body');
const menuContainer = document.getElementById('menu-list-container');
const restaurantNameDisplay = document.getElementById('restaurant-name-display');
const menuTimeInfoDisplay = document.getElementById('menu-time-info');
const restaurantPhoneDisplay = document.getElementById('restaurant-phone');
const usernameInput = document.getElementById('username-input');
const submitBtn = document.getElementById('submit-btn');
const personalTotalDisplay = document.getElementById('personal-total');
const liveStatusList = document.getElementById('live-status-list');
const totalPeopleCountSpan = document.getElementById('total-people-count');
const mapLinkContainer = document.getElementById('map-link-container');
const deadlineBanner = document.getElementById('deadline-banner');
const deadlineFullDateDisplay = document.getElementById('deadline-full-date');
const countdownTimerDisplay = document.getElementById('countdown-timer');

let selectedAvatarChar = null;
let currentSelectionsMap = new Map();
let currentSessionId = null;
let unsubscribeOrders = null;
let isManualClosed = false;
let deadlineDate = null;
let checkTimeInterval = null;
let countdownInterval = null;
let priceChangeMap = new Map(); 
let globalItemIndex = 0;

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
    } else {
        menuContainer.innerHTML = '<p style="text-align: center;">今日尚未發布菜單...</p>';
        deadlineBanner.style.display = 'none';
        mapLinkContainer.innerHTML = '';
        if (checkTimeInterval) clearInterval(checkTimeInterval);
        if (countdownInterval) clearInterval(countdownInterval);
    }
});

// 倒數計時功能
function startCountdown() {
    if (countdownInterval) clearInterval(countdownInterval);
    
    if (!deadlineDate) {
        countdownTimerDisplay.textContent = '---';
        return;
    }

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
            
            const hStr = hours.toString().padStart(2, '0');
            const mStr = minutes.toString().padStart(2, '0');
            const sStr = seconds.toString().padStart(2, '0');

            countdownTimerDisplay.textContent = `剩餘 ${hStr}小時 ${mStr}分 ${sStr}秒`;
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
            const diff = item.newPrice - item.oldPrice;
            priceChangeMap.set(item.name, diff);
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
    } else {
        mainBody.classList.remove('order-closed');
        submitBtn.textContent = '✅ 送出訂單';
        usernameInput.disabled = false;
        checkSubmitButtonState();
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

// renderMenu
function renderMenu(data) {
    menuContainer.innerHTML = '';
    currentSelectionsMap.clear();
    updatePersonalSummary();
    globalItemIndex = 0;

    if (data.menuCategories && Array.isArray(data.menuCategories)) {
        data.menuCategories.forEach(category => {
            const titleEl = document.createElement('div');
            titleEl.classList.add('category-title');
            titleEl.textContent = category.categoryName;
            menuContainer.appendChild(titleEl);

            const listEl = document.createElement('div');
            listEl.classList.add('menu-grid');
            category.items.forEach(item => {
                listEl.appendChild(createMenuItemElement(item));
            });
            menuContainer.appendChild(listEl);
        });
    } else if (data.menuItems && Array.isArray(data.menuItems)) {
        const listEl = document.createElement('div');
        listEl.classList.add('menu-grid');
        data.menuItems.forEach(item => {
            listEl.appendChild(createMenuItemElement(item));
        });
        menuContainer.appendChild(listEl);
    } else {
            menuContainer.innerHTML = '<p>菜單資料格式錯誤或為空。</p>';
    }

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

    const menuItems = document.querySelectorAll('.menu-item-checkbox');
    menuItems.forEach(item => {
        observer.observe(item);
    });
}

// 建立菜單項目元素
function createMenuItemElement(item) {
    const el = document.createElement('div');
    el.classList.add('menu-item-checkbox');

    el.style.transitionDelay = `${globalItemIndex * 0.025}s`;
    globalItemIndex++;

    let priceNoteHtml = '';
    if (priceChangeMap.has(item.name)) {
        const diff = priceChangeMap.get(item.name);
        if (diff > 0) {
            priceNoteHtml = `<span class="price-note-up">(漲${diff})</span>`;
        } else if (diff < 0) {
            priceNoteHtml = `<span class="price-note-down">(降${Math.abs(diff)})</span>`;
        }
    }

    const dishIcon = getIconForDish(item.name);

    el.innerHTML = `
        <div class="menu-item-header">
            <div class="food-icon-wrapper">${dishIcon}</div>
            <div class="food-info">
                <span>${item.name}</span>
                <div>
                    <b>$${item.price}</b>${priceNoteHtml}
                </div>
            </div>
            <div class="checkbox-square"></div>
        </div>
        <div class="item-details-container">
            <div class="quantity-controls" style="margin-bottom: 10px;">
                <button class="qty-btn minus">-</button>
                <span>數量: <span class="qty-display">1</span></span>
                <button class="qty-btn plus">+</button>
            </div>
            <input type="text" class="note-input" placeholder="備註 (例如: 加辣)">
        </div>
    `;
    
    const header = el.querySelector('.menu-item-header');
    const noteInput = el.querySelector('.note-input');
    const qtyDisplay = el.querySelector('.qty-display');
    const minusBtn = el.querySelector('.minus');
    const plusBtn = el.querySelector('.plus');

    header.addEventListener('click', () => {
        if (mainBody.classList.contains('order-closed')) return;
        el.classList.toggle('selected');
        if (el.classList.contains('selected')) {
            currentSelectionsMap.set(item.name, { originalItem: item, noteInputDOM: noteInput, quantityDOM: qtyDisplay });
            qtyDisplay.textContent = '1';
        } else {
            currentSelectionsMap.delete(item.name);
            noteInput.value = ''; 
        }
        updatePersonalSummary();
        checkSubmitButtonState();
    });

    minusBtn.addEventListener('click', (e) => { e.stopPropagation(); changeQuantity(item.name, -1); });
    plusBtn.addEventListener('click', (e) => { e.stopPropagation(); changeQuantity(item.name, 1); });
    return el;
}

function changeQuantity(itemName, delta) {
    if (mainBody.classList.contains('order-closed')) return;
    const selection = currentSelectionsMap.get(itemName);
    if (!selection) return;
    let currentQty = parseInt(selection.quantityDOM.textContent);
    let newQty = currentQty + delta;
    if (newQty < 1) newQty = 1;
    selection.quantityDOM.textContent = newQty;
    updatePersonalSummary();
}

function updatePersonalSummary() {
    let total = 0;
    currentSelectionsMap.forEach(sel => {
        total += sel.originalItem.price * parseInt(sel.quantityDOM.textContent);
    });
    personalTotalDisplay.textContent = total;
}

// --- B. 用戶輸入互動 ---
// 將 selectAvatar 掛載到 window 物件上，因為 HTML onclick 會用到它
window.selectAvatar = (element, char) => {
    if (mainBody.classList.contains('order-closed')) return;
    document.querySelectorAll('.avatar-option').forEach(e => e.classList.remove('selected'));
    element.classList.add('selected');
    selectedAvatarChar = char;
    checkSubmitButtonState();
}

function checkSubmitButtonState() {
    if (mainBody.classList.contains('order-closed')) {
        submitBtn.disabled = true; return;
    }
    if (selectedAvatarChar && usernameInput.value.trim() !== '' && currentSelectionsMap.size > 0 && currentSessionId) {
        submitBtn.disabled = false;
    } else {
        submitBtn.disabled = true;
    }
}
usernameInput.addEventListener('input', checkSubmitButtonState);

// --- C. 送出訂單 ---
submitBtn.addEventListener('click', async () => {
    if (submitBtn.disabled || mainBody.classList.contains('order-closed')) return;
    if (!currentSessionId) { alert('系統錯誤：無場次 ID'); return; }
    
    const userName = usernameInput.value.trim();
    submitBtn.textContent = '正在送出...';
    submitBtn.disabled = true;

    const itemsToOrder = [];
    let totalCost = 0;
    currentSelectionsMap.forEach(sel => {
        const qty = parseInt(sel.quantityDOM.textContent);
        itemsToOrder.push({
            name: sel.originalItem.name,
            price: sel.originalItem.price,
            note: sel.noteInputDOM.value.trim(),
            quantity: qty
        });
        totalCost += sel.originalItem.price * qty;
    });

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
        window.location.reload(); 
    } catch (e) {
        alert('❌ 訂購失敗：' + e.message);
        submitBtn.disabled = false;
        submitBtn.textContent = '✅ 送出訂單';
    }
});

// --- D. 即時監聽點餐狀況 ---
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