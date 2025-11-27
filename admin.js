// admin.js - 後台主邏輯 (v10.0)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, doc, setDoc, updateDoc, deleteDoc, onSnapshot, collection, query, orderBy, serverTimestamp, where, increment, getDoc, Timestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
// 引入獨立的設定檔
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// DOM
const adminRestaurantName = document.getElementById('admin-restaurant-name');
const currentSessionIdDisplay = document.getElementById('current-session-id');
const statusBadge = document.getElementById('status-badge');
const btnCloseOrder = document.getElementById('btn-close-order');
const summaryHeader = document.getElementById('summary-header');
const aggregatedListEl = document.getElementById('aggregated-order-list');
const orderTableBody = document.getElementById('order-table-body');
const grandTotalDueEl = document.getElementById('grand-total-due');
const grandTotalPaidEl = document.getElementById('grand-total-paid');
const grandTotalDebtEl = document.getElementById('grand-total-debt');
const adminJsonInput = document.getElementById('admin-json-input');
const publishBtn = document.getElementById('publish-btn');
const historyListEl = document.getElementById('history-list');
const deadlineTimeInput = document.getElementById('deadline-time-input');
const deadlineDisplay = document.getElementById('deadline-display');
const adminMapUrlInput = document.getElementById('admin-map-url');

let currentSessionId = null;
let unsubscribeOrders = null;
let currentMenuData = null;
let isOrderClosed = false;

// --- A. 監聽菜單資訊與狀態 ---
onSnapshot(doc(db, "dailyData", "menu"), (docSnap) => {
    if (docSnap.exists()) {
        currentMenuData = docSnap.data();
        adminRestaurantName.textContent = currentMenuData.restaurantName || '今日餐廳';
        currentSessionId = currentMenuData.sessionId || 'unknown_session';
        currentSessionIdDisplay.textContent = `場次 ID: ${currentSessionId}`;
        
        isOrderClosed = currentMenuData.isOrderClosed === true;
        statusBadge.style.display = 'inline-block';
        btnCloseOrder.disabled = false;

        if (currentMenuData.deadlineTimestamp) {
            const deadlineDate = currentMenuData.deadlineTimestamp.toDate();
            deadlineDisplay.textContent = `(今日截止: ${deadlineDate.toLocaleString('zh-TW', {hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'})})`;
        } else {
            deadlineDisplay.textContent = '(未設定截止時間)';
        }

        if (isOrderClosed) {
            statusBadge.textContent = '⛔ 已手動結單';
            statusBadge.className = 'status-badge status-closed';
            btnCloseOrder.textContent = '✅ 已結單 (點擊重新開放)';
            btnCloseOrder.style.background = '#ccc';
            btnCloseOrder.style.color = '#333';
        } else {
            statusBadge.textContent = '🟢 手動開放中 (時間到自動關閉)';
            statusBadge.className = 'status-badge status-open';
            btnCloseOrder.textContent = '🔴 鎖定結單 (停止點餐)';
            btnCloseOrder.style.background = '#ff4d4d';
            btnCloseOrder.style.color = 'white';
        }
        
        let dateStr = '未知日期';
        if (currentMenuData.updatedAt) {
            dateStr = new Date(currentMenuData.updatedAt.seconds * 1000).toLocaleString('zh-TW');
        }
        summaryHeader.innerHTML = `訂餐日期: ${dateStr}<br>餐廳電話: ${currentMenuData.restaurantPhone || '(無)'}`;
        
        if (currentMenuData.restaurantMapUrl) {
            adminMapUrlInput.value = currentMenuData.restaurantMapUrl;
        } else {
            adminMapUrlInput.value = '';
        }

        setupOrderListener(currentSessionId);
    } else {
        adminRestaurantName.textContent = '尚未發布';
        summaryHeader.textContent = '等待發布菜單...';
        statusBadge.style.display = 'none';
        btnCloseOrder.disabled = true;
        deadlineDisplay.textContent = '';
        adminMapUrlInput.value = '';
    }
});

// --- 手動結單按鈕點擊事件 ---
btnCloseOrder.addEventListener('click', async () => {
    if (!currentSessionId) return;
    const newStatus = !isOrderClosed;
    const confirmMsg = newStatus ? "確定要「手動結單」嗎？前台將無法再點餐。" : "確定要「重新開放」點餐嗎？";
    if (confirm(confirmMsg)) {
        try { await updateDoc(doc(db, "dailyData", "menu"), { isOrderClosed: newStatus }); } 
        catch (e) { alert('操作失敗：' + e.message); }
    }
});

