// Default Template
const DEFAULT_TEMPLATE = `Merhaba {Alıcı Adı},

{Website Adı} üzerinden oluşturduğunuz siparişiniz hakkında bilgilendirme:

Kargo Firması: {Kargo Firması}
Takip Numarası: {Kargo Kodu}
Kargo Takip: {Kargo Takip Linki}

Detayları kontrol etmenizi rica ederiz. İyi günler dileriz.`;

let orders = [];
let sendingStatuses = {};
let selectedOrderId = null;
let statusPollInterval = null;
let profiles = [];
let currentProfile = null;
const SELECTION_SWAP_DELAY_MS = 180;
let selectionHintTimeout = null;

// Orders selected for bulk send (in-memory)
let sendSelectIds = new Set();
let hiddenRestoreSelectIds = new Set();
let waState = 'disconnected'; // WhatsApp bağlantı durumu
let isBulkSending = false; // Toplu gönderim süreci takibi

function isOrderHidden(id) {
    return sendingStatuses[id] && sendingStatuses[id].hidden === true;
}

function profileTemplateKey() {
    return `whatsapp_template_${currentProfile?.id || 'default'}`;
}

function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

// Format source filename meta label (extract date if present like 2026-06-30, or clean name like benimdosyam23)
function formatSourceMetaText(fileName) {
    if (!fileName) return "";
    const str = String(fileName);
    const dateMatch = str.match(/(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) return dateMatch[1];
    return str.replace(/\.[^/.]+$/, "");
}

async function loadProfiles() {
    const response = await fetch('/api/profiles');
    if (!response.ok) throw new Error("Profiller alınamadı.");
    const data = await response.json();
    profiles = data.profiles || [];
    const savedProfileId = localStorage.getItem('active_profile_id');
    currentProfile = profiles.find(profile => profile.id === savedProfileId) || profiles[0] || null;
    renderProfileList();
    updateActiveProfileName();
}

function updateActiveProfileName() {
    const activeEl = document.getElementById('active-profile-name');
    if (activeEl) activeEl.textContent = currentProfile?.name || 'Profil seçin';
    const panelTitleEl = document.getElementById('panel-title');
    if (panelTitleEl) panelTitleEl.textContent = currentProfile ? currentProfile.name : 'Sipariş Paneli';
    document.title = currentProfile ? `${currentProfile.name} Sipariş Bildirim Paneli` : 'Sipariş Bildirim Paneli';
}

function renderProfileList() {
    const list = document.getElementById('profile-list');
    if (!list) return;
    list.innerHTML = profiles.map(profile => `
                <div class="profile-row ${profile.id === currentProfile?.id ? 'active' : ''}" onclick="switchProfile('${escapeHtml(profile.id)}')">
                    <button class="profile-select" onclick="event.stopPropagation(); switchProfile('${escapeHtml(profile.id)}')">${escapeHtml(profile.name)}</button>
                    <button class="profile-delete" onclick="event.stopPropagation(); deleteProfile('${escapeHtml(profile.id)}')" title="Profili listeden kaldır"><i class="fas fa-trash-can"></i></button>
                </div>
            `).join('') || '<div style="color: var(--text-muted); font-size: 0.85rem;">Henüz profil yok.</div>';
}

function openProfileModal() {
    renderProfileList();
    document.getElementById('profile-modal').classList.add('open');
    document.getElementById('new-profile-name').focus();
}

function closeProfileModal(event) {
    if (event && event.target !== event.currentTarget) return;
    document.getElementById('profile-modal').classList.remove('open');
}

async function switchProfile(profileId) {
    const profile = profiles.find(item => item.id === profileId);
    if (!profile || profile.id === currentProfile?.id) {
        closeProfileModal();
        return;
    }
    currentProfile = profile;
    localStorage.setItem('active_profile_id', profile.id);
    selectedOrderId = null;
    sendSelectIds.clear();
    hiddenRestoreSelectIds.clear();
    sendingStatuses = {};
    const textarea = document.getElementById('template-input');
    textarea.value = localStorage.getItem(profileTemplateKey()) || DEFAULT_TEMPLATE;
    autoResize(textarea);
    updateActiveProfileName();
    closeProfileModal();
    await fetchExcelFiles();
    showToast(`${profile.name} profiline geçildi.`, 'success');
}

async function createProfile() {
    const input = document.getElementById('new-profile-name');
    const name = input.value.trim();
    if (!name) return;
    try {
        const response = await fetch('/api/profiles', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || 'Profil oluşturulamadı.');
        input.value = '';
        await loadProfiles();
        await switchProfile(data.profile.id);
    } catch (error) {
        showToast(error.message, 'error');
    }
}

async function deleteProfile(profileId) {
    const profile = profiles.find(item => item.id === profileId);
    if (!profile || !confirm(`${profile.name} profili listeden kaldırılacak. Excel dosyaları silinmeyecek. Devam edilsin mi?`)) return;
    try {
        const response = await fetch(`/api/profiles/${encodeURIComponent(profileId)}`, { method: 'DELETE' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || 'Profil silinemedi.');
        const wasActive = currentProfile?.id === profileId;
        await loadProfiles();
        if (wasActive && currentProfile) {
            localStorage.setItem('active_profile_id', currentProfile.id);
            await fetchExcelFiles();
        }
        if (!currentProfile) {
            orders = [];
            sendingStatuses = {};
            renderOrders();
            updateStats();
        }
        showToast(`${profile.name} profili kaldırıldı.`, 'success');
    } catch (error) {
        showToast(error.message, 'error');
    }
}

function isOrderHidden(id) {
    return sendingStatuses[id] && sendingStatuses[id].hidden === true;
}

async function deleteOrder(id) {
    const order = orders.find(o => o.ID === id);
    try {
        const response = await fetch('/api/hide-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: id, profile: currentProfile.id, order: order })
        });
        if (response.ok) {
            if (!sendingStatuses[id]) sendingStatuses[id] = {};
            sendingStatuses[id].hidden = true;
            sendingStatuses[id].hidden_at = new Date().toISOString();
            if (order) sendingStatuses[id].order_data = order;
            sendSelectIds.delete(id);
            updateSelectedCount();
            renderOrders();
            updateStats();
            showToast("Sipariş gizlendi.", "success");
        }
    } catch (e) {
        showToast("Gizleme hatası: " + e.message, "error");
    }
}

async function restoreOrder(id) {
    try {
        const response = await fetch('/api/restore-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: id, profile: currentProfile.id })
        });
        if (response.ok) {
            if (sendingStatuses[id]) {
                sendingStatuses[id].hidden = false;
                delete sendingStatuses[id].order_data;
            }
            hiddenRestoreSelectIds.delete(id);
            renderOrders();
            updateStats();
            showToast("Sipariş geri getirildi.", "success");
        }
    } catch (e) {
        showToast("Geri getirme hatası: " + e.message, "error");
    }
}

function formatStatusBreakdownText(items, suffixText) {
    let x = 0; // Sorunlu count
    let y = 0; // Sorunlu olmayan count
    items.forEach(o => {
        const status = o ? String(o["Durum"] || "").trim() : "";
        if (status === "Sorunlu" || status.toLowerCase().includes("sorunlu")) {
            x++;
        } else {
            y++;
        }
    });

    if (x > 0 && y > 0) {
        return `Durumu Sorunlu olan ${x} ve Sorunlu olmayan ${y} ${suffixText}`;
    } else if (x > 0) {
        return `Durumu Sorunlu olan ${x} ${suffixText}`;
    } else {
        return `Durumu Sorunlu olmayan ${y} ${suffixText}`;
    }
}

async function restoreAllOrders() {
    const currentFile = document.getElementById("excel-file-select")?.value || "all";

    let allHidden = [];
    for (let id in sendingStatuses) {
        if (sendingStatuses[id] && sendingStatuses[id].hidden === true) {
            if (currentFile !== "all" && !id.startsWith(`${currentProfile?.id || ''}|${currentFile}|`)) {
                continue;
            }
            let o = orders.find(ord => ord.ID === id) || sendingStatuses[id].order_data || { ID: id, "Durum": "Diğer" };
            allHidden.push(o);
        }
    }

    if (allHidden.length === 0) {
        showToast("Geri getirilecek gizli sipariş bulunamadı.", "info");
        return;
    }

    const confirmMsg = formatStatusBreakdownText(allHidden, "adet gizlenen sipariş geri getirilecek. Devam edilsin mi?");
    if (!confirm(confirmMsg)) return;

    try {
        const response = await fetch('/api/restore-all-orders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file: currentFile, profile: currentProfile.id })
        });
        if (response.ok) {
            hiddenRestoreSelectIds.clear();
            for (let id in sendingStatuses) {
                if (sendingStatuses[id].hidden) {
                    if (currentFile !== "all" && !id.startsWith(`${currentProfile.id}|${currentFile}|`)) {
                        continue;
                    }
                    sendingStatuses[id].hidden = false;
                    delete sendingStatuses[id].order_data;
                }
            }
            renderOrders();
            updateStats();
            showToast(currentFile === "all" ? `${allHidden.length} adet gizlenen sipariş geri getirildi.` : `Seçili günün ${allHidden.length} adet gizlenen siparişi geri getirildi.`, "success");
        }
    } catch (e) {
        showToast("Geri getirme hatası: " + e.message, "error");
    }
}

