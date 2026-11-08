/* RPG Engine v0.2.0
 * Thai Gothic RPG management extension for SillyTavern.
 * Uses chatMetadata for per-chat state, generateQuietPrompt for Raven and AI tracking,
 * and setExtensionPrompt for injecting the current authoritative game state.
 */
(() => {
    'use strict';

    const VERSION = '0.2.0';
    const MODULE = 'rpg_engine';
    const DATA_KEY = 'rpg_engine_v2';
    const LEGACY_DATA_KEY = 'rpg_engine_data';
    const SETTINGS_ID = 'rpg-engine-settings-root';
    const OVERLAY_ID = 'rpg-engine-overlay';
    const LAUNCHER_ID = 'rpg-engine-floating-launcher';
    const PROMPT_KEY = 'rpg_engine_authoritative_state';

    const DEFAULT_SETTINGS = {
        showLauncher: true,
        autoTrack: true,
        autoApply: true,
        injectState: true,
        ravenName: 'เรเวน',
        ravenPersonality: 'ฉลาด ช่างสังเกต ปากไว ชอบประชดและแซวผู้เล่นเล็กน้อย แต่มีเหตุผล ใส่ใจ และจริงจังเมื่อจำเป็น พูดภาษาไทยเป็นธรรมชาติ ไม่พูดเหมือนหุ่นยนต์',
        ravenAvatar: '',
        trackerConfidence: 0.78,
    };

    const DEFAULT_STATE = {
        schemaVersion: 2,
        player: {
            name: 'ผู้เล่น', level: 1, exp: 0, hp: 100, maxHp: 100, mp: 50, maxMp: 50, gold: 250,
            location: 'ไม่ระบุ', stats: { str: 5, int: 5, agi: 5, vit: 5, luk: 5 },
        },
        inventory: [],
        quests: [],
        relationships: [],
        assistantChat: [],
        eventLog: [],
        tracker: { lastSignature: '', lastRunAt: null, lastResult: 'ยังไม่เคยตรวจจับเหตุการณ์', pending: null },
        updatedAt: null,
    };

    const TABS = [
        ['overview', 'ภาพรวม'], ['character', 'สถานะ'], ['inventory', 'กระเป๋า'],
        ['quests', 'ภารกิจ'], ['relationships', 'ความสัมพันธ์'], ['assistant', 'เรเวน'], ['settings', 'ตั้งค่า'],
    ];

    let activeTab = 'overview';
    let selectedNpcId = null;
    let isOpen = false;
    let trackerBusy = false;
    let assistantBusy = false;
    let currentFallbackState = clone(DEFAULT_STATE);

    function clone(value) { return JSON.parse(JSON.stringify(value)); }
    function makeId() { return globalThis.crypto?.randomUUID?.() || `rpg-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
    function clamp(value, min, max) { return Math.min(max, Math.max(min, Number(value) || 0)); }
    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
    }
    function getContext() {
        try { return globalThis.SillyTavern?.getContext?.() ?? null; }
        catch (error) { console.warn('[RPG Engine] getContext failed', error); return null; }
    }
    function notify(message, type = 'info') {
        const toast = globalThis.toastr?.[type];
        if (typeof toast === 'function') toast(message, 'RPG Engine');
        else console.info(`[RPG Engine] ${message}`);
    }
    function getSettings() {
        const ctx = getContext();
        const settings = ctx?.extensionSettings || ctx?.extension_settings;
        if (!settings) return DEFAULT_SETTINGS;
        if (!settings[MODULE]) settings[MODULE] = clone(DEFAULT_SETTINGS);
        for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
            if (!(key in settings[MODULE])) settings[MODULE][key] = value;
        }
        return settings[MODULE];
    }
    function saveSettings() {
        const ctx = getContext();
        try { ctx?.saveSettingsDebounced?.(); } catch (error) { console.warn('[RPG Engine] settings save failed', error); }
    }

    function normalizeNpc(npc = {}) {
        const rel = npc.relationship || {};
        return {
            id: npc.id || makeId(), name: String(npc.name || 'ตัวละครไม่ระบุ'), surname: npc.surname || '',
            alias: npc.alias || '', role: npc.role || '', faction: npc.faction || '', age: npc.age || '',
            race: npc.race || '', status: npc.status || 'มีชีวิต', location: npc.location || '',
            appearance: npc.appearance || '', personality: npc.personality || '', backstory: npc.backstory || '',
            summary: npc.summary || '', avatar: npc.avatar || '', tags: Array.isArray(npc.tags) ? npc.tags : [],
            relationship: {
                affection: clamp(rel.affection ?? npc.affection, 0, 100), trust: clamp(rel.trust ?? npc.trust, 0, 100),
                respect: clamp(rel.respect ?? npc.respect, 0, 100), fear: clamp(rel.fear ?? npc.fear, 0, 100),
                hostility: clamp(rel.hostility ?? npc.hostility, 0, 100),
            },
            events: Array.isArray(npc.events) ? npc.events : [], createdAt: npc.createdAt || new Date().toISOString(),
        };
    }
    function normalizeState(raw) {
        const base = clone(DEFAULT_STATE);
        const source = raw && typeof raw === 'object' ? raw : {};
        const player = source.player && typeof source.player === 'object' ? source.player : {};
        const state = {
            ...base, ...source, schemaVersion: 2,
            player: {
                ...base.player, ...player,
                stats: { ...base.player.stats, ...(player.stats || {}) },
            },
            inventory: Array.isArray(source.inventory) ? source.inventory : [],
            quests: Array.isArray(source.quests) ? source.quests : [],
            relationships: Array.isArray(source.relationships) ? source.relationships.map(normalizeNpc) : [],
            assistantChat: Array.isArray(source.assistantChat) ? source.assistantChat.slice(-80) : [],
            eventLog: Array.isArray(source.eventLog) ? source.eventLog.slice(-100) : [],
            tracker: { ...base.tracker, ...(source.tracker || {}) },
        };
        state.player.level = Math.max(1, Number(state.player.level) || 1);
        state.player.maxHp = Math.max(1, Number(state.player.maxHp) || 100);
        state.player.maxMp = Math.max(1, Number(state.player.maxMp) || 50);
        state.player.hp = clamp(state.player.hp, 0, state.player.maxHp);
        state.player.mp = clamp(state.player.mp, 0, state.player.maxMp);
        state.player.exp = Math.max(0, Number(state.player.exp) || 0);
        state.player.gold = Math.max(0, Number(state.player.gold) || 0);
        return state;
    }
    function getState() {
        const ctx = getContext();
        const metadata = ctx?.chatMetadata;
        if (metadata && typeof metadata === 'object') {
            if (!metadata[DATA_KEY]) {
                metadata[DATA_KEY] = normalizeState(metadata[LEGACY_DATA_KEY] || DEFAULT_STATE);
            }
            metadata[DATA_KEY] = normalizeState(metadata[DATA_KEY]);
            currentFallbackState = metadata[DATA_KEY];
            return metadata[DATA_KEY];
        }
        return currentFallbackState;
    }
    async function persistState(silent = false) {
        const ctx = getContext();
        if (!ctx?.chatMetadata || typeof ctx.saveMetadata !== 'function') {
            if (!silent) notify('ยังไม่มีห้องแชตที่เปิดอยู่ จึงบันทึกข้อมูลถาวรไม่ได้', 'warning');
            return false;
        }
        const state = getState();
        state.updatedAt = new Date().toISOString();
        ctx.chatMetadata[DATA_KEY] = state;
        try {
            await ctx.saveMetadata();
            syncPromptInjection();
            updateFooter();
            return true;
        } catch (error) {
            console.error('[RPG Engine] persist failed', error);
            if (!silent) notify('บันทึกข้อมูลไม่สำเร็จ ตรวจ Console ได้', 'error');
            return false;
        }
    }

    function buildStatePrompt() {
        const s = getState();
        const p = s.player;
        const npcs = s.relationships.slice(0, 40).map(n => ({
            name: n.name, alias: n.alias, status: n.status, location: n.location, relationship: n.relationship,
        }));
        const quests = s.quests.filter(q => q.status !== 'completed' && !q.done).slice(0, 30).map(q => ({
            title: q.title || q.name, status: q.status || 'active', progress: q.progress || 0, target: q.target || 0,
        }));
        const items = s.inventory.slice(0, 50).map(i => ({ name: i.name, quantity: i.quantity, rarity: i.rarity || 'ทั่วไป' }));
        return [
            '[RPG ENGINE — ข้อมูลเกมที่เชื่อถือได้]',
            `ผู้เล่น: ${p.name} | LV ${p.level} | EXP ${p.exp} | HP ${p.hp}/${p.maxHp} | MP ${p.mp}/${p.maxMp} | เงิน ${p.gold} | สถานที่ ${p.location || 'ไม่ระบุ'}`,
            `ค่าสถานะ: ${JSON.stringify(p.stats)}`,
            `ไอเทม: ${JSON.stringify(items)}`,
            `ภารกิจที่ยังไม่สำเร็จ: ${JSON.stringify(quests)}`,
            `NPC ที่บันทึกไว้: ${JSON.stringify(npcs)}`,
            'กฎ: ใช้ข้อมูลนี้เป็นแหล่งข้อมูลหลัก ห้ามเปลี่ยนตัวเลข/ไอเทม/ภารกิจเองโดยไม่มีเหตุการณ์รองรับ หากผู้เล่นถามสถานะให้ยึดข้อมูลนี้',
            `ผู้ช่วยระบบ: ${getSettings().ravenName || 'เรเวน'} สามารถถูกเรียกด้วย @เรเวน หรือ @ระบบ เมื่อต้องการให้ผู้ช่วยตอบ ให้แยกบทพูดด้วยชื่อผู้ช่วยอย่างชัดเจน และอย่าพูดแทนผู้เล่น`,
        ].join('\n');
    }
    function syncPromptInjection() {
        const ctx = getContext();
        const settings = getSettings();
        if (typeof ctx?.setExtensionPrompt !== 'function') return false;
        const prompt = settings.injectState ? buildStatePrompt() : '';
        try {
            // SillyTavern extension prompt positions: 0 = after story string, 1 = in-chat, 2 = after chat.
            // Role 0 is system. A fresh value replaces this extension's slot on every turn.
            ctx.setExtensionPrompt(PROMPT_KEY, prompt, 1, 0, false, 0);
            return true;
        } catch (error) {
            console.warn('[RPG Engine] prompt injection unavailable', error);
            return false;
        }
    }
    globalThis.rpgEnginePromptInterceptor = async function () { syncPromptInjection(); };

    function settingsMarkup() {
        return `
        <div id="${SETTINGS_ID}" class="rpg-engine-settings">
          <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
              <b>RPG Engine</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
              <div class="rpg-drawer-intro"><span class="rpg-small-sigil">✦</span><div><strong>RPG Engine</strong><small>ระบบจัดการเกมสวมบทบาท · v${VERSION}</small></div></div>
              <p class="rpg-drawer-desc">หน้าต่างควบคุมเกม Gothic พร้อมระบบ NPC ผู้ช่วยเรเวน และการติดตามเหตุการณ์ด้วย AI</p>
              <div class="rpg-drawer-actions"><button class="menu_button" id="rpg-open-from-drawer" type="button">เปิด RPG Engine</button></div>
              <label class="checkbox_label"><input type="checkbox" id="rpg-setting-launcher"><span>แสดงปุ่มลอยในหน้าแชต</span></label>
              <label class="checkbox_label"><input type="checkbox" id="rpg-setting-track"><span>ให้ AI ตรวจจับการเปลี่ยนแปลงเกมอัตโนมัติ</span></label>
              <label class="checkbox_label"><input type="checkbox" id="rpg-setting-apply"><span>บันทึกการเปลี่ยนแปลงที่ AI ตรวจพบโดยอัตโนมัติ</span></label>
              <label class="checkbox_label"><input type="checkbox" id="rpg-setting-inject"><span>ส่งสถานะเกมให้ AI ทุกครั้งที่สร้างคำตอบ</span></label>
              <p class="rpg-settings-note">การติดตามอัตโนมัติจะเรียก AI เบื้องหลังอีก 1 ครั้งหลังคำตอบของตัวละครแต่ละครั้ง และใช้โควตา/ค่าใช้จ่ายเพิ่มเติมตาม API ที่เชื่อมอยู่</p>
              <div class="rpg-settings-status" id="rpg-settings-status">กำลังตรวจสอบการเชื่อมต่อ...</div>
            </div>
          </div>
        </div>`;
    }

    function modalMarkup() {
        const tabs = TABS.map(([id, label]) => `<button class="rpg-tab" data-tab="${id}" type="button">${label}</button>`).join('');
        return `
        <div id="${OVERLAY_ID}" class="rpg-overlay" aria-hidden="true">
          <section class="rpg-window" role="dialog" aria-modal="true" aria-labelledby="rpg-title">
            <header class="rpg-header">
              <div class="rpg-brand-lockup"><div class="rpg-brand-symbol">✦</div><div><div class="rpg-eyebrow">ROLEPLAY MANAGEMENT SYSTEM</div><h2 id="rpg-title">RPG Engine</h2><p>ทะเบียนข้อมูลแห่งโลกเรื่องราว</p></div></div>
              <button class="rpg-close" data-action="close" type="button" aria-label="ปิด">×</button>
            </header>
            <nav class="rpg-tabs">${tabs}</nav>
            <main id="rpg-content" class="rpg-content"></main>
            <footer class="rpg-footer"><span><i class="rpg-status-dot"></i><span id="rpg-footer-state">ระบบพร้อมใช้งาน</span></span><span id="rpg-save-status">ข้อมูลแยกตามห้องแชต</span></footer>
          </section>
        </div>`;
    }
    function mountUi() {
        if (document.getElementById(SETTINGS_ID)) return;
        const panel = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
        if (!panel) { console.warn('[RPG Engine] ไม่พบ Extensions settings container'); return; }
        const wrapper = document.createElement('div');
        wrapper.innerHTML = settingsMarkup();
        panel.appendChild(wrapper.firstElementChild);
        const drawer = document.getElementById(SETTINGS_ID);
        drawer.querySelector('#rpg-open-from-drawer')?.addEventListener('click', openWindow);
        ['launcher', 'track', 'apply', 'inject'].forEach(key => {
            const el = drawer.querySelector(`#rpg-setting-${key}`);
            if (el) el.addEventListener('change', () => {
                const s = getSettings();
                if (key === 'launcher') { s.showLauncher = el.checked; updateLauncher(); }
                if (key === 'track') s.autoTrack = el.checked;
                if (key === 'apply') s.autoApply = el.checked;
                if (key === 'inject') { s.injectState = el.checked; syncPromptInjection(); }
                saveSettings(); updateSettingsPanel();
            });
        });
        document.body.insertAdjacentHTML('beforeend', modalMarkup());
        mountLauncher();
        const overlay = document.getElementById(OVERLAY_ID);
        overlay.addEventListener('click', handleOverlayClick);
        overlay.querySelector('.rpg-tabs').addEventListener('click', event => {
            const tab = event.target.closest('[data-tab]');
            if (!tab) return;
            activeTab = tab.dataset.tab; selectedNpcId = null; renderWindow();
        });
        overlay.querySelector('#rpg-content').addEventListener('click', handleContentClick);
        overlay.querySelector('#rpg-content').addEventListener('submit', handleContentSubmit);
        overlay.querySelector('#rpg-content').addEventListener('change', handleContentChange);
        document.addEventListener('keydown', event => { if (event.key === 'Escape' && isOpen) closeWindow(); });
        updateSettingsPanel();
    }
    function mountLauncher() {
        if (document.getElementById(LAUNCHER_ID)) return;
        const button = document.createElement('button');
        button.id = LAUNCHER_ID; button.type = 'button'; button.title = 'เปิด RPG Engine'; button.setAttribute('aria-label', 'เปิด RPG Engine');
        button.innerHTML = '<span>✦</span>';
        button.addEventListener('click', openWindow);
        document.body.appendChild(button);
        updateLauncher();
    }
    function updateLauncher() {
        const button = document.getElementById(LAUNCHER_ID);
        if (button) button.hidden = !getSettings().showLauncher;
    }
    function updateSettingsPanel() {
        const s = getSettings(); const root = document.getElementById(SETTINGS_ID); if (!root) return;
        const map = { launcher: s.showLauncher, track: s.autoTrack, apply: s.autoApply, inject: s.injectState };
        Object.entries(map).forEach(([key, value]) => { const el = root.querySelector(`#rpg-setting-${key}`); if (el) el.checked = !!value; });
        const status = root.querySelector('#rpg-settings-status');
        const ctx = getContext();
        if (status) status.textContent = typeof ctx?.generateQuietPrompt === 'function'
            ? '● เชื่อมต่อโมเดลแล้ว · พร้อมใช้เรเวนและ AI Tracker'
            : '● UI พร้อมใช้งาน · ยังไม่พบ generateQuietPrompt ในโฮสต์นี้';
    }
    function openWindow() {
        const overlay = document.getElementById(OVERLAY_ID); if (!overlay) return;
        isOpen = true; overlay.classList.add('is-open'); overlay.setAttribute('aria-hidden', 'false');
        renderWindow();
    }
    function closeWindow() {
        const overlay = document.getElementById(OVERLAY_ID); if (!overlay) return;
        isOpen = false; overlay.classList.remove('is-open'); overlay.setAttribute('aria-hidden', 'true');
    }
    function handleOverlayClick(event) {
        if (event.target.id === OVERLAY_ID || event.target.closest('[data-action="close"]')) closeWindow();
    }
    function updateFooter(message) {
        const save = document.getElementById('rpg-save-status');
        if (save) save.textContent = message || (getContext()?.chatMetadata ? 'บันทึกแยกตามห้องแชต' : 'ยังไม่มีห้องแชต');
    }
    function renderWindow() {
        const content = document.getElementById('rpg-content'); if (!content) return;
        const state = getState();
        document.querySelectorAll('.rpg-tab').forEach(tab => tab.classList.toggle('is-active', tab.dataset.tab === activeTab));
        const renderers = {
            overview: renderOverview, character: renderCharacter, inventory: renderInventory,
            quests: renderQuests, relationships: renderRelationships, assistant: renderAssistant, settings: renderGameSettings,
        };
        content.innerHTML = (renderers[activeTab] || renderOverview)(state);
        updateFooter();
    }

    function meter(label, value, max, kind) {
        const safeMax = Math.max(1, Number(max) || 1); const safeValue = Math.max(0, Number(value) || 0);
        const percent = Math.min(100, Math.round(safeValue / safeMax * 100));
        return `<div class="rpg-meter rpg-meter-${kind}"><div class="rpg-meter-label"><span>${label}</span><b>${safeValue} / ${safeMax}</b></div><div class="rpg-meter-track"><span style="width:${percent}%"></span></div></div>`;
    }
    function pageHeading(kicker, title, extra = '') {
        return `<div class="rpg-page-heading"><div><span class="rpg-kicker">${kicker}</span><h3>${title}</h3></div>${extra}</div>`;
    }
    function renderOverview(state) {
        const p = state.player; const active = state.quests.filter(q => q.status !== 'completed' && !q.done).length;
        const latest = state.eventLog.slice(-4).reverse();
        const pendingMarkup = state.tracker.pending ? `<div class="rpg-pending-card"><b>มีข้อมูลเกมรอการยืนยันจาก AI Tracker</b><p>ความมั่นใจ ${Math.round((Number(state.tracker.pending.confidence) || 0) * 100)}%</p><button type="button" class="rpg-primary-button" data-action="apply-pending">ยืนยันและบันทึก</button></div>` : '';
        return `${pageHeading('หน้าหลัก', 'ภาพรวมการผจญภัย', `<span class="rpg-level-seal">LV. ${p.level}</span>`)}
          <section class="rpg-hero-card"><div class="rpg-hero-ornament">✦</div><div class="rpg-hero-label">ผู้ถือครองบันทึก</div><h4>${escapeHtml(p.name)}</h4><p>${escapeHtml(p.location || 'ยังไม่ระบุสถานที่')}</p>
            <div class="rpg-hero-stats"><div><small>เหรียญ</small><b>${p.gold.toLocaleString('th-TH')} G</b></div><div><small>ประสบการณ์</small><b>${p.exp.toLocaleString('th-TH')} EXP</b></div><div><small>ภารกิจค้าง</small><b>${active}</b></div><div><small>NPC</small><b>${state.relationships.length}</b></div></div>
          </section>${pendingMarkup}
          <div class="rpg-two-columns"><section class="rpg-panel"><h4>พลังชีวิต</h4>${meter('HP', p.hp, p.maxHp, 'hp')}</section><section class="rpg-panel"><h4>พลังเวท</h4>${meter('MP', p.mp, p.maxMp, 'mp')}</section></div>
          <div class="rpg-section-title">กิจกรรมล่าสุด</div>
          <div class="rpg-event-list">${latest.length ? latest.map(e => `<div class="rpg-event-row"><span class="rpg-event-dot"></span><div><b>${escapeHtml(e.title || 'เหตุการณ์')}</b><small>${escapeHtml(e.detail || '')}</small></div><time>${escapeHtml(e.time || '')}</time></div>`).join('') : '<div class="rpg-empty">บันทึกเหตุการณ์จะปรากฏเมื่อเริ่มผจญภัย</div>'}</div>
          <div class="rpg-shortcuts"><button type="button" data-tab="character">สถานะ <span>↗</span></button><button type="button" data-tab="relationships">ตัวละคร NPC <span>↗</span></button><button type="button" data-tab="assistant">ปรึกษาเรเวน <span>↗</span></button></div>
          <p class="rpg-hint">ข้อมูลนี้แยกตามห้องแชต · AI Tracker ${getSettings().autoTrack ? 'เปิดอยู่' : 'ปิดอยู่'}</p>`;
    }
    function renderCharacter(state) {
        const p = state.player;
        return `${pageHeading('ข้อมูลผู้เล่น', 'สถานะตัวละคร')}
          <form class="rpg-form" data-form="character">
            <div class="rpg-form-grid"><label>ชื่อตัวละคร<input name="name" maxlength="60" value="${escapeHtml(p.name)}"></label><label>สถานที่ปัจจุบัน<input name="location" maxlength="100" value="${escapeHtml(p.location)}"></label></div>
            <div class="rpg-form-grid"><label>เลเวล<input name="level" type="number" min="1" max="9999" value="${p.level}"></label><label>EXP<input name="exp" type="number" min="0" value="${p.exp}"></label><label>HP<input name="hp" type="number" min="0" value="${p.hp}"></label><label>HP สูงสุด<input name="maxHp" type="number" min="1" value="${p.maxHp}"></label><label>MP<input name="mp" type="number" min="0" value="${p.mp}"></label><label>MP สูงสุด<input name="maxMp" type="number" min="1" value="${p.maxMp}"></label><label>เงิน<input name="gold" type="number" min="0" value="${p.gold}"></label></div>
            <div class="rpg-section-title">ค่าสถานะพื้นฐาน</div><div class="rpg-form-grid rpg-form-grid-five">${[['str','STR'],['int','INT'],['agi','AGI'],['vit','VIT'],['luk','LUK']].map(([key,label]) => `<label>${label}<input name="${key}" type="number" min="0" value="${Number(p.stats[key]) || 0}"></label>`).join('')}</div>
            <button class="rpg-primary-button" type="submit">บันทึกสถานะ</button>
          </form>`;
    }
    function renderInventory(state) {
        return `${pageHeading('ทรัพย์สิน', 'กระเป๋าสัมภาระ', `<span class="rpg-count">${state.inventory.length} รายการ</span>`)}
          <form class="rpg-form rpg-add-form" data-form="item"><div class="rpg-form-grid"><label>ชื่อไอเทม<input name="name" required maxlength="80" placeholder="เช่น ดาบเงินจันทรา"></label><label>จำนวน<input name="quantity" type="number" min="1" value="1"></label><label>ประเภท<input name="category" maxlength="40" placeholder="อาวุธ / วัตถุดิบ"></label><label>ระดับความหายาก<select name="rarity"><option>ทั่วไป</option><option>ไม่ธรรมดา</option><option>หายาก</option><option>มหากาพย์</option><option>ตำนาน</option></select></label></div><label>คำอธิบาย<textarea name="description" rows="2" maxlength="400"></textarea></label><button class="rpg-primary-button" type="submit">＋ เพิ่มไอเทม</button></form>
          <div class="rpg-list">${state.inventory.length ? state.inventory.map(item => `<article class="rpg-item-card"><div class="rpg-item-icon">${escapeHtml((item.name || '?').slice(0,1))}</div><div class="rpg-item-main"><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.rarity || 'ทั่วไป')} · ${escapeHtml(item.category || 'ไม่มีประเภท')}</small><p>${escapeHtml(item.description || item.note || 'ไม่มีคำอธิบาย')}</p></div><strong>×${Number(item.quantity) || 1}</strong><button class="rpg-icon-button" data-action="remove-item" data-id="${escapeHtml(item.id)}" type="button">×</button></article>`).join('') : '<div class="rpg-empty">กระเป๋ายังว่างเปล่า</div>'}</div>`;
    }
    function renderQuests(state) {
        const active = state.quests.filter(q => (q.status || (q.done ? 'completed' : 'active')) === 'active');
        return `${pageHeading('เป้าหมาย', 'บันทึกภารกิจ', `<span class="rpg-count">${active.length} กำลังดำเนินการ</span>`)}
          <form class="rpg-form rpg-add-form" data-form="quest"><label>ชื่อภารกิจ<input name="title" required maxlength="120" placeholder="ระบุภารกิจ"></label><label>รายละเอียด<textarea name="description" rows="2" maxlength="400"></textarea></label><div class="rpg-form-grid"><label>ความคืบหน้า<input name="progress" type="number" min="0" value="0"></label><label>เป้าหมาย<input name="target" type="number" min="0" value="0"></label></div><label>รางวัล<input name="reward" maxlength="180" placeholder="รางวัล (ไม่บังคับ)"></label><button class="rpg-primary-button" type="submit">＋ เพิ่มภารกิจ</button></form>
          <div class="rpg-list">${state.quests.length ? state.quests.map(q => { const status = q.status || (q.done ? 'completed' : 'active'); return `<article class="rpg-quest-card ${status === 'completed' ? 'is-complete' : ''}"><div class="rpg-quest-head"><div><b>${escapeHtml(q.title || q.name)}</b><small>${escapeHtml(status === 'completed' ? 'สำเร็จ' : status === 'failed' ? 'ล้มเหลว' : 'กำลังดำเนินการ')}</small></div><button class="rpg-icon-button" data-action="remove-quest" data-id="${escapeHtml(q.id)}" type="button">×</button></div><p>${escapeHtml(q.description || '')}</p><div class="rpg-quest-progress"><span>${Number(q.progress) || 0}${q.target ? ` / ${q.target}` : ''}</span>${q.target ? `<div><i style="width:${clamp((Number(q.progress) || 0) / q.target * 100, 0, 100)}%"></i></div>` : ''}</div><div class="rpg-inline-actions"><button type="button" class="rpg-small-button" data-action="quest-status" data-id="${escapeHtml(q.id)}" data-status="active">ดำเนินการ</button><button type="button" class="rpg-small-button" data-action="quest-status" data-id="${escapeHtml(q.id)}" data-status="completed">สำเร็จ</button><button type="button" class="rpg-small-button" data-action="quest-status" data-id="${escapeHtml(q.id)}" data-status="failed">ล้มเหลว</button></div></article>`; }).join('') : '<div class="rpg-empty">ยังไม่มีภารกิจที่บันทึกไว้</div>'}</div>`;
    }
    function renderRelationships(state) {
        if (selectedNpcId) {
            const npc = state.relationships.find(item => item.id === selectedNpcId);
            if (npc) return renderNpcDetail(npc);
            selectedNpcId = null;
        }
        return `${pageHeading('ตัวละครในโลก', 'ทะเบียน NPC', `<span class="rpg-count">${state.relationships.length} คน</span>`)}
          <form class="rpg-form rpg-add-form" data-form="npc-create"><div class="rpg-form-grid"><label>ชื่อ NPC<input name="name" required maxlength="80" placeholder="ชื่อที่ใช้เรียก"></label><label>ตำแหน่ง / บทบาท<input name="role" maxlength="80" placeholder="เช่น องครักษ์"></label></div><label class="rpg-upload-label">รูปโปรไฟล์จากคลังภาพ<input name="avatar" type="file" accept="image/*"><small>เลือกจากคลังรูปภาพหรือถ่ายภาพใหม่ได้ · ระบบจะย่อรูปก่อนบันทึก</small></label><button class="rpg-primary-button" type="submit">＋ สร้างโปรไฟล์ NPC</button></form>
          <div class="rpg-npc-grid">${state.relationships.length ? state.relationships.map(npc => `<button type="button" class="rpg-npc-card" data-action="open-npc" data-id="${escapeHtml(npc.id)}"><div class="rpg-npc-avatar">${npc.avatar ? `<img src="${npc.avatar}" alt="">` : '<span>✦</span>'}</div><div class="rpg-npc-info"><b>${escapeHtml([npc.name,npc.surname].filter(Boolean).join(' '))}</b><small>${escapeHtml(npc.role || npc.alias || 'ยังไม่กำหนดบทบาท')}</small><span>${escapeHtml(npc.status)} · ${escapeHtml(npc.location || 'ไม่ระบุสถานที่')}</span><div class="rpg-mini-meter"><i style="width:${npc.relationship.affection}%"></i></div><small>ความชอบ ${npc.relationship.affection}/100</small></div><span class="rpg-npc-arrow">›</span></button>`).join('') : '<div class="rpg-empty">ยังไม่มี NPC · สร้างโปรไฟล์แรกได้ด้านบน หรือเปิด Auto Tracker ให้ AI ช่วยบันทึกตัวละคร</div>'}</div>`;
    }
    function renderRelationBar(label, key, value) {
        return `<label class="rpg-relation-control"><span>${label}<b>${value}/100</b></span><input type="range" name="${key}" min="0" max="100" value="${value}"></label>`;
    }
    function renderNpcDetail(npc) {
        const r = npc.relationship;
        return `<div class="rpg-npc-detail-head"><button class="rpg-back-button" type="button" data-action="back-npcs">‹ กลับรายชื่อ</button><span class="rpg-count">โปรไฟล์ตัวละคร</span></div>
          <form class="rpg-form rpg-npc-profile" data-form="npc-edit" data-id="${escapeHtml(npc.id)}">
            <div class="rpg-profile-top"><div class="rpg-profile-avatar">${npc.avatar ? `<img src="${npc.avatar}" alt="รูปโปรไฟล์">` : '<span>✦</span>'}</div><div class="rpg-profile-heading"><h3>${escapeHtml(npc.name)} ${escapeHtml(npc.surname)}</h3><p>${escapeHtml(npc.role || npc.alias || 'NPC')}</p><label class="rpg-upload-label">เปลี่ยนรูปโปรไฟล์<input name="avatar" type="file" accept="image/*"><small>เลือกจากคลังภาพ</small></label></div></div>
            <div class="rpg-section-title">ข้อมูลประจำตัว</div>
            <div class="rpg-form-grid"><label>ชื่อ<input name="name" value="${escapeHtml(npc.name)}" required maxlength="80"></label><label>นามสกุล<input name="surname" value="${escapeHtml(npc.surname)}" maxlength="80"></label><label>ฉายา<input name="alias" value="${escapeHtml(npc.alias)}" maxlength="100"></label><label>อายุ<input name="age" value="${escapeHtml(npc.age)}" maxlength="40"></label><label>เผ่าพันธุ์<input name="race" value="${escapeHtml(npc.race)}" maxlength="60"></label><label>อาชีพ / บทบาท<input name="role" value="${escapeHtml(npc.role)}" maxlength="100"></label><label>สังกัด<input name="faction" value="${escapeHtml(npc.faction)}" maxlength="100"></label><label>สถานะ<select name="status">${['มีชีวิต','เสียชีวิต','สูญหาย','ไม่ทราบ','อื่น ๆ'].map(x => `<option ${npc.status === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label><label class="rpg-grid-full">สถานที่ปัจจุบัน<input name="location" value="${escapeHtml(npc.location)}" maxlength="140"></label></div>
            <label>รูปลักษณ์<textarea name="appearance" rows="2" maxlength="1000">${escapeHtml(npc.appearance)}</textarea></label><label>บุคลิก<textarea name="personality" rows="2" maxlength="1000">${escapeHtml(npc.personality)}</textarea></label><label>ประวัติ / ภูมิหลัง<textarea name="backstory" rows="3" maxlength="1800">${escapeHtml(npc.backstory)}</textarea></label><label>บันทึกความสัมพันธ์<textarea name="summary" rows="2" maxlength="800">${escapeHtml(npc.summary)}</textarea></label>
            <div class="rpg-section-title">ค่าความสัมพันธ์</div><p class="rpg-hint">แต่ละค่าคำนวณแยกจากกัน NPC สามารถชอบผู้เล่นแต่ไม่ไว้วางใจ หรือกลัวแต่ยังเป็นศัตรูได้</p>
            ${renderRelationBar('ความชอบ', 'affection', r.affection)}${renderRelationBar('ความไว้ใจ', 'trust', r.trust)}${renderRelationBar('ความเคารพ', 'respect', r.respect)}${renderRelationBar('ความกลัว', 'fear', r.fear)}${renderRelationBar('ความเป็นปฏิปักษ์', 'hostility', r.hostility)}
            <button class="rpg-primary-button" type="submit">บันทึกโปรไฟล์</button>
          </form>
          <form class="rpg-form rpg-event-form" data-form="npc-event" data-id="${escapeHtml(npc.id)}"><div class="rpg-section-title">เพิ่มเหตุการณ์ที่เกิดขึ้นร่วมกัน</div><label>บันทึกเหตุการณ์<input name="event" maxlength="300" placeholder="เช่น ช่วยผู้เล่นจากการลอบโจมตี" required></label><button class="rpg-small-button" type="submit">＋ เพิ่มลงประวัติ</button></form>
          <div class="rpg-section-title">ประวัติความสัมพันธ์</div><div class="rpg-timeline">${npc.events.length ? npc.events.slice().reverse().map(e => `<div class="rpg-timeline-item"><i></i><div><b>${escapeHtml(e.title || e.detail || 'เหตุการณ์')}</b><small>${escapeHtml(e.time || '')}</small></div></div>`).join('') : '<div class="rpg-empty">ยังไม่มีประวัติ เหตุการณ์จะถูกเพิ่มโดย AI Tracker หรือบันทึกเองได้</div>'}</div>
          <button class="rpg-danger-button" type="button" data-action="remove-npc" data-id="${escapeHtml(npc.id)}">ลบโปรไฟล์ NPC</button>`;
    }

    function renderAssistant(state) {
        const settings = getSettings(); const name = settings.ravenName || 'เรเวน';
        const messages = state.assistantChat.slice(-40);
        return `<div class="rpg-assistant-profile"><div class="rpg-raven-avatar">${settings.ravenAvatar ? `<img src="${settings.ravenAvatar}" alt="">` : '<span>✦</span>'}</div><div><span class="rpg-kicker">SYSTEM COMPANION</span><h3>${escapeHtml(name)}</h3><small>ผู้ช่วยประจำ RPG Engine · สนทนาผ่านโมเดลที่เชื่อมกับ SillyTavern</small></div><span class="rpg-online-dot"></span></div>
          <div class="rpg-assistant-tools"><button type="button" data-action="raven-status">ตรวจสถานะเกม</button><button type="button" data-action="raven-quests">สรุปภารกิจ</button><button type="button" data-action="raven-npcs">วิเคราะห์ NPC</button></div>
          <div class="rpg-lorebook-note"><b>เชื่อมกับ Lorebook</b><p>เพิ่มรายการ World Info ชื่อเรเวนใน SillyTavern ได้ เมื่อรายการนี้ถูกเรียกใช้งาน โมเดลจะได้รับข้อมูลดังกล่าวร่วมกับบทสนทนาส่วนตัวของเรเวน</p><button type="button" class="rpg-small-button" data-action="copy-raven-lorebook">คัดลอกแนวทาง Lorebook</button></div>
          <div class="rpg-chat-log" id="rpg-raven-chat">${messages.length ? messages.map(m => `<div class="rpg-chat-message ${m.role === 'user' ? 'from-user' : 'from-raven'}"><small>${m.role === 'user' ? 'คุณ' : escapeHtml(name)}</small><div>${escapeHtml(m.text).replace(/\n/g, '<br>')}</div></div>`).join('') : `<div class="rpg-chat-welcome"><div class="rpg-welcome-sigil">✦</div><b>ยินดีต้อนรับกลับครับ</b><p>มีอะไรให้ผมช่วย วิเคราะห์ หรือจัดการให้หรือเปล่าครับ?</p><small>ผมจะอ่านบริบทของห้องแชตและ World Info ที่ SillyTavern เปิดใช้งานตามปกติ</small></div>`}</div>
          <form class="rpg-chat-compose" data-form="assistant-chat"><textarea name="message" rows="2" maxlength="1800" placeholder="คุยกับ${escapeHtml(name)}... เช่น ช่วยวิเคราะห์ความสัมพันธ์กับ NPC ให้หน่อย" required></textarea><button class="rpg-send-button" type="submit" ${assistantBusy ? 'disabled' : ''}>${assistantBusy ? 'กำลังคิด…' : 'ส่ง ↗'}</button></form>
          <p class="rpg-hint">บทสนทนานี้เป็นห้องส่วนตัวของผู้ช่วยใน Popup ไม่ถูกส่งเป็นข้อความในเนื้อเรื่องหลัก การตอบใช้โมเดล/API ปัจจุบัน และอาจใช้โควตาเพิ่มเติม</p>`;
    }
    function renderGameSettings() {
        const s = getSettings();
        return `${pageHeading('การตั้งค่า', 'ปรับแต่งระบบ')}
          <form class="rpg-form" data-form="raven-settings"><div class="rpg-section-title">ตัวตนผู้ช่วยระบบ</div><label>ชื่อผู้ช่วย<input name="ravenName" value="${escapeHtml(s.ravenName)}" maxlength="40"></label><label>บุคลิกและแนวทางการพูด<textarea name="ravenPersonality" rows="4" maxlength="1200">${escapeHtml(s.ravenPersonality)}</textarea></label><label class="rpg-upload-label">รูปโปรไฟล์ผู้ช่วย<input name="ravenAvatar" type="file" accept="image/*"><small>เลือกจากคลังรูปภาพ (ถ้าไม่เลือกจะใช้ตราสัญลักษณ์)</small></label><button class="rpg-primary-button" type="submit">บันทึกการตั้งค่าเรเวน</button></form>
          <div class="rpg-panel rpg-about-panel"><h4>ระบบอัตโนมัติ</h4><p>AI Tracker จะอ่านคำตอบของตัวละครหลังจบแต่ละเทิร์น แล้วเรียกโมเดลเบื้องหลังเพื่อดึงเฉพาะการเปลี่ยนแปลงที่เกิดขึ้นจริง จากนั้นจึงตรวจสอบและบันทึกข้อมูล</p><p>ค่าความสัมพันธ์ของ NPC ใช้ 0–100 แยก 5 มิติ ส่วนข้อมูลเกมจะเก็บแยกตามห้องแชต</p><div class="rpg-version-row"><span>รุ่นโปรแกรม</span><b>${VERSION}</b></div></div>`;
    }

    async function compressImage(file, maxSide = 560, maxBytes = 220000) {
        if (!file) return '';
        if (!file.type?.startsWith('image/')) throw new Error('กรุณาเลือกไฟล์รูปภาพ');
        if (file.size > 12 * 1024 * 1024) throw new Error('รูปใหญ่เกิน 12 MB');
        const sourceUrl = URL.createObjectURL(file);
        try {
            const image = new Image();
            await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = sourceUrl; });
            const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
            const ctx = canvas.getContext('2d');
            ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
            let quality = 0.82; let result = canvas.toDataURL('image/webp', quality);
            while (result.length > maxBytes * 1.38 && quality > 0.42) { quality -= 0.08; result = canvas.toDataURL('image/webp', quality); }
            if (result.length > maxBytes * 1.38) result = canvas.toDataURL('image/jpeg', 0.55);
            if (result.length > maxBytes * 1.38) throw new Error('รูปยังมีขนาดใหญ่เกินไป กรุณาเลือกรูปที่เล็กกว่านี้');
            return result;
        } finally { URL.revokeObjectURL(sourceUrl); }
    }
    function addEvent(title, detail) {
        const state = getState();
        state.eventLog.push({ id: makeId(), title, detail, time: new Date().toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' }) });
        state.eventLog = state.eventLog.slice(-100);
    }
    function getFormData(form) { return new FormData(form); }
    async function handleContentSubmit(event) {
        const form = event.target.closest('form[data-form]'); if (!form) return;
        event.preventDefault();
        const type = form.dataset.form; const data = getFormData(form); const state = getState();
        try {
            if (type === 'character') {
                const p = state.player; const num = key => Math.max(0, Number(data.get(key)) || 0);
                p.name = String(data.get('name') || 'ผู้เล่น').trim() || 'ผู้เล่น'; p.location = String(data.get('location') || '').trim();
                p.level = Math.max(1, num('level')); p.exp = num('exp'); p.maxHp = Math.max(1, num('maxHp')); p.maxMp = Math.max(1, num('maxMp'));
                p.hp = Math.min(p.maxHp, num('hp')); p.mp = Math.min(p.maxMp, num('mp')); p.gold = num('gold');
                for (const key of ['str','int','agi','vit','luk']) p.stats[key] = num(key);
                addEvent('แก้ไขสถานะผู้เล่น', 'อัปเดตข้อมูลตัวละครด้วยตนเอง');
            }
            if (type === 'item') {
                const name = String(data.get('name') || '').trim(); if (!name) return;
                const item = state.inventory.find(x => x.name.toLowerCase() === name.toLowerCase());
                if (item) item.quantity = (Number(item.quantity) || 0) + Math.max(1, Number(data.get('quantity')) || 1);
                else state.inventory.push({ id: makeId(), name, quantity: Math.max(1, Number(data.get('quantity')) || 1), category: String(data.get('category') || ''), rarity: String(data.get('rarity') || 'ทั่วไป'), description: String(data.get('description') || '').trim() });
                addEvent('ได้รับไอเทม', `${name} ×${Math.max(1, Number(data.get('quantity')) || 1)}`);
            }
            if (type === 'quest') {
                const title = String(data.get('title') || '').trim(); if (!title) return;
                state.quests.push({ id: makeId(), title, description: String(data.get('description') || ''), progress: Math.max(0, Number(data.get('progress')) || 0), target: Math.max(0, Number(data.get('target')) || 0), reward: String(data.get('reward') || ''), status: 'active', createdAt: new Date().toISOString() });
                addEvent('ได้รับภารกิจใหม่', title);
            }
            if (type === 'npc-create') {
                const name = String(data.get('name') || '').trim(); if (!name) return;
                const file = form.querySelector('input[name="avatar"]')?.files?.[0];
                const avatar = file ? await compressImage(file) : '';
                const npc = normalizeNpc({ id: makeId(), name, role: String(data.get('role') || ''), avatar });
                state.relationships.push(npc); selectedNpcId = npc.id; addEvent('พบตัวละครใหม่', name);
            }
            if (type === 'npc-edit') {
                const npc = state.relationships.find(x => x.id === form.dataset.id); if (!npc) return;
                for (const key of ['name','surname','alias','age','race','role','faction','status','location','appearance','personality','backstory','summary']) npc[key] = String(data.get(key) || '').trim();
                for (const key of ['affection','trust','respect','fear','hostility']) npc.relationship[key] = clamp(data.get(key), 0, 100);
                const file = form.querySelector('input[name="avatar"]')?.files?.[0]; if (file) npc.avatar = await compressImage(file);
                addEvent('อัปเดตโปรไฟล์ NPC', npc.name); notify('บันทึกโปรไฟล์ NPC แล้ว');
            }
            if (type === 'npc-event') {
                const npc = state.relationships.find(x => x.id === form.dataset.id); const text = String(data.get('event') || '').trim();
                if (!npc || !text) return;
                npc.events.push({ id: makeId(), title: text, time: new Date().toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' }) });
                npc.events = npc.events.slice(-80); addEvent(`เหตุการณ์กับ ${npc.name}`, text);
            }
            if (type === 'raven-settings') {
                const settings = getSettings(); settings.ravenName = String(data.get('ravenName') || 'เรเวน').trim();
                settings.ravenPersonality = String(data.get('ravenPersonality') || DEFAULT_SETTINGS.ravenPersonality).trim();
                const file = form.querySelector('input[name="ravenAvatar"]')?.files?.[0]; if (file) settings.ravenAvatar = await compressImage(file, 520, 180000);
                saveSettings(); notify('บันทึกข้อมูลผู้ช่วยแล้ว'); renderWindow(); return;
            }
            if (type === 'assistant-chat') {
                const message = String(data.get('message') || '').trim(); if (!message) return;
                state.assistantChat.push({ id: makeId(), role: 'user', text: message, time: new Date().toISOString() });
                state.assistantChat = state.assistantChat.slice(-80);
                await persistState(true); renderWindow();
                await askRaven(message);
                return;
            }
            await persistState(); renderWindow();
            if (type !== 'npc-edit') notify('บันทึกข้อมูลแล้ว');
        } catch (error) {
            console.error('[RPG Engine] form action failed', error); notify(error.message || 'ดำเนินการไม่สำเร็จ', 'error');
        }
    }
    async function handleContentChange(event) {
        const input = event.target;
        if (input.matches('[data-action="toggle-quest"]')) {
            const quest = getState().quests.find(q => q.id === input.dataset.id); if (quest) quest.status = input.checked ? 'completed' : 'active';
            await persistState(); renderWindow();
        }
        if (input.matches('.rpg-relation-control input[type="range"]')) {
            const form = input.closest('form[data-form="npc-edit"]'); const npc = getState().relationships.find(x => x.id === form?.dataset.id);
            if (npc) { npc.relationship[input.name] = clamp(input.value, 0, 100); input.previousElementSibling?.querySelector('b')?.replaceChildren(document.createTextNode(`${input.value}/100`)); await persistState(true); }
        }
    }
    async function handleContentClick(event) {
        const tab = event.target.closest('[data-tab]');
        if (tab) { activeTab = tab.dataset.tab; selectedNpcId = null; renderWindow(); return; }
        const button = event.target.closest('[data-action]'); if (!button) return;
        const { action, id } = button.dataset; const state = getState();
        if (action === 'close') { closeWindow(); return; }
        if (action === 'open-npc') { selectedNpcId = id; renderWindow(); return; }
        if (action === 'back-npcs') { selectedNpcId = null; renderWindow(); return; }
        if (action === 'remove-item') { state.inventory = state.inventory.filter(x => x.id !== id); addEvent('นำไอเทมออก', 'ลบไอเทมออกจากกระเป๋า'); }
        if (action === 'remove-quest') state.quests = state.quests.filter(x => x.id !== id);
        if (action === 'remove-npc') { const npc = state.relationships.find(x => x.id === id); state.relationships = state.relationships.filter(x => x.id !== id); selectedNpcId = null; if (npc) addEvent('ลบโปรไฟล์ NPC', npc.name); }
        if (action === 'quest-status') { const q = state.quests.find(x => x.id === id); if (q) { q.status = button.dataset.status; if (q.status === 'completed') q.progress = q.target || q.progress; addEvent('อัปเดตภารกิจ', `${q.title}: ${q.status}`); } }
        if (action === 'apply-pending') { const pending = state.tracker.pending; if (pending) { const changed = applyTrackerData(pending, true); state.tracker.lastResult = changed.length ? `ยืนยันแล้ว ${changed.length} รายการ` : 'ยืนยันแล้ว แต่ไม่มีการเปลี่ยนแปลง'; } }
        if (action === 'raven-status') { const p = state.player; await askRaven(`ช่วยตรวจสอบสถานะปัจจุบันของฉันแบบสรุป โดยดู HP ${p.hp}/${p.maxHp}, MP ${p.mp}/${p.maxMp}, เงิน ${p.gold}, เลเวล ${p.level} และค่าสถานะอื่น ๆ`); return; }
        if (action === 'raven-quests') { await askRaven('ช่วยสรุปภารกิจที่กำลังดำเนินการ จัดลำดับความสำคัญ และแนะนำว่าควรทำอะไรก่อน'); return; }
        if (action === 'raven-npcs') { await askRaven('ช่วยวิเคราะห์ความสัมพันธ์กับ NPC ทั้งหมดจากข้อมูลเกม จุดที่ควรระวังและคำแนะนำ'); return; }
        await persistState(); renderWindow();
    }

    function stateSummaryForRaven(state) {
        return JSON.stringify({ player: state.player, inventory: state.inventory, quests: state.quests, relationships: state.relationships.map(n => ({ name:n.name, role:n.role, faction:n.faction, status:n.status, relationship:n.relationship, summary:n.summary, events:n.events.slice(-8) })) }, null, 2);
    }
    function parseJsonFromText(value) {
        if (value && typeof value === 'object') {
            if (typeof value.text === 'string') value = value.text;
            else if (typeof value.result === 'string') value = value.result;
            else return value;
        }
        const text = String(value || '').trim();
        const candidates = [text];
        const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i); if (fenced) candidates.unshift(fenced[1].trim());
        for (const candidate of candidates) {
            try { return JSON.parse(candidate); } catch { /* extract a JSON object below */ }
            const start = candidate.indexOf('{'); if (start < 0) continue;
            let depth = 0; let quoted = false; let escaped = false;
            for (let i = start; i < candidate.length; i++) {
                const ch = candidate[i];
                if (quoted) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false; continue; }
                if (ch === '"') quoted = true;
                else if (ch === '{') depth++;
                else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(candidate.slice(start, i + 1)); } catch { break; } } }
            }
        }
        return null;
    }
    function parseAssistantPayload(raw) {
        const obj = parseJsonFromText(raw);
        if (obj && typeof obj === 'object' && typeof obj.reply === 'string') return obj;
        return { reply: typeof raw === 'string' ? raw : JSON.stringify(raw), actions: [] };
    }
    function applyRavenActions(actions = []) {
        const state = getState(); const applied = [];
        for (const action of Array.isArray(actions) ? actions.slice(0, 8) : []) {
            if (!action || typeof action !== 'object') continue;
            const value = Number(action.value) || 0;
            if (action.type === 'gold_delta') { state.player.gold = Math.max(0, state.player.gold + clamp(value, -100000, 100000)); applied.push(`เงิน ${value >= 0 ? '+' : ''}${value}`); }
            if (action.type === 'hp_delta') { state.player.hp = clamp(state.player.hp + clamp(value, -100000, 100000), 0, state.player.maxHp); applied.push(`HP ${value >= 0 ? '+' : ''}${value}`); }
            if (action.type === 'mp_delta') { state.player.mp = clamp(state.player.mp + clamp(value, -100000, 100000), 0, state.player.maxMp); applied.push(`MP ${value >= 0 ? '+' : ''}${value}`); }
            if (action.type === 'add_item' && String(action.name || '').trim()) {
                const name = String(action.name).trim(); const qty = clamp(action.quantity || 1, 1, 9999); const existing = state.inventory.find(i => i.name.toLowerCase() === name.toLowerCase());
                if (existing) existing.quantity += qty; else state.inventory.push({ id:makeId(), name, quantity:qty, category:'', rarity:'ทั่วไป', description:String(action.description || '') });
                applied.push(`เพิ่มไอเทม ${name} ×${qty}`);
            }
            if (action.type === 'add_quest' && String(action.name || '').trim()) {
                const name = String(action.name).trim(); if (!state.quests.some(q => (q.title || q.name).toLowerCase() === name.toLowerCase())) state.quests.push({ id:makeId(), title:name, description:String(action.description || ''), progress:0, target:0, reward:'', status:'active' });
                applied.push(`เพิ่มภารกิจ ${name}`);
            }
            if (action.type === 'npc_relation' && String(action.name || '').trim()) {
                const npc = state.relationships.find(n => n.name.toLowerCase() === String(action.name).trim().toLowerCase());
                if (npc) { for (const key of ['affection','trust','respect','fear','hostility']) npc.relationship[key] = clamp(npc.relationship[key] + clamp(action[key], -30, 30), 0, 100); applied.push(`ปรับความสัมพันธ์ ${npc.name}`); }
            }
        }
        if (applied.length) addEvent('เรเวนดำเนินการ', applied.join(' · '));
        return applied;
    }
    async function askRaven(message) {
        if (assistantBusy) { notify('เรเวนกำลังประมวลผลคำขอก่อนหน้า', 'warning'); return; }
        const ctx = getContext();
        if (typeof ctx?.generateQuietPrompt !== 'function') { notify('โฮสต์นี้ยังไม่รองรับ generateQuietPrompt', 'error'); return; }
        assistantBusy = true; renderWindow();
        const state = getState(); const settings = getSettings(); const name = settings.ravenName || 'เรเวน';
        const history = state.assistantChat.slice(-14).map(m => `${m.role === 'user' ? 'ผู้เล่น' : name}: ${m.text}`).join('\n');
        const prompt = `คุณคือ ${name} ผู้ช่วย AI ประจำ RPG Engine ที่กำลังสนทนาส่วนตัวกับผู้เล่น\nบุคลิก: ${settings.ravenPersonality}\nแนวทาง: ใช้ภาษาไทยธรรมชาติ ฉลาด กวนอย่างมีชั้นเชิง ตอบตรงคำถาม มีอารมณ์ขันได้เมื่อเหมาะสม แต่จริงจังและอ่อนโยนเมื่อจำเป็น ห้ามพูดแทนผู้เล่นหรือตัวละครอื่น ห้ามอ้างว่าดำเนินการสำเร็จถ้ายังไม่มี action ที่ถูกต้อง\n\nข้อมูลเกมที่เชื่อถือได้ (อ่านอย่างเดียว เว้นแต่จะส่ง action ที่ได้รับอนุญาต):\n${stateSummaryForRaven(state)}\n\nบทสนทนาส่วนตัวก่อนหน้า:\n${history || '(ยังไม่มี)'}\n\nข้อความล่าสุดจากผู้เล่น: ${message}\n\nตอบกลับเป็น JSON เพียง object เดียว รูปแบบ: {"reply":"คำตอบภาษาไทย","actions":[]}\nเมื่อผู้เล่นสั่งให้ดำเนินการที่ชัดเจนและทำได้ ให้ใส่ action ได้เฉพาะประเภทต่อไปนี้: {"type":"gold_delta","value":จำนวน}, {"type":"hp_delta","value":จำนวน}, {"type":"mp_delta","value":จำนวน}, {"type":"add_item","name":"ชื่อไอเทม","quantity":จำนวนเต็ม,"description":"คำอธิบาย"}, {"type":"add_quest","name":"ชื่อภารกิจ","description":"รายละเอียด"}, {"type":"npc_relation","name":"ชื่อตรงกับ NPC ที่มีอยู่","affection":-30ถึง30,"trust":-30ถึง30,"respect":-30ถึง30,"fear":-30ถึง30,"hostility":-30ถึง30}. หากเป็นเพียงการถาม ปรึกษา หรือการกระทำไม่ชัดเจน ให้ actions เป็น []. ห้ามสร้างรางวัล เงิน ไอเทม หรือเควสต์เองโดยไม่มีคำสั่งผู้เล่นที่ชัดเจน ห้ามทำ action เกิน 8 รายการ`;
        try {
            const raw = await ctx.generateQuietPrompt({ quietPrompt: prompt });
            const payload = parseAssistantPayload(raw);
            const applied = applyRavenActions(payload.actions || []);
            const reply = String(payload.reply || 'ระบบไม่สามารถสร้างคำตอบได้').trim();
            state.assistantChat.push({ id:makeId(), role:'assistant', text: reply + (applied.length ? `\n\n[ระบบดำเนินการแล้ว: ${applied.join(' · ')}]` : ''), time:new Date().toISOString() });
            state.assistantChat = state.assistantChat.slice(-80);
            await persistState(true);
        } catch (error) {
            console.error('[RPG Engine] Raven generation failed', error);
            state.assistantChat.push({ id:makeId(), role:'assistant', text:`ขออภัยครับ ระบบเชื่อมต่อโมเดลไม่สำเร็จ: ${error.message || error}`, time:new Date().toISOString() });
            await persistState(true);
        } finally { assistantBusy = false; if (isOpen && activeTab === 'assistant') renderWindow(); }
    }

    const TRACKER_SCHEMA_PROMPT = `คุณคือ RPG Engine AI Tracker ทำหน้าที่สกัดการเปลี่ยนแปลงของสถานะเกมจากข้อความตอบล่าสุดของ AI เท่านั้น\nกฎเคร่งครัด:\n1. อ่านเหตุการณ์ในข้อความตอบล่าสุดและบริบทสนทนาก่อนหน้าเพื่อเข้าใจเหตุการณ์ แต่ห้ามตีความแผน/ความคิด/สมมติฐาน/คำพูดอ้างอิงเป็นสิ่งที่เกิดขึ้นแล้ว\n2. บันทึกเฉพาะการเปลี่ยนแปลงที่เกิดขึ้นจริงและมีหลักฐานในเนื้อเรื่อง ห้ามแต่งตัวเลข รางวัล ไอเทม หรือความสัมพันธ์ขึ้นเอง\n3. playerDelta ใช้ค่าที่เปลี่ยนแปลง (delta) เช่น HP ลด 10 ให้ hp=-10 หากไม่มีการเปลี่ยนแปลงให้ 0\n4. เพิ่มไอเทมเฉพาะเมื่อได้รับจริง ลบเมื่อใช้/สูญเสียจริง เพิ่มภารกิจเมื่อได้รับ/ประกาศภารกิจจริง\n5. npcAdd ใช้เฉพาะ NPC ใหม่ที่มีบทบาทชัดเจนในเรื่อง ไม่สร้างตัวละครฉากหลังที่ไม่มีความสำคัญ\n6. npcUpdates ใช้เฉพาะ NPC ที่ระบุชื่อชัดเจนและมีอยู่ในรายชื่อปัจจุบัน ความสัมพันธ์ใช้ delta ไม่ใช่ค่ารวม\n7. ความมั่นใจ 0.0–1.0 ถ้าหลักฐานไม่ชัดให้ confidence ต่ำกว่า 0.78 และไม่ควรเสนอการเปลี่ยนแปลง\n8. คืน JSON object อย่างเดียว ไม่มี Markdown ไม่มีคำอธิบาย\n\nรูปแบบ JSON ที่ต้องส่ง:\n{"confidence":0.0,"playerDelta":{"hp":0,"mp":0,"exp":0,"gold":0,"location":""},"itemsAdd":[{"name":"","quantity":1,"category":"","rarity":"ทั่วไป","description":""}],"itemsRemove":[{"name":"","quantity":1}],"questsAdd":[{"title":"","description":"","reward":""}],"questsUpdate":[{"title":"","status":"active","progress":0,"target":0}],"npcAdd":[{"name":"","role":"","faction":"","appearance":"","personality":"","location":"","summary":""}],"npcUpdates":[{"name":"","affection":0,"trust":0,"respect":0,"fear":0,"hostility":0,"location":"","summary":"","event":""}],"events":[{"title":"","detail":""}]}\nทุก field ต้องมีอยู่เสมอ หากไม่มีการเปลี่ยนแปลงให้ส่ง array ว่างและตัวเลข 0`;

    function applyTrackerData(data, force = false) {
        if (!data || typeof data !== 'object') return [];
        const confidence = clamp(data.confidence, 0, 1); const settings = getSettings();
        if (confidence < settings.trackerConfidence) return [];
        if (!settings.autoApply && !force) { getState().tracker.pending = clone(data); getState().tracker.lastResult = `ตรวจพบเหตุการณ์ (ความมั่นใจ ${Math.round(confidence * 100)}%) แต่รออนุมัติ`; return []; }
        const state = getState(); state.tracker.pending = null; const changed = []; const d = data.playerDelta || {};
        const applyDelta = (key, min, max) => {
            const delta = Number(d[key]) || 0; if (!delta) return;
            const old = Number(state.player[key]) || 0; state.player[key] = clamp(old + delta, min, max); changed.push(`${key} ${delta > 0 ? '+' : ''}${delta}`);
        };
        applyDelta('hp', 0, state.player.maxHp); applyDelta('mp', 0, state.player.maxMp); applyDelta('exp', 0, 999999999); applyDelta('gold', 0, 999999999);
        if (String(d.location || '').trim() && state.player.location !== d.location.trim()) { state.player.location = d.location.trim(); changed.push('เปลี่ยนสถานที่'); }
        for (const item of Array.isArray(data.itemsAdd) ? data.itemsAdd.slice(0, 12) : []) {
            const name = String(item.name || '').trim(); if (!name) continue;
            const qty = clamp(item.quantity || 1, 1, 9999); const existing = state.inventory.find(x => x.name.toLowerCase() === name.toLowerCase());
            if (existing) existing.quantity += qty;
            else state.inventory.push({ id:makeId(), name, quantity:qty, category:String(item.category || ''), rarity:String(item.rarity || 'ทั่วไป'), description:String(item.description || '') });
            changed.push(`ได้รับ ${name} ×${qty}`);
        }
        for (const item of Array.isArray(data.itemsRemove) ? data.itemsRemove.slice(0, 12) : []) {
            const name = String(item.name || '').trim(); if (!name) continue; const existing = state.inventory.find(x => x.name.toLowerCase() === name.toLowerCase());
            if (existing) { existing.quantity -= clamp(item.quantity || 1, 1, 9999); if (existing.quantity <= 0) state.inventory = state.inventory.filter(x => x.id !== existing.id); changed.push(`ใช้/สูญเสีย ${name}`); }
        }
        for (const q of Array.isArray(data.questsAdd) ? data.questsAdd.slice(0, 8) : []) {
            const title = String(q.title || '').trim(); if (!title || state.quests.some(x => (x.title || x.name).toLowerCase() === title.toLowerCase())) continue;
            state.quests.push({ id:makeId(), title, description:String(q.description || ''), reward:String(q.reward || ''), progress:0, target:0, status:'active' }); changed.push(`ภารกิจใหม่: ${title}`);
        }
        for (const q of Array.isArray(data.questsUpdate) ? data.questsUpdate.slice(0, 8) : []) {
            const title = String(q.title || '').trim(); const quest = state.quests.find(x => (x.title || x.name).toLowerCase() === title.toLowerCase()); if (!quest) continue;
            if (['active','completed','failed'].includes(q.status)) quest.status = q.status;
            if (Number.isFinite(Number(q.progress))) quest.progress = Math.max(0, Number(q.progress));
            if (Number.isFinite(Number(q.target)) && Number(q.target) > 0) quest.target = Number(q.target);
            changed.push(`อัปเดตภารกิจ: ${title}`);
        }
        for (const n of Array.isArray(data.npcAdd) ? data.npcAdd.slice(0, 8) : []) {
            const name = String(n.name || '').trim(); if (!name || state.relationships.some(x => x.name.toLowerCase() === name.toLowerCase())) continue;
            state.relationships.push(normalizeNpc({ id:makeId(), ...n })); changed.push(`บันทึก NPC: ${name}`);
        }
        for (const n of Array.isArray(data.npcUpdates) ? data.npcUpdates.slice(0, 12) : []) {
            const name = String(n.name || '').trim(); const npc = state.relationships.find(x => x.name.toLowerCase() === name.toLowerCase()); if (!npc) continue;
            for (const key of ['affection','trust','respect','fear','hostility']) { const delta = clamp(n[key], -25, 25); if (delta) { npc.relationship[key] = clamp(npc.relationship[key] + delta, 0, 100); changed.push(`${npc.name}: ${key} ${delta > 0 ? '+' : ''}${delta}`); } }
            if (String(n.location || '').trim()) npc.location = String(n.location).trim();
            if (String(n.summary || '').trim()) npc.summary = String(n.summary).trim();
            if (String(n.event || '').trim()) npc.events.push({ id:makeId(), title:String(n.event).trim(), time:new Date().toLocaleString('th-TH', { dateStyle:'short', timeStyle:'short' }) });
        }
        for (const e of Array.isArray(data.events) ? data.events.slice(0, 8) : []) {
            const title = String(e.title || '').trim(); if (title) { addEvent(title, String(e.detail || '')); changed.push(title); }
        }
        state.tracker.lastResult = changed.length ? `อัปเดต ${changed.length} รายการ · ${Math.round(confidence * 100)}%` : `ตรวจแล้ว ไม่พบการเปลี่ยนแปลง · ${Math.round(confidence * 100)}%`;
        return changed;
    }
    function lastAiMessage() {
        const chat = getContext()?.chat;
        if (!Array.isArray(chat) || !chat.length) return null;
        for (let i = chat.length - 1; i >= 0; i--) {
            const message = chat[i];
            if (message && message.is_user !== true && message.is_system !== true && typeof message.mes === 'string' && message.mes.trim()) return { message, index:i };
        }
        return null;
    }
    function signatureForMessage(item) {
        const text = item.message.mes || '';
        let hash = 2166136261;
        for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
        return `${item.index}:${text.length}:${(hash >>> 0).toString(16)}`;
    }
    async function runAutoTracker() {
        const settings = getSettings(); if (!settings.autoTrack || trackerBusy) return;
        const ctx = getContext(); if (typeof ctx?.generateQuietPrompt !== 'function') return;
        const last = lastAiMessage(); if (!last) return;
        const signature = signatureForMessage(last); const state = getState();
        if (state.tracker.lastSignature === signature) return;
        trackerBusy = true;
        if (isOpen) updateFooter('AI Tracker กำลังวิเคราะห์เหตุการณ์…');
        try {
            const prompt = `${TRACKER_SCHEMA_PROMPT}\n\nสถานะเกมปัจจุบัน (ใช้เป็นค่าตั้งต้น ห้ามเปลี่ยนส่วนที่ไม่เกี่ยวข้อง):\n${stateSummaryForRaven(state)}\n\nข้อความตอบล่าสุดของ AI ที่ต้องวิเคราะห์:\n${last.message.mes}\n\nคืน JSON ตาม schema เท่านั้น`;
            const raw = await ctx.generateQuietPrompt({ quietPrompt: prompt });
            const data = parseJsonFromText(raw);
            if (!data) throw new Error('โมเดลส่งผลลัพธ์ที่ไม่ใช่ JSON');
            state.tracker.lastSignature = signature;
            state.tracker.lastRunAt = new Date().toISOString();
            const changed = applyTrackerData(data);
            await persistState(true);
            if (isOpen) { renderWindow(); updateFooter(state.tracker.lastResult); }
            if (changed.length) console.info('[RPG Engine] AI Tracker updated:', changed);
        } catch (error) {
            console.warn('[RPG Engine] AI Tracker failed', error);
            getState().tracker.lastResult = `วิเคราะห์ไม่สำเร็จ: ${error.message || error}`;
            await persistState(true);
            if (isOpen) updateFooter('AI Tracker ไม่สำเร็จ · ตรวจสอบการเชื่อมต่อโมเดล');
        } finally { trackerBusy = false; }
    }

    function onMessageReceived() {
        // MESSAGE_RECEIVED is emitted after the AI message is recorded but before it is rendered.
        // Delay one tick so the latest chat entry is stable on hosted/mobile builds.
        setTimeout(() => { runAutoTracker(); }, 250);
    }
    function onChatChanged() {
        selectedNpcId = null; syncPromptInjection();
        if (isOpen) renderWindow();
    }
    function onMessageEditedOrSwiped() {
        syncPromptInjection();
        // The edited/swiped response is re-analysed only when a new MESSAGE_RECEIVED is emitted.
    }
    function registerEvents() {
        const ctx = getContext(); if (!ctx?.eventSource || !ctx?.event_types) return;
        const events = ctx.event_types;
        if (events.MESSAGE_RECEIVED) ctx.eventSource.on(events.MESSAGE_RECEIVED, onMessageReceived);
        if (events.CHAT_CHANGED) ctx.eventSource.on(events.CHAT_CHANGED, onChatChanged);
        if (events.MESSAGE_EDITED) ctx.eventSource.on(events.MESSAGE_EDITED, onMessageEditedOrSwiped);
        if (events.MESSAGE_SWIPED) ctx.eventSource.on(events.MESSAGE_SWIPED, onMessageEditedOrSwiped);
    }
    function start() {
        mountUi(); registerEvents(); syncPromptInjection(); updateSettingsPanel();
        console.info(`[RPG Engine] loaded v${VERSION}`);
    }
    if (globalThis.jQuery) globalThis.jQuery(start);
    else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once:true });
    else start();
})();
