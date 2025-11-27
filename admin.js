// admin.js - 後台主邏輯 (v14.0 JSON微調助手版)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, doc, setDoc, updateDoc, deleteDoc, onSnapshot, collection, query, orderBy, serverTimestamp, where, increment, getDoc, Timestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// --- DOM 元素 ---
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
const statOrderCount = document.getElementById('stat-order-count');
const statTotalSales = document.getElementById('stat-total-sales');
const statTotalDebt = document.getElementById('stat-total-debt');
const topItemsListEl = document.getElementById('top-items-list');
const toastContainer = document.getElementById('toast-container');
// v14.0 新增 DOM
const btnParseTweak = document.getElementById('btn-parse-tweak');
const jsonTweakerContainer = document.getElementById('json-tweaker-container');
const tweakerItemsList = document.getElementById('tweaker-items-list');
const btnCancelTweak = document.getElementById('btn-cancel-tweak');
const btnApplyTweak = document.getElementById('btn-apply-tweak');
const tweakerControls = document.getElementById('tweaker-controls');


let currentSessionId = null;
let unsubscribeOrders = null;
let currentMenuData = null;
let isOrderClosed = false;
// v14.0: 用於暫存解析後的資料結構
let tempTweakerData = { restaurantName: '', restaurantPhone: '', categories: [] };


// --- Toast 提示訊息函數 ---
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.classList.add('toast', type);
    let icon = 'ℹ️';
    if (type === 'success') icon = '✅';
    if (type === 'error') icon = '❌';
    toast.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-message">${message}</span>`;
    toastContainer.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('hide');
        toast.addEventListener('animationend', () => toast.remove());
    }, 3000);
}

// --- A. 監聽菜單資訊與狀態 (維持不變) ---
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
            statusBadge.textContent = '🟢 手動開放中';
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
        updateDashboardStats(0, 0, 0);
        topItemsListEl.innerHTML = '<p style="text-align: center; color: #888;">尚無資料</p>';
    }
});

// --- 手動結單按鈕點擊事件 ---
btnCloseOrder.addEventListener('click', async () => {
    if (!currentSessionId) return;
    const newStatus = !isOrderClosed;
    const confirmMsg = newStatus ? "確定要「手動結單」嗎？前台將無法再點餐。" : "確定要「重新開放」點餐嗎？";
    if (confirm(confirmMsg)) {
        try { 
            await updateDoc(doc(db, "dailyData", "menu"), { isOrderClosed: newStatus });
            showToast(newStatus ? '已手動結單' : '已重新開放點餐', 'success');
        } 
        catch (e) { showToast('操作失敗：' + e.message, 'error'); }
    }
});


// --- v14.0 核心：JSON 微調助手邏輯 ---

// 1. 解析並顯示微調介面
btnParseTweak.addEventListener('click', () => {
    const jsonString = adminJsonInput.value.trim();
    if (!jsonString) { showToast('請先貼上 JSON 文字！', 'error'); return; }

    try {
        const data = JSON.parse(jsonString);
        // 簡單驗證結構
        if (!data.restaurantName || (!data.menuCategories && !data.menuItems)) {
            throw new Error('JSON 結構不完整，缺少餐廳名稱或菜單資料。');
        }

        // 暫存資料
        tempTweakerData.restaurantName = data.restaurantName;
        tempTweakerData.restaurantPhone = data.restaurantPhone || '';
        tempTweakerData.categories = [];

        // 統一格式化為分類結構，方便渲染
        if (data.menuCategories) {
            tempTweakerData.categories = data.menuCategories;
        } else if (data.menuItems) {
            tempTweakerData.categories = [{ categoryName: '未分類項目', items: data.menuItems }];
        }

        // 渲染微調介面
        renderTweakerInterface();

        // 切換顯示狀態
        adminJsonInput.style.display = 'none';
        tweakerControls.style.display = 'none';
        jsonTweakerContainer.style.display = 'block';
        showToast('解析成功，請開始微調。', 'success');

    } catch (e) {
        showToast('JSON 解析失敗：' + e.message, 'error');
    }
});