function renderHiddenOrders(gridContainer) {
    // gridContainer can be passed directly (from renderOrders) or looked up
    const container = gridContainer || document.getElementById("orders-container");
    if (!container) return;

    // Remove any existing hidden section first
    const existing = container.querySelector(".hidden-orders-section");
    if (existing) existing.remove();

    const currentFile = document.getElementById("excel-file-select")?.value || "all";
    const searchVal = document.getElementById("search-input")?.value.toLowerCase() || "";
    const problematicOnly = document.getElementById("filter-problematic-only")?.checked || false;

    // Build hidden list from sendingStatuses
    let hiddenList = [];
    for (let id in sendingStatuses) {
        if (sendingStatuses[id] && sendingStatuses[id].hidden === true) {
            let o = sendingStatuses[id].order_data;
            if (!o) {
                o = {
                    ID: id,
                    "Alıcı Adı": "Gizlenen Sipariş",
                    "Alıcı Telefon": "",
                    "Sipariş No": id.split('|')[2] || "",
                    "Kaynak Dosya": id.split('|')[1] || "",
                    "Durum": "Sorunlu",
                    "Ürün Adı": "Bilinmeyen Ürün",
                    "Kargo Firması": "Bilinmeyen"
                };
            }
            hiddenList.push(o);
        }
    }

    // Filter by current day/file
    if (currentFile !== "all") {
        hiddenList = hiddenList.filter(o => o.ID.startsWith(`${currentProfile.id}|${currentFile}|`) || o["Kaynak Dosya"] === currentFile);
    }

    // Filter by search query
    if (searchVal) {
        hiddenList = hiddenList.filter(o => {
            const nameMatch = (o["Alıcı Adı"] || "").toLowerCase().includes(searchVal);
            const phoneMatch = (o["Alıcı Telefon"] || "").toString().includes(searchVal);
            const idMatch = (o["ID"] || "").toLowerCase().includes(searchVal);
            const orderNoMatch = (o["Sipariş No"] || "").toString().includes(searchVal);
            return nameMatch || phoneMatch || idMatch || orderNoMatch;
        });
    }

    // Filter by problematic state
    if (problematicOnly) {
        hiddenList = hiddenList.filter(o => o["Durum"] === "Sorunlu");
    }

    const notSentOnly = document.getElementById("filter-not-sent-only")?.checked || false;
    if (notSentOnly) {
        hiddenList = hiddenList.filter(o => sendingStatuses[o.ID]?.status !== "sent");
    }

    // Sort hidden list
    const savedHiddenSort = getSavedHiddenSortPref();
    const sortedHiddenList = sortHiddenOrdersList(hiddenList);

    const visibleHiddenIds = new Set(sortedHiddenList.map(o => o.ID));
    hiddenRestoreSelectIds = new Set(
        [...hiddenRestoreSelectIds].filter(id => visibleHiddenIds.has(id))
    );
    if (sortedHiddenList.length === 0) return;

    // Build restore button label based on current selection
    const restoreDateMatch = currentFile !== "all" ? currentFile.match(/(\d{4}-\d{2}-\d{2})/) : null;
    const restoreLabel = restoreDateMatch
        ? `<i class="fas fa-rotate-left"></i> ${restoreDateMatch[1]} Tarihindeki Tüm Gizlenenleri Geri Getir`
        : `<i class="fas fa-rotate-left"></i> Tüm Gizlenen Siparişleri Geri Getir`;

    const section = document.createElement("div");
    section.className = "hidden-orders-section";

    section.innerHTML = `
                <div style="border-top: 1px solid rgba(255,255,255,0.12); margin-top:1rem; padding-top:1rem;">
                    <button id="hidden-orders-toggle" onclick="toggleHiddenSection()" style="width:100%; display:flex; align-items:center; justify-content:space-between; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:0.7rem 1rem; cursor:pointer; font-family:var(--font-family); color:var(--text-muted); font-size:14px; font-weight:700; letter-spacing:0.4px; transition:all 0.2s; margin-bottom:0;">
                        <span><i class="fas fa-eye-slash" style="margin-right:0.4rem; color:var(--accent-red);"></i>Gizlenen Siparişler Panelini Göster (${sortedHiddenList.length} müşteri)</span>
                        <i class="fas fa-chevron-down" id="hidden-orders-chevron" style="transition:transform 0.25s;"></i>
                    </button>
                    <div id="hidden-orders-body" style="display:none; padding-top:0.75rem;">
                        <div style="display:flex; justify-content:space-between; align-items:center; gap:0.75rem; margin-bottom:0.75rem; flex-wrap:wrap;">
                            <div class="sort-wrapper" style="padding:0.4rem 0.75rem;">
                                <i class="fas fa-arrow-up-wide-short" style="color:var(--text-muted); font-size:0.85rem;"></i>
                                <select id="hidden-sort-select" class="sort-select" onchange="saveHiddenSortPref(); renderOrders()">
                                    <option value="hidden-at-desc" ${savedHiddenSort === 'hidden-at-desc' ? 'selected' : ''}>Son Gizlenen En Üstte</option>
                                    <option value="hidden-at-asc" ${savedHiddenSort === 'hidden-at-asc' ? 'selected' : ''}>İlk Gizlenen En Üstte</option>
                                    <option value="date-desc" ${savedHiddenSort === 'date-desc' ? 'selected' : ''}>Tarih ↓ (Yeniden Eskiye)</option>
                                    <option value="date-asc" ${savedHiddenSort === 'date-asc' ? 'selected' : ''}>Tarih ↑ (Eskiden Yeniye)</option>
                                    <option value="name-asc" ${savedHiddenSort === 'name-asc' ? 'selected' : ''}>İsim A→Z</option>
                                    <option value="name-desc" ${savedHiddenSort === 'name-desc' ? 'selected' : ''}>İsim Z→A</option>
                                    <option value="status" ${savedHiddenSort === 'status' ? 'selected' : ''}>Duruma Göre</option>
                                    <option value="cargo" ${savedHiddenSort === 'cargo' ? 'selected' : ''}>Kargo Firmasına Göre</option>
                                    <option value="order-no-asc" ${savedHiddenSort === 'order-no-asc' ? 'selected' : ''}>Sipariş No ↑</option>
                                    <option value="order-no-desc" ${savedHiddenSort === 'order-no-desc' ? 'selected' : ''}>Sipariş No ↓</option>
                                </select>
                            </div>
                            <div style="display:flex; align-items:center; gap:0.75rem; flex-wrap:wrap;">
                                <button id="btn-restore-selected-hidden" class="bulk-btn bulk-btn-restore-hidden" onclick="restoreSelectedHiddenOrders()" style="display: ${hiddenRestoreSelectIds.size ? 'inline-flex' : 'none'};">
                                    <i class="fas fa-eye"></i>
                                    Seçilen Müşterileri Geri Getir&nbsp;<span id="hidden-selected-count">${hiddenRestoreSelectIds.size} / ${sortedHiddenList.length}</span>
                                </button>
                                <button class="bulk-btn bulk-btn-restore-all" onclick="restoreAllOrders()">
                                    ${restoreLabel}
                                </button>
                            </div>
                        </div>
                        <div style="display:flex; flex-direction:column; gap:0.75rem;">
                            ${sortedHiddenList.map(o => {
        const durumClass = o["Durum"] === "Sorunlu" ? "status-sorunlu" : "status-tamamlandi";
        const badgeClass = o["Durum"] === "Sorunlu" ? "badge-sorunlu" : (o["Durum"] === "Tamamlandı" ? "badge-tamamlandi" : "badge-other");
        const isHiddenSelected = hiddenRestoreSelectIds.has(o.ID);
        const hiddenCbChecked = isHiddenSelected ? "checked" : "";
        const hiddenCbIcon = isHiddenSelected ? '<i class="fas fa-check"></i>' : '';
        return `
                                    <div class="order-card ${durumClass} ${isHiddenSelected ? 'send-selected' : ''}" style="opacity:0.75; filter:grayscale(0.35); border-style:dashed; cursor:pointer;" id="card-hidden-${o.ID}" onclick="toggleHiddenRestoreSelect('${o.ID}')">
                                        <div class="card-select-wrap" onclick="event.stopPropagation(); toggleHiddenRestoreSelect('${o.ID}')" title="Geri getirmek için seç">
                                            <div class="card-select-cb ${hiddenCbChecked}" id="hidden-scb-${o.ID}">${hiddenCbIcon}</div>
                                        </div>
                                        <div class="order-info">
                                            <div class="info-block">
                                                <span class="info-label">Müşteri</span>
                                                <span class="info-val" style="font-weight:700;">${o["Alıcı Adı"]}</span>
                                                <span class="info-val subtle">${o["Alıcı Telefon"]}</span>
                                            </div>
                                            <div class="info-block">
                                                <span class="info-label">Sipariş No / ID</span>
                                                <span class="info-val">#${o["Sipariş No"] || o["Sipari No"]}</span>
                                                <span class="info-val source-meta" title="Kaynak Dosya: ${o["Kaynak Dosya"]}">${formatSourceMetaText(o["Kaynak Dosya"] || o.ID.split('|')[1])}</span>
                                            </div>
                                            <div class="info-block">
                                                <span class="info-label">Ürün</span>
                                                <span class="info-val" title="${o["Ürün Adı"] || ''}">${o["Ürün Adı"] || 'Bilinmeyen'}</span>
                                                <span class="info-val subtle">${o["Kargo Firması"] || ''} (${o["Kargo Kodu"] || 'Kod Yok'})</span>
                                            </div>
                                            <div class="info-block">
                                                <span class="info-label">Durum / WP</span>
                                                <span class="badge ${badgeClass}">${o["Durum"] || 'Bilinmiyor'}</span>
                                                <span class="sending-status-container" id="status-text-${o.ID}">${getStatusDropdownHtml(o.ID)}</span>
                                            </div>
                                        </div>
                                        <div class="order-actions" onclick="event.stopPropagation()">
                                            <button class="action-btn" onclick="restoreOrder('${o.ID}')" title="Geri getir" style="color:var(--primary); background:rgba(37,211,102,0.08); border-color:rgba(37,211,102,0.2);">
                                                <i class="fas fa-eye"></i>
                                            </button>
                                        </div>
                                    </div>
                                `;
    }).join("")}
                        </div>
                    </div>
                </div>
            `;
    container.appendChild(section);

}

// Track whether the hidden orders section is expanded
let hiddenSectionOpen = false;