// --- B. 發布新菜單 ---
publishBtn.addEventListener('click', async () => {
    const jsonString = adminJsonInput.value.trim();
    const deadlineTimeStr = deadlineTimeInput.value;
    const mapUrl = adminMapUrlInput.value.trim();

    if (!jsonString) { alert('請先貼上 JSON！'); return; }
    if (!deadlineTimeStr) { alert('請設定截止時間！'); return; }

    publishBtn.textContent = '正在處理比對與發布...';
    publishBtn.disabled = true;
    
    const newSessionId = 'session_' + Date.now();
    try {
        const newMenuData = JSON.parse(jsonString);

        const now = new Date();
        const [hours, minutes] = deadlineTimeStr.split(':').map(Number);
        const deadlineDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0);
        
        const oldDocSnap = await getDoc(doc(db, "dailyData", "menu"));
        const oldMenuData = oldDocSnap.exists() ? oldDocSnap.data() : null;
        const comparisonSummary = generateComparisonSummary(oldMenuData, newMenuData);
        
        const dataToSave = {
            restaurantName: newMenuData.restaurantName || '未知餐廳',
            restaurantPhone: newMenuData.restaurantPhone || '',
            restaurantMapUrl: mapUrl,
            sessionId: newSessionId,
            isOrderClosed: false,
            deadlineTimestamp: Timestamp.fromDate(deadlineDate),
            updatedAt: serverTimestamp(),
            comparisonSummary: comparisonSummary
        };

        if (newMenuData.menuCategories) dataToSave.menuCategories = newMenuData.menuCategories;
        else if (newMenuData.menuItems) dataToSave.menuItems = newMenuData.menuItems;

        await setDoc(doc(db, "dailyData", "menu"), dataToSave);

        const historyData = {
            restaurantName: dataToSave.restaurantName,
            restaurantPhone: dataToSave.restaurantPhone,
            restaurantMapUrl: mapUrl,
            lastUsed: serverTimestamp(),
            orderCount: increment(1)
        };
        if (newMenuData.menuCategories) historyData.menuCategories = newMenuData.menuCategories;
        else if (newMenuData.menuItems) historyData.menuItems = newMenuData.menuItems;

        await setDoc(doc(db, 'restaurantHistory', dataToSave.restaurantName), historyData, { merge: true });

        alert(`✅ 新場次開啟成功！截止時間設定為 ${deadlineDate.toLocaleTimeString('zh-TW', {hour:'2-digit', minute:'2-digit'})}。`);
        adminJsonInput.value = '';
    } catch (e) { 
        alert('❌ 發布失敗：' + e.message); 
    } finally {
        publishBtn.textContent = '🚀 發布新菜單 (開啟新場次)';
        publishBtn.disabled = false;
    }
});

// 自動比對函數
function generateComparisonSummary(oldData, newData) {
    if (!oldData || oldData.restaurantName !== newData.restaurantName) {
        return null;
    }
    const oldMap = flattenMenu(oldData);
    const newMap = flattenMenu(newData);
    const summary = { newItems: [], changedItems: [], removedItems: [] };
    let hasChanges = false;

    newMap.forEach((price, name) => {
        if (!oldMap.has(name)) {
            summary.newItems.push({ name, price });
            hasChanges = true;
        } else if (oldMap.get(name) !== price) {
            summary.changedItems.push({ name, oldPrice: oldMap.get(name), newPrice: price });
            hasChanges = true;
        }
    });
    oldMap.forEach((price, name) => {
        if (!newMap.has(name)) {
            summary.removedItems.push({ name });
            hasChanges = true;
        }
    });
    return hasChanges ? summary : null;
}

// 輔助函數：扁平化菜單
function flattenMenu(menuData) {
    const itemsMap = new Map();
    let itemsArray = [];
    if (menuData.menuCategories) {
        menuData.menuCategories.forEach(cat => { if (cat.items) itemsArray = itemsArray.concat(cat.items); });
    } else if (menuData.menuItems) {
        itemsArray = menuData.menuItems;
    }
    itemsArray.forEach(item => { itemsMap.set(item.name, item.price); });
    return itemsMap;
}


// --- C. 監聽歷史紀錄 ---
const historyQ = query(collection(db, 'restaurantHistory'), orderBy('lastUsed', 'desc'));
onSnapshot(historyQ, (snapshot) => {
    historyListEl.innerHTML = '';
    if (snapshot.empty) { historyListEl.innerHTML = '<p>尚無歷史紀錄</p>'; return; }
    snapshot.forEach(doc => {
        const data = doc.data();
        const li = document.createElement('li');
        li.classList.add('history-item');
        li.innerHTML = `
            <div class="history-info">
                <strong>${data.restaurantName}</strong> (點過 ${data.orderCount || 1} 次)<br>
                <span style="font-size: 0.9rem;">電話: ${data.restaurantPhone}</span>
            </div>
            <button class="btn btn-load">載入菜單</button>
        `;
        li.querySelector('.btn-load').addEventListener('click', () => {
            const jsonToLoad = {
                restaurantName: data.restaurantName,
                restaurantPhone: data.restaurantPhone,
            };
            if (data.menuCategories) jsonToLoad.menuCategories = data.menuCategories;
            else if (data.menuItems) jsonToLoad.menuItems = data.menuItems;

            adminJsonInput.value = JSON.stringify(jsonToLoad, null, 2);
            adminMapUrlInput.value = data.restaurantMapUrl || '';
            
            adminJsonInput.scrollIntoView({ behavior: 'smooth' });
        });
        historyListEl.appendChild(li);
    });
});