function renderTweakerInterface() {
    tweakerItemsList.innerHTML = '';
    
    // 顯示餐廳基本資訊 (唯讀，提示用)
    const infoHeader = document.createElement('div');
    infoHeader.innerHTML = `<p><strong>餐廳：</strong>${tempTweakerData.restaurantName} ${tempTweakerData.restaurantPhone ? '('+tempTweakerData.restaurantPhone+')' : ''}</p>`;
    tweakerItemsList.appendChild(infoHeader);

    tempTweakerData.categories.forEach((cat, catIndex) => {
        const catCard = document.createElement('div');
        catCard.classList.add('tweaker-category-card');
        catCard.innerHTML = `<div class="tweaker-cat-title">${cat.categoryName}</div>`;
        
        cat.items.forEach((item, itemIndex) => {
            const row = document.createElement('div');
            row.classList.add('tweaker-item-row');
            // 使用 data- 屬性來標記位置，方便後續讀取
            row.innerHTML = `
                <input type="text" class="tweak-input-name" value="${item.name}" data-cat="${catIndex}" data-item="${itemIndex}">
                <input type="number" class="tweak-input-price" value="${item.price}" min="0" data-cat="${catIndex}" data-item="${itemIndex}">
            `;
            catCard.appendChild(row);
        });
        tweakerItemsList.appendChild(catCard);
    });
}

// 2. 取消微調
btnCancelTweak.addEventListener('click', () => {
    toggleTweakerView(false);
});

// 3. 確認修改並重建 JSON
btnApplyTweak.addEventListener('click', () => {
    // 讀取所有輸入框的值並更新 tempTweakerData
    const nameInputs = tweakerItemsList.querySelectorAll('.tweak-input-name');
    const priceInputs = tweakerItemsList.querySelectorAll('.tweak-input-price');

    let hasError = false;
    nameInputs.forEach(input => {
        const catIdx = input.dataset.cat;
        const itemIdx = input.dataset.item;
        const newName = input.value.trim();
        if (!newName) hasError = true;
        tempTweakerData.categories[catIdx].items[itemIdx].name = newName;
    });
    priceInputs.forEach(input => {
        const catIdx = input.dataset.cat;
        const itemIdx = input.dataset.item;
        const newPrice = parseInt(input.value);
        if (isNaN(newPrice) || newPrice < 0) hasError = true;
        tempTweakerData.categories[catIdx].items[itemIdx].price = newPrice;
    });

    if (hasError) {
        showToast('請檢查輸入：餐點名稱不能為空，價格必須為有效數字。', 'error');
        return;
    }

    // 重建最終的 JSON 物件
    const finalJsonObj = {
        restaurantName: tempTweakerData.restaurantName,
        restaurantPhone: tempTweakerData.restaurantPhone,
        menuCategories: tempTweakerData.categories
    };

    // 轉成字串並填回文字框
    adminJsonInput.value = JSON.stringify(finalJsonObj, null, 2); // 使用 2 空格縮排增加可讀性

    toggleTweakerView(false);
    showToast('✅ 修改已套用！新的 JSON 已產生。', 'success');
    // 自動捲動到發布按鈕，方便使用者操作
    publishBtn.scrollIntoView({ behavior: 'smooth' });
});

function toggleTweakerView(showTweaker) {
    if (showTweaker) {
        adminJsonInput.style.display = 'none';
        tweakerControls.style.display = 'none';
        jsonTweakerContainer.style.display = 'block';
    } else {
        adminJsonInput.style.display = 'block';
        tweakerControls.style.display = 'block';
        jsonTweakerContainer.style.display = 'none';
    }
}


// --- B. 發布新菜單 (維持 v13) ---
publishBtn.addEventListener('click', async () => {
    const jsonString = adminJsonInput.value.trim();
    const deadlineTimeStr = deadlineTimeInput.value;
    const mapUrl = adminMapUrlInput.value.trim();

    if (!jsonString) { showToast('請先貼上 JSON！', 'error'); return; }
    if (!deadlineTimeStr) { showToast('請設定截止時間！', 'error'); return; }

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

        showToast(`✅ 新場次開啟成功！截止時間：${deadlineDate.toLocaleTimeString('zh-TW', {hour:'2-digit', minute:'2-digit'})}`, 'success');
        adminJsonInput.value = '';
        // 發布成功後，確保地圖連結也被清空，避免下次誤用
        adminMapUrlInput.value = ''; 
    } catch (e) { 
        showToast('❌ 發布失敗：' + e.message, 'error');
    } finally {
        publishBtn.textContent = '🚀 發布新菜單 (開啟新場次)';
        publishBtn.disabled = false;
    }
});