function toggleHiddenSection() {
    hiddenSectionOpen = !hiddenSectionOpen;
    const body = document.getElementById("hidden-orders-body");
    const chevron = document.getElementById("hidden-orders-chevron");
    const toggle = document.getElementById("hidden-orders-toggle");
    if (!body) return;
    if (hiddenSectionOpen) {
        body.style.display = "block";
        if (chevron) chevron.style.transform = "rotate(180deg)";
        if (toggle) {
            const countSpan = toggle.querySelector("span");
            if (countSpan) {
                const m = countSpan.textContent.match(/\((\d+)/);
                const n = m ? m[1] : "";
                countSpan.innerHTML = `<i class="fas fa-eye-slash" style="margin-right:0.4rem; color:var(--accent-red);"></i>Gizlenen Siparişler Panelini Gizle${n ? " (" + n + " müşteri)" : ""}`;
            }
        }
    } else {
        body.style.display = "none";
        if (chevron) chevron.style.transform = "rotate(0deg)";
        if (toggle) {
            const countSpan = toggle.querySelector("span");
            if (countSpan) {
                const m = countSpan.textContent.match(/\((\d+)/);
                const n = m ? m[1] : "";
                countSpan.innerHTML = `<i class="fas fa-eye-slash" style="margin-right:0.4rem; color:var(--accent-red);"></i>Gizlenen Siparişler Panelini Göster${n ? " (" + n + " müşteri)" : ""}`;
            }
        }
    }
}

function toggleSendSelect(id) {

    if (sendSelectIds.has(id)) {
        sendSelectIds.delete(id);
    } else {
        sendSelectIds.add(id);
    }
    // Update only the checkbox element, not full re-render
    const cb = document.getElementById(`scb-${id}`);
    const card = document.getElementById(`card-${id}`);
    if (cb) cb.classList.toggle("checked", sendSelectIds.has(id));
    if (cb) cb.innerHTML = sendSelectIds.has(id) ? '<i class="fas fa-check"></i>' : '';
    if (card) card.classList.toggle("send-selected", sendSelectIds.has(id));
    updateSelectedCount();
}

function getVisibleOrdersCount() {
    const searchVal = (document.getElementById("search-input")?.value || "").toLowerCase();
    const problematicOnly = document.getElementById("filter-problematic-only")?.checked;
    const notSentOnly = document.getElementById("filter-not-sent-only")?.checked;
    return orders.filter(o => {
        if (isOrderHidden(o.ID)) return false;
        const nameMatch = (o["Alıcı Adı"] || "").toLowerCase().includes(searchVal);
        const phoneMatch = (o["Alıcı Telefon"] || "").toString().includes(searchVal);
        const idMatch = (o["ID"] || "").toLowerCase().includes(searchVal);
        const orderNoMatch = (o["Sipariş No"] || "").toString().includes(searchVal);
        const matchesSearch = nameMatch || phoneMatch || idMatch || orderNoMatch;
        if (!matchesSearch) return false;
        if (problematicOnly && o["Durum"] !== "Sorunlu") return false;
        if (notSentOnly && sendingStatuses[o.ID]?.status === "sent") return false;
        return true;
    }).length;
}

function updateSelectedCount() {
    const count = sendSelectIds.size;
    const totalVisible = getVisibleOrdersCount();

    const hint = document.getElementById("selection-hint");
    const selActions = document.getElementById("selection-actions");
    const countEl = document.getElementById("selected-count");
    const totalEl = document.getElementById("selection-counter-total");

    if (selectionHintTimeout) {
        clearTimeout(selectionHintTimeout);
        selectionHintTimeout = null;
    }

    if (countEl) {
        countEl.textContent = count;
    }
    if (totalEl) {
        totalEl.textContent = totalVisible > 0 ? ` / ${totalVisible}` : '';
    }

    if (count > 0) {
        if (hint) {
            hint.classList.remove("selection-fade-visible");
            hint.classList.add("selection-fade-hidden");
        }

        if (selActions) {
            selActions.classList.remove("selection-fade-hidden");
            selActions.classList.add("selection-fade-visible");
        }

        return;
    }

    if (selActions) {
        selActions.classList.remove("selection-fade-visible");
        selActions.classList.add("selection-fade-hidden");
    }

    if (!hint) return;

    hint.classList.remove("selection-fade-visible");
    hint.classList.add("selection-fade-hidden");

    selectionHintTimeout = window.setTimeout(() => {
        selectionHintTimeout = null;
        if (sendSelectIds.size !== 0) return;
        hint.classList.remove("selection-fade-hidden");
        hint.classList.add("selection-fade-visible");
    }, SELECTION_SWAP_DELAY_MS);
}

function toggleHiddenRestoreSelect(id) {
    if (hiddenRestoreSelectIds.has(id)) {
        hiddenRestoreSelectIds.delete(id);
    } else {
        hiddenRestoreSelectIds.add(id);
    }

    const cb = document.getElementById(`hidden-scb-${id}`);
    const card = document.getElementById(`card-hidden-${id}`);
    const isSelected = hiddenRestoreSelectIds.has(id);

    if (cb) cb.classList.toggle("checked", isSelected);
    if (cb) cb.innerHTML = isSelected ? '<i class="fas fa-check"></i>' : '';
    if (card) card.classList.toggle("send-selected", isSelected);

    updateHiddenSelectedCount();
}

function getVisibleHiddenOrdersCount() {
    const currentFile = document.getElementById("excel-file-select")?.value || "all";
    const searchVal = (document.getElementById("search-input")?.value || "").toLowerCase();
    const problematicOnly = document.getElementById("filter-problematic-only")?.checked || false;

    let hiddenList = [];
    for (let id in sendingStatuses) {
        if (sendingStatuses[id] && sendingStatuses[id].hidden === true) {
            let o = orders.find(ord => ord.ID === id) || sendingStatuses[id].order_data || {
                ID: id,
                "Alıcı Adı": "Gizlenen Sipariş",
                "Alıcı Telefon": "",
                "Sipariş No": id.split('|')[2] || "",
                "Kaynak Dosya": id.split('|')[1] || "",
                "Durum": "Diğer"
            };
            hiddenList.push(o);
        }
    }

    if (currentFile !== "all") {
        hiddenList = hiddenList.filter(o => o.ID.startsWith(`${currentProfile?.id || ''}|${currentFile}|`) || o["Kaynak Dosya"] === currentFile);
    }
    if (searchVal) {
        hiddenList = hiddenList.filter(o => {
            const nameMatch = (o["Alıcı Adı"] || "").toLowerCase().includes(searchVal);
            const phoneMatch = (o["Alıcı Telefon"] || "").toString().includes(searchVal);
            const idMatch = (o["ID"] || "").toLowerCase().includes(searchVal);
            const orderNoMatch = (o["Sipariş No"] || "").toString().includes(searchVal);
            return nameMatch || phoneMatch || idMatch || orderNoMatch;
        });
    }
    if (problematicOnly) {
        hiddenList = hiddenList.filter(o => o["Durum"] === "Sorunlu");
    }
    const notSentOnly = document.getElementById("filter-not-sent-only")?.checked || false;
    if (notSentOnly) {
        hiddenList = hiddenList.filter(o => sendingStatuses[o.ID]?.status !== "sent");
    }
    return hiddenList.length;
}

function updateHiddenSelectedCount() {
    const count = hiddenRestoreSelectIds.size;
    const totalVisibleHidden = getVisibleHiddenOrdersCount();
    const countEl = document.getElementById("hidden-selected-count");
    const restoreBtn = document.getElementById("btn-restore-selected-hidden");

    if (countEl) {
        countEl.textContent = `${count} / ${totalVisibleHidden}`;
    }
    if (restoreBtn) {
        if (count === 0) {
            restoreBtn.style.display = "none";
        } else {
            restoreBtn.style.display = "inline-flex";
        }
    }
}

function saveHiddenSortPref() {
    const sortVal = document.getElementById("hidden-sort-select")?.value || "hidden-at-desc";
    localStorage.setItem("pref_hidden_sort_order", sortVal);
}

function getSavedHiddenSortPref() {
    return localStorage.getItem("pref_hidden_sort_order") || "hidden-at-desc";
}

function sortHiddenOrdersList(list) {
    const sortVal = document.getElementById("hidden-sort-select")?.value || getSavedHiddenSortPref();
    const copy = [...list];
    copy.sort((a, b) => {
        if (sortVal === "hidden-at-desc") {
            const ha = sendingStatuses[a.ID]?.hidden_at || "";
            const hb = sendingStatuses[b.ID]?.hidden_at || "";
            if (ha > hb) return -1;
            if (ha < hb) return 1;
            return 0;
        } else if (sortVal === "hidden-at-asc") {
            const ha = sendingStatuses[a.ID]?.hidden_at || "";
            const hb = sendingStatuses[b.ID]?.hidden_at || "";
            if (ha < hb) return -1;
            if (ha > hb) return 1;
            return 0;
        } else if (sortVal === "date-desc") {
            const da = getOrderDateValue(a);
            const db = getOrderDateValue(b);
            return db.localeCompare(da, 'tr');
        } else if (sortVal === "date-asc") {
            const da = getOrderDateValue(a);
            const db = getOrderDateValue(b);
            return da.localeCompare(db, 'tr');
        } else if (sortVal === "name-asc") {
            const na = (a["Alıcı Adı"] || "").toString();
            const nb = (b["Alıcı Adı"] || "").toString();
            return na.localeCompare(nb, 'tr');
        } else if (sortVal === "name-desc") {
            const na = (a["Alıcı Adı"] || "").toString();
            const nb = (b["Alıcı Adı"] || "").toString();
            return nb.localeCompare(na, 'tr');
        } else if (sortVal === "status") {
            const sa = (a["Durum"] || "").toString();
            const sb = (b["Durum"] || "").toString();
            if (sa === "Sorunlu" && sb !== "Sorunlu") return -1;
            if (sb === "Sorunlu" && sa !== "Sorunlu") return 1;
            return sa.localeCompare(sb, 'tr');
        } else if (sortVal === "cargo") {
            const ca = (a["Kargo Firması"] || "").toString();
            const cb = (b["Kargo Firması"] || "").toString();
            return ca.localeCompare(cb, 'tr');
        } else if (sortVal === "order-no-asc") {
            const oa = (a["Sipariş No"] || a["Sipari No"] || "").toString();
            const ob = (b["Sipariş No"] || b["Sipari No"] || "").toString();
            return oa.localeCompare(ob, 'tr', { numeric: true });
        } else if (sortVal === "order-no-desc") {
            const oa = (a["Sipariş No"] || a["Sipari No"] || "").toString();
            const ob = (b["Sipariş No"] || b["Sipari No"] || "").toString();
            return ob.localeCompare(oa, 'tr', { numeric: true });
        }
        return 0;
    });
    return copy;
}



async function restoreSelectedHiddenOrders() {
    const ids = [...hiddenRestoreSelectIds];
    if (ids.length === 0) {
        showToast("Geri getirilecek gizli sipariş seçilmedi.", "info");
        return;
    }

    const hiddenItems = ids.map(id => orders.find(o => o.ID === id) || sendingStatuses[id]?.order_data).filter(Boolean);
    const confirmMsg = formatStatusBreakdownText(hiddenItems, "adet gizlenen sipariş geri getirilecek. Devam edilsin mi?");
    if (!confirm(confirmMsg)) return;

    let restoredCount = 0;
    for (const id of ids) {
        try {
            const response = await fetch('/api/restore-order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, profile: currentProfile.id })
            });

            if (response.ok) {
                if (sendingStatuses[id]) {
                    sendingStatuses[id].hidden = false;
                    delete sendingStatuses[id].order_data;
                }
                hiddenRestoreSelectIds.delete(id);
                restoredCount++;
            }
        } catch (e) { /* ignore individual errors */ }
    }

    updateHiddenSelectedCount();
    renderOrders();
    updateStats();

    if (restoredCount === 0) {
        showToast("Seçili gizli siparişler geri getirilemedi.", "error");
        return;
    }

    showToast(`${restoredCount} gizli sipariş geri getirildi.`, "success");
}

async function hideSentOrders() {
    const sentOrders = orders.filter(o => !isOrderHidden(o.ID) && sendingStatuses[o.ID]?.status === 'sent');
    if (sentOrders.length === 0) {
        showToast("Gönderilmiş sipariş bulunamadı.", "info");
        return;
    }

    const confirmMsg = formatStatusBreakdownText(sentOrders, "mesaj gönderilmiş müşteri listeden gizlenecek. Devam edilsin mi?");
    if (!confirm(confirmMsg)) return;

    for (const order of sentOrders) {
        const id = order.ID;
        try {
            const res = await fetch('/api/hide-order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, profile: currentProfile.id, order: order || null })
            });
            if (res.ok) {
                if (!sendingStatuses[id]) sendingStatuses[id] = {};
                sendingStatuses[id].hidden = true;
                sendingStatuses[id].hidden_at = new Date().toISOString();
                if (order) sendingStatuses[id].order_data = order;
            }
        } catch (e) { /* ignore individual errors */ }
    }
    sendSelectIds.clear();
    updateSelectedCount();
    renderOrders();
    updateStats();
    showToast(`${sentOrders.length} gönderilmiş sipariş gizlendi.`, "success");
}