// --- D. 訂單監聽與渲染 ---
function setupOrderListener(sessionId) {
    if (unsubscribeOrders) unsubscribeOrders();
    const q = query(collection(db, "todayOrders"), where("sessionId", "==", sessionId), orderBy("orderTime", "desc"));
    unsubscribeOrders = onSnapshot(q, (querySnapshot) => {
        renderOrders(querySnapshot);
    });
}

function renderOrders(querySnapshot) {
    orderTableBody.innerHTML = '';
    let currentOrdersData = [];
    let stats = { totalDue: 0, totalPaid: 0 };

    if (querySnapshot.empty) {
        orderTableBody.innerHTML = '<tr><td colspan="6">當前場次尚無訂單</td></tr>';
        aggregatedListEl.innerHTML = '<li>尚未有訂單</li>';
        updateFooterStats(0, 0);
        return;
    }

    querySnapshot.forEach((docSnap) => {
        const order = docSnap.data();
        if (!order.items || !Array.isArray(order.items)) return;
        order.id = docSnap.id;
        currentOrdersData.push(order);

        stats.totalDue += order.totalCost;
        const paidAmount = Number(order.paidAmount) || 0;
        stats.totalPaid += paidAmount;
        const remaining = order.totalCost - paidAmount;
        
        const isFullyPaid = remaining === 0 && order.totalCost > 0;
        let statusHtml = '<span class="status-paid">已付清</span>';
        if (remaining > 0) statusHtml = `<span class="status-debt">未付: $${remaining}</span>`;
        else if (remaining < 0) statusHtml = `<span class="status-change">需找回: $${Math.abs(remaining)}</span>`;

        const tr = document.createElement('tr');
        if (isFullyPaid) tr.classList.add('row-fully-paid');

        const itemsDetails = order.items.map(item => {
            const qtyStr = item.quantity > 1 ? ` <b>x${item.quantity}</b>` : '';
            const noteStr = item.note ? ` <span class="item-note">(${item.note})</span>` : '';
            return `${item.name}${qtyStr}${noteStr}`;
        }).join('<br>');

        tr.innerHTML = `
            <td>${order.userAvatar} ${order.userName}</td>
            <td class="text-left">${itemsDetails}</td>
            <td>$${order.totalCost}</td>
            <td><input type="number" class="paid-input" value="${paidAmount}" min="0" onchange="updatePaidAmount('${order.id}', this.value)"></td>
            <td>${statusHtml}</td>
            <td><button class="btn btn-delete" onclick="deleteOrder('${order.id}', '${order.userName}')">❌ 刪除</button></td>
        `;
        orderTableBody.appendChild(tr);
    });
    updateFooterStats(stats.totalDue, stats.totalPaid);
    calculateAggregation(currentOrdersData);
}

function updateFooterStats(due, paid) {
    grandTotalDueEl.textContent = due;
    grandTotalPaidEl.textContent = paid;
    const debt = due - paid;
    grandTotalDebtEl.textContent = debt > 0 ? debt : 0;
}

// 將 deleteOrder 和 updatePaidAmount 掛載到 window 物件，因為 HTML onclick 會用到
window.deleteOrder = async (orderId, userName) => {
    if (confirm(`確定要刪除「${userName}」的訂單嗎？此動作無法復原。`)) {
        try { await deleteDoc(doc(db, "todayOrders", orderId)); } 
        catch (e) { alert('刪除失敗：' + e.message); }
    }
}

window.updatePaidAmount = async (orderId, newValue) => {
    const amount = Number(newValue);
    if (isNaN(amount)) { alert('請輸入有效的金額'); return; }
    try { await updateDoc(doc(db, "todayOrders", orderId), { paidAmount: amount }); } 
    catch (e) { alert('更新失敗：' + e.message); }
}

// --- E. 訂單統整邏輯 ---
function calculateAggregation(orders) {
    const summaryMap = {};
    let totalItemsCount = 0;
    orders.forEach(order => {
        order.items.forEach(item => {
            const qty = item.quantity || 1;
            totalItemsCount += qty;
            if (!summaryMap[item.name]) summaryMap[item.name] = { count: 0, notes: [] };
            summaryMap[item.name].count += qty;
            if (item.note) summaryMap[item.name].notes.push(`${qty}份:${item.note}`);
        });
    });
    aggregatedListEl.innerHTML = '';
    if (Object.keys(summaryMap).length === 0) { aggregatedListEl.innerHTML = '<li>當前場次尚無訂單</li>'; return; }
    
    const totalLi = document.createElement('li');
    totalLi.innerHTML = `<strong>📊 總共訂購：${totalItemsCount} 份餐點</strong><hr style="margin: 5px 0; border-top: 1px dashed #ccc;">`;
    aggregatedListEl.appendChild(totalLi);

    for (const [foodName, data] of Object.entries(summaryMap)) {
        const li = document.createElement('li');
        let noteDisplay = data.notes.length > 0 ? `<span class="summary-notes">備註: ${data.notes.join('; ')}</span>` : '';
        li.innerHTML = `<b>${foodName}</b> x ${data.count} 份 ${noteDisplay}`;
        aggregatedListEl.appendChild(li);
    }
}