// 自動比對函數 (維持 v13)
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

// 輔助函數：扁平化菜單 (維持 v13)
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


// --- C. 監聽歷史紀錄 (維持 v13) ---
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
            showToast('已載入歷史菜單資料，您可以點擊「解析並微調」進行修改。', 'info');
        });
        historyListEl.appendChild(li);
    });
});

// --- D. 訂單監聽與渲染 (維持 v13) ---
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
    let stats = { totalDue: 0, totalPaid: 0, orderCount: 0 };

    if (querySnapshot.empty) {
        orderTableBody.innerHTML = '<tr><td colspan="6">當前場次尚無訂單</td></tr>';
        aggregatedListEl.innerHTML = '<li>尚未有訂單</li>';
        updateDashboardStats(0, 0, 0);
        renderTopItemsChart({});
        updateFooterStats(0, 0);
        return;
    }

    stats.orderCount = querySnapshot.size;

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

    const totalDebt = stats.totalDue - stats.totalPaid;
    updateDashboardStats(stats.orderCount, stats.totalDue, totalDebt);
    updateFooterStats(stats.totalDue, stats.totalPaid);
    
    const aggregationResult = calculateAggregation(currentOrdersData);
    renderTopItemsChart(aggregationResult.summaryMap);
}

// v13.0 新增：更新儀表板戰情卡
function updateDashboardStats(count, sales, debt) {
    statOrderCount.textContent = count;
    statTotalSales.textContent = sales;
    statTotalDebt.textContent = debt > 0 ? debt : 0;
}

function updateFooterStats(due, paid) {
    grandTotalDueEl.textContent = due;
    grandTotalPaidEl.textContent = paid;
    const debt = due - paid;
    grandTotalDebtEl.textContent = debt > 0 ? debt : 0;
}

window.deleteOrder = async (orderId, userName) => {
    if (confirm(`確定要刪除「${userName}」的訂單嗎？此動作無法復原。`)) {
        try { 
            await deleteDoc(doc(db, "todayOrders", orderId)); 
            showToast(`已刪除 ${userName} 的訂單`, 'success');
        } 
        catch (e) { showToast('刪除失敗：' + e.message, 'error'); }
    }
}

window.updatePaidAmount = async (orderId, newValue) => {
    const amount = Number(newValue);
    if (isNaN(amount)) { showToast('請輸入有效的金額', 'error'); return; }
    try { 
        await updateDoc(doc(db, "todayOrders", orderId), { paidAmount: amount }); 
    } 
    catch (e) { showToast('更新失敗：' + e.message, 'error'); }
}

// --- E. 訂單統整邏輯 (v13.0 修改) ---
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
    if (Object.keys(summaryMap).length === 0) { 
        aggregatedListEl.innerHTML = '<li>當前場次尚無訂單</li>'; 
    } else {
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
    return { summaryMap, totalItemsCount };
}

// v13.0 新增：渲染熱門餐點排行榜
function renderTopItemsChart(summaryMap) {
    topItemsListEl.innerHTML = '';
    const itemsArray = Object.entries(summaryMap).map(([name, data]) => ({ name, count: data.count }));
    
    if (itemsArray.length === 0) {
        topItemsListEl.innerHTML = '<p style="text-align: center; color: #888;">尚無資料</p>';
        return;
    }

    itemsArray.sort((a, b) => b.count - a.count);
    const top5 = itemsArray.slice(0, 5);
    const maxCount = top5[0].count;

    top5.forEach((item, index) => {
        const percentage = (item.count / maxCount) * 100;
        const li = document.createElement('li');
        li.classList.add('top-item');
        
        let rankClass = '';
        if (index === 0) rankClass = 'rank-1';
        else if (index === 1) rankClass = 'rank-2';
        else if (index === 2) rankClass = 'rank-3';

        li.innerHTML = `
            <div class="top-item-info">
                <span>#${index + 1} ${item.name}</span>
                <span>${item.count} 份</span>
            </div>
            <div class="bar-container">
                <div class="bar-fill ${rankClass}" style="width: ${percentage}%;"></div>
            </div>
        `;
        topItemsListEl.appendChild(li);
    });
}