async function hideSelectedOrders() {
    const ids = [...sendSelectIds];
    if (ids.length === 0) {
        showToast("Hiçbir sipariş seçili değil.", "info");
        return;
    }
    if (!confirm(`${ids.length} seçili sipariş gizlenecek. Devam edilsin mi?`)) return;
    for (const id of ids) {
        const order = orders.find(o => o.ID === id);
        try {
            const res = await fetch('/api/hide-order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, profile: currentProfile.id, order: order || null })
            });
            if (res.ok) {
                if (!sendingStatuses[id]) sendingStatuses[id] = {};
                sendingStatuses[id].hidden = true;
                sendingStatuses[id].hidden_at = new Date().toISOString();
                if (order) sendingStatuses[id].order_data = order;
            }
        } catch (e) { /* ignore individual errors */ }
    }
    sendSelectIds.clear();
    updateSelectedCount();
    renderOrders();
    updateStats();
    showToast(`${ids.length} sipariş gizlendi.`, "success");
}

async function hideSingleOrder(id) {
    const order = orders.find(o => o.ID === id);
    try {
        const res = await fetch('/api/hide-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, profile: currentProfile.id, order: order || null })
        });
        if (res.ok) {
            if (!sendingStatuses[id]) sendingStatuses[id] = {};
            sendingStatuses[id].hidden = true;
            sendingStatuses[id].hidden_at = new Date().toISOString();
            if (order) sendingStatuses[id].order_data = order;
            renderOrders();
            updateStats();
        }
    } catch (e) { /* ignore individual error */ }
}

function showBulkProgress(current, total) {
    const badge = document.getElementById("bulk-progress-badge");
    const text = document.getElementById("bulk-progress-text");
    if (!badge || !text) return;
    text.textContent = `Oto Gönderim: ${current} / ${total}`;
    badge.style.display = "inline-flex";
}

function hideBulkProgress() {
    const badge = document.getElementById("bulk-progress-badge");
    if (badge) badge.style.display = "none";
}

async function sendToSelected() {
    const toSend = [...sendSelectIds].map(id => orders.find(o => o.ID === id)).filter(Boolean);
    if (toSend.length === 0) {
        alert("Seçili sipariş bulunamadı.");
        return;
    }
    const confirmMsg = formatStatusBreakdownText(toSend, "mesaj gönderilmemiş müşteriye otomatik mesaj gönderilecek. Devam edilsin mi?");
    if (!confirm(confirmMsg)) return;

    showToast("Seçilen müşterilere otomatik mesaj gönderimi başlatıldı.", "success");

    isBulkSending = true;
    toSend.forEach(o => queuedOrderIds.add(o.ID));
    updateStatusIndicators();
    showBulkProgress(0, toSend.length);

    try {
        for (let i = 0; i < toSend.length; i++) {
            showBulkProgress(i + 1, toSend.length);
            const order = toSend[i];
            queuedOrderIds.delete(order.ID); // Sırası gelen sipariş kuyruktan çıkarılır
            selectOrder(order.ID);
            await sendAuto(order.ID);

            let completed = false;
            while (!completed) {
                await new Promise(r => setTimeout(r, 2000));
                await fetchSendingStatuses();
                const state = sendingStatuses[order.ID];
                if (state && (state.status === "sent" || state.status === "failed")) {
                    completed = true;
                    if (state.status === "sent" && isAutoHideSentEnabled()) {
                        await hideSingleOrder(order.ID);
                    }
                }
            }
            await new Promise(r => setTimeout(r, 3000));
        }
        showToast("Seçilen müşterilere otomatik mesaj gönderimi tamamlandı.", "success");
    } finally {
        isBulkSending = false;
        queuedOrderIds.clear();
        updateStatusIndicators();
        hideBulkProgress();
    }
}

// Load data on page load
document.addEventListener("DOMContentLoaded", async () => {
    // Load saved template from localStorage or use default
    try {
        await loadProfiles();
    } catch (error) {
        showToast(error.message, "error");
        return;
    }
    const savedTemplate = localStorage.getItem(profileTemplateKey());
    const ta = document.getElementById("template-input");
    ta.value = savedTemplate || DEFAULT_TEMPLATE;
    // Resize after fonts are loaded so measurement is accurate
    document.fonts.ready.then(() => autoResize(ta));

    // Filtre tercihlerini yükle (varsayılan: her ikisi de işaretli)
    loadFilterPrefs();

    // First load excel file list
    if (currentProfile) await fetchExcelFiles();

    // Poll sending status every 2 seconds
    statusPollInterval = setInterval(fetchSendingStatuses, 2000);

    // Poll WhatsApp connection status every 4 seconds
    fetchWAStatus();
    setInterval(fetchWAStatus, 4000);
});

// ── Filtre & Sıralama tercihleri ─────────────────────────────────────────────

function saveFilterPrefs() {
    const autoHide = document.getElementById('auto-hide-sent')?.checked ?? true;
    const notSentOnly = document.getElementById('filter-not-sent-only')?.checked ?? false;
    const probOnly = document.getElementById('filter-problematic-only')?.checked ?? false;
    localStorage.setItem('pref_auto_hide_sent', autoHide ? '1' : '0');
    localStorage.setItem('pref_filter_not_sent_only', notSentOnly ? '1' : '0');
    localStorage.setItem('pref_filter_problematic_only', probOnly ? '1' : '0');
}

function saveSortPref() {
    const sortVal = document.getElementById("sort-select")?.value || "default";
    localStorage.setItem("pref_sort_order", sortVal);
}

function loadFilterPrefs() {
    const autoHideVal = localStorage.getItem('pref_auto_hide_sent') ?? '1';
    const notSentOnlyVal = localStorage.getItem('pref_filter_not_sent_only') ?? '0';
    const probOnlyVal = localStorage.getItem('pref_filter_problematic_only') ?? '0';

    const autoHideEl = document.getElementById('auto-hide-sent');
    const notSentOnlyEl = document.getElementById('filter-not-sent-only');
    const probOnlyEl = document.getElementById('filter-problematic-only');

    if (autoHideEl) autoHideEl.checked = autoHideVal === '1';
    if (notSentOnlyEl) notSentOnlyEl.checked = notSentOnlyVal === '1';
    if (probOnlyEl) probOnlyEl.checked = probOnlyVal === '1';

    loadSortPref();
}

function loadSortPref() {
    const savedSort = localStorage.getItem("pref_sort_order") || "default";
    const sortEl = document.getElementById("sort-select");
    if (sortEl) sortEl.value = savedSort;
}

function isAutoHideSentEnabled() {
    return document.getElementById('auto-hide-sent')?.checked ?? true;
}

// ── Sıralama Mantığı ─────────────────────────────────────────────────────────

function getOrderDateValue(o) {
    const keys = Object.keys(o);
    const dateKey = keys.find(k => {
        const lower = k.toLowerCase();
        return lower.includes('tarih') || lower.includes('date') || lower.includes('zaman');
    });
    if (dateKey && o[dateKey]) {
        const val = String(o[dateKey]).trim();
        if (val) return val;
    }
    const srcFile = o["Kaynak Dosya"] || "";
    const match = srcFile.match(/(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : "";
}

function sortOrdersList(list) {
    const sortVal = document.getElementById("sort-select")?.value || "default";
    if (sortVal === "default") return list;

    const copy = [...list];
    copy.sort((a, b) => {
        if (sortVal === "date-desc") {
            const da = getOrderDateValue(a);
            const db = getOrderDateValue(b);
            return db.localeCompare(da, 'tr');
        } else if (sortVal === "date-asc") {
            const da = getOrderDateValue(a);
            const db = getOrderDateValue(b);
            return da.localeCompare(db, 'tr');
        } else if (sortVal === "name-asc") {
            const na = (a["Alıcı Adı"] || "").toString();
            const nb = (b["Alıcı Adı"] || "").toString();
            return na.localeCompare(nb, 'tr');
        } else if (sortVal === "name-desc") {
            const na = (a["Alıcı Adı"] || "").toString();
            const nb = (b["Alıcı Adı"] || "").toString();
            return nb.localeCompare(na, 'tr');
        } else if (sortVal === "status") {
            const sa = (a["Durum"] || "").toString();
            const sb = (b["Durum"] || "").toString();
            if (sa === "Sorunlu" && sb !== "Sorunlu") return -1;
            if (sb === "Sorunlu" && sa !== "Sorunlu") return 1;
            return sa.localeCompare(sb, 'tr');
        } else if (sortVal === "cargo") {
            const ca = (a["Kargo Firması"] || "").toString();
            const cb = (b["Kargo Firması"] || "").toString();
            return ca.localeCompare(cb, 'tr');
        } else if (sortVal === "order-no-asc") {
            const oa = (a["Sipariş No"] || a["Sipari No"] || "").toString();
            const ob = (b["Sipariş No"] || b["Sipari No"] || "").toString();
            return oa.localeCompare(ob, 'tr', { numeric: true });
        } else if (sortVal === "order-no-desc") {
            const oa = (a["Sipariş No"] || a["Sipari No"] || "").toString();
            const ob = (b["Sipariş No"] || b["Sipari No"] || "").toString();
            return ob.localeCompare(oa, 'tr', { numeric: true });
        }
        return 0;
    });
    return copy;
}

async function fetchExcelFiles() {
    try {
        if (!currentProfile) return;
        const response = await fetch(`/api/excel-files?profile=${encodeURIComponent(currentProfile.id)}`);
        if (!response.ok) throw new Error("Excel dosyaları alınamadı.");
        const data = await response.json();
        const select = document.getElementById("excel-file-select");

        if (data.files && data.files.length > 0) {
            const currentVal = select.value || "all";

            let optionsHtml = `<option value="all" style="background: var(--bg-surface);">Tümü</option>`;
            optionsHtml += data.files.map(f => {
                const dateMatch = f.match(/(\d{4}-\d{2}-\d{2})/);
                const label = dateMatch ? dateMatch[1] : f;
                return `<option value="${f}" style="background: var(--bg-surface);">${label}</option>`;
            }).join('');

            select.innerHTML = optionsHtml;

            // Restore previous selection if it still exists, otherwise use 'all'
            if (currentVal === "all" || data.files.includes(currentVal)) {
                select.value = currentVal;
            } else {
                select.value = "all";
            }

            await fetchOrders(select.value);
            updateResetButtonText();
        } else {
            select.innerHTML = `<option value="all" style="background: var(--bg-surface);">Tümü</option>`;
            orders = [];
            sendingStatuses = {};
            selectedOrderId = null;
            renderOrders();
            renderPlaceholders();
            updateStats();
        }
    } catch (err) {
        console.error(err);
        showToast("Excel dosyaları listelenemedi: " + err.message, "error");
    }
}

async function loadSelectedExcel() {
    const select = document.getElementById("excel-file-select");
    if (select.value) {
        selectedOrderId = null; // Clear selected preview
        showEmptyPreview();
        await fetchOrders(select.value);
        updateResetButtonText();
    }
}

async function refreshData() {
    await fetchExcelFiles();
}

async function openExcelManagerModal() {
    const modal = document.getElementById("excel-manager-modal");
    if (modal) {
        modal.classList.add("open");
        await renderExcelManagerList();
    }
}

function closeExcelManagerModal(event) {
    if (event && event.target !== event.currentTarget) return;
    const modal = document.getElementById("excel-manager-modal");
    if (modal) {
        modal.classList.remove("open");
    }
}

async function renderExcelManagerList() {
    const listEl = document.getElementById("excel-files-modal-list");
    if (!listEl || !currentProfile) return;

    listEl.classList.add('centered-state');
    listEl.innerHTML = `<div style="display:flex; align-items:center; justify-content:center; height:100%; width:100%; color:var(--text-muted);"><i class="fas fa-spinner fa-spin" style="margin-right:0.6rem;"></i> Dosyalar yükleniyor...</div>`;

    try {
        const response = await fetch(`/api/excel-files?profile=${encodeURIComponent(currentProfile.id)}`);
        if (!response.ok) throw new Error("Excel dosyaları alınamadı.");
        const data = await response.json();
        const files = data.files || [];

        if (files.length === 0) {
            listEl.classList.add('centered-state');
            listEl.innerHTML = `
                <div style="color:var(--text-muted); font-size:0.9rem;">
                    <i class="fas fa-folder-open" style="font-size:1.8rem; margin-bottom:0.5rem; display:block;"></i>
                    Sistemde yüklü Excel dosyası bulunmuyor.
                </div>
            `;
            return;
        }

        listEl.classList.remove('centered-state');
        listEl.innerHTML = files.map(f => {
            const dateMatch = f.match(/(\d{4}-\d{2}-\d{2})/);
            const dateLabel = dateMatch ? dateMatch[1] : null;
            return `
                <div class="profile-row" style="justify-content:space-between; padding:0.75rem 1rem;">
                    <div style="display:flex; align-items:center; gap:0.75rem; min-width:0;">
                        <i class="fas fa-file-excel" style="color:var(--primary); font-size:1.2rem; flex-shrink:0;"></i>
                        <div style="min-width:0;">
                            <div style="font-weight:700; font-size:0.9rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${f}">${f}</div>
                            ${dateLabel ? `<span style="font-size:0.75rem; color:var(--accent-blue); font-weight:600;"><i class="fas fa-calendar-day" style="font-size:0.7rem;"></i> ${dateLabel}</span>` : ''}
                        </div>
                    </div>
                    <button class="profile-delete" onclick="deleteExcelFileFromModal('${f}')" title="Dosyayı Sil" style="color:var(--accent-red); padding:0.4rem 0.6rem; border-radius:8px; background:rgba(255,82,82,0.1); border:1px solid rgba(255,82,82,0.25); cursor:pointer;">
                        <i class="fas fa-trash-can"></i>
                    </button>
                </div>
            `;
        }).join('');
    } catch (err) {
        listEl.classList.add('centered-state');
        listEl.innerHTML = `<div style="color:var(--accent-red); font-size:0.95rem;">Hata: ${err.message}</div>`;
    }
}

function triggerExcelUploadModal() {
    document.getElementById("excel-upload-input-modal").click();
}

async function handleExcelUploadModal(event) {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;

    const invalidFiles = files.filter(f => !f.name.toLowerCase().endsWith('.xlsx'));
    if (invalidFiles.length > 0) {
        showToast("Sadece .xlsx uzantılı Excel dosyaları yüklenebilir.", "error");
        event.target.value = "";
        return;
    }

    const formData = new FormData();
    formData.append("profile", currentProfile.id);
    files.forEach(file => {
        formData.append("files", file);
    });

    if (files.length === 1) {
        showToast(`${files[0].name} yükleniyor...`, "info");
    } else {
        showToast(`${files.length} adet dosya yükleniyor...`, "info");
    }

    try {
        const response = await fetch('/api/upload-excel', {
            method: 'POST',
            body: formData
        });

        const data = await response.json();
        if (response.ok) {
            const count = data.uploaded ? data.uploaded.length : files.length;
            const successMsg = count === 1 ? `${files[0].name} başarıyla yüklendi.` : `${count} adet Excel dosyası başarıyla yüklendi.`;
            showToast(successMsg, "success");
            await fetchExcelFiles();
            await renderExcelManagerList();
            const select = document.getElementById("excel-file-select");
            if (data.uploaded && data.uploaded.length > 0) {
                select.value = data.uploaded[data.uploaded.length - 1];
            } else if (files.length > 0) {
                select.value = files[files.length - 1].name;
            }
            await loadSelectedExcel();
        } else {
            showToast(data.detail || "Dosyalar yüklenemedi.", "error");
        }
    } catch (e) {
        showToast("Yükleme hatası: " + e.message, "error");
    } finally {
        event.target.value = "";
    }
}

async function deleteExcelFileFromModal(filename) {
    if (!confirm(`"${filename}" dosyasını sunucudan kalıcı olarak silmek istediğinize emin misiniz?`)) {
        return;
    }

    try {
        const response = await fetch(`/api/excel-files/${encodeURIComponent(filename)}?profile=${encodeURIComponent(currentProfile.id)}`, {
            method: 'DELETE'
        });

        const data = await response.json();
        if (response.ok) {
            showToast(`"${filename}" dosyası silindi.`, "success");
            await fetchExcelFiles();
            await renderExcelManagerList();
            const select = document.getElementById("excel-file-select");
            if (select.value === filename) {
                select.value = "all";
                await loadSelectedExcel();
            }
        } else {
            showToast(data.detail || "Dosya silinemedi.", "error");
        }
    } catch (e) {
        showToast("Silme hatası: " + e.message, "error");
    }
}

function renderPlaceholders() {
    const container = document.getElementById("placeholders-container");
    if (!container) return;
    if (orders.length === 0) {
        container.innerHTML = `<span style="color: var(--text-muted); font-size: 0.8rem; font-style: italic;">Sütun bulunamadı</span>`;
        return;
    }

    // Get all unique keys from orders (excluding internal fields)
    const sampleOrder = orders[0];
    const keys = Object.keys(sampleOrder).filter(key => key !== "ID" && key !== "Kaynak Dosya");

    // Start with custom virtual placeholders
    let tagsHtml = `<span class="placeholder-tag" onclick="insertPlaceholder('{ID}')">&#123;ID&#125;</span>`;
    tagsHtml += `<span class="placeholder-tag" onclick="insertPlaceholder('{Kargo Takip Linki}')">&#123;Kargo Takip Linki&#125;</span>`;

    // Add excel columns as clickable tags
    tagsHtml += keys.map(key => {
        return `<span class="placeholder-tag" onclick="insertPlaceholder('{${key}}')">{${key}}</span>`;
    }).join('');

    container.innerHTML = tagsHtml;
}

// Save template when user types
document.getElementById("template-input").addEventListener("input", (e) => {
    localStorage.setItem(profileTemplateKey(), e.target.value);
    autoResize(e.target);
});

// Auto-resize textarea to fit content
// scrollHeight excludes borders; +2px compensates for 1px top + 1px bottom border
function autoResize(el) {
    el.style.height = "0px";
    el.style.height = (el.scrollHeight + 2) + "px";
}

// Insert placeholder at cursor position
function insertPlaceholder(placeholder) {
    const textarea = document.getElementById("template-input");
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;

    textarea.value = text.substring(0, start) + placeholder + text.substring(end);
    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = start + placeholder.length;

    // Save to storage and update preview
    localStorage.setItem(profileTemplateKey(), textarea.value);
    autoResize(textarea);
    updatePreview();
}

// Fetch orders from FastAPI
async function fetchOrders(selectedFile = null) {
    try {
        if (!currentProfile) return;
        let url = `/api/orders?profile=${encodeURIComponent(currentProfile.id)}`;
        if (selectedFile) url += `&file=${encodeURIComponent(selectedFile)}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error("Siparişler alınamadı.");
        const data = await response.json();
        orders = data.orders;

        await fetchSendingStatuses();
        renderOrders();
        renderPlaceholders();
        updateStats();

        showToast("Siparişler başarıyla yüklendi.", "success");
    } catch (err) {
        console.error(err);
        showToast("Veri çekme hatası: " + err.message, "error");
        document.getElementById("orders-container").innerHTML = `
                    <div class="no-data">
                        <i class="fas fa-circle-exclamation" style="color: var(--accent-red)"></i>
                        <p>Excel dosyası yüklenemedi. Sunucu çalışıyor mu ve dosya yerinde mi kontrol edin.</p>
                    </div>
                `;
    }
}

// Fetch sending statuses
async function fetchSendingStatuses() {
    try {
        if (!currentProfile) return;
        const response = await fetch(`/api/status?profile=${encodeURIComponent(currentProfile.id)}`);
        if (response.ok) {
            const newStatuses = await response.json();
            sendingStatuses = newStatuses;
            updateStatusIndicators();
            updateStats();
        }
    } catch (err) {
        console.error("Status check failed", err);
    }
}


// Helper: get selected date label from excel-file-select
function getSelectedDateLabel() {
    const select = document.getElementById("excel-file-select");
    if (!select || select.value === "all" || !select.value) return null;
    const dateMatch = select.value.match(/(\d{4}-\d{2}-\d{2})/);
    return dateMatch ? dateMatch[1] : null;
}

// Update reset button text and hint based on selection
function updateResetButtonText() {
    const dateLabel = getSelectedDateLabel();
    const btnText = document.getElementById("reset-status-btn-text");
    const hint = document.getElementById("reset-status-hint");
    if (!btnText || !hint) return;
    if (dateLabel) {
        btnText.textContent = `${dateLabel} Gönderim Durumlarını Sıfırla`;
        hint.textContent = `${dateLabel} tarihindeki, görünür ve gizli tüm siparişlerin gönderim durumlarını 'Bekliyor' yapar.`;
    } else {
        btnText.textContent = 'Tüm Gönderim Durumlarını Sıfırla';
        hint.textContent = 'Tüm tarihlerdeki görünür ve gizli tüm siparişlerin gönderim durumlarını \'Bekliyor\' yapar.';
    }
}

// Reset Statuses on backend
async function resetStatuses() {
    const dateLabel = getSelectedDateLabel();
    const confirmMsg = dateLabel
        ? `${dateLabel} tarihindeki, görünür ve gizli tüm siparişlerin durumlarını bekliyor yapmak istediğinize emin misiniz?`
        : `Tüm tarihlerdeki, görünür ve gizli tüm siparişlerin durumlarını bekliyor yapmak istediğinize emin misiniz?`;
    if (!confirm(confirmMsg)) return;
    try {
        const response = await fetch(`/api/reset-status?profile=${encodeURIComponent(currentProfile.id)}`, { method: 'POST' });
        if (response.ok) {
            // Fetch fresh statuses from server so hidden orders' new "pending" state is reflected
            await fetchSendingStatuses();
            renderOrders();
            updateStats();
            const toastMsg = dateLabel
                ? `${dateLabel} tarihindeki gönderim durumları sıfırlandı.`
                : 'Tüm gönderim durumları sıfırlandı.';
            showToast(toastMsg, "success");
        }
    } catch (e) {
        showToast("Sıfırlama başarısız: " + e.message, "error");
    }
}

// Render orders list
function renderOrders() {
    const container = document.getElementById("orders-container");
    const searchVal = document.getElementById("search-input").value.toLowerCase();
    const problematicOnly = document.getElementById("filter-problematic-only")?.checked;
    const notSentOnly = document.getElementById("filter-not-sent-only")?.checked;

    // Filter orders (exclude deleted)
    const filtered = orders.filter(o => {
        if (isOrderHidden(o.ID)) return false;

        const nameMatch = (o["Alıcı Adı"] || "").toLowerCase().includes(searchVal);
        const phoneMatch = (o["Alıcı Telefon"] || "").toString().includes(searchVal);
        const idMatch = (o["ID"] || "").toLowerCase().includes(searchVal);
        const orderNoMatch = (o["Sipariş No"] || "").toString().includes(searchVal);

        const matchesSearch = nameMatch || phoneMatch || idMatch || orderNoMatch;
        if (!matchesSearch) return false;

        if (problematicOnly && o["Durum"] !== "Sorunlu") return false;

        if (notSentOnly) {
            const isSent = sendingStatuses[o.ID]?.status === "sent";
            if (isSent) return false;
        }

        return true;
    });

    const sortedList = sortOrdersList(filtered);

    if (sortedList.length === 0) {
        container.innerHTML = `
                    <div class="no-data">
                        <i class="fas fa-folder-open"></i>
                        <p>Eşleşen sipariş bulunamadı.</p>
                    </div>
                `;
    } else {
        container.innerHTML = sortedList.map(o => {
            const isSelected = selectedOrderId === o.ID ? 'selected' : '';
            const isSendSelected = sendSelectIds.has(o.ID) ? 'send-selected' : '';
            const durumClass = o["Durum"] === "Sorunlu" ? "status-sorunlu" : "status-tamamlandi";
            const badgeClass = o["Durum"] === "Sorunlu" ? "badge-sorunlu" : (o["Durum"] === "Tamamlandı" ? "badge-tamamlandi" : "badge-other");
            const cbChecked = sendSelectIds.has(o.ID) ? 'checked' : '';
            const cbIcon = sendSelectIds.has(o.ID) ? '<i class="fas fa-check"></i>' : '';

            return `
                        <div class="order-card ${durumClass} ${isSelected} ${isSendSelected}" id="card-${o.ID}" onclick="selectOrder(this, '${o.ID}')">
                            <div class="card-select-wrap" onclick="event.stopPropagation(); toggleSendSelect('${o.ID}')" title="Gönderim için seç">
                                <div class="card-select-cb ${cbChecked}" id="scb-${o.ID}">${cbIcon}</div>
                            </div>
                            <div class="order-info">
                                <div class="info-block">
                                    <span class="info-label">Müşteri</span>
                                    <span class="info-val" style="font-weight: 700;">${o["Alıcı Adı"]}</span>
                                    <span class="info-val subtle">${o["Alıcı Telefon"]}</span>
                                </div>
                                <div class="info-block">
                                    <span class="info-label">Sipariş No / ID</span>
                                    <span class="info-val">#${o["Sipariş No"] || o["Sipari No"]}</span>
                                    <span class="info-val source-meta" title="Kaynak Dosya: ${o["Kaynak Dosya"]}">${formatSourceMetaText(o["Kaynak Dosya"] || o.ID.split('|')[1])}</span>
                                </div>
                                <div class="info-block">
                                    <span class="info-label">Ürün</span>
                                    <span class="info-val" title="${o["Ürün Adı"]}">${o["Ürün Adı"]}</span>
                                    <span class="info-val subtle">${o["Kargo Firması"]} (${o["Kargo Kodu"] || 'Kod Yok'})</span>
                                </div>
                                <div class="info-block">
                                    <span class="info-label">Durum / WP</span>
                                    <span class="badge ${badgeClass}">${o["Durum"]}</span>
                                    <span class="sending-status-container" id="status-text-${o.ID}">
                                        ${getStatusDropdownHtml(o.ID)}
                                    </span>
                                </div>
                            </div>
                            
                            <div class="order-actions" onclick="event.stopPropagation()">
                                <button class="action-btn btn-whatsapp-web" onclick="sendManual('${o.ID}')" title="Manuel Gönder">
                                    <i class="fab fa-whatsapp"></i>
                                </button>
                                <button class="action-btn btn-auto-send" onclick="sendAuto('${o.ID}')" title="Otomatik Gönder">
                                    <i class="fas fa-robot"></i>
                                </button>
                                <button class="action-btn btn-delete" onclick="deleteOrder('${o.ID}')" title="Listeden kaldır">
                                    <i class="fas fa-eye-slash"></i>
                                </button>
                            </div>
                        </div>
                    `;
        }).join('');
    }

    updateSelectedCount();
    renderHiddenOrders(container);

    // Restore toggle state after re-render
    if (hiddenSectionOpen) {
        const body = document.getElementById("hidden-orders-body");
        const chevron = document.getElementById("hidden-orders-chevron");
        const toggle = document.getElementById("hidden-orders-toggle");
        if (body) body.style.display = "block";
        if (chevron) chevron.style.transform = "rotate(180deg)";
        if (toggle) {
            const countSpan = toggle.querySelector("span");
            if (countSpan) {
                const m = countSpan.textContent.match(/\((\d+)/);
                const n = m ? m[1] : "";
                countSpan.innerHTML = `<i class="fas fa-eye-slash" style="margin-right:0.4rem; color:var(--accent-red);"></i>Gizlenen Siparişler Panelini Gizle${n ? " (" + n + " müşteri)" : ""}`;
            }
        }
    }
}



let queuedOrderIds = new Set();

// Get status dropdown HTML
function getStatusDropdownHtml(id) {
    const state = sendingStatuses[id];
    let currentStatus = state ? state.status : 'pending';

    // Toplu gönderimlerde sırada bekleyenler sunucuya kaydedilmeden geçici olarak 'queued' (Sıraya Alındı) görünecektir
    if (queuedOrderIds.has(id) && currentStatus !== 'sending' && currentStatus !== 'sent' && currentStatus !== 'failed') {
        currentStatus = 'queued';
    }

    const options = [
        { value: 'pending', label: 'Bekliyor' }
    ];

    // 'Sıraya Alındı' veya 'Gidiyor...' sadece sipariş aktif olarak o durumdaysa listede yer alır
    if (currentStatus === 'queued') {
        options.push({ value: 'queued', label: 'Sıraya Alındı' });
    }
    if (currentStatus === 'sending') {
        options.push({ value: 'sending', label: 'Gidiyor...' });
    }

    options.push(
        { value: 'sent', label: 'Gönderildi' },
        { value: 'failed', label: 'Hata' }
    );

    const optionHtml = options.map(opt => {
        const selected = opt.value === currentStatus ? 'selected' : '';
        return `<option value="${opt.value}" ${selected}>${opt.label}</option>`;
    }).join('');

    return `
                <select class="status-select ${currentStatus}" onchange="changeOrderStatus('${id}', this.value)" onclick="event.stopPropagation()">
                    ${optionHtml}
                </select>
            `;
}

// Change order status manually on backend and locally
async function changeOrderStatus(id, newStatus) {
    if (newStatus === 'queued' || newStatus === 'sending') {
        showToast('Bu durum manuel olarak seçilemez.', 'info');
        return;
    }
    const order = orders.find(o => o.ID === id);
    queuedOrderIds.delete(id);
    try {
        const response = await fetch('/api/set-order-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: id,
                status: newStatus,
                profile: currentProfile.id,
                error: newStatus === 'failed' ? 'Manuel hata olarak işaretlendi' : '',
                order: order || null
            })
        });

        if (response.ok) {
            if (!sendingStatuses[id]) {
                sendingStatuses[id] = {};
            }
            sendingStatuses[id].status = newStatus;
            if (newStatus === 'failed') {
                sendingStatuses[id].error = 'Manuel hata olarak işaretlendi';
            } else {
                delete sendingStatuses[id].error;
            }

            // Update UI stats and classes
            updateStatusIndicators();
            updateStats();
            showToast('Sipariş durumu güncellendi.', 'success');
        } else {
            showToast('Durum güncellenemedi.', 'error');
        }
    } catch (err) {
        console.error(err);
        showToast('Hata: ' + err.message, 'error');
    }
}

// Update status badges on the screen without full re-render
function updateStatusIndicators() {
    let anySending = false;
    orders.forEach(o => {
        const containerEl = document.getElementById(`status-text-${o.ID}`);
        if (containerEl) {
            const selectEl = containerEl.querySelector('select');
            const state = sendingStatuses[o.ID];
            let currentStatus = state ? state.status : 'pending';

            if (queuedOrderIds.has(o.ID) && currentStatus !== 'sending' && currentStatus !== 'sent' && currentStatus !== 'failed') {
                currentStatus = 'queued';
            }

            // Sadece durum gerçekten değiştiyse veya eleman yoksa DOM'u güncelle
            if (!selectEl || selectEl.value !== currentStatus || !selectEl.classList.contains(currentStatus)) {
                containerEl.innerHTML = getStatusDropdownHtml(o.ID);
            }
        }
        const state = sendingStatuses[o.ID];
        if (queuedOrderIds.has(o.ID) || (state && (state.status === "queued" || state.status === "sending"))) {
            anySending = true;
        }
    });
    toggleUiInteractivity(!anySending);
}

// Enable or disable UI buttons during active sending tasks to prevent accidental double clicks and PyAutoGUI click loops
function toggleUiInteractivity(enabled) {
    const selectors = ".btn-auto-send, #btn-bulk-send, .btn-secondary.btn-danger, .action-btn.btn-auto-send";
    const buttons = document.querySelectorAll(selectors);
    buttons.forEach(btn => {
        btn.disabled = !enabled;
        if (!enabled) {
            btn.style.opacity = "0.5";
            btn.style.pointerEvents = "none";
        } else {
            btn.style.opacity = "1";
            btn.style.pointerEvents = "auto";
        }
    });
}

// Select an order to preview message
function selectOrder(cardElOrId, id) {
    // Eski çağrı: selectOrder(id) — yeni çağrı: selectOrder(this, id)
    let cardEl;
    let isClick = false;
    if (typeof cardElOrId === 'string') {
        id = cardElOrId;
        cardEl = document.getElementById(`card-${id}`);
    } else {
        cardEl = cardElOrId;
        isClick = true;
    }

    // Önceki seçimi kaldır (querySelectorAll — ID çakışmasından etkilenmez)
    document.querySelectorAll('.order-card.selected').forEach(c => c.classList.remove('selected'));

    selectedOrderId = id;

    // Tıklanan kartı direkt seç — getElementById'e gerek yok
    if (cardEl) cardEl.classList.add('selected');

    updatePreview();

    // Kartın herhangi bir boş yerine tıklandığında checkbox seçimi de tetiklensin
    if (isClick) {
        toggleSendSelect(id);
    }
}

// Build preview text for specific order
function buildMessageForOrder(order, template) {
    if (!order) return "";

    let message = template;

    // Loop through all properties in the order object and replace placeholders
    Object.keys(order).forEach(key => {
        if (key === "ID") {
            // Show original ID in placeholder replacement
            const originalId = order.ID.split('|')[1] || order.ID;
            const regex = new RegExp(`{ID}`, 'g');
            message = message.replace(regex, originalId);
        } else {
            const val = order[key] !== undefined && order[key] !== null ? order[key] : "";
            const regex = new RegExp(`{${key}}`, 'g');
            message = message.replace(regex, val);
        }
    });

    // Fallback templates for common aliases
    const orderNo = order["Sipariş No"] || order["Sipari No"] || "";
    message = message.replace(/{Sipariş No}/g, orderNo);
    message = message.replace(/{Sipari No}/g, orderNo);

    const receiverName = order["Alıcı Adı"] || order["Alc Ad"] || "";
    message = message.replace(/{Alıcı Adı}/g, receiverName);

    const trackingCode = order["Kargo Firması Takip Kodu"] || order["Kargo Takip Kodu"] || "";
    message = message.replace(/{Kargo Firması Takip Kodu}/g, trackingCode);
    message = message.replace(/{Takip Kodu}/g, trackingCode);

    // Kargo firmasına göre otomatik takip linki
    const kargoFirmasi = (order["Kargo Firması"] || "").toString().toLowerCase();
    let kargoTakipLinki = "";
    if (kargoFirmasi.includes("ptt")) {
        kargoTakipLinki = "https://www.ptt.gov.tr/";
    } else if (kargoFirmasi.includes("sürat") || kargoFirmasi.includes("surat")) {
        kargoTakipLinki = "https://suratkargo.com.tr/KargoTakip/";
    }
    message = message.replace(/{Kargo Takip Linki}/g, kargoTakipLinki);

    return message;
}

// Update preview pane
function showEmptyPreview() {
    const previewBox = document.getElementById("preview-box");
    previewBox.classList.add("empty");
    previewBox.innerHTML = `<div class="preview-empty">Önizlemek için sağdan herhangi bir sipariş seçin.</div>`;
}

function updatePreview() {
    const previewBox = document.getElementById("preview-box");
    if (!selectedOrderId) {
        showEmptyPreview();
        return;
    }

    const order = orders.find(o => o.ID === selectedOrderId);
    if (!order) return;

    const template = document.getElementById("template-input").value;
    const msg = buildMessageForOrder(order, template);

    previewBox.classList.remove("empty");
    previewBox.innerHTML = `<div class="preview-badge">Sipariş #${order["Sipariş No"] || order["Sipari No"]} Önizleme</div>
<div>${escapeHtml(msg)}</div>`;
}

function escapeHtml(text) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// WhatsApp bağlantısı kontrolü - bağlı değilse paneli açar
function checkWAConnectionOrOpenModal() {
    if (waState !== 'connected') {
        showToast("Gönderim yapabilmek için önce WhatsApp bağlantısı kurmalısınız.", "error");
        openQRModal();
        return false;
    }
    return true;
}

// Filter and Search trigger
function filterOrders() {
    renderOrders();
}

// Update top statistics panel
function updateStats() {
    const visible = orders.filter(o => !isOrderHidden(o.ID));
    document.getElementById("stat-total").innerText = visible.length;

    const problematic = visible.filter(o => o["Durum"] === "Sorunlu").length;
    document.getElementById("stat-problematic").innerText = problematic;

    const sent = visible.filter(o => sendingStatuses[o.ID]?.status === "sent").length;
    document.getElementById("stat-sent").innerText = sent;
}

// Send manual message (opens new tab with pre-filled WhatsApp link)
async function sendManual(id) {
    if (!checkWAConnectionOrOpenModal()) return;

    const order = orders.find(o => o.ID === id);
    if (!order) return;

    const template = document.getElementById("template-input").value;
    const message = buildMessageForOrder(order, template);

    // Format phone (web api wants numbers only with country code)
    let phone = (order["Alıcı Telefon"] || "").toString().replace(/\D/g, '');
    if (!phone.startsWith('90') && phone.length === 10) {
        phone = '90' + phone;
    } else if (phone.startsWith('0') && phone.length === 11) {
        phone = '90' + phone.substring(1);
    }

    const url = `https://web.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(message)}`;

    window.open(url, '_blank');

    // Mark as sent both locally and on the backend so it persists
    sendingStatuses[id] = { status: "sent", error: "" };
    updateStatusIndicators();
    updateStats();

    // Otomatik gizle ayarı açıksa gönderilen siparışi gizle
    if (isAutoHideSentEnabled()) {
        await deleteOrder(id);
    }

    try {
        await fetch('/api/mark-sent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: order.ID,
                profile: currentProfile.id,
                phone: order["Alıcı Telefon"].toString(),
                message: message,
                order: order
            })
        });
    } catch (e) {
        console.warn("Durum kaydedilemedi (backend):", e);
    }

    showToast(`${order["Alıcı Adı"]} için WhatsApp Web sekmesi açıldı.`, "success");
}

// Send automatically using Python backend
async function sendAuto(id) {
    const isSingleSend = !isBulkSending;
    if (isSingleSend && !checkWAConnectionOrOpenModal()) return;

    const order = orders.find(o => o.ID === id);
    if (!order) return;

    if (isSingleSend) {
        showBulkProgress(1, 1);
    }

    const template = document.getElementById("template-input").value;
    const message = buildMessageForOrder(order, template);

    try {
        // Instantly update UI status to sending
        sendingStatuses[id] = { status: "sending", error: "" };
        updateStatusIndicators();

        const response = await fetch('/api/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: order.ID,
                profile: currentProfile.id,
                phone: order["Alıcı Telefon"].toString(),
                message: message,
                order: order
            })
        });

        if (response.ok) {
            showToast(`${order["Alıcı Adı"]} için otomatik gönderim sıraya alındı.`, "success");

            // Tekli gönderim modunda mesaj tamamlanıp 'sent' olunca 'Hemen Gizle' açıksa gizle
            if (isSingleSend) {
                let checkCount = 0;
                const pollSent = setInterval(async () => {
                    checkCount++;
                    await fetchSendingStatuses();
                    const state = sendingStatuses[id];
                    if (state && state.status === 'sent') {
                        clearInterval(pollSent);
                        if (isAutoHideSentEnabled()) {
                            await hideSingleOrder(id);
                        }
                    }
                    if (checkCount > 15 || (state && state.status === 'failed')) {
                        clearInterval(pollSent);
                    }
                }, 2000);
            }
        } else {
            let errText = "";
            try {
                const err = await response.json();
                errText = err.detail || err.message || "İşlem başarısız.";
            } catch (_) {
                errText = (await response.text()) || `Sunucu hatası (${response.status})`;
            }
            throw new Error(errText);
        }
    } catch (err) {
        console.error(err);
        sendingStatuses[id] = { status: "failed", error: err.message };
        updateStatusIndicators();
        showToast(`Hata: ${err.message}`, "error");
    } finally {
        if (isSingleSend) {
            setTimeout(() => {
                if (!isBulkSending) hideBulkProgress();
            }, 2500);
        }
    }
}

// Bulk Auto Sender (queues all visible pending orders)
async function startBulkSend(useSelection = false) {
    if (!checkWAConnectionOrOpenModal()) return;
    let toSend = [];
    if (useSelection) {
        toSend = orders.filter(o => sendSelectIds.has(o.ID));
    } else {
        const problematicOnly = document.getElementById("filter-problematic-only")?.checked;
        const notSentOnly = document.getElementById("filter-not-sent-only")?.checked;
        const searchVal = document.getElementById("search-input").value.toLowerCase();

        // Get all visible orders based on active filters
        const visible = orders.filter(o => {
            if (isOrderHidden(o.ID)) return false;

            const nameMatch = (o["Alıcı Adı"] || "").toLowerCase().includes(searchVal);
            const phoneMatch = (o["Alıcı Telefon"] || "").toString().includes(searchVal);
            const idMatch = (o["ID"] || "").toLowerCase().includes(searchVal);
            const orderNoMatch = (o["Sipariş No"] || "").toString().includes(searchVal);

            const matchesSearch = nameMatch || phoneMatch || idMatch || orderNoMatch;
            if (!matchesSearch) return false;

            if (problematicOnly && o["Durum"] !== "Sorunlu") return false;

            if (notSentOnly && sendingStatuses[o.ID]?.status === "sent") return false;

            return true;
        });

        // Filter to get only pending/failed ones
        toSend = visible.filter(o => {
            const stat = sendingStatuses[o.ID];
            return !stat || (stat.status !== "sent" && stat.status !== "sending" && stat.status !== "queued");
        });
    }

    if (toSend.length === 0) {
        alert("Gönderilecek sipariş bulunamadı.");
        return;
    }

    const confirmMsg = formatStatusBreakdownText(toSend, "mesaj gönderilmemiş müşteriye otomatik mesaj gönderilecek. Devam edilsin mi?");
    if (!confirm(confirmMsg)) {
        return;
    }

    showToast("Toplu otomatik gönderim başlatıldı.", "success");

    isBulkSending = true;
    toSend.forEach(o => queuedOrderIds.add(o.ID));
    updateStatusIndicators();
    showBulkProgress(0, toSend.length);

    try {
        // Send sequentially by waiting for each status to finish
        for (let i = 0; i < toSend.length; i++) {
            showBulkProgress(i + 1, toSend.length);
            const order = toSend[i];
            queuedOrderIds.delete(order.ID); // Sırası gelen sipariş kuyruktan çıkarılır

            // Select order visually
            selectOrder(order.ID);

            // Trigger auto send
            await sendAuto(order.ID);

            // Wait for the status to change from "sending"
            let completed = false;
            while (!completed) {
                await new Promise(r => setTimeout(r, 2000));

                // Fetch latest status
                await fetchSendingStatuses();
                const state = sendingStatuses[order.ID];
                if (state && (state.status === "sent" || state.status === "failed")) {
                    completed = true;
                    if (state.status === "sent" && isAutoHideSentEnabled()) {
                        await hideSingleOrder(order.ID);
                    }
                }
            }

            // Wait another 3 seconds before next order to let browser cool down
            await new Promise(r => setTimeout(r, 3000));
        }

        showToast("Toplu gönderim tamamlandı.", "success");
    } finally {
        isBulkSending = false;
        queuedOrderIds.clear();
        updateStatusIndicators();
        hideBulkProgress();
    }
}

function sendToSelected() {
    startBulkSend(true);
}

// Toast Helper
function showToast(message, type = "success") {
    const toast = document.getElementById("toast");
    const icon = document.getElementById("toast-icon");
    const msgSpan = document.getElementById("toast-message");

    msgSpan.innerText = message;

    toast.className = "toast show " + type;
    if (type === "success") {
        icon.className = "fas fa-circle-check";
    } else {
        icon.className = "fas fa-circle-exclamation";
    }

    setTimeout(() => {
        toast.classList.remove("show");
    }, 4000);
}

// ── WhatsApp Bağlantı Durumu ────────────────────────────────────────

let waUserPhone = null;
let isLoggingOut = false;

async function fetchWAStatus() {
    if (isLoggingOut) {
        updateWAStatusUI('logging_out');
        return;
    }
    try {
        const resp = await fetch('/api/whatsapp-status');
        const data = await resp.json();
        if (isLoggingOut) return;
        const newState = data.state || 'disconnected';
        waState = newState;
        waUserPhone = data.user || null;
        updateWAStatusUI(newState);

        // Modal açık ise içeriğini güncelle (otomatik açma yapılmaz!)
        if (document.getElementById('wa-qr-modal').classList.contains('open')) {
            refreshQRModalContent();
        }
    } catch (e) {
        if (isLoggingOut) {
            updateWAStatusUI('logging_out');
            return;
        }
        waState = 'service_offline';
        waUserPhone = null;
        updateWAStatusUI('service_offline');

        if (document.getElementById('wa-qr-modal').classList.contains('open')) {
            refreshQRModalContent();
        }
    }
}

function updateWAStatusUI(state) {
    const text = document.getElementById('wa-status-text');
    const btn = document.getElementById('wa-status-btn');
    if (!text) return;

    if (btn) {
        btn.className = 'btn btn-secondary wa-status-btn state-' + state;
    }

    const labels = {
        connected: 'Bağlı',
        qr_pending: 'QR Bekleniyor',
        connecting: 'Bağlanıyor',
        logging_out: 'Çıkış Yapılıyor',
        disconnected: 'Bağlı Değil',
        service_offline: 'Servis Kapalı'
    };
    text.textContent = labels[state] || state;
}

async function logoutWhatsApp() {
    if (!confirm("WhatsApp oturumu kapatılacak. Devam edilsin mi?")) return;
    isLoggingOut = true;
    waState = 'logging_out';
    updateWAStatusUI('logging_out');
    refreshQRModalContent();

    try {
        const res = await fetch('/api/whatsapp-logout', { method: 'POST' });
        if (res.ok) {
            showToast("WhatsApp oturumu başarıyla kapatıldı.", "success");
        } else {
            showToast("Oturum kapatılırken uyarı alındı.", "info");
        }
    } catch (e) {
        showToast("Oturum kapatılırken hata: " + e.message, "error");
    } finally {
        isLoggingOut = false;
        waState = 'disconnected';
        waUserPhone = null;
        updateWAStatusUI('disconnected');
        document.getElementById('wa-qr-modal')?.classList.remove('open');
    }
}

async function openQRModal() {
    if (isLoggingOut) return;
    document.getElementById('wa-qr-modal').classList.add('open');
    if (waState === 'disconnected') {
        try {
            await fetch('/api/whatsapp-connect', { method: 'POST' });
        } catch (_) { }
    }
    await refreshQRModalContent();
}

async function closeQRModal(event) {
    if (isLoggingOut) return;
    if (event && event.target !== event.currentTarget) return;
    document.getElementById('wa-qr-modal').classList.remove('open');

    // Oturum kurulmadan panel kapatıldıysa bağlantı/QR sürecini iptal et
    if (waState !== 'connected') {
        waState = 'disconnected';
        updateWAStatusUI('disconnected');
        try {
            await fetch('/api/whatsapp-cancel', { method: 'POST' });
        } catch (_) { }
    }
}

let lastQRDataUrl = null; // Önceki QR resmi — değişmemişse DOM'u yeniden çizme

async function refreshQRModalContent() {
    const qrContent = document.getElementById('wa-qr-content');
    const connectedContent = document.getElementById('wa-connected-content');
    const offlineContent = document.getElementById('wa-offline-content');

    if (waState === 'connected') {
        qrContent.style.display = 'none';
        offlineContent.style.display = 'none';
        connectedContent.style.display = 'block';
        const phoneEl = document.getElementById('wa-connected-phone');
        if (phoneEl) {
            phoneEl.textContent = waUserPhone ? waUserPhone : '';
        }
        lastQRDataUrl = null;
        return;
    }

    if (waState === 'logging_out') {
        qrContent.style.display = 'none';
        connectedContent.style.display = 'none';
        offlineContent.style.display = 'block';
        const titleEl = offlineContent.querySelector('.wa-connected-text');
        const descEl = offlineContent.querySelector('p');
        if (titleEl) titleEl.textContent = 'Çıkış Yapılıyor...';
        if (descEl) descEl.textContent = 'WhatsApp oturum dosyaları temizleniyor, lütfen bekleyin...';
        lastQRDataUrl = null;
        return;
    }

    if (waState === 'service_offline') {
        qrContent.style.display = 'none';
        connectedContent.style.display = 'none';
        offlineContent.style.display = 'block';
        const titleEl = offlineContent.querySelector('.wa-connected-text');
        const descEl = offlineContent.querySelector('p');
        if (titleEl) titleEl.textContent = 'Servis Kapalı';
        if (descEl) descEl.textContent = 'Sunucuyu yeniden başlatın veya bekleyin.';
        lastQRDataUrl = null;
        return;
    }

    if (waState === 'disconnected' && !lastQRDataUrl) {
        qrContent.style.display = 'none';
        connectedContent.style.display = 'none';
        offlineContent.style.display = 'block';
        const titleEl = offlineContent.querySelector('.wa-connected-text');
        const descEl = offlineContent.querySelector('p');
        if (titleEl) titleEl.textContent = 'Bağlı Değil';
        if (descEl) descEl.textContent = 'Bağlanmak için butona tıklayın.';
        return;
    }

    // qr_pending veya connecting — QR çek
    connectedContent.style.display = 'none';
    offlineContent.style.display = 'none';
    qrContent.style.display = 'block';

    try {
        const resp = await fetch('/api/whatsapp-qr');
        const data = await resp.json();

        if (data.qr) {
            // Sadece QR değiştiyse DOM'u yeniden çiz
            if (data.qr !== lastQRDataUrl) {
                lastQRDataUrl = data.qr;
                qrContent.innerHTML = `
                        <img src="${data.qr}" class="wa-qr-img" alt="WhatsApp QR Kod">
                        <div class="wa-qr-hint">
                            WhatsApp → Bağlı Cihazlar → Cihaz Ekle<br>
                            ile bu QR kodu okutun.
                        </div>`;
            }
            // QR aynıysa hiçbir şey yapma — titreme olmaz
        } else if (data.state === 'connected' || waState === 'connected') {
            qrContent.style.display = 'none';
            connectedContent.style.display = 'block';
            lastQRDataUrl = null;
        } else {
            // Henüz QR hazır değil — ama önceşi QR varsa onu koru
            if (!lastQRDataUrl) {
                qrContent.innerHTML = '<div class="wa-qr-loading"><i class="fas fa-circle-notch fa-spin"></i> QR hazırlanıyor, lütfen bekleyin...</div>';
            }
            // Önceşi QR varsa onu göstermeye devam et (değiştirme)
        }
    } catch (e) {
        if (!lastQRDataUrl) {
            qrContent.innerHTML = '<div class="wa-qr-loading" style="color:var(--accent-red);">QR alınamadı.</div>';
        }
    }
}

async function logoutWhatsApp() {
    if (!confirm('WhatsApp oturumunu kapatmak istediğinize emin misiniz? Tekrar bağlanmak için QR kodu yeniden okutmanız gerekecek.')) return;
    try {
        await fetch('/api/whatsapp-logout', { method: 'POST' });
        showToast('WhatsApp oturumu kapatıldı.', 'success');
        closeQRModal();
    } catch (e) {
        showToast('Oturum kapatılamadı.', 'error');
    }
}