document.addEventListener('DOMContentLoaded', () => {

    // =============================================================================
    // 1. CONFIGURATION & STATE
    // =============================================================================
    
    // DOM Elements
    const authScreen = document.getElementById('auth-screen');
    const dashboardContainer = document.getElementById('dashboard-container');
    const sidebarPlaceholder = document.getElementById('sidebar-placeholder');
    const mainContentArea = document.getElementById('main-content');
    const authMessage = document.getElementById('auth-message');

    // H-1: HTML escape helper — use on ALL server-supplied strings before injecting into innerHTML
    const escHtml = (s) => String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    // H-2: apiFetch — token is now an HttpOnly cookie, sent automatically by the browser.
    // We no longer read or set auth_token in localStorage.
    const apiFetch = async (url, options = {}) => {
        const headers = {
            'Content-Type': 'application/json',
            ...(options.headers || {}),
        };

        // credentials:'include' tells the browser to send the HttpOnly auth cookie
        const res = await fetch(url, { ...options, headers, credentials: 'include' });

        // If session expired, clear user info and reload to the login screen
        if (res.status === 401) {
            const wasLoggedIn = !!localStorage.getItem('auth_user');
            if (wasLoggedIn) {
                localStorage.removeItem('auth_user');
                location.reload();
            }
            throw new Error('Session expired');
        }

        return res;
    };

    // ─── TOAST NOTIFICATION SYSTEM ──────────────────────────────────────────────
    // Replaces browser alert() with non-blocking in-app toasts.
    // Usage: showToast('message', 'success'|'error'|'info')
    (() => {
        const container = document.createElement('div');
        container.id = 'toast-container';
        container.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999;display:flex;flex-direction:column;gap:10px;pointer-events:none;max-width:360px;';
        document.body.appendChild(container);
    })();

    window.showToast = (message, type = 'info', duration = 3500) => {
        const container = document.getElementById('toast-container');
        if (!container) return;
        const colors = {
            success: { bg: '#1a2e1a', border: '#4ade80', icon: '✓', text: '#4ade80' },
            error:   { bg: '#2e1a1a', border: '#f87171', icon: '✕', text: '#f87171' },
            info:    { bg: '#1a1f2e', border: '#FFDB89', icon: 'ℹ', text: '#FFDB89' },
        };
        const c = colors[type] || colors.info;
        const toast = document.createElement('div');
        toast.style.cssText = `background:${c.bg};border:1px solid ${c.border}40;border-left:3px solid ${c.border};border-radius:10px;padding:12px 16px;display:flex;align-items:flex-start;gap:10px;box-shadow:0 4px 24px rgba(0,0,0,0.5);pointer-events:all;transition:opacity 0.3s,transform 0.3s;opacity:0;transform:translateX(20px);`;
        toast.innerHTML = `<span style="color:${c.text};font-weight:700;font-size:15px;line-height:1;margin-top:1px">${c.icon}</span><span style="color:#e5e5e5;font-size:13px;line-height:1.4;flex:1">${message}</span><button onclick="this.parentElement.remove()" style="color:#ffffff40;font-size:16px;line-height:1;background:none;border:none;cursor:pointer;padding:0;margin-left:4px;pointer-events:all">&times;</button>`;
        container.appendChild(toast);
        requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateX(0)'; });
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(20px)';
            setTimeout(() => toast.remove(), 300);
        }, duration);
    };
    // ─────────────────────────────────────────────────────────────────────────────

    // ─── CONFIRM DIALOG ──────────────────────────────────────────────────────────
    // Usage: const yes = await showConfirm('¿Eliminar?');  // returns true/false
    window.showConfirm = (message, { confirmLabel = 'Confirmar', cancelLabel = 'Cancelar', danger = true } = {}) => {
        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);';
            const btnColor = danger ? '#f87171' : '#FFDB89';
            const btnBg    = danger ? 'rgba(248,113,113,0.15)' : 'rgba(255,219,137,0.15)';
            overlay.innerHTML = `
                <div style="background:#1C1C1E;border:1px solid #FFDB89/20;border-radius:16px;padding:28px 32px;max-width:360px;width:90%;box-shadow:0 24px 60px rgba(0,0,0,0.7);text-align:center;">
                    <p style="color:#e5e5e5;font-size:15px;line-height:1.5;margin:0 0 24px;">${message}</p>
                    <div style="display:flex;gap:12px;justify-content:center;">
                        <button id="sc-cancel" style="flex:1;padding:10px 16px;border-radius:10px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.05);color:#aaa;font-size:14px;cursor:pointer;">${cancelLabel}</button>
                        <button id="sc-confirm" style="flex:1;padding:10px 16px;border-radius:10px;border:1px solid ${btnColor}40;background:${btnBg};color:${btnColor};font-weight:700;font-size:14px;cursor:pointer;">${confirmLabel}</button>
                    </div>
                </div>`;
            document.body.appendChild(overlay);
            const cleanup = val => { overlay.remove(); resolve(val); };
            overlay.querySelector('#sc-confirm').addEventListener('click', () => cleanup(true));
            overlay.querySelector('#sc-cancel').addEventListener('click',  () => cleanup(false));
            overlay.addEventListener('click', e => { if (e.target === overlay) cleanup(false); });
        });
    };
    // ─────────────────────────────────────────────────────────────────────────────

    // --- DATA STORES ---
    let clientsCache = [];
    let programsCache = [];
    let globalExerciseLibrary = [];
    let groupsCache = [];

    // --- STATE VARIABLES ---
    const MODULE_CACHE = {}; 
    let currentWeekCount = 0;
    let exerciseCount = 0;
    let dayNutritionState = { weekIndex: 0, dayNum: 0, targets: { cal: 2200, p: 160, c: 220, f: 65 }, meals: [] };
    let currentProgramId = null;
    let copiedProgramDayData = null; // stores a day's data for copy/paste in program builder
    let currentEditingDay = null; 
    let currentEditingWeekIndex = 0;
    let currentVideoExerciseBtn = null;
    let currentVideoTarget = null;   // null = exercise btn, 'warmup', 'cooldown'
    let routineWarmupVideo = '';
    let routineCooldownVideo = '';
    let routineWarmupItems = [];     // [{id, name, videoUrl}] — per-item rows in program builder
    let routineCooldownItems = [];   // [{id, name, videoUrl}]
    let currentClientViewId = null;
    let currentNotifFilter = '7days';
    let copiedWorkoutData = null; // Store copied workout (single day)
    let copiedMultiDayData = null; // Store copied multi-day workouts with spacing
    let selectedCopyDays = new Set(); // Track selected days for multi-day copy

    // NEW: Workout Editor State (For the Orange Modal)
    let editorExercises = [];
    let editorDateStr = "";
    let editorWarmup = ""; // State for Warmup Text
    let editorWarmupVideoUrl = ""; // State for Warmup Video URL
    let editorWarmupItems = []; // Individual warmup exercises [{id, name, videoUrl}]
    let editorWorkoutTitle = "";
    let editorCooldown = "";
    let editorCooldownVideoUrl = ""; // State for Cooldown Video URL
    let editorCooldownItems = []; // Individual cooldown exercises [{id, name, videoUrl}]
    let currentEditorExId = null; // Track which exercise is being edited for Video/History
    let editorIsDirty = false;
    let editorAutosaveInterval = null;
    let editorIsComplete = false;
    let editorIsMissed   = false;
    let editorHistory = []; // undo stack — snapshots of editor state

    // MUSCLE GROUPS DEFINITION
    const muscleGroups = [
        "Pecho", "Espalda", "Piernas", "Quadriceps", "Femorales", "Tibiales", 
        "Pantorrillas", "Glúteos", "Triceps", "Biceps", "Hombros", "Antebrazos", 
        "Empuje", "Halón", "Abdomen", "Espalda Baja", "Calentamientos", "Cardio"
    ];

    // =============================================================================
    // 2. PERSISTENCE & SESSION
    // =============================================================================

    const saveData = () => {
        // Groups now saved via API (kept for backward compat)
    };

    const fetchGroupsFromDB = async () => {
        try {
            const res = await apiFetch('/api/groups');
            if (res.ok) {
                const groups = await res.json();
                groupsCache = groups.map(g => g.name);
                // Ensure 'General' always exists
                if (!groupsCache.includes('General')) groupsCache.unshift('General');
            }
        } catch (e) { console.error('Error fetching groups:', e); }
    };

    const loadData = () => {
        fetchLibraryFromDB();
        fetchClientsFromDB();
        fetchProgramsFromDB();
        fetchGroupsFromDB();
    };

    const fetchClientsFromDB = async () => {
        try {
            const res = await apiFetch('/api/clients');
            if(res.ok) {
                clientsCache = await res.json();
                if(typeof window.renderClientsTable === 'function') {
                    window.renderClientsTable();
                }
            }
        } catch(e) { console.error("Error cargando clientes:", e); }
    };

    const fetchLibraryFromDB = async () => {
        try {
            const res = await apiFetch('/api/library');
            if(res.ok) globalExerciseLibrary = await res.json();
        } catch(e) { console.error("Error cargando librería:", e); }
    };

    const fetchProgramsFromDB = async () => {
        try {
            const res = await apiFetch('/api/programs');
            if(res.ok) programsCache = await res.json();
        } catch(e) { console.error("Error cargando programas:", e); }
    };

    // =============================================================================
    // NOTIFICATION FUNCTIONS
    // =============================================================================

    let notificationPollInterval = null;

    const fetchNotificationCount = async () => {
        try {
            const res = await apiFetch('/api/notifications/unread-count');
            if (res.ok) {
                const { count } = await res.json();
                const badge = document.getElementById('notification-badge');
                if (badge) {
                    badge.textContent = count;
                    if (count > 0) {
                        badge.classList.remove('hidden');
                    } else {
                        badge.classList.add('hidden');
                    }
                }
            }
        } catch (e) { /* silently ignore — user may not be logged in */ }
    };

    const fetchAndRenderNotifications = async (filter) => {
        if (filter !== undefined) currentNotifFilter = filter;
        try {
            const res = await apiFetch('/api/notifications');
            if (res.ok) {
                let notifications = await res.json();
                const feed = document.getElementById('activity-feed');
                const loading = document.getElementById('notifications-loading');
                const empty = document.getElementById('notifications-empty');
                if (!feed) return;
                if (loading) loading.classList.add('hidden');
                // Apply filter
                if (currentNotifFilter === '7days') {
                    const sevenDaysAgo = new Date();
                    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
                    notifications = notifications.filter(n => new Date(n.createdAt) >= sevenDaysAgo);
                } else if (currentNotifFilter === 'unread') {
                    notifications = notifications.filter(n => !n.isRead);
                }
                if (notifications.length === 0) {
                    const emptyMsg = currentNotifFilter === 'unread'
                        ? 'No tienes notificaciones sin leer.'
                        : 'No hay actividad de clientes en los últimos 7 días.';
                    feed.innerHTML = `<div class="flex flex-col items-center justify-center py-14 gap-3 text-[#FFDB89]/30">
                        <i class="fas fa-bell-slash text-4xl"></i>
                        <p class="text-sm font-medium">${emptyMsg}</p>
                    </div>`;
                    return;
                }
                feed.innerHTML = notifications.map(n => renderNotificationItem(n)).join('');
            }
        } catch (e) { console.error('Error fetching notifications:', e); }
    };

    const renderNotificationItem = (n) => {
        const config = getNotificationConfig(n.type);
        const timeAgo = getTimeAgo(new Date(n.createdAt));
        const unreadDot = !n.isRead ? `<span class="w-2 h-2 rounded-full shrink-0 mt-1.5 ml-3" style="background:${config.color}"></span>` : '';
        // H-1+M-8: escHtml on all server-supplied strings in attribute and content contexts
        const safeId       = escHtml(n._id);
        const safeClientId = escHtml(n.clientId);
        const clickHandler = !n.isRead ? `onclick="window.markNotificationRead('${safeId}')"` : '';
        const readOpacity = n.isRead ? 'opacity-50' : 'cursor-pointer hover:border-[#FFDB89]/30';

        // contact_inquiry has no linked client profile — render name as plain text
        const isContact = n.type === 'contact_inquiry';
        const nameHtml = isContact
            ? `<span class="font-semibold text-[#FFDB89]">${escHtml(n.clientName)}</span>`
            : `<span class="cursor-pointer hover:underline decoration-[#FFDB89]/40"
                     onclick="event.stopPropagation(); window.openClientProfile('${safeClientId}')">${escHtml(n.clientName)}</span>`;

        return `
            <div class="flex items-start p-4 glass-chip rounded-xl border-l-4 ${readOpacity} transition-all"
                 style="border-left-color: ${config.color}"
                 data-notification-id="${safeId}" ${clickHandler}>
                <i class="${config.icon} mt-0.5 mr-4 text-lg shrink-0" style="color:${config.color}"></i>
                <div class="flex-grow min-w-0">
                    <p class="font-semibold text-[#FFDB89] text-sm leading-snug">
                        ${nameHtml}
                        <span class="font-normal text-[#FFDB89]/70"> ${escHtml(n.title)}</span>
                    </p>
                    <p class="text-xs text-[#FFDB89]/50 mt-0.5 truncate">${escHtml(n.message)}</p>
                    <p class="text-[11px] text-[#FFDB89]/30 mt-1">${timeAgo}</p>
                </div>
                ${unreadDot}
            </div>
        `;
    };

    const getNotificationConfig = (type) => {
        const configs = {
            workout_completed: { icon: 'fas fa-check-circle',        color: '#6EE7B7' },
            workout_missed:    { icon: 'fas fa-calendar-times',       color: '#F87171' },
            weight_update:     { icon: 'fas fa-weight-scale',         color: '#FFDB89' },
            nutrition_logged:  { icon: 'fas fa-utensils',             color: '#FB923C' },
            progress_photos:   { icon: 'fas fa-camera',               color: '#F472B6' },
            metric_resistance: { icon: 'fas fa-chart-line',           color: '#34D399' },
            metric_inactivity: { icon: 'fas fa-clock',                color: '#FBBF24' },
            workout_comment:   { icon: 'fas fa-comment-dots',         color: '#92A9E1' },
            video_upload:      { icon: 'fas fa-video',                color: '#A78BFA' },
            reported_issue:    { icon: 'fas fa-triangle-exclamation', color: '#FB923C' },
            program_assigned:  { icon: 'fas fa-dumbbell',             color: '#FFDB89' },
            client_created:    { icon: 'fas fa-user-plus',            color: '#92A9E1' },
            rpe_submitted:     { icon: 'fas fa-fire',                 color: '#FB923C' },
            contact_inquiry:   { icon: 'fas fa-envelope-open-text',   color: '#34D399' }
        };
        return configs[type] || { icon: 'fas fa-bell', color: '#FFDB89' };
    };

    const getTimeAgo = (date) => {
        const seconds = Math.floor((new Date() - date) / 1000);
        if (seconds < 60) return 'Hace un momento';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `Hace ${minutes} min`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `Hace ${hours}h`;
        const days = Math.floor(hours / 24);
        if (days === 1) return 'Hace 1 dia';
        return `Hace ${days} dias`;
    };

    // Global functions for notification actions
    window.markNotificationRead = async (id) => {
        try {
            await apiFetch(`/api/notifications/${id}/read`, { method: 'PUT' });
            fetchNotificationCount();
            fetchAndRenderNotifications();
        } catch (e) { console.error(e); }
    };

    window.markAllNotificationsRead = async () => {
        try {
            await apiFetch('/api/notifications/read-all', { method: 'PUT' });
            fetchNotificationCount();
            fetchAndRenderNotifications();
        } catch (e) { console.error(e); }
    };

    // =============================================================================
    // SETTINGS FUNCTIONS
    // =============================================================================

    // ── Muscle group definitions for injury map ───────────────────────────────
    const MUSCLE_DEFS = {
        front: [
            { id:'shoulders',   name:'Hombros',            shapes:[{type:'ellipse',cx:150,cy:86,rx:12,ry:10},{type:'ellipse',cx:30,cy:86,rx:12,ry:10}] },
            { id:'chest',       name:'Pecho',              shapes:[{type:'ellipse',cx:90,cy:115,rx:27,ry:21}] },
            { id:'biceps',      name:'Bíceps',             shapes:[{type:'ellipse',cx:150,cy:140,rx:10,ry:20},{type:'ellipse',cx:30,cy:140,rx:10,ry:20}] },
            { id:'forearms',    name:'Antebrazos',         shapes:[{type:'ellipse',cx:148,cy:200,rx:9,ry:16},{type:'ellipse',cx:32,cy:200,rx:9,ry:16}] },
            { id:'abs',         name:'Abdomen',            shapes:[{type:'ellipse',cx:90,cy:175,rx:20,ry:32}] },
            { id:'obliques',    name:'Oblicuos',           shapes:[{type:'ellipse',cx:68,cy:175,rx:9,ry:28},{type:'ellipse',cx:112,cy:175,rx:9,ry:28}] },
            { id:'hip_flexors', name:'Flexores de cadera', shapes:[{type:'ellipse',cx:90,cy:286,rx:22,ry:12}] },
            { id:'quads',       name:'Cuádriceps',         shapes:[{type:'ellipse',cx:76,cy:370,rx:14,ry:50},{type:'ellipse',cx:103,cy:370,rx:14,ry:50}] },
            { id:'tibialis',    name:'Tibiales',           shapes:[{type:'ellipse',cx:77,cy:460,rx:9,ry:26},{type:'ellipse',cx:103,cy:460,rx:9,ry:26}] },
        ],
        back: [
            { id:'traps',       name:'Trapecio',           shapes:[{type:'ellipse',cx:90,cy:90,rx:26,ry:17}] },
            { id:'rear_delts',  name:'Deltoides post.',    shapes:[{type:'ellipse',cx:30,cy:86,rx:12,ry:10},{type:'ellipse',cx:150,cy:86,rx:12,ry:10}] },
            { id:'upper_back',  name:'Espalda alta',       shapes:[{type:'ellipse',cx:90,cy:126,rx:22,ry:19}] },
            { id:'lats',        name:'Dorsales',           shapes:[{type:'ellipse',cx:62,cy:162,rx:13,ry:32},{type:'ellipse',cx:118,cy:162,rx:13,ry:32}] },
            { id:'triceps',     name:'Tríceps',            shapes:[{type:'ellipse',cx:30,cy:148,rx:10,ry:22},{type:'ellipse',cx:150,cy:148,rx:10,ry:22}] },
            { id:'lower_back',  name:'Lumbar',             shapes:[{type:'ellipse',cx:90,cy:200,rx:22,ry:14}] },
            { id:'glutes',      name:'Glúteos',            shapes:[{type:'ellipse',cx:74,cy:278,rx:22,ry:22},{type:'ellipse',cx:106,cy:278,rx:22,ry:22}] },
            { id:'hamstrings',  name:'Isquiotibiales',     shapes:[{type:'ellipse',cx:76,cy:370,rx:14,ry:50},{type:'ellipse',cx:103,cy:370,rx:14,ry:50}] },
            { id:'calves',      name:'Pantorrillas',       shapes:[{type:'ellipse',cx:77,cy:452,rx:10,ry:28},{type:'ellipse',cx:103,cy:452,rx:10,ry:28}] },
        ]
    };
    // 4-subpath body: head+neck · torso+legs · right arm · left arm
    const BODY_PATH = 'M 90 2 C 101 2 112 12 112 24 C 112 38 104 48 97 54 L 97 64 L 83 64 L 83 54 C 76 48 68 38 68 24 C 68 12 79 2 90 2 Z M 50 64 C 87 58 93 58 130 64 C 133 74 134 92 133 114 C 132 140 129 168 126 192 C 123 212 120 230 117 248 C 115 260 116 272 120 283 C 123 293 121 303 119 310 C 117 322 116 346 115 370 C 114 396 113 422 112 446 C 111 466 110 488 110 504 L 115 519 L 115 525 L 97 525 L 96 513 C 96 493 95 474 95 454 C 94 428 93 402 92 376 C 91 350 91 330 91 318 L 91 310 L 89 310 L 89 318 C 89 330 89 350 88 376 C 87 402 86 428 85 454 C 85 474 84 493 84 513 L 83 525 L 65 525 L 65 519 L 70 504 C 70 488 69 466 68 446 C 67 422 66 396 65 370 C 64 346 63 322 61 310 C 59 303 57 293 60 283 C 64 272 65 260 63 248 C 60 230 57 212 54 192 C 51 168 48 140 47 114 C 46 92 47 74 50 64 Z M 138 64 C 152 66 162 84 162 122 C 162 163 160 203 157 243 C 154 268 152 284 150 296 C 148 310 143 320 139 318 C 135 315 133 305 134 295 C 135 279 136 263 136 243 C 136 203 137 163 137 122 C 137 86 138 72 138 64 Z M 42 64 C 28 66 18 84 18 122 C 18 163 20 203 23 243 C 26 268 28 284 30 296 C 32 310 37 320 41 318 C 45 315 47 305 46 295 C 45 279 44 263 44 243 C 44 203 43 163 43 122 C 43 86 42 72 42 64 Z';

    const initSettings = async () => {
        try {
            // Fetch current profile from API
            const res = await apiFetch('/api/me');
            if (!res.ok) return;
            const profile = await res.json();

            // Populate form fields
            const nameInput = document.getElementById('settings-name');
            const lastNameInput = document.getElementById('settings-lastname');
            const emailInput = document.getElementById('settings-email');
            const avatar = document.getElementById('settings-avatar');

            if (nameInput) nameInput.value = profile.name || '';
            if (lastNameInput) lastNameInput.value = profile.lastName || '';
            if (emailInput) emailInput.value = profile.email || '';

            const thrEl  = document.getElementById('settings-thr');
            const mahrEl = document.getElementById('settings-mahr');
            if (thrEl)  thrEl.textContent  = profile.thr  ? `${profile.thr} bpm`  : '—';
            if (mahrEl) mahrEl.textContent = profile.mahr ? `${profile.mahr} bpm` : '—';

            // Payment handles — trainers only
            const session = loadSession();
            if (session?.role === 'trainer') {
                const section = document.getElementById('payment-handles-section');
                if (section) section.classList.remove('hidden');
                const ph = profile.paymentHandles || {};
                const athEl    = document.getElementById('settings-ath');
                const venmoEl  = document.getElementById('settings-venmo');
                const paypalEl = document.getElementById('settings-paypal');
                if (athEl)    athEl.value    = ph.athMovil || '';
                if (venmoEl)  venmoEl.value  = ph.venmo    || '';
                if (paypalEl) paypalEl.value = ph.paypal   || '';

                const saveHandlesBtn = document.getElementById('save-payment-handles-btn');
                if (saveHandlesBtn && !saveHandlesBtn.dataset.wired) {
                    saveHandlesBtn.dataset.wired = 'true';
                    saveHandlesBtn.addEventListener('click', async () => {
                        saveHandlesBtn.disabled = true;
                        saveHandlesBtn.textContent = 'Guardando...';
                        try {
                            const res2 = await apiFetch('/api/me', {
                                method: 'PUT',
                                body: JSON.stringify({
                                    paymentHandles: {
                                        athMovil: document.getElementById('settings-ath')?.value.trim()    || '',
                                        venmo:    document.getElementById('settings-venmo')?.value.trim()  || '',
                                        paypal:   document.getElementById('settings-paypal')?.value.trim() || ''
                                    }
                                })
                            });
                            if (res2.ok) { showToast('Métodos de cobro guardados.', 'success'); }
                            else { showToast('Error guardando métodos de cobro.', 'error'); }
                        } catch (e) { showToast('Error de conexión.', 'error'); }
                        finally {
                            saveHandlesBtn.disabled = false;
                            saveHandlesBtn.textContent = 'Guardar métodos de cobro';
                        }
                    });
                }
            }

            // Set avatar: show profile picture or initials
            if (avatar) {
                if (profile.profilePicture) {
                    avatar.innerHTML = `<img src="${profile.profilePicture}" class="w-full h-full object-cover" alt="Profile">`;
                } else {
                    const initials = `${(profile.name || '')[0] || ''}${(profile.lastName || '')[0] || ''}`.toUpperCase() || '?';
                    avatar.textContent = initials;
                }
            }

            // Profile picture upload + position/zoom editor
            const changePhotoBtn = document.getElementById('change-photo-btn');
            const profilePicInput = document.getElementById('profile-pic-input');
            window._pendingProfilePicture = null;

            // --- Photo editor state ---
            // baseScale: auto-computed so 1× = image just covers the circle (no empty space)
            // scale: multiplier on top of baseScale (slider 100 = 1×, 300 = 3×)
            const editorState = { x: 0, y: 0, scale: 1, baseScale: 1, dragging: false, lastX: 0, lastY: 0 };
            const CIRCLE_PX = 192; // w-48 in px

            const effectiveScale = () => editorState.baseScale * editorState.scale;

            const updatePhotoTransform = () => {
                const img = document.getElementById('photo-crop-img');
                if (!img) return;
                img.style.transform = `translate(calc(-50% + ${editorState.x}px), calc(-50% + ${editorState.y}px)) scale(${effectiveScale()})`;
            };

            const openPhotoEditor = (src) => {
                const modal  = document.getElementById('photo-editor-modal');
                const img    = document.getElementById('photo-crop-img');
                const slider = document.getElementById('photo-zoom-slider');
                const label  = document.getElementById('photo-zoom-label');
                if (!modal || !img) return;
                editorState.x = 0; editorState.y = 0; editorState.scale = 1; editorState.baseScale = 1;
                if (slider) slider.value = 100;
                if (label)  label.textContent = '1.0×';
                // Compute cover scale once image dimensions are known
                img.onload = () => {
                    const coverScale = Math.max(CIRCLE_PX / img.naturalWidth, CIRCLE_PX / img.naturalHeight);
                    editorState.baseScale = coverScale;
                    updatePhotoTransform();
                };
                img.src = src;
                modal.classList.remove('hidden');
            };

            const exportCroppedPhoto = () => {
                const img = document.getElementById('photo-crop-img');
                if (!img) return null;
                const SIZE  = 400;
                const ratio = SIZE / CIRCLE_PX;
                const canvas = document.createElement('canvas');
                canvas.width = SIZE; canvas.height = SIZE;
                const ctx = canvas.getContext('2d');
                const totalScale = effectiveScale();
                const scaledW = img.naturalWidth  * totalScale * ratio;
                const scaledH = img.naturalHeight * totalScale * ratio;
                const drawX   = SIZE / 2 + editorState.x * ratio - scaledW / 2;
                const drawY   = SIZE / 2 + editorState.y * ratio - scaledH / 2;
                ctx.drawImage(img, drawX, drawY, scaledW, scaledH);
                return canvas.toDataURL('image/jpeg', 0.92);
            };

            // Wire up editor UI (runs once per initSettings call)
            const setupPhotoEditorUI = () => {
                const modal   = document.getElementById('photo-editor-modal');
                const circle  = document.getElementById('photo-crop-circle');
                const slider  = document.getElementById('photo-zoom-slider');
                const label   = document.getElementById('photo-zoom-label');
                const resetBtn  = document.getElementById('photo-editor-reset');
                const cancelBtn = document.getElementById('photo-editor-cancel');
                const applyBtn  = document.getElementById('photo-editor-apply');
                if (!modal || !circle) return;

                // Drag to reposition
                circle.addEventListener('pointerdown', (e) => {
                    editorState.dragging = true;
                    editorState.lastX = e.clientX;
                    editorState.lastY = e.clientY;
                    circle.setPointerCapture(e.pointerId);
                    circle.style.cursor = 'grabbing';
                });
                circle.addEventListener('pointermove', (e) => {
                    if (!editorState.dragging) return;
                    editorState.x += e.clientX - editorState.lastX;
                    editorState.y += e.clientY - editorState.lastY;
                    editorState.lastX = e.clientX;
                    editorState.lastY = e.clientY;
                    updatePhotoTransform();
                });
                circle.addEventListener('pointerup', () => {
                    editorState.dragging = false;
                    circle.style.cursor = 'grab';
                });

                // Zoom slider — multiplies on top of baseScale
                if (slider) {
                    slider.addEventListener('input', () => {
                        editorState.scale = slider.value / 100;
                        if (label) label.textContent = editorState.scale.toFixed(1) + '×';
                        updatePhotoTransform();
                    });
                }

                // Reset to cover position
                if (resetBtn) resetBtn.onclick = () => {
                    editorState.x = 0; editorState.y = 0; editorState.scale = 1;
                    if (slider) slider.value = 100;
                    if (label) label.textContent = '1.0×';
                    updatePhotoTransform();
                };

                // Cancel
                if (cancelBtn) cancelBtn.onclick = () => modal.classList.add('hidden');

                // Apply — export to canvas → base64 → pending
                if (applyBtn) applyBtn.onclick = () => {
                    const base64 = exportCroppedPhoto();
                    if (!base64) return;
                    window._pendingProfilePicture = base64;
                    if (avatar) {
                        avatar.innerHTML = `<img src="${base64}" class="w-full h-full object-cover" alt="Profile">`;
                    }
                    modal.classList.add('hidden');
                };

                // Close on backdrop click
                modal.addEventListener('click', (e) => {
                    if (e.target === modal) modal.classList.add('hidden');
                });
            };

            setupPhotoEditorUI();

            if (changePhotoBtn && profilePicInput) {
                changePhotoBtn.onclick = () => profilePicInput.click();

                profilePicInput.onchange = (e) => {
                    const file = e.target.files[0];
                    if (!file) return;

                    if (file.size > 5 * 1024 * 1024) {
                        showToast('La imagen debe ser menor a 5MB.', 'error');
                        return;
                    }
                    if (!['image/jpeg', 'image/png', 'image/gif'].includes(file.type)) {
                        showToast('Solo se permiten archivos JPG, PNG o GIF.', 'error');
                        return;
                    }

                    const reader = new FileReader();
                    reader.onload = (ev) => openPhotoEditor(ev.target.result);
                    reader.readAsDataURL(file);
                    // Reset input so same file can be re-selected
                    profilePicInput.value = '';
                };
            }

            // Unit system toggle state
            const unitToggle = document.getElementById('weight-unit-toggle');
            const unitCircle = document.getElementById('unit-toggle-circle');
            const isMetric = profile.unitSystem === 'metric';

            if (unitToggle && unitCircle) {
                // Set initial visual state
                if (isMetric) {
                    unitToggle.classList.add('bg-[#FFDB89]/20');
                    unitToggle.classList.remove('bg-white/10');
                    unitCircle.classList.add('translate-x-5');
                    unitCircle.classList.remove('translate-x-0');
                } else {
                    unitToggle.classList.remove('bg-[#FFDB89]/20');
                    unitToggle.classList.add('bg-white/10');
                    unitCircle.classList.remove('translate-x-5');
                    unitCircle.classList.add('translate-x-0');
                }

                // Add label next to toggle
                let unitLabel = document.getElementById('unit-label');
                if (!unitLabel) {
                    unitLabel = document.createElement('span');
                    unitLabel.id = 'unit-label';
                    unitLabel.className = 'text-sm font-medium text-[#FFDB89]/70 ml-3';
                    unitToggle.parentElement.appendChild(unitLabel);
                }
                unitLabel.textContent = isMetric ? 'Metrico (kg/cm)' : 'Imperial (lbs/ft)';

                // Toggle click handler
                unitToggle.onclick = () => {
                    const currentlyMetric = unitCircle.classList.contains('translate-x-5');
                    if (currentlyMetric) {
                        unitToggle.classList.remove('bg-[#FFDB89]/20');
                        unitToggle.classList.add('bg-white/10');
                        unitCircle.classList.remove('translate-x-5');
                        unitCircle.classList.add('translate-x-0');
                        unitLabel.textContent = 'Imperial (lbs/ft)';
                    } else {
                        unitToggle.classList.add('bg-[#FFDB89]/20');
                        unitToggle.classList.remove('bg-white/10');
                        unitCircle.classList.add('translate-x-5');
                        unitCircle.classList.remove('translate-x-0');
                        unitLabel.textContent = 'Metrico (kg/cm)';
                    }
                };
            }

            // Theme toggle — use the existing theme system
            const themeToggle = document.getElementById('settings-theme-toggle');
            if (themeToggle) {
                themeToggle.onclick = () => {
                    document.documentElement.classList.toggle('dark');
                    const isDark = document.documentElement.classList.contains('dark');
                    localStorage.setItem('theme', isDark ? 'dark' : 'light');
                };
            }

            // Save button handler
            const saveBtn = document.getElementById('save-settings-btn');
            if (saveBtn) {
                saveBtn.onclick = async () => {
                    const unitCircleNow = document.getElementById('unit-toggle-circle');
                    const isMetricNow = unitCircleNow?.classList.contains('translate-x-5');

                    const updates = {
                        name: document.getElementById('settings-name')?.value.trim(),
                        lastName: document.getElementById('settings-lastname')?.value.trim(),
                        unitSystem: isMetricNow ? 'metric' : 'imperial'
                    };

                    // Include profile picture if changed
                    if (window._pendingProfilePicture) {
                        updates.profilePicture = window._pendingProfilePicture;
                    }

                    if (!updates.name) {
                        showToast('El nombre es requerido.', 'error');
                        return;
                    }

                    try {
                        const saveRes = await apiFetch('/api/me', {
                            method: 'PUT',
                            body: JSON.stringify(updates)
                        });
                        if (saveRes.ok) {
                            const updatedUser = await saveRes.json();
                            // Update localStorage session with ALL changed fields
                            const session = loadSession();
                            if (session) {
                                session.name = updatedUser.name;
                                session.lastName = updatedUser.lastName;
                                session.unitSystem = updatedUser.unitSystem;
                                session.profilePicture = updatedUser.profilePicture || '';
                                localStorage.setItem('auth_user', JSON.stringify(session));
                            }
                            // Clear pending picture
                            window._pendingProfilePicture = null;

                            // Update sidebar trainer name
                            const trainerName = document.getElementById('trainer-name');
                            if (trainerName) trainerName.textContent = updatedUser.name;

                            // Update avatar in settings
                            const av = document.getElementById('settings-avatar');
                            if (av) {
                                if (updatedUser.profilePicture) {
                                    av.innerHTML = `<img src="${updatedUser.profilePicture}" class="w-full h-full object-cover" alt="Profile">`;
                                } else {
                                    const initials = `${(updatedUser.name || '')[0] || ''}${(updatedUser.lastName || '')[0] || ''}`.toUpperCase();
                                    av.textContent = initials;
                                }
                            }

                            showToast('Configuración guardada exitosamente.', 'success');
                        } else {
                            const err = await saveRes.json();
                            showToast(err.message || 'Error guardando configuración', 'error');
                        }
                    } catch (e) {
                        console.error(e);
                        showToast('Error de conexión', 'error');
                    }
                };
            }

            // ── Muscle Injury Map ─────────────────────────────────────────────
            let muscleState   = { ...(profile.injuredMuscles || {}) };
            let muscleView    = 'front';
            const allMuscles  = [...MUSCLE_DEFS.front, ...MUSCLE_DEFS.back];

            const renderMuscleMap = () => {
                const container = document.getElementById('muscle-svg-container');
                if (!container) return;
                const shapeHtml = MUSCLE_DEFS[muscleView].map(muscle => {
                    const st  = muscleState[muscle.id] || null;
                    const fill   = st === 'red'    ? 'rgba(239,68,68,0.5)'    : st === 'yellow' ? 'rgba(251,191,36,0.5)'  : 'rgba(34,197,94,0.07)';
                    const stroke = st === 'red'    ? 'rgba(239,68,68,0.85)'   : st === 'yellow' ? 'rgba(251,191,36,0.85)' : 'rgba(34,197,94,0.18)';
                    const sw = st ? 2 : 1;
                    return muscle.shapes.map(s => {
                        const attrs = `data-muscle="${muscle.id}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" style="cursor:pointer;transition:fill .15s,stroke .15s"`;
                        return s.type === 'ellipse'
                            ? `<ellipse ${attrs} cx="${s.cx}" cy="${s.cy}" rx="${s.rx}" ry="${s.ry}"/>`
                            : `<rect    ${attrs} x="${s.x}"  y="${s.y}"  width="${s.width}" height="${s.height}" rx="${s.rx||0}"/>`;
                    }).join('');
                }).join('');
                container.innerHTML = `<svg viewBox="0 0 180 535" xmlns="http://www.w3.org/2000/svg" class="w-40 md:w-48 h-auto select-none" id="muscle-body-svg">
                    <path d="${BODY_PATH}" fill="rgba(255,219,137,0.09)" stroke="rgba(255,219,137,0.38)" stroke-width="1.5" stroke-linejoin="round"/>
                    ${shapeHtml}
                </svg>`;
                document.getElementById('muscle-body-svg')?.addEventListener('click', e => {
                    const el = e.target.closest('[data-muscle]');
                    if (!el) return;
                    const id  = el.dataset.muscle;
                    const cur = muscleState[id] || null;
                    const nxt = cur === null ? 'yellow' : cur === 'yellow' ? 'red' : null;
                    if (nxt === null) delete muscleState[id]; else muscleState[id] = nxt;
                    renderMuscleMap();
                    updateMuscleFlags();
                });
            };

            const updateMuscleFlags = () => {
                const list = document.getElementById('injury-flags-list');
                if (!list) return;
                const flagged = Object.entries(muscleState).filter(([, st]) => st);
                if (!flagged.length) {
                    list.innerHTML = '<p class="text-xs text-[#FFDB89]/30 italic">Sin restricciones marcadas. Toca un músculo para cambiar su estado.</p>';
                    return;
                }
                list.innerHTML = flagged.map(([id, st]) => {
                    const name  = allMuscles.find(m => m.id === id)?.name || id;
                    const isRed = st === 'red';
                    return `<div class="flex items-center justify-between px-3 py-1.5 rounded-lg border ${isRed ? 'bg-red-500/10 border-red-400/25' : 'bg-yellow-400/10 border-yellow-400/25'}">
                        <span class="text-xs font-medium ${isRed ? 'text-red-400' : 'text-yellow-400'}">${name}</span>
                        <span class="text-xs font-bold ml-4 ${isRed ? 'text-red-400' : 'text-yellow-400'}">${isRed ? '🔴 Evitar' : '🟡 Precaución'}</span>
                    </div>`;
                }).join('');
            };

            const setMuscleView = (view) => {
                muscleView = view;
                const activeClass   = 'px-4 py-1.5 rounded-lg text-xs font-bold bg-[#FFDB89] text-[#030303] transition';
                const inactiveClass = 'px-4 py-1.5 rounded-lg text-xs font-bold bg-[#FFDB89]/10 text-[#FFDB89] border border-[#FFDB89]/20 transition';
                const fb = document.getElementById('muscle-view-front');
                const bb = document.getElementById('muscle-view-back');
                if (fb) fb.className = view === 'front' ? activeClass : inactiveClass;
                if (bb) bb.className = view === 'back'  ? activeClass : inactiveClass;
                renderMuscleMap();
            };

            document.getElementById('muscle-view-front')?.addEventListener('click', () => setMuscleView('front'));
            document.getElementById('muscle-view-back')?.addEventListener('click',  () => setMuscleView('back'));
            document.getElementById('muscle-clear-all')?.addEventListener('click',  () => { muscleState = {}; renderMuscleMap(); updateMuscleFlags(); });

            document.getElementById('save-muscle-btn')?.addEventListener('click', async () => {
                try {
                    const r = await apiFetch('/api/me', { method: 'PUT', body: JSON.stringify({ injuredMuscles: muscleState }) });
                    showToast(r.ok ? 'Grupos musculares guardados.' : 'Error al guardar.', r.ok ? 'success' : 'error');
                } catch { showToast('Error de conexión.', 'error'); }
            });

            renderMuscleMap();
            updateMuscleFlags();

        } catch (e) { console.error('Error loading settings:', e); }
    };

    const loadSession = () => { try { return JSON.parse(localStorage.getItem('auth_user')); } catch (e) { return null; } };


    // =============================================================================
    // 3. THEME LOGIC
    // =============================================================================

    const updateThemeIcon = () => {
        const btns = document.querySelectorAll('#theme-toggle');
        const isDark = document.documentElement.classList.contains('dark');
        btns.forEach(btn => {
            if (isDark) {
                btn.innerHTML = `<i class="fas fa-moon w-6 text-center text-lg transition-colors"></i><span class="font-medium whitespace-nowrap overflow-hidden nav-text group-[.w-20]:hidden">Modo oscuro</span>`;
            } else {
                btn.innerHTML = `<i class="fas fa-sun w-6 text-center text-lg transition-colors"></i><span class="font-medium whitespace-nowrap overflow-hidden nav-text group-[.w-20]:hidden">Modo claro</span>`;
            }
        });
    };

    const applyThemePreferenceEarly = () => {
        const savedTheme = localStorage.getItem('theme');
        const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        if (savedTheme === 'dark' || (!savedTheme && systemPrefersDark)) {
            document.documentElement.classList.add('dark');
        } else {
            document.documentElement.classList.remove('dark');
        }
        setTimeout(updateThemeIcon, 50);
    };


    // =============================================================================
    // 4. VIEW HELPERS & ROUTER
    // =============================================================================

    const injectGlobalStyles = () => {
        if (document.getElementById('dynamic-styles')) return;
        const style = document.createElement('style');
        style.id = 'dynamic-styles';
        style.innerHTML = `
            .exercise-name-input::-webkit-calendar-picker-indicator { display: none !important; opacity: 0 !important; }
            .exercise-name-input { -webkit-appearance: none; -moz-appearance: none; appearance: none; background-image: none !important; }
            .autocomplete-list { background-color: #1C1C1E; border: 1px solid rgba(255,219,137,0.2); border-radius: 0.625rem; max-height: 220px; overflow-y: auto; box-shadow: 0 8px 28px rgba(0,0,0,0.5); }
            .autocomplete-item { padding: 0.6rem 0.875rem; cursor: pointer; color: rgba(255,219,137,0.7); font-size: 0.875rem; display: flex; align-items: center; gap: 0.5rem; border-bottom: 1px solid rgba(255,219,137,0.06); }
            .autocomplete-item:last-child { border-bottom: none; }
            .autocomplete-item:first-child { border-radius: 0.625rem 0.625rem 0 0; }
            .autocomplete-item:last-child { border-radius: 0 0 0.625rem 0.625rem; }
            .autocomplete-item:only-child { border-radius: 0.625rem; }
            .autocomplete-item:hover { background-color: rgba(255,219,137,0.08); color: #FFDB89; }
            .autocomplete-item mark { background: transparent; color: #FFDB89; font-weight: 700; }
            
            /* CALENDAR & EDITOR STYLES */
            .category-pill { cursor: pointer; border: 1px solid rgba(255,255,255,0.2); transition: all 0.2s; }
            .category-pill:hover { background: rgba(255,255,255,0.1); }
            .category-pill.selected { background: #5e2d91; border-color: #ffde00; color: white; }
            
            .day-cell-menu { display: none; }
            .day-cell:hover .day-cell-menu { display: flex; }

            /* Copy checkbox: visible on hover for days with workouts */
            .copy-day-checkbox:not(.hidden) { opacity: 0; transition: opacity 0.15s; }
            .day-cell:hover .copy-day-checkbox:not(.hidden) { opacity: 1; }
            .copy-day-checkbox:checked { opacity: 1 !important; }

            /* Slide content right on hover to reveal checkbox */
            .content-area { transition: padding-left 0.15s ease; }
            .day-cell:has(.content-area:not(:empty)):hover .content-area { padding-left: 26px; }
            .day-cell:has(.copy-day-checkbox:checked) .content-area { padding-left: 26px; }
            
            /* Transparent default, visible on hover */
            .cal-action-btn { 
                transition: transform 0.2s; 
                padding: 10px; 
                border-radius: 50%; 
                background: transparent; 
            }
            .cal-action-btn:hover { 
                transform: scale(1.15); 
                text-shadow: 0 2px 4px rgba(0,0,0,0.5); 
            }
            
            .editor-expanded { max-width: 900px !important; }
            .slide-in-right { animation: slideIn 0.3s ease-out forwards; }
            @keyframes slideIn { from { transform: translateX(100%); } to { transform: translateX(0); } }

            /* Superset Connector Line */
            .superset-connector {
                position: absolute;
                left: 20px;
                top: -10px;
                bottom: -10px;
                width: 4px;
                background-color: #FFDB89; /* Golden line */
                z-index: 0;
            }

            /* TABLET/SMALL DESKTOP: Scale down hover menu to prevent overlap */
            @media (max-width: 1200px) and (min-width: 769px) {
                .cal-action-btn {
                    padding: 6px !important;
                }
                
                .cal-action-btn i {
                    font-size: 16px !important;
                }
                
                .day-cell-menu .flex {
                    gap: 8px !important;
                }
            }
            
            @media (max-width: 1024px) and (min-width: 769px) {
                .cal-action-btn {
                    padding: 4px !important;
                }
                
                .cal-action-btn i {
                    font-size: 14px !important;
                }
                
                .day-cell-menu .flex {
                    gap: 4px !important;
                }
            }
            
            @media (max-width: 900px) and (min-width: 769px) {
                .cal-action-btn {
                    padding: 3px !important;
                }
                
                .cal-action-btn i {
                    font-size: 12px !important;
                }
                
                .day-cell-menu .flex {
                    gap: 2px !important;
                }
                
                .day-cell { min-height: 52px; }
            }

                /* Hide action icons when the cell already has content */
                .day-cell:has(.content-area:not(:empty)) .day-cell-menu { display: none !important; }

                /* On touch devices, show icons without hover */
                @media (hover: none) {
                    .day-cell-menu { opacity: 1 !important; }

                    #back-to-clients-btn {
                        font-size: 14px;
                    }

                    /* Workout editor - make full width on mobile */
                    #editor-panel {
                        max-width: 100% !important;
                        width: 100% !important;
                    }
                }
        `;
        document.head.appendChild(style);
    };

    const updateContent = (title, contentHtml) => {
        if(contentHtml.includes('id="clock-module-root"')) {
            mainContentArea.innerHTML = contentHtml;
            return;
        }
        // Remove padding for calendar view to allow full edge-to-edge scrolling
        const isCalendar = contentHtml.includes('client-calendar-grid');
        const paddingClass = isCalendar ? 'p-0' : 'p-4 md:p-14';
        const titleClass = (isCalendar || !title) ? 'hidden' : 'text-2xl md:text-4xl font-bold text-[#FFDB89] dark:text-[#FFDB89] mb-4 md:mb-6 border-b border-[#FFDB89]/10 pb-3 flex-shrink-0';
        const bgClass = isCalendar
            ? 'glass-card'
            : 'glass-card rounded-2xl';

        mainContentArea.innerHTML = `
        <div class="${paddingClass} ${bgClass} h-full flex flex-col relative overflow-hidden">
            ${title ? `<h1 class="${titleClass}">${title}</h1>` : ''}
            <div class="flex-grow overflow-auto relative h-full">${contentHtml}</div>
        </div>`;
    };

    const updateDashboard = (welcomeTitle, userName) => {
        const trainerNameSpan = document.getElementById('trainer-name');
        if(trainerNameSpan) trainerNameSpan.textContent = userName;
        const sidebar = document.getElementById('sidebar');
        if(sidebar) sidebar.querySelectorAll('nav a').forEach(a => a.classList.add('nav-link-item'));

        // On mobile the sidebar is hidden off-screen; hamburger controls it.
        // On desktop it stays visible as normal.
        initMobileMenu();

        // ── Sidebar collapse/expand button ────────────────────────────────────
        // Wire up directly on the element so it works regardless of event delegation.
        const collapseBtn = document.getElementById('collapse-btn');
        if (collapseBtn && !collapseBtn.dataset.wired) {
            collapseBtn.dataset.wired = '1';
            collapseBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const sb = document.getElementById('sidebar');
                if (!sb) return;
                const icon = collapseBtn.querySelector('svg') || collapseBtn.querySelector('i');
                const isCollapsed = sb.classList.contains('w-20');
                if (isCollapsed) {
                    sb.classList.remove('w-20'); sb.classList.add('w-60');
                    sb.querySelectorAll('.nav-text').forEach(span => span.classList.remove('hidden'));
                    if (icon) icon.style.transform = 'rotate(0deg)';
                } else {
                    sb.classList.remove('w-60'); sb.classList.add('w-20');
                    sb.querySelectorAll('.nav-text').forEach(span => span.classList.add('hidden'));
                    if (icon) icon.style.transform = 'rotate(180deg)';
                }
            });
        }

        setTimeout(updateThemeIcon, 100);
    };

    const initMobileMenu = () => {
        const overlay = document.getElementById('mobile-sidebar-overlay');
        const sp = document.getElementById('sidebar-placeholder');
        if (!overlay || !sp || sp.dataset.mobileInit) return;
        sp.dataset.mobileInit = '1';

        const closeMenu = () => {
            sp.classList.remove('mobile-open');
            overlay.classList.add('hidden');
            document.body.style.overflow = '';
        };

        overlay.addEventListener('click', closeMenu);

        // Close on nav item click when on mobile
        sp.addEventListener('click', (e) => {
            if (e.target.closest('.nav-link-item') && window.innerWidth < 768) {
                closeMenu();
            }
        });
    };

    const loadModule = async (name) => {
        if (MODULE_CACHE[name]) return MODULE_CACHE[name];
        try {
            const res = await fetch(`${name}.html`);
            if (!res.ok) throw new Error(`Error loading ${name}`);
            const html = await res.text();
            MODULE_CACHE[name] = html;
            return html;
        } catch (e) { return `<p class="text-red-500">Error: ${e.message}</p>`; }
    };

    const router = async (user) => {
        if (!user) user = loadSession(); 
        if (!user) {
            dashboardContainer.classList.add('hidden');
            authScreen.classList.remove('hidden');
            document.body.classList.remove('flex');
            return;
        }
        authScreen.classList.add('hidden');
        dashboardContainer.classList.remove('hidden');
        document.body.classList.add('flex');

        const dashModule = user.role === 'trainer' ? 'trainer-dashboard' : 'client-dashboard';
        const dashHtml = await loadModule(dashModule);
        sidebarPlaceholder.innerHTML = dashHtml;

        if (user.role === 'trainer') {
            const homeHtml = await loadModule('trainer_home');
            updateContent('', homeHtml);
            renderTrainerHome(user.name);
            updateDashboard('', user.name);

            // Start notification badge polling for trainers
            fetchNotificationCount();
            if (notificationPollInterval) clearInterval(notificationPollInterval);
            notificationPollInterval = setInterval(fetchNotificationCount, 60000);
        } else {
            const homeHtml = await loadModule('client_inicio');
            updateContent('', homeHtml);
            initClientHome();
            updateDashboard('', user.name);
        }
        setTimeout(updateThemeIcon, 100); 

        // FORCE PASSWORD CHANGE MODAL
        if (user.role === 'client' && user.isFirstLogin) {
            if (!document.getElementById('change-password-modal')) {
                document.body.insertAdjacentHTML('beforeend', `
                    <div id="change-password-modal" class="fixed inset-0 bg-black/90 z-[100] flex items-center justify-center p-4 backdrop-blur-sm">
                        <div class="bg-[#030303] border border-red-500/40 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
                            <div class="h-1 w-full bg-gradient-to-r from-red-500 via-red-400 to-red-500"></div>
                            <div class="p-8">
                                <div class="text-center mb-6">
                                    <div class="w-12 h-12 bg-red-500/10 border border-red-500/30 rounded-full flex items-center justify-center mx-auto mb-4">
                                        <i class="fas fa-lock text-red-400 text-xl"></i>
                                    </div>
                                    <h2 class="text-2xl font-bold text-white">Acción Requerida</h2>
                                    <p class="text-[#FFDB89]/50 mt-2 text-sm">Por seguridad, debes cambiar tu contraseña temporal.</p>
                                </div>
                                <div class="space-y-4">
                                    <input type="password" id="new-password-input" class="w-full p-4 bg-[#FFDB89]/5 border border-[#FFDB89]/20 rounded-xl text-[#FFDB89] placeholder:text-[#FFDB89]/30 focus:ring-2 focus:ring-red-500/40 focus:border-red-500/50 outline-none transition" placeholder="Nueva Contraseña">
                                    <button id="confirm-password-change-btn" class="w-full bg-red-600 hover:bg-red-500 text-white font-bold py-4 rounded-xl shadow-lg transition transform hover:scale-[1.01]">
                                        Guardar y Continuar
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                `);
            }

            const confirmBtn = document.getElementById('confirm-password-change-btn');
            if (confirmBtn) {
                confirmBtn.onclick = async () => {
                    const newPw = document.getElementById('new-password-input').value;
                    const pwErr = validatePassword(newPw);
                    if (pwErr) { showToast(pwErr, 'error'); return; }
                    try {
                        const res = await apiFetch('/api/auth/update-password', {
                            method: 'POST',
                            body: JSON.stringify({ newPassword: newPw })
                        });
                        if (res.ok) {
                            user.isFirstLogin = false;
                            localStorage.setItem('auth_user', JSON.stringify(user));
                            document.getElementById('change-password-modal').remove();
                            showToast("¡Contraseña actualizada! Bienvenido.", 'success');
                        } else {
                            showToast("Error al actualizar contraseña.", 'error');
                        }
                    } catch (e) { console.error(e); showToast("Error de conexión.", 'error'); }
                };
            }
        }
    };

    // =============================================================================
    // AUTH & PASSWORD RECOVERY LOGIC
    // =============================================================================

    const showMessage = (elementId, message, type) => {
        const msgEl = document.getElementById(elementId);
        if(!msgEl) return;
        
        msgEl.className = `p-3 rounded-lg text-sm ${
            type === 'error' ? 'bg-red-100 text-red-700 border border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-800' :
            type === 'success' ? 'bg-green-100 text-green-700 border border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-800' :
            'bg-[#FFDB89]/10 text-[#FFDB89]/70 border border-[#FFDB89]/20'
        }`;
        msgEl.textContent = message;
        msgEl.classList.remove('hidden');
        
        setTimeout(() => {
            msgEl.classList.add('hidden');
        }, 5000);
    };

    const handleLogin = async (e) => {
        e.preventDefault();
        
        const email = document.getElementById('login-email')?.value.trim();
        const password = document.getElementById('login-password')?.value;
        const remember = document.getElementById('remember-me')?.checked;

        if(!email || !password) {
            showMessage('auth-message', 'Por favor completa todos los campos', 'error');
            return;
        }

        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });

            const data = await res.json();

            if(res.ok) {
                // FIX: Server returns data.user.id (not data.userId)
                const userSession = {
                    id: data.user.id,
                    name: data.user.name,
                    email: data.user.email,
                    role: data.user.role,
                    isFirstLogin: data.user.isFirstLogin || false
                };

                // H-2: Token is now an HttpOnly cookie set by the server — never stored in JS
                localStorage.setItem('auth_user', JSON.stringify(userSession));

                if(remember) {
                    localStorage.setItem('remember_email', email);
                }

                showMessage('auth-message', 'Inicio de sesion exitoso', 'success');
                
                setTimeout(() => {
                    router(userSession);
                }, 500);
            } else {
                showMessage('auth-message', data.message || 'Email o contraseña incorrectos', 'error');
            }
        } catch(error) {
            console.error('Login error:', error);
            showMessage('auth-message', 'Error de conexión. Intenta nuevamente.', 'error');
        }
    };

    const handleForgotPassword = async (e) => {
        e.preventDefault();
        
        const email = document.getElementById('forgot-email')?.value.trim();

        if(!email) {
            showMessage('forgot-message', 'Por favor ingresa tu email', 'error');
            return;
        }

        try {
            const res = await fetch('/api/auth/forgot-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email })
            });

            const data = await res.json();

            if(res.ok) {
                showMessage('forgot-message', 'Hemos enviado un enlace de recuperación a tu email', 'success');
                document.getElementById('forgot-email').value = '';
            } else {
                showMessage('forgot-message', data.message || 'No encontramos una cuenta con ese email', 'error');
            }
        } catch(error) {
            console.error('Forgot password error:', error);
            showMessage('forgot-message', 'Error de conexión. Intenta nuevamente.', 'error');
        }
    };

    const handleResetPassword = async (e) => {
        e.preventDefault();
        
        const newPassword = document.getElementById('new-password')?.value;
        const confirmPassword = document.getElementById('confirm-password')?.value;
        
        const urlParams = new URLSearchParams(window.location.search);
        const resetToken = urlParams.get('token');

        if(!resetToken) {
            showMessage('reset-message', 'Enlace de recuperación inválido', 'error');
            return;
        }

        const pwError = validatePassword(newPassword);
        if (pwError) { showMessage('reset-message', pwError, 'error'); return; }
        if (newPassword !== confirmPassword) {
            showMessage('reset-message', 'Las contraseñas no coinciden', 'error');
            return;
        }

        try {
            const res = await fetch('/api/auth/reset-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: resetToken, newPassword })
            });

            const data = await res.json();

            if(res.ok) {
                showMessage('reset-message', 'Contraseña actualizada exitosamente', 'success');
                
                setTimeout(() => {
                    window.location.href = '/';
                }, 2000);
            } else {
                showMessage('reset-message', data.message || 'Error al actualizar contraseña', 'error');
            }
        } catch(error) {
            console.error('Reset password error:', error);
            showMessage('reset-message', 'Error de conexión. Intenta nuevamente.', 'error');
        }
    };

    const togglePasswordVisibility = () => {
        const passwordInput = document.getElementById('login-password');
        const toggleBtn = document.getElementById('toggle-password');
        
        if(!passwordInput || !toggleBtn) return;
        
        if(passwordInput.type === 'password') {
            passwordInput.type = 'text';
            toggleBtn.innerHTML = '<i class="fas fa-eye-slash"></i>';
        } else {
            passwordInput.type = 'password';
            toggleBtn.innerHTML = '<i class="fas fa-eye"></i>';
        }
    };

    const showCard = (cardToShow) => {
        const cards = ['login-card', 'forgot-password-card', 'reset-password-card', 'setup-account-card'];
        cards.forEach(card => {
            const el = document.getElementById(card);
            if(el) {
                if(card === cardToShow) {
                    el.classList.remove('hidden');
                } else {
                    el.classList.add('hidden');
                }
            }
        });
    };

    const checkResetToken = () => {
        const urlParams = new URLSearchParams(window.location.search);
        const resetToken = urlParams.get('token');
        if(resetToken) showCard('reset-password-card');
    };

    // --- INVITE: check for ?invite= token and show the account setup card ---
    const checkInviteToken = async () => {
        const urlParams = new URLSearchParams(window.location.search);
        const inviteToken = urlParams.get('invite');
        if (!inviteToken) return;

        showCard('setup-account-card');

        // Pre-fill name and email by looking up the token server-side
        try {
            const res = await fetch(`/api/auth/invite-info?token=${encodeURIComponent(inviteToken)}`);
            if (res.ok) {
                const data = await res.json();
                const greetingEl = document.getElementById('invite-greeting');
                const greetingText = document.getElementById('invite-greeting-text');
                const emailDisplay = document.getElementById('invite-email-display');
                if (greetingEl) greetingEl.classList.remove('hidden');
                if (greetingText) greetingText.textContent = `¡Hola, ${data.name}! Tu entrenador te ha dado acceso.`;
                if (emailDisplay) emailDisplay.value = data.email;
            } else {
                showMessage('invite-message', 'Este enlace es inválido o ya expiró. Si ya activaste tu cuenta, inicia sesión.', 'error');
                document.getElementById('accept-invite-form')?.querySelectorAll('input, button').forEach(el => el.disabled = true);
                const backWrap = document.getElementById('invite-back-login-wrap');
                if (backWrap) backWrap.classList.remove('hidden');
                const backBtn = document.getElementById('invite-back-to-login-btn');
                if (backBtn) backBtn.addEventListener('click', () => showCard('login-card'), { once: true });
                setTimeout(() => showCard('login-card'), 5000);
            }
        } catch (err) {
            console.error('Invite info fetch error:', err);
        }
    };

    // --- Shared password validator (mirrors server.js validatePassword) ---
    const validatePassword = (pw) => {
        if (!pw || pw.length < 8)      return 'La contraseña debe tener al menos 8 caracteres.';
        if (!/[a-zA-Z]/.test(pw))      return 'Incluye al menos una letra.';
        if (!/[0-9]/.test(pw))         return 'Incluye al menos un número.';
        if (!/[^a-zA-Z0-9]/.test(pw))  return 'Incluye al menos un carácter especial (!@#$%...).';
        return null; // null = valid
    };

    // --- INVITE: handle account activation form submission ---
    const handleAcceptInvite = async (e) => {
        e.preventDefault();

        const urlParams = new URLSearchParams(window.location.search);
        const inviteToken = urlParams.get('invite');
        const password = document.getElementById('invite-password')?.value;
        const confirmPassword = document.getElementById('invite-confirm-password')?.value;

        if (!inviteToken) {
            showMessage('invite-message', 'Token de invitación no encontrado.', 'error');
            return;
        }
        const pwError = validatePassword(password);
        if (pwError) { showMessage('invite-message', pwError, 'error'); return; }
        if (password !== confirmPassword) {
            showMessage('invite-message', 'Las contraseñas no coinciden.', 'error');
            return;
        }

        try {
            const res = await fetch('/api/auth/accept-invite', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: inviteToken, password })
            });
            const data = await res.json();

            if (res.ok) {
                showMessage('invite-message', '¡Cuenta activada! Iniciando sesión...', 'success');
                // H-2: JWT is now in the HttpOnly cookie set by the server — just store user info
                localStorage.setItem('auth_user', JSON.stringify(data.user));
                // Clean URL and redirect to the appropriate dashboard
                window.history.replaceState({}, document.title, '/');
                setTimeout(() => {
                    window.location.href = '/'; // let index.html router show the right dashboard
                }, 1500);
            } else {
                showMessage('invite-message', data.message || 'Error al activar cuenta.', 'error');
            }
        } catch (err) {
            console.error('Accept invite error:', err);
            showMessage('invite-message', 'Error de conexión. Intenta nuevamente.', 'error');
        }
    };

    const initAuthListeners = () => {
        const loginForm = document.getElementById('login-form');
        if(loginForm) {
            loginForm.addEventListener('submit', handleLogin);
        }

        const forgotLink = document.getElementById('forgot-password-link');
        if(forgotLink) {
            forgotLink.addEventListener('click', () => showCard('forgot-password-card'));
        }

        const backBtn = document.getElementById('back-to-login');
        if(backBtn) {
            backBtn.addEventListener('click', () => showCard('login-card'));
        }

        const forgotForm = document.getElementById('forgot-password-form');
        if(forgotForm) {
            forgotForm.addEventListener('submit', handleForgotPassword);
        }

        const resetForm = document.getElementById('reset-password-form');
        if(resetForm) {
            resetForm.addEventListener('submit', handleResetPassword);
        }

        const toggleBtn = document.getElementById('toggle-password');
        if(toggleBtn) {
            toggleBtn.addEventListener('click', togglePasswordVisibility);
        }

        // --- Eye toggle helper ---
        const makeToggle = (btnId, inputId) => {
            const btn = document.getElementById(btnId);
            const inp = document.getElementById(inputId);
            if (!btn || !inp) return;
            btn.addEventListener('click', () => {
                const showing = inp.type === 'text';
                inp.type = showing ? 'password' : 'text';
                btn.innerHTML = `<i class="fas fa-eye${showing ? '' : '-slash'} text-sm"></i>`;
            });
        };
        makeToggle('toggle-invite-password',         'invite-password');
        makeToggle('toggle-invite-confirm-password', 'invite-confirm-password');
        makeToggle('toggle-new-password',            'new-password');
        makeToggle('toggle-confirm-password',        'confirm-password');

        // --- Real-time password mismatch feedback ---
        const wireMatchCheck = (confirmId, errorId, refId) => {
            const confirmInput = document.getElementById(confirmId);
            const refInput     = document.getElementById(refId);
            const errorEl      = document.getElementById(errorId);
            if (!confirmInput || !errorEl || !refInput) return;
            confirmInput.addEventListener('input', () => {
                const mismatch = confirmInput.value.length > 0 && confirmInput.value !== refInput.value;
                errorEl.classList.toggle('hidden', !mismatch);
            });
        };
        wireMatchCheck('invite-confirm-password', 'invite-password-match-error', 'invite-password');
        wireMatchCheck('confirm-password',        'reset-password-match-error',  'new-password');

        // --- Real-time password requirements checklist ---
        const PW_RULES = [
            { key: 'len',     label: 'Al menos 8 caracteres',                   test: pw => pw.length >= 8 },
            { key: 'letter',  label: 'Al menos una letra',                       test: pw => /[a-zA-Z]/.test(pw) },
            { key: 'number',  label: 'Al menos un número',                       test: pw => /[0-9]/.test(pw) },
            { key: 'special', label: 'Al menos un carácter especial (!@#$%...)', test: pw => /[^a-zA-Z0-9]/.test(pw) },
        ];
        const wirePasswordRules = (inputId, containerId) => {
            const input     = document.getElementById(inputId);
            const container = document.getElementById(containerId);
            if (!input || !container) return;
            container.innerHTML = PW_RULES.map(r =>
                `<div id="${containerId}-${r.key}" class="flex items-center gap-1.5 text-[#FFDB89]/40 transition-colors">
                    <i class="fas fa-circle" style="font-size:6px"></i>
                    <span>${r.label}</span>
                </div>`
            ).join('');
            input.addEventListener('input', () => {
                const pw = input.value;
                PW_RULES.forEach(r => {
                    const el = document.getElementById(`${containerId}-${r.key}`);
                    if (!el) return;
                    const passed = r.test(pw);
                    const empty  = pw.length === 0;
                    el.className = `flex items-center gap-1.5 transition-colors ${empty ? 'text-[#FFDB89]/40' : passed ? 'text-green-400' : 'text-red-400'}`;
                    el.querySelector('i').className = `fas ${empty ? 'fa-circle' : passed ? 'fa-check-circle' : 'fa-times-circle'}`;
                    el.querySelector('i').style.fontSize = empty ? '6px' : '10px';
                });
            });
        };
        wirePasswordRules('invite-password', 'invite-pw-rules');
        wirePasswordRules('new-password',    'reset-pw-rules');

        const supportLink = document.getElementById('contact-support-link');
        if(supportLink) {
            supportLink.addEventListener('click', () => {
                showToast('Contacta a: soporte@fitbysuarez.com', 'info');
            });
        }

        const rememberedEmail = localStorage.getItem('remember_email');
        if(rememberedEmail) {
            const emailInput = document.getElementById('login-email');
            if(emailInput) {
                emailInput.value = rememberedEmail;
                const rememberCheckbox = document.getElementById('remember-me');
                if(rememberCheckbox) {
                    rememberCheckbox.checked = true;
                }
            }
        }

        checkResetToken();

        // Invite flow
        const acceptInviteForm = document.getElementById('accept-invite-form');
        if (acceptInviteForm) {
            acceptInviteForm.addEventListener('submit', handleAcceptInvite);
        }

        checkInviteToken();
    };

    // =============================================================================
    // 5. CLIENT & TRAINER LOGIC (PERSISTENT CLIENTS)
    // =============================================================================

    const populateTimezones = () => {
        const select = document.getElementById('opt-timezone');
        if (!select || select.options.length > 0) return;

        const tzGroups = {
            'Estados Unidos': [
                { value: 'America/New_York',       label: 'Nueva York / Miami / Atlanta (EST/EDT)' },
                { value: 'America/Chicago',         label: 'Dallas / Chicago / Houston (CST/CDT)' },
                { value: 'America/Denver',          label: 'Denver / Salt Lake City (MST/MDT)' },
                { value: 'America/Phoenix',         label: 'Phoenix / Arizona (MST)' },
                { value: 'America/Los_Angeles',     label: 'Los Ángeles / Seattle / Las Vegas (PST/PDT)' },
                { value: 'America/Anchorage',       label: 'Alaska (AKST/AKDT)' },
                { value: 'Pacific/Honolulu',        label: 'Hawái (HST)' },
                { value: 'America/Puerto_Rico',     label: 'Puerto Rico (AST)' },
            ],
            'Canadá': [
                { value: 'America/Toronto',         label: 'Toronto / Ottawa (EST/EDT)' },
                { value: 'America/Winnipeg',        label: 'Winnipeg / Manitoba (CST/CDT)' },
                { value: 'America/Edmonton',        label: 'Edmonton / Calgary (MST/MDT)' },
                { value: 'America/Vancouver',       label: 'Vancouver / British Columbia (PST/PDT)' },
                { value: 'America/Halifax',         label: 'Halifax / Nueva Escocia (AST/ADT)' },
                { value: 'America/St_Johns',        label: 'San Juan / Terranova (NST/NDT)' },
            ],
            'México': [
                { value: 'America/Mexico_City',     label: 'Ciudad de México / Guadalajara / Monterrey (CST/CDT)' },
                { value: 'America/Cancun',          label: 'Cancún / Quintana Roo (EST)' },
                { value: 'America/Chihuahua',       label: 'Chihuahua / Hermosillo (MST/MDT)' },
                { value: 'America/Tijuana',         label: 'Tijuana / Baja California (PST/PDT)' },
            ],
            'Centroamérica y Caribe': [
                { value: 'America/Guatemala',       label: 'Ciudad de Guatemala (CST)' },
                { value: 'America/El_Salvador',     label: 'San Salvador (CST)' },
                { value: 'America/Tegucigalpa',     label: 'Tegucigalpa / Honduras (CST)' },
                { value: 'America/Managua',         label: 'Managua / Nicaragua (CST)' },
                { value: 'America/Costa_Rica',      label: 'San José / Costa Rica (CST)' },
                { value: 'America/Panama',          label: 'Ciudad de Panamá (EST)' },
                { value: 'America/Havana',          label: 'La Habana / Cuba (CST/CDT)' },
                { value: 'America/Santo_Domingo',   label: 'Santo Domingo / Rep. Dominicana (AST)' },
                { value: 'America/Port-au-Prince',  label: 'Puerto Príncipe / Haití (EST/EDT)' },
                { value: 'America/Jamaica',         label: 'Kingston / Jamaica (EST)' },
            ],
            'Sudamérica': [
                { value: 'America/Bogota',          label: 'Bogotá / Colombia (COT)' },
                { value: 'America/Lima',            label: 'Lima / Perú (PET)' },
                { value: 'America/Guayaquil',       label: 'Guayaquil / Ecuador (ECT)' },
                { value: 'America/Caracas',         label: 'Caracas / Venezuela (VET)' },
                { value: 'America/La_Paz',          label: 'La Paz / Bolivia (BOT)' },
                { value: 'America/Santiago',        label: 'Santiago / Chile (CLT/CLST)' },
                { value: 'America/Argentina/Buenos_Aires', label: 'Buenos Aires / Argentina (ART)' },
                { value: 'America/Montevideo',      label: 'Montevideo / Uruguay (UYT)' },
                { value: 'America/Asuncion',        label: 'Asunción / Paraguay (PYT)' },
                { value: 'America/Sao_Paulo',       label: 'São Paulo / Brasilia (BRT/BRST)' },
                { value: 'America/Manaus',          label: 'Manaos / Amazonas (AMT)' },
                { value: 'America/Fortaleza',       label: 'Fortaleza / Nordeste Brasil (BRT)' },
            ],
            'Europa': [
                { value: 'Europe/London',           label: 'Londres / Dublín (GMT/BST)' },
                { value: 'Europe/Lisbon',           label: 'Lisboa / Portugal (WET/WEST)' },
                { value: 'Europe/Madrid',           label: 'Madrid / Barcelona (CET/CEST)' },
                { value: 'Europe/Paris',            label: 'París / Bruselas (CET/CEST)' },
                { value: 'Europe/Berlin',           label: 'Berlín / Roma / Viena (CET/CEST)' },
                { value: 'Europe/Amsterdam',        label: 'Ámsterdam / Países Bajos (CET/CEST)' },
                { value: 'Europe/Moscow',           label: 'Moscú / Rusia (MSK)' },
            ],
            'Otro': [
                { value: 'UTC',                     label: 'UTC — Tiempo Universal Coordinado' },
            ],
        };

        const userTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = '— Seleccionar zona horaria —';
        blank.className = 'bg-gray-900';
        select.appendChild(blank);

        Object.entries(tzGroups).forEach(([groupName, zones]) => {
            const group = document.createElement('optgroup');
            group.label = groupName;
            zones.forEach(tz => {
                const option = document.createElement('option');
                option.value = tz.value;
                option.textContent = tz.label;
                option.className = 'bg-gray-900';
                if (tz.value === userTz) option.selected = true;
                group.appendChild(option);
            });
            select.appendChild(group);
        });
    };

    const renderGroupOptions = () => {
        const select = document.getElementById('new-client-group');
        if(!select) return;
        select.innerHTML = '';
        groupsCache.forEach(group => {
            const opt = document.createElement('option');
            opt.value = group;
            opt.textContent = group;
            opt.className = "bg-gray-900";
            select.appendChild(opt);
        });
    };

    const renderProgramOptions = async (selectedValue) => {
        const select = document.getElementById('new-client-program');
        if (!select) return;
        // Fetch programs if not yet loaded
        if (programsCache.length === 0) await fetchProgramsFromDB();
        // Always start with "Sin asignar"
        select.innerHTML = '<option class="bg-gray-900" value="Sin asignar">-- Sin programa --</option>';
        programsCache.forEach(prog => {
            const opt = document.createElement('option');
            opt.value = prog.name;
            opt.textContent = prog.name;
            opt.className = "bg-gray-900";
            select.appendChild(opt);
        });
        // Restore selection if editing an existing client
        if (selectedValue) select.value = selectedValue;
    };

    // 1. OPEN CLIENT PROFILE (Updated with Modals)
    window.openClientProfile = (clientId) => {
        // LOOSE MATCHING (==)
        const client = clientsCache.find(c => (c._id == clientId) || (c.id == clientId));
        
        if (!client) return;
        
        currentClientViewId = clientId;

        // TRUECOACH STYLE CONTINUOUS CALENDAR (with tabs)
        updateContent(`Perfil: ${client.name} ${client.lastName}`, `
            <div id="client-calendar-grid" class="flex flex-col h-full bg-[#2C2C2E] overflow-hidden">
                <div class="flex items-center justify-between p-4 bg-[#2C2C2E] border-b border-[#FFDB89]/20 shadow-sm z-10">
                    <div class="flex items-center gap-4">
                        <button id="back-to-clients-btn" class="text-[#FFDB89]/70 hover:text-[#FFDB89] transition"><i class="fas fa-arrow-left text-xl"></i></button>
                        <h2 class="text-2xl font-bold text-[#FFDB89]">${client.name} ${client.lastName}</h2>
                    </div>
                    <div class="flex items-center gap-2">
                        <button class="px-3 py-1 text-sm font-semibold border border-[#FFDB89]/30 bg-[#FFDB89]/10 text-[#FFDB89] rounded hover:bg-[#FFDB89]/20 transition" onclick="document.querySelector('.is-today')?.scrollIntoView({block:'center', behavior:'smooth'})">Hoy</button>
                    </div>
                </div>

                <!-- Tab Bar -->
                <div class="flex border-b border-[#FFDB89]/20 bg-transparent px-4 shrink-0 z-10">
                    <button class="client-detail-tab px-4 py-3 text-sm font-bold border-b-2 border-[#FFDB89] text-[#FFDB89]" data-tab="calendar">Calendario</button>
                    <button class="client-detail-tab px-4 py-3 text-sm font-bold text-[#FFDB89]/50 hover:text-[#FFDB89]/80 border-b-2 border-transparent" data-tab="metrics">Métricas</button>
                    <button class="client-detail-tab px-4 py-3 text-sm font-bold text-[#FFDB89]/50 hover:text-[#FFDB89]/80 border-b-2 border-transparent" data-tab="nutrition">Nutrición</button>
                    <button class="client-detail-tab px-4 py-3 text-sm font-bold text-[#FFDB89]/50 hover:text-[#FFDB89]/80 border-b-2 border-transparent" data-tab="photos">Fotos</button>
                    <button class="client-detail-tab px-4 py-3 text-sm font-bold text-[#FFDB89]/50 hover:text-[#FFDB89]/80 border-b-2 border-transparent" data-tab="restrictions">Restricciones</button>
                </div>

                <!-- TAB: Calendar (default) -->
                <div id="tab-calendar" class="client-tab-content flex flex-col flex-grow overflow-hidden">
                    <div id="infinite-calendar-scroll" class="flex-grow overflow-y-auto overflow-x-hidden relative bg-[#1C1C1E] pb-20">
                        <div id="calendar-grid-container" class="flex flex-col">
                            ${generateContinuousCalendar(client)}
                        </div>
                    </div>
                    <div id="workout-editor-modal" class="hidden absolute inset-0 z-50 flex justify-end bg-black/20 backdrop-blur-[1px]"></div>
                </div>

                <!-- TAB: Metrics -->
                <div id="tab-metrics" class="client-tab-content hidden flex-grow overflow-y-auto p-6">
                    <p class="text-gray-400 text-sm animate-pulse">Cargando metricas...</p>
                </div>

                <!-- TAB: Nutrition -->
                <div id="tab-nutrition" class="client-tab-content hidden flex-grow overflow-y-auto p-6">
                    <p class="text-gray-400 text-sm animate-pulse">Cargando nutricion...</p>
                </div>

                <!-- TAB: Photos -->
                <div id="tab-photos" class="client-tab-content hidden flex-grow overflow-y-auto p-6">
                    <p class="text-gray-400 text-sm animate-pulse">Cargando fotos...</p>
                </div>

                <!-- TAB: Restrictions -->
                <div id="tab-restrictions" class="client-tab-content hidden flex-grow overflow-y-auto p-6">
                    <p class="text-gray-400 text-sm animate-pulse">Cargando restricciones...</p>
                </div>

                <!-- Modals (shared) -->
                <div id="history-modal" class="hidden fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm">
                    <div class="bg-[#030303] border border-[#FFDB89]/20 w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden">
                        <div class="bg-[#FFDB89]/5 px-5 py-4 border-b border-[#FFDB89]/15 flex justify-between items-center">
                            <h3 class="font-bold text-lg text-[#FFDB89]">Historial de Ejercicio</h3>
                            <button onclick="document.getElementById('history-modal').classList.add('hidden')" class="text-[#FFDB89]/40 hover:text-red-400 transition"><i class="fas fa-times text-xl"></i></button>
                        </div>
                        <div class="p-5">
                            <div class="overflow-x-auto rounded-xl border border-[#FFDB89]/10">
                                <table class="w-full text-sm text-left">
                                    <thead>
                                        <tr class="border-b border-[#FFDB89]/10">
                                            <th class="px-3 py-2.5 text-[10px] font-bold text-[#FFDB89]/40 uppercase tracking-widest">Fecha</th>
                                            <th class="px-3 py-2.5 text-[10px] font-bold text-[#FFDB89]/40 uppercase tracking-widest">Peso</th>
                                            <th class="px-3 py-2.5 text-[10px] font-bold text-[#FFDB89]/40 uppercase tracking-widest">Reps</th>
                                            <th class="px-3 py-2.5 text-[10px] font-bold text-[#FFDB89]/40 uppercase tracking-widest">Sets</th>
                                            <th class="px-3 py-2.5 text-[10px] font-bold text-[#FFDB89]/40 uppercase tracking-widest">Notas</th>
                                        </tr>
                                    </thead>
                                    <tbody id="history-table-body">
                                        <tr class="border-b border-[#FFDB89]/5 hover:bg-[#FFDB89]/5 transition">
                                            <td class="px-3 py-2.5 text-[#FFDB89]/70">01/02/2026</td>
                                            <td class="px-3 py-2.5 text-[#FFDB89]/70">135 lbs</td>
                                            <td class="px-3 py-2.5 text-[#FFDB89]/70">10</td>
                                            <td class="px-3 py-2.5 text-[#FFDB89]/70">3</td>
                                            <td class="px-3 py-2.5 text-[#FFDB89]/50 italic">Easy</td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>

                <div id="video-upload-modal" class="hidden fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
                     <div class="bg-[#030303]/95 backdrop-blur-2xl p-6 rounded-2xl shadow-2xl w-full max-w-sm border border-[#FFDB89]/20">
                        <div class="flex items-center gap-2 mb-4">
                            <i class="fas fa-video text-[#FFDB89]"></i>
                            <h3 id="video-modal-title" class="text-lg font-bold text-[#FFDB89]">Añadir Video URL</h3>
                        </div>
                        <p class="text-xs text-[#FFDB89]/40 mb-3">Enlace de YouTube o Vimeo</p>
                        <input type="text" id="video-url-input" class="w-full p-2.5 bg-white/10 border border-[#FFDB89]/30 rounded-lg text-[#FFDB89] text-sm outline-none focus:ring-2 focus:ring-[#FFDB89] placeholder-[#FFDB89]/30 mb-3" placeholder="https://youtube.com/...">
                        <div class="border-t border-[#FFDB89]/10 pt-3 mb-4">
                            <p class="text-xs text-[#FFDB89]/40 mb-2">Guardar en librería como (opcional)</p>
                            <div class="relative">
                                <input type="text" id="video-library-name" autocomplete="off" class="w-full p-2.5 bg-white/10 border border-[#FFDB89]/30 rounded-lg text-[#FFDB89] text-sm outline-none focus:ring-2 focus:ring-[#FFDB89] placeholder-[#FFDB89]/30" placeholder="Nombre del ejercicio...">
                                <div id="video-lib-name-suggestions" class="absolute left-0 right-0 top-full mt-1 bg-[#111113] border border-[#FFDB89]/25 rounded-lg z-[90] overflow-hidden shadow-xl hidden max-h-40 overflow-y-auto"></div>
                            </div>
                        </div>
                        <div class="flex justify-end gap-2 flex-wrap">
                            <button onclick="document.getElementById('video-upload-modal').classList.add('hidden')" class="px-4 py-2 text-[#FFDB89]/60 hover:text-[#FFDB89] font-medium transition">Cancelar</button>
                            <button onclick="window.saveEditorVideoSmart()" class="px-4 py-2 bg-[#3a3a3c] hover:bg-[#3a3a3c]/80 text-[#FFDB89] rounded-lg font-bold transition">Guardar</button>
                        </div>
                     </div>
                </div>

            </div>
        `);

        // Tab switching logic
        document.querySelectorAll('.client-detail-tab').forEach(tab => {
            tab.onclick = () => {
                document.querySelectorAll('.client-detail-tab').forEach(t => {
                    t.classList.remove('border-[#FFDB89]', 'text-[#FFDB89]');
                    t.classList.add('text-[#FFDB89]/50', 'border-transparent');
                });
                tab.classList.add('border-[#FFDB89]', 'text-[#FFDB89]');
                tab.classList.remove('text-[#FFDB89]/50', 'border-transparent');

                document.querySelectorAll('.client-tab-content').forEach(c => c.classList.add('hidden'));
                const targetTab = document.getElementById(`tab-${tab.dataset.tab}`);
                if (targetTab) {
                    targetTab.classList.remove('hidden');
                    if (tab.dataset.tab === 'calendar') targetTab.classList.add('flex');
                }

                // Load data on tab switch
                if (tab.dataset.tab === 'metrics') loadClientMetrics(clientId);
                if (tab.dataset.tab === 'nutrition') loadClientNutrition(clientId);
                if (tab.dataset.tab === 'photos') loadClientPhotos(clientId);
                if (tab.dataset.tab === 'restrictions') loadClientRestrictions(clientId);
            };
        });

        // Mood metadata used in trainer calendar cells and expand panels
        const MOOD_META = {
            amazing: { icon: 'fa-grin-stars', color: '#FFDB89', label: 'Increíble' },
            great:   { icon: 'fa-smile',       color: '#4ade80', label: 'Genial'    },
            neutral: { icon: 'fa-meh',         color: '#9ca3af', label: 'Normal'    },
            tired:   { icon: 'fa-tired',       color: '#fb923c', label: 'Cansado'   },
            bad:     { icon: 'fa-angry',       color: '#f87171', label: 'Mal'       },
        };
        const moodBadgeHtml = (mood) => {
            const m = MOOD_META[mood];
            if (!m) return '';
            return `<div class="flex items-center gap-1.5 mt-1 pt-1 border-t border-white/5">
                <i class="fas ${m.icon} text-[10px]" style="color:${m.color}" title="Estado de ánimo: ${m.label}"></i>
                <span class="text-[10px] font-semibold" style="color:${m.color}">${m.label}</span>
            </div>`;
        };

        const loadClientWorkoutsToCalendar = async (clientId) => {
            try {
                const response = await apiFetch(`/api/client-workouts/${clientId}`);
                if(response.ok) {
                    const workouts = await response.json();

                    // Display each workout in its calendar cell
                    workouts.forEach(workout => {
                        window._calendarWorkouts[workout.date] = workout;
                        const cell = document.getElementById(`day-${workout.date}`);
                        if(cell) {
                            const area = cell.querySelector('.content-area');

                            if (workout.isRest) {
                                // Rest / Active-rest badge
                                const isActive = workout.restType === 'active_rest';
                                const icon  = isActive ? 'fa-person-walking' : 'fa-moon';
                                const color = isActive ? '#6EE7B7' : '#93C5FD'; // emerald / blue
                                const label = workout.title || (isActive ? 'Descanso Activo' : 'Descanso');
                                area.innerHTML = `
                                    <div class="flex items-center gap-2 py-0.5">
                                        <div class="w-1 h-6 rounded-full shrink-0" style="background:${color}"></div>
                                        <i class="fas ${icon} text-xs shrink-0" style="color:${color}"></i>
                                        <span class="text-xs font-semibold" style="color:${color}">${label}</span>
                                    </div>
                                    ${moodBadgeHtml(workout.mood)}`;
                                // Show copy checkbox on hover for rest days too
                                const cb = cell.querySelector('.copy-day-checkbox');
                                if (cb) cb.classList.remove('hidden');
                            } else {
                                const barColor = workout.isComplete ? '#4ade80' : workout.isMissed ? '#f87171' : '#FFDB89';
                                const statusBadge = workout.isComplete
                                    ? `<span class="text-[10px] text-green-400 font-bold flex items-center gap-0.5"><i class="fas fa-check-circle"></i> Completado</span>`
                                    : workout.isMissed
                                    ? `<span class="text-[10px] text-red-400 font-bold flex items-center gap-0.5"><i class="fas fa-times-circle"></i> Perdido</span>`
                                    : '';
                                area.innerHTML = `
                                    <div class="workout-card-wrapper">
                                        <div class="workout-card-header flex items-center gap-3 cursor-pointer py-0.5 group/wk">
                                            <div class="w-1 h-8 rounded-full shrink-0" style="background:${barColor}"></div>
                                            <div class="min-w-0 flex-1">
                                                <div class="text-sm font-bold truncate" style="color:${barColor}">${workout.title}</div>
                                                <div class="text-xs text-[#FFDB89]/50 flex items-center gap-2">${workout.exercises.length} ejercicio${workout.exercises.length !== 1 ? 's' : ''}${statusBadge ? ' · ' : ''}${statusBadge}</div>
                                            </div>
                                            <i class="fas fa-chevron-right text-[#FFDB89]/40 text-xs shrink-0 workout-chevron transition-transform duration-200"></i>
                                        </div>
                                        ${moodBadgeHtml(workout.mood)}
                                        <div class="workout-expand-content hidden mt-1 border-t border-[#FFDB89]/10"></div>
                                    </div>
                                `;
                                // Show copy checkbox on hover for days with workouts
                                const cb = cell.querySelector('.copy-day-checkbox');
                                if(cb) cb.classList.remove('hidden');
                            }
                        }
                    });
                }
            } catch(e) {
                console.error('Error loading workouts:', e);
            }
        };

        // Load saved workouts onto the calendar
        loadClientWorkoutsToCalendar(clientId);

        // Delegated expand-header listener (avoids CSP script-src-attr blocking inline onclick)
        const calScroll = document.getElementById('infinite-calendar-scroll');
        if (calScroll && !calScroll.dataset.expandListenerAttached) {
            calScroll.dataset.expandListenerAttached = '1';
            calScroll.addEventListener('click', (e) => {
                const header = e.target.closest('.workout-card-header');
                if (header) window.toggleWorkoutExpand(header);
            });
        }

        // Scroll to Today automatically
        setTimeout(() => {
            const todayCell = document.querySelector('.is-today');
            if(todayCell) todayCell.scrollIntoView({ block: "center", behavior: "auto" });
        }, 100);
    };

    // --- Client Detail Tab Data Loaders ---

    // Parse measurement values: handles numbers, decimal strings, and fraction strings like "27 3/8"
    const parseMeasurement = (v) => {
        if (v === null || v === undefined || v === '') return null;
        if (typeof v === 'number') return isNaN(v) ? null : v;
        const s = String(v).trim();
        const mixed = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
        if (mixed) return parseInt(mixed[1]) + parseInt(mixed[2]) / parseInt(mixed[3]);
        const frac = s.match(/^(\d+)\/(\d+)$/);
        if (frac) return parseInt(frac[1]) / parseInt(frac[2]);
        const n = parseFloat(s);
        return isNaN(n) ? null : n;
    };

    const loadClientMetrics = async (clientId) => {
        const container = document.getElementById('tab-metrics');
        if (!container) return;
        try {
            const res = await apiFetch(`/api/body-measurements/${clientId}`);
            const measurements = res.ok ? await res.json() : [];
            const client = clientsCache.find(c => c._id == clientId);

            // Calculate height in inches for BMI
            const hFt = client?.height?.feet || 0;
            const hIn = client?.height?.inches || 0;
            const totalInches = hFt * 12 + hIn;

            const tableRows = measurements.length === 0
                ? `<tr><td colspan="11" class="py-8 text-center text-[#FFDB89]/40">
                       <i class="fas fa-ruler-combined text-2xl mb-2 block"></i>
                       Sin registros. Haz clic en "Agregar medición" para comenzar.
                   </td></tr>`
                : [...measurements].reverse().map(m => {
                    const [y, mo, d] = m.date.split('-');
                    const dateStr = `${d}/${mo}/${y}`;
                    const cell = (val, gold = false) =>
                        `<td class="px-3 py-2.5 text-center whitespace-nowrap ${gold ? 'font-bold text-[#FFDB89]' : 'text-[#FFDB89]/60'}">${val || '—'}</td>`;
                    return `<tr class="border-b border-[#FFDB89]/10 hover:bg-[#FFDB89]/5 transition group">
                        <td class="px-3 py-2.5 text-left font-medium text-[#FFDB89] whitespace-nowrap">${dateStr}</td>
                        ${cell(m.bmi ? m.bmi.toFixed(1) : null)}
                        ${cell(m.bodyFat ? m.bodyFat + '%' : null)}
                        ${cell(m.weight ? m.weight + ' lbs' : null, true)}
                        ${cell(m.pecho)}
                        ${cell(m.biceps)}
                        ${cell(m.cintura)}
                        ${cell(m.cadera)}
                        ${cell(m.quads)}
                        ${cell(m.calves)}
                        <td class="px-3 py-2.5 text-center">
                            <button onclick="window.deleteMeasurement('${clientId}', '${m._id}')"
                                class="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-300 transition text-xs">
                                <i class="fas fa-trash"></i>
                            </button>
                        </td>
                    </tr>`;
                }).join('');

            container.innerHTML = `
                <div class="space-y-6">

                    <!-- Header -->
                    <div class="flex flex-wrap justify-between items-center gap-3">
                        <div>
                            <h3 class="text-xl font-bold text-[#FFDB89]">Medidas corporales</h3>
                            ${client ? `<p class="text-sm text-[#FFDB89]/60 mt-0.5">
                                ${client.height ? `Estatura: ${hFt}'${hIn}"` : ''}
                                ${client.thr  ? ` · THR: ${client.thr} bpm`   : ''}
                                ${client.mahr ? ` · MaxHR: ${client.mahr} bpm` : ''}
                            </p>` : ''}
                        </div>
                        <button onclick="window.showAddMeasurementModal('${clientId}', ${totalInches})"
                            class="px-4 py-2 bg-[#3a3a3c] hover:bg-[#3a3a3c]/80 text-[#FFDB89] rounded-lg text-sm font-bold transition flex items-center gap-2">
                            <i class="fas fa-plus"></i> Agregar medición
                        </button>
                    </div>

                    <!-- Progress Chart -->
                    <div class="bg-[#FFDB89]/5 border border-[#FFDB89]/15 rounded-2xl overflow-hidden">
                        <div class="flex items-center justify-between px-5 pt-4 pb-3 border-b border-[#FFDB89]/10">
                            <span class="text-sm font-bold text-[#FFDB89]">Progreso visual</span>
                            <div class="flex gap-1.5 flex-wrap" id="trainer-metric-tabs">
                                <button class="tr-metric-btn px-3 py-1 rounded-lg text-xs font-bold bg-[#FFDB89] text-[#030303]" data-metric="weight">Peso</button>
                                <button class="tr-metric-btn px-3 py-1 rounded-lg text-xs font-bold text-[#FFDB89]/50 hover:text-[#FFDB89]" data-metric="fat">% Grasa</button>
                                <button class="tr-metric-btn px-3 py-1 rounded-lg text-xs font-bold text-[#FFDB89]/50 hover:text-[#FFDB89]" data-metric="bmi">BMI</button>
                                <button class="tr-metric-btn px-3 py-1 rounded-lg text-xs font-bold text-[#FFDB89]/50 hover:text-[#FFDB89]" data-metric="circum">Circunf.</button>
                            </div>
                        </div>
                        <!-- Circum dropdown (shown only when Circunf. tab is active) -->
                        <div id="tr-circum-selector-wrap" class="hidden px-5 py-2.5 border-b border-[#FFDB89]/10 flex items-center gap-2">
                            <span class="text-xs text-[#FFDB89]/40 uppercase tracking-wider font-bold">Ver:</span>
                            <select id="tr-circum-field-select" class="bg-[#FFDB89]/10 text-[#FFDB89] text-xs font-bold rounded-lg px-3 py-1.5 border border-[#FFDB89]/20 outline-none cursor-pointer appearance-none pr-7" style="background-image:url(&quot;data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23FFDB89' stroke-width='2.5'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E&quot;);background-repeat:no-repeat;background-position:right 8px center;">
                                <option value="pecho">Pecho</option>
                                <option value="biceps">Bíceps</option>
                                <option value="cintura" selected>Cintura</option>
                                <option value="cadera">Cadera</option>
                                <option value="quads">Quads</option>
                                <option value="calves">Pantorrillas</option>
                            </select>
                        </div>
                        <div class="grid grid-cols-3 divide-x divide-[#FFDB89]/10 border-b border-[#FFDB89]/10">
                            <div class="px-4 py-2.5 text-center"><p class="text-xs text-[#FFDB89]/40 mb-0.5">Actual</p><p class="text-lg font-black text-[#FFDB89]" id="tr-stat-current">—</p></div>
                            <div class="px-4 py-2.5 text-center"><p class="text-xs text-[#FFDB89]/40 mb-0.5">Cambio</p><p class="text-lg font-black" id="tr-stat-change">—</p></div>
                            <div class="px-4 py-2.5 text-center"><p class="text-xs text-[#FFDB89]/40 mb-0.5">Mejor</p><p class="text-lg font-black text-[#92A9E1]" id="tr-stat-best">—</p></div>
                        </div>
                        <div class="p-5" style="height:200px; position:relative;">
                            <canvas id="trainerMetricsChart"></canvas>
                        </div>
                    </div>

                    <!-- Measurements Table -->
                    <div class="overflow-x-auto">
                        <table class="w-full text-sm border-collapse">
                            <thead>
                                <tr class="border-b border-[#FFDB89]/20">
                                    <th class="px-3 py-3 text-left   text-xs font-bold text-[#FFDB89] uppercase whitespace-nowrap">Fecha</th>
                                    <th class="px-3 py-3 text-center text-xs font-bold text-[#FFDB89] uppercase whitespace-nowrap">BMI</th>
                                    <th class="px-3 py-3 text-center text-xs font-bold text-[#FFDB89] uppercase whitespace-nowrap">%G</th>
                                    <th class="px-3 py-3 text-center text-xs font-bold text-[#FFDB89] uppercase whitespace-nowrap">Peso</th>
                                    <th class="px-3 py-3 text-center text-xs font-bold text-[#FFDB89] uppercase whitespace-nowrap">Pecho</th>
                                    <th class="px-3 py-3 text-center text-xs font-bold text-[#FFDB89] uppercase whitespace-nowrap">Bíceps</th>
                                    <th class="px-3 py-3 text-center text-xs font-bold text-[#FFDB89] uppercase whitespace-nowrap">Cintura</th>
                                    <th class="px-3 py-3 text-center text-xs font-bold text-[#FFDB89] uppercase whitespace-nowrap">Cadera</th>
                                    <th class="px-3 py-3 text-center text-xs font-bold text-[#FFDB89] uppercase whitespace-nowrap">Quads</th>
                                    <th class="px-3 py-3 text-center text-xs font-bold text-[#FFDB89] uppercase whitespace-nowrap">Pantorrillas</th>
                                    <th class="px-3 py-3 text-center text-xs font-bold text-[#FFDB89] uppercase"></th>
                                </tr>
                            </thead>
                            <tbody class="divide-y divide-[#FFDB89]/10">${tableRows}</tbody>
                        </table>
                    </div>
                </div>
            `;

            // Build trainer chart (shared logic)
            if (measurements.length > 1) {
                const chartLabels = measurements.map(m => {
                    const [y, mo, d] = m.date.split('-'); return `${d}/${mo}/${y.slice(2)}`;
                });
                const circumFields = [
                    { key: 'pecho',   label: 'Pecho',    color: '#F472B6' },
                    { key: 'biceps',  label: 'Bíceps',   color: '#A78BFA' },
                    { key: 'cintura', label: 'Cintura',  color: '#6EE7B7' },
                    { key: 'cadera',  label: 'Cadera',   color: '#FCA5A5' },
                    { key: 'quads',   label: 'Quads',    color: '#FCD34D' },
                    { key: 'calves',  label: 'Pantorr.', color: '#60A5FA' },
                ];
                const trMetrics = {
                    weight:  { label: 'Peso (lbs)',  data: measurements.map(m => parseMeasurement(m.weight)),  color: '#FFDB89', unit: ' lbs', lower: true  },
                    fat:     { label: '% Grasa',     data: measurements.map(m => parseMeasurement(m.bodyFat)), color: '#F87171', unit: '%',    lower: true  },
                    bmi:     { label: 'BMI',          data: measurements.map(m => parseMeasurement(m.bmi)),     color: '#92A9E1', unit: '',     lower: true  },
                    circum:  { label: 'Circunferencias', multiLine: true, unit: ' in', lower: true }
                };
                let trChart = null;
                let trActive = 'weight';
                let trActiveCircumKey = 'cintura';

                const renderTrainerChart = (key) => {
                    const ctx = document.getElementById('trainerMetricsChart');
                    if (!ctx) return;
                    if (trChart) { trChart.destroy(); trChart = null; }

                    // Show/hide circum dropdown
                    const trCircumWrap = document.getElementById('tr-circum-selector-wrap');
                    if (trCircumWrap) trCircumWrap.classList.toggle('hidden', key !== 'circum');

                    if (key === 'circum') {
                        // ── Single-line circumference chart (dropdown-driven) ──
                        const f = circumFields.find(f => f.key === trActiveCircumKey) || circumFields[2];
                        const vals = measurements.map(m => parseMeasurement(m[f.key]));
                        const filteredVals = vals.filter(v => v !== null);

                        // Stats
                        const statCur = document.getElementById('tr-stat-current');
                        const statChg = document.getElementById('tr-stat-change');
                        const statBst = document.getElementById('tr-stat-best');
                        if (filteredVals.length) {
                            const latest = filteredVals[filteredVals.length - 1];
                            const first  = filteredVals[0];
                            const delta  = latest - first;
                            const best   = Math.min(...filteredVals);
                            if (statCur) statCur.textContent = latest + ' in';
                            if (statChg) {
                                statChg.textContent = (delta > 0 ? '+' : '') + delta.toFixed(1) + ' in';
                                statChg.className = `text-lg font-black ${delta === 0 ? 'text-[#FFDB89]/40' : delta <= 0 ? 'text-green-400' : 'text-red-400'}`;
                            }
                            if (statBst) statBst.textContent = best + ' in';
                        } else {
                            if (statCur) statCur.textContent = '—';
                            if (statChg) { statChg.textContent = '—'; statChg.className = 'text-lg font-black'; }
                            if (statBst) statBst.textContent = '—';
                        }

                        const lo = filteredVals.length ? Math.min(...filteredVals) : 0;
                        const hi = filteredVals.length ? Math.max(...filteredVals) : 1;
                        const range = hi - lo;
                        const pad = range === 0 ? 1 : range * 0.3;
                        const yMin = parseFloat((lo - pad).toFixed(1));
                        const yMax = parseFloat((hi + pad).toFixed(1));
                        const hex = f.color;
                        const rgb = [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)].join(',');

                        trChart = new Chart(ctx, {
                            type: 'line',
                            data: {
                                labels: chartLabels,
                                datasets: [{
                                    label: f.label, data: vals, borderColor: f.color,
                                    backgroundColor: (ctx2) => {
                                        const {ctx: c, chartArea} = ctx2.chart;
                                        if (!chartArea) return 'transparent';
                                        const g = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
                                        g.addColorStop(0, `rgba(${rgb},0.35)`); g.addColorStop(1, `rgba(${rgb},0)`); return g;
                                    },
                                    borderWidth: 2.5, tension: 0.45, fill: true,
                                    pointRadius: 5, pointHoverRadius: 7,
                                    pointBackgroundColor: f.color, pointBorderColor: '#1C1C1E', pointBorderWidth: 2, spanGaps: true
                                }]
                            },
                            options: {
                                responsive: true, maintainAspectRatio: false,
                                interaction: { mode: 'index', intersect: false },
                                plugins: {
                                    legend: { display: false },
                                    tooltip: {
                                        backgroundColor: '#030303', borderColor: f.color + '55', borderWidth: 1,
                                        titleColor: f.color, bodyColor: '#fff', padding: 10, cornerRadius: 10,
                                        callbacks: { label: (c) => c.parsed.y !== null ? ` ${c.parsed.y} in` : ' —' }
                                    }
                                },
                                scales: {
                                    x: { ticks: { color: 'rgba(255,219,137,0.5)', font: { size: 10 }, maxRotation: 0 }, grid: { color: 'rgba(255,219,137,0.06)' }, border: { color: 'transparent' } },
                                    y: { min: yMin, max: yMax, beginAtZero: false, ticks: { color: 'rgba(255,219,137,0.5)', font: { size: 10 } }, grid: { color: 'rgba(255,219,137,0.06)' }, border: { color: 'transparent' } }
                                }
                            }
                        });
                        return;
                    }

                    // ── Single-line chart (weight / fat / bmi) ────────────────
                    const m = trMetrics[key];
                    const boundVals = m.data.filter(v => v !== null);
                    const lo = boundVals.length ? Math.min(...boundVals) : 0;
                    const hi = boundVals.length ? Math.max(...boundVals) : 1;
                    const range = hi - lo;
                    const pad = range === 0 ? 1 : range * 0.3;
                    const yMin = parseFloat((lo - pad).toFixed(2));
                    const yMax = parseFloat((hi + pad).toFixed(2));
                    const hex = m.color;
                    const rgb = [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)].join(',');
                    trChart = new Chart(ctx, {
                        type: 'line',
                        data: {
                            labels: chartLabels,
                            datasets: [{ label: m.label, data: m.data, borderColor: m.color,
                                backgroundColor: (ctx2) => {
                                    const {ctx: c, chartArea} = ctx2.chart;
                                    if (!chartArea) return 'transparent';
                                    const g = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
                                    g.addColorStop(0, `rgba(${rgb},0.35)`); g.addColorStop(1, `rgba(${rgb},0)`); return g;
                                },
                                borderWidth: 2.5, tension: 0.45, fill: true,
                                pointRadius: 5, pointHoverRadius: 7,
                                pointBackgroundColor: m.color, pointBorderColor: '#1C1C1E', pointBorderWidth: 2, spanGaps: true
                            }]
                        },
                        options: {
                            responsive: true, maintainAspectRatio: false,
                            interaction: { mode: 'index', intersect: false },
                            plugins: {
                                legend: { display: false },
                                tooltip: { backgroundColor: '#030303', borderColor: m.color + '55', borderWidth: 1,
                                    titleColor: m.color, bodyColor: '#fff', padding: 10, cornerRadius: 10,
                                    callbacks: { label: (c) => c.parsed.y !== null ? ` ${c.parsed.y}${m.unit}` : ' —' }
                                }
                            },
                            scales: {
                                x: { ticks: { color: 'rgba(255,219,137,0.5)', font: { size: 10 }, maxRotation: 0 }, grid: { color: 'rgba(255,219,137,0.06)' }, border: { color: 'transparent' } },
                                y: { min: yMin, max: yMax, beginAtZero: false, ticks: { color: 'rgba(255,219,137,0.5)', font: { size: 10 } }, grid: { color: 'rgba(255,219,137,0.06)' }, border: { color: 'transparent' } }
                            }
                        }
                    });
                    // Stats
                    const vals = m.data.filter(v => v !== null);
                    if (vals.length) {
                        const latest = vals[vals.length-1], first = vals[0], delta = latest - first;
                        const best = m.lower ? Math.min(...vals) : Math.max(...vals);
                        document.getElementById('tr-stat-current').textContent = latest + m.unit;
                        const ce = document.getElementById('tr-stat-change');
                        ce.textContent = (delta > 0 ? '+' : '') + delta.toFixed(1) + m.unit;
                        const good = (m.lower && delta <= 0) || (!m.lower && delta >= 0);
                        ce.className = `text-lg font-black ${delta === 0 ? 'text-[#FFDB89]/40' : good ? 'text-green-400' : 'text-red-400'}`;
                        document.getElementById('tr-stat-best').textContent = best + m.unit;
                    }
                };

                document.querySelectorAll('.tr-metric-btn').forEach(btn => {
                    btn.addEventListener('click', () => {
                        trActive = btn.dataset.metric;
                        document.querySelectorAll('.tr-metric-btn').forEach(b => {
                            const on = b.dataset.metric === trActive;
                            b.className = `tr-metric-btn px-3 py-1 rounded-lg text-xs font-bold transition ${on ? 'bg-[#FFDB89] text-[#030303]' : 'text-[#FFDB89]/50 hover:text-[#FFDB89]'}`;
                        });
                        renderTrainerChart(trActive);
                    });
                });

                const trCircumSel = document.getElementById('tr-circum-field-select');
                if (trCircumSel) {
                    trCircumSel.addEventListener('change', () => {
                        trActiveCircumKey = trCircumSel.value;
                        renderTrainerChart('circum');
                    });
                }

                renderTrainerChart(trActive);
            }
        } catch (e) { container.innerHTML = '<p class="text-red-400 text-sm">Error cargando métricas.</p>'; }
    };

    window.showAddMeasurementModal = (clientId, heightInches) => {
        const existing = document.getElementById('add-measurement-modal');
        if (existing) existing.remove();
        const today = new Date().toISOString().split('T')[0];
        const inputCls = 'w-full p-2 bg-white/10 border border-[#FFDB89]/30 rounded-lg text-[#FFDB89] text-sm outline-none focus:ring-2 focus:ring-[#FFDB89] placeholder-[#FFDB89]/30';
        const labelCls = 'block text-xs font-bold text-[#FFDB89]/70 uppercase mb-1';
        document.body.insertAdjacentHTML('beforeend', `
            <div id="add-measurement-modal" class="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
                <div class="bg-[#030303]/95 backdrop-blur-2xl border border-[#FFDB89]/20 rounded-2xl shadow-2xl w-full max-w-2xl p-7 overflow-y-auto max-h-[90vh]">
                    <div class="flex justify-between items-center mb-6">
                        <h3 class="text-xl font-bold text-[#FFDB89]"><i class="fas fa-ruler-combined mr-2 text-[#FFDB89]"></i>Agregar medición</h3>
                        <button onclick="document.getElementById('add-measurement-modal').remove()" class="text-[#FFDB89]/50 hover:text-[#FFDB89] transition text-xl">&times;</button>
                    </div>

                    <!-- Date + Key Numbers -->
                    <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                        <div class="md:col-span-1">
                            <label class="${labelCls}">Fecha</label>
                            <input type="date" id="m-date" value="${today}" class="${inputCls}">
                        </div>
                        <div>
                            <label class="${labelCls}">Peso (lbs)</label>
                            <input type="number" id="m-weight" step="0.1" placeholder="124.4" class="${inputCls}" oninput="window.calcBMI(${heightInches})">
                        </div>
                        <div>
                            <label class="${labelCls}">% Grasa</label>
                            <input type="number" id="m-bodyfat" step="0.1" placeholder="18.4" class="${inputCls}">
                        </div>
                        <div>
                            <label class="${labelCls}">BMI (auto)</label>
                            <input type="text" id="m-bmi" readonly placeholder="—" class="${inputCls} opacity-60 cursor-default">
                        </div>
                    </div>

                    <!-- Body Measurements -->
                    <p class="text-xs font-bold text-[#FFDB89]/50 uppercase tracking-wider mb-3">Medidas (pulg)</p>
                    <div class="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
                        <div>
                            <label class="${labelCls}">Pecho</label>
                            <input type="text" id="m-pecho" placeholder='35 4/8' class="${inputCls}">
                        </div>
                        <div>
                            <label class="${labelCls}">Bíceps</label>
                            <input type="text" id="m-biceps" placeholder='10 4/8R 10 5/8L' class="${inputCls}">
                        </div>
                        <div>
                            <label class="${labelCls}">Cintura</label>
                            <input type="text" id="m-cintura" placeholder='27 2/8' class="${inputCls}">
                        </div>
                        <div>
                            <label class="${labelCls}">Cadera</label>
                            <input type="text" id="m-cadera" placeholder='36 6/8' class="${inputCls}">
                        </div>
                        <div>
                            <label class="${labelCls}">Quads</label>
                            <input type="text" id="m-quads" placeholder='18 7/8R 18 5/8L' class="${inputCls}">
                        </div>
                        <div>
                            <label class="${labelCls}">Pantorrillas</label>
                            <input type="text" id="m-calves" placeholder='13 5/8R 13 5/8L' class="${inputCls}">
                        </div>
                    </div>

                    <!-- Notes -->
                    <div class="mb-6">
                        <label class="${labelCls}">Notas (opcional)</label>
                        <input type="text" id="m-notes" placeholder="Observaciones de esta sesión..." class="${inputCls}">
                    </div>

                    <div class="flex justify-end gap-3">
                        <button onclick="document.getElementById('add-measurement-modal').remove()"
                            class="px-5 py-2.5 text-[#FFDB89]/70 hover:text-[#FFDB89] font-medium transition">Cancelar</button>
                        <button onclick="window.saveMeasurement('${clientId}')"
                            class="px-6 py-2.5 bg-[#3a3a3c] hover:bg-[#3a3a3c]/80 text-[#FFDB89] rounded-lg font-bold transition shadow-md">
                            Guardar medición
                        </button>
                    </div>
                </div>
            </div>
        `);
    };

    window.calcBMI = (heightInches) => {
        const weight = parseFloat(document.getElementById('m-weight')?.value);
        const bmiEl = document.getElementById('m-bmi');
        if (!bmiEl) return;
        if (!weight || !heightInches) { bmiEl.value = '—'; return; }
        const bmi = (weight / (heightInches * heightInches)) * 703;
        bmiEl.value = bmi.toFixed(1);
    };

    window.saveMeasurement = async (clientId) => {
        const date    = document.getElementById('m-date')?.value;
        const weight  = parseFloat(document.getElementById('m-weight')?.value) || null;
        const bodyFat = parseFloat(document.getElementById('m-bodyfat')?.value) || null;
        const bmi     = parseFloat(document.getElementById('m-bmi')?.value) || null;
        const pecho   = document.getElementById('m-pecho')?.value.trim() || '';
        const biceps  = document.getElementById('m-biceps')?.value.trim() || '';
        const cintura = document.getElementById('m-cintura')?.value.trim() || '';
        const cadera  = document.getElementById('m-cadera')?.value.trim() || '';
        const quads   = document.getElementById('m-quads')?.value.trim() || '';
        const calves  = document.getElementById('m-calves')?.value.trim() || '';
        const notes   = document.getElementById('m-notes')?.value.trim() || '';
        if (!date) { showToast('La fecha es requerida.', 'error'); return; }
        try {
            const res = await apiFetch('/api/body-measurements', {
                method: 'POST',
                body: JSON.stringify({ clientId, date, weight, bodyFat, bmi, pecho, biceps, cintura, cadera, quads, calves, notes })
            });
            if (res.ok) {
                document.getElementById('add-measurement-modal')?.remove();
                loadClientMetrics(clientId);
            } else {
                const err = await res.json();
                showToast(err.message || 'Error guardando medición.', 'error');
            }
        } catch (e) { console.error(e); showToast('Error de conexión.', 'error'); }
    };

    window.deleteMeasurement = async (clientId, measurementId) => {
        const yes = await showConfirm('¿Eliminar este registro?', { confirmLabel: 'Eliminar', danger: true });
        if (!yes) return;
        try {
            await apiFetch(`/api/body-measurements/${measurementId}`, { method: 'DELETE' });
            loadClientMetrics(clientId);
        } catch (e) { showToast('Error eliminando registro.', 'error'); }
    };

    // ─── Shared macro calculator ─────────────────────────────────────────────
    // Renders a full interactive macro calculator card into `container`.
    // `clientData` = { weight, bodyFat, macroSettings }  (from DB)
    // `clientId`   = MongoDB _id (null for client self-view)
    // `readOnly`   = if true, hides the save button (client self-view)
    const renderMacroCalculator = (container, clientData, clientId = null, readOnly = false) => {
        const weight   = parseMeasurement(clientData.weight);
        const rawBf    = parseMeasurement(clientData.bodyFat);
        if (!weight || rawBf === null) {
            container.innerHTML = `<div class="bg-[#1C1C1E] border border-[#FFDB89]/10 rounded-2xl p-6 text-center text-[#FFDB89]/40 text-sm">
                <i class="fas fa-ruler-combined text-2xl mb-2 block"></i>Sin evaluación registrada. Agrega una medición para calcular los macros recomendados.</div>`;
            return;
        }
        // Normalise body fat to decimal (store as 0.24 OR 24 — handle both)
        const bfDecimal = rawBf > 1 ? rawBf / 100 : rawBf;
        const ms        = clientData.macroSettings || {};
        const initGoal  = ms.goal         || 'maintain';
        const initPro   = Math.round((ms.proteinRatio ?? 0.4) * 100);
        const initFat   = Math.round((ms.fatRatio     ?? 0.3) * 100);
        const initCarb  = Math.round((ms.carbRatio    ?? 0.3) * 100);
        const evalDate  = clientData.evalDate || '';

        // Pre-compute fixed values
        const lbm         = weight * (1 - bfDecimal);
        const water        = weight * 0.667;
        const maintenance  = lbm * 11 + 800;
        const goalCalMap   = { maintain: 0, cut250: -250, cut500: -500, bulk250: +250, bulk500: +500 };

        const goalLabels = {
            maintain: 'Mantener',
            cut250:   'Déficit  −250',
            cut500:   'Déficit  −500',
            bulk250:  'Superávit  +250',
            bulk500:  'Superávit  +500'
        };
        const goalColors = {
            maintain: '#FFDB89',
            cut250:   '#6EE7B7',
            cut500:   '#34D399',
            bulk250:  '#FB923C',
            bulk500:  '#F97316'
        };

        const collapsed = readOnly && localStorage.getItem('macroCalcCollapsed') === 'true';

        container.innerHTML = `
        <div class="glass-card rounded-2xl overflow-hidden">

            <!-- Header -->
            <div class="px-6 py-4 ${collapsed ? '' : 'border-b border-[#FFDB89]/10'} flex items-center justify-between">
                <div>
                    <h3 class="text-base font-bold text-[#FFDB89]">Macros Recomendados</h3>
                    ${evalDate ? `<p class="text-xs text-[#FFDB89]/35 mt-0.5">Basado en evaluación del ${evalDate}</p>` : ''}
                </div>
                <div class="flex items-center gap-3">
                    ${readOnly ? `<button id="mc-collapse-btn" class="flex items-center gap-1.5 text-xs text-[#FFDB89]/40 hover:text-[#FFDB89]/70 transition font-medium">
                        <i id="mc-collapse-icon" class="fas ${collapsed ? 'fa-chevron-down' : 'fa-chevron-up'} text-[10px]"></i>
                        <span id="mc-collapse-label">${collapsed ? 'Mostrar' : 'Ocultar'}</span>
                    </button>` : ''}
                    <i class="fas fa-calculator text-[#FFDB89]/20 text-2xl"></i>
                </div>
            </div>

            <!-- Collapsible body -->
            <div id="mc-collapsible-body" class="${collapsed ? 'hidden' : ''}">

            <!-- Body stats row -->
            <div class="grid grid-cols-2 md:grid-cols-4 divide-y md:divide-y-0 divide-x-0 md:divide-x divide-[#FFDB89]/10 border-b border-[#FFDB89]/10">
                <div class="px-4 py-3 text-center">
                    <p class="text-[10px] font-bold text-[#FFDB89]/40 uppercase tracking-wider mb-0.5">Peso Actual</p>
                    <p class="text-xl font-black text-[#FFDB89]">${weight.toFixed(1)} lbs</p>
                </div>
                <div class="px-4 py-3 text-center">
                    <p class="text-[10px] font-bold text-[#F87171]/60 uppercase tracking-wider mb-0.5">% Grasa</p>
                    <p class="text-xl font-black text-[#F87171]">${(bfDecimal * 100).toFixed(1)}%</p>
                </div>
                <div class="px-4 py-3 text-center">
                    <p class="text-[10px] font-bold text-[#6EE7B7]/60 uppercase tracking-wider mb-0.5">Masa Magra</p>
                    <p class="text-xl font-black text-[#6EE7B7]">${lbm.toFixed(1)} lbs</p>
                </div>
                <div class="px-4 py-3 text-center">
                    <p class="text-[10px] font-bold text-sky-400/60 uppercase tracking-wider mb-0.5">Agua / Día</p>
                    <p class="text-xl font-black text-sky-400">${water.toFixed(0)} oz</p>
                </div>
            </div>

            <!-- Calorie reference row -->
            <div class="px-6 py-3 border-b border-[#FFDB89]/10 flex flex-wrap items-center gap-6">
                <div class="text-xs text-[#FFDB89]/40">Mantenimiento <span class="text-[#FFDB89] font-bold ml-1">${Math.round(maintenance).toLocaleString()} kcal</span></div>
                <div class="text-xs text-[#FFDB89]/40">Déficit −250 <span class="text-[#6EE7B7] font-bold ml-1">${Math.round(maintenance - 250).toLocaleString()} kcal</span></div>
                <div class="text-xs text-[#FFDB89]/40">Déficit −500 <span class="text-[#34D399] font-bold ml-1">${Math.round(maintenance - 500).toLocaleString()} kcal</span></div>
                <div class="text-xs text-[#FFDB89]/40">Superávit +250 <span class="text-[#FB923C] font-bold ml-1">${Math.round(maintenance + 250).toLocaleString()} kcal</span></div>
                <div class="text-xs text-[#FFDB89]/40">Superávit +500 <span class="text-[#F97316] font-bold ml-1">${Math.round(maintenance + 500).toLocaleString()} kcal</span></div>
            </div>

            <!-- Goal pills -->
            <div class="px-6 py-4 border-b border-[#FFDB89]/10">
                <p class="text-[10px] font-bold text-[#FFDB89]/40 uppercase tracking-wider mb-3">Objetivo</p>
                <div class="flex flex-wrap gap-2" id="mc-goal-pills">
                    ${Object.entries(goalLabels).map(([k, label]) => `
                        <button class="mc-goal-btn px-3 py-1.5 rounded-lg text-xs font-bold border transition" data-goal="${k}"
                            style="${k === initGoal ? `background:${goalColors[k]}22; border-color:${goalColors[k]}; color:${goalColors[k]}` : 'border-color:rgba(255,219,137,0.2); color:rgba(255,219,137,0.4)'}">
                            ${label}
                        </button>`).join('')}
                </div>
            </div>

            <!-- Macro ratio sliders -->
            <div class="px-6 py-4 border-b border-[#FFDB89]/10">
                <div class="flex flex-wrap items-center gap-4">
                    <p class="text-[10px] font-bold text-[#FFDB89]/40 uppercase tracking-wider">Distribución</p>
                    <label class="flex items-center gap-1.5">
                        <span class="text-xs font-bold text-[#F87171]">Proteína</span>
                        <input id="mc-ratio-pro" type="number" min="10" max="80" value="${initPro}"
                            class="w-14 px-2 py-1 text-center rounded-lg border border-[#F87171]/30 bg-[#F87171]/10 text-[#F87171] text-sm font-black outline-none focus:ring-1 focus:ring-[#F87171]">
                        <span class="text-xs text-[#F87171]/60">%</span>
                    </label>
                    <label class="flex items-center gap-1.5">
                        <span class="text-xs font-bold text-orange-400">Grasas</span>
                        <input id="mc-ratio-fat" type="number" min="10" max="80" value="${initFat}"
                            class="w-14 px-2 py-1 text-center rounded-lg border border-orange-400/30 bg-orange-400/10 text-orange-400 text-sm font-black outline-none focus:ring-1 focus:ring-orange-400">
                        <span class="text-xs text-orange-400/60">%</span>
                    </label>
                    <label class="flex items-center gap-1.5">
                        <span class="text-xs font-bold text-yellow-400">Carbos</span>
                        <input id="mc-ratio-carb" type="number" min="10" max="80" value="${initCarb}"
                            class="w-14 px-2 py-1 text-center rounded-lg border border-yellow-400/30 bg-yellow-400/10 text-yellow-400 text-sm font-black outline-none focus:ring-1 focus:ring-yellow-400">
                        <span class="text-xs text-yellow-400/60">%</span>
                    </label>
                    <span id="mc-sum-check" class="text-xs font-bold text-green-400"></span>
                </div>
            </div>

            <!-- Results -->
            <div class="grid grid-cols-3 divide-x divide-[#FFDB89]/10 border-b border-[#FFDB89]/10">
                <div class="px-6 py-5 text-center">
                    <p class="text-[10px] font-bold text-[#F87171]/60 uppercase tracking-wider mb-3">Proteína</p>
                    <p class="text-2xl font-black text-[#F87171]" id="mc-cal-pro">—</p>
                    <p class="text-xs text-[#F87171]/50 mt-0.5">kcal / día</p>
                    <p class="text-lg font-black text-[#F87171]/80 mt-2" id="mc-g-pro">—</p>
                    <p class="text-xs text-[#F87171]/40">gramos / día</p>
                </div>
                <div class="px-6 py-5 text-center">
                    <p class="text-[10px] font-bold text-orange-400/60 uppercase tracking-wider mb-3">Grasas</p>
                    <p class="text-2xl font-black text-orange-400" id="mc-cal-fat">—</p>
                    <p class="text-xs text-orange-400/50 mt-0.5">kcal / día</p>
                    <p class="text-lg font-black text-orange-400/80 mt-2" id="mc-g-fat">—</p>
                    <p class="text-xs text-orange-400/40">gramos / día</p>
                </div>
                <div class="px-6 py-5 text-center">
                    <p class="text-[10px] font-bold text-yellow-400/60 uppercase tracking-wider mb-3">Carbohidratos</p>
                    <p class="text-2xl font-black text-yellow-400" id="mc-cal-carb">—</p>
                    <p class="text-xs text-yellow-400/50 mt-0.5">kcal / día</p>
                    <p class="text-lg font-black text-yellow-400/80 mt-2" id="mc-g-carb">—</p>
                    <p class="text-xs text-yellow-400/40">gramos / día</p>
                </div>
            </div>

            <!-- Meta total + save -->
            <div class="px-6 py-4 flex items-center justify-between flex-wrap gap-3">
                <div>
                    <span class="text-xs text-[#FFDB89]/40">Meta calórica diaria</span>
                    <span class="ml-2 text-xl font-black text-[#FFDB89]" id="mc-total-cal">—</span>
                    <span class="text-xs text-[#FFDB89]/40 ml-1">kcal</span>
                </div>
                ${!readOnly ? `<button id="mc-save-btn" class="px-5 py-2.5 bg-[#FFDB89] text-[#030303] rounded-xl text-sm font-black hover:bg-[#FFDB89]/80 transition flex items-center gap-2">
                    <i class="fas fa-save"></i> Guardar configuración
                </button>` : ''}
            </div>

            </div><!-- end mc-collapsible-body -->
        </div>`;

        // ── JS logic ──────────────────────────────────────────────────────
        let currentGoal = initGoal;

        const recompute = () => {
            const proRatio  = (parseFloat(document.getElementById('mc-ratio-pro')?.value)  || 0) / 100;
            const fatRatio  = (parseFloat(document.getElementById('mc-ratio-fat')?.value)  || 0) / 100;
            const carbRatio = (parseFloat(document.getElementById('mc-ratio-carb')?.value) || 0) / 100;
            const sumCheck  = document.getElementById('mc-sum-check');
            const total     = Math.round(proRatio * 100) + Math.round(fatRatio * 100) + Math.round(carbRatio * 100);

            if (sumCheck) {
                if (total === 100) {
                    sumCheck.textContent = '= 100% ✓';
                    sumCheck.className = 'text-xs font-bold text-green-400';
                } else {
                    sumCheck.textContent = `= ${total}% (debe sumar 100%)`;
                    sumCheck.className = 'text-xs font-bold text-red-400';
                }
            }
            if (total !== 100) return;

            const delta    = goalCalMap[currentGoal] ?? 0;
            const targetCal = maintenance + delta;
            const calPro   = targetCal * proRatio;
            const calFat   = targetCal * fatRatio;
            const calCarb  = targetCal * carbRatio;

            const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
            set('mc-total-cal', Math.round(targetCal).toLocaleString());
            set('mc-cal-pro',   Math.round(calPro).toLocaleString());
            set('mc-g-pro',     `${Math.round(calPro / 4)} g`);
            set('mc-cal-fat',   Math.round(calFat).toLocaleString());
            set('mc-g-fat',     `${Math.round(calFat / 9)} g`);
            set('mc-cal-carb',  Math.round(calCarb).toLocaleString());
            set('mc-g-carb',    `${Math.round(calCarb / 4)} g`);
        };

        // Goal pill clicks
        container.querySelectorAll('.mc-goal-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                currentGoal = btn.dataset.goal;
                container.querySelectorAll('.mc-goal-btn').forEach(b => {
                    const g = b.dataset.goal;
                    const active = g === currentGoal;
                    b.style.background      = active ? `${goalColors[g]}22` : 'transparent';
                    b.style.borderColor     = active ? goalColors[g] : 'rgba(255,219,137,0.2)';
                    b.style.color           = active ? goalColors[g] : 'rgba(255,219,137,0.4)';
                });
                recompute();
            });
        });

        // Ratio input changes
        ['mc-ratio-pro','mc-ratio-fat','mc-ratio-carb'].forEach(id => {
            document.getElementById(id)?.addEventListener('input', recompute);
        });

        // Collapse toggle (client view only)
        if (readOnly) {
            document.getElementById('mc-collapse-btn')?.addEventListener('click', () => {
                const body  = document.getElementById('mc-collapsible-body');
                const icon  = document.getElementById('mc-collapse-icon');
                const label = document.getElementById('mc-collapse-label');
                const hdr   = document.getElementById('mc-collapse-btn')?.closest('.px-6');
                const isNowCollapsed = !body.classList.contains('hidden');
                body.classList.toggle('hidden', isNowCollapsed);
                if (icon)  icon.className  = `fas ${isNowCollapsed ? 'fa-chevron-down' : 'fa-chevron-up'} text-[10px]`;
                if (label) label.textContent = isNowCollapsed ? 'Mostrar' : 'Ocultar';
                if (hdr)   hdr.classList.toggle('border-b', !isNowCollapsed);
                if (hdr)   hdr.classList.toggle('border-[#FFDB89]/10', !isNowCollapsed);
                localStorage.setItem('macroCalcCollapsed', isNowCollapsed ? 'true' : 'false');
            });
        }

        // Save button
        if (!readOnly) {
            document.getElementById('mc-save-btn')?.addEventListener('click', async () => {
                const proRatio  = (parseFloat(document.getElementById('mc-ratio-pro')?.value)  || 40) / 100;
                const fatRatio  = (parseFloat(document.getElementById('mc-ratio-fat')?.value)  || 30) / 100;
                const carbRatio = (parseFloat(document.getElementById('mc-ratio-carb')?.value) || 30) / 100;

                // Compute actual calorie/gram targets to push to client
                const delta      = goalCalMap[currentGoal] ?? 0;
                const targetCal  = Math.round(maintenance + delta);
                const goalProtein = Math.round(targetCal * proRatio / 4);
                const goalFat_g   = Math.round(targetCal * fatRatio  / 9);
                const goalCarbs_g = Math.round(targetCal * carbRatio / 4);

                const payload = { macroSettings: { goal: currentGoal, proteinRatio: proRatio, fatRatio, carbRatio,
                    targetCal, goalProtein, goalFat: goalFat_g, goalCarbs: goalCarbs_g } };
                const url    = clientId ? `/api/clients/${clientId}` : '/api/me';
                try {
                    const r = await apiFetch(url, { method: 'PUT', body: JSON.stringify(payload) });
                    if (r.ok) {
                        const btn = document.getElementById('mc-save-btn');
                        if (btn) { btn.innerHTML = '<i class="fas fa-check mr-2"></i>Guardado'; btn.classList.add('bg-green-400'); setTimeout(() => { btn.innerHTML = '<i class="fas fa-save mr-2"></i>Guardar configuración'; btn.classList.remove('bg-green-400'); }, 2000); }
                    }
                } catch(e) { console.error('Error saving macro settings', e); }
            });
        }

        recompute();
    };

    const loadClientNutrition = async (clientId) => {
        const container = document.getElementById('tab-nutrition');
        if (!container) return;
        try {
            const [logsRes, measRes] = await Promise.all([
                apiFetch(`/api/nutrition-logs/${clientId}`),
                apiFetch(`/api/body-measurements/${clientId}`)
            ]);
            const logs         = logsRes.ok ? await logsRes.json() : [];
            const measurements = measRes.ok ? await measRes.json() : [];
            const clientData   = clientsCache.find(c => c._id === clientId) || {};
            const latest       = measurements.length ? measurements[measurements.length - 1] : null;

            // Build macro calc data from latest measurement + client profile
            const macroData = latest
                ? { weight: parseMeasurement(latest.weight), bodyFat: parseMeasurement(latest.bodyFat),
                    macroSettings: clientData.macroSettings, evalDate: latest.date }
                : null;
            container.innerHTML = `
                <div class="space-y-6 max-w-4xl mx-auto">
                    <div id="macro-calc-wrapper"></div>
                    <div class="flex justify-between items-center">
                        <h3 class="text-xl font-bold text-[#FFDB89]">Historial de nutrición</h3>
                        <button onclick="window.showAddNutritionModal('${clientId}')" class="px-4 py-2 bg-[#3a3a3c] hover:bg-[#3a3a3c]/80 text-[#FFDB89] rounded-lg text-sm font-bold transition">
                            <i class="fas fa-plus mr-1"></i> Registrar nutrición
                        </button>
                    </div>
                    <div class="overflow-x-auto">
                        <table class="w-full text-sm border-collapse">
                            <thead>
                                <tr class="border-b border-[#FFDB89]/20">
                                    <th class="px-4 py-3 text-left text-xs font-bold text-[#FFDB89] uppercase tracking-wider">Fecha</th>
                                    <th class="px-4 py-3 text-left text-xs font-bold text-[#FFDB89] uppercase tracking-wider">Calorías</th>
                                    <th class="px-4 py-3 text-left text-xs font-bold text-[#FFDB89] uppercase tracking-wider">Proteína</th>
                                    <th class="px-4 py-3 text-left text-xs font-bold text-[#FFDB89] uppercase tracking-wider">Carbos</th>
                                    <th class="px-4 py-3 text-left text-xs font-bold text-[#FFDB89] uppercase tracking-wider">Grasa</th>
                                    <th class="px-4 py-3 text-left text-xs font-bold text-[#FFDB89] uppercase tracking-wider">Agua (oz)</th>
                                    <th class="px-4 py-3 text-left text-xs font-bold text-[#FFDB89] uppercase tracking-wider">Notas</th>
                                    <th class="px-4 py-3 w-10"></th>
                                </tr>
                            </thead>
                            <tbody class="divide-y divide-[#FFDB89]/10">
                                ${logs.length === 0 ? '<tr><td colspan="8" class="p-6 text-center text-[#FFDB89]/40">Sin registros de nutrición. Haz clic en "Registrar nutrición" para comenzar.</td></tr>' :
                                logs.map(l => `<tr class="group hover:bg-[#FFDB89]/5 transition">
                                    <td class="px-4 py-3 text-[#FFDB89]">${l.date}</td>
                                    <td class="px-4 py-3 font-bold text-[#FFDB89]">${l.calories}</td>
                                    <td class="px-4 py-3 text-[#FFDB89]/70">${l.protein}g</td>
                                    <td class="px-4 py-3 text-[#FFDB89]/70">${l.carbs}g</td>
                                    <td class="px-4 py-3 text-[#FFDB89]/70">${l.fat}g</td>
                                    <td class="px-4 py-3 text-[#FFDB89]/70">${l.water || '--'}</td>
                                    <td class="px-4 py-3 text-[#FFDB89]/50">${l.notes || '--'}</td>
                                    <td class="px-4 py-3 text-right">
                                        <button onclick="window._deleteClientNutriLog('${l._id}','${clientId}')" class="opacity-0 group-hover:opacity-100 text-red-400/50 hover:text-red-400 transition p-1 rounded" title="Eliminar registro">
                                            <i class="fas fa-trash-alt text-xs"></i>
                                        </button>
                                    </td>
                                </tr>`).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            `;
            // Inject macro calculator into its wrapper
            const calcWrapper = document.getElementById('macro-calc-wrapper');
            if (calcWrapper && macroData) renderMacroCalculator(calcWrapper, macroData, clientId, false);
            else if (calcWrapper) calcWrapper.innerHTML = `<div class="bg-[#1C1C1E] border border-[#FFDB89]/10 rounded-2xl p-6 text-center text-[#FFDB89]/40 text-sm"><i class="fas fa-ruler-combined text-2xl mb-2 block"></i>Sin evaluación registrada. Agrega una medición para ver los macros recomendados.</div>`;
        } catch (e) { container.innerHTML = '<p class="text-red-500">Error cargando nutricion.</p>'; }
    };

    window._deleteClientNutriLog = async (logId, clientId) => {
        const yes = await showConfirm('¿Eliminar este registro de nutrición?', { confirmLabel: 'Eliminar', danger: true });
        if (!yes) return;
        try {
            const res = await apiFetch(`/api/nutrition-logs/${logId}`, { method: 'DELETE' });
            if (res.ok) {
                loadClientNutrition(clientId);
            } else {
                showToast('Error eliminando el registro.', 'error');
            }
        } catch (e) {
            showToast('Error de conexión.', 'error');
        }
    };

    window.showAddNutritionModal = (clientId) => {
        const existing = document.getElementById('add-nutrition-modal');
        if (existing) existing.remove();
        const today = new Date().toISOString().split('T')[0];
        document.body.insertAdjacentHTML('beforeend', `
            <div id="add-nutrition-modal" class="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 backdrop-blur-sm">
                <div class="bg-[#030303]/95 backdrop-blur-2xl border border-[#FFDB89]/20 rounded-2xl shadow-2xl w-full max-w-md p-6">
                    <h3 class="text-lg font-bold text-[#FFDB89] mb-4">Registrar nutrición</h3>
                    <div class="space-y-4">
                        <div>
                            <label class="block text-xs font-bold text-[#FFDB89]/70 uppercase mb-1">Fecha</label>
                            <input type="date" id="nutri-date" value="${today}" class="w-full p-2.5 bg-white/10 border border-[#FFDB89]/30 rounded-lg text-[#FFDB89] text-sm outline-none focus:ring-2 focus:ring-[#FFDB89]">
                        </div>
                        <div class="grid grid-cols-2 gap-3">
                            <div>
                                <label class="block text-xs font-bold text-[#FFDB89]/70 uppercase mb-1">Calorías</label>
                                <input type="number" id="nutri-calories" class="w-full p-2.5 bg-white/10 border border-[#FFDB89]/30 rounded-lg text-[#FFDB89] text-sm outline-none focus:ring-2 focus:ring-[#FFDB89] placeholder-[#FFDB89]/30" placeholder="0">
                            </div>
                            <div>
                                <label class="block text-xs font-bold text-[#FFDB89]/70 uppercase mb-1">Proteína (g)</label>
                                <input type="number" id="nutri-protein" class="w-full p-2.5 bg-white/10 border border-[#FFDB89]/30 rounded-lg text-[#FFDB89] text-sm outline-none focus:ring-2 focus:ring-[#FFDB89] placeholder-[#FFDB89]/30" placeholder="0">
                            </div>
                            <div>
                                <label class="block text-xs font-bold text-[#FFDB89]/70 uppercase mb-1">Carbos (g)</label>
                                <input type="number" id="nutri-carbs" class="w-full p-2.5 bg-white/10 border border-[#FFDB89]/30 rounded-lg text-[#FFDB89] text-sm outline-none focus:ring-2 focus:ring-[#FFDB89] placeholder-[#FFDB89]/30" placeholder="0">
                            </div>
                            <div>
                                <label class="block text-xs font-bold text-[#FFDB89]/70 uppercase mb-1">Grasa (g)</label>
                                <input type="number" id="nutri-fat" class="w-full p-2.5 bg-white/10 border border-[#FFDB89]/30 rounded-lg text-[#FFDB89] text-sm outline-none focus:ring-2 focus:ring-[#FFDB89] placeholder-[#FFDB89]/30" placeholder="0">
                            </div>
                        </div>
                        <div>
                            <label class="block text-xs font-bold text-[#FFDB89]/70 uppercase mb-1">Agua (oz)</label>
                            <input type="number" id="nutri-water" class="w-full p-2.5 bg-white/10 border border-[#FFDB89]/30 rounded-lg text-[#FFDB89] text-sm outline-none focus:ring-2 focus:ring-[#FFDB89] placeholder-[#FFDB89]/30" placeholder="0">
                        </div>
                        <div>
                            <label class="block text-xs font-bold text-[#FFDB89]/70 uppercase mb-1">Notas (opcional)</label>
                            <input type="text" id="nutri-notes" class="w-full p-2.5 bg-white/10 border border-[#FFDB89]/30 rounded-lg text-[#FFDB89] text-sm outline-none focus:ring-2 focus:ring-[#FFDB89] placeholder-[#FFDB89]/30" placeholder="Notas...">
                        </div>
                    </div>
                    <div class="flex justify-end gap-3 mt-6">
                        <button onclick="document.getElementById('add-nutrition-modal').remove()" class="px-4 py-2 text-[#FFDB89]/70 hover:text-[#FFDB89] font-medium transition">Cancelar</button>
                        <button onclick="window.saveNutritionLog('${clientId}')" class="px-4 py-2 bg-[#3a3a3c] hover:bg-[#3a3a3c]/80 text-[#FFDB89] rounded-lg font-bold transition">Guardar</button>
                    </div>
                </div>
            </div>
        `);
    };

    window.saveNutritionLog = async (clientId) => {
        const date = document.getElementById('nutri-date')?.value;
        const calories = parseInt(document.getElementById('nutri-calories')?.value) || 0;
        const protein = parseInt(document.getElementById('nutri-protein')?.value) || 0;
        const carbs = parseInt(document.getElementById('nutri-carbs')?.value) || 0;
        const fat = parseInt(document.getElementById('nutri-fat')?.value) || 0;
        const water = parseInt(document.getElementById('nutri-water')?.value) || 0;
        const notes = document.getElementById('nutri-notes')?.value || '';
        if (!date) { showToast('Fecha es requerida.', 'error'); return; }
        try {
            const res = await apiFetch('/api/nutrition-logs', {
                method: 'POST',
                body: JSON.stringify({ clientId, date, calories, protein, carbs, fat, water, notes })
            });
            if (res.ok) {
                document.getElementById('add-nutrition-modal')?.remove();
                loadClientNutrition(clientId);
            } else { showToast('Error guardando registro.', 'error'); }
        } catch (e) { showToast('Error de conexión.', 'error'); }
    };

    const loadClientPhotos = async (clientId) => {
        const container = document.getElementById('tab-photos');
        if (!container) return;
        try {
            const res = await apiFetch(`/api/progress-photos/${clientId}`);
            const photos = res.ok ? await res.json() : [];

            let compareMode = false;
            let selectedIds = [];

            const renderPhotoGrid = () => {
                container.innerHTML = `
                    <div class="space-y-4 max-w-4xl mx-auto">
                        <div class="flex flex-wrap justify-between items-center gap-3">
                            <h3 class="text-xl font-bold text-[#FFDB89]">Fotos de progreso</h3>
                            <div class="flex items-center gap-2">
                                ${photos.length >= 2 ? `
                                <button id="tr-compare-toggle" class="px-3 py-2 rounded-lg text-xs font-bold border transition ${compareMode ? 'bg-[#92A9E1] text-white border-[#92A9E1]' : 'border-[#92A9E1]/30 text-[#92A9E1]/70 hover:text-[#92A9E1]'}">
                                    <i class="fas fa-columns mr-1.5"></i>${compareMode ? 'Cancelar' : 'Comparar'}
                                </button>` : ''}
                                <button onclick="window.showAddPhotoModal('${clientId}')" class="px-4 py-2 bg-[#3a3a3c] hover:bg-[#3a3a3c]/80 text-[#FFDB89] rounded-lg text-sm font-bold transition">
                                    <i class="fas fa-camera mr-1"></i> Subir foto
                                </button>
                            </div>
                        </div>
                        ${compareMode ? `<p class="text-xs text-[#92A9E1]/60 text-center">Selecciona 2 fotos para comparar</p>` : ''}
                        <div id="tr-photos-grid" class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                            ${photos.length === 0
                                ? '<div class="col-span-full text-center py-12 text-[#FFDB89]/40"><i class="fas fa-camera text-5xl mb-3 block"></i><p>Sin fotos de progreso.</p></div>'
                                : photos.map(p => {
                                    const [y, mo, d] = (p.date || '').split('-');
                                    const dateStr = p.date ? `${d}/${mo}/${y}` : '—';
                                    const isSelected = selectedIds.includes(p._id);
                                    return `
                                    <div class="relative group bg-[#2C2C2E] rounded-xl overflow-hidden border ${isSelected ? 'border-[#92A9E1] ring-2 ring-[#92A9E1]' : 'border-[#FFDB89]/20'} shadow-sm cursor-pointer transition-all"
                                         data-photo-id="${p._id}" onclick="window._trPhotoClick('${p._id}')">
                                        <img src="${p.imageData}" alt="Progress" class="w-full aspect-[3/4] object-cover">
                                        ${isSelected ? `<div class="absolute inset-0 bg-[#92A9E1]/20 flex items-start justify-end p-2"><div class="w-6 h-6 bg-[#92A9E1] rounded-full flex items-center justify-center text-white text-xs font-bold">${selectedIds.indexOf(p._id)+1}</div></div>` : ''}
                                        <div class="p-2">
                                            <p class="text-xs font-bold text-[#FFDB89]/70">${dateStr}</p>
                                            ${p.category ? `<p class="text-[10px] text-[#FFDB89]/40">${p.category}</p>` : ''}
                                            ${p.notes ? `<p class="text-xs text-[#FFDB89]/50 truncate">${p.notes}</p>` : ''}
                                        </div>
                                        ${!compareMode ? `<button onclick="event.stopPropagation(); window.deleteProgressPhoto('${p._id}','${clientId}')"
                                            class="absolute top-2 right-2 w-7 h-7 bg-red-600 text-white rounded-full text-xs opacity-0 group-hover:opacity-100 transition flex items-center justify-center">
                                            <i class="fas fa-trash text-[10px]"></i>
                                        </button>` : ''}
                                    </div>`;
                                }).join('')
                            }
                        </div>
                        ${compareMode && selectedIds.length === 2 ? `
                        <div class="flex justify-center pt-2">
                            <button id="tr-do-compare-btn" class="px-6 py-3 bg-[#92A9E1] hover:bg-[#7b93cc] text-white font-bold rounded-xl transition shadow-lg flex items-center gap-2">
                                <i class="fas fa-columns"></i> Ver comparación
                            </button>
                        </div>` : ''}
                    </div>`;

                // Compare toggle
                document.getElementById('tr-compare-toggle')?.addEventListener('click', () => {
                    compareMode = !compareMode;
                    selectedIds = [];
                    renderPhotoGrid();
                });

                // Compare button
                document.getElementById('tr-do-compare-btn')?.addEventListener('click', () => {
                    const [a, b] = selectedIds.map(id => photos.find(p => p._id === id));
                    if (a && b) openPhotoCompare(a, b);
                });

                // Photo click handler
                window._trPhotoClick = (id) => {
                    if (!compareMode) return;
                    if (selectedIds.includes(id)) {
                        selectedIds = selectedIds.filter(x => x !== id);
                    } else if (selectedIds.length < 2) {
                        selectedIds.push(id);
                    }
                    renderPhotoGrid();
                };
            };

            renderPhotoGrid();
        } catch (e) { container.innerHTML = '<p class="text-red-500">Error cargando fotos.</p>'; }
    };

    const openPhotoCompare = (photoA, photoB) => {
        document.getElementById('photo-compare-modal')?.remove();
        const fmtDate = (d) => { if (!d) return '—'; const [y,mo,dd] = d.split('-'); return `${dd}/${mo}/${y}`; };
        const modal = document.createElement('div');
        modal.id = 'photo-compare-modal';
        modal.className = 'fixed inset-0 z-[100] flex items-center justify-center bg-black/90 backdrop-blur-sm p-2 md:p-6';
        modal.innerHTML = `
            <div class="bg-[#1C1C1E] border border-[#FFDB89]/20 rounded-2xl shadow-2xl w-full max-w-4xl max-h-[95vh] flex flex-col overflow-hidden">
                <div class="flex items-center justify-between px-5 py-4 border-b border-[#FFDB89]/15 shrink-0">
                    <p class="font-bold text-[#FFDB89] flex items-center gap-2"><i class="fas fa-columns text-sm"></i>Comparación de progreso</p>
                    <button id="close-compare-modal" class="text-[#FFDB89]/50 hover:text-[#FFDB89] transition text-xl"><i class="fas fa-times"></i></button>
                </div>
                <div class="flex flex-1 overflow-hidden">
                    ${[photoA, photoB].map((p, i) => {
                        const [y, mo, d] = (p.date || '').split('-');
                        const dateStr = p.date ? `${d}/${mo}/${y}` : '—';
                        return `
                        <div class="flex-1 flex flex-col overflow-hidden border-r border-[#FFDB89]/10 last:border-0">
                            <div class="px-4 py-3 bg-black/20 shrink-0 text-center">
                                <p class="font-bold text-[#FFDB89] text-sm">${dateStr}</p>
                                ${p.category ? `<p class="text-xs text-[#FFDB89]/50">${p.category}</p>` : ''}
                                ${p.notes ? `<p class="text-xs text-[#FFDB89]/40 truncate">${p.notes}</p>` : ''}
                            </div>
                            <div class="flex-1 overflow-hidden bg-black/30">
                                <img src="${p.imageData}" alt="Foto ${i+1}" class="w-full h-full object-contain">
                            </div>
                        </div>`;
                    }).join('')}
                </div>
            </div>`;
        document.body.appendChild(modal);
        modal.querySelector('#close-compare-modal')?.addEventListener('click', () => modal.remove());
        modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    };
    window.openPhotoCompare = openPhotoCompare;

    window.showAddPhotoModal = (clientId) => {
        const existing = document.getElementById('add-photo-modal');
        if (existing) existing.remove();
        const today = new Date().toISOString().split('T')[0];
        document.body.insertAdjacentHTML('beforeend', `
            <div id="add-photo-modal" class="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 backdrop-blur-sm">
                <div class="bg-[#030303]/95 backdrop-blur-2xl border border-[#FFDB89]/20 rounded-2xl shadow-2xl w-full max-w-md p-6">
                    <h3 class="text-lg font-bold text-[#FFDB89] mb-4">Subir foto de progreso</h3>
                    <div class="space-y-4">
                        <div>
                            <label class="block text-xs font-bold text-[#FFDB89]/70 uppercase mb-1">Fecha</label>
                            <input type="date" id="photo-date" value="${today}" class="w-full p-2.5 bg-white/10 border border-[#FFDB89]/30 rounded-lg text-[#FFDB89] text-sm outline-none focus:ring-2 focus:ring-[#FFDB89]">
                        </div>
                        <div>
                            <label class="block text-xs font-bold text-[#FFDB89]/70 uppercase mb-1">Foto</label>
                            <label for="photo-file" class="flex items-center gap-3 w-full p-2.5 bg-white/10 border border-[#FFDB89]/30 rounded-lg cursor-pointer hover:border-[#FFDB89] transition">
                                <span class="shrink-0 bg-[#FFDB89]/20 hover:bg-[#FFDB89]/30 text-[#FFDB89] text-xs font-bold px-3 py-1.5 rounded-md transition">Seleccionar</span>
                                <span id="photo-file-name" class="text-[#FFDB89]/50 text-sm truncate">Ningún archivo seleccionado</span>
                            </label>
                            <input type="file" id="photo-file" accept="image/jpeg,image/png,image/gif" class="hidden">
                        </div>
                        <div id="photo-preview-container" class="hidden">
                            <img id="photo-preview" class="w-full max-h-48 object-contain rounded-lg border border-[#FFDB89]/20">
                        </div>
                        <div>
                            <label class="block text-xs font-bold text-[#FFDB89]/70 uppercase mb-1">Categoría</label>
                            <select id="photo-category" class="w-full p-2.5 bg-white/10 border border-[#FFDB89]/30 rounded-lg text-[#FFDB89] text-sm outline-none focus:ring-2 focus:ring-[#FFDB89]">
                                <option value="general" class="text-black">General</option>
                                <option value="front" class="text-black">Frente</option>
                                <option value="back" class="text-black">Espalda</option>
                                <option value="side" class="text-black">Lateral</option>
                            </select>
                        </div>
                        <div>
                            <label class="block text-xs font-bold text-[#FFDB89]/70 uppercase mb-1">Notas (opcional)</label>
                            <input type="text" id="photo-notes" class="w-full p-2.5 bg-white/10 border border-[#FFDB89]/30 rounded-lg text-[#FFDB89] text-sm outline-none focus:ring-2 focus:ring-[#FFDB89] placeholder-[#FFDB89]/30" placeholder="Notas...">
                        </div>
                    </div>
                    <div class="flex justify-end gap-3 mt-6">
                        <button onclick="document.getElementById('add-photo-modal').remove()" class="px-4 py-2 text-[#FFDB89]/70 hover:text-[#FFDB89] font-medium transition">Cancelar</button>
                        <button onclick="window.saveProgressPhoto('${clientId}')" class="px-4 py-2 bg-[#3a3a3c] hover:bg-[#3a3a3c]/80 text-[#FFDB89] rounded-lg font-bold transition">Subir</button>
                    </div>
                </div>
            </div>
        `);
        // Preview handler
        setTimeout(() => {
            const fileInput = document.getElementById('photo-file');
            if (fileInput) {
                fileInput.onchange = (e) => {
                    const file = e.target.files[0];
                    if (!file) return;
                    if (file.size > 2 * 1024 * 1024) { showToast('La imagen debe ser menor a 2MB.', 'error'); return; }
                    const nameEl = document.getElementById('photo-file-name');
                    if (nameEl) nameEl.textContent = file.name;
                    const reader = new FileReader();
                    reader.onload = (ev) => {
                        document.getElementById('photo-preview').src = ev.target.result;
                        document.getElementById('photo-preview-container').classList.remove('hidden');
                    };
                    reader.readAsDataURL(file);
                };
            }
        }, 50);
    };

    window.saveProgressPhoto = async (clientId) => {
        const date = document.getElementById('photo-date')?.value;
        const fileInput = document.getElementById('photo-file');
        const category = document.getElementById('photo-category')?.value || 'general';
        const notes = document.getElementById('photo-notes')?.value || '';
        if (!date || !fileInput?.files[0]) { showToast('Fecha y foto son requeridas.', 'error'); return; }
        const file = fileInput.files[0];
        if (file.size > 2 * 1024 * 1024) { showToast('La imagen debe ser menor a 2MB.', 'error'); return; }
        const reader = new FileReader();
        reader.onload = async (ev) => {
            try {
                const res = await apiFetch('/api/progress-photos', {
                    method: 'POST',
                    body: JSON.stringify({ clientId, date, imageData: ev.target.result, notes, category })
                });
                if (res.ok) {
                    document.getElementById('add-photo-modal')?.remove();
                    loadClientPhotos(clientId);
                } else { showToast('Error subiendo foto.', 'error'); }
            } catch (e) { showToast('Error de conexión.', 'error'); }
        };
        reader.readAsDataURL(file);
    };

    window.deleteProgressPhoto = async (photoId, clientId) => {
        const yes = await showConfirm('¿Eliminar esta foto?', { confirmLabel: 'Eliminar', danger: true });
        if (!yes) return;
        try {
            const res = await apiFetch(`/api/progress-photos/${photoId}`, { method: 'DELETE' });
            if (res.ok) loadClientPhotos(clientId);
        } catch (e) { showToast('Error eliminando foto.', 'error'); }
    };

    const loadClientRestrictions = (clientId) => {
        const container = document.getElementById('tab-restrictions');
        if (!container) return;

        const client = clientsCache.find(c => (c._id == clientId) || (c.id == clientId));
        let muscleState = (client && client.injuredMuscles) ? { ...client.injuredMuscles } : {};
        let muscleView  = 'front';
        const allMuscles = [...MUSCLE_DEFS.front, ...MUSCLE_DEFS.back];

        const colorFor = (state) => state === 'red' ? '#ef4444' : state === 'yellow' ? '#facc15' : '#4ade80';
        const fillFor  = (state) => state === 'red' ? 'rgba(239,68,68,0.35)' : state === 'yellow' ? 'rgba(250,204,21,0.35)' : 'rgba(74,222,128,0.25)';

        const renderMap = () => {
            const svgEl = document.getElementById('tr-muscle-svg-container');
            if (!svgEl) return;
            const defs = MUSCLE_DEFS[muscleView];
            const shapesHtml = defs.map(muscle => {
                const state = muscleState[muscle.id] || null;
                const stroke = colorFor(state);
                const fill   = fillFor(state);
                return muscle.shapes.map(s =>
                    `<ellipse data-muscle="${muscle.id}" cx="${s.cx}" cy="${s.cy}" rx="${s.rx}" ry="${s.ry}"
                        fill="${fill}" stroke="${stroke}" stroke-width="1.5"
                        style="cursor:pointer;transition:fill .15s,stroke .15s;"
                        opacity="0.9"/>`
                ).join('');
            }).join('');

            svgEl.innerHTML = `
                <svg viewBox="0 0 180 540" width="160" height="480" xmlns="http://www.w3.org/2000/svg" style="display:block">
                    <path d="${BODY_PATH}" fill="rgba(255,219,137,0.07)" stroke="rgba(255,219,137,0.25)" stroke-width="1.5"/>
                    ${shapesHtml}
                </svg>`;

            svgEl.querySelector('svg').addEventListener('click', (e) => {
                const el = e.target.closest('[data-muscle]');
                if (!el) return;
                const id = el.dataset.muscle;
                const cur = muscleState[id] || null;
                if      (cur === null)     muscleState[id] = 'yellow';
                else if (cur === 'yellow') muscleState[id] = 'red';
                else                       delete muscleState[id];
                renderMap();
                renderFlags();
            });
        };

        const renderFlags = () => {
            const list = document.getElementById('tr-injury-flags-list');
            if (!list) return;
            const flagged = Object.entries(muscleState);
            if (flagged.length === 0) {
                list.innerHTML = '<p class="text-xs text-[#FFDB89]/30 italic">Sin restricciones marcadas.</p>';
                return;
            }
            list.innerHTML = flagged.map(([id, state]) => {
                const def = allMuscles.find(m => m.id === id);
                const name = def ? def.name : id;
                const dotClass = state === 'red'
                    ? 'bg-red-400/80 border-red-400/60'
                    : 'bg-yellow-400/80 border-yellow-400/60';
                const label = state === 'red' ? 'Evitar' : 'Precaución';
                return `<div class="flex items-center justify-between p-2.5 rounded-lg bg-[#FFDB89]/5 border border-[#FFDB89]/10">
                    <div class="flex items-center gap-2.5">
                        <div class="w-3 h-3 rounded-full border ${dotClass} shrink-0"></div>
                        <span class="text-sm font-medium text-[#FFDB89]/80">${name}</span>
                    </div>
                    <span class="text-xs font-bold text-[#FFDB89]/40">${label}</span>
                </div>`;
            }).join('');
        };

        const setView = (view) => {
            muscleView = view;
            const frontBtn = document.getElementById('tr-muscle-view-front');
            const backBtn  = document.getElementById('tr-muscle-view-back');
            if (!frontBtn || !backBtn) return;
            if (view === 'front') {
                frontBtn.className = 'px-4 py-1.5 rounded-lg text-xs font-bold bg-[#FFDB89] text-[#030303] transition';
                backBtn.className  = 'px-4 py-1.5 rounded-lg text-xs font-bold bg-[#FFDB89]/10 text-[#FFDB89] border border-[#FFDB89]/20 transition';
            } else {
                backBtn.className  = 'px-4 py-1.5 rounded-lg text-xs font-bold bg-[#FFDB89] text-[#030303] transition';
                frontBtn.className = 'px-4 py-1.5 rounded-lg text-xs font-bold bg-[#FFDB89]/10 text-[#FFDB89] border border-[#FFDB89]/20 transition';
            }
            renderMap();
        };

        container.innerHTML = `
            <div class="max-w-2xl mx-auto space-y-6">
                <div>
                    <h3 class="text-xl font-bold text-[#FFDB89]">Grupos musculares</h3>
                    <p class="text-sm text-[#FFDB89]/60 mt-1">Marca los grupos que requieren atención especial al armar la rutina de ${client ? client.name : 'este cliente'}.</p>
                </div>

                <!-- Legend -->
                <div class="flex flex-wrap items-center gap-4 text-xs">
                    <div class="flex items-center gap-1.5"><div class="w-3 h-3 rounded-full bg-green-400/60 border border-green-400/40"></div><span class="text-[#FFDB89]/60">Sin restricción</span></div>
                    <div class="flex items-center gap-1.5"><div class="w-3 h-3 rounded-full bg-yellow-400/80 border border-yellow-400/60"></div><span class="text-[#FFDB89]/60">Precaución</span></div>
                    <div class="flex items-center gap-1.5"><div class="w-3 h-3 rounded-full bg-red-400/80 border border-red-400/60"></div><span class="text-[#FFDB89]/60">Evitar</span></div>
                    <span class="text-[#FFDB89]/25 italic">· Clic para cambiar estado</span>
                </div>

                <!-- Toggle -->
                <div class="flex items-center gap-2">
                    <button id="tr-muscle-view-front" class="px-4 py-1.5 rounded-lg text-xs font-bold bg-[#FFDB89] text-[#030303] transition">Frente</button>
                    <button id="tr-muscle-view-back"  class="px-4 py-1.5 rounded-lg text-xs font-bold bg-[#FFDB89]/10 text-[#FFDB89] border border-[#FFDB89]/20 transition">Espalda</button>
                    <button id="tr-muscle-clear-all"  class="ml-auto px-3 py-1.5 rounded-lg text-xs font-bold text-[#FFDB89]/40 hover:text-[#FFDB89] border border-[#FFDB89]/10 hover:border-[#FFDB89]/30 transition">Limpiar todo</button>
                </div>

                <div class="flex flex-col md:flex-row gap-6 items-start">
                    <div id="tr-muscle-svg-container" class="flex-shrink-0 flex justify-center w-full md:w-auto"></div>
                    <div class="flex-grow min-w-0">
                        <p class="text-xs font-bold text-[#FFDB89]/50 uppercase tracking-wider mb-3">Estado actual</p>
                        <div id="tr-injury-flags-list" class="space-y-2">
                            <p class="text-xs text-[#FFDB89]/30 italic">Sin restricciones marcadas.</p>
                        </div>
                    </div>
                </div>

                <div class="flex justify-end">
                    <button id="tr-save-muscle-btn" class="px-5 py-2.5 bg-[#2C2C2E] border border-[#FFDB89]/30 hover:bg-[#FFDB89]/20 text-[#FFDB89] font-medium rounded-lg text-sm transition shadow-md">
                        Guardar restricciones
                    </button>
                </div>
            </div>`;

        renderMap();
        renderFlags();

        document.getElementById('tr-muscle-view-front').addEventListener('click', () => setView('front'));
        document.getElementById('tr-muscle-view-back').addEventListener('click',  () => setView('back'));
        document.getElementById('tr-muscle-clear-all').addEventListener('click',  () => {
            muscleState = {};
            renderMap();
            renderFlags();
        });
        document.getElementById('tr-save-muscle-btn').addEventListener('click', async () => {
            try {
                const res = await apiFetch(`/api/clients/${clientId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ injuredMuscles: muscleState })
                });
                if (res.ok) {
                    // Update local cache
                    const idx = clientsCache.findIndex(c => (c._id == clientId) || (c.id == clientId));
                    if (idx !== -1) clientsCache[idx].injuredMuscles = { ...muscleState };
                    showToast('Restricciones guardadas.', 'success');
                } else {
                    showToast('Error al guardar.', 'error');
                }
            } catch (e) { showToast('Error de conexión.', 'error'); }
        });
    };

    window.openEditClientModal = (clientId) => {
        const client = clientsCache.find(c => c._id === clientId);
        if (!client) return;

        currentClientViewId = clientId; 
        const modal = document.getElementById('add-client-modal');
        const title = modal.querySelector('h2');
        const btn = document.getElementById('save-new-client-btn');

        title.textContent = "Editar cliente";
        btn.textContent = "Actualizar Cliente";
        modal.classList.remove('hidden');
        populateTimezones();
        renderGroupOptions();
        renderProgramOptions(client.program || "Sin asignar");

        document.getElementById('new-client-name').value = client.name || "";
        document.getElementById('new-client-lastname').value = client.lastName || "";
        document.getElementById('new-client-email').value = client.email || "";
        setTimeout(() => document.getElementById('new-client-group').value = client.group || "General", 100);
        
        document.querySelectorAll('.client-type-btn').forEach(b => {
            b.classList.remove('ring-2', 'ring-[#FFDB89]', 'bg-[#FFDB89]/10');
            b.classList.add('border-[#FFDB89]/15', 'bg-white/5');
            if (b.dataset.type === client.type) {
                b.classList.add('ring-2', 'ring-[#FFDB89]', 'bg-[#FFDB89]/10');
                b.classList.remove('border-[#FFDB89]/15', 'bg-white/5');
            }
        });

        document.getElementById('opt-location').value = client.location || "";
        document.getElementById('opt-timezone').value = client.timezone || "";
        document.getElementById('opt-birthday').value = client.birthday || "";
        document.getElementById('opt-phone').value = client.phone || "";
        if (document.getElementById('opt-due-date')) document.getElementById('opt-due-date').value = client.dueDate || "";
        if (document.getElementById('opt-resting-hr')) document.getElementById('opt-resting-hr').value = client.restingHr || "";
        if (document.getElementById('opt-thr'))        document.getElementById('opt-thr').value        = client.thr       || "";
        if (document.getElementById('opt-mahr'))       document.getElementById('opt-mahr').value       = client.mahr      || "";

        document.querySelectorAll('button[data-group="gender"]').forEach(b => {
            b.classList.remove('active', 'text-white', 'text-gray-400');
            if(b.dataset.val === client.gender) b.classList.add('active', 'text-white');
            else b.classList.add('text-gray-400');
        });

        const unitSys = client.unitSystem || 'imperial';
        document.querySelectorAll('button[data-group="units"]').forEach(b => {
            b.classList.remove('active', 'text-white', 'text-gray-400');
            if(b.dataset.val === unitSys) b.classList.add('active', 'text-white');
            else b.classList.add('text-gray-400');
        });

        const heightImp = document.getElementById('height-imperial');
        const heightMet = document.getElementById('height-metric');
        const weightLabel = document.getElementById('weight-unit-label');

        if (unitSys === 'metric') {
            heightImp.classList.add('hidden');
            heightMet.classList.remove('hidden');
            weightLabel.textContent = 'kg';
            
            const feet = client.height?.feet || 0;
            const inches = client.height?.inches || 0;
            const totalInches = (feet * 12) + inches;
            const cm = Math.round(totalInches * 2.54);
            const kg = Math.round((client.weight || 0) / 2.20462);

            document.getElementById('opt-height-cm').value = cm || "";
            document.getElementById('opt-weight').value = kg || "";
        } else {
            heightImp.classList.remove('hidden');
            heightMet.classList.add('hidden');
            weightLabel.textContent = 'lbs';
            document.getElementById('opt-height-ft').value = client.height?.feet || "";
            document.getElementById('opt-height-in').value = client.height?.inches || "";
            document.getElementById('opt-weight').value = client.weight || "";
        }

        const setToggle = (idx, state) => {
            const toggle = document.querySelectorAll('.toggle-switch')[idx];
            if(!toggle) return;
            toggle.dataset.on = state ? "true" : "false";
            const thumb = toggle.querySelector('div');
            if (state) {
                toggle.classList.remove('bg-white/10'); toggle.classList.add('bg-[#FFDB89]/20');
                thumb.classList.add('translate-x-5'); thumb.classList.remove('translate-x-0');
            } else {
                toggle.classList.add('bg-white/10'); toggle.classList.remove('bg-[#FFDB89]/20');
                thumb.classList.remove('translate-x-5'); thumb.classList.add('translate-x-0');
            }
        };

        setToggle(0, client.emailPreferences?.dailyRoutine);
        setToggle(1, client.emailPreferences?.incompleteRoutine);
        setToggle(2, client.hideFromDashboard);

        wireHeartRateCalc();
    };

    window.deleteClient = async (id) => {
        const yes = await showConfirm("¿Estás seguro de que deseas eliminar este cliente? Se moverá a la papelera.", { confirmLabel: 'Eliminar', danger: true });
        if (!yes) return;
        try {
            const res = await apiFetch(`/api/clients/${id}`, { method: 'DELETE' });
            if (res.ok) {
                clientsCache = clientsCache.filter(c => c._id !== id);
                renderClientsTable();
            } else {
                const contentType = res.headers.get("content-type");
                if (contentType && contentType.indexOf("application/json") !== -1) {
                    const err = await res.json();
                    showToast("Error: " + err.message, 'error');
                } else { showToast("Error de servidor.", 'error'); }
            }
        } catch (e) { console.error(e); showToast('Error de conexión.', 'error'); }
    };

    // ── Invite result modal: shows link + email status after client creation ──
    const showInviteResultModal = (savedClient, email, sendInvite) => {
        document.getElementById('invite-result-modal')?.remove();
        const inviteLink = savedClient._inviteLink || null;
        const emailFailed = savedClient._emailFailed;

        const modal = document.createElement('div');
        modal.id = 'invite-result-modal';
        modal.className = 'fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4';
        modal.innerHTML = `
            <div class="bg-[#1C1C1E] border border-[#FFDB89]/20 rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
                <div class="flex items-center gap-3">
                    <div class="w-10 h-10 rounded-full flex items-center justify-center ${emailFailed ? 'bg-yellow-500/20' : 'bg-green-500/20'}">
                        <i class="fas ${emailFailed ? 'fa-exclamation-triangle text-yellow-400' : 'fa-check text-green-400'}"></i>
                    </div>
                    <div>
                        <p class="font-bold text-[#FFDB89] text-lg">Cliente creado</p>
                        <p class="text-xs text-[#FFDB89]/50">
                            ${!sendInvite ? 'Invitación no enviada (toggle desactivado).' :
                              emailFailed ? `No se pudo enviar el correo a <strong>${email}</strong>. Copia el enlace de abajo.` :
                              `Enlace de invitación enviado a <strong>${email}</strong>.`}
                        </p>
                    </div>
                </div>
                ${inviteLink ? `
                <div class="bg-black/30 border border-[#FFDB89]/15 rounded-xl p-3 space-y-2">
                    <p class="text-xs font-bold text-[#FFDB89]/60 uppercase tracking-wider">Enlace de activación (7 días)</p>
                    <div class="flex items-center gap-2">
                        <input id="invite-link-input" type="text" value="${inviteLink}" readonly
                            class="flex-1 min-w-0 text-xs text-[#FFDB89]/70 bg-transparent border-none outline-none truncate">
                        <button id="copy-invite-link-btn" class="shrink-0 px-3 py-1.5 rounded-lg bg-[#FFDB89]/10 border border-[#FFDB89]/20 text-[#FFDB89] text-xs font-bold hover:bg-[#FFDB89]/20 transition">
                            <i class="fas fa-copy mr-1"></i>Copiar
                        </button>
                    </div>
                </div>
                <p class="text-[10px] text-[#FFDB89]/30 text-center">Comparte este enlace directamente si el correo no llega. Revisar spam.</p>
                ` : ''}
                <button id="close-invite-result-btn" class="w-full py-2.5 rounded-xl bg-[#FFDB89] text-[#030303] font-bold text-sm hover:bg-[#f5cb6e] transition">
                    Listo
                </button>
            </div>`;
        document.body.appendChild(modal);

        modal.querySelector('#copy-invite-link-btn')?.addEventListener('click', () => {
            navigator.clipboard.writeText(inviteLink).then(() => {
                const btn = modal.querySelector('#copy-invite-link-btn');
                btn.innerHTML = '<i class="fas fa-check mr-1"></i>Copiado';
                setTimeout(() => { btn.innerHTML = '<i class="fas fa-copy mr-1"></i>Copiar'; }, 2000);
            });
        });

        modal.querySelector('#close-invite-result-btn')?.addEventListener('click', () => modal.remove());
        modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    };

    // ── Resend invite to existing client ─────────────────────────────────────
    window.resendClientInvite = async (clientId) => {
        const client = clientsCache.find(c => c._id === clientId);
        const btn = document.getElementById(`resend-invite-${clientId}`);
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Enviando...'; }

        try {
            const res = await apiFetch(`/api/clients/${clientId}/resend-invite`, { method: 'POST' });
            const data = await res.json();

            document.getElementById('resend-invite-modal')?.remove();
            const modal = document.createElement('div');
            modal.id = 'resend-invite-modal';
            modal.className = 'fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4';
            modal.innerHTML = `
                <div class="bg-[#1C1C1E] border border-[#FFDB89]/20 rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
                    <div class="flex items-center gap-3">
                        <div class="w-10 h-10 rounded-full flex items-center justify-center ${data.emailSent ? 'bg-green-500/20' : 'bg-yellow-500/20'}">
                            <i class="fas ${data.emailSent ? 'fa-envelope-open-text text-green-400' : 'fa-exclamation-triangle text-yellow-400'}"></i>
                        </div>
                        <div>
                            <p class="font-bold text-[#FFDB89]">Invitación ${data.emailSent ? 'reenviada' : 'generada'}</p>
                            <p class="text-xs text-[#FFDB89]/50">${data.emailSent ? `Correo enviado a <strong>${client?.email || ''}</strong>. Revisar spam.` : 'No se pudo enviar el correo. Comparte el enlace manualmente.'}</p>
                        </div>
                    </div>
                    <div class="bg-black/30 border border-[#FFDB89]/15 rounded-xl p-3 space-y-2">
                        <p class="text-xs font-bold text-[#FFDB89]/60 uppercase tracking-wider">Enlace de activación (7 días)</p>
                        <div class="flex items-center gap-2">
                            <input type="text" value="${data.inviteLink}" readonly
                                class="flex-1 min-w-0 text-xs text-[#FFDB89]/70 bg-transparent border-none outline-none truncate">
                            <button id="copy-resend-link-btn" class="shrink-0 px-3 py-1.5 rounded-lg bg-[#FFDB89]/10 border border-[#FFDB89]/20 text-[#FFDB89] text-xs font-bold hover:bg-[#FFDB89]/20 transition">
                                <i class="fas fa-copy mr-1"></i>Copiar
                            </button>
                        </div>
                    </div>
                    <button id="close-resend-modal-btn" class="w-full py-2.5 rounded-xl bg-[#FFDB89] text-[#030303] font-bold text-sm hover:bg-[#f5cb6e] transition">Listo</button>
                </div>`;
            document.body.appendChild(modal);
            modal.querySelector('#copy-resend-link-btn')?.addEventListener('click', () => {
                navigator.clipboard.writeText(data.inviteLink).then(() => {
                    const b = modal.querySelector('#copy-resend-link-btn');
                    b.innerHTML = '<i class="fas fa-check mr-1"></i>Copiado';
                    setTimeout(() => { b.innerHTML = '<i class="fas fa-copy mr-1"></i>Copiar'; }, 2000);
                });
            });
            modal.querySelector('#close-resend-modal-btn')?.addEventListener('click', () => modal.remove());
            modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
        } catch (e) {
            showToast('Error al reenviar invitación. Intenta de nuevo.', 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane mr-1"></i>Reenviar'; }
        }
    };

    window.handleSaveClient = async () => {
        const firstName = document.getElementById('new-client-name')?.value;
        const lastName = document.getElementById('new-client-lastname')?.value;
        const email = document.getElementById('new-client-email')?.value;
        const typeBtn = document.querySelector('.client-type-btn.ring-2');
        const type = typeBtn ? typeBtn.dataset.type : "Remoto";
        const program = document.getElementById('new-client-program')?.value || "Sin asignar";
        const group = document.getElementById('new-client-group')?.value || "General";
        const location = document.getElementById('opt-location')?.value || "";
        const timezone = document.getElementById('opt-timezone')?.value || "";
        const birthday = document.getElementById('opt-birthday')?.value || "";
        const phone = document.getElementById('opt-phone')?.value || "";
        const unitBtn = document.querySelector('button[data-group="units"].active');
        const unitSystem = unitBtn ? unitBtn.dataset.val : "imperial";
        const genderBtn = document.querySelector('button[data-group="gender"].active');
        const gender = genderBtn ? genderBtn.dataset.val : "";

        let heightFt = 0; let heightIn = 0; let weight = parseFloat(document.getElementById('opt-weight')?.value || 0);

        if (unitSystem === 'metric') {
            const heightCm = parseFloat(document.getElementById('opt-height-cm')?.value || 0);
            const totalInches = heightCm / 2.54;
            heightFt = Math.floor(totalInches / 12);
            heightIn = Math.round(totalInches % 12);
            weight = Math.round(weight * 2.20462);
        } else {
            heightFt = parseFloat(document.getElementById('opt-height-ft')?.value || 0);
            heightIn = parseFloat(document.getElementById('opt-height-in')?.value || 0);
        }

        const getToggleState = (btn) => btn.dataset.on === "true";
        const toggles = document.querySelectorAll('.toggle-switch');
        const sendDaily = toggles[0] ? getToggleState(toggles[0]) : false;
        const sendIncomplete = toggles[1] ? getToggleState(toggles[1]) : false;
        const hideDash = toggles[2] ? getToggleState(toggles[2]) : false;

        if(!firstName || !email) { showToast("Nombre y Email son requeridos", 'error'); return; }

        const thr       = parseFloat(document.getElementById('opt-thr')?.value)        || null;
        const mahr      = parseFloat(document.getElementById('opt-mahr')?.value)       || null;
        const restingHr = parseFloat(document.getElementById('opt-resting-hr')?.value) || null;

        const payload = {
            name: firstName, lastName: lastName || "", email: email, type: type, program: program, group: group,
            location, timezone, unitSystem,
            height: { feet: heightFt, inches: heightIn },
            weight: weight,
            birthday, gender, phone,
            restingHr, thr, mahr,
            hideFromDashboard: hideDash,
            emailPreferences: { dailyRoutine: sendDaily, incompleteRoutine: sendIncomplete },
            dueDate: document.getElementById('opt-due-date')?.value || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
        };

        try {
            let res;
            if (currentClientViewId) {
                res = await apiFetch(`/api/clients/${currentClientViewId}`, { method: 'PUT', body: JSON.stringify(payload) });
            } else {
                // Only set these for NEW clients
                payload.isFirstLogin = true;
                payload.isActive = true;
                // Pass sendInvite flag to the server — it handles the invite email directly
                const sendInvite = document.getElementById('send-invite-toggle')?.dataset.on === 'true';
                payload.sendInvite = sendInvite;
                res = await apiFetch('/api/clients', { method: 'POST', body: JSON.stringify(payload) });
            }

            if (res.ok) {
                const savedClient = await res.json();
                const savedClientId = savedClient._id;

                if (currentClientViewId) {
                    const idx = clientsCache.findIndex(c => c._id === currentClientViewId);
                    if (idx > -1) clientsCache[idx] = savedClient;
                } else {
                    clientsCache.unshift(savedClient);
                }

                document.getElementById('add-client-modal').classList.add('hidden');
                renderClientsTable();
                currentClientViewId = null;
                document.querySelector('#add-client-modal h2').textContent = "Nuevo cliente";
                document.getElementById('save-new-client-btn').textContent = "Guardar cliente";
                document.getElementById('new-client-name').value = "";
                document.getElementById('new-client-lastname').value = "";
                document.getElementById('new-client-email').value = "";
                document.getElementById('opt-location').value = "";
                document.getElementById('opt-height-ft').value = "";
                document.getElementById('opt-height-in').value = "";
                document.getElementById('opt-weight').value = "";

                // If a real program was selected, offer to push its workouts to the client's calendar
                if (program && program !== 'Sin asignar') {
                    const prog = programsCache.find(p => p.name === program);
                    if (prog) {
                        const today = new Date().toISOString().split('T')[0];
                        // Show a small modal asking for start date
                        const pushModal = document.createElement('div');
                        pushModal.id = 'push-program-modal';
                        pushModal.className = 'fixed inset-0 z-[90] flex items-center justify-center bg-black/70 backdrop-blur-sm';
                        pushModal.innerHTML = `
                            <div class="bg-[#030303] border border-[#FFDB89]/20 rounded-2xl shadow-2xl w-full max-w-sm p-6">
                                <div class="flex items-center gap-3 mb-4">
                                    <i class="fas fa-dumbbell text-[#FFDB89]"></i>
                                    <h3 class="text-lg font-bold text-[#FFDB89]">Cargar programa al calendario</h3>
                                </div>
                                <p class="text-sm text-[#FFDB89]/60 mb-4">
                                    ¿Deseas cargar los workouts de <span class="text-[#FFDB89] font-bold">${prog.name}</span> al calendario de <span class="text-[#FFDB89] font-bold">${savedClient.name}</span>?
                                </p>
                                <div class="mb-5">
                                    <label class="block text-xs font-bold text-[#FFDB89]/50 uppercase tracking-wider mb-1">Fecha de inicio</label>
                                    <input type="date" id="push-program-start-date" value="${today}"
                                        class="w-full p-2.5 bg-white/10 border border-[#FFDB89]/20 rounded-lg text-[#FFDB89] text-sm outline-none focus:ring-2 focus:ring-[#FFDB89]">
                                </div>
                                <div class="flex gap-3">
                                    <button id="push-program-skip-btn" class="flex-1 py-2.5 border border-[#FFDB89]/20 text-[#FFDB89]/60 hover:text-[#FFDB89] rounded-lg font-bold transition text-sm">Solo guardar</button>
                                    <button id="push-program-confirm-btn" class="flex-1 py-2.5 bg-[#FFDB89] hover:bg-[#ffe9a8] text-[#030303] rounded-lg font-bold transition text-sm">Cargar workouts</button>
                                </div>
                            </div>
                        `;
                        document.body.appendChild(pushModal);

                        document.getElementById('push-program-skip-btn').onclick = () => {
                            pushModal.remove();
                            if (payload.sendInvite !== undefined) showInviteResultModal(savedClient, email, payload.sendInvite);
                            else showToast('Cliente actualizado exitosamente.', 'success');
                        };

                        document.getElementById('push-program-confirm-btn').onclick = async () => {
                            const startDate = document.getElementById('push-program-start-date').value;
                            pushModal.remove();
                            try {
                                const { created, skipped } = await pushProgramToCalendar(prog, savedClientId, startDate);
                                const skipNote = skipped > 0 ? ` (${skipped} día${skipped > 1 ? 's' : ''} ya tenían rutina)` : '';
                                showToast(`✓ ${prog.name} cargado. ${created} día${created !== 1 ? 's' : ''} agregado${created !== 1 ? 's' : ''} al calendario.${skipNote}`, 'success', 5000);
                            } catch(e) {
                                showToast('Error cargando el programa al calendario.', 'error');
                            }
                        };
                        return; // Don't show the default alert; the modal handles it
                    }
                }

                // Default success feedback (no program, or program not found in local DB)
                if (payload.sendInvite !== undefined) {
                    showInviteResultModal(savedClient, email, payload.sendInvite);
                } else {
                    showToast('Cliente actualizado exitosamente.', 'success');
                }
            } else {
                const err = await res.json();
                showToast(err.message || "Error al guardar", 'error');
            }
        } catch (error) { console.error(error); showToast('Error de conexión con el servidor.', 'error'); }
    };

    // RENDER CLIENTS TABLE (with search + status filter support)
    window.renderClientsTable = () => {
        const tbody = document.getElementById('clients-table-body');
        if(!tbody) return;
        tbody.innerHTML = '';

        // Read filter values
        const searchInput = document.getElementById('client-search-input');
        const statusFilter = document.getElementById('client-status-filter');
        const searchTerm = (searchInput?.value || '').toLowerCase().trim();
        const statusValue = statusFilter?.value || 'all';

        // Apply filters
        let filtered = clientsCache;
        if (searchTerm) {
            filtered = filtered.filter(c => {
                const fullName = `${c.name} ${c.lastName || ''}`.toLowerCase();
                return fullName.includes(searchTerm);
            });
        }
        if (statusValue === 'active') filtered = filtered.filter(c => c.isActive);
        if (statusValue === 'inactive') filtered = filtered.filter(c => !c.isActive);

        if(filtered.length === 0) { tbody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-[#FFDB89]">No hay clientes.</td></tr>`; return; }

        filtered.forEach(client => {
            const tr = document.createElement('tr');
            tr.className = "hover:bg-[#FFDB89]/5 transition cursor-pointer client-row";
            tr.setAttribute('data-id', client._id);
            // CLICK LISTENER FOR ROW
            tr.onclick = (e) => {
                // Status toggle button — uses data-attrs to avoid CSP script-src-attr blocking
                const statusBtn = e.target.closest('[data-toggle-status]');
                if (statusBtn) {
                    window.toggleClientStatus(statusBtn.dataset.clientId, statusBtn.dataset.active === 'true');
                    return;
                }
                if(!e.target.closest('button')) {
                    window.openClientProfile(client._id);
                }
            };
            const initials = (client.name.charAt(0) + (client.lastName ? client.lastName.charAt(0) : '')).toUpperCase();
            tr.innerHTML = `
                <td class="px-6 py-4 whitespace-nowrap"><div class="flex items-center"><div class="h-10 w-10 rounded-full bg-[#FFDB89]/30 text-[#FFDB89] flex items-center justify-center font-bold mr-3">${initials}</div><div class="text-sm font-medium text-[#FFDB89]">${client.name} ${client.lastName || ''}</div></div></td>
                <td class="px-6 py-4 whitespace-nowrap"><span class="bg-[#FFDB89]/10 text-[#FFDB89] px-2 py-1 rounded text-xs font-bold">${client.group || 'General'}</span></td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-[#FFDB89]/80">${(!client.program || client.program === 'Sin asignar' || client.program === 'Sin Asignar') ? 'Sin asignar' : client.program}</td>
                <td class="px-6 py-4 whitespace-nowrap">
                    <button data-toggle-status data-client-id="${client._id}" data-active="${client.isActive}" class="px-2 inline-flex text-xs leading-5 font-semibold rounded-full cursor-pointer transition ${client.isActive ? 'bg-green-900/40 text-green-300 hover:bg-green-900/60' : 'bg-red-900/40 text-red-300 hover:bg-red-900/60'}">
                        ${client.isActive ? 'Activo' : 'Inactivo'}
                    </button>
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    ${!client.isFirstLogin ? '' : `<button id="resend-invite-${client._id}" onclick="window.resendClientInvite('${client._id}'); event.stopPropagation();" class="text-[#92A9E1]/60 hover:text-[#92A9E1] mr-3 transition text-xs" title="Reenviar invitación"><i class="fas fa-paper-plane mr-1"></i>Inv.</button>`}
                    <button onclick="window.openEditClientModal('${client._id}'); event.stopPropagation();" class="text-[#FFDB89]/70 hover:text-[#FFDB89] mr-2 transition"><i class="fas fa-edit"></i></button>
                    <button onclick="window.deleteClient('${client._id}'); event.stopPropagation();" class="text-red-400 hover:text-red-300 transition"><i class="fas fa-trash"></i></button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    };

    // Toggle client active/inactive status
    window.toggleClientStatus = async (clientId, currentActive) => {
        try {
            const res = await apiFetch(`/api/clients/${clientId}`, {
                method: 'PUT',
                body: JSON.stringify({ isActive: !currentActive })
            });
            if (res.ok) {
                const updated = await res.json();
                const idx = clientsCache.findIndex(c => c._id === clientId);
                if (idx > -1) clientsCache[idx] = updated;
                // Switch to "Todos" so the trainer sees the updated badge,
                // not a blank list after a client is deactivated.
                const filterEl = document.getElementById('client-status-filter');
                if (filterEl) filterEl.value = 'all';
                renderClientsTable();
                showToast(`${updated.name} marcado como ${updated.isActive ? 'Activo' : 'Inactivo'}.`, 'success');
            }
        } catch (e) { console.error('Error toggling status:', e); showToast('Error actualizando estado.', 'error'); }
    };

    // ── Heart-rate auto-calculator ────────────────────────────────────────
    // Fires whenever birthday or resting HR changes.
    // Max HR  = 220 − age            (Haskell & Fox)
    // THR     = (MaxHR − RestHR) × 0.70 + RestHR   (Karvonen at 70%)
    // Both fields remain editable so the trainer can override.
    const calcHeartRates = () => {
        const birthday   = document.getElementById('opt-birthday')?.value;
        const restingHr  = parseFloat(document.getElementById('opt-resting-hr')?.value);
        if (!birthday || isNaN(restingHr) || restingHr < 30) return;

        const today = new Date();
        const dob   = new Date(birthday);
        let age = today.getFullYear() - dob.getFullYear();
        const m = today.getMonth() - dob.getMonth();
        if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
        if (age < 1 || age > 110) return;

        const maxHr = Math.round(220 - age);
        const thr   = Math.round((maxHr - restingHr) * 0.70 + restingHr);

        const thrEl  = document.getElementById('opt-thr');
        const mahrEl = document.getElementById('opt-mahr');
        if (mahrEl && !mahrEl.dataset.manualOverride) mahrEl.value = maxHr;
        if (thrEl  && !thrEl.dataset.manualOverride)  thrEl.value  = thr;
    };

    const wireHeartRateCalc = () => {
        const birthdayEl  = document.getElementById('opt-birthday');
        const restingHrEl = document.getElementById('opt-resting-hr');
        const thrEl       = document.getElementById('opt-thr');
        const mahrEl      = document.getElementById('opt-mahr');
        if (!restingHrEl) return;

        // Clear override flags when restingHr or birthday changes so calc can re-run
        [birthdayEl, restingHrEl].forEach(el => el?.addEventListener('input', () => {
            if (thrEl)  delete thrEl.dataset.manualOverride;
            if (mahrEl) delete mahrEl.dataset.manualOverride;
            calcHeartRates();
        }));

        // If trainer manually edits THR or MaxHR, mark as overridden so calc doesn't stomp it
        thrEl?.addEventListener('input',  () => { thrEl.dataset.manualOverride  = '1'; });
        mahrEl?.addEventListener('input', () => { mahrEl.dataset.manualOverride = '1'; });
    };

    // Attach search/filter listeners for clients table
    const attachClientFilterListeners = () => {
        const searchInput = document.getElementById('client-search-input');
        const statusFilter = document.getElementById('client-status-filter');
        if (searchInput) searchInput.addEventListener('input', () => renderClientsTable());
        if (statusFilter) statusFilter.addEventListener('change', () => renderClientsTable());
    };

    // =============================================================================
    // 6. EXERCISE LIBRARY LOGIC
    // =============================================================================

    // ── Video name autocomplete ───────────────────────────────────────────────
    let _videoNameHandler = null;
    let _videoDropdownHandler = null;

    const initVideoNameAutocomplete = () => {
        const input    = document.getElementById('video-library-name');
        const dropdown = document.getElementById('video-lib-name-suggestions');
        if (!input || !dropdown) return;

        // Detach old listeners to avoid stacking
        if (_videoNameHandler)     input.removeEventListener('input', _videoNameHandler);
        if (_videoDropdownHandler) dropdown.removeEventListener('click', _videoDropdownHandler);

        _videoNameHandler = () => {
            const val = input.value.trim().toLowerCase();
            if (!val) { dropdown.classList.add('hidden'); return; }
            const matches = globalExerciseLibrary
                .filter(e => e.name.toLowerCase().includes(val))
                .slice(0, 7);
            if (!matches.length) { dropdown.classList.add('hidden'); return; }
            dropdown.innerHTML = matches.map(e => {
                const icon = e.videoUrl
                    ? '<i class="fas fa-video text-[10px] text-[#FFDB89]/40 shrink-0"></i>'
                    : '<i class="fas fa-dumbbell text-[10px] text-[#FFDB89]/20 shrink-0"></i>';
                const safeName = e.name.replace(/</g, '&lt;').replace(/"/g, '&quot;');
                return `<div class="flex items-center gap-2 px-3 py-2.5 text-sm text-[#FFDB89]/70 hover:text-[#FFDB89] hover:bg-[#FFDB89]/8 cursor-pointer border-b border-[#FFDB89]/6 last:border-none transition video-lib-suggest" data-name="${safeName}">${icon}<span>${safeName}</span></div>`;
            }).join('');
            dropdown.classList.remove('hidden');
        };

        _videoDropdownHandler = (e) => {
            const item = e.target.closest('.video-lib-suggest');
            if (!item) return;
            input.value = item.dataset.name;
            dropdown.classList.add('hidden');
        };

        input.addEventListener('input', _videoNameHandler);
        dropdown.addEventListener('click', _videoDropdownHandler);

        // Close on outside click
        setTimeout(() => {
            document.addEventListener('click', function _closeVideoDrop(e) {
                const modal = document.getElementById('video-upload-modal');
                if (!modal || modal.classList.contains('hidden')) {
                    document.removeEventListener('click', _closeVideoDrop);
                    return;
                }
                if (!input.contains(e.target) && !dropdown.contains(e.target)) {
                    dropdown.classList.add('hidden');
                }
            });
        }, 0);
    };

    // ── Dedup check before saving to library ──────────────────────────────────
    // Returns true if it's safe to proceed, false if user cancelled
    const checkVideoDuplicate = async (url, name) => {
        const normName = name.toLowerCase();
        // Same URL already saved under a DIFFERENT name → warn
        const urlMatch = globalExerciseLibrary.find(e => e.videoUrl && e.videoUrl === url && e.name.toLowerCase() !== normName);
        if (urlMatch) {
            return await showConfirm(`Este video ya está guardado en la librería como "${urlMatch.name}".\n¿Guardarlo también como "${name}"?`, { confirmLabel: 'Guardar también', danger: false });
        }
        // Same name + same URL → exact duplicate, skip silently
        const exactMatch = globalExerciseLibrary.find(e => e.name.toLowerCase() === normName && e.videoUrl === url);
        if (exactMatch) {
            // Show toast instead of alert
            const toast = document.createElement('div');
            toast.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 z-[200] bg-[#1C1C1E] border border-[#FFDB89]/30 text-[#FFDB89] text-sm font-bold px-5 py-2.5 rounded-full shadow-xl pointer-events-none';
            toast.innerHTML = `<i class="fas fa-check-circle mr-2 text-green-400"></i>"${name}" ya está en la librería`;
            document.body.appendChild(toast);
            setTimeout(() => toast.remove(), 2000);
            return false; // skip the API call, URL already applied
        }
        return true; // good to go (new entry OR updating URL for existing name)
    };

    // ── Video Library ─────────────────────────────────────────────────────────
    // Extract a YouTube/Vimeo thumbnail URL from a video URL (best effort)
    const getVideoThumbnail = (url) => {
        if (!url) return null;
        // YouTube: youtube.com/watch?v=ID or youtu.be/ID
        const ytMatch = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
        if (ytMatch) return `https://img.youtube.com/vi/${ytMatch[1]}/mqdefault.jpg`;
        // Vimeo: vimeo.com/ID
        // (Vimeo thumbnails require an API call, so we skip for now)
        return null;
    };

    window.renderVideoLibrary = () => {
        const grid = document.getElementById('video-library-grid');
        if (!grid) return;
        const withVideos = globalExerciseLibrary.filter(ex => ex.videoUrl);
        if (withVideos.length === 0) {
            grid.innerHTML = `
                <div class="col-span-full flex flex-col items-center justify-center py-20 text-[#FFDB89]/30">
                    <i class="fas fa-film text-5xl mb-4"></i>
                    <p class="font-bold text-lg">Aún no hay videos en la librería</p>
                    <p class="text-sm mt-1 text-[#FFDB89]/20">Agrega videos desde los ejercicios, las rutinas o el editor del cliente</p>
                </div>`;
            return;
        }
        grid.innerHTML = withVideos.map(ex => {
            const thumb = getVideoThumbnail(ex.videoUrl);
            const safeUrl = ex.videoUrl.replace(/"/g, '&quot;');
            const safeName = ex.name.replace(/</g, '&lt;');
            return `
                <div class="bg-[#1C1C1E] border border-[#FFDB89]/15 rounded-xl overflow-hidden group hover:border-[#FFDB89]/40 transition-all duration-200">
                    <div class="relative h-36 bg-[#0D0D0D] flex items-center justify-center overflow-hidden">
                        ${thumb
                            ? `<img src="${thumb}" class="w-full h-full object-cover opacity-75 group-hover:opacity-90 transition" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
                            : ''}
                        <div class="${thumb ? 'hidden' : 'flex'} w-full h-full items-center justify-center">
                            <i class="fas fa-video text-3xl text-[#FFDB89]/15"></i>
                        </div>
                        <a href="${safeUrl}" target="_blank" rel="noopener" class="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 transition">
                            <div class="w-12 h-12 rounded-full bg-[#FFDB89]/20 border-2 border-[#FFDB89]/50 flex items-center justify-center shadow-lg">
                                <i class="fas fa-play text-[#FFDB89] ml-1"></i>
                            </div>
                        </a>
                    </div>
                    <div class="p-3 flex items-start justify-between gap-2">
                        <div class="min-w-0">
                            <h4 class="font-bold text-[#FFDB89] text-sm truncate">${safeName}</h4>
                            <p class="text-[10px] text-[#FFDB89]/30 truncate mt-0.5">${safeUrl}</p>
                        </div>
                        <a href="${safeUrl}" target="_blank" rel="noopener" class="shrink-0 p-1.5 text-[#FFDB89]/30 hover:text-[#FFDB89] transition" title="Abrir video">
                            <i class="fas fa-external-link-alt text-xs"></i>
                        </a>
                    </div>
                </div>`;
        }).join('');
    };

    // ── Tab switching helper ───────────────────────────────────────────────────
    const switchLibraryTab = (activeTabId) => {
        const tabs   = ['tab-programas', 'tab-ejercicios', 'tab-videos'];
        const panels = ['programs-main-view', 'ejercicios-panel', 'videos-panel'];
        const tabPanelMap = {
            'tab-programas':   'programs-main-view',
            'tab-ejercicios':  'ejercicios-panel',
            'tab-videos':      'videos-panel',
        };
        tabs.forEach(id => {
            const btn = document.getElementById(id);
            if (!btn) return;
            if (id === activeTabId) {
                btn.classList.add('lib-tab-active');
                btn.classList.remove('lib-tab-inactive');
            } else {
                btn.classList.remove('lib-tab-active');
                btn.classList.add('lib-tab-inactive');
            }
        });
        panels.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.add('hidden');
        });
        const activePanel = tabPanelMap[activeTabId];
        if (activePanel) {
            const el = document.getElementById(activePanel);
            if (el) el.classList.remove('hidden');
        }
        // Update action button
        const btnText = document.getElementById('add-btn-text');
        const btn     = document.getElementById('add-new-item-btn');
        if (activeTabId === 'tab-programas') {
            if (btnText) btnText.textContent = 'Nuevo programa';
            if (btn) btn.onclick = () => document.getElementById('create-program-modal')?.classList.remove('hidden');
        } else if (activeTabId === 'tab-ejercicios') {
            if (btnText) btnText.textContent = 'Nuevo Ejercicio';
            if (btn) btn.onclick = () => {
                document.getElementById('add-exercise-modal')?.classList.remove('hidden');
                window.renderExerciseLibrary(); // ensure pills are ready
            };
            window.renderExerciseLibrary();
        } else if (activeTabId === 'tab-videos') {
            if (btnText) btnText.textContent = 'Añadir Video';
            if (btn) btn.onclick = () => {
                // Open video modal in standalone library-add mode
                currentVideoTarget = 'library-standalone';
                currentVideoExerciseBtn = null;
                const titleEl  = document.getElementById('video-modal-title');
                const urlInput = document.getElementById('video-url-input');
                const nameInput = document.getElementById('video-library-name');
                if (titleEl)  titleEl.textContent = 'Añadir Video a la Librería';
                if (urlInput) urlInput.value = '';
                if (nameInput) nameInput.value = '';
                document.getElementById('video-upload-modal')?.classList.remove('hidden');
            };
            window.renderVideoLibrary();
        }
    };

    window.renderExerciseLibrary = () => {
        const listContainer = document.getElementById('exercise-library-list');
        const searchInput = document.getElementById('library-search-input');
        if (!listContainer) return;

        // Render Pills
        const catContainer = document.getElementById('category-selection-container');
        if (catContainer && catContainer.innerHTML.trim() === '') {
            catContainer.innerHTML = '';
            muscleGroups.forEach(muscle => {
                const btn = document.createElement('button');
                btn.className = "category-pill px-3 py-1 bg-[#FFDB89]/5 border border-[#FFDB89]/20 rounded-full text-xs text-[#FFDB89]/60 hover:text-[#FFDB89] hover:border-[#FFDB89]/40 hover:bg-[#FFDB89]/10 transition m-1";
                btn.textContent = muscle;
                btn.onclick = () => btn.classList.toggle('selected');
                catContainer.appendChild(btn);
            });
        }

        const renderList = (filterText = '') => {
            listContainer.innerHTML = '';
            const filtered = globalExerciseLibrary.filter(ex => ex.name.toLowerCase().includes(filterText.toLowerCase()));
            if(filtered.length === 0) { listContainer.innerHTML = `<div class="p-8 text-center text-[#FFDB89]/30">No hay ejercicios. ¡Añade uno!</div>`; return; }

            filtered.forEach(ex => {
                const catDisplay = Array.isArray(ex.category) ? ex.category.join(", ") : ex.category;
                const item = document.createElement('div');
                item.className = "p-4 hover:bg-[#FFDB89]/5 flex justify-between items-center transition group border-b border-[#FFDB89]/10 last:border-none";
                item.innerHTML = `
                    <div class="flex items-center gap-4">
                        <div class="w-10 h-10 rounded-full bg-[#FFDB89]/10 border border-[#FFDB89]/20 flex items-center justify-center text-[#FFDB89] font-bold text-sm">${ex.name.charAt(0).toUpperCase()}</div>
                        <div>
                            <h4 class="font-bold text-[#FFDB89]">${ex.name}</h4>
                            <div class="flex gap-2 text-xs text-[#FFDB89]/40 mt-0.5">
                                <span class="px-2 py-0.5 rounded bg-[#FFDB89]/8 border border-[#FFDB89]/15">${catDisplay}</span>
                                ${ex.videoUrl ? `<span class="text-[#FFDB89]/60 flex items-center gap-1"><i class="fas fa-video text-[10px]"></i> Video</span>` : ''}
                            </div>
                        </div>
                    </div>
                    <div class="flex gap-2 opacity-0 group-hover:opacity-100 transition"><button class="p-2 text-[#FFDB89]/40 hover:text-[#FFDB89] transition" title="Edit"><i class="fas fa-edit"></i></button></div>`;
                listContainer.appendChild(item);
            });
        };
        renderList(); 
        if(searchInput) { searchInput.addEventListener('input', (e) => { renderList(e.target.value); }); }
    };

    window.handleSaveNewExercise = async () => {
        const name = document.getElementById('new-ex-name').value;
        const url = document.getElementById('new-ex-url').value;
        const selectedCats = [];
        document.querySelectorAll('#category-selection-container .category-pill.selected').forEach(pill => { selectedCats.push(pill.textContent); });
        const categories = selectedCats.length > 0 ? selectedCats : ["General"];

        if(!name) { showToast("Nombre requerido", 'error'); return; }

        try {
            const res = await apiFetch('/api/library', { method: 'POST', body: JSON.stringify({ name, videoUrl: url, category: categories }) });
            if(res.ok) {
                const savedExercise = await res.json();
                const existingIdx = globalExerciseLibrary.findIndex(e => e.name === savedExercise.name);
                if(existingIdx > -1) globalExerciseLibrary[existingIdx] = savedExercise;
                else globalExerciseLibrary.push(savedExercise);
                document.getElementById('add-exercise-modal').classList.add('hidden');
                document.getElementById('new-ex-name').value = '';
                document.getElementById('new-ex-url').value = '';
                document.querySelectorAll('.category-pill').forEach(p => p.classList.remove('selected'));
                renderExerciseLibrary();
                showToast("¡Ejercicio guardado!", 'success');
            } else { showToast('Error guardando ejercicio.', 'error'); }
        } catch(e) { console.error(e); }
    };

    window.copyWorkout = async (dateStr, clientId) => {
        try {
            const response = await apiFetch(`/api/client-workouts/${clientId}/${dateStr}`);
            if(response.ok) {
                copiedWorkoutData = await response.json();
                copiedMultiDayData = null; // Clear multi-day when single copy is used
                showToast('Workout copiado. Usa el botón "Pegar" en cualquier otro día.', 'success');
            } else {
                showToast('No hay workout en este día para copiar.', 'info');
            }
        } catch(e) {
            console.error(e);
            showToast('Error al copiar workout.', 'error');
        }
    };

    // Multi-day copy/paste system
    window.toggleCopyDay = (checkbox) => {
        const dateStr = checkbox.dataset.date;
        if(checkbox.checked) {
            selectedCopyDays.add(dateStr);
        } else {
            selectedCopyDays.delete(dateStr);
        }
        window.updateCopyBar();
    };

    window.updateCopyBar = () => {
        let bar = document.getElementById('copy-selection-bar');
        if(selectedCopyDays.size > 0) {
            if(!bar) {
                bar = document.createElement('div');
                bar.id = 'copy-selection-bar';
                bar.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 z-[55] bg-[#FFDB89] text-[#2C2C2E] px-6 py-3 rounded-full shadow-2xl flex items-center gap-4 animate-fade-in-down';
                document.body.appendChild(bar);
            }
            bar.innerHTML = `
                <span class="font-bold text-sm"><i class="fas fa-check-square mr-2"></i>${selectedCopyDays.size} dia${selectedCopyDays.size > 1 ? 's' : ''} seleccionado${selectedCopyDays.size > 1 ? 's' : ''}</span>
                <button onclick="window.copySelectedDays()" class="bg-[#2C2C2E] text-[#FFDB89] font-bold px-4 py-1.5 rounded-full text-sm hover:bg-[#2C2C2E]/80 transition">
                    <i class="fas fa-copy mr-1"></i> Copiar
                </button>
                <button onclick="window.deleteSelectedDays()" class="bg-red-600 text-white font-bold px-4 py-1.5 rounded-full text-sm hover:bg-red-700 transition">
                    <i class="fas fa-trash mr-1"></i> Borrar
                </button>
                <button onclick="window.clearCopySelection()" class="text-white/70 hover:text-white transition text-sm">
                    <i class="fas fa-times"></i>
                </button>
            `;
        } else {
            if(bar) bar.remove();
        }
    };

    window.copySelectedDays = async () => {
        if(selectedCopyDays.size === 0 || !currentClientViewId) return;

        // Sort dates to determine order and spacing
        const sortedDates = [...selectedCopyDays].sort();
        const baseDate = new Date(sortedDates[0] + 'T00:00:00');

        // Fetch workouts for each selected day
        const workoutsWithOffsets = [];
        for(const dateStr of sortedDates) {
            try {
                const response = await apiFetch(`/api/client-workouts/${currentClientViewId}/${dateStr}`);
                if(response.ok) {
                    const workout = await response.json();
                    const thisDate = new Date(dateStr + 'T00:00:00');
                    const dayOffset = Math.round((thisDate - baseDate) / (1000 * 60 * 60 * 24));
                    workoutsWithOffsets.push({ workout, dayOffset });
                }
            } catch(e) {
                console.error('Error fetching workout for copy:', e);
            }
        }

        if(workoutsWithOffsets.length === 0) {
            showToast('No se encontraron workouts para copiar.', 'info');
            return;
        }

        copiedMultiDayData = workoutsWithOffsets;
        copiedWorkoutData = null; // Clear single-day copy
        window.clearCopySelection();
        showToast(`${workoutsWithOffsets.length} día${workoutsWithOffsets.length > 1 ? 's' : ''} copiado${workoutsWithOffsets.length > 1 ? 's' : ''}. Usa el botón "Pegar" en el día donde quieres que inicie.`, 'success');
    };

    window.clearCopySelection = () => {
        selectedCopyDays.clear();
        document.querySelectorAll('.copy-day-checkbox').forEach(cb => cb.checked = false);
        window.updateCopyBar();
    };

    window.deleteSelectedDays = async () => {
        if (selectedCopyDays.size === 0 || !currentClientViewId) return;
        const count = selectedCopyDays.size;
        const yes = await showConfirm(
            `¿Borrar el workout de ${count} día${count > 1 ? 's' : ''} seleccionado${count > 1 ? 's' : ''}? Esta acción no se puede deshacer.`,
            { confirmLabel: 'Borrar', danger: true }
        );
        if (!yes) return;

        const datesToDelete = [...selectedCopyDays];
        let deleted = 0;
        for (const dateStr of datesToDelete) {
            try {
                const res = await apiFetch(`/api/client-workouts/${currentClientViewId}/${dateStr}`, { method: 'DELETE' });
                if (res.ok) {
                    deleted++;
                    // Clear the cell UI
                    const cell = document.getElementById(`day-${dateStr}`);
                    if (cell) {
                        const area = cell.querySelector('.content-area');
                        if (area) area.innerHTML = '';
                        const cb = cell.querySelector('.copy-day-checkbox');
                        if (cb) cb.classList.add('hidden');
                    }
                    // Remove from in-memory cache
                    if (window._calendarWorkouts) delete window._calendarWorkouts[dateStr];
                }
            } catch (e) {
                console.error('Error deleting workout:', e);
            }
        }

        window.clearCopySelection();
        showToast(`${deleted} día${deleted > 1 ? 's' : ''} borrado${deleted > 1 ? 's' : ''} exitosamente.`, 'success');
    };

    // =============================================================================
    // 7. PROGRAMS, CALENDAR & BUILDER (MODIFIED SECTION)
    // =============================================================================

    const handleCreateProgram = async () => {
        const name = document.getElementById('program-name-input').value.trim();
        if(!name) { showToast("Nombre requerido", 'error'); return; }
        
        try {
            const res = await apiFetch('/api/programs', {
                method: 'POST',
                body: JSON.stringify({
                    name: name,
                    description: "",
                    weeks: [],
                    clientCount: 0,
                    tags: "Borrador"
                })
            });
            
            if(res.ok) {
                const newProg = await res.json();
                programsCache.push(newProg);
                document.getElementById('create-program-modal').classList.add('hidden');
                document.getElementById('program-name-input').value = '';
                renderProgramsList();
                openProgramBuilder(newProg._id); // Use MongoDB _id
                showToast("¡Programa creado!", 'success');
            } else {
                showToast("Error creando programa", 'error');
            }
        } catch(e) {
            console.error(e);
            showToast('Error de conexión.', 'error');
        }
    };

    const renderProgramsList = () => { /* ... (Existing Logic) ... */
        const container = document.getElementById('programs-list-container');
        if (!container) return;
        container.innerHTML = '';
        programsCache.forEach(prog => {
            const card = document.createElement('div');
            card.className = "program-card bg-[#1C1C1E] border border-[#FFDB89]/20 hover:border-[#FFDB89]/50 p-5 rounded-xl shadow-lg hover:shadow-[0_0_20px_rgba(255,219,137,0.08)] transition duration-300 cursor-pointer relative group";
            card.dataset.id = prog._id || prog.id;
            const progId = prog._id || prog.id;
            card.innerHTML = `
                <button class="delete-program-btn absolute top-3 right-3 w-7 h-7 rounded-full bg-red-500/10 border border-red-500/20 text-red-400/50 hover:text-red-400 hover:bg-red-500/20 hover:border-red-500/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-200 z-10" data-id="${progId}" title="Borrar programa">
                    <i class="fas fa-times text-xs pointer-events-none"></i>
                </button>
                <div class="pointer-events-none">
                    <h3 class="font-bold text-lg text-[#FFDB89]">${prog.name}</h3>
                    <span class="text-xs px-2 py-0.5 bg-[#FFDB89]/10 text-[#FFDB89]/70 border border-[#FFDB89]/20 rounded-full">${prog.tags || 'General'}</span>
                </div>
                <div class="mt-4 text-xs text-[#FFDB89]/40 pointer-events-none flex items-center gap-2"><i class="fas fa-layer-group text-[8px]"></i><span>${prog.weeks.length} ${prog.weeks.length === 1 ? 'Semana' : 'Semanas'}</span><span class="opacity-40">|</span><i class="fas fa-users text-[8px]"></i><span>${(() => { const n = clientsCache.filter(c => c.program === prog.name && !c.isDeleted).length; return `${n} ${n === 1 ? 'cliente' : 'clientes'}`; })()}</span></div>`;
            container.appendChild(card);
        });
    };

    const renderProgramBuilder = (prog) => {
        document.getElementById('builder-program-name').textContent = prog.name;
        const countEl = document.getElementById('builder-client-count');
        if (countEl) {
            const n = clientsCache.filter(c => c.program === prog.name && !c.isDeleted).length;
            countEl.textContent = `${n} ${n === 1 ? 'Cliente' : 'Clientes'}`;
        }
        document.getElementById('calendar-container').innerHTML = '';
        currentWeekCount = 0;
        if (prog.weeks && prog.weeks.length > 0) {
            prog.weeks.forEach(week => addWeekToCalendar(week));
        } else {
            addWeekToCalendar();
        }
    };

    const openProgramBuilder = async (id) => {
        const prog = programsCache.find(p => (p.id == id) || (p._id == id));
        if (!prog) return;
        currentProgramId = id;
        document.getElementById('programs-main-view').classList.add('hidden');
        document.getElementById('program-builder-view').classList.remove('hidden');
        if (clientsCache.length === 0) await fetchClientsFromDB();
        renderProgramBuilder(prog);
    };

    const addWeekToCalendar = (weekData = null) => {
        currentWeekCount++;
        const weekDiv = document.createElement('div');
        weekDiv.className = "week-block mb-8";
        const days = weekData?.days || {};
        const getDayData = (i) => days[String(i + 1)] || days[i + 1] || null;
        weekDiv.innerHTML = `<h4 class="text-sm font-bold text-[#FFDB89]/50 uppercase tracking-widest mb-4 px-1 flex items-center gap-2"><span class="inline-block w-4 h-px bg-[#FFDB89]/30"></span>Semana ${currentWeekCount}</h4><div class="grid grid-cols-1 md:grid-cols-7 gap-3">${Array.from({length: 7}, (_, i) => renderDayCell(i + 1, getDayData(i))).join('')}</div>`;
        document.getElementById('calendar-container').appendChild(weekDiv);
    };

    // Sync every copy/paste cell to reflect whether clipboard has data
    const syncCopyPasteButtons = () => {
        const hasCopy = !!copiedProgramDayData;
        document.querySelectorAll('.action-copy, .action-paste').forEach(el => {
            const dayAttr = el.dataset.day;
            if (hasCopy) {
                el.classList.remove('action-copy');
                el.classList.add('action-paste');
                el.querySelector('i').className = 'fas fa-paste text-sm';
                el.querySelector('span').textContent = 'Pegar';
            } else {
                el.classList.remove('action-paste');
                el.classList.add('action-copy');
                el.querySelector('i').className = 'fas fa-copy text-sm';
                el.querySelector('span').textContent = 'Copiar';
            }
            el.dataset.day = dayAttr; // preserve data-day through the swap
        });
    };

    // Original Render Day Cell (For Program Builder)
    const renderDayCell = (dayNum, existingDay = null) => {
        const dayNames = ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];
        let bodyContent;
        if (existingDay?.isRest && existingDay?.isActiveRest) {
            bodyContent = `<div class="text-center text-[#6EE7B7]/70"><i class="fas fa-person-walking text-xl"></i><div class="text-[10px] font-bold mt-1 uppercase tracking-wider">Desc. Activo</div></div>`;
        } else if (existingDay?.isRest) {
            bodyContent = `<div class="text-center text-green-400/70"><i class="fas fa-bed text-xl"></i><div class="text-[10px] font-bold mt-1 uppercase tracking-wider">Descanso</div></div>`;
        } else if (existingDay?.exercises?.length > 0) {
            const preview = existingDay.exercises.slice(0, 3).map(ex => `<div class="truncate text-[10px] text-[#FFDB89]/60">• ${ex.name}</div>`).join('');
            const more = existingDay.exercises.length > 3 ? `<div class="text-[10px] text-[#FFDB89]/30">+${existingDay.exercises.length - 3} más</div>` : '';
            bodyContent = `<div class="text-left w-full space-y-0.5">${preview}${more}</div>`;
        } else {
            bodyContent = `<div class="text-center text-[#FFDB89]/15"><i class="fas fa-plus text-xl"></i></div>`;
        }
        const nameLabel = existingDay?.name ? `<div class="text-[10px] text-[#FFDB89]/50 truncate mt-0.5">${existingDay.name}</div>` : '';
        const hasContent = existingDay?.exercises?.length > 0 || existingDay?.isRest || existingDay?.isActiveRest;
        return `<div class="relative bg-[#1C1C1E] h-40 rounded-xl border border-[#FFDB89]/15 group overflow-hidden hover:border-[#FFDB89]/40 transition-all duration-200">
            <div class="p-3 h-full flex flex-col justify-between">
                <div>
                    <div class="flex items-center justify-between">
                        <span class="text-[10px] font-bold text-[#FFDB89]/40 uppercase tracking-widest">${dayNames[dayNum-1]}</span>
                        ${existingDay?.nutrition?.meals?.length > 0 ? '<span title="Tiene plan de nutrición" class="text-orange-400/70 text-[9px]"><i class="fas fa-apple-alt"></i></span>' : ''}
                    </div>
                    ${nameLabel}
                </div>
                ${bodyContent}
                <div></div>
            </div>
            <div class="absolute inset-0 bg-[#030303]/96 backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity flex flex-col cursor-pointer z-10 rounded-xl overflow-hidden">
                ${hasContent ? `
                <div class="action-view flex items-center justify-center gap-2 py-2.5 hover:bg-[#FFDB89]/12 text-[#FFDB89]/60 hover:text-[#FFDB89] transition border-b-2 border-[#FFDB89]/20 shrink-0" data-day="${dayNum}">
                    <i class="fas fa-eye text-sm pointer-events-none"></i>
                    <span class="text-[9px] font-bold uppercase tracking-wider pointer-events-none">Ver rutina</span>
                </div>` : ''}
                <div class="flex-1 flex border-b border-[#FFDB89]/10">
                    <div class="action-add flex-1 flex flex-col items-center justify-center hover:bg-[#FFDB89]/10 text-[#FFDB89]/80 hover:text-[#FFDB89] transition border-r border-[#FFDB89]/10" data-day="${dayNum}"><i class="fas fa-dumbbell text-sm"></i><span class="text-[9px] font-bold mt-1 uppercase tracking-wider">Añadir</span></div>
                    <div class="action-nutri flex-1 flex flex-col items-center justify-center hover:bg-orange-500/10 text-orange-400/70 hover:text-orange-400 transition" data-day="${dayNum}"><i class="fas fa-apple-alt text-sm"></i><span class="text-[9px] font-bold mt-1 uppercase tracking-wider">Nutrición</span></div>
                </div>
                <div class="flex-1 flex">
                    <div class="action-rest flex-1 flex flex-col items-center justify-center hover:bg-green-500/10 text-green-400/70 hover:text-green-400 transition border-r border-[#FFDB89]/10" data-day="${dayNum}"><i class="fas fa-bed text-sm"></i><span class="text-[9px] font-bold mt-1 uppercase tracking-wider">Descanso</span></div>
                    <div class="action-active-rest flex-1 flex flex-col items-center justify-center hover:bg-[#6EE7B7]/10 text-[#6EE7B7]/60 hover:text-[#6EE7B7] transition border-r border-[#FFDB89]/10" data-day="${dayNum}"><i class="fas fa-person-walking text-sm"></i><span class="text-[9px] font-bold mt-1 uppercase tracking-wider">Activo</span></div>
                    <div class="action-copy flex-1 flex flex-col items-center justify-center hover:bg-[#FFDB89]/10 text-[#FFDB89]/40 hover:text-[#FFDB89]/70 transition" data-day="${dayNum}"><i class="fas fa-copy text-sm"></i><span class="text-[9px] font-bold mt-1 uppercase tracking-wider">Copiar</span></div>
                </div>
            </div>
        </div>`;
    };

    const openProgramDayView = (weekIndex, dayNum) => {
        const prog = programsCache.find(p => (p._id == currentProgramId) || (p.id == currentProgramId));
        if (!prog) return;
        const day = prog.weeks?.[weekIndex]?.days?.[String(dayNum)];
        const dayNames = ['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo'];
        const dayLabel = dayNames[(dayNum - 1) % 7];
        const weekNum  = weekIndex + 1;

        document.getElementById('program-day-view-modal')?.remove();

        let bodyHtml = '';

        if (day?.isActiveRest) {
            bodyHtml = `<div class="flex flex-col items-center justify-center py-12 gap-3">
                <i class="fas fa-person-walking text-5xl text-[#6EE7B7]/60"></i>
                <p class="text-lg font-bold text-[#6EE7B7]">Descanso Activo</p>
                <p class="text-sm text-[#FFDB89]/40">Cardio ligero, caminata, movilidad o stretching</p>
            </div>`;
        } else if (day?.isRest) {
            bodyHtml = `<div class="flex flex-col items-center justify-center py-12 gap-3">
                <i class="fas fa-bed text-5xl text-green-400/60"></i>
                <p class="text-lg font-bold text-green-400">Día de Descanso</p>
                <p class="text-sm text-[#FFDB89]/40">Recuperación completa</p>
            </div>`;
        } else if (day?.exercises?.length > 0) {
            const warmupItemsHtml = (day.warmupItems || []).map(item => `
                <div class="flex items-center gap-2 pl-1">
                    <i class="fas fa-circle text-orange-400/40 text-[6px] shrink-0"></i>
                    <span class="text-sm text-[#FFDB89]/70 flex-1">${item.name || ''}</span>
                    ${item.videoUrl ? `<button onclick="window.previewExerciseVideo('${item.videoUrl.replace(/'/g,"\\'")}','${(item.name||'').replace(/'/g,"\\'")}',this);" class="text-green-400/70 hover:text-green-400 transition text-sm shrink-0"><i class="fas fa-play-circle"></i></button>` : ''}
                </div>`).join('');
            const warmupHtml = (day.warmup || day.warmupItems?.length) ? `
                <div class="flex items-start gap-3 p-4 bg-orange-500/5 border border-orange-500/20 rounded-xl mb-4">
                    <div class="w-7 h-7 bg-orange-500/20 rounded-lg flex items-center justify-center shrink-0 mt-0.5"><i class="fas fa-fire text-orange-400 text-xs"></i></div>
                    <div class="flex-1 min-w-0">
                        <p class="text-xs font-bold text-orange-400/80 uppercase tracking-wider mb-1">Calentamiento</p>
                        ${day.warmup ? `<p class="text-sm text-[#FFDB89]/70 leading-relaxed mb-2">${day.warmup}</p>` : ''}
                        ${warmupItemsHtml ? `<div class="space-y-1.5">${warmupItemsHtml}</div>` : ''}
                        ${day.warmupVideo ? `<button onclick="window.previewExerciseVideo('${day.warmupVideo.replace(/'/g,"\\'")}','Calentamiento',this)" class="mt-2 text-xs text-[#FFDB89]/50 hover:text-[#FFDB89] flex items-center gap-1.5 transition"><i class="fas fa-play-circle text-green-400"></i>Ver video</button>` : ''}
                    </div>
                </div>` : '';

            const exercisesHtml = day.exercises.map((ex, idx) => {
                const letter = (window.getExerciseLetter ? window.getExerciseLetter(idx, day.exercises) : String.fromCharCode(65 + idx % 26));
                const hasVideo = ex.video || ex.videoUrl;
                const videoUrl = ex.video || ex.videoUrl || '';
                return `
                <div class="flex gap-3 p-4 bg-[#FFDB89]/3 border border-[#FFDB89]/10 rounded-xl hover:border-[#FFDB89]/20 transition">
                    <span class="text-2xl font-black text-[#FFDB89]/20 shrink-0 w-6 text-center leading-tight">${letter}</span>
                    <div class="flex-1 min-w-0">
                        <div class="flex items-start justify-between gap-2">
                            <p class="font-bold text-[#FFDB89] text-sm leading-snug">${ex.name || '—'}</p>
                            ${hasVideo ? `<button onclick="window.previewExerciseVideo('${videoUrl.replace(/'/g,"\\'")}','${(ex.name||'').replace(/'/g,"\\'")}',this); event.stopPropagation();" class="shrink-0 text-green-400/70 hover:text-green-400 transition text-sm" title="Ver video del ejercicio"><i class="fas fa-play-circle"></i></button>` : ''}
                        </div>
                        ${ex.stats ? `<p class="text-xs text-[#FFDB89]/50 mt-1 leading-relaxed whitespace-pre-line">${ex.stats}</p>` : ''}
                        ${ex.instructions ? `<p class="text-xs text-[#FFDB89]/50 mt-1 leading-relaxed whitespace-pre-line">${ex.instructions}</p>` : ''}
                        ${ex.results ? `<p class="text-xs text-green-400/60 mt-1 italic">${ex.results}</p>` : ''}
                    </div>
                </div>`;
            }).join('');

            const cooldownItemsHtml = (day.cooldownItems || []).map(item => `
                <div class="flex items-center gap-2 pl-1">
                    <i class="fas fa-circle text-sky-400/40 text-[6px] shrink-0"></i>
                    <span class="text-sm text-[#FFDB89]/60 flex-1">${item.name || ''}</span>
                    ${item.videoUrl ? `<button onclick="window.previewExerciseVideo('${item.videoUrl.replace(/'/g,"\\'")}','${(item.name||'').replace(/'/g,"\\'")}',this);" class="text-green-400/70 hover:text-green-400 transition text-sm shrink-0"><i class="fas fa-play-circle"></i></button>` : ''}
                </div>`).join('');
            const cooldownHtml = (day.cooldown || day.cooldownItems?.length) ? `
                <div class="flex items-start gap-3 p-4 bg-sky-400/5 border border-sky-400/20 rounded-xl mt-4">
                    <div class="w-7 h-7 bg-sky-400/20 rounded-lg flex items-center justify-center shrink-0 mt-0.5"><i class="fas fa-snowflake text-sky-400 text-xs"></i></div>
                    <div class="flex-1 min-w-0">
                        <p class="text-xs font-bold text-sky-400/70 uppercase tracking-wider mb-1">Enfriamiento</p>
                        ${day.cooldown ? `<p class="text-sm text-[#FFDB89]/60 leading-relaxed mb-2">${day.cooldown}</p>` : ''}
                        ${cooldownItemsHtml ? `<div class="space-y-1.5">${cooldownItemsHtml}</div>` : ''}
                        ${day.cooldownVideo ? `<button onclick="window.previewExerciseVideo('${day.cooldownVideo.replace(/'/g,"\\'")}','Enfriamiento',this)" class="mt-2 text-xs text-[#FFDB89]/50 hover:text-[#FFDB89] flex items-center gap-1.5 transition"><i class="fas fa-play-circle text-green-400"></i>Ver video</button>` : ''}
                    </div>
                </div>` : '';

            bodyHtml = warmupHtml + `<div class="space-y-2">${exercisesHtml}</div>` + cooldownHtml;
        } else {
            bodyHtml = `<div class="flex flex-col items-center justify-center py-12 gap-3 text-[#FFDB89]/25">
                <i class="fas fa-dumbbell text-4xl"></i>
                <p class="text-sm">Sin ejercicios asignados</p>
            </div>`;
        }

        const modal = document.createElement('div');
        modal.id = 'program-day-view-modal';
        modal.className = 'fixed inset-0 z-[80] flex items-end md:items-center justify-center bg-black/70 backdrop-blur-sm p-0 md:p-6';
        modal.innerHTML = `
            <div class="bg-[#1C1C1E] border border-[#FFDB89]/20 rounded-t-2xl md:rounded-2xl shadow-2xl w-full max-w-lg max-h-[88vh] flex flex-col overflow-hidden">
                <!-- Header -->
                <div class="flex items-center justify-between px-5 py-4 border-b border-[#FFDB89]/15 shrink-0 bg-[#26262c]">
                    <div>
                        <p class="text-xs text-[#FFDB89]/40 font-bold uppercase tracking-widest">Semana ${weekNum} · ${dayLabel}</p>
                        <h3 class="text-lg font-black text-[#FFDB89] mt-0.5">${day?.name || dayLabel}</h3>
                    </div>
                    <div class="flex items-center gap-2">
                        <button onclick="document.getElementById('program-day-view-modal').remove(); const wb=Array.from(document.querySelectorAll('.week-block')); currentEditingWeekIndex=${weekIndex}; currentEditingDay=${dayNum}; openExerciseBuilder(${dayNum});"
                            class="px-3 py-1.5 rounded-lg border border-[#FFDB89]/30 text-[#FFDB89]/70 hover:text-[#FFDB89] hover:bg-[#FFDB89]/10 text-xs font-bold transition flex items-center gap-1.5">
                            <i class="fas fa-edit text-xs"></i>Editar
                        </button>
                        <button id="close-day-view-modal" class="text-[#FFDB89]/40 hover:text-[#FFDB89] transition text-xl leading-none">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>
                </div>
                <!-- Body -->
                <div class="flex-1 overflow-y-auto p-5 space-y-3">
                    ${bodyHtml}
                </div>
            </div>`;

        document.body.appendChild(modal);
        modal.querySelector('#close-day-view-modal')?.addEventListener('click', () => modal.remove());
        modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    };

    const openExerciseBuilder = (dayNum) => {
        document.getElementById('edit-routine-modal').classList.remove('hidden');
        document.getElementById('exercise-list').innerHTML = '';
        exerciseCount = 0;
        const prog = currentProgramId ? programsCache.find(p => (p.id == currentProgramId) || (p._id == currentProgramId)) : null;
        const existingDay = prog?.weeks?.[currentEditingWeekIndex]?.days?.[String(dayNum)];
        if (existingDay) {
            document.getElementById('routine-name-input').value = existingDay.name || `Entrenamiento Día ${dayNum}`;
            document.getElementById('routine-warmup').value   = existingDay.warmup   || '';
            document.getElementById('routine-cooldown').value = existingDay.cooldown || '';
            routineWarmupVideo   = existingDay.warmupVideo   || '';
            routineCooldownVideo = existingDay.cooldownVideo || '';
            routineWarmupItems   = (existingDay.warmupItems  || []).map(i => ({ ...i }));
            routineCooldownItems = (existingDay.cooldownItems|| []).map(i => ({ ...i }));
            if (existingDay.exercises?.length > 0) {
                existingDay.exercises.forEach(ex => addExerciseToBuilder(ex));
            } else {
                addExerciseToBuilder();
            }
        } else {
            document.getElementById('routine-name-input').value = `Entrenamiento Día ${dayNum}`;
            document.getElementById('routine-warmup').value   = '';
            document.getElementById('routine-cooldown').value = '';
            routineWarmupVideo   = '';
            routineCooldownVideo = '';
            routineWarmupItems   = [];
            routineCooldownItems = [];
            addExerciseToBuilder();
        }
        renderRoutineItems();
        // Update video button colours to gold when a URL is already stored
        const wBtn = document.getElementById('warmup-video-btn');
        const cBtn = document.getElementById('cooldown-video-btn');
        if (wBtn) { wBtn.classList.toggle('text-[#FFDB89]', !!routineWarmupVideo); wBtn.classList.toggle('text-[#FFDB89]/40', !routineWarmupVideo); }
        if (cBtn) { cBtn.classList.toggle('text-[#FFDB89]', !!routineCooldownVideo); cBtn.classList.toggle('text-[#FFDB89]/40', !routineCooldownVideo); }
    };

    // ── Routine builder warmup / cooldown items ───────────────────────────────
    const renderRoutineItems = () => {
        const wList = document.getElementById('routine-warmup-items-list');
        const cList = document.getElementById('routine-cooldown-items-list');
        // Programas aesthetic: same card style as the textarea rows above (subtle bg tint + border + rounded)
        if (wList) wList.innerHTML = routineWarmupItems.map(item => `
            <div class="flex items-center gap-2">
                <input type="text" value="${(item.name||'').replace(/"/g,'&quot;')}"
                    oninput="window.updateRoutineWarmupItem(${item.id}, this.value); window.showRoutineItemAc(this, ${item.id}, 'warmup')"
                    onkeydown="if(event.key==='Escape') window._hideExAc()"
                    onblur="setTimeout(window._hideExAc, 150)"
                    class="flex-1 min-w-0 p-2.5 bg-[#FFDB89]/5 border border-[#FFDB89]/15 rounded-lg text-sm text-[#FFDB89] placeholder:text-[#FFDB89]/25 outline-none focus:border-[#FFDB89]/40 transition"
                    placeholder="Ejercicio de calentamiento...">
                ${item.videoUrl
                    ? `<button onclick="window.previewExerciseVideo('${item.videoUrl.replace(/'/g,"\\'")}','${(item.name||'').replace(/'/g,"\\'")}',this);"
                        class="p-2.5 bg-green-500/10 border border-green-500/20 text-green-400 hover:bg-green-500/20 rounded-lg transition shrink-0" title="Ver video">
                        <i class="fas fa-play text-xs"></i></button>`
                    : ''}
                <button onclick="window.openVideoForRoutineWarmupItem(${item.id})"
                    class="p-2.5 bg-[#FFDB89]/5 border border-[#FFDB89]/15 ${item.videoUrl ? 'text-[#FFDB89]' : 'text-[#FFDB89]/40'} hover:text-[#FFDB89] hover:bg-[#FFDB89]/10 rounded-lg transition shrink-0" title="Asignar video">
                    <i class="fas fa-video text-xs"></i></button>
                <button onclick="window.removeRoutineWarmupItem(${item.id})"
                    class="p-2.5 text-[#FFDB89]/25 hover:text-red-400 transition shrink-0" title="Eliminar">
                    <i class="fas fa-times text-xs"></i></button>
            </div>`).join('');
        if (cList) cList.innerHTML = routineCooldownItems.map(item => `
            <div class="flex items-center gap-2">
                <input type="text" value="${(item.name||'').replace(/"/g,'&quot;')}"
                    oninput="window.updateRoutineCooldownItem(${item.id}, this.value); window.showRoutineItemAc(this, ${item.id}, 'cooldown')"
                    onkeydown="if(event.key==='Escape') window._hideExAc()"
                    onblur="setTimeout(window._hideExAc, 150)"
                    class="flex-1 min-w-0 p-2.5 bg-[#FFDB89]/5 border border-[#FFDB89]/15 rounded-lg text-sm text-[#FFDB89] placeholder:text-[#FFDB89]/25 outline-none focus:border-[#FFDB89]/40 transition"
                    placeholder="Ejercicio de enfriamiento...">
                ${item.videoUrl
                    ? `<button onclick="window.previewExerciseVideo('${item.videoUrl.replace(/'/g,"\\'")}','${(item.name||'').replace(/'/g,"\\'")}',this);"
                        class="p-2.5 bg-green-500/10 border border-green-500/20 text-green-400 hover:bg-green-500/20 rounded-lg transition shrink-0" title="Ver video">
                        <i class="fas fa-play text-xs"></i></button>`
                    : ''}
                <button onclick="window.openVideoForRoutineCooldownItem(${item.id})"
                    class="p-2.5 bg-[#FFDB89]/5 border border-[#FFDB89]/15 ${item.videoUrl ? 'text-[#FFDB89]' : 'text-[#FFDB89]/40'} hover:text-[#FFDB89] hover:bg-[#FFDB89]/10 rounded-lg transition shrink-0" title="Asignar video">
                    <i class="fas fa-video text-xs"></i></button>
                <button onclick="window.removeRoutineCooldownItem(${item.id})"
                    class="p-2.5 text-[#FFDB89]/25 hover:text-red-400 transition shrink-0" title="Eliminar">
                    <i class="fas fa-times text-xs"></i></button>
            </div>`).join('');
    };

    window.addRoutineWarmupItem = () => {
        routineWarmupItems.push({ id: Date.now(), name: '', videoUrl: '' });
        renderRoutineItems();
    };
    window.removeRoutineWarmupItem = (id) => {
        routineWarmupItems = routineWarmupItems.filter(i => i.id !== id);
        renderRoutineItems();
    };
    window.updateRoutineWarmupItem = (id, val) => {
        const item = routineWarmupItems.find(i => i.id === id);
        if (item) item.name = val;
    };
    window.openVideoForRoutineWarmupItem = (id) => {
        currentVideoTarget = `routine-warmup-item-${id}`;
        const item = routineWarmupItems.find(i => i.id === id);
        const modal    = document.getElementById('video-upload-modal');
        const input    = document.getElementById('video-url-input');
        const nameInp  = document.getElementById('video-library-name');
        const title    = document.getElementById('video-modal-title');
        if (input)   input.value   = item?.videoUrl || '';
        if (nameInp) nameInp.value = item?.name     || '';
        if (title)   title.textContent = 'Video del ejercicio';
        if (modal)   modal.classList.remove('hidden');
    };

    window.addRoutineCooldownItem = () => {
        routineCooldownItems.push({ id: Date.now(), name: '', videoUrl: '' });
        renderRoutineItems();
    };
    window.removeRoutineCooldownItem = (id) => {
        routineCooldownItems = routineCooldownItems.filter(i => i.id !== id);
        renderRoutineItems();
    };
    window.updateRoutineCooldownItem = (id, val) => {
        const item = routineCooldownItems.find(i => i.id === id);
        if (item) item.name = val;
    };
    window.openVideoForRoutineCooldownItem = (id) => {
        currentVideoTarget = `routine-cooldown-item-${id}`;
        const item = routineCooldownItems.find(i => i.id === id);
        const modal    = document.getElementById('video-upload-modal');
        const input    = document.getElementById('video-url-input');
        const nameInp  = document.getElementById('video-library-name');
        const title    = document.getElementById('video-modal-title');
        if (input)   input.value   = item?.videoUrl || '';
        if (nameInp) nameInp.value = item?.name     || '';
        if (title)   title.textContent = 'Video del ejercicio';
        if (modal)   modal.classList.remove('hidden');
    };

    // ── Exercise-name autocomplete portal ────────────────────────────────────
    // Attached to <body> so it's never clipped by overflow-y:auto ancestors.

    // Build a deduplicated exercise list from the library + every exercise ever
    // used in any program (so names typed in routines show up even if the library
    // section is empty).
    const getAllKnownExercises = () => {
        const seen = new Set();
        const all  = [];
        const add  = (name, videoUrl) => {
            if (!name) return;
            const k = name.toLowerCase().trim();
            if (seen.has(k)) return;
            seen.add(k);
            all.push({ name: name.trim(), videoUrl: videoUrl || '' });
        };
        globalExerciseLibrary.forEach(ex => add(ex.name, ex.videoUrl));
        programsCache.forEach(prog => {
            prog.weeks?.forEach(week => {
                Object.values(week.days || {}).forEach(day => {
                    (day.exercises    || []).forEach(ex   => add(ex.name,   ex.videoUrl));
                    (day.warmupItems  || []).forEach(item => add(item.name, item.videoUrl));
                    (day.cooldownItems|| []).forEach(item => add(item.name, item.videoUrl));
                });
            });
        });
        return all;
    };

    let _exAcPortal = null;
    const getExAcPortal = () => {
        if (!_exAcPortal) {
            _exAcPortal = document.createElement('div');
            _exAcPortal.className = 'autocomplete-list hidden';
            _exAcPortal.style.cssText = 'position:fixed;z-index:9999;';
            document.body.appendChild(_exAcPortal);
        }
        return _exAcPortal;
    };
    const hideExAc = () => getExAcPortal().classList.add('hidden');
    const positionExAc = (inputEl) => {
        const r = inputEl.getBoundingClientRect();
        const p = getExAcPortal();
        p.style.top   = (r.bottom + 4) + 'px';
        p.style.left  = r.left + 'px';
        p.style.width = r.width + 'px';
    };
    // Close portal when clicking outside it or outside any exercise/routine name input
    document.addEventListener('click', (e) => {
        const p = _exAcPortal;
        if (!p || p.contains(e.target)) return;
        const t = e.target;
        if (t.classList.contains('exercise-name-input')) return;
        // routine item inputs (warmup/cooldown) live inside these lists
        if (t.closest('#routine-warmup-items-list, #routine-cooldown-items-list')) return;
        hideExAc();
    });

    const addExerciseToBuilder = (data = null) => {
        const list = document.getElementById('exercise-list');
        const label = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[exerciseCount++ % 26];
        const item = document.createElement('div');
        item.className = "exercise-item bg-[#111113] border border-[#FFDB89]/15 hover:border-[#FFDB89]/30 p-4 rounded-xl group transition-colors duration-200";
        item.innerHTML = `
            <div class="flex gap-3 items-stretch">
                <div class="flex flex-col justify-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 self-center">
                    <button class="w-7 h-7 rounded-full bg-[#FFDB89]/10 border border-[#FFDB89]/20 text-[#FFDB89]/50 hover:text-[#FFDB89] hover:bg-[#FFDB89]/20 flex items-center justify-center transition" title="Reordenar"><i class="fas fa-grip-lines text-xs"></i></button>
                    <button class="w-7 h-7 rounded-full bg-red-500/10 border border-red-500/20 text-red-400/50 hover:text-red-400 hover:bg-red-500/20 flex items-center justify-center transition" onclick="this.closest('.exercise-item').remove()" title="Eliminar"><i class="fas fa-trash text-xs"></i></button>
                </div>
                <div class="pt-2 shrink-0"><span class="text-2xl font-black text-[#FFDB89]/20 exercise-label">${label}</span></div>
                <div class="flex-grow space-y-3">
                    <div class="flex gap-2">
                        <input type="text" class="exercise-name-input w-full p-3 bg-[#FFDB89]/5 border border-[#FFDB89]/20 rounded-lg text-[#FFDB89] placeholder:text-[#FFDB89]/25 font-semibold focus:ring-2 focus:ring-[#FFDB89]/30 focus:border-[#FFDB89]/50 outline-none transition" placeholder="Nombre del ejercicio" value="${data ? data.name : ''}" autocomplete="off">
                        <button class="p-3 bg-[#FFDB89]/5 border border-[#FFDB89]/20 ${data?.video ? 'text-[#FFDB89]' : 'text-[#FFDB89]/40'} hover:text-[#FFDB89] hover:bg-[#FFDB89]/10 rounded-lg transition open-video-modal" data-video="${data?.video || ''}"><i class="fas fa-video text-sm"></i></button>
                    </div>
                    <textarea class="exercise-stats-input w-full p-3 bg-[#FFDB89]/5 border border-[#FFDB89]/15 rounded-lg text-[#FFDB89]/80 placeholder:text-[#FFDB89]/25 text-sm resize-none focus:border-[#FFDB89]/40 focus:ring-2 focus:ring-[#FFDB89]/20 outline-none transition" rows="3" placeholder="Sets x Reps — Ej: 4x10 @ 70%, descanso 90s...">${data ? data.stats : ''}</textarea>
                </div>
            </div>`;
        list.appendChild(item);

        const input   = item.querySelector('.exercise-name-input');
        const videoBtn = item.querySelector('.open-video-modal');

        input.addEventListener('input', (e) => {
            const val = e.target.value.trim();
            const portal = getExAcPortal();
            portal.innerHTML = '';
            hideExAc();
            if (!val) return;
            const lc = val.toLowerCase();
            const matches = getAllKnownExercises()
                .filter(ex => ex.name.toLowerCase().includes(lc))
                .slice(0, 8);
            if (!matches.length) return;
            positionExAc(input);
            portal.classList.remove('hidden');
            matches.forEach(match => {
                const div = document.createElement('div');
                div.className = 'autocomplete-item';
                const idx     = match.name.toLowerCase().indexOf(lc);
                const before  = match.name.slice(0, idx);
                const matched = match.name.slice(idx, idx + val.length);
                const after   = match.name.slice(idx + val.length);
                div.innerHTML = `
                    <span class="flex-1 min-w-0 truncate">${before}<mark>${matched}</mark>${after}</span>
                    ${match.videoUrl ? '<i class="fas fa-video text-[9px] text-green-400/60 shrink-0"></i>' : ''}`;
                div.addEventListener('mousedown', (ev) => {
                    ev.preventDefault(); // keep focus on input
                    input.value = match.name;
                    hideExAc();
                    if (match.videoUrl) {
                        videoBtn.dataset.video = match.videoUrl;
                        videoBtn.classList.remove('text-[#FFDB89]/40');
                        videoBtn.classList.add('text-[#FFDB89]');
                    }
                });
                portal.appendChild(div);
            });
        });
        input.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideExAc(); });
        input.addEventListener('blur',    ()  => { setTimeout(hideExAc, 150); });
    };

    // Expose to global scope so inline onclick in HTML can reach it
    window.addExerciseToBuilder = addExerciseToBuilder;
    // Expose hideExAc so inline onblur/onkeydown in renderRoutineItems can call it
    window._hideExAc = hideExAc;

    // Autocomplete for warmup / cooldown item inputs (rendered via innerHTML in renderRoutineItems)
    window.showRoutineItemAc = (inputEl, itemId, type) => {
        const val = inputEl.value.trim();
        const portal = getExAcPortal();
        portal.innerHTML = '';
        hideExAc();
        if (!val) return;
        const lc = val.toLowerCase();
        const matches = getAllKnownExercises()
            .filter(ex => ex.name.toLowerCase().includes(lc))
            .slice(0, 8);
        if (!matches.length) return;
        positionExAc(inputEl);
        portal.classList.remove('hidden');
        matches.forEach(match => {
            const div = document.createElement('div');
            div.className = 'autocomplete-item';
            const idx     = match.name.toLowerCase().indexOf(lc);
            const before  = match.name.slice(0, idx);
            const matched = match.name.slice(idx, idx + val.length);
            const after   = match.name.slice(idx + val.length);
            div.innerHTML = `
                <span class="flex-1 min-w-0 truncate">${before}<mark>${matched}</mark>${after}</span>
                ${match.videoUrl ? '<i class="fas fa-video text-[9px] text-green-400/60 shrink-0"></i>' : ''}`;
            div.addEventListener('mousedown', (ev) => {
                ev.preventDefault();
                inputEl.value = match.name;
                hideExAc();
                if (type === 'warmup') {
                    window.updateRoutineWarmupItem(itemId, match.name);
                    if (match.videoUrl) {
                        const it = routineWarmupItems.find(i => i.id === itemId);
                        if (it) { it.videoUrl = match.videoUrl; renderRoutineItems(); }
                    }
                } else {
                    window.updateRoutineCooldownItem(itemId, match.name);
                    if (match.videoUrl) {
                        const it = routineCooldownItems.find(i => i.id === itemId);
                        if (it) { it.videoUrl = match.videoUrl; renderRoutineItems(); }
                    }
                }
            });
            portal.appendChild(div);
        });
    };

    // =========================================================================
    // NUTRITION DAY PLANNER
    // =========================================================================

    const escNutri = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

    const computeFood = (food) => ({
        cal: Math.round((food.cal100 || 0) * (food.qty || 0) / 100),
        p:   Math.round((food.p100   || 0) * (food.qty || 0) / 100 * 10) / 10,
        c:   Math.round((food.c100   || 0) * (food.qty || 0) / 100 * 10) / 10,
        f:   Math.round((food.f100   || 0) * (food.qty || 0) / 100 * 10) / 10,
    });

    const computeDayNutriTotals = () => {
        let cal = 0, p = 0, c = 0, f = 0;
        for (const meal of dayNutritionState.meals)
            for (const food of meal.foods) { const v = computeFood(food); cal += v.cal; p += v.p; c += v.c; f += v.f; }
        return { cal: Math.round(cal), p: Math.round(p*10)/10, c: Math.round(c*10)/10, f: Math.round(f*10)/10 };
    };

    const updateNutriProgress = () => {
        const el = document.getElementById('nutri-daily-progress');
        if (!el) return;
        const totals = computeDayNutriTotals();
        const tCal = parseInt(document.getElementById('nutri-target-cal')?.value) || 2200;
        const tP   = parseInt(document.getElementById('nutri-target-p')?.value)   || 160;
        const tC   = parseInt(document.getElementById('nutri-target-c')?.value)   || 220;
        const tF   = parseInt(document.getElementById('nutri-target-f')?.value)   || 65;
        const pct = (v, t) => Math.min(100, t > 0 ? Math.round(v / t * 100) : 0);
        el.innerHTML = `
            <div class="flex items-center gap-2 text-xs">
                <span class="text-[#FFDB89]/50 w-16 shrink-0">Calorías</span>
                <div class="flex-grow bg-[#FFDB89]/10 rounded-full h-1.5"><div class="bg-[#FFDB89] h-1.5 rounded-full transition-all" style="width:${pct(totals.cal,tCal)}%"></div></div>
                <span class="text-[#FFDB89] font-bold w-24 text-right text-[11px]">${totals.cal} / ${tCal} cal</span>
            </div>
            <div class="flex items-center gap-2 text-xs">
                <span class="text-red-400/50 w-16 shrink-0">Proteína</span>
                <div class="flex-grow bg-red-500/10 rounded-full h-1.5"><div class="bg-red-400 h-1.5 rounded-full transition-all" style="width:${pct(totals.p,tP)}%"></div></div>
                <span class="text-red-400 font-bold w-24 text-right text-[11px]">${totals.p}g / ${tP}g</span>
            </div>
            <div class="flex items-center gap-2 text-xs">
                <span class="text-yellow-400/50 w-16 shrink-0">Carbos</span>
                <div class="flex-grow bg-yellow-500/10 rounded-full h-1.5"><div class="bg-yellow-400 h-1.5 rounded-full transition-all" style="width:${pct(totals.c,tC)}%"></div></div>
                <span class="text-yellow-400 font-bold w-24 text-right text-[11px]">${totals.c}g / ${tC}g</span>
            </div>
            <div class="flex items-center gap-2 text-xs">
                <span class="text-[#FFDB89]/50 w-16 shrink-0">Grasa</span>
                <div class="flex-grow bg-[#FFDB89]/10 rounded-full h-1.5"><div class="bg-[#FFDB89] h-1.5 rounded-full transition-all" style="width:${pct(totals.f,tF)}%"></div></div>
                <span class="text-[#FFDB89] font-bold w-24 text-right text-[11px]">${totals.f}g / ${tF}g</span>
            </div>`;
    };

    const renderNutriMeals = () => {
        const body = document.getElementById('nutri-meals-body');
        if (!body) return;
        if (!dayNutritionState.meals.length) {
            body.innerHTML = `<div class="text-center text-[#FFDB89]/20 py-12 text-sm">Sin comidas — añade una con el botón de abajo</div>`;
            updateNutriProgress();
            return;
        }
        body.innerHTML = dayNutritionState.meals.map((meal) => {
            const mT = meal.foods.reduce((a, fd) => { const v = computeFood(fd); return { cal: a.cal+v.cal, p: a.p+v.p, c: a.c+v.c, f: a.f+v.f }; }, { cal:0,p:0,c:0,f:0 });
            const foodRows = meal.foods.map((food, fi) => {
                const v = computeFood(food);
                return `<div class="grid items-center gap-1 text-xs" style="grid-template-columns:1fr 56px 52px 46px 46px 46px 26px">
                    <input type="text" value="${escNutri(food.name)}" placeholder="Alimento..."
                        class="p-1.5 bg-[#FFDB89]/5 border border-[#FFDB89]/12 rounded text-[#FFDB89]/80 placeholder:text-[#FFDB89]/20 outline-none focus:border-[#FFDB89]/35 transition"
                        onchange="window._nFC('${meal.id}',${fi},'name',this.value)">
                    <input type="number" value="${food.qty}" min="1" title="Cantidad (g)"
                        class="p-1.5 bg-[#FFDB89]/5 border border-[#FFDB89]/12 rounded text-[#FFDB89]/60 text-center outline-none focus:border-[#FFDB89]/35 transition"
                        onchange="window._nFC('${meal.id}',${fi},'qty',+this.value)">
                    <input type="number" value="${v.cal}" min="0" title="Calorías"
                        class="p-1.5 bg-[#FFDB89]/5 border border-[#FFDB89]/12 rounded text-[#FFDB89] font-bold text-center outline-none focus:border-[#FFDB89]/50 transition"
                        onchange="window._nFC('${meal.id}',${fi},'cal',+this.value)">
                    <input type="number" value="${v.p}" min="0" title="Proteína (g)"
                        class="p-1.5 bg-red-500/5 border border-red-400/12 rounded text-red-400 font-bold text-center outline-none focus:border-red-400/40 transition"
                        onchange="window._nFC('${meal.id}',${fi},'p',+this.value)">
                    <input type="number" value="${v.c}" min="0" title="Carbos (g)"
                        class="p-1.5 bg-yellow-500/5 border border-yellow-400/12 rounded text-yellow-400 font-bold text-center outline-none focus:border-yellow-400/40 transition"
                        onchange="window._nFC('${meal.id}',${fi},'c',+this.value)">
                    <input type="number" value="${v.f}" min="0" title="Grasa (g)"
                        class="p-1.5 bg-blue-500/5 border border-blue-400/12 rounded text-blue-400 font-bold text-center outline-none focus:border-blue-400/40 transition"
                        onchange="window._nFC('${meal.id}',${fi},'f',+this.value)">
                    <button class="w-6 h-6 rounded bg-red-500/10 text-red-400/40 hover:text-red-400 hover:bg-red-500/20 flex items-center justify-center transition"
                        onclick="window._nRF('${meal.id}',${fi})"><i class="fas fa-times text-[9px]"></i></button>
                </div>`;
            }).join('');
            return `<div class="bg-[#111113] border border-[#FFDB89]/10 rounded-xl overflow-hidden">
                <div class="flex items-center gap-2 px-4 py-2.5 border-b border-[#FFDB89]/10 bg-[#FFDB89]/3">
                    <input type="text" value="${escNutri(meal.name)}"
                        class="flex-grow bg-transparent text-[#FFDB89] font-bold text-sm outline-none"
                        onchange="window._nMN('${meal.id}',this.value)">
                    <button class="w-7 h-7 rounded-lg bg-red-500/10 text-red-400/40 hover:text-red-400 hover:bg-red-500/20 flex items-center justify-center transition shrink-0"
                        onclick="window._nRM('${meal.id}')"><i class="fas fa-trash text-[10px]"></i></button>
                </div>
                <div class="grid px-4 pt-2 pb-0.5 text-[9px] font-bold text-[#FFDB89]/25 uppercase tracking-wider" style="grid-template-columns:1fr 56px 52px 46px 46px 46px 26px">
                    <span>Alimento</span><span class="text-center">g</span><span class="text-center">Cal</span><span class="text-center">P</span><span class="text-center">C</span><span class="text-center">G</span><span></span>
                </div>
                <div class="px-4 pb-2 space-y-1">
                    ${foodRows || '<div class="text-[11px] text-[#FFDB89]/20 py-2 text-center italic">Sin alimentos aún</div>'}
                </div>
                ${meal.foods.length > 0 ? `<div class="grid px-4 py-2 border-t border-[#FFDB89]/8 text-xs font-bold" style="grid-template-columns:1fr 56px 52px 46px 46px 46px 26px">
                    <span class="text-[#FFDB89]/30">Subtotal</span><span></span>
                    <span class="text-[#FFDB89] text-center">${Math.round(mT.cal)}</span>
                    <span class="text-red-400 text-center">${Math.round(mT.p*10)/10}</span>
                    <span class="text-yellow-400 text-center">${Math.round(mT.c*10)/10}</span>
                    <span class="text-blue-400 text-center">${Math.round(mT.f*10)/10}</span>
                    <span></span></div>` : ''}
                <div class="px-4 py-2 border-t border-[#FFDB89]/8">
                    <div class="flex items-center gap-2">
                        <i class="fas fa-search text-[#FFDB89]/20 text-xs shrink-0"></i>
                        <input type="text" placeholder="Buscar alimento online..."
                            class="nutri-search-input flex-grow p-1.5 bg-transparent text-[#FFDB89]/60 placeholder:text-[#FFDB89]/20 text-xs outline-none"
                            data-meal-id="${meal.id}"
                            oninput="window._nSrch(this,'${meal.id}')">
                        <button class="px-2.5 py-1 bg-[#FFDB89]/8 border border-[#FFDB89]/15 text-[#FFDB89]/50 hover:text-[#FFDB89] hover:bg-[#FFDB89]/15 rounded text-xs font-bold transition shrink-0"
                            onclick="window._nAM('${meal.id}')">+ Manual</button>
                    </div>
                    <div class="nutri-drop-${meal.id} hidden relative">
                        <div class="absolute top-1 left-0 right-0 z-50 bg-[#0a0a0b] border border-[#FFDB89]/20 rounded-xl shadow-2xl overflow-hidden max-h-52 overflow-y-auto"></div>
                    </div>
                </div>
            </div>`;
        }).join('');
        updateNutriProgress();
    };

    const openDayNutrition = (dayNum, weekIndex) => {
        const prog = currentProgramId ? programsCache.find(p => (p._id == currentProgramId) || (p.id == currentProgramId)) : null;
        const existing = prog?.weeks?.[weekIndex]?.days?.[String(dayNum)]?.nutrition;
        dayNutritionState = {
            weekIndex,
            dayNum,
            targets: existing?.targets || { cal: 2200, p: 160, c: 220, f: 65 },
            meals: existing?.meals?.length ? existing.meals : [{ id: 'meal_' + Date.now(), name: 'Comida 1', foods: [] }]
        };
        const dayNames = ['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo'];
        document.getElementById('nutri-modal-title').textContent = `${dayNames[(dayNum-1) % 7]} — Semana ${weekIndex + 1}`;
        document.getElementById('nutri-target-cal').value = dayNutritionState.targets.cal;
        document.getElementById('nutri-target-p').value   = dayNutritionState.targets.p;
        document.getElementById('nutri-target-c').value   = dayNutritionState.targets.c;
        document.getElementById('nutri-target-f').value   = dayNutritionState.targets.f;
        ['nutri-target-cal','nutri-target-p','nutri-target-c','nutri-target-f'].forEach(id => {
            const el = document.getElementById(id);
            if (el) { el.oninput = updateNutriProgress; }
        });
        renderNutriMeals();
        document.getElementById('day-nutrition-modal').classList.remove('hidden');
    };

    const addNutriMeal = () => {
        dayNutritionState.meals.push({ id: 'meal_' + Date.now(), name: `Comida ${dayNutritionState.meals.length + 1}`, foods: [] });
        renderNutriMeals();
    };

    const saveDayNutrition = async () => {
        const prog = programsCache.find(p => (p._id == currentProgramId) || (p.id == currentProgramId));
        if (!prog) return;
        const { weekIndex, dayNum } = dayNutritionState;
        if (!prog.weeks[weekIndex]) prog.weeks[weekIndex] = { weekNumber: weekIndex + 1, days: {} };
        if (!prog.weeks[weekIndex].days) prog.weeks[weekIndex].days = {};
        if (!prog.weeks[weekIndex].days[String(dayNum)]) prog.weeks[weekIndex].days[String(dayNum)] = { name: `Día ${dayNum}`, exercises: [], isRest: false };
        prog.weeks[weekIndex].days[String(dayNum)].nutrition = {
            targets: {
                cal: parseInt(document.getElementById('nutri-target-cal').value) || 2200,
                p:   parseInt(document.getElementById('nutri-target-p').value)   || 160,
                c:   parseInt(document.getElementById('nutri-target-c').value)   || 220,
                f:   parseInt(document.getElementById('nutri-target-f').value)   || 65,
            },
            meals: dayNutritionState.meals
        };
        try {
            const res = await apiFetch(`/api/programs/${prog._id || prog.id}`, { method: 'PUT', body: JSON.stringify(prog) });
            if (res.ok) {
                const updated = await res.json();
                const idx = programsCache.findIndex(p => (p._id == currentProgramId) || (p.id == currentProgramId));
                if (idx > -1) programsCache[idx] = updated;
                document.getElementById('day-nutrition-modal').classList.add('hidden');
                renderProgramBuilder(updated);
            } else { showToast('Error guardando el plan de nutrición.', 'error'); }
        } catch(e) { console.error(e); showToast('Error de conexión.', 'error'); }
    };

    // Window-scoped helpers for inline handlers
    window._nFC = (mealId, fi, field, value) => {
        const meal = dayNutritionState.meals.find(m => m.id === mealId);
        if (!meal || !meal.foods[fi]) return;
        const food = meal.foods[fi];
        if (field === 'name') { food.name = value; }
        else if (field === 'qty') {
            food.qty = Math.max(1, value);
        } else if (field === 'cal') { food.cal100 = food.qty > 0 ? (value / food.qty) * 100 : value; }
        else if (field === 'p') { food.p100 = food.qty > 0 ? (value / food.qty) * 100 : value; }
        else if (field === 'c') { food.c100 = food.qty > 0 ? (value / food.qty) * 100 : value; }
        else if (field === 'f') { food.f100 = food.qty > 0 ? (value / food.qty) * 100 : value; }
        updateNutriProgress();
    };
    window._nRF = (mealId, fi) => {
        const meal = dayNutritionState.meals.find(m => m.id === mealId);
        if (meal) { meal.foods.splice(fi, 1); renderNutriMeals(); }
    };
    window._nMN = (mealId, value) => { const meal = dayNutritionState.meals.find(m => m.id === mealId); if (meal) meal.name = value; };
    window._nRM = (mealId) => { dayNutritionState.meals = dayNutritionState.meals.filter(m => m.id !== mealId); renderNutriMeals(); };
    window._nAM = (mealId) => {
        const meal = dayNutritionState.meals.find(m => m.id === mealId);
        if (!meal) return;
        meal.foods.push({ id: 'food_' + Date.now(), name: '', qty: 100, cal100: 0, p100: 0, c100: 0, f100: 0 });
        renderNutriMeals();
    };

    let _nSearchTimer = null;
    window._nSrch = async (input, mealId) => {
        const q = input.value.trim();
        const dropWrap = document.querySelector(`.nutri-drop-${mealId}`);
        if (!dropWrap) return;
        const drop = dropWrap.querySelector('div');
        if (!drop) return;
        if (q.length < 2) { dropWrap.classList.add('hidden'); return; }
        clearTimeout(_nSearchTimer);
        _nSearchTimer = setTimeout(async () => {
            drop.innerHTML = '<div class="p-3 text-[11px] text-[#FFDB89]/30 text-center animate-pulse">Buscando...</div>';
            dropWrap.classList.remove('hidden');
            try {
                const res = await apiFetch(`/api/food-search?q=${encodeURIComponent(q)}`);
                const foods = await res.json();
                if (!foods.length) { drop.innerHTML = '<div class="p-3 text-[11px] text-[#FFDB89]/25 text-center">Sin resultados. Usa "+ Manual".</div>'; return; }

                // ── Show results list ──
                const showDropResults = () => {
                    drop.innerHTML = foods.map((f, i) => `
                        <div class="px-3 py-2 cursor-pointer hover:bg-[#FFDB89]/8 border-b border-[#FFDB89]/5 last:border-0 transition nutri-result" data-idx="${i}">
                            <div class="text-[#FFDB89]/80 text-xs font-semibold truncate">${escNutri(f.name)}</div>
                            <div class="text-[10px] mt-0.5 text-[#FFDB89]/40">
                                ${f.cal100} kcal · P:${f.p100}g · C:${f.c100}g · G:${f.f100}g <span class="text-[#FFDB89]/20">/100g</span>
                            </div>
                        </div>`).join('');
                    drop.querySelectorAll('.nutri-result').forEach(el => {
                        el.addEventListener('click', () => showDropQtyPicker(foods[parseInt(el.dataset.idx)]));
                    });
                };

                // ── Quantity picker inside the dropdown ──
                const showDropQtyPicker = (f) => {
                    const unitG = parseFloat(f.serving) || 100;
                    drop.innerHTML = `
                        <div class="p-3 space-y-2.5">
                            <div class="flex items-center gap-2">
                                <button id="drop-back-${mealId}" class="text-[#FFDB89]/40 hover:text-[#FFDB89] transition text-xs shrink-0">
                                    <i class="fas fa-chevron-left"></i>
                                </button>
                                <p class="text-xs font-bold text-white truncate">${escNutri(f.name)}</p>
                            </div>
                            <div class="flex gap-2">
                                <input type="number" id="drop-qty-${mealId}" value="1" min="1" step="1"
                                    class="w-16 p-1.5 bg-white/10 border border-[#FFDB89]/30 rounded-lg text-white text-center font-black text-sm outline-none focus:ring-1 focus:ring-[#FFDB89]">
                                <select id="drop-unit-${mealId}"
                                    class="flex-1 p-1.5 bg-white/10 border border-[#FFDB89]/30 rounded-lg text-white text-xs outline-none focus:ring-1 focus:ring-[#FFDB89] cursor-pointer">
                                    <option value="${unitG}">porción (${unitG}g c/u)</option>
                                    <option value="1">gramos (g)</option>
                                    <option value="28.35">onzas (oz)</option>
                                    <option value="15">cucharada (~15g)</option>
                                    <option value="5">cucharadita (~5g)</option>
                                    <option value="240">taza (~240g)</option>
                                </select>
                            </div>
                            <div id="drop-preview-${mealId}" class="grid grid-cols-4 gap-1 text-center text-[10px]"></div>
                            <button id="drop-add-${mealId}" class="w-full py-1.5 bg-[#FFDB89] hover:bg-[#ffe9a8] text-[#030303] rounded-lg text-xs font-black transition">
                                + Añadir
                            </button>
                        </div>`;

                    const qtyEl  = document.getElementById(`drop-qty-${mealId}`);
                    const unitEl = document.getElementById(`drop-unit-${mealId}`);
                    const prevEl = document.getElementById(`drop-preview-${mealId}`);

                    const updatePrev = () => {
                        const qty   = Math.max(1, Math.round(parseFloat(qtyEl.value) || 1));
                        qtyEl.value = qty;
                        const gPerU = parseFloat(unitEl.value) || unitG;
                        const totalG = qty * gPerU;
                        const s = totalG / 100;
                        const cal  = Math.round(f.cal100 * s);
                        const pro  = Math.round(f.p100   * s);
                        const carb = Math.round(f.c100   * s);
                        const fat  = Math.round(f.f100   * s);
                        prevEl.innerHTML = `
                            <div class="bg-[#FFDB89]/8 rounded p-1"><p class="text-[#FFDB89]/50">Cal</p><p class="text-[#FFDB89] font-black">${cal}</p></div>
                            <div class="bg-red-400/8 rounded p-1"><p class="text-red-400/50">P</p><p class="text-red-400 font-black">${pro}g</p></div>
                            <div class="bg-yellow-400/8 rounded p-1"><p class="text-yellow-400/50">C</p><p class="text-yellow-400 font-black">${carb}g</p></div>
                            <div class="bg-orange-400/8 rounded p-1"><p class="text-orange-400/50">G</p><p class="text-orange-400 font-black">${fat}g</p></div>`;
                        return totalG;
                    };

                    qtyEl.addEventListener('input', updatePrev);
                    unitEl.addEventListener('change', updatePrev);
                    updatePrev();

                    document.getElementById(`drop-back-${mealId}`)?.addEventListener('click', showDropResults);
                    document.getElementById(`drop-add-${mealId}`)?.addEventListener('click', () => {
                        const totalG = updatePrev();
                        const meal = dayNutritionState.meals.find(m => m.id === mealId);
                        if (!meal) return;
                        const qty = parseFloat(qtyEl.value) || 1;
                        const gPerU = parseFloat(unitEl.value) || unitG;
                        const label = unitEl.options[unitEl.selectedIndex].text;
                        const displayName = qty === 1
                            ? f.name
                            : `${qty % 1 === 0 ? qty : qty}x ${f.name}`;
                        meal.foods.push({
                            id:    'food_' + Date.now(),
                            name:  displayName,
                            qty:   Math.round(totalG * 10) / 10,
                            cal100: parseFloat(f.cal100),
                            p100:   parseFloat(f.p100),
                            c100:   parseFloat(f.c100),
                            f100:   parseFloat(f.f100)
                        });
                        input.value = '';
                        dropWrap.classList.add('hidden');
                        renderNutriMeals();
                    });
                };

                showDropResults();
            } catch(e) { drop.innerHTML = '<div class="p-3 text-[11px] text-red-400/50 text-center">Error de búsqueda</div>'; }
        }, 450);
    };

    // --- Sets a program day as a rest day and saves to DB ---
    const setRestDay = async (weekIndex, dayNum) => {
        const prog = programsCache.find(p => (p._id == currentProgramId) || (p.id == currentProgramId));
        if (!prog) return;
        if (!prog.weeks[weekIndex]) prog.weeks[weekIndex] = { weekNumber: weekIndex + 1, days: {} };
        if (!prog.weeks[weekIndex].days) prog.weeks[weekIndex].days = {};
        const existing = prog.weeks[weekIndex].days[String(dayNum)] || {};
        prog.weeks[weekIndex].days[String(dayNum)] = { ...existing, name: 'Descanso', isRest: true, exercises: [] };
        try {
            const res = await apiFetch(`/api/programs/${prog._id || prog.id}`, { method: 'PUT', body: JSON.stringify(prog) });
            if (res.ok) {
                const updated = await res.json();
                const idx = programsCache.findIndex(p => (p._id == currentProgramId) || (p.id == currentProgramId));
                if (idx > -1) programsCache[idx] = updated;
                renderProgramBuilder(updated);
            } else { showToast('Error guardando día de descanso.', 'error'); }
        } catch (e) { showToast('Error de conexión.', 'error'); }
    };

    // --- Sets a program day as an active rest day and saves to DB ---
    const setActiveRestDay = async (weekIndex, dayNum) => {
        const prog = programsCache.find(p => (p._id == currentProgramId) || (p.id == currentProgramId));
        if (!prog) return;
        if (!prog.weeks[weekIndex]) prog.weeks[weekIndex] = { weekNumber: weekIndex + 1, days: {} };
        if (!prog.weeks[weekIndex].days) prog.weeks[weekIndex].days = {};
        const existing = prog.weeks[weekIndex].days[String(dayNum)] || {};
        prog.weeks[weekIndex].days[String(dayNum)] = { ...existing, name: 'Descanso Activo', isRest: true, isActiveRest: true, exercises: [] };
        try {
            const res = await apiFetch(`/api/programs/${prog._id || prog.id}`, { method: 'PUT', body: JSON.stringify(prog) });
            if (res.ok) {
                const updated = await res.json();
                const idx = programsCache.findIndex(p => (p._id == currentProgramId) || (p.id == currentProgramId));
                if (idx > -1) programsCache[idx] = updated;
                renderProgramBuilder(updated);
            } else { showToast('Error guardando día de descanso activo.', 'error'); }
        } catch (e) { showToast('Error de conexión.', 'error'); }
    };

    // --- Pushes all program days to a client's calendar starting from startDateStr ---
    const pushProgramToCalendar = async (prog, clientId, startDateStr) => {
        const startDate = new Date(startDateStr + 'T00:00:00');
        let current = new Date(startDate);
        let created = 0, skipped = 0;

        for (let wIdx = 0; wIdx < prog.weeks.length; wIdx++) {
            const week = prog.weeks[wIdx];
            for (let dayNum = 1; dayNum <= 7; dayNum++) {
                // Mongoose Maps serialize with string keys
                const dayData = week.days?.[String(dayNum)] ?? week.days?.[dayNum];
                const dateStr = current.toISOString().split('T')[0];

                if (dayData) {
                    try {
                        if (dayData.isRest || dayData.isActiveRest) {
                            // Push rest / active rest day
                            const restTitle = dayData.isActiveRest ? 'Descanso Activo' : 'Descanso';
                            const restType  = dayData.isActiveRest ? 'active_rest' : 'rest';
                            const res = await apiFetch('/api/client-workouts', {
                                method: 'POST',
                                body: JSON.stringify({
                                    clientId, date: dateStr,
                                    title: dayData.name || restTitle,
                                    isRest: true, restType,
                                    exercises: []
                                })
                            });
                            if (res.ok) created++; else skipped++;
                        } else if (dayData.exercises?.length > 0) {
                            // Push training day
                            const res = await apiFetch('/api/client-workouts', {
                                method: 'POST',
                                body: JSON.stringify({
                                    clientId, date: dateStr,
                                    title: dayData.name || `Semana ${wIdx + 1} — Día ${dayNum}`,
                                    warmup:        dayData.warmup        || '',
                                    warmupVideoUrl: dayData.warmupVideo  || '',
                                    warmupItems:   (dayData.warmupItems  || []).map(i => ({ id: i.id, name: i.name || '', videoUrl: i.videoUrl || '' })),
                                    cooldown:      dayData.cooldown      || '',
                                    cooldownVideoUrl: dayData.cooldownVideo || '',
                                    cooldownItems: (dayData.cooldownItems|| []).map(i => ({ id: i.id, name: i.name || '', videoUrl: i.videoUrl || '' })),
                                    exercises: dayData.exercises.map((ex, idx) => ({
                                        id:           Date.now() + idx,
                                        name:         ex.name,
                                        instructions: ex.stats || ex.instructions || '',
                                        videoUrl:     ex.video || ex.videoUrl || '',
                                        isSuperset:   ex.isSuperset   || false,
                                        supersetHead: ex.supersetHead || false
                                    }))
                                })
                            });
                            if (res.ok) created++; else skipped++;

                            // Push nutrition targets if set for this day
                            const nutr = dayData.nutrition;
                            if (nutr && (nutr.targets?.cal || nutr.targets?.p || nutr.targets?.c || nutr.targets?.f)) {
                                try {
                                    await apiFetch('/api/nutrition-logs', {
                                        method: 'POST',
                                        body: JSON.stringify({
                                            clientId, date: dateStr,
                                            calories: nutr.targets?.cal || 0,
                                            protein:  nutr.targets?.p  || 0,
                                            carbs:    nutr.targets?.c  || 0,
                                            fat:      nutr.targets?.f  || 0,
                                            meals:    nutr.meals || []
                                        })
                                    });
                                } catch { /* nutrition push failure is non-critical */ }
                            }
                        }
                    } catch { skipped++; }
                }

                // Every day (training, rest or unset) advances the calendar slot
                current.setDate(current.getDate() + 1);
            }
        }
        return { created, skipped };
    };

    // --- Opens modal to assign the current program to a client ---
    const openAssignProgramModal = () => {
        const prog = programsCache.find(p => (p._id == currentProgramId) || (p.id == currentProgramId));
        if (!prog) return;

        const clients = clientsCache.filter(c => !c.isDeleted && c.isActive);
        const todayStr = new Date().toISOString().split('T')[0];

        let existing = document.getElementById('assign-to-client-modal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'assign-to-client-modal';
        modal.className = 'fixed inset-0 bg-black/80 z-[70] flex items-center justify-center p-4 backdrop-blur-sm';
        modal.innerHTML = `
            <div class="bg-[#030303] border border-[#FFDB89]/20 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
                <div class="px-6 py-4 border-b border-[#FFDB89]/15 bg-[#FFDB89]/5 flex justify-between items-center">
                    <div>
                        <h3 class="text-lg font-bold text-[#FFDB89]">Asignar programa</h3>
                        <p class="text-xs text-[#FFDB89]/50 mt-0.5">Asignando <strong class="text-[#FFDB89]/80">${prog.name}</strong> — ${prog.weeks.length} ${prog.weeks.length === 1 ? 'semana' : 'semanas'}</p>
                    </div>
                    <button id="close-assign-modal" class="text-[#FFDB89]/40 hover:text-[#FFDB89] transition"><i class="fas fa-times"></i></button>
                </div>

                <div class="px-4 pt-4 pb-2 border-b border-[#FFDB89]/10">
                    <label class="block text-xs font-bold text-[#FFDB89]/50 uppercase tracking-wider mb-1.5">Fecha de inicio</label>
                    <input type="date" id="assign-start-date" value="${todayStr}"
                        class="w-full px-3 py-2 bg-[#FFDB89]/5 border border-[#FFDB89]/20 rounded-lg text-sm text-[#FFDB89] outline-none focus:border-[#FFDB89]/50 mb-3">
                    <input type="text" id="assign-client-search" placeholder="Buscar cliente..." class="w-full px-3 py-2 bg-[#FFDB89]/5 border border-[#FFDB89]/20 rounded-lg text-sm text-[#FFDB89] placeholder:text-[#FFDB89]/30 outline-none focus:border-[#FFDB89]/50">
                </div>

                <div id="assign-client-list" class="max-h-64 overflow-y-auto divide-y divide-[#FFDB89]/10">
                    ${clients.length === 0
                        ? `<p class="text-center text-[#FFDB89]/30 py-8 text-sm">No hay clientes activos.</p>`
                        : clients.map(c => `
                            <button class="assign-client-row w-full flex items-center gap-3 px-4 py-3 hover:bg-[#FFDB89]/5 transition text-left" data-client-id="${c._id}">
                                <div class="w-8 h-8 rounded-full bg-[#FFDB89]/10 border border-[#FFDB89]/20 flex items-center justify-center text-[#FFDB89]/60 text-xs font-bold shrink-0">${(c.name||'?')[0].toUpperCase()}</div>
                                <div class="min-w-0">
                                    <div class="text-sm font-bold text-[#FFDB89] truncate">${c.name} ${c.lastName || ''}</div>
                                    <div class="text-xs text-[#FFDB89]/40 truncate">${c.program && c.program !== 'Sin asignar' ? `📋 ${c.program}` : 'Sin programa'}</div>
                                </div>
                                <i class="fas fa-chevron-right text-[#FFDB89]/20 ml-auto shrink-0 text-xs"></i>
                            </button>`).join('')}
                </div>

                <div id="assign-progress" class="hidden px-6 py-4 text-center">
                    <i class="fas fa-spinner fa-spin text-[#FFDB89] text-xl mb-2 block"></i>
                    <p class="text-sm text-[#FFDB89]/70">Cargando rutinas al calendario...</p>
                </div>
            </div>`;
        document.body.appendChild(modal);

        // Search filter
        document.getElementById('assign-client-search').addEventListener('input', (e) => {
            const q = e.target.value.toLowerCase();
            document.querySelectorAll('.assign-client-row').forEach(row => {
                const name = row.querySelector('.text-sm').textContent.toLowerCase();
                row.style.display = name.includes(q) ? '' : 'none';
            });
        });

        // Close
        document.getElementById('close-assign-modal').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

        // Assign on click
        document.getElementById('assign-client-list').addEventListener('click', async (e) => {
            const row = e.target.closest('.assign-client-row');
            if (!row) return;
            const clientId = row.dataset.clientId;
            const client = clientsCache.find(c => c._id === clientId);
            if (!client) return;
            const startDateStr = document.getElementById('assign-start-date')?.value || todayStr;

            // Show progress state
            document.getElementById('assign-client-list').classList.add('hidden');
            document.getElementById('assign-progress').classList.remove('hidden');
            document.getElementById('close-assign-modal').disabled = true;

            try {
                // 1. Link program name to client record
                const res = await apiFetch(`/api/clients/${clientId}`, {
                    method: 'PUT',
                    body: JSON.stringify({ program: prog.name })
                });
                if (!res.ok) { showToast('Error asignando programa.', 'error'); modal.remove(); return; }
                client.program = prog.name;

                // 2. Push every training day to the client calendar
                const { created, skipped } = await pushProgramToCalendar(prog, clientId, startDateStr);

                // 3. Update count badge in builder header
                const assigned = clientsCache.filter(c => c.program === prog.name && !c.isDeleted).length;
                const countEl = document.getElementById('builder-client-count');
                if (countEl) countEl.textContent = `${assigned} ${assigned === 1 ? 'Cliente' : 'Clientes'}`;

                modal.remove();

                const skipNote = skipped > 0 ? ` (${skipped} día${skipped > 1 ? 's' : ''} ya tenían rutina y no fueron sobreescritos)` : '';
                showToast(`✓ ${prog.name} asignado a ${client.name}. ${created} día${created !== 1 ? 's' : ''} cargado${created !== 1 ? 's' : ''} al calendario desde el ${startDateStr}.${skipNote}`, 'success');

            } catch(err) { showToast('Error de conexión.', 'error'); modal.remove(); }
        });
    };

    const saveRoutine = async () => {
        const name = document.getElementById('routine-name-input').value;
        const exercises = [];
        document.querySelectorAll('.exercise-item').forEach(item => {
            const nameInput = item.querySelector('.exercise-name-input');
            const statsInput = item.querySelector('.exercise-stats-input');
            const videoBtn = item.querySelector('.open-video-modal');
            exercises.push({ name: nameInput.value, stats: statsInput.value, video: videoBtn?.dataset?.video || "" });
        });

        if(currentProgramId) {
            const prog = programsCache.find(p => (p.id == currentProgramId) || (p._id == currentProgramId));
            if(prog) {
                if (!prog.weeks[currentEditingWeekIndex]) {
                    prog.weeks[currentEditingWeekIndex] = { weekNumber: currentEditingWeekIndex + 1, days: {} };
                }
                if (!prog.weeks[currentEditingWeekIndex].days) {
                    prog.weeks[currentEditingWeekIndex].days = {};
                }

                // Preserve any existing fields (e.g. nutrition) — only overwrite routine fields
                const existing = prog.weeks[currentEditingWeekIndex].days[currentEditingDay] || {};
                const dayData = {
                    ...existing,
                    name:          name,
                    exercises:     exercises,
                    warmup:        document.getElementById('routine-warmup').value.trim(),
                    cooldown:      document.getElementById('routine-cooldown').value.trim(),
                    warmupVideo:   routineWarmupVideo,
                    cooldownVideo: routineCooldownVideo,
                    warmupItems:   routineWarmupItems.map(i => ({ id: i.id, name: i.name || '', videoUrl: i.videoUrl || '' })),
                    cooldownItems: routineCooldownItems.map(i => ({ id: i.id, name: i.name || '', videoUrl: i.videoUrl || '' })),
                    isRest:        false
                };

                prog.weeks[currentEditingWeekIndex].days[currentEditingDay] = dayData;

                // SAVE TO DATABASE
                try {
                    const res = await apiFetch(`/api/programs/${prog._id || prog.id}`, {
                        method: 'PUT',
                        body: JSON.stringify(prog)
                    });

                    if(res.ok) {
                        // Sync the local cache with the server response so
                        // subsequent opens always reflect the latest saved data
                        const updated = await res.json();
                        const idx = programsCache.findIndex(p => (p._id == currentProgramId) || (p.id == currentProgramId));
                        if (idx > -1) programsCache[idx] = updated;
                    } else {
                        showToast('Error al guardar la rutina.', 'error');
                    }
                } catch(e) {
                    showToast('Error al guardar la rutina.', 'error');
                    console.error("Database save error:", e);
                }
            }
        }

        document.getElementById('edit-routine-modal').classList.add('hidden');
        if(currentClientViewId) openClientProfile(currentClientViewId);
        // Re-render program builder if we're in program view
        if(currentProgramId && document.getElementById('program-builder-view') && !document.getElementById('program-builder-view').classList.contains('hidden')) {
            const prog = programsCache.find(p => (p.id == currentProgramId) || (p._id == currentProgramId));
            if(prog) renderProgramBuilder(prog);
        }
    };

    // ── Payments: in-memory store ─────────────────────────────────────────────
    let paymentsDb = [];

    // ── Render the payments table from paymentsDb ─────────────────────────────
    const renderPaymentsTable = () => {
        const tbody = document.getElementById('payments-table-body');
        if (!tbody) return;

        const searchVal    = (document.getElementById('pagos-search')?.value || '').toLowerCase();
        const statusFilter = document.getElementById('pagos-status-filter')?.value || 'all';
        const today        = new Date().toISOString().split('T')[0];

        // Auto-elevate pending → overdue based on today
        const enriched = paymentsDb.map(p => ({
            ...p,
            _status: p.status === 'pending' && p.dueDate < today ? 'overdue' : p.status
        }));

        // Update summary cards
        const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        set('count-paid',    enriched.filter(p => p._status === 'paid').length);
        set('count-pending', enriched.filter(p => p._status === 'pending').length);
        set('count-overdue', enriched.filter(p => p._status === 'overdue').length);

        // Filter
        let list = enriched;
        if (searchVal)         list = list.filter(p => (p.clientName + p.periodLabel).toLowerCase().includes(searchVal));
        if (statusFilter !== 'all') list = list.filter(p => p._status === statusFilter);

        if (list.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" class="py-12 text-center text-[#FFDB89]/30 text-sm">
                ${paymentsDb.length === 0 ? 'No hay facturas aún. Crea una con el botón <strong>Nueva factura</strong>.' : 'Sin resultados para ese filtro.'}
            </td></tr>`;
            return;
        }

        const statusBadge = s => {
            if (s === 'paid')    return `<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-green-500/15 text-green-400 border border-green-500/30"><i class="fas fa-check mr-1"></i>Al día</span>`;
            if (s === 'overdue') return `<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-red-500/15 text-red-400 border border-red-500/30"><i class="fas fa-exclamation-triangle mr-1"></i>Vencido</span>`;
            return `<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-yellow-500/15 text-yellow-400 border border-yellow-500/30"><i class="fas fa-clock mr-1"></i>Pendiente</span>`;
        };

        tbody.innerHTML = list.map(p => {
            const isStripe = p.type && p.type !== 'manual';
            const stripeBadge = isStripe
                ? `<span class="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-[#635BFF]/15 border border-[#635BFF]/30 text-[#7B73FF] font-bold">Stripe</span>`
                : '';
            const typeLabel = { subscription: 'Suscripción', one_time: 'Pago único', stripe_invoice: 'Factura', trial: 'Prueba' }[p.type] || '';
            const typeHint = isStripe && typeLabel ? `<span class="block text-[10px] text-[#635BFF]/70">${typeLabel}</span>` : '';

            return `
            <tr class="hover:bg-[#FFDB89]/5 transition group">
                <td class="px-4 py-3 text-sm font-bold text-[#FFDB89]">${p.clientName}${stripeBadge}</td>
                <td class="px-4 py-3 text-sm text-[#FFDB89]/70">${p.periodLabel || p.planLabel || '—'}${typeHint}</td>
                <td class="px-4 py-3 text-sm font-bold text-[#FFDB89]">$${Number(p.amount).toFixed(2)}</td>
                <td class="px-4 py-3 text-sm text-[#FFDB89]/60">${p.dueDate}</td>
                <td class="px-4 py-3 text-center">${statusBadge(p._status)}</td>
                <td class="px-4 py-3 text-right">
                    <div class="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition">
                        ${p._status !== 'paid' ? `
                        <button onclick="window.markPaymentPaid('${p._id}')"
                            class="px-2 py-1 rounded-lg bg-green-500/10 border border-green-500/30 text-green-400 hover:bg-green-500/20 text-xs font-bold transition" title="Marcar como pagado">
                            <i class="fas fa-check mr-1"></i>Pagado
                        </button>` : `
                        <button onclick="window.markPaymentPending('${p._id}')"
                            class="px-2 py-1 rounded-lg bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 hover:bg-yellow-500/20 text-xs font-bold transition" title="Revertir a pendiente">
                            <i class="fas fa-undo mr-1"></i>Revertir
                        </button>`}
                        ${isStripe && p.stripePaymentLink ? `
                        <button onclick="navigator.clipboard.writeText('${p.stripePaymentLink.replace(/'/g,"\\'")}').then(()=>showToast('Link copiado.','success'))"
                            class="px-2 py-1 rounded-lg bg-[#635BFF]/10 border border-[#635BFF]/30 text-[#7B73FF] hover:bg-[#635BFF]/20 text-xs font-bold transition" title="Copiar link de pago Stripe">
                            <i class="fas fa-link mr-1"></i>Link
                        </button>` : `
                        <button onclick="window.sendPaymentInvoice('${p._id}', '${p.clientName}')"
                            class="px-2 py-1 rounded-lg bg-[#FFDB89]/10 border border-[#FFDB89]/20 text-[#FFDB89]/70 hover:text-[#FFDB89] hover:bg-[#FFDB89]/20 text-xs font-bold transition" title="Enviar factura por email">
                            <i class="fas fa-envelope mr-1"></i>Factura
                        </button>`}
                        ${isStripe && p.stripeSubscriptionId ? `
                        <button onclick="window.cancelStripeSubscription('${p._id}')"
                            class="px-2 py-1 rounded-lg bg-orange-500/10 border border-orange-500/30 text-orange-400 hover:bg-orange-500/20 text-xs font-bold transition" title="Cancelar suscripción al final del período">
                            <i class="fas fa-ban mr-1"></i>Cancelar
                        </button>` : ''}
                        ${isStripe ? `
                        <button onclick="window.openStripePortal('${p.clientId || ''}')"
                            class="px-2 py-1 rounded-lg bg-[#635BFF]/10 border border-[#635BFF]/30 text-[#7B73FF] hover:bg-[#635BFF]/20 text-xs transition" title="Portal de facturación Stripe">
                            <i class="fab fa-stripe-s"></i>
                        </button>` : ''}
                        <button onclick="window.deletePayment('${p._id}')"
                            class="px-2 py-1 rounded-lg text-red-400/40 hover:text-red-400 hover:bg-red-500/10 text-xs transition" title="Eliminar">
                            <i class="fas fa-trash-alt"></i>
                        </button>
                    </div>
                </td>
            </tr>`;
        }).join('');
    };

    // ── Load payments from API then render ────────────────────────────────────
    const renderPaymentsView = async () => {
        const tbody = document.getElementById('payments-table-body');
        if (!tbody) return;
        try {
            const res = await apiFetch('/api/payments');
            if (!res.ok) { showToast('Error cargando facturas.', 'error'); return; }
            paymentsDb = await res.json();
            renderPaymentsTable();

            // Wire filters (once)
            const search = document.getElementById('pagos-search');
            const filter = document.getElementById('pagos-status-filter');
            if (search && !search.dataset.wired) {
                search.dataset.wired = 'true';
                search.addEventListener('input', renderPaymentsTable);
            }
            if (filter && !filter.dataset.wired) {
                filter.dataset.wired = 'true';
                filter.addEventListener('change', renderPaymentsTable);
            }

            // Wire New Invoice button + modal
            const newBtn = document.getElementById('new-invoice-btn');
            if (newBtn && !newBtn.dataset.wired) {
                newBtn.dataset.wired = 'true';
                newBtn.addEventListener('click', () => openNewInvoiceModal());
            }
            ['close-invoice-modal', 'close-invoice-modal-2'].forEach(id => {
                const btn = document.getElementById(id);
                if (btn && !btn.dataset.wired) {
                    btn.dataset.wired = 'true';
                    btn.addEventListener('click', closeNewInvoiceModal);
                }
            });
            const saveBtn = document.getElementById('save-invoice-btn');
            if (saveBtn && !saveBtn.dataset.wired) {
                saveBtn.dataset.wired = 'true';
                saveBtn.addEventListener('click', handleCreateInvoice);
            }
        } catch (e) { console.error(e); showToast('Error de conexión.', 'error'); }
    };

    // ── Invoice modal tab switching ───────────────────────────────────────────
    let _invTab = 'manual'; // current active tab
    window.switchInvoiceTab = (tab) => {
        _invTab = tab;
        const stripeFields = document.getElementById('stripe-extra-fields');
        const tabManual    = document.getElementById('inv-tab-manual');
        const tabStripe    = document.getElementById('inv-tab-stripe');
        const saveBtn      = document.getElementById('save-invoice-btn');
        const activeClass  = ['bg-[#FFDB89]', 'text-[#030303]'];
        const inactiveClass= ['text-[#FFDB89]/50', 'hover:text-[#FFDB89]'];
        if (tab === 'stripe') {
            stripeFields?.classList.remove('hidden');
            tabStripe?.classList.add(...activeClass); tabStripe?.classList.remove(...inactiveClass);
            tabManual?.classList.remove(...activeClass); tabManual?.classList.add(...inactiveClass);
            if (saveBtn) saveBtn.innerHTML = '<i class="fab fa-stripe-s mr-1"></i> Crear con Stripe';
        } else {
            stripeFields?.classList.add('hidden');
            tabManual?.classList.add(...activeClass); tabManual?.classList.remove(...inactiveClass);
            tabStripe?.classList.remove(...activeClass); tabStripe?.classList.add(...inactiveClass);
            if (saveBtn) saveBtn.innerHTML = '<i class="fas fa-check mr-1"></i> Crear Factura';
        }
        // Reset link output when switching tabs
        document.getElementById('stripe-link-output')?.classList.add('hidden');
    };

    window.onStripeTypeChange = () => {
        const type    = document.getElementById('inv-stripe-type')?.value;
        const trialRow = document.getElementById('inv-trial-days-row');
        if (trialRow) trialRow.classList.toggle('hidden', type !== 'trial');
    };

    window.copyStripeLink = () => {
        const val = document.getElementById('stripe-link-value')?.value;
        if (!val) return;
        navigator.clipboard.writeText(val).then(() => showToast('Link copiado al portapapeles.', 'success'));
    };

    // ── New Invoice modal ─────────────────────────────────────────────────────
    const openNewInvoiceModal = () => {
        const modal = document.getElementById('new-invoice-modal');
        if (!modal) return;
        // Populate client select
        const sel = document.getElementById('inv-client');
        sel.innerHTML = '<option value="">— Selecciona cliente —</option>' +
            clientsCache.map(c => `<option value="${c._id}">${c.name} ${c.lastName || ''}</option>`).join('');
        // Default due date to end of current month
        const now = new Date();
        const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
        document.getElementById('inv-due').value = lastDay;
        // Default period label
        const months = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
        document.getElementById('inv-period').value = `${months[now.getMonth()]} ${now.getFullYear()}`;
        // Reset to manual tab
        window.switchInvoiceTab('manual');
        document.getElementById('stripe-link-output')?.classList.add('hidden');
        modal.classList.remove('hidden');
        modal.classList.add('flex');
    };

    const closeNewInvoiceModal = () => {
        const modal = document.getElementById('new-invoice-modal');
        if (!modal) return;
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    };

    const handleCreateInvoice = async () => {
        const clientId    = document.getElementById('inv-client')?.value;
        const amount      = document.getElementById('inv-amount')?.value;
        const periodLabel = document.getElementById('inv-period')?.value.trim();
        const dueDate     = document.getElementById('inv-due')?.value;
        const notes       = document.getElementById('inv-notes')?.value.trim();

        if (!clientId)  { showToast('Selecciona un cliente.', 'error'); return; }
        if (!amount || Number(amount) <= 0) { showToast('Ingresa un monto válido.', 'error'); return; }
        if (!dueDate)   { showToast('La fecha límite es requerida.', 'error'); return; }

        const btn = document.getElementById('save-invoice-btn');

        // ── Stripe path ──────────────────────────────────────────────────────
        if (_invTab === 'stripe') {
            const type      = document.getElementById('inv-stripe-type')?.value || 'subscription';
            const planLabel = document.getElementById('inv-plan-label')?.value.trim();
            const trialDays = Number(document.getElementById('inv-trial-days')?.value) || 0;

            btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i> Creando con Stripe...';
            try {
                const res = await apiFetch('/api/stripe/checkout', {
                    method: 'POST',
                    body: JSON.stringify({ clientId, amount: Number(amount), periodLabel, dueDate, notes, type, planLabel, trialDays })
                });
                if (res.ok) {
                    const data = await res.json();
                    // Show the generated payment link inside the modal
                    const linkOutput = document.getElementById('stripe-link-output');
                    const linkInput  = document.getElementById('stripe-link-value');
                    if (linkOutput && linkInput) {
                        linkInput.value = data.checkoutUrl || '';
                        linkOutput.classList.remove('hidden');
                    }
                    showToast('Sesión de Stripe creada. Copia el link y envíaselo al cliente.', 'success');
                    paymentsDb.unshift({ ...data.payment, clientName: clientsCache.find(c => c._id === clientId)?.name || 'Cliente' });
                    renderPaymentsTable();
                    // Don't close the modal — let trainer copy the link
                    btn.disabled = false; btn.innerHTML = '<i class="fab fa-stripe-s mr-1"></i> Crear con Stripe';
                } else {
                    const err = await res.json();
                    showToast(err.message || 'Error con Stripe.', 'error');
                    btn.disabled = false; btn.innerHTML = '<i class="fab fa-stripe-s mr-1"></i> Crear con Stripe';
                }
            } catch (e) {
                showToast('Error de conexión con Stripe.', 'error');
                btn.disabled = false; btn.innerHTML = '<i class="fab fa-stripe-s mr-1"></i> Crear con Stripe';
            }
            return;
        }

        // ── Manual path (existing behavior) ──────────────────────────────────
        btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i> Creando...';
        try {
            const res = await apiFetch('/api/payments', {
                method: 'POST',
                body: JSON.stringify({ clientId, amount: Number(amount), periodLabel, dueDate, notes })
            });
            if (res.ok) {
                showToast('Factura creada.', 'success');
                closeNewInvoiceModal();
                document.getElementById('inv-amount').value = '';
                document.getElementById('inv-notes').value = '';
                await renderPaymentsView();
            } else {
                const err = await res.json();
                showToast(err.message || 'Error creando factura.', 'error');
            }
        } catch (e) { showToast('Error de conexión.', 'error'); }
        finally { btn.disabled = false; btn.innerHTML = '<i class="fas fa-check mr-1"></i> Crear Factura'; }
    };

    // ── Payment actions ───────────────────────────────────────────────────────
    window.markPaymentPaid = async (paymentId) => {
        try {
            const res = await apiFetch(`/api/payments/${paymentId}`, {
                method: 'PATCH', body: JSON.stringify({ status: 'paid' })
            });
            if (res.ok) {
                const updated = await res.json();
                const idx = paymentsDb.findIndex(p => p._id === paymentId);
                if (idx > -1) paymentsDb[idx] = { ...paymentsDb[idx], ...updated };
                showToast('Marcado como pagado.', 'success');
                renderPaymentsTable();
            } else { showToast('Error actualizando pago.', 'error'); }
        } catch (e) { showToast('Error de conexión.', 'error'); }
    };

    window.markPaymentPending = async (paymentId) => {
        try {
            const res = await apiFetch(`/api/payments/${paymentId}`, {
                method: 'PATCH', body: JSON.stringify({ status: 'pending' })
            });
            if (res.ok) {
                const updated = await res.json();
                const idx = paymentsDb.findIndex(p => p._id === paymentId);
                if (idx > -1) paymentsDb[idx] = { ...paymentsDb[idx], ...updated };
                showToast('Revertido a pendiente.', 'info');
                renderPaymentsTable();
            } else { showToast('Error actualizando pago.', 'error'); }
        } catch (e) { showToast('Error de conexión.', 'error'); }
    };

    window.sendPaymentInvoice = async (paymentId, clientName) => {
        const yes = await showConfirm(
            `¿Enviar la factura por email a <strong>${clientName}</strong>?`,
            { confirmLabel: 'Enviar', danger: false }
        );
        if (!yes) return;
        try {
            const res = await apiFetch(`/api/payments/${paymentId}/invoice`, { method: 'POST' });
            if (res.ok) { showToast(`Factura enviada a ${clientName}.`, 'success'); }
            else { showToast('Error enviando la factura.', 'error'); }
        } catch (e) { showToast('Error de conexión.', 'error'); }
    };

    // ── Stripe: cancel subscription ───────────────────────────────────────────
    window.cancelStripeSubscription = async (paymentId) => {
        const yes = await showConfirm(
            '¿Cancelar esta suscripción? <br><span class="text-xs text-[#FFDB89]/60">El cliente mantendrá acceso hasta el final del período de facturación actual.</span>',
            { confirmLabel: 'Cancelar suscripción', danger: true }
        );
        if (!yes) return;
        try {
            const res = await apiFetch('/api/stripe/subscription/cancel', {
                method: 'POST', body: JSON.stringify({ paymentId })
            });
            if (res.ok) { showToast('Suscripción cancelada al final del período.', 'success'); await renderPaymentsView(); }
            else { const err = await res.json(); showToast(err.message || 'Error cancelando suscripción.', 'error'); }
        } catch (e) { showToast('Error de conexión.', 'error'); }
    };

    // ── Stripe: open billing portal ───────────────────────────────────────────
    window.openStripePortal = async (clientId) => {
        if (!clientId) { showToast('ID de cliente no disponible.', 'error'); return; }
        try {
            const res = await apiFetch('/api/stripe/portal', {
                method: 'POST', body: JSON.stringify({ clientId })
            });
            if (res.ok) {
                const { portalUrl } = await res.json();
                window.open(portalUrl, '_blank');
            } else {
                const err = await res.json();
                showToast(err.message || 'Error abriendo el portal.', 'error');
            }
        } catch (e) { showToast('Error de conexión.', 'error'); }
    };

    window.deletePayment = async (paymentId) => {
        const yes = await showConfirm('¿Eliminar esta factura?', { confirmLabel: 'Eliminar', danger: true });
        if (!yes) return;
        try {
            const res = await apiFetch(`/api/payments/${paymentId}`, { method: 'DELETE' });
            if (res.ok) {
                paymentsDb = paymentsDb.filter(p => p._id !== paymentId);
                showToast('Factura eliminada.', 'success');
                renderPaymentsTable();
            } else { showToast('Error eliminando factura.', 'error'); }
        } catch (e) { showToast('Error de conexión.', 'error'); }
    };

    // HELPER: Generate Continuous Calendar Days (6 Months)
    const generateContinuousCalendar = (client) => {
        let html = '';
        const today = new Date();
        const startDate = new Date(today);
    
    // Start 3 months in the past
        startDate.setMonth(today.getMonth() - 3);
        startDate.setDate(1); 
    
    // Find the Monday of the week containing the 1st
        const dayOfWeek = startDate.getDay(); 
        const diff = startDate.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1); 
        startDate.setDate(diff);
    
    // Show 12 months total (3 past + 9 future)
        const totalDays = 52 * 7; // 52 weeks = ~1 year 
        
        const dayNames = ['DOM', 'LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB'];
        const monthNames = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

        for(let i=0; i < totalDays; i++) {
            const currentDate = new Date(startDate);
            currentDate.setDate(startDate.getDate() + i);
            const dayNum = currentDate.getDate();
            const monthName = monthNames[currentDate.getMonth()];
            const year = currentDate.getFullYear();
            const isToday = currentDate.toDateString() === new Date().toDateString();
            const isFirstOfMonth = dayNum === 1;
            const cellId = `day-${currentDate.toISOString().split('T')[0]}`;
            const dayName = dayNames[currentDate.getDay()];

            // Month divider on the 1st of each month
            if (isFirstOfMonth) {
                html += `<div class="month-divider px-5 py-2.5 bg-[#1C1C1E] border-b border-[#FFDB89]/15 sticky top-0 z-10">
                    <span class="text-xs font-bold text-[#FFDB89]/60 uppercase tracking-widest">${monthName} ${year}</span>
                </div>`;
            }

            const dayNumDisplay = isToday
                ? `<span class="inline-flex items-center justify-center w-7 h-7 bg-[#FFDB89] text-[#1C1C1E] rounded-full text-sm font-bold">${dayNum}</span>`
                : `<span class="text-lg font-bold text-[#FFDB89]/80">${dayNum}</span>`;

            const rowBg = isToday ? 'bg-[#FFDB89]/[0.06] border-l-2 border-l-[#FFDB89]' : '';

            html += `
                <div id="${cellId}" class="day-cell flex items-stretch border-b border-[#FFDB89]/10 relative group hover:bg-white/[0.02] transition-colors ${rowBg} ${isToday ? 'is-today' : ''}" data-day-name="${dayName}">

                    <!-- Date column -->
                    <div class="w-16 shrink-0 flex flex-col items-center justify-center py-3 gap-0.5 border-r border-[#FFDB89]/10">
                        <span class="text-[10px] font-bold uppercase tracking-wide ${isToday ? 'text-[#FFDB89]' : 'text-[#FFDB89]/40'}">${dayName}</span>
                        ${dayNumDisplay}
                    </div>

                    <!-- Content area -->
                    <div class="flex-1 py-2.5 px-4 min-w-0 flex items-center">
                        <div class="content-area w-full"></div>
                    </div>

                    <!-- Action icons — no squares, just icons, hidden when cell has content -->
                    <div class="day-cell-menu flex items-center gap-4 px-4 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button class="cal-action-btn text-[#FFDB89]/35 hover:text-[#FFDB89] transition-colors" data-action="add" data-date="${cellId}" title="Añadir rutina"><i class="fas fa-plus text-sm"></i></button>
                        <button class="cal-action-btn text-[#FFDB89]/35 hover:text-[#FFDB89] transition-colors" data-action="rest" data-date="${cellId}" title="Día de descanso"><i class="fas fa-battery-full text-sm"></i></button>
                        <button class="cal-action-btn text-[#FFDB89]/35 hover:text-[#FFDB89] transition-colors" data-action="nutrition" data-date="${cellId}" title="Nutrición"><i class="fab fa-apple text-sm"></i></button>
                        <button class="cal-action-btn text-[#FFDB89]/35 hover:text-[#FFDB89] transition-colors" data-action="paste" data-date="${cellId}" title="Pegar"><i class="fas fa-clipboard text-sm"></i></button>
                        <button class="cal-action-btn text-[#FFDB89]/35 hover:text-[#FFDB89] transition-colors" data-action="program" data-date="${cellId}" title="Asignar programa"><i class="far fa-calendar-plus text-sm"></i></button>
                    </div>

                    <input type="checkbox" class="copy-day-checkbox hidden absolute left-[80px] top-1/2 -translate-y-1/2 w-4 h-4 z-30 accent-[#FFDB89] cursor-pointer pointer-events-auto" data-date="${currentDate.toISOString().split('T')[0]}" onclick="event.stopPropagation(); window.toggleCopyDay(this)" />
                </div>
            `;
        }
        return html;
    };

    // CALENDAR ACTIONS HANDLER
    const handleCalendarAction = async (action, dateId) => {
        const dateStr = dateId.replace('day-', '');
        
        if (action === 'add') {
            editorExercises = [{ id: Date.now(), name: "", instructions: "", results: "", isSuperset: false, supersetHead: false, videoUrl: "" }];
            editorDateStr = dateStr;
            editorWarmup = "";
            editorWarmupVideoUrl = "";
            editorCooldown = "";
            editorWorkoutTitle = dateStr;
            openWorkoutEditor(dateStr); 
            
        } else if (action === 'rest') {
            try {
                const res = await apiFetch('/api/client-workouts', {
                    method: 'POST',
                    body: JSON.stringify({
                        clientId: currentClientViewId,
                        date: dateStr,
                        title: 'Descanso',
                        isRest: true,
                        restType: 'rest',
                        exercises: []
                    })
                });
                if (res.ok) {
                    const cell = document.getElementById(dateId);
                    if (cell) {
                        const content = cell.querySelector('.content-area');
                        if (content) {
                            content.innerHTML = `
                                <div class="flex items-center gap-2 py-0.5">
                                    <div class="w-1 h-6 rounded-full shrink-0" style="background:#93C5FD"></div>
                                    <i class="fas fa-moon text-xs shrink-0" style="color:#93C5FD"></i>
                                    <span class="text-xs font-semibold" style="color:#93C5FD">Descanso</span>
                                </div>`;
                        }
                        const cb = cell.querySelector('.copy-day-checkbox');
                        if (cb) cb.classList.remove('hidden');
                    }
                } else {
                    showToast('Error guardando día de descanso.', 'error');
                }
            } catch (e) { showToast('Error de conexión.', 'error'); }

        } else if (action === 'nutrition') {
            // Switch to the Nutrición tab on the client profile
            const nutriTab = document.querySelector('.client-detail-tab[data-tab="nutrition"]');
            if (nutriTab) nutriTab.click();
            
        } else if (action === 'paste') {
            // PASTE - supports both single-day and multi-day
            if(copiedMultiDayData && copiedMultiDayData.length > 0) {
                // MULTI-DAY PASTE: preserve spacing from original
                const pasteStartDate = new Date(dateStr + 'T00:00:00');
                let successCount = 0;

                for(const item of copiedMultiDayData) {
                    const targetDate = new Date(pasteStartDate);
                    targetDate.setDate(targetDate.getDate() + item.dayOffset);
                    const targetDateStr = targetDate.toISOString().split('T')[0];

                    const pastedWorkout = {
                        ...item.workout,
                        clientId: currentClientViewId,
                        date: targetDateStr,
                        title: item.workout.title
                    };
                    delete pastedWorkout._id;

                    try {
                        const response = await apiFetch('/api/client-workouts', {
                            method: 'POST',
                            body: JSON.stringify(pastedWorkout)
                        });
                        if(response.ok) {
                            successCount++;
                            const targetCellId = `day-${targetDateStr}`;
                            const cell = document.getElementById(targetCellId);
                            if(cell) {
                                const area = cell.querySelector('.content-area');
                                area.innerHTML = `
                                    <div class="workout-card-wrapper">${window._calendarWorkouts[targetDateStr] = pastedWorkout, ''}
                                        <div class="workout-card-header flex items-center gap-3 cursor-pointer py-0.5 group/wk">
                                            <div class="w-1 h-8 bg-[#FFDB89] rounded-full shrink-0"></div>
                                            <div class="min-w-0 flex-1">
                                                <div class="text-sm font-bold text-[#FFDB89] truncate">${pastedWorkout.title}</div>
                                                <div class="text-xs text-[#FFDB89]/50">${pastedWorkout.exercises.length} ejercicios</div>
                                            </div>
                                            <i class="fas fa-chevron-right text-[#FFDB89]/40 text-xs shrink-0 workout-chevron transition-transform duration-200"></i>
                                        </div>
                                        <div class="workout-expand-content hidden mt-1 border-t border-[#FFDB89]/10"></div>
                                    </div>
                                `;
                                const cb = cell.querySelector('.copy-day-checkbox');
                                if(cb) cb.classList.remove('hidden');
                            }
                        }
                    } catch(e) {
                        console.error('Error pasting workout:', e);
                    }
                }
                showToast(`${successCount} workout${successCount > 1 ? 's' : ''} pegado${successCount > 1 ? 's' : ''} exitosamente.`, 'success');

            } else if(copiedWorkoutData) {
                // SINGLE-DAY PASTE (legacy behavior)
                const pastedWorkout = {
                    ...copiedWorkoutData,
                    clientId: currentClientViewId,
                    date: dateStr,
                    title: copiedWorkoutData.title + ' (Copia)'
                };
                delete pastedWorkout._id;

                try {
                    const response = await apiFetch('/api/client-workouts', {
                        method: 'POST',
                        body: JSON.stringify(pastedWorkout)
                    });
                    if(response.ok) {
                        const cell = document.getElementById(dateId);
                        if(cell) {
                            const area = cell.querySelector('.content-area');
                            area.innerHTML = `
                                <div class="workout-card flex items-center gap-3 cursor-pointer group/wk" onclick="window.loadWorkoutForEditing('${dateStr}', '${currentClientViewId}')">
                                    <div class="w-1 h-8 bg-[#FFDB89] rounded-full shrink-0"></div>
                                    <div class="min-w-0 flex-1">
                                        <div class="text-sm font-bold text-[#FFDB89] truncate">${pastedWorkout.title}</div>
                                        <div class="text-xs text-[#FFDB89]/50">${pastedWorkout.exercises.length} ejercicios</div>
                                    </div>
                                    <i class="fas fa-chevron-right text-[#FFDB89]/30 text-xs group-hover/wk:text-[#FFDB89] transition-colors shrink-0"></i>
                                </div>
                            `;
                            const cb = cell.querySelector('.copy-day-checkbox');
                            if(cb) cb.classList.remove('hidden');
                        }
                        showToast('Workout pegado exitosamente.', 'success');
                    }
                } catch(e) {
                    console.error(e);
                    showToast('Error al pegar workout.', 'error');
                }

            } else {
                showToast('No hay workout copiado. Selecciona días con el checkbox o haz clic derecho en un día con workout.', 'info');
            }
            
        } else if (action === 'program') {
            // ASSIGN PROGRAM (Show program selector)
            showProgramAssignmentModal(dateStr);
        }
    };

    // Backfill missing videoUrls from the exercise library (by matching name)
    const syncExerciseVideoUrls = () => {
        editorExercises = editorExercises.map(ex => {
            if (!ex.videoUrl && ex.name) {
                const libMatch = globalExerciseLibrary.find(l => l.name.toLowerCase() === ex.name.toLowerCase());
                if (libMatch?.videoUrl) return { ...ex, videoUrl: libMatch.videoUrl };
            }
            return ex;
        });
    };

    // NEW WORKOUT EDITOR UI
    const openWorkoutEditor = async (dateStr) => {
        editorDateStr = dateStr;
        
        // Try to load existing workout for this date
        if(currentClientViewId) {
            try {
                const response = await apiFetch(`/api/client-workouts/${currentClientViewId}/${dateStr}`);
                if(response.ok) {
                    const workout = await response.json();
                    editorWorkoutTitle = workout.title || editorDateStr;
                    editorWarmup = workout.warmup || '';
                    editorWarmupVideoUrl = workout.warmupVideoUrl || '';
                    editorWarmupItems = workout.warmupItems || [];
                    editorCooldown = workout.cooldown || '';
                    editorCooldownVideoUrl = workout.cooldownVideoUrl || '';
                    editorCooldownItems = workout.cooldownItems || [];
                    editorExercises = workout.exercises || [{ id: Date.now(), name: "", instructions: "", results: "", isSuperset: false, supersetHead: false, videoUrl: "" }];
                    // Backward-compat migration: old data used isSuperset=true on ALL exercises
                    // in a group (including the first). New model uses supersetHead=true on the
                    // first and isSuperset=true only on continuations.
                    editorExercises.forEach((ex, i) => {
                        if (ex.supersetHead === undefined) ex.supersetHead = false;
                        // An exercise with isSuperset=true that has no predecessor with
                        // isSuperset=true or supersetHead=true is the group's first exercise.
                        const prevIsChained = i > 0 && (editorExercises[i - 1].isSuperset || editorExercises[i - 1].supersetHead);
                        if (ex.isSuperset && !prevIsChained) {
                            ex.supersetHead = true;
                            ex.isSuperset   = false;
                        }
                    });
                    syncExerciseVideoUrls(); // backfill URLs from library for exercises that have none
                    editorIsComplete = workout.isComplete || false;
                    editorIsMissed   = workout.isMissed   || false;
                } else {
                    // New workout - initialize empty
                    editorWorkoutTitle = editorDateStr;
                    editorExercises = [{ id: Date.now(), name: "", instructions: "", results: "", isSuperset: false, supersetHead: false, videoUrl: "" }];
                    editorWarmup = "";
                    editorWarmupVideoUrl = "";
                    editorWarmupItems = [];
                    editorCooldown = "";
                    editorCooldownVideoUrl = "";
                    editorCooldownItems = [];
                    editorIsComplete = false;
                    editorIsMissed   = false;
                }
            } catch(e) {
                // Network error - initialize empty
                editorWorkoutTitle = editorDateStr;
                editorExercises = [{ id: Date.now(), name: "", instructions: "", results: "", isSuperset: false, supersetHead: false, videoUrl: "" }];
                editorWarmup = "";
                editorWarmupVideoUrl = "";
                editorWarmupItems = [];
                editorCooldown = "";
                editorCooldownVideoUrl = "";
                editorCooldownItems = [];
                editorIsComplete = false;
                editorIsMissed   = false;
            }
        }
        
        editorIsDirty = false;
        editorHistory = []; // clear undo stack on fresh open
        clearInterval(editorAutosaveInterval);
        editorAutosaveInterval = setInterval(async () => {
            if (editorIsDirty) await window.performWorkoutSave(true);
        }, 30000);

        const modal = document.getElementById('workout-editor-modal');
        modal.classList.remove('hidden');
        renderWorkoutEditorUI();
    };

    const renderWorkoutEditorUI = () => {
        const modal = document.getElementById('workout-editor-modal');

        // If panel already exists, only update the exercise list — no full re-render, no animation
        // Dynamic Exercise List
        const listHtml = editorExercises.map((ex, index) => {
            const letter = getLetter(index, editorExercises); 
            // 4. SUPERSET BUTTON: Insert BETWEEN exercises
            let supersetBtnHtml = '';
            if (index < editorExercises.length - 1) {
                const nextEx = editorExercises[index + 1];
                if (!nextEx.isSuperset) {
                    supersetBtnHtml = `
                        <div class="flex justify-center -my-3 z-10 relative">
                            <button onclick="window.linkSuperset(${index})" class="bg-[#3a3a3c] hover:bg-[#FFDB89]/20 text-[#FFDB89] text-[10px] px-3 py-1 rounded-full shadow-md transition border border-[#FFDB89]/30 font-bold">
                                <i class="fas fa-link mr-1"></i> Superset
                            </button>
                        </div>
                    `;
                } else {
                    supersetBtnHtml = `
                        <div class="flex justify-center -my-3 z-10 relative">
                            <button onclick="window.unlinkSuperset(${index + 1})" class="bg-[#3a3a3c] hover:bg-red-500/20 text-[#FFDB89]/50 hover:text-red-400 text-[10px] px-3 py-1 rounded-full shadow-md transition border border-[#FFDB89]/15 hover:border-red-400/40 font-bold">
                                <i class="fas fa-unlink mr-1"></i> Superset
                            </button>
                        </div>
                    `;
                }
            }

            return `
            <div class="p-6 border-b border-[#FFDB89]/15 bg-[#32323c] relative">
                <div class="flex items-start gap-2 mb-2 min-w-0">
                    <div class="flex flex-col items-center gap-0.5 pt-1 shrink-0">
                        <input type="checkbox" class="ex-checkbox w-4 h-4 rounded accent-[#FFDB89] bg-gray-700 border-[#FFDB89]/30 cursor-pointer" data-id="${ex.id}" ${ex._selected ? 'checked' : ''} onchange="window.toggleExerciseSelect(${ex.id}, this.checked)" title="Seleccionar para eliminar">
                        <button onclick="window.moveExerciseUp(${index})" class="text-[#FFDB89]/25 hover:text-[#FFDB89] transition leading-none py-0.5 ${index === 0 ? 'invisible' : ''}" title="Mover arriba"><i class="fas fa-chevron-up text-[9px]"></i></button>
                        <button onclick="window.moveExerciseDown(${index})" class="text-[#FFDB89]/25 hover:text-[#FFDB89] transition leading-none py-0.5 ${index === editorExercises.length - 1 ? 'invisible' : ''}" title="Mover abajo"><i class="fas fa-chevron-down text-[9px]"></i></button>
                    </div>
                    <h3 class="text-[#FFDB89] font-bold text-lg shrink-0">${letter})</h3>
                    <input type="text" value="${ex.name}" class="bg-transparent text-[#FFDB89] font-bold outline-none min-w-0 flex-1 placeholder-[#FFDB89]/30" placeholder="Título del ejercicio" oninput="window.updateExName(${ex.id}, this.value); window.markEditorDirty();">
                    <div class="flex items-center gap-1.5 shrink-0">
                        ${ex._selected ? `<button onclick="window.deleteEditorExercise(${ex.id})" class="text-red-400/80 hover:text-red-400 transition" title="Eliminar ejercicio"><i class="fas fa-trash-alt text-sm"></i></button>` : ''}
                        ${ex.videoUrl ? `<button onclick="window.previewExerciseVideo('${ex.videoUrl.replace(/'/g,"\\'")}','${(ex.name||'').replace(/'/g,"\\'")}',this); event.stopPropagation();" class="text-green-400/70 hover:text-green-400 transition text-sm" title="Ver video"><i class="fas fa-play-circle"></i></button>` : ''}
                        <i class="fas fa-video ${ex.videoUrl ? 'text-[#FFDB89]' : 'text-[#FFDB89]/30'} cursor-pointer hover:text-[#FFDB89] mt-0.5" onclick="window.openVideoModalForEditor(${ex.id})" title="Editar URL del video"></i>
                    </div>
                </div>

                <button class="w-full py-2 bg-[#3a3a3c] text-[#FFDB89] font-bold rounded text-sm hover:bg-[#3a3a3c]/80 transition mb-3 flex items-center justify-center gap-2" onclick="window.openHistoryModal(${ex.id})">
                    <i class="fas fa-history"></i> Ver historial
                </button>
                <textarea oninput="window.updateExInstructions(${ex.id}, this.value); window.markEditorDirty();" class="w-full bg-transparent text-[#FFDB89]/60 text-xs resize-none outline-none placeholder-[#FFDB89]/30 mb-2" placeholder="Sets, Reps, Tempo, Rest etc." rows="2">${ex.instructions || ''}</textarea>
                <textarea oninput="window.updateExResults(${ex.id}, this.value); window.markEditorDirty();" class="w-full bg-black/30 border border-[#FFDB89]/10 rounded-lg text-[#FFDB89]/80 text-xs resize-none outline-none placeholder-[#FFDB89]/25 p-2.5 focus:border-[#FFDB89]/30 transition" placeholder="Agregar resultados..." rows="2">${ex.results || ''}</textarea>
            </div>
            ${supersetBtnHtml}
            `;
        }).join('');

        // Helper: render warmup items rows (used both for full and partial re-render)
        const warmupItemsHtml = editorWarmupItems.map(item => `
            <div class="flex items-center gap-2 pl-1">
                <i class="fas fa-circle text-orange-400/40 text-[6px] shrink-0"></i>
                <input type="text" value="${(item.name||'').replace(/"/g,'&quot;')}" oninput="window.updateWarmupItem(${item.id},'name',this.value); window.markEditorDirty();" class="flex-1 min-w-0 bg-transparent text-sm text-[#FFDB89]/70 placeholder-[#FFDB89]/25 outline-none" placeholder="Ejercicio de calentamiento...">
                ${item.videoUrl ? `<button onclick="window.previewExerciseVideo('${item.videoUrl.replace(/'/g,"\\'")}','${(item.name||'').replace(/'/g,"\\'")}',this);" class="text-green-400/70 hover:text-green-400 transition text-sm shrink-0" title="Ver video"><i class="fas fa-play-circle"></i></button>` : ''}
                <i class="fas fa-video ${item.videoUrl ? 'text-[#FFDB89]' : 'text-[#FFDB89]/20'} cursor-pointer hover:text-[#FFDB89] text-xs shrink-0" onclick="window.openVideoForWarmupItem(${item.id})" title="URL de video"></i>
                <button onclick="window.removeWarmupItem(${item.id})" class="text-[#FFDB89]/20 hover:text-red-400 transition text-xs shrink-0" title="Eliminar"><i class="fas fa-times"></i></button>
            </div>`).join('');

        // Helper: render cooldown items rows
        const cooldownItemsHtml = editorCooldownItems.map(item => `
            <div class="flex items-center gap-2 pl-1">
                <i class="fas fa-circle text-blue-300/40 text-[6px] shrink-0"></i>
                <input type="text" value="${(item.name||'').replace(/"/g,'&quot;')}" oninput="window.updateCooldownItem(${item.id},'name',this.value); window.markEditorDirty();" class="flex-1 min-w-0 bg-transparent text-sm text-[#FFDB89]/70 placeholder-[#FFDB89]/25 outline-none" placeholder="Ejercicio de enfriamiento...">
                ${item.videoUrl ? `<button onclick="window.previewExerciseVideo('${item.videoUrl.replace(/'/g,"\\'")}','${(item.name||'').replace(/'/g,"\\'")}',this);" class="text-green-400/70 hover:text-green-400 transition text-sm shrink-0" title="Ver video"><i class="fas fa-play-circle"></i></button>` : ''}
                <i class="fas fa-video ${item.videoUrl ? 'text-[#FFDB89]' : 'text-[#FFDB89]/20'} cursor-pointer hover:text-[#FFDB89] text-xs shrink-0" onclick="window.openVideoForCooldownItem(${item.id})" title="URL de video"></i>
                <button onclick="window.removeCooldownItem(${item.id})" class="text-[#FFDB89]/20 hover:text-red-400 transition text-xs shrink-0" title="Eliminar"><i class="fas fa-times"></i></button>
            </div>`).join('');

        // If the panel already exists just swap the exercise + items lists — no full re-render, no animation
        const existingList = document.getElementById('editor-exercises-list');
        if (existingList) {
            existingList.innerHTML = listHtml;
            const wList = document.getElementById('warmup-items-list');
            if (wList) wList.innerHTML = warmupItemsHtml;
            const cList = document.getElementById('cooldown-items-list');
            if (cList) cList.innerHTML = cooldownItemsHtml;
            return;
        }

        modal.innerHTML = `
            <div id="editor-panel" class="bg-[#2d2d35] w-full max-w-md h-full shadow-2xl flex flex-col border-l border-[#FFDB89]/15 slide-in-right transition-all duration-300">

                <!-- TITLE always on top -->
                <div class="px-5 py-4 border-b border-[#FFDB89]/15 bg-[#26262c] shrink-0 flex items-center gap-3">
                    <input type="text" id="workout-title-input" value="${(editorWorkoutTitle || editorDateStr).replace(/"/g,'&quot;')}" oninput="window.updateWorkoutTitle(this.value); window.markEditorDirty();" class="bg-transparent text-2xl font-bold text-[#FFDB89] placeholder-[#FFDB89]/30 w-full outline-none" placeholder="Nombre del Entrenamiento">
                    <div class="flex gap-3 text-[#FFDB89]/40 shrink-0">
                        <button onclick="window.undoEditorChange()" id="editor-undo-btn" class="hover:text-[#FFDB89] transition opacity-30" title="Deshacer (Ctrl+Z)" disabled><i class="fas fa-undo text-sm"></i></button>
                        <button onclick="document.getElementById('editor-panel').classList.toggle('editor-expanded')" class="hover:text-[#FFDB89] transition"><i class="fas fa-expand-alt text-sm"></i></button>
                        <button onclick="window.closeWorkoutEditor()" class="hover:text-[#FFDB89] transition"><i class="fas fa-times text-sm"></i></button>
                    </div>
                </div>

                <!-- UNSAVED BANNER — hidden by default, slides in when dirty -->
                <div id="editor-unsaved-banner" class="bg-[#ff6b4a] shrink-0 overflow-hidden transition-all duration-500" style="max-height:0; opacity:0;">
                    <div class="px-4 py-2 flex justify-between items-center text-white">
                        <span class="text-xs font-bold flex items-center gap-1.5"><i class="fas fa-exclamation-circle"></i> Cambios sin guardar</span>
                        <span id="editor-autosave-status" class="text-xs opacity-80"></span>
                    </div>
                </div>

                <!-- SCROLLABLE BODY -->
                <div class="flex-1 overflow-y-auto">
                    <!-- WARMUP -->
                    <div class="p-5 border-b border-[#FFDB89]/15 bg-[#2a2a32]">
                        <div class="flex items-center gap-2 mb-3">
                            <div class="w-6 h-6 bg-orange-500 rounded flex-shrink-0 flex items-center justify-center text-white text-xs font-bold"><i class="fas fa-fire"></i></div>
                            <span class="text-xs font-bold text-[#FFDB89]/60 uppercase tracking-wider">Calentamiento</span>
                        </div>
                        <div class="mb-3">
                            <textarea oninput="window.updateWarmup(this.value); window.markEditorDirty();" class="bg-transparent text-sm text-[#FFDB89]/60 placeholder-[#FFDB89]/25 w-full outline-none resize-none" rows="2" placeholder="Instrucciones generales...">${editorWarmup}</textarea>
                        </div>
                        <div id="warmup-items-list" class="space-y-1.5">
                            ${warmupItemsHtml}
                        </div>
                        <button onclick="window.addWarmupItem()" class="mt-2 text-[#FFDB89]/35 hover:text-[#FFDB89]/70 text-xs transition flex items-center gap-1.5 pl-1">
                            <i class="fas fa-plus text-[8px]"></i> Agregar calentamiento
                        </button>
                    </div>

                    <div id="editor-exercises-list">${listHtml}</div>

                    <div class="flex justify-center gap-2 p-6">
                        <button class="px-3 py-1 border border-[#FFDB89]/30 rounded text-[#FFDB89] text-xs hover:bg-[#FFDB89]/10 transition" onclick="window.addEditorExercise()">+ Ejercicio</button>
                    </div>

                    <!-- COOLDOWN -->
                    <div class="p-5 border-t border-[#FFDB89]/15 bg-[#2a2a32]">
                        <div class="flex items-center gap-2 mb-3">
                            <div class="w-6 h-6 bg-[#3a3a3c] border border-[#FFDB89]/30 rounded flex-shrink-0 flex items-center justify-center text-[#FFDB89] text-xs font-bold"><i class="fas fa-snowflake"></i></div>
                            <span class="text-xs font-bold text-[#FFDB89]/60 uppercase tracking-wider">Enfriamiento</span>
                        </div>
                        <div class="mb-3">
                            <textarea oninput="window.updateCooldown(this.value); window.markEditorDirty();" class="bg-transparent text-sm text-[#FFDB89]/60 placeholder-[#FFDB89]/25 w-full outline-none resize-none" rows="2" placeholder="Instrucciones generales...">${editorCooldown || ''}</textarea>
                        </div>
                        <div id="cooldown-items-list" class="space-y-1.5">
                            ${cooldownItemsHtml}
                        </div>
                        <button onclick="window.addCooldownItem()" class="mt-2 text-[#FFDB89]/35 hover:text-[#FFDB89]/70 text-xs transition flex items-center gap-1.5 pl-1">
                            <i class="fas fa-plus text-[8px]"></i> Agregar enfriamiento
                        </button>
                    </div>
                </div>

                <!-- FOOTER -->
                <div class="p-4 border-t border-[#FFDB89]/15 flex flex-col gap-2 bg-[#26262c] shrink-0">
                    <button class="w-full py-3 bg-[#3a3a3c] text-[#FFDB89] font-bold rounded hover:bg-[#3a3a3c]/80 transition shadow-lg" onclick="window.saveDayWorkout()">Guardar</button>
                    <div class="grid grid-cols-2 gap-2 pt-1 border-t border-[#FFDB89]/10 mt-1">
                        <button id="editor-complete-btn"
                            class="py-2.5 rounded-lg border text-xs font-bold transition flex items-center justify-center gap-1.5 ${editorIsComplete ? 'bg-green-500/20 border-green-500/60 text-green-400' : 'border-green-500/30 text-green-400/70 hover:bg-green-500/10 hover:border-green-500/50 hover:text-green-400'}"
                            onclick="window.trainerMarkWorkout('complete')">
                            <i class="fas fa-check-circle text-xs"></i>${editorIsComplete ? 'Completado ✓' : 'Completar'}
                        </button>
                        <button id="editor-missed-btn"
                            class="py-2.5 rounded-lg border text-xs font-bold transition flex items-center justify-center gap-1.5 ${editorIsMissed ? 'bg-red-500/20 border-red-500/60 text-red-400' : 'border-red-500/30 text-red-400/70 hover:bg-red-500/10 hover:border-red-500/50 hover:text-red-400'}"
                            onclick="window.trainerMarkWorkout('missed')">
                            <i class="fas fa-times-circle text-xs"></i>${editorIsMissed ? 'Perdido ✕' : 'Marcar perdido'}
                        </button>
                    </div>
                    <button class="w-full py-2 text-[#FFDB89]/50 font-bold hover:text-[#FFDB89] transition rounded hover:bg-[#FFDB89]/10 text-sm" onclick="window.closeWorkoutEditor()">Cancelar</button>
                </div>
            </div>
        `;
    };

    const showProgramAssignmentModal = async (startDate) => {
        if(!currentClientViewId) return;
        
        // Fetch all available programs
        try {
            const response = await apiFetch('/api/programs');
            if(!response.ok) {
                showToast('Error cargando programas.', 'error');
                return;
            }

            const programs = await response.json();

            if(programs.length === 0) {
                showToast('No hay programas creados. Ve a la sección "Programas" para crear uno primero.', 'info');
                return;
            }
            
            // Create modal
            const modal = document.createElement('div');
            modal.id = 'program-assignment-modal';
            modal.className = 'fixed inset-0 bg-black/80 z-[70] flex items-center justify-center p-4';
            modal.innerHTML = `
                <div class="bg-[#030303] border border-[#FFDB89]/20 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
                    <div class="px-6 py-4 border-b border-[#FFDB89]/15 bg-[#FFDB89]/5">
                        <h3 class="text-xl font-bold text-[#FFDB89]">Asignar Programa</h3>
                        <p class="text-sm text-[#FFDB89]/50 mt-0.5">Selecciona un programa para asignar a partir del ${startDate}</p>
                    </div>

                    <div class="p-4 space-y-2 max-h-80 overflow-y-auto">
                        ${programs.map(prog => `
                            <div class="p-4 border border-[#FFDB89]/15 hover:border-[#FFDB89]/40 bg-[#1C1C1E] hover:bg-[#FFDB89]/5 rounded-xl cursor-pointer transition-all duration-150" onclick="window.assignProgramToClient('${prog._id}', '${startDate}')">
                                <div class="font-bold text-[#FFDB89]">${prog.name}</div>
                                <div class="text-xs text-[#FFDB89]/40 mt-0.5">${prog.weeks?.length || 0} semanas · ${prog.clientCount || 0} clientes</div>
                            </div>
                        `).join('')}
                    </div>

                    <div class="px-4 py-4 border-t border-[#FFDB89]/10 bg-[#FFDB89]/5">
                        <button onclick="document.getElementById('program-assignment-modal').remove()" class="w-full py-2.5 bg-[#FFDB89]/10 hover:bg-[#FFDB89]/20 border border-[#FFDB89]/20 text-[#FFDB89] font-bold rounded-lg transition">Cancelar</button>
                    </div>
                </div>
            `;
            
            document.body.appendChild(modal);
            
        } catch(e) {
            console.error(e);
            showToast('Error cargando programas.', 'error');
        }
    };

    // SUPERSET LETTER LOGIC
    // Two-flag model:
    //   supersetHead:true  = first exercise of a new superset group (not linked to previous)
    //   isSuperset:true    = continuation of the exercise above (same group)
    const getLetter = (index, arr) => {
        let charCode = 65;
        let subIndex = 0;
        let letters = [];
        for (let i = 0; i < arr.length; i++) {
            const isContinuation = i > 0 && !!arr[i].isSuperset;
            const isHead         = !!arr[i].supersetHead;
            if (isContinuation) {
                subIndex++;
            } else {
                if (i > 0) charCode++;
                subIndex = isHead ? 1 : 0;
            }
            letters.push((isHead || isContinuation)
                ? String.fromCharCode(charCode) + subIndex
                : String.fromCharCode(charCode));
        }
        return letters[index];
    };

    // Expose letter resolver globally so calendar / feed views can reuse it
    window.getExerciseLetter = getLetter;

    // HELPERS
    window.updateWarmup = (val) => { editorWarmup = val; };
    // Remove supersetHead from any exercise whose next sibling is no longer a continuation
    const cleanupSupersetHeads = () => {
        editorExercises.forEach((ex, i) => {
            if (ex.supersetHead && (!editorExercises[i + 1] || !editorExercises[i + 1].isSuperset)) {
                ex.supersetHead = false;
            }
        });
    };

    window.addEditorExercise = () => { captureEditorSnapshot(); editorExercises.push({ id: Date.now(), name: "", instructions: "", results: "", isSuperset: false, supersetHead: false, videoUrl: "" }); renderWorkoutEditorUI(); window.markEditorDirty(); };
    window.updateExName = (id, val) => { const ex = editorExercises.find(e => e.id === id); if(ex) ex.name = val; };
    window.updateExInstructions = (id, val) => {
        const ex = editorExercises.find(e => e.id === id);
        if(ex) ex.instructions = val;
    };
    window.updateExResults = (id, val) => {
        const ex = editorExercises.find(e => e.id === id);
        if(ex) ex.results = val;
    };
    window.updateCooldown = (val) => { editorCooldown = val; };
    window.updateWorkoutTitle = (val) => { editorWorkoutTitle = val; };

    // ── Undo history ──────────────────────────────────────────────────────
    const captureEditorSnapshot = () => {
        editorHistory.push(JSON.parse(JSON.stringify({
            exercises:        editorExercises,
            title:            editorWorkoutTitle,
            warmup:           editorWarmup,
            warmupVideoUrl:   editorWarmupVideoUrl,
            warmupItems:      editorWarmupItems,
            cooldown:         editorCooldown,
            cooldownVideoUrl: editorCooldownVideoUrl,
            cooldownItems:    editorCooldownItems,
        })));
        if (editorHistory.length > 50) editorHistory.shift(); // cap at 50 steps
        // Enable the undo button
        const btn = document.getElementById('editor-undo-btn');
        if (btn) { btn.disabled = false; btn.classList.remove('opacity-30'); btn.classList.add('opacity-100'); }
    };

    window.undoEditorChange = () => {
        if (!editorHistory.length) return;
        const snap = editorHistory.pop();
        editorExercises        = snap.exercises;
        editorWorkoutTitle     = snap.title;
        editorWarmup           = snap.warmup;
        editorWarmupVideoUrl   = snap.warmupVideoUrl;
        editorWarmupItems      = snap.warmupItems;
        editorCooldown         = snap.cooldown;
        editorCooldownVideoUrl = snap.cooldownVideoUrl;
        editorCooldownItems    = snap.cooldownItems;
        // Sync title input so it reflects the restored value
        const titleEl = document.getElementById('workout-title-input');
        if (titleEl) titleEl.value = editorWorkoutTitle;
        renderWorkoutEditorUI();
        window.markEditorDirty();
        if (!editorHistory.length) {
            const btn = document.getElementById('editor-undo-btn');
            if (btn) { btn.disabled = true; btn.classList.add('opacity-30'); btn.classList.remove('opacity-100'); }
        }
    };

    // Ctrl/Cmd+Z shortcut — fires only when the editor panel is open
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
            if (document.getElementById('editor-panel')) {
                e.preventDefault();
                window.undoEditorChange();
            }
        }
    });

    // ── Warmup items ──────────────────────────────────────────────────────
    window.addWarmupItem = () => {
        captureEditorSnapshot();
        editorWarmupItems.push({ id: Date.now(), name: '', videoUrl: '' });
        renderWorkoutEditorUI();
        window.markEditorDirty();
    };
    window.removeWarmupItem = (id) => {
        captureEditorSnapshot();
        editorWarmupItems = editorWarmupItems.filter(i => i.id !== id);
        renderWorkoutEditorUI();
        window.markEditorDirty();
    };
    window.updateWarmupItem = (id, field, val) => {
        const item = editorWarmupItems.find(i => i.id === id);
        if (item) item[field] = val;
    };
    window.openVideoForWarmupItem = (id) => {
        currentEditorExId = `warmup-item-${id}`;
        const item = editorWarmupItems.find(i => i.id === id);
        document.getElementById('video-url-input').value = item?.videoUrl || '';
        const titleEl = document.getElementById('video-modal-title');
        const nameInput = document.getElementById('video-library-name');
        if (titleEl) titleEl.textContent = item?.name || 'Video de calentamiento';
        if (nameInput) nameInput.value = item?.name || '';
        document.getElementById('video-upload-modal').classList.remove('hidden');
        initVideoNameAutocomplete();
    };

    // ── Cooldown items ────────────────────────────────────────────────────
    window.addCooldownItem = () => {
        captureEditorSnapshot();
        editorCooldownItems.push({ id: Date.now(), name: '', videoUrl: '' });
        renderWorkoutEditorUI();
        window.markEditorDirty();
    };
    window.removeCooldownItem = (id) => {
        captureEditorSnapshot();
        editorCooldownItems = editorCooldownItems.filter(i => i.id !== id);
        renderWorkoutEditorUI();
        window.markEditorDirty();
    };
    window.updateCooldownItem = (id, field, val) => {
        const item = editorCooldownItems.find(i => i.id === id);
        if (item) item[field] = val;
    };
    window.openVideoForCooldownItem = (id) => {
        currentEditorExId = `cooldown-item-${id}`;
        const item = editorCooldownItems.find(i => i.id === id);
        document.getElementById('video-url-input').value = item?.videoUrl || '';
        const titleEl = document.getElementById('video-modal-title');
        const nameInput = document.getElementById('video-library-name');
        if (titleEl) titleEl.textContent = item?.name || 'Video de enfriamiento';
        if (nameInput) nameInput.value = item?.name || '';
        document.getElementById('video-upload-modal').classList.remove('hidden');
        initVideoNameAutocomplete();
    };
    window.openCooldownVideoModal = () => {
        currentEditorExId = 'cooldown';
        document.getElementById('video-url-input').value = editorCooldownVideoUrl || '';
        const titleEl = document.getElementById('video-modal-title');
        const nameInput = document.getElementById('video-library-name');
        if (titleEl) titleEl.textContent = 'Enfriamiento';
        if (nameInput) nameInput.value = '';
        document.getElementById('video-upload-modal').classList.remove('hidden');
        initVideoNameAutocomplete();
    };

    // ── Unlink superset ───────────────────────────────────────────────────
    window.unlinkSuperset = (index) => {
        if (!editorExercises[index]) return;
        captureEditorSnapshot();
        editorExercises[index].isSuperset = false;
        // If the now-detached exercise is followed by another continuation, it becomes a new head
        if (editorExercises[index + 1]?.isSuperset) {
            editorExercises[index].supersetHead = true;
        } else {
            editorExercises[index].supersetHead = false;
        }
        // Clean up the exercise above — if it was a supersetHead and no longer has a successor, strip the flag
        cleanupSupersetHeads();
        renderWorkoutEditorUI();
        window.markEditorDirty();
    };

    window._calendarWorkouts = window._calendarWorkouts || {};

    window.toggleWorkoutExpand = (headerEl) => {
        const cell = headerEl.closest('.day-cell');
        if (!cell) return;
        const dateStr = cell.id.replace('day-', '');
        const wrapper = headerEl.closest('.workout-card-wrapper');
        const content = wrapper.querySelector('.workout-expand-content');
        const chevron = headerEl.querySelector('.workout-chevron');
        const isExpanded = !content.classList.contains('hidden');

        if (isExpanded) {
            content.classList.add('hidden');
            chevron.style.transform = 'rotate(0deg)';
            return;
        }

        const workout = window._calendarWorkouts[dateStr];
        if (!workout) { window.loadWorkoutForEditing(dateStr, currentClientViewId); return; }

        let html = '';

        // Show client's mood for this day if logged
        if (workout.mood) {
            const moodMap = {
                amazing: { icon: 'fa-grin-stars', color: '#FFDB89', label: 'Increíble' },
                great:   { icon: 'fa-smile',       color: '#4ade80', label: 'Genial'    },
                neutral: { icon: 'fa-meh',         color: '#9ca3af', label: 'Normal'    },
                tired:   { icon: 'fa-tired',       color: '#fb923c', label: 'Cansado'   },
                bad:     { icon: 'fa-angry',       color: '#f87171', label: 'Mal'       },
            };
            const m = moodMap[workout.mood];
            if (m) {
                html += `<div class="flex items-center gap-2 py-2 mb-1 border-b border-[#FFDB89]/10">
                    <span class="text-[10px] font-bold text-[#FFDB89]/40 uppercase tracking-wider">Estado de ánimo</span>
                    <i class="fas ${m.icon} text-sm" style="color:${m.color}"></i>
                    <span class="text-xs font-bold" style="color:${m.color}">${m.label}</span>
                </div>`;
            }
        }

        if (workout.warmup) {
            html += `<div class="py-2 text-xs text-[#FFDB89]/50 italic border-b border-[#FFDB89]/10">${workout.warmup}</div>`;
        }

        const _exArr = workout.exercises || [];
        _exArr.forEach((ex, i) => {
            const exLetter = window.getExerciseLetter ? window.getExerciseLetter(i, _exArr) : String.fromCharCode(65 + i % 26);
            const hasVideo = !!ex.videoUrl;
            const clickAttr = hasVideo
                ? `onclick="event.stopPropagation(); window.previewExerciseVideo('${(ex.videoUrl||'').replace(/'/g,"\\'")}','${(ex.name||'').replace(/'/g,"\\'")}',this)"`
                : '';
            html += `<div class="py-2 flex items-start gap-2 border-b border-[#FFDB89]/10 last:border-0 ${hasVideo ? 'cursor-pointer group/exrow hover:bg-[#FFDB89]/5 rounded-lg px-1 -mx-1 transition-colors' : ''}" ${clickAttr}>
                <span class="text-xs font-bold text-[#FFDB89]/50 shrink-0 mt-0.5">${exLetter})</span>
                <div class="min-w-0 flex-1">
                    <div class="text-xs font-bold ${hasVideo ? 'text-[#FFDB89] group-hover/exrow:text-[#FFDB89]' : 'text-[#FFDB89]/80'}">${ex.name || '<span class="opacity-40 italic">Sin nombre</span>'}</div>
                    ${ex.instructions ? `<div class="text-xs text-[#FFDB89]/40 mt-0.5 leading-relaxed">${ex.instructions}</div>` : ''}
                </div>
                ${hasVideo ? `<i class="fas fa-play-circle text-green-400/60 group-hover/exrow:text-green-400 text-sm shrink-0 mt-0.5 transition-colors"></i>` : ''}
            </div>`;
        });

        if (workout.cooldown) {
            html += `<div class="pt-2 text-xs text-[#FFDB89]/50 italic border-t border-[#FFDB89]/10">${workout.cooldown}</div>`;
        }

        html += `<button onclick="event.stopPropagation(); window.loadWorkoutForEditing('${dateStr}', '${currentClientViewId}')"
            class="mt-2 text-[10px] font-bold text-[#FFDB89]/30 hover:text-[#FFDB89] transition-colors flex items-center gap-1">
            <i class="fas fa-pen text-[9px]"></i> Editar rutina
        </button>`;

        content.innerHTML = html;
        content.classList.remove('hidden');
        chevron.style.transform = 'rotate(90deg)';
    };

    window.markEditorDirty = () => {
        editorIsDirty = true;
        const banner = document.getElementById('editor-unsaved-banner');
        if (!banner) return;
        banner.style.maxHeight = '40px';
        banner.style.opacity = '1';
        clearTimeout(window._editorBannerHideTimer);
        window._editorBannerHideTimer = setTimeout(() => {
            banner.style.maxHeight = '0';
            banner.style.opacity = '0';
        }, 4000);
    };

    window.closeWorkoutEditor = () => {
        clearInterval(editorAutosaveInterval);
        editorAutosaveInterval = null;
        editorIsDirty = false;
        document.getElementById('workout-editor-modal').classList.add('hidden');
    };

    window.trainerMarkWorkout = async (action) => {
        if (!currentClientViewId || !editorDateStr) return;
        const isComplete = action === 'complete' ? !editorIsComplete : false;
        const isMissed   = action === 'missed'   ? !editorIsMissed   : false;
        // Complete and missed are mutually exclusive
        const payload = action === 'complete'
            ? { isComplete, isMissed: false }
            : { isMissed, isComplete: false };

        const btn = document.getElementById(action === 'complete' ? 'editor-complete-btn' : 'editor-missed-btn');
        if (btn) { btn.disabled = true; btn.innerHTML = `<i class="fas fa-spinner fa-spin text-xs"></i>`; }

        try {
            const res = await apiFetch(`/api/client-workouts/${currentClientViewId}/${editorDateStr}`, {
                method: 'PATCH', body: JSON.stringify(payload)
            });
            if (res.ok) {
                editorIsComplete = payload.isComplete;
                editorIsMissed   = payload.isMissed;
                // Update button states without full re-render
                const completeBtn = document.getElementById('editor-complete-btn');
                const missedBtn   = document.getElementById('editor-missed-btn');
                if (completeBtn) {
                    completeBtn.disabled = false;
                    completeBtn.className = `py-2.5 rounded-lg border text-xs font-bold transition flex items-center justify-center gap-1.5 ${editorIsComplete ? 'bg-green-500/20 border-green-500/60 text-green-400' : 'border-green-500/30 text-green-400/70 hover:bg-green-500/10 hover:border-green-500/50 hover:text-green-400'}`;
                    completeBtn.innerHTML = `<i class="fas fa-check-circle text-xs"></i>${editorIsComplete ? 'Completado ✓' : 'Completar'}`;
                }
                if (missedBtn) {
                    missedBtn.disabled = false;
                    missedBtn.className = `py-2.5 rounded-lg border text-xs font-bold transition flex items-center justify-center gap-1.5 ${editorIsMissed ? 'bg-red-500/20 border-red-500/60 text-red-400' : 'border-red-500/30 text-red-400/70 hover:bg-red-500/10 hover:border-red-500/50 hover:text-red-400'}`;
                    missedBtn.innerHTML = `<i class="fas fa-times-circle text-xs"></i>${editorIsMissed ? 'Perdido ✕' : 'Marcar perdido'}`;
                }
                // Update the calendar cell indicator
                const cell = document.getElementById(`day-${editorDateStr}`);
                if (cell) {
                    let dot = cell.querySelector('.completion-dot');
                    if (!dot) { dot = document.createElement('span'); dot.className = 'completion-dot'; cell.querySelector('.content-area')?.appendChild(dot); }
                    if (editorIsComplete) dot.outerHTML = `<span class="completion-dot ml-1 inline-block w-2 h-2 rounded-full bg-green-400" title="Completado"></span>`;
                    else if (editorIsMissed) dot.outerHTML = `<span class="completion-dot ml-1 inline-block w-2 h-2 rounded-full bg-red-400" title="Perdido"></span>`;
                    else { cell.querySelector('.completion-dot')?.remove(); }
                }
                // Update in-memory workout store
                if (window._calendarWorkouts?.[editorDateStr]) {
                    window._calendarWorkouts[editorDateStr].isComplete = editorIsComplete;
                    window._calendarWorkouts[editorDateStr].isMissed   = editorIsMissed;
                }
                showToast(editorIsComplete ? '✓ Marcado como completado' : editorIsMissed ? '✕ Marcado como perdido' : 'Estado actualizado', editorIsComplete ? 'success' : editorIsMissed ? 'error' : 'info');
            } else {
                if (btn) { btn.disabled = false; btn.innerHTML = `<i class="fas fa-exclamation text-xs"></i>Error`; }
                showToast('Error al actualizar estado.', 'error');
            }
        } catch(e) {
            if (btn) { btn.disabled = false; }
            showToast('Error de conexión.', 'error');
        }
    };

    window.performWorkoutSave = async (silent = false) => {
        if (!currentClientViewId) { if (!silent) showToast('Error: No hay cliente seleccionado.', 'error'); return; }
        const titleInput = document.getElementById('workout-title-input');
        const workoutData = {
            clientId: currentClientViewId,
            date: editorDateStr,
            title: titleInput?.value || editorDateStr,
            warmup: editorWarmup,
            warmupVideoUrl: editorWarmupVideoUrl,
            warmupItems: editorWarmupItems.map(i => ({ id: i.id, name: i.name || '', videoUrl: i.videoUrl || '' })),
            cooldown: editorCooldown,
            cooldownVideoUrl: editorCooldownVideoUrl,
            cooldownItems: editorCooldownItems.map(i => ({ id: i.id, name: i.name || '', videoUrl: i.videoUrl || '' })),
            exercises: editorExercises.map(ex => ({
                id: ex.id, name: ex.name, instructions: ex.instructions || '',
                results: ex.results || '', videoUrl: ex.videoUrl || '', isSuperset: ex.isSuperset || false, supersetHead: ex.supersetHead || false
            }))
        };
        try {
            const response = await apiFetch('/api/client-workouts', { method: 'POST', body: JSON.stringify(workoutData) });
            if (response.ok) {
                const savedWorkout = await response.json();
                editorIsDirty = false;
                const cell = document.getElementById(`day-${editorDateStr}`);
                if (cell) {
                    const area = cell.querySelector('.content-area');
                    window._calendarWorkouts[editorDateStr] = workoutData;
                    area.innerHTML = `
                        <div class="workout-card-wrapper">
                            <div class="workout-card-header flex items-center gap-3 cursor-pointer py-0.5 group/wk">
                                <div class="w-1 h-8 bg-[#FFDB89] rounded-full shrink-0"></div>
                                <div class="min-w-0 flex-1">
                                    <div class="text-sm font-bold text-[#FFDB89] truncate">${workoutData.title}</div>
                                    <div class="text-xs text-[#FFDB89]/50">${editorExercises.length} ejercicios</div>
                                </div>
                                <i class="fas fa-chevron-right text-[#FFDB89]/40 text-xs shrink-0 workout-chevron transition-transform duration-200"></i>
                            </div>
                            <div class="workout-expand-content hidden mt-1 border-t border-[#FFDB89]/10"></div>
                        </div>`;
                    const cb = cell.querySelector('.copy-day-checkbox');
                    if (cb) cb.classList.remove('hidden');
                }
                if (silent) {
                    // Show brief "Autoguardado" indicator in the banner status
                    const banner = document.getElementById('editor-unsaved-banner');
                    const status = document.getElementById('editor-autosave-status');
                    if (banner && status) {
                        status.innerHTML = '<i class="fas fa-check mr-1"></i>Autoguardado';
                        banner.style.maxHeight = '40px';
                        banner.style.opacity = '1';
                        // Change banner color to indicate success
                        banner.style.backgroundColor = '#2C6B3C';
                        setTimeout(() => {
                            banner.style.maxHeight = '0';
                            banner.style.opacity = '0';
                            banner.style.backgroundColor = '';
                            status.textContent = '';
                        }, 2500);
                    }
                } else {
                    window.closeWorkoutEditor();
                    showToast('Workout guardado exitosamente.', 'success');
                }
            } else {
                if (!silent) { showToast('Error al guardar workout.', 'error'); }
            }
        } catch(e) {
            if (!silent) showToast('Error de conexión.', 'error');
        }
    };
    // LINK SUPERSET BUTTON ACTION
    window.linkSuperset = (index) => {
        const curr = editorExercises[index];
        const next = editorExercises[index + 1];
        if (!curr || !next) return;
        captureEditorSnapshot();
        // Mark the next exercise as a continuation
        next.isSuperset = true;
        next.supersetHead = false;
        // If curr is a plain (non-linked) exercise, it now starts a NEW superset group
        if (!curr.isSuperset && !curr.supersetHead) {
            curr.supersetHead = true;
            // curr.isSuperset stays false — it is NOT linked to whatever is above it
        }
        // If curr already has isSuperset=true or supersetHead=true it's already in a chain — just extend
        renderWorkoutEditorUI();
        window.markEditorDirty();
    };

    // Select exercise (for deletion) — no snapshot needed, selection is not undoable
    window.toggleExerciseSelect = (id, checked) => {
        const ex = editorExercises.find(e => e.id === id);
        if (ex) ex._selected = checked;
        renderWorkoutEditorUI();
    };

    // Delete selected exercise
    window.deleteEditorExercise = (id) => {
        captureEditorSnapshot();
        const idx = editorExercises.findIndex(e => e.id === id);
        if (idx === -1) return;
        const dying = editorExercises[idx];
        const next  = editorExercises[idx + 1];
        // If deleting a supersetHead, promote the next exercise as the new group start
        if (dying.supersetHead && next?.isSuperset) {
            next.isSuperset = false;
            next.supersetHead = true;
        }
        // If deleting a plain continuation, the chain just shortens — nothing special needed
        editorExercises.splice(idx, 1);
        // Clean up any now-orphaned supersetHead flags
        cleanupSupersetHeads();
        // Ensure there's always at least one exercise
        if (editorExercises.length === 0) {
            editorExercises.push({ id: Date.now(), name: '', instructions: '', results: '', isSuperset: false, supersetHead: false, videoUrl: '' });
        }
        renderWorkoutEditorUI();
        window.markEditorDirty();
    };

    // Move exercise up/down (works across and within superset groups)
    window.moveExerciseUp = (index) => {
        if (index <= 0) return;
        captureEditorSnapshot();
        [editorExercises[index - 1], editorExercises[index]] = [editorExercises[index], editorExercises[index - 1]];
        cleanupSupersetHeads();
        renderWorkoutEditorUI();
        window.markEditorDirty();
    };
    window.moveExerciseDown = (index) => {
        if (index >= editorExercises.length - 1) return;
        captureEditorSnapshot();
        [editorExercises[index], editorExercises[index + 1]] = [editorExercises[index + 1], editorExercises[index]];
        cleanupSupersetHeads();
        renderWorkoutEditorUI();
        window.markEditorDirty();
    };

    // Helper: convert YouTube/Vimeo URL to embeddable URL
    // Returns { embedUrl, ytId, isYt } so callers can build fallback links
    const getVideoEmbedInfo = (url) => {
        if (!url) return { embedUrl: null, ytId: null, isYt: false };
        const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([^&?/\s]+)/);
        if (yt) return {
            embedUrl: `https://www.youtube.com/embed/${yt[1]}?autoplay=1&rel=0`,
            ytId: yt[1],
            isYt: true
        };
        const vi = url.match(/vimeo\.com\/(\d+)/);
        if (vi) return { embedUrl: `https://player.vimeo.com/video/${vi[1]}?autoplay=1`, ytId: null, isYt: false };
        const gd = url.match(/drive\.google\.com\/file\/d\/([^/]+)/);
        if (gd) return { embedUrl: `https://drive.google.com/file/d/${gd[1]}/preview`, ytId: null, isYt: false };
        if (/\.(mp4|webm|ogg|mov|mkv)(\?|$)/i.test(url)) return { embedUrl: `__direct__${url}`, ytId: null, isYt: false };
        return { embedUrl: null, ytId: null, isYt: false };
    };
    // Backward-compat shim — older callers that only need the URL string
    const getVideoEmbedUrl = (url) => {
        if (!url) return null;
        // YouTube (watch, short URL, embed, Shorts)
        const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([^&?/\s]+)/);
        if (yt) return `https://www.youtube.com/embed/${yt[1]}?autoplay=1&rel=0`;
        // Vimeo
        const vi = url.match(/vimeo\.com\/(\d+)/);
        if (vi) return `https://player.vimeo.com/video/${vi[1]}?autoplay=1`;
        // Google Drive  (drive.google.com/file/d/ID/view  →  /preview)
        const gd = url.match(/drive\.google\.com\/file\/d\/([^/]+)/);
        if (gd) return `https://drive.google.com/file/d/${gd[1]}/preview`;
        // Direct video files — signal with a special prefix the caller checks
        if (/\.(mp4|webm|ogg|mov|mkv)(\?|$)/i.test(url)) return `__direct__${url}`;
        return null; // unknown — open-in-tab fallback
    };

    window.previewExerciseVideo = (url, name, triggerEl) => {
        // Remove any existing popover
        document.getElementById('video-preview-overlay')?.remove();
        if (!url) return;

        const { embedUrl, ytId, isYt } = getVideoEmbedInfo(url);
        const isDirectVideo = embedUrl?.startsWith('__direct__');
        const directSrc     = isDirectVideo ? embedUrl.slice(10) : null;
        const isShort       = isYt && /youtube\.com\/shorts\//i.test(url);

        let playerHtml;
        if (isShort) {
            // YouTube Shorts don't support inline iframe playback — they redirect to YouTube
            // on click regardless of embed settings. Show a thumbnail + tap-to-watch card instead.
            const thumb    = `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`;
            const watchUrl = url.split('?')[0]; // strip tracking params
            playerHtml = `
                <a href="${watchUrl}" target="_blank" rel="noopener"
                   style="display:block;position:relative;aspect-ratio:9/16;max-height:340px;
                          background:#000;overflow:hidden;text-decoration:none;cursor:pointer">
                    <img src="${thumb}" alt="${name}"
                         style="width:100%;height:100%;object-fit:cover;opacity:.85;display:block">
                    <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
                        <div style="width:56px;height:56px;background:rgba(255,0,0,.9);border-radius:50%;
                                    display:flex;align-items:center;justify-content:center;
                                    box-shadow:0 4px 20px rgba(0,0,0,.6)">
                            <svg width="22" height="22" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>
                        </div>
                    </div>
                </a>
                <div style="padding:.4rem .75rem;background:#0a0a0a;text-align:center">
                    <span style="color:rgba(255,219,137,.4);font-size:.68rem">
                        YouTube Shorts — toca para ver
                    </span>
                </div>`;
        } else if (isDirectVideo) {
            playerHtml = `<video style="width:100%;display:block;aspect-ratio:16/9;background:#000"
                src="${directSrc}" controls autoplay playsinline></video>`;
        } else if (embedUrl) {
            // Regular YouTube, Vimeo, Google Drive — embed directly
            playerHtml = `<div style="aspect-ratio:16/9;position:relative;background:#000">
                <iframe src="${embedUrl}" style="position:absolute;inset:0;width:100%;height:100%;border:0"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                    allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>
            </div>`;
        } else {
            playerHtml = `<div style="padding:1.5rem;text-align:center">
                <p style="color:rgba(255,219,137,.5);font-size:.8125rem;margin-bottom:.75rem">
                    No se puede reproducir este enlace directamente.</p>
                <a href="${url}" target="_blank" rel="noopener noreferrer"
                    style="display:inline-flex;align-items:center;gap:.4rem;padding:.5rem 1.1rem;
                           background:#FFDB89;color:#030303;border-radius:.5rem;font-weight:700;font-size:.8125rem">
                    <i class="fas fa-external-link-alt"></i>Abrir en nueva pestaña</a>
            </div>`;
        }

        // Build the floating card
        const CARD_W = 340;
        const card   = document.createElement('div');
        card.id      = 'video-preview-overlay';
        card.style.cssText = `position:fixed;z-index:9998;width:${CARD_W}px;
            background:#1C1C1E;border:1px solid rgba(255,219,137,.22);
            border-radius:1rem;box-shadow:0 12px 40px rgba(0,0,0,.7);overflow:hidden;`;
        card.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;
                        padding:.625rem .875rem;border-bottom:1px solid rgba(255,219,137,.12)">
                <span style="font-weight:700;color:#FFDB89;font-size:.875rem;
                             white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1">
                    ${name || 'Video'}</span>
                <button id="close-video-preview"
                    style="margin-left:.5rem;color:rgba(255,219,137,.4);background:none;border:none;
                           cursor:pointer;font-size:1rem;line-height:1;padding:0"
                    onmouseover="this.style.color='#FFDB89'" onmouseout="this.style.color='rgba(255,219,137,.4)'">
                    <i class="fas fa-times"></i></button>
            </div>
            ${playerHtml}`;
        document.body.appendChild(card);

        // Smart positioning near the trigger button
        const vw = window.innerWidth, vh = window.innerHeight;
        const CARD_H = 240; // approximate (header ~40px + 16:9 video ~190px)
        let top, left;
        if (triggerEl) {
            const r = triggerEl.getBoundingClientRect();
            // Prefer left side; fall back to right, then below
            if (r.left - CARD_W - 10 >= 0) {
                left = r.left - CARD_W - 8;
                top  = r.top;
            } else if (r.right + CARD_W + 10 <= vw) {
                left = r.right + 8;
                top  = r.top;
            } else {
                left = Math.max(8, Math.min(r.left, vw - CARD_W - 8));
                top  = r.bottom + 8;
            }
            // Keep within vertical viewport
            top = Math.max(8, Math.min(top, vh - CARD_H - 8));
        } else {
            // No anchor — centre it
            top  = vh / 2 - CARD_H / 2;
            left = vw / 2 - CARD_W / 2;
        }
        card.style.top  = top  + 'px';
        card.style.left = left + 'px';

        const closeCard = () => {
            card.remove();
            document.removeEventListener('click', onOutside);
        };

        // Close button
        card.querySelector('#close-video-preview').addEventListener('click', closeCard);

        // Click outside to close (defer one tick so the triggering click doesn't immediately close it)
        const onOutside = (e) => {
            if (!card.contains(e.target)) closeCard();
        };
        setTimeout(() => document.addEventListener('click', onOutside), 0);
    };

    // MODAL ACTIONS
    window.openVideoModalForEditor = (id) => {
        currentEditorExId = id;
        const ex = editorExercises.find(e => e.id === id);
        document.getElementById('video-url-input').value = ex ? ex.videoUrl : "";
        const titleEl = document.getElementById('video-modal-title');
        const nameInput = document.getElementById('video-library-name');
        const displayName = ex?.name?.trim() || 'Añadir Video URL';
        if (titleEl) titleEl.textContent = displayName;
        if (nameInput) nameInput.value = ex?.name?.trim() || '';
        document.getElementById('video-upload-modal').classList.remove('hidden');
        initVideoNameAutocomplete();
    };

    // Single smart save: saves to library if name is filled, otherwise just applies URL
    window.saveEditorVideoSmart = async () => {
        const url  = (document.getElementById('video-url-input')?.value  || '').trim();
        const name = (document.getElementById('video-library-name')?.value || '').trim();
        if (!url) { showToast('Por favor ingresa una URL de video.', 'error'); return; }
        if (name) {
            await window.saveEditorVideoToLibrary();
        } else {
            window.saveEditorVideo();
        }
    };

    window.saveEditorVideo = () => {
        captureEditorSnapshot();
        const url = document.getElementById('video-url-input').value.trim();
        if (currentEditorExId === 'warmup') {
            editorWarmupVideoUrl = url;
        } else if (currentEditorExId === 'cooldown') {
            editorCooldownVideoUrl = url;
        } else if (typeof currentEditorExId === 'string' && currentEditorExId.startsWith('warmup-item-')) {
            const id = Number(currentEditorExId.replace('warmup-item-', ''));
            const item = editorWarmupItems.find(i => i.id === id);
            if (item) item.videoUrl = url;
        } else if (typeof currentEditorExId === 'string' && currentEditorExId.startsWith('cooldown-item-')) {
            const id = Number(currentEditorExId.replace('cooldown-item-', ''));
            const item = editorCooldownItems.find(i => i.id === id);
            if (item) item.videoUrl = url;
        } else if (currentEditorExId) {
            const ex = editorExercises.find(e => e.id === currentEditorExId);
            if (ex) ex.videoUrl = url;
        }
        currentEditorExId = null;
        document.getElementById('video-upload-modal').classList.add('hidden');
        renderWorkoutEditorUI();
        window.markEditorDirty();
    };

    // Save video URL to library from client workout editor
    window.saveEditorVideoToLibrary = async () => {
        const url  = (document.getElementById('video-url-input')?.value  || '').trim();
        const name = (document.getElementById('video-library-name')?.value || '').trim();
        if (!url)  { showToast('Por favor ingresa una URL de video.', 'error'); return; }
        if (!name) { showToast('Por favor ingresa un nombre para guardar en la librería.', 'error'); return; }
        if (!await checkVideoDuplicate(url, name)) {
            // Exact duplicate already notified — just apply URL normally
            window.saveEditorVideo();
            return;
        }
        try {
            const res = await apiFetch('/api/library', {
                method: 'POST',
                body: JSON.stringify({ name, videoUrl: url, category: ['General'] })
            });
            if (res.ok) {
                const savedEx = await res.json();
                const idx = globalExerciseLibrary.findIndex(e => e.name === savedEx.name);
                if (idx > -1) globalExerciseLibrary[idx] = savedEx;
                else globalExerciseLibrary.push(savedEx);

                // Sync URL into any other exercises in the current editor that share the same name
                editorExercises = editorExercises.map(ex =>
                    (!ex.videoUrl && ex.name?.toLowerCase() === name.toLowerCase())
                        ? { ...ex, videoUrl: url }
                        : ex
                );

                const toast = document.createElement('div');
                toast.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 z-[200] bg-[#1C1C1E] border border-[#FFDB89]/30 text-[#FFDB89] text-sm font-bold px-5 py-2.5 rounded-full shadow-xl pointer-events-none';
                toast.innerHTML = `<i class="fas fa-bookmark mr-2 text-[#FFDB89]"></i>"${name}" guardado en la librería`;
                document.body.appendChild(toast);
                setTimeout(() => toast.remove(), 2500);
            }
        } catch(e) { console.error('Error saving to library:', e); }
        // Also apply to current exercise context
        window.saveEditorVideo();
    };

    window.openWarmupVideoModal = () => {
        currentEditorExId = 'warmup';
        document.getElementById('video-url-input').value = editorWarmupVideoUrl || '';
        const titleEl   = document.getElementById('video-modal-title');
        const nameInput = document.getElementById('video-library-name');
        if (titleEl)   titleEl.textContent = 'Calentamiento — Video URL';
        if (nameInput) nameInput.value = 'Calentamiento';
        document.getElementById('video-upload-modal').classList.remove('hidden');
        initVideoNameAutocomplete();
    };

    window.openHistoryModal = (id) => {
        document.getElementById('history-modal').classList.remove('hidden');
    };

    window.saveDayWorkout = async () => {
        await window.performWorkoutSave(false);
    };

    window._saveDayWorkoutLegacy = async () => {

        if(!currentClientViewId) {
            showToast('Error: No hay cliente seleccionado. Por favor abre el calendario de un cliente primero.', 'error');
            console.error("currentClientViewId is null/undefined");
            return;
        }
        
        const titleInput = document.getElementById('workout-title-input');
        
        const workoutData = {
            clientId: currentClientViewId,
            date: editorDateStr,
            title: titleInput?.value || editorDateStr,
            warmup: editorWarmup,
            warmupVideoUrl: editorWarmupVideoUrl,
            cooldown: editorCooldown,
            exercises: editorExercises.map(ex => ({
                id: ex.id,
                name: ex.name,
                instructions: ex.instructions || '',
                videoUrl: ex.videoUrl || '',
                isSuperset: ex.isSuperset || false,
                supersetHead: ex.supersetHead || false
            }))
        };

        try {
            const response = await apiFetch('/api/client-workouts', {
                method: 'POST',
                body: JSON.stringify(workoutData)
            });
            
            if(response.ok) {
                const savedWorkout = await response.json();

                const cell = document.getElementById(`day-${editorDateStr}`);
                if(cell) {
                    const area = cell.querySelector('.content-area');
                    area.innerHTML = `
                        <div class="workout-card flex items-center gap-3 cursor-pointer group/wk" onclick="window.loadWorkoutForEditing('${editorDateStr}', '${currentClientViewId}')">
                            <div class="font-bold">${workoutData.title}</div>
                            <div class="text-gray-400">${editorExercises.length} ejercicios</div>
                        </div>
                    `;
                    // Show copy checkbox for this newly saved day
                    const cb = cell.querySelector('.copy-day-checkbox');
                    if(cb) cb.classList.remove('hidden');
                }

                document.getElementById('workout-editor-modal').classList.add('hidden');
                showToast('Workout guardado exitosamente.', 'success');
            } else {
                const errorText = await response.text();
                console.error("Server error:", errorText);
                showToast('Error al guardar workout.', 'error');
            }
        } catch(e) {
            console.error("Fetch error:", e);
            showToast('Error de conexión.', 'error');
        }
    };

    window.loadWorkoutForEditing = async (dateStr, clientId) => {
        try {
            const response = await apiFetch(`/api/client-workouts/${clientId}/${dateStr}`);
            if(response.ok) {
                const workout = await response.json();
                
                // Populate editor state
                editorDateStr = dateStr;
                editorWarmup = workout.warmup || '';
                editorWarmupVideoUrl = workout.warmupVideoUrl || '';
                editorCooldown = workout.cooldown || '';
                editorExercises = workout.exercises || [];
                
                // Open editor with loaded data
                openWorkoutEditor(dateStr);
            }
        } catch(e) {
            console.error('Error loading workout:', e);
        }
    };

    window.assignProgramToClient = async (programId, startDate) => {
        try {
            const progResponse = await apiFetch('/api/programs');
            const programs = await progResponse.json();
            const program = programs.find(p => p._id === programId);
            if (!program) { showToast('Programa no encontrado.', 'error'); return; }

            document.getElementById('program-assignment-modal')?.remove();

            const { created, skipped } = await pushProgramToCalendar(program, currentClientViewId, startDate);

            const skipNote = skipped > 0 ? ` (${skipped} día${skipped > 1 ? 's' : ''} ya tenían rutina)` : '';
            showToast(`✓ ${program.name} asignado. ${created} día${created !== 1 ? 's' : ''} cargado${created !== 1 ? 's' : ''} al calendario.${skipNote}`, 'success', 5000);

            openClientProfile(currentClientViewId);
        } catch(e) {
            console.error(e);
            showToast('Error asignando programa.', 'error');
        }
    };

    // =============================================================================
    // 8. EVENT DELEGATION
    // =============================================================================
    
    document.addEventListener('click', async (e) => {
        // Close filter dropdown when clicking outside it
        const filterDropdown = document.getElementById('client-filter-dropdown');
        const filterBtn = document.getElementById('client-filter-btn');
        if (filterDropdown && filterBtn &&
            !filterDropdown.classList.contains('hidden') &&
            !filterBtn.contains(e.target) &&
            !filterDropdown.contains(e.target)) {
            filterDropdown.classList.add('hidden');
        }

        const target = e.target.closest('a, button, [id], .program-card, .open-video-modal, .client-row, .action-add, .action-nutri, .action-view, .action-rest, .action-active-rest, .action-copy, .action-paste, .pill-option, .toggle-switch, .cal-action-btn');
        if (!target) return;

        if (target.id === 'theme-toggle' || target.closest('#theme-toggle')) { 
            e.preventDefault(); 
            const isDark = document.documentElement.classList.toggle('dark');
            localStorage.setItem('theme', isDark ? 'dark' : 'light');
            updateThemeIcon();
            return; 
        }

        if (target.id === 'logout-btn' || target.closest('#logout-btn')) {
            const confirmed = await showConfirm('¿Estás seguro que quieres cerrar sesión?', {
                confirmLabel: 'Cerrar sesión',
                cancelLabel: 'Cancelar',
                danger: true
            });
            if (!confirmed) return;
            // H-2: Tell server to clear the HttpOnly cookie, then wipe local state
            fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).finally(() => {
                localStorage.removeItem('auth_user');
                location.reload();
            });
            return;
        }

        if (target.classList.contains('cal-action-btn')) {
              
            handleCalendarAction(target.dataset.action, target.dataset.date);
            return;
        }

        // Handle mobile action button clicks
        if (target.classList.contains('mobile-action-btn')) {
            e.stopPropagation();
            handleCalendarAction(target.dataset.action, target.dataset.date);
            return;
        }

        const navLink = target.closest('.nav-link-item');
        if (navLink) {
            e.preventDefault();
            const linkText = navLink.querySelector('.nav-text').textContent.trim();
            let moduleToLoad = null;

            if (linkText.includes('Notificaciones')) moduleToLoad = 'notifications_content';
            else if (linkText === 'Inicio' || linkText === document.getElementById('trainer-name')?.textContent.trim()) {
                const session = loadSession();
                moduleToLoad = (session?.role === 'client') ? 'client_inicio' : 'trainer_home';
            }
            else if (linkText === 'Clientes') moduleToLoad = 'clientes_content';
            else if (linkText === 'Programas') moduleToLoad = 'programas_content';
            else if (linkText === 'Ajustes') { moduleToLoad = 'ajustes_content'; } 
            else if (linkText === 'Pagos') moduleToLoad = 'pagos_content';
            else if (linkText.includes('Mis programas')) moduleToLoad = 'client_programas';
            else if (linkText.includes('Métricas')) moduleToLoad = 'client_metricas';
            else if (linkText.includes('Nutrición')) moduleToLoad = 'client_nutricion';
            else if (linkText.includes('Equipo')) moduleToLoad = 'client_equipo';
            else if (linkText.includes('Fotos')) moduleToLoad = 'client_progress';
            else if (linkText.includes('Cronómetro')) moduleToLoad = 'client_clock';
            
            if (moduleToLoad) {
                try {
                    const res = await fetch(`${moduleToLoad}.html`);
                    if(res.ok) {
                        const html = await res.text();
                        const contentTitle = (moduleToLoad === 'trainer_home' || moduleToLoad === 'client_inicio' || moduleToLoad === 'clientes_content' || moduleToLoad === 'pagos_content') ? '' : linkText;
                        updateContent(contentTitle, html);
                        if (moduleToLoad === 'clientes_content') { renderClientsTable(); attachClientFilterListeners(); }
                        if (moduleToLoad === 'programas_content') {
                            await Promise.all([fetchProgramsFromDB(), clientsCache.length === 0 ? fetchClientsFromDB() : Promise.resolve()]);
                            renderProgramsList();
                            // Wire up the tab bar and pre-render exercise/video library
                            switchLibraryTab('tab-programas');
                            window.renderExerciseLibrary();
                            window.renderVideoLibrary();
                        }
                        if (moduleToLoad === 'notifications_content') {
                            currentNotifFilter = '7days';
                            fetchAndRenderNotifications('7days');
                            fetchNotificationCount();
                            setTimeout(() => {
                                const markAllBtn = document.getElementById('mark-all-read-btn');
                                if (markAllBtn) markAllBtn.addEventListener('click', window.markAllNotificationsRead);
                                const btn7 = document.getElementById('notif-filter-7days');
                                const btnU = document.getElementById('notif-filter-unread');
                                const setActive = (active, inactive) => {
                                    active.classList.add('bg-[#FFDB89]', 'text-[#2C2C2E]', 'shadow');
                                    active.classList.remove('bg-[#030303]/60', 'text-[#FFDB89]', 'border', 'border-[#FFDB89]/30');
                                    inactive.classList.remove('bg-[#FFDB89]', 'text-[#2C2C2E]', 'shadow');
                                    inactive.classList.add('bg-[#030303]/60', 'text-[#FFDB89]', 'border', 'border-[#FFDB89]/30');
                                };
                                if (btn7) btn7.addEventListener('click', () => { setActive(btn7, btnU); fetchAndRenderNotifications('7days'); });
                                if (btnU) btnU.addEventListener('click', () => { setActive(btnU, btn7); fetchAndRenderNotifications('unread'); });
                            }, 100);
                        }
                        if (moduleToLoad === 'pagos_content') renderPaymentsView();
                        if (moduleToLoad === 'client_metricas') initClientMetrics();
                        if (moduleToLoad === 'client_equipo') renderEquipmentOptions();
                        if (moduleToLoad === 'client_nutricion') initClientNutrition();
                        if (moduleToLoad === 'client_progress') initClientProgress();
                        if (moduleToLoad === 'client_programas') initClientPrograms();
                        if (moduleToLoad === 'client_clock') window.initClockModule();
                        if (moduleToLoad === 'trainer_home') renderTrainerHome(loadSession().name);
                        if (moduleToLoad === 'client_inicio') initClientHome();
                        if (moduleToLoad === 'ajustes_content') initSettings();
                    }
                } catch(e) { console.error(e); }
            }
            return;
        }

        // ... (Remaining handlers kept)
        if (target.id === 'add-new-exercise-btn') { document.getElementById('add-exercise-modal').classList.remove('hidden'); return; }
        if (target.id === 'close-exercise-modal-x' || target.id === 'cancel-exercise-btn') { document.getElementById('add-exercise-modal').classList.add('hidden'); return; }
        if (target.id === 'save-exercise-db-btn') { window.handleSaveNewExercise(); return; }
        if (target.id === 'save-new-client-btn') { window.handleSaveClient(); return; }
        if (target.id === 'close-add-client-modal' || target.id === 'cancel-add-client') { document.getElementById('add-client-modal').classList.add('hidden'); return; }
        if (target.id === 'open-add-client-modal') {
            currentClientViewId = null;
            document.querySelector('#add-client-modal h2').textContent = "Nuevo cliente";
            document.getElementById('save-new-client-btn').textContent = "Guardar cliente";
            document.getElementById('new-client-name').value = "";
            document.getElementById('new-client-lastname').value = "";
            document.getElementById('new-client-email').value = "";
            document.getElementById('add-client-modal').classList.remove('hidden');
            populateTimezones();
            renderGroupOptions();
            renderProgramOptions();
            wireHeartRateCalc();
            // Reset invite toggle to ON for every new client
            const invToggle = document.getElementById('send-invite-toggle');
            const invBtn = document.getElementById('send-invite-btn');
            if (invToggle) {
                invToggle.dataset.on = 'true';
                invToggle.classList.add('bg-[#FFDB89]/20');
                invToggle.classList.remove('bg-white/10');
                invToggle.querySelector('div').classList.add('translate-x-5');
                invToggle.querySelector('div').classList.remove('translate-x-0');
            }
            if (invBtn) {
                invBtn.disabled = false;
                invBtn.classList.remove('opacity-40', 'cursor-not-allowed', 'bg-gray-600');
                invBtn.classList.add('bg-green-500', 'hover:bg-green-600');
            }
            return;
        }
        if (target.id === 'open-group-modal') { document.getElementById('add-group-modal').classList.remove('hidden'); return; }
        if (target.id === 'close-group-modal') { document.getElementById('add-group-modal').classList.add('hidden'); return; }
        if (target.id === 'save-group-btn') {
            const groupName = document.getElementById('new-group-name').value.trim();
            if (groupName) {
                try {
                    const res = await apiFetch('/api/groups', {
                        method: 'POST',
                        body: JSON.stringify({ name: groupName })
                    });
                    if (res.ok) {
                        groupsCache.push(groupName);
                        document.getElementById('add-group-modal').classList.add('hidden');
                        document.getElementById('new-group-name').value = '';
                        showToast(`Grupo "${groupName}" creado.`, 'success');
                    } else {
                        const err = await res.json();
                        showToast(err.message || 'Error al crear grupo', 'error');
                    }
                } catch (e) { showToast('Error al crear grupo', 'error'); }
            } else { showToast("Por favor ingresa un nombre de grupo.", 'error'); }
            return;
        }

        if (target.classList.contains('delete-program-btn')) {
            e.stopPropagation();
            const progId = target.dataset.id;
            const prog = programsCache.find(p => (p._id == progId) || (p.id == progId));
            if (!prog) return;
            const yes = await showConfirm(`¿Borrar "${prog.name}"? Esta acción no se puede deshacer.`, { confirmLabel: 'Eliminar', danger: true });
            if (!yes) return;
            apiFetch(`/api/programs/${progId}`, { method: 'DELETE' })
                .then(res => {
                    if (res.ok) {
                        programsCache = programsCache.filter(p => (p._id != progId) && (p.id != progId));
                        renderProgramsList();
                    } else {
                        showToast('Error al borrar el programa.', 'error');
                    }
                })
                .catch(() => showToast('Error de conexión.', 'error'));
            return;
        }
        if (target.classList.contains('program-card')) { openProgramBuilder(target.dataset.id); return; }
        if (target.id === 'open-create-program-modal') { document.getElementById('create-program-modal').classList.remove('hidden'); return; }
        if (target.id === 'save-and-add-workouts') { handleCreateProgram(); return; }
        if (target.id === 'cancel-create-program') { document.getElementById('create-program-modal').classList.add('hidden'); return; }
        if (target.id === 'back-to-program-list') { document.getElementById('program-builder-view').classList.add('hidden'); document.getElementById('programs-main-view').classList.remove('hidden'); return; }
        if (target.id === 'add-week-btn') { addWeekToCalendar(); return; }
        if (target.classList.contains('action-nutri')) {
            const weekBlocks = Array.from(document.querySelectorAll('.week-block'));
            const weekIndex = weekBlocks.indexOf(target.closest('.week-block'));
            openDayNutrition(target.dataset.day, weekIndex);
            return;
        }
        if (target.classList.contains('action-add')) {
            const weekBlocks = Array.from(document.querySelectorAll('.week-block'));
            currentEditingWeekIndex = weekBlocks.indexOf(target.closest('.week-block'));
            currentEditingDay = target.dataset.day;
            openExerciseBuilder(target.dataset.day);
            return;
        }
        if (target.classList.contains('action-view')) {
            const weekBlocks = Array.from(document.querySelectorAll('.week-block'));
            const weekIndex = weekBlocks.indexOf(target.closest('.week-block'));
            openProgramDayView(weekIndex, parseInt(target.dataset.day));
            return;
        }
        if (target.classList.contains('action-rest')) {
            const weekBlocks = Array.from(document.querySelectorAll('.week-block'));
            const weekIndex = weekBlocks.indexOf(target.closest('.week-block'));
            setRestDay(weekIndex, target.dataset.day);
            return;
        }
        if (target.classList.contains('action-active-rest')) {
            const weekBlocks = Array.from(document.querySelectorAll('.week-block'));
            const weekIndex = weekBlocks.indexOf(target.closest('.week-block'));
            setActiveRestDay(weekIndex, target.dataset.day);
            return;
        }
        if (target.classList.contains('action-copy')) {
            const prog = programsCache.find(p => (p._id == currentProgramId) || (p.id == currentProgramId));
            if (!prog) return;
            const weekBlocks = Array.from(document.querySelectorAll('.week-block'));
            const weekIndex = weekBlocks.indexOf(target.closest('.week-block'));
            const dayNum = target.dataset.day;
            const dayData = prog.weeks?.[weekIndex]?.days?.[String(dayNum)];
            if (!dayData || (!dayData.exercises?.length && !dayData.isRest && !dayData.isActiveRest)) {
                showToast('Este día no tiene contenido para copiar.', 'info');
                return;
            }
            copiedProgramDayData = JSON.parse(JSON.stringify(dayData)); // deep clone
            syncCopyPasteButtons(); // all cells → Pegar
            // Flash the cell to confirm copy
            const cell = target.closest('.relative.bg-\\[\\#1C1C1E\\]') || target.closest('[class*="h-40"]');
            if (cell) {
                cell.style.outline = '2px solid rgba(255,219,137,0.6)';
                setTimeout(() => cell.style.outline = '', 800);
            }
            // Show brief toast
            const toast = document.createElement('div');
            toast.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] bg-[#1C1C1E] border border-[#FFDB89]/30 text-[#FFDB89] text-sm font-bold px-5 py-2.5 rounded-full shadow-xl pointer-events-none';
            toast.innerHTML = '<i class="fas fa-check mr-2 text-green-400"></i>Día copiado — ahora haz clic en <strong>Pegar</strong> en otro día';
            document.body.appendChild(toast);
            setTimeout(() => toast.remove(), 2800);
            return;
        }
        if (target.classList.contains('action-paste')) {
            if (!copiedProgramDayData) return; // shouldn't happen — button only appears after copy
            const prog = programsCache.find(p => (p._id == currentProgramId) || (p.id == currentProgramId));
            if (!prog) return;
            const weekBlocks = Array.from(document.querySelectorAll('.week-block'));
            const weekIndex = weekBlocks.indexOf(target.closest('.week-block'));
            const dayNum = target.dataset.day;
            if (!prog.weeks[weekIndex]) prog.weeks[weekIndex] = { weekNumber: weekIndex + 1, days: {} };
            if (!prog.weeks[weekIndex].days) prog.weeks[weekIndex].days = {};
            const existing = prog.weeks[weekIndex].days[String(dayNum)] || {};
            // Paste the copied day but preserve any existing nutrition
            prog.weeks[weekIndex].days[String(dayNum)] = {
                ...JSON.parse(JSON.stringify(copiedProgramDayData)),
                nutrition: existing.nutrition // keep existing nutrition if any
            };
            try {
                const res = await apiFetch(`/api/programs/${prog._id || prog.id}`, { method: 'PUT', body: JSON.stringify(prog) });
                if (res.ok) {
                    const updated = await res.json();
                    const idx = programsCache.findIndex(p => (p._id == currentProgramId) || (p.id == currentProgramId));
                    if (idx > -1) programsCache[idx] = updated;
                    copiedProgramDayData = null; // clear clipboard after paste
                    renderProgramBuilder(updated); // re-renders cells as Copiar
                } else { showToast('Error al pegar el día.', 'error'); }
            } catch(e) { showToast('Error de conexión.', 'error'); }
            return;
        }
        if (target.id === 'assign-program-to-client-btn') {
            openAssignProgramModal();
            return;
        }
        if (target.id === 'cancel-routine-edit' || target.id === 'cancel-routine-btn-footer') { document.getElementById('edit-routine-modal').classList.add('hidden'); return; }
        if (target.id === 'close-nutri-modal' || target.id === 'cancel-nutri-modal-btn') { document.getElementById('day-nutrition-modal').classList.add('hidden'); return; }
        if (target.id === 'add-meal-nutri-btn') { addNutriMeal(); return; }
        if (target.id === 'save-nutri-btn') { saveDayNutrition(); return; }
        if (target.id === 'add-exercise-btn') { addExerciseToBuilder(); return; }
        if (target.id === 'save-routine-btn') { saveRoutine(); return; }

        // ── Video modal: open ──────────────────────────────────────────────────
        if (target.classList.contains('open-video-modal')) {
            currentVideoTarget = target.dataset.target || null; // 'warmup', 'cooldown', or null (exercise)
            const titleEl    = document.getElementById('video-modal-title');
            const urlInput   = document.getElementById('video-url-input');
            const nameInput  = document.getElementById('video-library-name');
            if (currentVideoTarget === 'warmup') {
                if (titleEl)   titleEl.textContent = 'Calentamiento — Video URL';
                if (urlInput)  urlInput.value = routineWarmupVideo;
                if (nameInput) nameInput.value = 'Calentamiento';
                currentVideoExerciseBtn = null;
            } else if (currentVideoTarget === 'cooldown') {
                if (titleEl)   titleEl.textContent = 'Enfriamiento — Video URL';
                if (urlInput)  urlInput.value = routineCooldownVideo;
                if (nameInput) nameInput.value = 'Enfriamiento';
                currentVideoExerciseBtn = null;
            } else {
                // Exercise video button
                currentVideoExerciseBtn = target;
                const exName = target.closest('.exercise-item')?.querySelector('.exercise-name-input')?.value?.trim();
                if (titleEl)   titleEl.textContent = exName ? `${exName} — Video` : 'Ejercicio — Video URL';
                if (urlInput)  urlInput.value = target.dataset.video || '';
                if (nameInput) nameInput.value = exName || '';
            }
            const modal = document.getElementById('video-upload-modal');
            if (modal) modal.classList.remove('hidden');
            initVideoNameAutocomplete();
            return;
        }

        // ── Video modal: save — always persists to library AND applies to context ─
        if (target.id === 'save-video-btn') {
            const url  = (document.getElementById('video-url-input')?.value  || '').trim();
            const name = (document.getElementById('video-library-name')?.value || '').trim();
            if (!url)  { showToast('Por favor ingresa una URL de video.', 'error'); return; }
            if (!name) { showToast('Por favor ingresa el nombre del ejercicio.', 'error'); return; }

            // Save to library (skip API call only if exact duplicate already exists)
            if (await checkVideoDuplicate(url, name)) {
                try {
                    const res = await apiFetch('/api/library', {
                        method: 'POST',
                        body: JSON.stringify({ name, videoUrl: url, category: ['General'] })
                    });
                    if (res.ok) {
                        const savedEx = await res.json();
                        const idx = globalExerciseLibrary.findIndex(e => e.name === savedEx.name);
                        if (idx > -1) globalExerciseLibrary[idx] = savedEx;
                        else globalExerciseLibrary.push(savedEx);
                        window.renderVideoLibrary();
                        window.renderExerciseLibrary();
                    }
                } catch(e) { console.error('Error saving to library:', e); }
            }

            // Apply URL to whichever context opened the modal
            if (currentVideoTarget === 'warmup') {
                routineWarmupVideo = url;
                const btn = document.getElementById('warmup-video-btn');
                if (btn) { btn.classList.toggle('text-[#FFDB89]', !!url); btn.classList.toggle('text-[#FFDB89]/40', !url); }
            } else if (currentVideoTarget === 'cooldown') {
                routineCooldownVideo = url;
                const btn = document.getElementById('cooldown-video-btn');
                if (btn) { btn.classList.toggle('text-[#FFDB89]', !!url); btn.classList.toggle('text-[#FFDB89]/40', !url); }
            } else if (typeof currentVideoTarget === 'string' && currentVideoTarget.startsWith('routine-warmup-item-')) {
                const id = Number(currentVideoTarget.replace('routine-warmup-item-', ''));
                const item = routineWarmupItems.find(i => i.id === id);
                if (item) { item.videoUrl = url; renderRoutineItems(); }
            } else if (typeof currentVideoTarget === 'string' && currentVideoTarget.startsWith('routine-cooldown-item-')) {
                const id = Number(currentVideoTarget.replace('routine-cooldown-item-', ''));
                const item = routineCooldownItems.find(i => i.id === id);
                if (item) { item.videoUrl = url; renderRoutineItems(); }
            } else if (currentVideoTarget !== 'library-standalone' && currentVideoExerciseBtn) {
                currentVideoExerciseBtn.dataset.video = url;
                currentVideoExerciseBtn.classList.toggle('text-[#FFDB89]', !!url);
                currentVideoExerciseBtn.classList.toggle('text-[#FFDB89]/40', !url);
            }

            showToast(`"${name}" guardado en la librería.`, 'success');
            currentVideoTarget = null;
            currentVideoExerciseBtn = null;
            document.getElementById('video-upload-modal')?.classList.add('hidden');
            return;
        }

        // ── Video modal: cancel ────────────────────────────────────────────────
        if (target.id === 'cancel-video-btn') {
            currentVideoTarget = null;
            currentVideoExerciseBtn = null;
            const modal = document.getElementById('video-upload-modal');
            if (modal) modal.classList.add('hidden');
            return;
        }
        
        if (target.id === 'toggle-optional-info' || target.closest('#toggle-optional-info')) {
            const content = document.getElementById('optional-info-content');
            const icon = document.getElementById('optional-info-icon');
            if(content) {
                content.classList.toggle('hidden');
                if (content.classList.contains('hidden')) { icon.classList.remove('rotate-180'); } 
                else { icon.classList.add('rotate-180'); }
            }
            return;
        }
        
        if (target.id === 'back-to-clients-btn') {
            const res = await fetch('clientes_content.html');
            if(res.ok) {
                const html = await res.text();
                updateContent('', html);
                renderClientsTable();
                attachClientFilterListeners();
            }
            return;
        }

        if (target.classList.contains('pill-option')) {
            e.preventDefault();
            const group = target.dataset.group;
            const val = target.dataset.val;
            document.querySelectorAll(`.pill-option[data-group="${group}"]`).forEach(b => {
                b.classList.remove('active', 'text-white', 'text-[#030303]', 'bg-[#FFDB89]');
                b.classList.add('text-[#FFDB89]/50');
            });
            target.classList.add('active', 'text-[#030303]', 'bg-[#FFDB89]');
            target.classList.remove('text-[#FFDB89]/50');
            if (group === 'units') {
                const heightImp = document.getElementById('height-imperial');
                const heightMet = document.getElementById('height-metric');
                const weightLabel = document.getElementById('weight-unit-label');
                if (val === 'metric') {
                    if (heightImp) heightImp.classList.add('hidden');
                    if (heightMet) heightMet.classList.remove('hidden');
                    if (weightLabel) weightLabel.textContent = 'kg';
                } else {
                    if (heightImp) heightImp.classList.remove('hidden');
                    if (heightMet) heightMet.classList.add('hidden');
                    if (weightLabel) weightLabel.textContent = 'lbs';
                }
            }
            return;
        }

        if (target.classList.contains('toggle-switch')) {
            e.preventDefault();
            const isOn = target.dataset.on === 'true';
            target.dataset.on = !isOn;
            const thumb = target.querySelector('div');
            if (!isOn) {
                target.classList.remove('bg-white/10'); target.classList.add('bg-[#FFDB89]/20');
                thumb.classList.add('translate-x-5'); thumb.classList.remove('translate-x-0');
            } else {
                target.classList.add('bg-white/10'); target.classList.remove('bg-[#FFDB89]/20');
                thumb.classList.remove('translate-x-5'); thumb.classList.add('translate-x-0');
            }
            // If this is the invite toggle, update the invite button state
            if (target.id === 'send-invite-toggle') {
                const inviteBtn = document.getElementById('send-invite-btn');
                if (inviteBtn) {
                    const nowOn = target.dataset.on === 'true';
                    inviteBtn.disabled = !nowOn;
                    inviteBtn.classList.toggle('opacity-40', !nowOn);
                    inviteBtn.classList.toggle('cursor-not-allowed', !nowOn);
                    inviteBtn.classList.toggle('bg-green-500', nowOn);
                    inviteBtn.classList.toggle('hover:bg-green-600', nowOn);
                    inviteBtn.classList.toggle('bg-gray-600', !nowOn);
                }
            }
            return;
        }

        const collapseBtn = target.closest('#collapse-btn');
        if (collapseBtn) {
            const sidebar = document.getElementById('sidebar');
            const icon = collapseBtn.querySelector('svg') || collapseBtn.querySelector('i');
            if (!sidebar) return;
            const isCollapsed = sidebar.classList.contains('w-20');
            if (isCollapsed) {
                sidebar.classList.remove('w-20'); sidebar.classList.add('w-60');
                sidebar.querySelectorAll('.nav-text').forEach(span => span.classList.remove('hidden'));
                if (icon) icon.style.transform = 'rotate(0deg)';
            } else {
                sidebar.classList.remove('w-60'); sidebar.classList.add('w-20');
                sidebar.querySelectorAll('.nav-text').forEach(span => span.classList.add('hidden'));
                if (icon) icon.style.transform = 'rotate(180deg)';
            }
            return;
        }

        // ── Library tab switching ──────────────────────────────────────────────
        if (target.id === 'tab-programas')  { switchLibraryTab('tab-programas');  return; }
        if (target.id === 'tab-ejercicios') { switchLibraryTab('tab-ejercicios'); return; }
        if (target.id === 'tab-videos')     { switchLibraryTab('tab-videos');     return; }
        // Legacy library_content.html buttons (kept for backwards compat)
        if (target.id === 'toggle-programs-view')  { switchLibraryTab('tab-programas');  return; }
        if (target.id === 'toggle-exercises-view') { switchLibraryTab('tab-ejercicios'); return; }
        // Close nutrition search dropdowns when clicking outside
        if (!target.closest('.nutri-search-input') && !target.closest('[class*="nutri-drop-"]')) {
            document.querySelectorAll('[class*="nutri-drop-"]').forEach(d => d.classList.add('hidden'));
        }
    });

    // Right-click context menu for copy workout
    document.addEventListener('contextmenu', async (e) => {
        const dayCell = e.target.closest('.day-cell');
        if(!dayCell || !currentClientViewId) return;
        
        e.preventDefault();
        
        const dateId = dayCell.id;
        const dateStr = dateId.replace('day-', '');
        
        // Check if there's a workout on this day
        const hasWorkout = dayCell.querySelector('.content-area').innerHTML.includes('ejercicios');
        
        if(hasWorkout) {
            const confirmed = await showConfirm('¿Copiar este workout?', { confirmLabel: 'Copiar', danger: false });
            if(confirmed) {
                window.copyWorkout(dateStr, currentClientViewId);
            }
        }
    });


    applyThemePreferenceEarly();
    injectGlobalStyles();
    const user = loadSession();
    if (user) loadData();   // Only fetch data if someone is logged in
    router(user);
    
    // ... (Clock Logic kept same) ...
    // CLOCK LOGIC
    let clockIntervalId = null; let stopwatchInterval = null; let timerInterval = null; let clockMode = 'CLOCK'; let stopwatchTime = 0; let timerTime = 0; let isClockRunning = false; let clockCanvas = null; let clockCtx = null; let clockIs24hr = true;
    // Auto-fit the clock face to whatever space is available
    const fitClockToContainer = () => {
        const root  = document.getElementById('clock-module-root');
        const inner = document.querySelector('.clock-inner-container');
        if (!root || !inner) return;
        // Reserve ~120px for the controls below the clock face
        const availW = root.offsetWidth;
        const availH = root.offsetHeight - 120;
        const scale  = Math.min(availW / 800, availH / 800, 0.75);
        // transform: scale() doesn't affect layout — compensate with negative margins
        const deadPx = Math.round(800 * (1 - scale) / 2);
        inner.style.transform    = `scale(${scale})`;
        inner.style.marginTop    = `-${deadPx}px`;
        inner.style.marginBottom = `-${deadPx}px`;
    };

    window.initClockModule = function() {
        clockCanvas = document.getElementById('clockCanvas');
        if (!clockCanvas) return;
        clockCtx = clockCanvas.getContext('2d');
        clockMode = 'CLOCK'; stopwatchTime = 0; timerTime = 0; isClockRunning = false;
        if (stopwatchInterval) clearInterval(stopwatchInterval);
        if (timerInterval)     clearInterval(timerInterval);
        if (clockIntervalId)   cancelAnimationFrame(clockIntervalId);
        const actionBtn = document.getElementById('actionBtn');
        if (actionBtn) actionBtn.innerText = clockIs24hr ? '→ 12H' : '→ 24H';
        fitClockToContainer();
        // Re-fit on resize (e.g. rotating the phone)
        window.removeEventListener('resize', fitClockToContainer);
        window.addEventListener('resize', fitClockToContainer);
        window.clockDrawLoop();
    };
    window.clockSetMode = function(mode) { clockMode = mode; const modeLabel = document.getElementById('modeLabel'); const timerInputArea = document.getElementById('timerInputArea'); const actionBtn = document.getElementById('actionBtn'); const timeDisplay = document.getElementById('timeDisplay'); const modeLabels = { CLOCK: 'Reloj', STOPWATCH: 'Cronómetro', TIMER: 'Cuenta Regresiva' }; if(modeLabel) modeLabel.innerText = modeLabels[mode] || mode; window.clockResetLogic(); if (mode === 'TIMER') { if(timerInputArea) timerInputArea.style.display = 'block'; if(timeDisplay) timeDisplay.innerText = "00:00"; } else { if(timerInputArea) timerInputArea.style.display = 'none'; } if(actionBtn) actionBtn.innerText = (mode === 'CLOCK') ? (clockIs24hr ? '→ 12H' : '→ 24H') : 'Iniciar'; };
    window.clockHandleAction = function() { if (clockMode === 'CLOCK') { clockIs24hr = !clockIs24hr; const actionBtn = document.getElementById('actionBtn'); if(actionBtn) actionBtn.innerText = clockIs24hr ? '→ 12H' : '→ 24H'; return; } if (isClockRunning) window.clockStopLogic(); else window.clockStartLogic(); };
    window.clockStartLogic = function() { const actionBtn = document.getElementById('actionBtn'); const timerInput = document.getElementById('timerInput'); isClockRunning = true; if(actionBtn) actionBtn.innerText = "Parar"; if (clockMode === 'STOPWATCH') { const startTime = Date.now() - stopwatchTime; stopwatchInterval = setInterval(() => { stopwatchTime = Date.now() - startTime; window.clockUpdateDisplay(stopwatchTime); }, 100); } else if (clockMode === 'TIMER') { if (timerTime === 0) timerTime = parseInt(timerInput ? timerInput.value || 0 : 0) * 1000; const endTime = Date.now() + timerTime; timerInterval = setInterval(() => { timerTime = endTime - Date.now(); if (timerTime <= 0) { timerTime = 0; clearInterval(timerInterval); showToast("¡Se acabó el tiempo!", 'info'); window.clockResetLogic(); } window.clockUpdateDisplay(timerTime); }, 100); } };
    window.clockStopLogic = function() { isClockRunning = false; const actionBtn = document.getElementById('actionBtn'); if(actionBtn) actionBtn.innerText = "Iniciar"; clearInterval(stopwatchInterval); clearInterval(timerInterval); };
    window.clockResetLogic = function() { window.clockStopLogic(); stopwatchTime = 0; timerTime = 0; const timeDisplay = document.getElementById('timeDisplay'); if (clockMode !== 'CLOCK' && timeDisplay) timeDisplay.innerText = "00:00"; };
    window.clockUpdateDisplay = function(ms) { const timeDisplay = document.getElementById('timeDisplay'); if(!timeDisplay) return; const totalSeconds = Math.floor(ms / 1000); const m = Math.floor(totalSeconds / 60).toString().padStart(2, '0'); const s = (totalSeconds % 60).toString().padStart(2, '0'); timeDisplay.innerText = `${m}:${s}`; };
    window.clockDrawLoop = function() { if(!document.getElementById('clockCanvas')) return; const centerX = 400; const centerY = 400; clockCtx.clearRect(0, 0, 800, 800); window.clockDrawGear(clockCtx, centerX, centerY, 12, 360, 320, 40, 'rgba(255,219,137,0.12)'); clockCtx.fillStyle = "rgba(255,219,137,0.5)"; clockCtx.font = "bold 24px Arial"; clockCtx.textAlign = "center"; for (let i = 0; i < 60; i += 5) { const angle = (i - 15) * (Math.PI * 2 / 60); const x = centerX + Math.cos(angle) * 385; const y = centerY + Math.sin(angle) * 385 + 10; clockCtx.fillText(i, x, y); } const now = new Date(); let activeSeconds = 0; if (clockMode === 'CLOCK') { activeSeconds = now.getSeconds(); const timeDisplay = document.getElementById('timeDisplay'); if(timeDisplay) { if(clockIs24hr) { timeDisplay.style.fontSize = ''; timeDisplay.innerHTML = now.toTimeString().split(' ')[0].substring(0, 5); } else { let h = now.getHours(); const m = now.getMinutes().toString().padStart(2,'0'); const ampm = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; timeDisplay.style.fontSize = ''; timeDisplay.innerHTML = `<span style="font-size:72px">${h}:${m}</span><span style="font-size:32px;vertical-align:middle;margin-left:8px;opacity:0.8">${ampm}</span>`; } } } else if (clockMode === 'STOPWATCH') { activeSeconds = Math.floor(stopwatchTime / 1000) % 60; } else if (clockMode === 'TIMER') { activeSeconds = Math.floor(timerTime / 1000) % 60; } for (let i = 0; i < 60; i++) { window.clockDrawMarker(clockCtx, centerX, centerY, i, i <= activeSeconds); } clockIntervalId = requestAnimationFrame(window.clockDrawLoop); };
    window.clockDrawGear = function(ctx, x, y, teeth, outerRadius, innerRadius, toothHeight, color) { ctx.save(); ctx.beginPath(); ctx.translate(x, y); ctx.fillStyle = color; ctx.strokeStyle = "rgba(0,0,0,0.3)"; ctx.lineWidth = 5; for (let i = 0; i < teeth; i++) { ctx.rotate(Math.PI / teeth); ctx.lineTo(innerRadius, 0); ctx.lineTo(outerRadius, toothHeight); ctx.rotate(Math.PI / teeth); ctx.lineTo(outerRadius, -toothHeight); ctx.lineTo(innerRadius, 0); } ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore(); };
    window.clockDrawMarker = function(ctx, centerX, centerY, index, isActive) { const angle = (index - 15) * (Math.PI * 2 / 60); ctx.beginPath(); ctx.strokeStyle = isActive ? "#FFDB89" : "rgba(255,219,137,0.15)"; ctx.lineWidth = 15; ctx.arc(centerX, centerY, 280, angle - 0.04, angle + 0.04); ctx.stroke(); };

    // CLIENT HOME / INICIO
    const initClientHome = async () => {
        const session = loadSession();
        if (!session) return;

        // Set greeting
        const greetingEl = document.getElementById('client-greeting');
        const dateEl = document.getElementById('client-today-date');

        if (greetingEl) {
            const hour = new Date().getHours();
            let greeting = '¡Buenos días';
            if (hour >= 12 && hour < 18) greeting = '¡Buenas tardes';
            else if (hour >= 18) greeting = '¡Buenas noches';
            greetingEl.textContent = `${greeting}, ${session.name}!`;
        }

        if (dateEl) {
            const today = new Date();
            const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
            dateEl.textContent = today.toLocaleDateString('es-ES', options);
        }

        // Load today's workout
        const todayStr = new Date().toISOString().split('T')[0];
        const content = document.getElementById('today-workout-content');
        try {
            const res = await apiFetch(`/api/client-workouts/${session.id}/${todayStr}`);
            if (res.ok) {
                const workout = await res.json();
                if (content) {
                    if (workout.isRest) {
                        const isActive = workout.restType === 'active_rest';
                        const icon  = isActive ? 'fa-person-walking' : 'fa-moon';
                        const color = isActive ? '#6EE7B7' : '#93C5FD';
                        const label = workout.title || (isActive ? 'Descanso Activo' : 'Descanso');
                        const msg   = isActive
                            ? 'Hoy es un día de descanso activo. Movilidad, caminata suave o yoga.'
                            : 'Hoy es día de descanso. Recarga energías y deja que tu cuerpo se recupere.';
                        content.innerHTML = `
                            <div class="flex flex-col items-center justify-center py-6 gap-3 text-center">
                                <div class="w-14 h-14 rounded-full flex items-center justify-center" style="background:${color}22">
                                    <i class="fas ${icon} text-2xl" style="color:${color}"></i>
                                </div>
                                <p class="text-lg font-bold" style="color:${color}">${label}</p>
                                <p class="text-sm text-[#FFDB89]/50 max-w-xs">${msg}</p>
                            </div>`;
                    } else {
                        content.innerHTML = `
                            <h4 class="text-lg font-bold text-[#FFDB89] mb-3">${workout.title || 'Entrenamiento'}</h4>
                            ${workout.warmup ? `<p class="text-sm text-orange-400 mb-2"><i class="fas fa-fire mr-1"></i> Calentamiento: ${workout.warmup}</p>` : ''}
                            <div class="space-y-2">
                                ${(workout.exercises || []).map((ex, i) => `
                                    <div class="flex items-center gap-3 p-2 bg-[#FFDB89]/5 border border-[#FFDB89]/10 rounded-lg">
                                        <span class="w-6 h-6 bg-[#FFDB89] text-[#030303] rounded text-xs flex items-center justify-center font-bold shrink-0">${i + 1}</span>
                                        <span class="text-sm font-medium text-[#FFDB89]/90">${ex.name}</span>
                                    </div>
                                `).join('')}
                            </div>
                            ${workout.cooldown ? `<p class="text-sm text-[#FFDB89]/50 mt-2"><i class="fas fa-snowflake mr-1"></i> Vuelta a la calma: ${workout.cooldown}</p>` : ''}
                        `;
                    }
                }
            } else {
                if (content) {
                    content.innerHTML = `
                        <div class="text-center py-6">
                            <i class="fas fa-calendar-check text-5xl text-[#FFDB89]/20 mb-3 block"></i>
                            <p class="text-[#FFDB89]/60 font-medium">No hay entrenamiento programado para hoy.</p>
                            <p class="text-[#FFDB89]/30 text-sm mt-1">¡Disfruta tu día de descanso!</p>
                        </div>
                    `;
                }
            }
        } catch (e) {
            if (content) content.innerHTML = '<p class="text-gray-400 text-sm">No se pudo cargar el entrenamiento.</p>';
        }

        // Load stats
        try {
            const allRes = await apiFetch(`/api/client-workouts/${session.id}`);
            if (allRes.ok) {
                const workouts = await allRes.json();
                // Only count training days (not rest days) for workout stats
                const trainingDays = workouts.filter(w => !w.isRest);
                const totalEl = document.getElementById('stat-total-workouts');
                if (totalEl) totalEl.textContent = trainingDays.length;

                // Training sessions this week
                const now = new Date();
                const dayOfWeek = now.getDay();
                const weekStart = new Date(now);
                weekStart.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
                const weekStartStr = weekStart.toISOString().split('T')[0];
                const thisWeek = trainingDays.filter(w => w.date >= weekStartStr && w.date <= todayStr).length;
                const weekEl = document.getElementById('stat-workouts-week');
                if (weekEl) weekEl.textContent = thisWeek;

                // Streak: consecutive days with ANY calendar entry (rest counts — adherence to plan)
                const workoutDates = new Set(workouts.map(w => w.date));
                let streak = 0;
                const checkDate = new Date();
                for (let i = 0; i < 365; i++) {
                    const ds = checkDate.toISOString().split('T')[0];
                    if (workoutDates.has(ds)) {
                        streak++;
                        checkDate.setDate(checkDate.getDate() - 1);
                    } else {
                        break;
                    }
                }
                const streakEl = document.getElementById('stat-streak');
                if (streakEl) streakEl.textContent = streak;

                // Recent activity (rest days shown with their own style)
                const activityEl = document.getElementById('client-recent-activity');
                if (activityEl) {
                    const recent = workouts.slice(0, 5);
                    if (recent.length === 0) {
                        activityEl.innerHTML = '<p class="text-[#FFDB89]/40 text-sm text-center py-4">Sin actividad reciente.</p>';
                    } else {
                        activityEl.innerHTML = recent.map(w => {
                            if (w.isRest) {
                                const isActive = w.restType === 'active_rest';
                                const icon  = isActive ? 'fa-person-walking' : 'fa-moon';
                                const color = isActive ? '#6EE7B7' : '#93C5FD';
                                return `
                                    <div class="flex items-center gap-3 p-3 bg-[#FFDB89]/5 border border-[#FFDB89]/10 rounded-lg">
                                        <div class="w-10 h-10 rounded-full flex items-center justify-center shrink-0" style="background:${color}22">
                                            <i class="fas ${icon} text-sm" style="color:${color}"></i>
                                        </div>
                                        <div class="flex-grow min-w-0">
                                            <p class="text-sm font-bold truncate" style="color:${color}">${w.title || (isActive ? 'Descanso Activo' : 'Descanso')}</p>
                                            <p class="text-xs text-[#FFDB89]/30">${w.date}</p>
                                        </div>
                                    </div>`;
                            }
                            return `
                                <div class="flex items-center gap-3 p-3 bg-[#FFDB89]/5 border border-[#FFDB89]/10 rounded-lg">
                                    <div class="w-10 h-10 bg-[#FFDB89]/10 rounded-full flex items-center justify-center shrink-0">
                                        <i class="fas fa-dumbbell text-[#FFDB89] text-sm"></i>
                                    </div>
                                    <div class="flex-grow min-w-0">
                                        <p class="text-sm font-bold text-[#FFDB89]/90 truncate">${w.title || 'Entrenamiento'}</p>
                                        <p class="text-xs text-[#FFDB89]/30">${w.date} · ${(w.exercises || []).length} ejercicio${(w.exercises || []).length !== 1 ? 's' : ''}</p>
                                    </div>
                                </div>`;
                        }).join('');
                    }
                }
            }
        } catch (e) { console.error('Error loading client stats:', e); }

        // Set program name
        try {
            const profileRes = await apiFetch('/api/me');
            if (profileRes.ok) {
                const profile = await profileRes.json();
                const progEl = document.getElementById('stat-program');
                if (progEl) progEl.textContent = profile.program || 'Sin asignar';
            }
        } catch (e) { /* silently fail */ }

        // Set daily tip
        const tips = [
            'La consistencia es mas importante que la intensidad.',
            'Dormir bien es la mejor recuperacion muscular.',
            'Hidratate antes, durante y despues del entrenamiento.',
            'Calentar reduce lesiones y mejora el rendimiento.',
            'El progreso no es lineal. Confiar en el proceso.',
            'La nutricion es el 80% de tus resultados.',
            'Descansar es parte del entrenamiento.',
            'Establece metas pequenas y alcanzables.',
            'Celebra cada logro, por pequeno que sea.',
            'Tu unica competencia eres tu mismo de ayer.',
            'La disciplina supera la motivacion.',
            'Una buena postura previene el 90% de las lesiones.',
            'Escucha a tu cuerpo, no al ego.',
            'La proteina es esencial para la recuperacion.',
            'Entrena con intencion, no solo con movimiento.'
        ];
        const tipEl = document.getElementById('client-daily-tip');
        if (tipEl) {
            // Use day of year as seed for consistent daily tip
            const dayOfYear = Math.floor((new Date() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
            tipEl.textContent = tips[dayOfYear % tips.length];
        }
    };

    // ========================================================================
    // CLIENT PAGE INITIALIZERS
    // ========================================================================

    // --- METRICAS: Weight & body fat charts ---
    const initClientMetrics = async () => {
        const session = loadSession();
        if (!session) return;

        try {
            const res = await apiFetch(`/api/body-measurements/${session.id}`);
            const measurements = res.ok ? await res.json() : [];

            // measurements come oldest→newest from API; keep that order for chart
            const chartLabels = measurements.map(m => {
                const [y, mo, d] = m.date.split('-');
                return `${d}/${mo}/${y.slice(2)}`;
            });

            // Metric definitions
            const circumFields = [
                { key: 'pecho',   label: 'Pecho',    color: '#F472B6' },
                { key: 'biceps',  label: 'Bíceps',   color: '#A78BFA' },
                { key: 'cintura', label: 'Cintura',  color: '#6EE7B7' },
                { key: 'cadera',  label: 'Cadera',   color: '#FCA5A5' },
                { key: 'quads',   label: 'Quads',    color: '#FCD34D' },
                { key: 'calves',  label: 'Pantorr.', color: '#60A5FA' },
            ];
            const metrics = {
                weight:  { label: 'Peso (lbs)',  data: measurements.map(m => parseMeasurement(m.weight)),  color: '#FFDB89', unit: ' lbs', lower: true  },
                fat:     { label: '% Grasa',     data: measurements.map(m => parseMeasurement(m.bodyFat)), color: '#F87171', unit: '%',    lower: true  },
                bmi:     { label: 'BMI',          data: measurements.map(m => parseMeasurement(m.bmi)),     color: '#93C5FD', unit: '',     lower: true  },
                circum:  { label: 'Circunferencias', multiLine: true, unit: ' in', lower: true }
            };

            let activeMetric = 'weight';
            let activeCircumKey = 'cintura';
            let chartInstance = null;

            // Tab active styles
            const styleTabBtns = () => {
                document.querySelectorAll('.metric-tab-btn').forEach(btn => {
                    const on = btn.dataset.metric === activeMetric;
                    btn.className = `metric-tab-btn px-3 py-1.5 rounded-lg text-xs font-bold transition ${on ? 'bg-[#FFDB89] text-[#030303]' : 'text-[#FFDB89]/50 hover:text-[#FFDB89] hover:bg-[#FFDB89]/10'}`;
                });
                // Show/hide circum dropdown
                const wrap = document.getElementById('circum-selector-wrap');
                if (wrap) wrap.classList.toggle('hidden', activeMetric !== 'circum');
            };

            const updateStats = (metric) => {
                const vals = metric.data.filter(v => v !== null);
                if (!vals.length) {
                    document.getElementById('stat-current').textContent = '—';
                    document.getElementById('stat-change').textContent  = '—';
                    document.getElementById('stat-best').textContent    = '—';
                    return;
                }
                const latest = vals[vals.length - 1];
                const first  = vals[0];
                const delta  = latest - first;
                const best   = metric.lower ? Math.min(...vals) : Math.max(...vals);

                document.getElementById('stat-current').textContent = latest + metric.unit;

                const changeEl = document.getElementById('stat-change');
                const sign = delta > 0 ? '+' : '';
                changeEl.textContent = sign + delta.toFixed(1) + metric.unit;
                // Good direction: green if lower is better and delta < 0, or lower=false and delta > 0
                const good = (metric.lower && delta <= 0) || (!metric.lower && delta >= 0);
                changeEl.className = `text-xl font-black ${delta === 0 ? 'text-[#FFDB89]/60' : good ? 'text-green-400' : 'text-red-400'}`;

                document.getElementById('stat-best').textContent = best + metric.unit;
            };

            const renderChart = (metricKey) => {
                const ctx = document.getElementById('metricsChart');
                if (!ctx) return;
                if (chartInstance) { chartInstance.destroy(); chartInstance = null; }

                if (metricKey === 'circum') {
                    // ── Single-line circumference chart (dropdown-driven) ─────
                    const f = circumFields.find(cf => cf.key === activeCircumKey) || circumFields[2];
                    const vals = measurements.map(m => parseMeasurement(m[f.key]));
                    const filteredVals = vals.filter(v => v !== null);

                    // Stats
                    if (filteredVals.length) {
                        const latest = filteredVals[filteredVals.length - 1];
                        const first  = filteredVals[0];
                        const delta  = latest - first;
                        const best   = Math.min(...filteredVals);
                        document.getElementById('stat-current').textContent = latest + ' in';
                        const changeEl = document.getElementById('stat-change');
                        changeEl.textContent = (delta > 0 ? '+' : '') + delta.toFixed(1) + ' in';
                        changeEl.className = `text-xl font-black ${delta === 0 ? 'text-[#FFDB89]/60' : delta <= 0 ? 'text-green-400' : 'text-red-400'}`;
                        document.getElementById('stat-best').textContent = best + ' in';
                    } else {
                        document.getElementById('stat-current').textContent = '—';
                        document.getElementById('stat-change').textContent = '—';
                        document.getElementById('stat-best').textContent = '—';
                    }

                    const lo = filteredVals.length ? Math.min(...filteredVals) : 0;
                    const hi = filteredVals.length ? Math.max(...filteredVals) : 1;
                    const range2 = hi - lo;
                    const pad2 = range2 === 0 ? 1 : range2 * 0.3;
                    const yMin2 = parseFloat((lo - pad2).toFixed(1));
                    const yMax2 = parseFloat((hi + pad2).toFixed(1));
                    const hexToRgb2 = hex => { const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16); return `${r},${g},${b}`; };
                    const rgb2 = hexToRgb2(f.color);

                    chartInstance = new Chart(ctx, {
                        type: 'line',
                        data: {
                            labels: chartLabels,
                            datasets: [{
                                label: f.label, data: vals, borderColor: f.color,
                                backgroundColor: (context) => {
                                    const chart = context.chart;
                                    const {ctx: c, chartArea} = chart;
                                    if (!chartArea) return 'transparent';
                                    const gradient = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
                                    gradient.addColorStop(0, `rgba(${rgb2}, 0.35)`);
                                    gradient.addColorStop(1, `rgba(${rgb2}, 0.0)`);
                                    return gradient;
                                },
                                borderWidth: 2.5, tension: 0.45, fill: true,
                                pointRadius: 5, pointHoverRadius: 7,
                                pointBackgroundColor: f.color,
                                pointBorderColor: '#1C1C1E', pointBorderWidth: 2, spanGaps: true
                            }]
                        },
                        options: {
                            responsive: true, maintainAspectRatio: false,
                            interaction: { mode: 'index', intersect: false },
                            plugins: {
                                legend: { display: false },
                                tooltip: {
                                    backgroundColor: '#030303', borderColor: f.color + '55', borderWidth: 1,
                                    titleColor: f.color, bodyColor: '#fff', padding: 10, cornerRadius: 10,
                                    callbacks: { label: (c) => c.parsed.y !== null ? ` ${c.parsed.y} in` : ' —' }
                                }
                            },
                            scales: {
                                x: { ticks: { color: 'rgba(255,219,137,0.5)', font: { size: 10 }, maxRotation: 0 }, grid: { color: 'rgba(255,219,137,0.06)' }, border: { color: 'transparent' } },
                                y: { min: yMin2, max: yMax2, beginAtZero: false, ticks: { color: 'rgba(255,219,137,0.5)', font: { size: 10 } }, grid: { color: 'rgba(255,219,137,0.06)' }, border: { color: 'transparent' } }
                            }
                        }
                    });
                    return;
                }

                // ── Single-line chart ─────────────────────────────────────────
                const metric = metrics[metricKey];
                const vals = metric.data.filter(v => v !== null);
                const lo = vals.length ? Math.min(...vals) : 0;
                const hi = vals.length ? Math.max(...vals) : 1;
                const range = hi - lo;
                const pad = range === 0 ? 1 : range * 0.3;
                const yMin = parseFloat((lo - pad).toFixed(2));
                const yMax = parseFloat((hi + pad).toFixed(2));
                const hexToRgb = hex => { const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16); return `${r},${g},${b}`; };
                const rgb = hexToRgb(metric.color);
                chartInstance = new Chart(ctx, {
                    type: 'line',
                    data: {
                        labels: chartLabels,
                        datasets: [{
                            label: metric.label, data: metric.data, borderColor: metric.color,
                            backgroundColor: (context) => {
                                const chart = context.chart;
                                const {ctx: c, chartArea} = chart;
                                if (!chartArea) return 'transparent';
                                const gradient = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
                                gradient.addColorStop(0, `rgba(${rgb}, 0.35)`);
                                gradient.addColorStop(1, `rgba(${rgb}, 0.0)`);
                                return gradient;
                            },
                            borderWidth: 2.5, tension: 0.45, fill: true,
                            pointRadius: 5, pointHoverRadius: 7,
                            pointBackgroundColor: metric.color,
                            pointBorderColor: '#1C1C1E', pointBorderWidth: 2, spanGaps: true
                        }]
                    },
                    options: {
                        responsive: true, maintainAspectRatio: false,
                        interaction: { mode: 'index', intersect: false },
                        plugins: {
                            legend: { display: false },
                            tooltip: {
                                backgroundColor: '#030303', borderColor: metric.color + '55', borderWidth: 1,
                                titleColor: metric.color, bodyColor: '#ffffff', padding: 10, cornerRadius: 10,
                                callbacks: { label: (ctx) => ctx.parsed.y !== null ? ` ${ctx.parsed.y}${metric.unit}` : ' —' }
                            }
                        },
                        scales: {
                            x: { ticks: { color: 'rgba(255,219,137,0.5)', font: { size: 10 }, maxRotation: 0 }, grid: { color: 'rgba(255,219,137,0.06)' }, border: { color: 'transparent' } },
                            y: { min: yMin, max: yMax, beginAtZero: false, ticks: { color: 'rgba(255,219,137,0.5)', font: { size: 10 } }, grid: { color: 'rgba(255,219,137,0.06)' }, border: { color: 'transparent' } }
                        }
                    }
                });
                updateStats(metric);
            };

            // Wire tab clicks
            document.querySelectorAll('.metric-tab-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    activeMetric = btn.dataset.metric;
                    styleTabBtns();
                    renderChart(activeMetric);
                });
            });

            // Wire circum dropdown
            const circumSel = document.getElementById('circum-field-select');
            if (circumSel) {
                circumSel.addEventListener('change', () => {
                    activeCircumKey = circumSel.value;
                    renderChart('circum');
                });
            }

            styleTabBtns();
            renderChart(activeMetric);

            // --- Render table ---
            const countEl = document.getElementById('metrics-record-count');
            const emptyEl = document.getElementById('metrics-empty');
            const wrapEl  = document.getElementById('metrics-table-wrap');
            const bodyEl  = document.getElementById('metrics-table-body');

            if (countEl) countEl.textContent = `${measurements.length} registro${measurements.length !== 1 ? 's' : ''}`;

            if (measurements.length === 0) {
                if (emptyEl) emptyEl.classList.remove('hidden');
                if (wrapEl)  wrapEl.classList.add('hidden');
                return;
            }

            if (emptyEl) emptyEl.classList.add('hidden');
            if (wrapEl)  wrapEl.classList.remove('hidden');

            const rows = [...measurements].reverse().map(m => {
                const [y, mo, d] = m.date.split('-');
                const dateStr = `${d}/${mo}/${y}`;
                const cell = (val, highlight = false) =>
                    `<td class="py-3 px-3 text-center ${highlight ? 'font-bold text-[#FFDB89]' : 'text-[#FFDB89]/60'} whitespace-nowrap">${val || '—'}</td>`;
                return `<tr class="border-b border-[#FFDB89]/10 hover:bg-[#FFDB89]/5 transition">
                    <td class="py-3 px-3 text-left font-medium text-white whitespace-nowrap">${dateStr}</td>
                    ${cell(m.bmi ? m.bmi.toFixed(1) : null)}
                    ${cell(m.bodyFat ? m.bodyFat + '%' : null)}
                    ${cell(m.weight ? m.weight + ' lbs' : null, true)}
                    ${cell(m.pecho)}
                    ${cell(m.biceps)}
                    ${cell(m.cintura)}
                    ${cell(m.cadera)}
                    ${cell(m.quads)}
                    ${cell(m.calves)}
                </tr>`;
            }).join('');

            if (bodyEl) bodyEl.innerHTML = rows;

        } catch (e) { console.error('Error loading client metrics:', e); }
    };

    // --- EQUIPO: Render weight selection grids with save/load ---
    const renderEquipmentOptions = async () => {
        const lbsWeights = {
            dumbbells:   [5,10,15,20,25,30,35,40,45,50,55,60,65,70,75,80,85,90,95,100],
            plates:      [2.5,5,10,15,25,35,45],
            kettlebells: [10,15,20,25,30,35,40,45,50,53,60,70,80,90,100],
            cables:      [5,10,15,20,25,30,35,40,45,50,55,60,65,70,75,80,85,90,95,100]
        };
        const kgWeights = {
            dumbbells:   [2,4,6,8,10,12,14,16,18,20,22,24,26,28,30,32,36,40,44,48],
            plates:      [1.25,2.5,5,10,15,20,25],
            kettlebells: [4,6,8,10,12,14,16,20,24,28,32,36,40,44,48],
            cables:      [2.5,5,7.5,10,12.5,15,17.5,20,22.5,25,27.5,30,35,40,45]
        };

        let isKg = false;
        let savedEquipment = {};

        // Load saved equipment from server
        try {
            const res = await apiFetch('/api/equipment');
            if (res.ok) savedEquipment = await res.json();
        } catch (e) { console.error('Error loading equipment:', e); }

        const getSelectedWeights = (type) => {
            const selected = new Set();
            document.querySelectorAll(`#${type}-container .equipment-btn[data-selected="true"]`).forEach(btn => {
                selected.add(parseFloat(btn.dataset.weight));
            });
            return [...selected];
        };

        const collectAllData = () => ({
            unit: isKg ? 'kg' : 'lbs',
            dumbbells:   getSelectedWeights('dumbbells'),
            plates:      getSelectedWeights('plates'),
            kettlebells: getSelectedWeights('kettlebells'),
            cables:      getSelectedWeights('cables'),
            stations: {
                barra:   document.getElementById('station-barra')?.checked  || false,
                banco:   document.getElementById('station-banco')?.checked   || false,
                prensa:  document.getElementById('station-prensa')?.checked  || false,
                squat:   document.getElementById('station-squat')?.checked   || false,
            },
            other: {
                bands:     document.getElementById('equip-bands')?.checked     || false,
                trx:       document.getElementById('equip-trx')?.checked       || false,
                mat:       document.getElementById('equip-mat')?.checked       || false,
                pullup:    document.getElementById('equip-pullup')?.checked    || false,
                treadmill: document.getElementById('equip-treadmill')?.checked || false,
                bike:      document.getElementById('equip-bike')?.checked      || false,
                row:       document.getElementById('equip-row')?.checked       || false,
                box:       document.getElementById('equip-box')?.checked       || false,
            }
        });

        const renderGrid = (containerId, weights, unit, savedList) => {
            const container = document.getElementById(containerId);
            if (!container) return;
            container.innerHTML = weights.map(w => {
                const isSelected = savedList && savedList.includes(w);
                return `<button class="equipment-btn p-1.5 md:p-2.5 rounded-lg border-2 text-center font-bold text-xs md:text-sm transition cursor-pointer select-none
                    ${isSelected
                        ? 'border-[#FFDB89] bg-[#FFDB89]/20 text-[#FFDB89]'
                        : 'border-[#FFDB89]/20 text-[#FFDB89]/50 hover:border-[#FFDB89]/50 hover:text-[#FFDB89]/80'}"
                    data-weight="${w}" data-selected="${isSelected}">
                    ${w}<span class="text-[8px] md:text-[10px] font-normal ml-0.5">${unit}</span>
                </button>`;
            }).join('');

            container.querySelectorAll('.equipment-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const sel = btn.dataset.selected === 'true';
                    btn.dataset.selected = (!sel).toString();
                    if (!sel) {
                        btn.classList.replace('border-[#FFDB89]/20', 'border-[#FFDB89]');
                        btn.classList.add('bg-[#FFDB89]/20');
                        btn.classList.replace('text-[#FFDB89]/50', 'text-[#FFDB89]');
                    } else {
                        btn.classList.replace('border-[#FFDB89]', 'border-[#FFDB89]/20');
                        btn.classList.remove('bg-[#FFDB89]/20');
                        btn.classList.replace('text-[#FFDB89]', 'text-[#FFDB89]/50');
                    }
                    autoSaveEquipment();
                });
            });
        };

        const renderAllGrids = () => {
            const weights = isKg ? kgWeights : lbsWeights;
            const unit = isKg ? 'kg' : 'lbs';
            const saved = savedEquipment;
            // Only restore saved selections if the saved unit matches current unit
            const sameUnit = (saved.unit || 'lbs') === unit;
            renderGrid('dumbbells-container',   weights.dumbbells,   unit, sameUnit ? saved.dumbbells   : []);
            renderGrid('plates-container',      weights.plates,      unit, sameUnit ? saved.plates      : []);
            renderGrid('kettlebells-container', weights.kettlebells, unit, sameUnit ? saved.kettlebells : []);
            renderGrid('cables-container',      weights.cables,      unit, sameUnit ? saved.cables      : []);
        };

        // Restore checkboxes
        const restoreCheckboxes = () => {
            if (savedEquipment.stations) {
                Object.entries(savedEquipment.stations).forEach(([key, val]) => {
                    const el = document.getElementById(`station-${key}`);
                    if (el) el.checked = val;
                });
            }
            if (savedEquipment.other) {
                Object.entries(savedEquipment.other).forEach(([key, val]) => {
                    const el = document.getElementById(`equip-${key}`);
                    if (el) el.checked = val;
                });
            }
        };

        // Auto-save: debounced so rapid toggles only fire one request
        let _equipSaveTimer = null;
        const saveStatus = document.getElementById('equipment-save-status');
        const autoSaveEquipment = async () => {
            clearTimeout(_equipSaveTimer);
            _equipSaveTimer = setTimeout(async () => {
                const data = collectAllData();
                try {
                    const res = await apiFetch('/api/equipment', {
                        method: 'PUT',
                        body: JSON.stringify({ equipment: data })
                    });
                    if (res.ok) {
                        savedEquipment = data;
                        if (saveStatus) {
                            saveStatus.innerHTML = '<i class="fas fa-check mr-1"></i>Guardado';
                            saveStatus.classList.remove('hidden', 'text-red-400');
                            saveStatus.classList.add('text-green-400');
                            setTimeout(() => saveStatus.classList.add('hidden'), 2000);
                        }
                    } else throw new Error();
                } catch {
                    if (saveStatus) {
                        saveStatus.innerHTML = '<i class="fas fa-exclamation-triangle mr-1"></i>Error al guardar';
                        saveStatus.classList.remove('hidden', 'text-green-400');
                        saveStatus.classList.add('text-red-400');
                        setTimeout(() => saveStatus.classList.add('hidden'), 3000);
                    }
                }
            }, 600);   // 600ms debounce — waits for rapid clicking to settle
        };

        // Unit toggle
        const unitToggle = document.getElementById('weight-unit-toggle');
        const unitCircle = document.getElementById('unit-toggle-circle');
        const unitLbl    = document.getElementById('equipment-unit-lbl');
        if (savedEquipment.unit === 'kg') {
            isKg = true;
            if (unitCircle) unitCircle.classList.replace('translate-x-0', 'translate-x-5');
            if (unitLbl) unitLbl.textContent = 'KG';
        }
        if (unitToggle) {
            unitToggle.addEventListener('click', () => {
                isKg = !isKg;
                unitCircle?.classList.toggle('translate-x-0', !isKg);
                unitCircle?.classList.toggle('translate-x-5',  isKg);
                if (unitLbl) unitLbl.textContent = isKg ? 'KG' : 'LBS';
                renderAllGrids();
                autoSaveEquipment();
            });
        }

        // Keep manual save button working too (doesn't hurt)
        const saveBtn = document.getElementById('save-equipment-btn');
        if (saveBtn) {
            saveBtn.addEventListener('click', async () => {
                const data = collectAllData();
                try {
                    const res = await apiFetch('/api/equipment', {
                        method: 'PUT',
                        body: JSON.stringify({ equipment: data })
                    });
                    if (res.ok) {
                        savedEquipment = data;
                        if (saveStatus) {
                            saveStatus.innerHTML = '<i class="fas fa-check mr-1"></i>Inventario guardado';
                            saveStatus.classList.add('text-green-400');
                            saveStatus.classList.remove('text-[#FFDB89]/60');
                            setTimeout(() => {
                                saveStatus.textContent = '';
                                saveStatus.classList.remove('text-green-400');
                                saveStatus.classList.add('text-[#FFDB89]/60');
                            }, 3000);
                        }
                    }
                } catch (e) { console.error('Error saving equipment:', e); }
            });
        }

        renderAllGrids();
        restoreCheckboxes();

        // Auto-save on every checkbox change
        document.querySelectorAll(
            '#station-barra,#station-banco,#station-prensa,#station-squat,' +
            '#equip-bands,#equip-trx,#equip-mat,#equip-pullup,' +
            '#equip-treadmill,#equip-bike,#equip-row,#equip-box'
        ).forEach(el => el?.addEventListener('change', autoSaveEquipment));
    };

    // --- CLIENT NUTRITION: Daily food log ---
    const initClientNutrition = async () => {
        const session = loadSession();
        if (!session) return;

        const todayStr = new Date().toISOString().split('T')[0];

        // Set date picker to today
        const datePicker = document.getElementById('nutri-date');
        if (datePicker) datePicker.value = todayStr;

        // ── Macro calculator (inject above trainer targets banner) ──────────
        const calcWrapper = document.getElementById('macro-calc-wrapper-client');
        if (calcWrapper) {
            try {
                const [measRes, meRes] = await Promise.all([
                    apiFetch(`/api/body-measurements/${session.id}`),
                    apiFetch('/api/me')
                ]);
                const measurements = measRes.ok ? await measRes.json() : [];
                const me           = meRes.ok   ? await meRes.json()   : {};
                const latest       = measurements.length ? measurements[measurements.length - 1] : null;
                if (latest) {
                    renderMacroCalculator(calcWrapper,
                        { weight: parseMeasurement(latest.weight), bodyFat: parseMeasurement(latest.bodyFat),
                          macroSettings: me.macroSettings, evalDate: latest.date },
                        null, true /* readOnly */);
                } else {
                    calcWrapper.innerHTML = `<div class="bg-[#1C1C1E] border border-[#FFDB89]/10 rounded-2xl p-6 text-center text-[#FFDB89]/40 text-sm"><i class="fas fa-ruler-combined text-2xl mb-2 block"></i>Sin evaluación registrada todavía.</div>`;
                }
            } catch(e) { console.error('Macro calc error', e); }
        }

        // State: meals array
        let mealsData = [];
        let waterOz = 0;
        let calorieGoal = 0;
        let foodHistory = [];   // cached from past logs for autocomplete
        let servingUnit = localStorage.getItem('nutriServingUnit') || 'g'; // warm-start cache; DB value applied below

        // Build food history from all past nutrition logs (runs once on init)
        const buildFoodHistory = async () => {
            try {
                const res = await apiFetch(`/api/nutrition-logs/${session.id}`);
                if (!res.ok) return;
                const logs = await res.json();
                const seen = new Map();
                logs.forEach(log => {
                    const meals = Array.isArray(log.meals) ? log.meals : Object.values(log.meals || {});
                    meals.forEach(meal => {
                        (meal.foods || []).forEach(food => {
                            if (!food.name?.trim()) return;
                            const key = food.name.toLowerCase().trim();
                            if (!seen.has(key)) seen.set(key, {
                                name:     food.name,
                                calories: parseFloat(food.calories) || 0,
                                protein:  parseFloat(food.protein)  || 0,
                                carbs:    parseFloat(food.carbs)    || 0,
                                fat:      parseFloat(food.fat)      || 0
                            });
                        });
                    });
                });
                foodHistory = Array.from(seen.values());
            } catch (e) { /* silently fail — autocomplete just won't have history */ }
        };
        buildFoodHistory();

        // ── Unit toggle (g / oz) ──────────────────────────────────────────
        const updateUnitToggleUI = () => {
            const lbl = document.getElementById('nutri-unit-label');
            const btn = document.getElementById('nutri-unit-toggle');
            if (lbl) lbl.textContent = servingUnit;
            if (btn) {
                btn.title = servingUnit === 'g' ? 'Cambiar a onzas (oz)' : 'Cambiar a gramos (g)';
                btn.classList.toggle('bg-[#FFDB89]/20', servingUnit === 'oz');
            }
        };
        updateUnitToggleUI();
        document.getElementById('nutri-unit-toggle')?.addEventListener('click', () => {
            servingUnit = servingUnit === 'g' ? 'oz' : 'g';
            localStorage.setItem('nutriServingUnit', servingUnit);
            updateUnitToggleUI();
            // Persist to DB so preference survives logout / new device
            apiFetch('/api/me', { method: 'PUT', body: JSON.stringify({ servingUnit }) }).catch(() => {});
        });

        // Fetch profile from server — source of truth for macro goals and serving unit preference
        try {
            const meRes = await apiFetch('/api/me');
            if (meRes.ok) {
                const me = await meRes.json();

                // Serving unit preference
                if (me.servingUnit) {
                    servingUnit = me.servingUnit;
                    localStorage.setItem('nutriServingUnit', servingUnit);
                    updateUnitToggleUI();
                }

                // Macro targets set by trainer
                const ms = me.macroSettings;
                if (ms?.targetCal) {
                    calorieGoal = ms.targetCal;
                    // Always apply server values — MongoDB is the source of truth
                    if (ms.goalProtein) { const el = document.getElementById('goal-protein'); if (el) el.value = ms.goalProtein; }
                    if (ms.goalCarbs)   { const el = document.getElementById('goal-carbs');   if (el) el.value = ms.goalCarbs;   }
                    if (ms.goalFat)     { const el = document.getElementById('goal-fat');     if (el) el.value = ms.goalFat;     }
                    // Update write-through cache
                    localStorage.setItem('nutriGoals', JSON.stringify({ p: ms.goalProtein, c: ms.goalCarbs, f: ms.goalFat }));
                }
            }
        } catch (e) { /* silently fail */ }

        // Also try weight logs as backup if no trainer target
        if (!calorieGoal) {
            try {
                const wRes = await apiFetch(`/api/weight-logs/${session.id}`);
                if (wRes.ok) {
                    const wLogs = await wRes.json();
                    if (wLogs.length > 0) calorieGoal = Math.round((wLogs[0].weight || 0) * 15);
                }
            } catch (e) { /* silently fail */ }
        }

        const goalEl = document.getElementById('calorie-goal-display');
        if (goalEl) goalEl.textContent = calorieGoal || '--';

        // --- MACRO GOAL HELPERS ---
        // Goals are authoritative in MongoDB (User.macroSettings.goalProtein/Carbs/Fat).
        // localStorage is only a warm-start cache so the inputs aren't blank on slow connections.
        const LS_GOALS = 'nutriGoals';

        // Warm-start: fill inputs from cache while the /api/me fetch is in flight
        const loadGoalInputs = () => {
            const saved = JSON.parse(localStorage.getItem(LS_GOALS) || '{}');
            const gP = document.getElementById('goal-protein');
            const gC = document.getElementById('goal-carbs');
            const gF = document.getElementById('goal-fat');
            if (gP && !gP.value && saved.p) gP.value = saved.p;
            if (gC && !gC.value && saved.c) gC.value = saved.c;
            if (gF && !gF.value && saved.f) gF.value = saved.f;
        };

        // Debounce timer for goal saves
        let _goalSaveTimer = null;
        const saveGoalInputs = () => {
            const p = parseInt(document.getElementById('goal-protein')?.value) || 0;
            const c = parseInt(document.getElementById('goal-carbs')?.value)   || 0;
            const f = parseInt(document.getElementById('goal-fat')?.value)     || 0;
            // Write-through cache so next load is instant
            localStorage.setItem(LS_GOALS, JSON.stringify({ p, c, f }));
            // Persist to DB — debounced 800ms so rapid keystrokes don't hammer the API
            clearTimeout(_goalSaveTimer);
            _goalSaveTimer = setTimeout(async () => {
                try {
                    await apiFetch('/api/me', {
                        method: 'PUT',
                        body: JSON.stringify({ macroGoals: { goalProtein: p, goalCarbs: c, goalFat: f } })
                    });
                } catch (e) { /* non-critical — localStorage already updated */ }
            }, 800);
        };
        const getGoals = () => {
            // Prefer explicit goal inputs; fall back to calorieGoal-derived; then sensible defaults
            const gP = parseInt(document.getElementById('goal-protein')?.value);
            const gC = parseInt(document.getElementById('goal-carbs')?.value);
            const gF = parseInt(document.getElementById('goal-fat')?.value);
            return {
                pro:   gP || (calorieGoal ? Math.round(calorieGoal * 0.40 / 4) : 120),
                carbs: gC || (calorieGoal ? Math.round(calorieGoal * 0.35 / 4) : 150),
                fat:   gF || (calorieGoal ? Math.round(calorieGoal * 0.25 / 9) : 55)
            };
        };
        loadGoalInputs();

        // Wire goal-input changes to recalc + save
        ['goal-protein','goal-carbs','goal-fat'].forEach(id => {
            document.getElementById(id)?.addEventListener('input', () => { saveGoalInputs(); recalcTotals(); });
        });

        // Toggle goals edit row
        document.getElementById('toggle-goals-btn')?.addEventListener('click', () => {
            const row = document.getElementById('goals-edit-row');
            if (!row) return;
            const hidden = row.classList.toggle('hidden');
            const btn = document.getElementById('toggle-goals-btn');
            if (btn) btn.innerHTML = hidden
                ? '<i class="fas fa-sliders-h text-[9px]"></i> Editar metas'
                : '<i class="fas fa-check text-[9px]"></i> Listo';
        });

        // --- RECALC TOTALS ---
        const recalcTotals = () => {
            let totalCal = 0, totalPro = 0, totalCarbs = 0, totalFat = 0;
            mealsData.forEach(meal => {
                (meal.foods || []).forEach(f => {
                    totalCal   += parseFloat(f.calories) || 0;
                    totalPro   += parseFloat(f.protein)  || 0;
                    totalCarbs += parseFloat(f.carbs)    || 0;
                    totalFat   += parseFloat(f.fat)      || 0;
                });
            });

            const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
            set('total-calories-display', Math.round(totalCal));
            set('total-protein-display',  Math.round(totalPro) + 'g');
            set('total-carbs-display',    Math.round(totalCarbs) + 'g');
            set('total-fat-display',      Math.round(totalFat) + 'g');
            set('total-water-display',    waterOz);

            // Update calorie goal display
            const { pro: goalPro, carbs: goalCarbs, fat: goalFat } = getGoals();
            const derivedCalGoal = calorieGoal || (goalPro * 4 + goalCarbs * 4 + goalFat * 9);
            const goalEl = document.getElementById('calorie-goal-display');
            if (goalEl) goalEl.textContent = derivedCalGoal || '--';

            const setBar = (barId, labelId, current, goal) => {
                const bar = document.getElementById(barId);
                const lbl = document.getElementById(labelId);
                const pct = goal > 0 ? Math.min(100, Math.round(current / goal * 100)) : 0;
                if (bar) bar.style.width = pct + '%';
                if (lbl) lbl.textContent = goal > 0
                    ? `${Math.round(current)} / ${goal}g`
                    : `${Math.round(current)}g`;
            };
            setBar('bar-protein', 'bar-protein-label', totalPro,   goalPro);
            setBar('bar-carbs',   'bar-carbs-label',   totalCarbs, goalCarbs);
            setBar('bar-fat',     'bar-fat-label',      totalFat,   goalFat);

            // Calorie ring (SVG stroke animation)
            const ring = document.getElementById('calorie-ring');
            if (ring) {
                const pct = derivedCalGoal > 0 ? Math.min(1, totalCal / derivedCalGoal) : 0;
                ring.style.strokeDashoffset = (314.16 * (1 - pct)).toFixed(2);
                ring.style.stroke = (derivedCalGoal > 0 && totalCal > derivedCalGoal) ? '#ef4444' : '#FFDB89';
            }
            // Remaining calories display
            const remainEl = document.getElementById('calories-remaining-display');
            if (remainEl) {
                if (derivedCalGoal > 0) {
                    const diff = Math.round(derivedCalGoal - totalCal);
                    remainEl.textContent = Math.abs(diff) + ' cal';
                    remainEl.style.color = diff >= 0 ? 'rgba(255,219,137,0.65)' : '#ef4444';
                    remainEl.title = diff >= 0 ? 'restantes' : 'excedidas';
                } else {
                    remainEl.textContent = '--';
                    remainEl.style.color = 'rgba(255,219,137,0.4)';
                }
            }
        };

        // --- RENDER MEALS ---
        const mealNames = ['Desayuno', 'Merienda AM', 'Almuerzo', 'Merienda PM', 'Cena', 'Snack'];

        const renderMeals = () => {
            const container = document.getElementById('meals-container');
            if (!container) return;
            container.innerHTML = mealsData.map((meal, mi) => `
                <div class="bg-white/5 border border-[#FFDB89]/15 rounded-xl overflow-hidden">
                    <div class="flex items-center justify-between px-4 py-3 border-b border-[#FFDB89]/10">
                        <h4 class="font-bold text-white text-sm">${meal.name}</h4>
                        <div class="flex items-center gap-3">
                            <span class="text-sm font-black text-[#FFDB89]">${Math.round((meal.foods||[]).reduce((s,f)=>s+(parseFloat(f.calories)||0),0))} <span class="text-[10px] font-normal text-[#FFDB89]/40">cal</span></span>
                            ${mealsData.length > 1 ? `<button class="text-red-400/30 hover:text-red-400 transition text-xs" onclick="window._nutriRemoveMeal(${mi})" title="Eliminar comida"><i class="fas fa-trash-alt"></i></button>` : ''}
                        </div>
                    </div>
                    <div class="px-4 pt-2 pb-3">
                        ${(meal.foods || []).length === 0 ? `<p class="text-xs text-[#FFDB89]/30 py-3 text-center italic">Sin alimentos aún.</p>` : ''}
                        ${(meal.foods || []).map((food, fi) => {
                            const hasServing = food.servingAmount && food.servingUnit;
                            const missingMacros = !(parseFloat(food.protein)||0) && !(parseFloat(food.carbs)||0) && !(parseFloat(food.fat)||0);
                            const cal  = Math.round(parseFloat(food.calories) || 0);
                            const pro  = Math.round(parseFloat(food.protein)  || 0);
                            const carb = Math.round(parseFloat(food.carbs)    || 0);
                            const fat  = Math.round(parseFloat(food.fat)      || 0);
                            return `
                            <div class="py-2.5 border-b border-[#FFDB89]/8 last:border-0 group/foodrow${missingMacros && food.name ? ' opacity-60' : ''}">
                                <div class="flex items-start justify-between gap-2 mb-1">
                                    <p class="text-sm font-semibold text-white leading-snug flex-1 min-w-0">${(food.name||'Sin nombre').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p>
                                    <div class="flex items-center gap-0.5 shrink-0 opacity-0 group-hover/foodrow:opacity-100 transition">
                                        <button class="text-[#FFDB89]/50 hover:text-[#FFDB89] p-1.5 rounded-lg hover:bg-[#FFDB89]/10 transition" onclick="window._editFoodEntry(${mi},${fi})" title="Editar"><i class="fas fa-pencil-alt text-xs"></i></button>
                                        <button class="text-red-400/40 hover:text-red-400 p-1.5 rounded-lg hover:bg-red-400/10 transition" onclick="window._nutriRemoveFood(${mi},${fi})" title="Eliminar"><i class="fas fa-times text-xs"></i></button>
                                    </div>
                                </div>
                                <div class="flex items-center justify-between gap-2">
                                    <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                        ${hasServing ? `<span class="text-[10px] text-[#FFDB89]/30">${food.servingAmount}${food.servingUnit} ·</span>` : ''}
                                        <span class="text-[10px] text-red-400/70">P:${pro}g</span>
                                        <span class="text-[10px] text-yellow-400/70">C:${carb}g</span>
                                        <span class="text-[10px] text-orange-400/70">G:${fat}g</span>
                                        ${missingMacros && food.name ? '<span class="text-[10px] text-yellow-500/60 ml-1"><i class="fas fa-exclamation-triangle"></i> sin macros</span>' : ''}
                                    </div>
                                    <span class="text-sm font-black text-[#FFDB89] shrink-0">${cal}<span class="text-[10px] font-normal text-[#FFDB89]/40 ml-0.5">cal</span></span>
                                </div>
                            </div>`;
                        }).join('')}
                        ${(meal.foods || []).length > 0 ? (() => {
                            const mCal  = (meal.foods||[]).reduce((s,f)=>s+(parseFloat(f.calories)||0),0);
                            const mPro  = (meal.foods||[]).reduce((s,f)=>s+(parseFloat(f.protein) ||0),0);
                            const mCarb = (meal.foods||[]).reduce((s,f)=>s+(parseFloat(f.carbs)   ||0),0);
                            const mFat  = (meal.foods||[]).reduce((s,f)=>s+(parseFloat(f.fat)     ||0),0);
                            return `<div class="flex items-center gap-3 mt-1 pt-2.5 border-t border-[#FFDB89]/10 text-[10px] font-bold text-[#FFDB89]/40 uppercase tracking-wider">
                                <span class="flex-1">Total</span>
                                <span class="text-[#FFDB89]/70">${Math.round(mCal)} cal</span>
                                <span class="text-red-400/70">P:${Math.round(mPro)}g</span>
                                <span class="text-yellow-400/70">C:${Math.round(mCarb)}g</span>
                                <span class="text-orange-400/70">G:${Math.round(mFat)}g</span>
                            </div>`;
                        })() : ''}
                        <button class="w-full text-xs text-[#FFDB89]/50 hover:text-[#FFDB89] transition flex items-center justify-center gap-1.5 mt-2 py-2 rounded-xl border border-dashed border-[#FFDB89]/15 hover:border-[#FFDB89]/40 hover:bg-[#FFDB89]/5" onclick="window._openAddFoodModal(${mi})">
                            <i class="fas fa-plus text-[10px]"></i> Añadir alimento
                        </button>
                    </div>
                </div>
            `).join('');

            // Cap add-meal button at 6
            const addBtn = document.getElementById('add-meal-btn');
            if (addBtn) {
                const atMax = mealsData.length >= 6;
                addBtn.disabled = atMax;
                addBtn.classList.toggle('opacity-30', atMax);
                addBtn.classList.toggle('cursor-not-allowed', atMax);
                addBtn.title = atMax ? 'Máximo de 6 comidas alcanzado' : '';
            }
        };

        // Expose mutation helpers globally (scoped to this session)
        window._nutriUpdateFood = (mi, fi, field, val) => {
            if (mealsData[mi]?.foods[fi]) mealsData[mi].foods[fi][field] = val;
            renderMeals();
            recalcTotals();
        };
        window._nutriAddFood = (mi) => window._openAddFoodModal(mi); // legacy alias

        window._nutriRemoveFood = (mi, fi) => {
            mealsData[mi].foods.splice(fi, 1);
            renderMeals();
            recalcTotals();
            doSaveNutrition({ silent: true });
        };

        window._nutriRemoveMeal = (mi) => {
            mealsData.splice(mi, 1);
            renderMeals();
            recalcTotals();
            doSaveNutrition({ silent: true });
        };

        window._editFoodEntry = (mi, fi) => {
            const food = mealsData[mi]?.foods?.[fi];
            if (!food) return;
            document.getElementById('edit-food-modal')?.remove();
            const modal = document.createElement('div');
            modal.id = 'edit-food-modal';
            modal.className = 'fixed inset-0 z-[95] flex items-end md:items-center justify-center bg-black/70 backdrop-blur-sm p-4';
            modal.innerHTML = `
                <div class="bg-[#1C1C1E] border border-[#FFDB89]/20 rounded-2xl w-full max-w-sm shadow-2xl p-5 space-y-4">
                    <div class="flex justify-between items-center">
                        <h3 class="text-base font-bold text-[#FFDB89]"><i class="fas fa-pencil-alt mr-2 text-sm"></i>Editar alimento</h3>
                        <button id="close-edit-food" class="text-[#FFDB89]/50 hover:text-[#FFDB89] transition text-lg"><i class="fas fa-times"></i></button>
                    </div>
                    <div>
                        <label class="text-[10px] text-[#FFDB89]/50 uppercase tracking-wider block mb-1">Nombre</label>
                        <input type="text" id="ef-name" value="${(food.name||'').replace(/"/g,'&quot;')}"
                            class="w-full p-2.5 bg-white/10 border border-[#FFDB89]/30 rounded-xl text-white text-sm outline-none focus:ring-2 focus:ring-[#FFDB89]">
                    </div>
                    <div class="bg-[#FFDB89]/5 border border-[#FFDB89]/10 rounded-xl p-3">
                        <label class="text-[10px] text-[#FFDB89]/50 uppercase tracking-wider block mb-2">Ajustar cantidad (multiplica los macros)</label>
                        <div class="flex items-center gap-3">
                            <input type="number" id="ef-multiplier" value="1" min="0.1" step="0.1"
                                class="w-24 p-2 bg-white/10 border border-[#FFDB89]/30 rounded-lg text-[#FFDB89] font-black text-sm text-center outline-none focus:ring-1 focus:ring-[#FFDB89]">
                            <span class="text-xs text-[#FFDB89]/40">× los valores actuales</span>
                        </div>
                    </div>
                    <div>
                        <p class="text-[10px] text-[#FFDB89]/40 uppercase tracking-wider mb-2">Macros (totales):</p>
                        <div class="grid grid-cols-2 gap-2">
                            <div><label class="text-xs text-[#FFDB89]/60 block mb-1">Calorías</label>
                            <input type="number" id="ef-cal" value="${parseFloat(food.calories)||0}" min="0"
                                class="w-full p-2.5 bg-white/10 border border-[#FFDB89]/20 rounded-lg text-[#FFDB89] font-bold text-sm text-center outline-none focus:ring-1 focus:ring-[#FFDB89]"></div>
                            <div><label class="text-xs text-red-400/70 block mb-1">Proteína (g)</label>
                            <input type="number" id="ef-pro" value="${parseFloat(food.protein)||0}" min="0"
                                class="w-full p-2.5 bg-white/10 border border-red-400/20 rounded-lg text-red-400 font-bold text-sm text-center outline-none focus:ring-1 focus:ring-red-400"></div>
                            <div><label class="text-xs text-yellow-400/70 block mb-1">Carbos (g)</label>
                            <input type="number" id="ef-carb" value="${parseFloat(food.carbs)||0}" min="0"
                                class="w-full p-2.5 bg-white/10 border border-yellow-400/20 rounded-lg text-yellow-400 font-bold text-sm text-center outline-none focus:ring-1 focus:ring-yellow-400"></div>
                            <div><label class="text-xs text-orange-400/70 block mb-1">Grasas (g)</label>
                            <input type="number" id="ef-fat" value="${parseFloat(food.fat)||0}" min="0"
                                class="w-full p-2.5 bg-white/10 border border-orange-400/20 rounded-lg text-orange-400 font-bold text-sm text-center outline-none focus:ring-1 focus:ring-orange-400"></div>
                        </div>
                    </div>
                    <div class="flex gap-2 pt-1">
                        <button id="ef-delete" class="px-4 py-2.5 rounded-xl bg-red-500/15 hover:bg-red-500/25 text-red-400 text-sm font-bold transition">
                            <i class="fas fa-trash-alt mr-1.5"></i>Eliminar
                        </button>
                        <button id="ef-save" class="flex-1 py-2.5 rounded-xl bg-[#FFDB89] hover:bg-[#ffe9a8] text-[#030303] text-sm font-bold transition">
                            <i class="fas fa-check mr-1.5"></i>Guardar
                        </button>
                    </div>
                </div>`;
            document.body.appendChild(modal);

            // Base values for multiplier
            const base = {
                cal:  parseFloat(food.calories) || 0,
                pro:  parseFloat(food.protein)  || 0,
                carb: parseFloat(food.carbs)    || 0,
                fat:  parseFloat(food.fat)      || 0
            };
            document.getElementById('ef-multiplier').addEventListener('input', e => {
                const m = parseFloat(e.target.value) || 1;
                document.getElementById('ef-cal').value  = Math.round(base.cal  * m) || '';
                document.getElementById('ef-pro').value  = Math.round(base.pro  * m) || '';
                document.getElementById('ef-carb').value = Math.round(base.carb * m) || '';
                document.getElementById('ef-fat').value  = Math.round(base.fat  * m) || '';
            });

            document.getElementById('ef-save').addEventListener('click', () => {
                mealsData[mi].foods[fi] = {
                    ...mealsData[mi].foods[fi],
                    name:     document.getElementById('ef-name').value.trim() || food.name,
                    calories: document.getElementById('ef-cal').value,
                    protein:  document.getElementById('ef-pro').value,
                    carbs:    document.getElementById('ef-carb').value,
                    fat:      document.getElementById('ef-fat').value
                };
                modal.remove();
                renderMeals();
                recalcTotals();
                doSaveNutrition({ silent: true });
            });

            document.getElementById('ef-delete').addEventListener('click', () => {
                mealsData[mi].foods.splice(fi, 1);
                modal.remove();
                renderMeals();
                recalcTotals();
                doSaveNutrition({ silent: true });
            });

            document.getElementById('close-edit-food').addEventListener('click', () => modal.remove());
            modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
        };

        // ============================================================
        // ADD FOOD MODAL — 3 tabs: Manual | Buscar | Escanear
        // ============================================================
        window._openAddFoodModal = (mealIndex) => {
            document.getElementById('add-food-modal')?.remove();

            // Per-modal state
            let pending        = { name: '', calories: '', protein: '', carbs: '', fat: '' };
            let baseNutrients  = null;   // per-100g values from search/scan (for serving scaling)
            let servingG       = 100;    // always in grams internally
            let modalUnit      = servingUnit; // inherit current global unit
            let zxingReader    = null;

            // oz ↔ g helpers
            const ozToG = oz => oz * 28.3495;
            const gToOz = g  => parseFloat((g / 28.3495).toFixed(1));

            const stopScanner = () => {
                if (zxingReader) { try { zxingReader.reset(); } catch (e) {} zxingReader = null; }
            };

            // ---- Build modal shell ----
            const modal = document.createElement('div');
            modal.id = 'add-food-modal';
            modal.className = 'fixed inset-0 z-[90] flex items-end md:items-center justify-center bg-black/70 backdrop-blur-sm p-4';
            modal.innerHTML = `
                <div class="bg-[#1C1C1E] border border-[#FFDB89]/20 rounded-2xl w-full max-w-lg max-h-[90vh] flex flex-col shadow-2xl">
                    <div class="flex items-center justify-between px-5 py-4 border-b border-[#FFDB89]/15 shrink-0">
                        <h3 class="text-lg font-bold text-[#FFDB89]">Añadir alimento</h3>
                        <button id="close-food-modal" class="text-[#FFDB89]/50 hover:text-[#FFDB89] transition text-xl"><i class="fas fa-times"></i></button>
                    </div>
                    <div class="flex border-b border-[#FFDB89]/15 shrink-0">
                        <button class="food-tab-btn flex-1 py-3 text-xs font-bold text-[#FFDB89] border-b-2 border-[#FFDB89] transition" data-tab="search"><i class="fas fa-search mr-1.5"></i>Buscar</button>
                        <button class="food-tab-btn flex-1 py-3 text-xs font-bold text-[#FFDB89]/50 hover:text-[#FFDB89] border-b-2 border-transparent transition" data-tab="manual"><i class="fas fa-pencil-alt mr-1.5"></i>Manual</button>
                        <button class="food-tab-btn flex-1 py-3 text-xs font-bold text-[#FFDB89]/50 hover:text-[#FFDB89] border-b-2 border-transparent transition" data-tab="scan"><i class="fas fa-barcode mr-1.5"></i>Escanear</button>
                    </div>
                    <div class="flex-1 overflow-y-auto" id="food-modal-body"></div>
                    <div class="shrink-0 border-t border-[#FFDB89]/15 p-4 space-y-3">
                        <div id="food-preview" class="hidden bg-[#FFDB89]/5 border border-[#FFDB89]/20 rounded-xl p-3">
                            <p class="text-sm font-bold text-[#FFDB89] mb-2 truncate" id="preview-name">—</p>
                            <div class="grid grid-cols-4 gap-2 text-center text-xs">
                                <div><p class="text-[#FFDB89]/50 mb-0.5">Cal</p><p class="font-bold text-[#FFDB89]" id="preview-cal">0</p></div>
                                <div><p class="text-red-400/70 mb-0.5">Prot</p><p class="font-bold text-red-400" id="preview-pro">0g</p></div>
                                <div><p class="text-yellow-400/70 mb-0.5">Carbs</p><p class="font-bold text-yellow-400" id="preview-carb">0g</p></div>
                                <div><p class="text-orange-400/70 mb-0.5">Grasas</p><p class="font-bold text-orange-400" id="preview-fat">0g</p></div>
                            </div>
                            <div id="serving-row" class="hidden mt-3 flex items-center gap-2">
                                <label class="text-xs text-[#FFDB89]/60 shrink-0">Porción:</label>
                                <input type="number" id="serving-input" value="100" min="0.1" step="0.1" class="w-20 p-1.5 bg-white/10 border border-[#FFDB89]/30 rounded-lg text-white text-sm text-center outline-none focus:ring-1 focus:ring-[#FFDB89]">
                                <button id="modal-unit-btn" class="px-2 py-1 rounded-lg border border-[#FFDB89]/30 text-[#FFDB89] text-xs font-bold hover:bg-[#FFDB89]/10 transition min-w-[2.5rem]">g</button>
                            </div>
                        </div>
                        <button id="confirm-add-food" disabled
                            class="w-full py-3 rounded-xl bg-[#FFDB89] text-[#030303] font-bold text-sm hover:bg-[#f5cb6e] transition disabled:opacity-40 disabled:cursor-not-allowed">
                            <i class="fas fa-plus mr-2"></i>Añadir al diario
                        </button>
                    </div>
                </div>`;
            document.body.appendChild(modal);

            // ---- Preview helper ----
            const syncServingDisplay = () => {
                const si = document.getElementById('serving-input');
                const ub = document.getElementById('modal-unit-btn');
                if (si) si.value = modalUnit === 'oz' ? gToOz(servingG) : Math.round(servingG);
                if (ub) ub.textContent = modalUnit;
            };

            const setPreview = (food, showServing = false) => {
                const pv  = document.getElementById('food-preview');
                const btn = document.getElementById('confirm-add-food');
                // null means clear/reset the preview
                if (!food) {
                    pending = { name: '', calories: '', protein: '', carbs: '', fat: '' };
                    if (pv) pv.classList.add('hidden');
                    if (btn) btn.disabled = true;
                    document.getElementById('serving-row')?.classList.add('hidden');
                    return;
                }
                pending = { ...food };
                if (!pv) return;
                pv.classList.remove('hidden');
                document.getElementById('preview-name').textContent  = food.name || '—';
                document.getElementById('preview-cal').textContent   = Math.round(food.calories || 0);
                document.getElementById('preview-pro').textContent   = Math.round(food.protein  || 0) + 'g';
                document.getElementById('preview-carb').textContent  = Math.round(food.carbs    || 0) + 'g';
                document.getElementById('preview-fat').textContent   = Math.round(food.fat      || 0) + 'g';
                const servingRow = document.getElementById('serving-row');
                servingRow?.classList.toggle('hidden', !showServing);
                if (showServing) syncServingDisplay();
                if (btn) btn.disabled = !food.name;
            };

            // Wire modal unit button
            modal.addEventListener('click', e => {
                if (e.target.id !== 'modal-unit-btn' && !e.target.closest('#modal-unit-btn')) return;
                modalUnit = modalUnit === 'g' ? 'oz' : 'g';
                syncServingDisplay();
                // Recalculate preview (servingG unchanged, just display flips)
                if (baseNutrients) {
                    const scale = servingG / 100;
                    setPreview({
                        name:     baseNutrients.name,
                        calories: Math.round(baseNutrients.calories_100g * scale),
                        protein:  Math.round(baseNutrients.protein_100g  * scale),
                        carbs:    Math.round(baseNutrients.carbs_100g    * scale),
                        fat:      Math.round(baseNutrients.fat_100g      * scale)
                    }, true);
                }
            });

            // ==================================================
            // TAB: MANUAL (with history autocomplete)
            // ==================================================
            const showManualTab = () => {
                document.getElementById('food-modal-body').innerHTML = `
                    <div class="p-5 space-y-4">
                        <div class="relative">
                            <input type="text" id="food-name-input" placeholder="Nombre del alimento..." autocomplete="off"
                                class="w-full p-3 bg-white/10 border border-[#FFDB89]/30 rounded-xl text-white text-sm outline-none focus:ring-2 focus:ring-[#FFDB89] placeholder-[#FFDB89]/30">
                            <div id="food-name-suggestions" class="hidden absolute top-full left-0 right-0 mt-1 bg-[#1a1a1c] border border-[#FFDB89]/30 rounded-xl shadow-2xl z-10 max-h-52 overflow-y-auto"></div>
                        </div>
                        <!-- Quantity row -->
                        <div class="flex items-center gap-2">
                            <div class="flex flex-col items-center">
                                <label class="text-[10px] text-[#FFDB89]/50 uppercase tracking-wider mb-1">Cantidad</label>
                                <input type="number" id="food-qty-input" value="1" min="0.1" step="0.1"
                                    class="w-20 p-2 bg-white/10 border border-[#FFDB89]/30 rounded-lg text-[#FFDB89] font-black text-sm text-center outline-none focus:ring-2 focus:ring-[#FFDB89]">
                            </div>
                            <div class="flex-1 flex flex-col">
                                <label class="text-[10px] text-[#FFDB89]/50 uppercase tracking-wider mb-1">Unidad <span class="normal-case opacity-60">(opcional)</span></label>
                                <input type="text" id="food-unit-input" placeholder="ej: huevos, rebanadas, tazas..."
                                    class="w-full p-2 bg-white/10 border border-[#FFDB89]/20 rounded-lg text-white text-sm outline-none focus:ring-1 focus:ring-[#FFDB89] placeholder-[#FFDB89]/20">
                            </div>
                        </div>
                        <!-- Macros per unit -->
                        <div>
                            <p class="text-[10px] text-[#FFDB89]/40 uppercase tracking-wider mb-2">Macros por unidad:</p>
                            <div class="grid grid-cols-2 gap-2">
                                <div><label class="text-xs text-[#FFDB89]/60 block mb-1">Calorías</label>
                                <input type="number" id="food-cal-input" placeholder="0" min="0" class="w-full p-2.5 bg-white/10 border border-[#FFDB89]/20 rounded-lg text-[#FFDB89] font-bold text-sm text-center outline-none focus:ring-1 focus:ring-[#FFDB89]"></div>
                                <div><label class="text-xs text-red-400/70 block mb-1">Proteína (g)</label>
                                <input type="number" id="food-pro-input" placeholder="0" min="0" class="w-full p-2.5 bg-white/10 border border-red-400/20 rounded-lg text-red-400 font-bold text-sm text-center outline-none focus:ring-1 focus:ring-red-400"></div>
                                <div><label class="text-xs text-yellow-400/70 block mb-1">Carbos (g)</label>
                                <input type="number" id="food-carb-input" placeholder="0" min="0" class="w-full p-2.5 bg-white/10 border border-yellow-400/20 rounded-lg text-yellow-400 font-bold text-sm text-center outline-none focus:ring-1 focus:ring-yellow-400"></div>
                                <div><label class="text-xs text-orange-400/70 block mb-1">Grasas (g)</label>
                                <input type="number" id="food-fat-input" placeholder="0" min="0" class="w-full p-2.5 bg-white/10 border border-orange-400/20 rounded-lg text-orange-400 font-bold text-sm text-center outline-none focus:ring-1 focus:ring-orange-400"></div>
                            </div>
                        </div>
                        ${foodHistory.length > 0 ? `<p class="text-xs text-[#FFDB89]/40 text-center">💡 Escribe el nombre para ver sugerencias de tu historial (${foodHistory.length} alimentos guardados)</p>` : '<p class="text-xs text-[#FFDB89]/40 text-center">Tus alimentos anteriores aparecerán como sugerencias al escribir</p>'}
                    </div>`;

                const nameInput = document.getElementById('food-name-input');
                const qtyInput  = document.getElementById('food-qty-input');
                const unitInput = document.getElementById('food-unit-input');
                const suggestions = document.getElementById('food-name-suggestions');
                const calInput  = document.getElementById('food-cal-input');
                const proInput  = document.getElementById('food-pro-input');
                const carbInput = document.getElementById('food-carb-input');
                const fatInput  = document.getElementById('food-fat-input');

                const syncPreview = () => {
                    const qty  = parseFloat(qtyInput.value) || 1;
                    const unit = unitInput.value.trim();
                    const baseName = nameInput.value.trim();
                    const displayName = baseName
                        ? (qty !== 1 ? `${qty}${unit ? ' ' + unit : 'x'} ${baseName}` : baseName)
                        : '';
                    const f = {
                        name:     displayName,
                        calories: Math.round((parseFloat(calInput.value)  || 0) * qty),
                        protein:  Math.round((parseFloat(proInput.value)  || 0) * qty),
                        carbs:    Math.round((parseFloat(carbInput.value) || 0) * qty),
                        fat:      Math.round((parseFloat(fatInput.value)  || 0) * qty)
                    };
                    if (baseName) setPreview(f, false);
                    const btn = document.getElementById('confirm-add-food');
                    if (btn) btn.disabled = !baseName;
                };

                [calInput, proInput, carbInput, fatInput, qtyInput, unitInput].forEach(el => el?.addEventListener('input', syncPreview));

                nameInput?.addEventListener('input', () => {
                    syncPreview();
                    const q = nameInput.value.trim().toLowerCase();
                    if (!q || !foodHistory.length) { suggestions.classList.add('hidden'); return; }
                    const matches = foodHistory.filter(f => f.name.toLowerCase().includes(q)).slice(0, 8);
                    if (!matches.length) { suggestions.classList.add('hidden'); return; }
                    suggestions.innerHTML = matches.map(f => `
                        <button class="food-suggest-item w-full text-left px-4 py-2.5 hover:bg-[#FFDB89]/10 transition border-b border-[#FFDB89]/10 last:border-0"
                            data-name="${f.name.replace(/"/g,'&quot;')}" data-cal="${f.calories}" data-pro="${f.protein}" data-carb="${f.carbs}" data-fat="${f.fat}">
                            <span class="text-sm text-white font-medium">${f.name}</span>
                            <span class="text-xs text-[#FFDB89]/50 ml-2">${f.calories} cal &middot; P:${f.protein}g C:${f.carbs}g G:${f.fat}g</span>
                        </button>`).join('');
                    suggestions.classList.remove('hidden');
                });

                suggestions?.addEventListener('click', e => {
                    const item = e.target.closest('.food-suggest-item');
                    if (!item) return;
                    nameInput.value  = item.dataset.name;
                    calInput.value   = item.dataset.cal;
                    proInput.value   = item.dataset.pro;
                    carbInput.value  = item.dataset.carb;
                    fatInput.value   = item.dataset.fat;
                    qtyInput.value   = 1;
                    unitInput.value  = '';
                    suggestions.classList.add('hidden');
                    syncPreview();
                });

                nameInput?.addEventListener('blur', () => setTimeout(() => suggestions?.classList.add('hidden'), 150));
            };

            // ==================================================
            // TAB: SEARCH  (instant live search + recent foods)
            // ==================================================
            const showSearchTab = () => {
                document.getElementById('food-modal-body').innerHTML = `
                    <div class="p-4 space-y-3">
                        <div class="relative">
                            <i class="fas fa-search absolute left-3.5 top-1/2 -translate-y-1/2 text-[#FFDB89]/30 text-sm pointer-events-none"></i>
                            <input type="text" id="off-search-input" placeholder="Buscar alimento (huevo, pechuga, arroz...)" autocomplete="off"
                                class="w-full pl-10 pr-4 py-3 bg-white/10 border border-[#FFDB89]/30 rounded-xl text-white text-sm outline-none focus:ring-2 focus:ring-[#FFDB89] placeholder-[#FFDB89]/30">
                        </div>
                        <div id="off-results" class="space-y-1.5 max-h-64 overflow-y-auto"></div>
                    </div>`;

                const searchInput = document.getElementById('off-search-input');
                const resultsDiv  = document.getElementById('off-results');
                let lastProducts  = [];
                let searchTimer   = null;

                // ── Show recent foods (from history) ──
                const showRecentFoods = () => {
                    if (!foodHistory.length) {
                        resultsDiv.innerHTML = `
                            <p class="text-xs text-[#FFDB89]/35 text-center py-4">Escribe para buscar alimentos en la base de datos.</p>
                            <div class="text-center pb-2">
                                <button class="add-manual-cta text-xs font-bold text-[#FFDB89]/60 border border-[#FFDB89]/20 hover:border-[#FFDB89]/50 hover:bg-[#FFDB89]/8 hover:text-[#FFDB89] px-4 py-2 rounded-xl transition">
                                    <i class="fas fa-plus-circle mr-1.5"></i>Añadir manualmente
                                </button>
                            </div>`;
                        return;
                    }
                    const recent = foodHistory.slice(-10).reverse();
                    resultsDiv.innerHTML = `
                        <p class="text-[10px] text-[#FFDB89]/30 uppercase tracking-wider font-bold px-1 pb-1">Usados recientemente</p>
                        ${recent.map(f => `
                        <button class="history-food-item w-full text-left p-3 bg-white/5 border border-[#FFDB89]/15 hover:border-[#FFDB89]/40 hover:bg-white/8 rounded-xl transition"
                            data-name="${(f.name||'').replace(/"/g,'&quot;')}" data-cal="${f.calories||0}" data-pro="${f.protein||0}" data-carb="${f.carbs||0}" data-fat="${f.fat||0}">
                            <div class="flex justify-between items-center gap-2">
                                <p class="text-sm font-semibold text-white leading-tight truncate">${(f.name||'').replace(/</g,'&lt;')}</p>
                                <span class="text-sm font-black text-[#FFDB89] shrink-0">${f.calories||0} <span class="text-[10px] font-normal text-[#FFDB89]/40">cal</span></span>
                            </div>
                            <p class="text-[10px] mt-0.5 text-[#FFDB89]/40">P:${f.protein||0}g · C:${f.carbs||0}g · G:${f.fat||0}g</p>
                        </button>`).join('')}
                        <div class="text-center pt-1 pb-1">
                            <button class="add-manual-cta text-xs text-[#FFDB89]/50 hover:text-[#FFDB89] border border-[#FFDB89]/20 hover:border-[#FFDB89]/40 hover:bg-[#FFDB89]/8 px-4 py-2 rounded-xl transition">
                                <i class="fas fa-plus-circle mr-1.5"></i>¿No encuentras tu alimento? Añadir manualmente
                            </button>
                        </div>`;

                    resultsDiv.querySelectorAll('.history-food-item').forEach(btn => {
                        btn.addEventListener('click', () => {
                            const cal  = parseFloat(btn.dataset.cal)  || 0;
                            const pro  = parseFloat(btn.dataset.pro)  || 0;
                            const carb = parseFloat(btn.dataset.carb) || 0;
                            const fat  = parseFloat(btn.dataset.fat)  || 0;
                            baseNutrients = {
                                name: btn.dataset.name,
                                calories_100g: cal, protein_100g: pro,
                                carbs_100g: carb, fat_100g: fat
                            };
                            servingG = 100;
                            setPreview({ name: btn.dataset.name, calories: cal, protein: pro, carbs: carb, fat: fat }, true);
                            syncServingDisplay();
                        });
                    });
                };

                // ── Render the API results list ──
                const showResultsList = (products) => {
                    if (!products.length) {
                        resultsDiv.innerHTML = `
                        <div class="py-4 text-center space-y-3">
                            <p class="text-xs text-[#FFDB89]/40">Sin resultados. Prueba otro término.</p>
                            <button class="add-manual-cta text-xs font-bold text-[#FFDB89] border border-[#FFDB89]/30 hover:border-[#FFDB89]/60 hover:bg-[#FFDB89]/10 px-4 py-2 rounded-xl transition">
                                <i class="fas fa-plus-circle mr-1.5"></i>Añadir manualmente
                            </button>
                        </div>`;
                        return;
                    }
                    resultsDiv.innerHTML = products.map((p, i) => {
                        const brand = p.brand ? `<span class="text-[#FFDB89]/40">${p.brand} · </span>` : '';
                        return `<button class="off-result-item w-full text-left p-3 bg-white/5 border border-[#FFDB89]/15 hover:border-[#FFDB89]/40 hover:bg-white/8 rounded-xl transition" data-idx="${i}">
                            <div class="flex justify-between items-center gap-2">
                                <p class="text-sm font-semibold text-white leading-tight">${p.name}</p>
                                <span class="text-sm font-black text-[#FFDB89] shrink-0">${p.cal100} <span class="text-[10px] font-normal text-[#FFDB89]/40">kcal</span></span>
                            </div>
                            <p class="text-[10px] mt-0.5 text-[#FFDB89]/40">${brand}P:${p.p100}g · C:${p.c100}g · G:${p.f100}g</p>
                        </button>`;
                    }).join('');

                    resultsDiv.querySelectorAll('.off-result-item').forEach(btn => {
                        btn.addEventListener('click', () => {
                            const p = lastProducts[parseInt(btn.dataset.idx)];
                            if (p) showQtyPicker(p);
                        });
                    });
                    // "Add manually" fallback at the bottom of results
                    resultsDiv.insertAdjacentHTML('beforeend', `
                        <div class="text-center pt-1 pb-1">
                            <button class="add-manual-cta text-xs text-[#FFDB89]/50 hover:text-[#FFDB89] border border-[#FFDB89]/20 hover:border-[#FFDB89]/40 hover:bg-[#FFDB89]/8 px-4 py-2 rounded-xl transition">
                                <i class="fas fa-plus-circle mr-1.5"></i>¿No encuentras tu alimento? Añadir manualmente
                            </button>
                        </div>`);
                };

                // ── Instant search (debounced 350ms) ──
                const doSearch = async () => {
                    const q = searchInput.value.trim();
                    if (!q) { showRecentFoods(); return; }
                    resultsDiv.innerHTML = '<p class="text-xs text-[#FFDB89]/40 text-center py-4 animate-pulse"><i class="fas fa-spinner fa-spin mr-2"></i>Buscando...</p>';
                    try {
                        const res = await apiFetch(`/api/food-search?q=${encodeURIComponent(q)}`);
                        if (!res.ok) throw new Error(`HTTP ${res.status}`);
                        lastProducts = await res.json();
                        showResultsList(lastProducts);
                    } catch (e) {
                        resultsDiv.innerHTML = `<div class="text-center py-4 space-y-2">
                            <p class="text-xs text-red-400/70">No se pudo completar la búsqueda.</p>
                            <button id="retry-search-btn" class="text-xs text-[#FFDB89]/60 hover:text-[#FFDB89] underline transition">Intentar de nuevo</button>
                        </div>`;
                        document.getElementById('retry-search-btn')?.addEventListener('click', doSearch);
                    }
                };

                searchInput?.addEventListener('input', () => {
                    clearTimeout(searchTimer);
                    if (!searchInput.value.trim()) { showRecentFoods(); return; }
                    searchTimer = setTimeout(doSearch, 350);
                });
                searchInput?.addEventListener('keydown', e => {
                    if (e.key === 'Enter') { clearTimeout(searchTimer); doSearch(); }
                });

                // Show recent foods immediately on tab open
                showRecentFoods();

                // Delegated listener: any ".add-manual-cta" button inside resultsDiv → switch to Manual tab
                resultsDiv.addEventListener('click', e => {
                    if (e.target.closest('.add-manual-cta')) {
                        modal.querySelector('.food-tab-btn[data-tab="manual"]')?.click();
                    }
                });

                // Auto-focus search input
                setTimeout(() => searchInput?.focus(), 80);

                // ── Quantity picker shown after selecting a food ──
                const showQtyPicker = (p) => {
                    const unitG = parseFloat(p.serving) || 100;   // grams per 1 "portion"

                    baseNutrients = {
                        name:          p.name,
                        calories_100g: parseFloat(p.cal100),
                        protein_100g:  parseFloat(p.p100),
                        carbs_100g:    parseFloat(p.c100),
                        fat_100g:      parseFloat(p.f100)
                    };

                    resultsDiv.innerHTML = `
                        <div class="space-y-3">
                            <!-- back -->
                            <button id="off-back-btn" class="flex items-center gap-1.5 text-xs text-[#FFDB89]/50 hover:text-[#FFDB89] transition">
                                <i class="fas fa-chevron-left text-[10px]"></i> Volver a resultados
                            </button>
                            <!-- food name -->
                            <div class="bg-white/5 border border-[#FFDB89]/20 rounded-xl px-4 py-3">
                                <p class="text-sm font-bold text-white">${p.name}</p>
                                <p class="text-xs text-[#FFDB89]/40 mt-0.5">1 porción = ${unitG}g · ${p.cal100} kcal/100g</p>
                            </div>
                            <!-- qty + unit row -->
                            <div class="flex gap-2 items-end">
                                <div class="flex flex-col gap-1" style="width:90px">
                                    <label class="text-[10px] text-[#FFDB89]/50 uppercase tracking-wider">Cantidad</label>
                                    <input type="number" id="off-qty" value="1" min="0.1" step="any"
                                        class="p-2.5 bg-white/10 border border-[#FFDB89]/30 rounded-xl text-white text-center text-lg font-black outline-none focus:ring-2 focus:ring-[#FFDB89]">
                                </div>
                                <div class="flex-1 flex flex-col gap-1">
                                    <label class="text-[10px] text-[#FFDB89]/50 uppercase tracking-wider">Unidad</label>
                                    <select id="off-unit"
                                        class="w-full p-2.5 bg-white/10 border border-[#FFDB89]/30 rounded-xl text-white text-sm outline-none focus:ring-2 focus:ring-[#FFDB89] cursor-pointer">
                                        <option value="${unitG}">porción (${unitG}g c/u)</option>
                                        <option value="1">gramos (g)</option>
                                        <option value="28.35">onzas (oz)</option>
                                        <option value="15">cucharada / tbsp (~15g)</option>
                                        <option value="5">cucharadita / tsp (~5g)</option>
                                        <option value="240">taza / cup (~240g)</option>
                                    </select>
                                </div>
                            </div>
                            <!-- live macro preview -->
                            <div id="off-macro-row" class="grid grid-cols-4 gap-2"></div>
                        </div>`;

                    const qtyInput  = document.getElementById('off-qty');
                    const unitSel   = document.getElementById('off-unit');
                    const macroRow  = document.getElementById('off-macro-row');

                    const recalc = (clampValue = false) => {
                        const raw = parseFloat(qtyInput.value);
                        // While typing, allow empty/partial input — don't force-overwrite the field.
                        // Only clamp (and write back) on blur or explicit request.
                        const qty = (!isNaN(raw) && raw > 0) ? raw : 1;
                        if (clampValue) qtyInput.value = qty;

                        const gPerU   = parseFloat(unitSel.value)  || unitG;
                        servingG      = qty * gPerU;
                        const scale   = servingG / 100;
                        const cal  = Math.round(baseNutrients.calories_100g * scale);
                        const pro  = Math.round(baseNutrients.protein_100g  * scale);
                        const carb = Math.round(baseNutrients.carbs_100g    * scale);
                        const fat  = Math.round(baseNutrients.fat_100g      * scale);

                        macroRow.innerHTML = `
                            <div class="bg-[#FFDB89]/8 rounded-xl p-2 text-center">
                                <p class="text-[10px] text-[#FFDB89]/50 mb-0.5">Cal</p>
                                <p class="text-base font-black text-[#FFDB89]">${cal}</p>
                            </div>
                            <div class="bg-red-400/8 rounded-xl p-2 text-center">
                                <p class="text-[10px] text-red-400/60 mb-0.5">Prot</p>
                                <p class="text-base font-black text-red-400">${pro}g</p>
                            </div>
                            <div class="bg-yellow-400/8 rounded-xl p-2 text-center">
                                <p class="text-[10px] text-yellow-400/60 mb-0.5">Carb</p>
                                <p class="text-base font-black text-yellow-400">${carb}g</p>
                            </div>
                            <div class="bg-orange-400/8 rounded-xl p-2 text-center">
                                <p class="text-[10px] text-orange-400/60 mb-0.5">Grasa</p>
                                <p class="text-base font-black text-orange-400">${fat}g</p>
                            </div>`;

                        setPreview({ name: p.name, calories: cal, protein: pro, carbs: carb, fat: fat }, true);
                        syncServingDisplay();
                    };

                    // Live preview while typing — never overwrite what the user is typing
                    qtyInput.addEventListener('input', () => recalc(false));
                    // On blur: clamp empty/zero to 1 and refresh
                    qtyInput.addEventListener('blur', () => recalc(true));
                    unitSel.addEventListener('change', recalc);
                    recalc(true);   // initialise with clamped value

                    document.getElementById('off-back-btn')?.addEventListener('click', () => {
                        baseNutrients = null;
                        servingG = 100;
                        setPreview(null);
                        showResultsList(lastProducts);
                    });
                };

            };

            // ==================================================
            // TAB: SCAN (ZXing barcode via camera)
            // ==================================================
            const showScanTab = () => {
                document.getElementById('food-modal-body').innerHTML = `
                    <div class="p-5 space-y-3 text-center">
                        <div class="relative bg-black rounded-xl overflow-hidden w-full" style="aspect-ratio:4/3">
                            <video id="barcode-video" class="w-full h-full object-cover" autoplay muted playsinline></video>
                            <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
                                <div class="w-56 h-28 border-2 border-[#FFDB89] rounded-xl opacity-80 shadow-[0_0_20px_rgba(255,219,137,0.3)]"></div>
                            </div>
                            <p id="scan-status" class="absolute bottom-3 left-0 right-0 text-xs text-white/70 text-center px-4">Apunta al código de barras del producto</p>
                        </div>
                        <p class="text-xs text-[#FFDB89]/40">Funciona mejor con la cámara trasera. Requiere permisos de cámara.</p>
                    </div>`;

                const setStatus = (msg, cls = 'text-white/70') => {
                    const el = document.getElementById('scan-status');
                    if (el) { el.textContent = msg; el.className = `absolute bottom-3 left-0 right-0 text-xs text-center px-4 ${cls}`; }
                };

                const applyProductData = (p) => {
                    const n = p.nutriments || {};
                    baseNutrients = {
                        name:          p.product_name || `Producto escaneado`,
                        calories_100g: parseFloat(n['energy-kcal_100g'] || 0) || Math.round((parseFloat(n['energy_100g'] || 0)) / 4.184),
                        protein_100g:  parseFloat(n['proteins_100g']        || 0),
                        carbs_100g:    parseFloat(n['carbohydrates_100g']   || 0),
                        fat_100g:      parseFloat(n['fat_100g']             || 0)
                    };
                    servingG = parseFloat(p.serving_quantity) || 100;
                    const scale = servingG / 100;
                    setPreview({
                        name:     baseNutrients.name,
                        calories: Math.round(baseNutrients.calories_100g * scale),
                        protein:  Math.round(baseNutrients.protein_100g  * scale),
                        carbs:    Math.round(baseNutrients.carbs_100g    * scale),
                        fat:      Math.round(baseNutrients.fat_100g      * scale)
                    }, true);
                    syncServingDisplay();
                    document.getElementById('food-modal-body').innerHTML = `
                        <div class="p-6 text-center space-y-3">
                            <div class="w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center mx-auto">
                                <i class="fas fa-check text-green-400 text-2xl"></i>
                            </div>
                            <p class="text-lg font-bold text-white">${baseNutrients.name}</p>
                            <p class="text-sm text-[#FFDB89]/60">Producto encontrado. Ajusta la porción si es necesario.</p>
                        </div>`;
                };

                const startScanner = async () => {
                    if (!window.ZXing) {
                        setStatus('Cargando escáner...', 'text-[#FFDB89]/80 animate-pulse');
                        try {
                            await new Promise((resolve, reject) => {
                                const s = document.createElement('script');
                                s.src = 'https://unpkg.com/@zxing/library@0.19.1/umd/index.min.js';
                                s.onload = resolve; s.onerror = reject;
                                document.head.appendChild(s);
                            });
                        } catch (e) {
                            setStatus('No se pudo cargar el escáner. Verifica tu conexión.', 'text-red-400');
                            return;
                        }
                    }
                    setStatus('Buscando código de barras...', 'text-[#FFDB89]/80 animate-pulse');
                    try {
                        zxingReader = new window.ZXing.BrowserMultiFormatReader();
                        await zxingReader.decodeFromConstraints(
                            { video: { facingMode: { ideal: 'environment' } } },
                            'barcode-video',
                            async (result, err) => {
                                if (!result) return;
                                const barcode = result.getText();
                                setStatus(`✓ Código: ${barcode} — Buscando producto...`, 'text-green-400');
                                stopScanner();
                                try {
                                    const res  = await fetch(`https://world.openfoodfacts.org/api/v0/product/${barcode}.json`);
                                    const data = await res.json();
                                    if (data.status !== 1 || !data.product?.product_name) {
                                        setStatus('Producto no encontrado. Prueba la búsqueda manual.', 'text-red-400');
                                        return;
                                    }
                                    applyProductData(data.product);
                                } catch (fetchErr) {
                                    setStatus('Error buscando el producto. Intenta de nuevo.', 'text-red-400');
                                }
                            }
                        );
                    } catch (camErr) {
                        setStatus('No se pudo acceder a la cámara. Verifica los permisos.', 'text-red-400');
                    }
                };
                startScanner();
            };

            // ---- Tab switching ----
            const switchFoodTab = (tab) => {
                stopScanner();
                modal.querySelectorAll('.food-tab-btn').forEach(b => {
                    const on = b.dataset.tab === tab;
                    b.classList.toggle('text-[#FFDB89]',       on);
                    b.classList.toggle('border-[#FFDB89]',     on);
                    b.classList.toggle('text-[#FFDB89]/50',   !on);
                    b.classList.toggle('border-transparent',  !on);
                });
                if (tab === 'manual') showManualTab();
                else if (tab === 'search') showSearchTab();
                else showScanTab();
            };

            modal.querySelectorAll('.food-tab-btn').forEach(b => b.addEventListener('click', () => switchFoodTab(b.dataset.tab)));
            showSearchTab();

            // ---- Serving size scaling ----
            modal.addEventListener('input', e => {
                if (e.target.id !== 'serving-input' || !baseNutrients) return;
                const inputVal = parseFloat(e.target.value) || (modalUnit === 'oz' ? 3.5 : 100);
                servingG = modalUnit === 'oz' ? ozToG(inputVal) : inputVal;
                const scale = servingG / 100;
                setPreview({
                    name:     baseNutrients.name,
                    calories: Math.round(baseNutrients.calories_100g * scale),
                    protein:  Math.round(baseNutrients.protein_100g  * scale),
                    carbs:    Math.round(baseNutrients.carbs_100g    * scale),
                    fat:      Math.round(baseNutrients.fat_100g      * scale)
                }, true);
            });

            // ---- Confirm: add food to meal ----
            modal.querySelector('#confirm-add-food')?.addEventListener('click', () => {
                if (!pending.name) return;

                // Warn if all macros are zero (soft validation)
                const hasMacros = (parseFloat(pending.protein)||0) > 0 || (parseFloat(pending.carbs)||0) > 0 || (parseFloat(pending.fat)||0) > 0;
                if (!hasMacros) {
                    const confirmBtn = modal.querySelector('#confirm-add-food');
                    if (!confirmBtn.dataset.warnShown) {
                        confirmBtn.dataset.warnShown = '1';
                        const origText = confirmBtn.innerHTML;
                        confirmBtn.innerHTML = '<i class="fas fa-exclamation-triangle mr-2"></i>Sin macros — ¿confirmar?';
                        confirmBtn.classList.add('bg-yellow-500/80');
                        confirmBtn.classList.remove('bg-[#FFDB89]');
                        setTimeout(() => {
                            confirmBtn.innerHTML = origText;
                            confirmBtn.classList.remove('bg-yellow-500/80');
                            confirmBtn.classList.add('bg-[#FFDB89]');
                            delete confirmBtn.dataset.warnShown;
                        }, 2500);
                        return;
                    }
                }

                if (!mealsData[mealIndex].foods) mealsData[mealIndex].foods = [];

                // Capture serving info for display
                const servingAmt = baseNutrients
                    ? (modalUnit === 'oz' ? gToOz(servingG) : Math.round(servingG))
                    : null;

                mealsData[mealIndex].foods.push({
                    name:          pending.name,
                    calories:      pending.calories || '',
                    protein:       pending.protein  || '',
                    carbs:         pending.carbs    || '',
                    fat:           pending.fat      || '',
                    servingAmount: servingAmt,
                    servingUnit:   servingAmt ? modalUnit : null
                });
                // Add to live foodHistory so it appears next time without refresh
                const key = pending.name.toLowerCase().trim();
                if (!foodHistory.find(f => f.name.toLowerCase().trim() === key)) {
                    foodHistory.push({ name: pending.name, calories: pending.calories || 0, protein: pending.protein || 0, carbs: pending.carbs || 0, fat: pending.fat || 0 });
                }
                stopScanner();
                modal.remove();
                renderMeals();
                recalcTotals();
                doSaveNutrition({ silent: true });
            });

            // ---- Close ----
            modal.querySelector('#close-food-modal')?.addEventListener('click', () => { stopScanner(); modal.remove(); });
            modal.addEventListener('click', e => { if (e.target === modal) { stopScanner(); modal.remove(); } });
        };

        // --- ADD MEAL ---
        const addMealBtn = document.getElementById('add-meal-btn');
        if (addMealBtn) {
            addMealBtn.addEventListener('click', () => {
                if (mealsData.length >= 6) return;
                const name = mealNames[mealsData.length] || `Comida ${mealsData.length + 1}`;
                mealsData.push({ name, foods: [] });
                renderMeals();
                recalcTotals();
                doSaveNutrition({ silent: true });
            });
        }

        // --- WATER TRACKER ---
        // Key for localStorage persistence: scoped per client + date so switching
        // dates doesn't bleed data from one day to another.
        const waterKey = () => {
            const d = document.getElementById('nutri-date')?.value || todayStr;
            return `fbs_water_${session.id}_${d}`;
        };
        const saveWaterLocal = () => localStorage.setItem(waterKey(), waterOz);
        const loadWaterLocal = (dateStr) => {
            const v = localStorage.getItem(`fbs_water_${session.id}_${dateStr}`);
            return v !== null ? (parseInt(v) || 0) : null;
        };

        // Single source of truth for all water UI — keeps both displays in sync.
        const updateWaterDisplay = () => {
            const tracker = document.getElementById('water-count-display');
            if (tracker) tracker.textContent = waterOz + ' oz';
            const macro = document.getElementById('total-water-display');
            if (macro) macro.textContent = waterOz;
        };

        const renderWaterCups = () => {
            const cupsEl = document.getElementById('water-cups');
            if (!cupsEl) return;
            const cups = 10; // 10 × 8 oz = 80 oz
            cupsEl.innerHTML = Array.from({ length: cups }, (_, i) => {
                const filled = waterOz >= (i + 1) * 8;
                return `<button class="water-cup-btn w-10 h-10 rounded-lg border-2 transition flex items-center justify-center text-lg
                    ${filled ? 'border-sky-400 bg-sky-400/20 text-sky-400' : 'border-[#FFDB89]/20 text-[#FFDB89]/20 hover:border-[#FFDB89]/40'}"
                    data-oz="${(i + 1) * 8}" title="${(i + 1) * 8} oz">
                    <i class="fas fa-tint text-sm"></i>
                </button>`;
            }).join('');

            updateWaterDisplay();

            document.querySelectorAll('.water-cup-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const oz = parseInt(btn.dataset.oz);
                    waterOz = waterOz === oz ? oz - 8 : oz;
                    if (waterOz < 0) waterOz = 0;
                    saveWaterLocal();          // persist instantly — survives navigation
                    renderWaterCups();
                    recalcTotals();
                    doSaveNutrition({ silent: true });
                });
            });
        };

        const waterSetBtn = document.getElementById('water-set-btn');
        if (waterSetBtn) {
            waterSetBtn.addEventListener('click', () => {
                const val = parseInt(document.getElementById('water-manual-input')?.value) || 0;
                waterOz = val;
                saveWaterLocal();
                renderWaterCups();
                recalcTotals();
                doSaveNutrition({ silent: true });
            });
        }

        // --- LOAD LOG FOR A DATE ---
        const loadLogForDate = async (dateStr) => {
            // Immediately show any locally-cached water value so the UI is correct
            // while we wait for the network, preventing a flash of "0 oz".
            const cachedWater = loadWaterLocal(dateStr);
            if (cachedWater !== null) {
                waterOz = cachedWater;
                renderWaterCups();
                recalcTotals();
            }

            try {
                const res = await apiFetch(`/api/nutrition-logs/${session.id}`);
                if (!res.ok) return;
                const logs = await res.json();
                const log = logs.find(l => l.date === dateStr);
                if (log) {
                    mealsData = log.meals ? (Array.isArray(log.meals) ? log.meals : Object.values(log.meals)) : [];
                    // DB is authoritative — use its value, then sync localStorage with it
                    waterOz = log.water || 0;
                    localStorage.setItem(`fbs_water_${session.id}_${dateStr}`, waterOz);
                    const notesEl = document.getElementById('nutrition-notes');
                    if (notesEl) notesEl.value = log.notes || '';

                    // (Goals come from macroSettings on /api/me, not from the consumed log values)
                } else {
                    mealsData = mealNames.slice(0, 3).map(name => ({ name, foods: [] }));
                    // No DB entry yet — check localStorage for any unsaved click state
                    const cached = loadWaterLocal(dateStr);
                    waterOz = cached !== null ? cached : 0;
                    const notesEl = document.getElementById('nutrition-notes');
                    if (notesEl) notesEl.value = '';
                }
                renderMeals();
                renderWaterCups();
                recalcTotals();
            } catch (e) { console.error('Error loading nutrition log:', e); }
        };

        // --- SAVE ---
        const saveBtn = document.getElementById('save-nutrition-btn');
        // Shared save function — called by button and auto-save
        const doSaveNutrition = async ({ silent = false } = {}) => {
            const dateStr = document.getElementById('nutri-date')?.value || todayStr;
            const notes   = document.getElementById('nutrition-notes')?.value || '';

            let calories = 0, protein = 0, carbs = 0, fat = 0;
            mealsData.forEach(m => (m.foods || []).forEach(f => {
                calories += parseFloat(f.calories) || 0;
                protein  += parseFloat(f.protein)  || 0;
                carbs    += parseFloat(f.carbs)    || 0;
                fat      += parseFloat(f.fat)      || 0;
            }));

            try {
                const res = await apiFetch('/api/nutrition-logs', {
                    method: 'POST',
                    body: JSON.stringify({
                        clientId: session.id, date: dateStr,
                        calories: Math.round(calories), protein: Math.round(protein),
                        carbs: Math.round(carbs), fat: Math.round(fat),
                        water: waterOz, notes, meals: mealsData
                    })
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                if (!silent) {
                    const orig = saveBtn.innerHTML;
                    saveBtn.innerHTML = '<i class="fas fa-check mr-1"></i> Guardado';
                    saveBtn.classList.add('bg-green-500');
                    saveBtn.classList.remove('bg-[#FFDB89]');
                    setTimeout(() => {
                        saveBtn.innerHTML = orig;
                        saveBtn.classList.remove('bg-green-500');
                        saveBtn.classList.add('bg-[#FFDB89]');
                    }, 2000);
                    loadHistory();
                }
            } catch (e) {
                console.error('Error saving nutrition:', e);
                if (!silent) {
                    const orig = saveBtn.innerHTML;
                    saveBtn.innerHTML = '<i class="fas fa-exclamation-triangle mr-1"></i> Error al guardar';
                    saveBtn.classList.add('bg-red-500/80');
                    saveBtn.classList.remove('bg-[#FFDB89]');
                    setTimeout(() => {
                        saveBtn.innerHTML = orig;
                        saveBtn.classList.remove('bg-red-500/80');
                        saveBtn.classList.add('bg-[#FFDB89]');
                    }, 3000);
                }
            }
        };

        if (saveBtn) {
            saveBtn.addEventListener('click', () => doSaveNutrition({ silent: false }));
        }

        // Date picker change
        if (datePicker) {
            datePicker.addEventListener('change', () => loadLogForDate(datePicker.value));
        }

        // --- HISTORY ---
        const deleteNutriLog = async (logId) => {
            const yes = await showConfirm('¿Eliminar este registro de nutrición?', { confirmLabel: 'Eliminar', danger: true });
            if (!yes) return;
            try {
                const res = await apiFetch(`/api/nutrition-logs/${logId}`, { method: 'DELETE' });
                if (res.ok) { showToast('Registro eliminado.', 'success'); await loadHistory(); }
                else showToast('Error al eliminar el registro.', 'error');
            } catch (e) { showToast('Error de conexión.', 'error'); }
        };

        const loadHistory = async () => {
            const histEl = document.getElementById('nutrition-history');
            if (!histEl) return;
            try {
                const res = await apiFetch(`/api/nutrition-logs/${session.id}`);
                if (!res.ok) return;
                const logs = await res.json();
                if (logs.length === 0) {
                    histEl.innerHTML = '<p class="text-[#FFDB89]/40 text-sm text-center py-4">Sin registros aún.</p>';
                    return;
                }
                histEl.innerHTML = logs.slice(0, 30).map(l => `
                    <div class="flex items-center gap-2 p-3 bg-white/5 border border-[#FFDB89]/15 rounded-lg hover:bg-white/8 transition group">
                        <div class="flex-1 flex items-center gap-3 cursor-pointer min-w-0"
                            onclick="document.getElementById('nutri-date').value='${l.date}'; document.getElementById('nutri-date').dispatchEvent(new Event('change'))">
                            <span class="text-sm font-bold text-[#FFDB89] shrink-0">${l.date}</span>
                            <div class="flex flex-wrap gap-3 text-xs text-[#FFDB89]/60">
                                <span><i class="fas fa-fire mr-1 text-[#FFDB89]/50"></i>${l.calories} cal</span>
                                <span class="text-red-400">${l.protein}g P</span>
                                <span class="text-yellow-400">${l.carbs}g C</span>
                                <span class="text-orange-400">${l.fat}g G</span>
                                ${l.water ? `<span class="text-sky-400"><i class="fas fa-tint mr-1"></i>${l.water} oz</span>` : ''}
                            </div>
                        </div>
                        <button onclick="window._deleteNutriLog('${l._id}')"
                            class="opacity-0 group-hover:opacity-100 text-red-400/50 hover:text-red-400 transition shrink-0 p-1" title="Eliminar registro">
                            <i class="fas fa-trash-alt text-xs"></i>
                        </button>
                    </div>
                `).join('');
                window._deleteNutriLog = deleteNutriLog;
            } catch (e) { console.error('Error loading history:', e); }
        };

        // Initial load
        await loadLogForDate(todayStr);
        await loadHistory();
    };

    // --- CLIENT PROGRESS PHOTOS: Fetch and render from API ---
    const initClientProgress = async () => {
        const session = loadSession();
        if (!session) return;

        const grid     = document.getElementById('progress-photos-grid');
        const loading  = document.getElementById('photos-loading');
        const uploadBtn = document.getElementById('upload-photo-btn');

        let clientCompareMode = false;
        let clientSelectedIds = [];
        let lastPhotos = [];

        const renderPhotos = (photos) => {
            if (!grid) return;
            if (loading) loading.classList.add('hidden');
            grid.classList.remove('hidden');
            lastPhotos = photos;

            const addCard = `
                <div id="add-progress-photo-card"
                    class="border-2 border-dashed border-[#FFDB89]/30 hover:border-[#FFDB89] rounded-xl flex flex-col items-center justify-center p-8 text-[#FFDB89]/40 hover:text-[#FFDB89] transition cursor-pointer min-h-[200px]">
                    <i class="fas fa-plus-circle text-4xl mb-2"></i>
                    <span class="font-semibold text-sm">Añadir foto</span>
                </div>`;

            // Header: compare toggle button (inject above grid if not already there)
            const headerArea = document.getElementById('client-photos-header');
            if (headerArea) {
                headerArea.innerHTML = photos.length >= 2 ? `
                    <button id="client-compare-toggle" class="px-3 py-2 rounded-lg text-xs font-bold border transition ${clientCompareMode ? 'bg-[#FFDB89] text-[#030303] border-[#FFDB89]' : 'border-[#FFDB89]/30 text-[#FFDB89]/70 hover:text-[#FFDB89]'}">
                        <i class="fas fa-columns mr-1.5"></i>${clientCompareMode ? 'Cancelar' : 'Comparar'}
                    </button>` : '';
                document.getElementById('client-compare-toggle')?.addEventListener('click', () => {
                    clientCompareMode = !clientCompareMode;
                    clientSelectedIds = [];
                    renderPhotos(lastPhotos);
                });
            }

            const hint = document.getElementById('client-compare-hint');
            const compareAction = document.getElementById('client-compare-action');
            if (hint) {
                if (clientCompareMode && photos.length >= 2) {
                    hint.classList.remove('hidden');
                    hint.textContent = clientSelectedIds.length === 2 ? 'Listas para comparar ↓' : `Selecciona ${2 - clientSelectedIds.length} foto(s) más`;
                } else {
                    hint.classList.add('hidden');
                }
            }
            if (compareAction) {
                if (clientCompareMode && clientSelectedIds.length === 2) {
                    compareAction.classList.remove('hidden');
                } else {
                    compareAction.classList.add('hidden');
                }
            }

            if (photos.length === 0) {
                grid.innerHTML = `
                    <div class="col-span-3 text-center py-10 text-[#FFDB89]/40">
                        <i class="fas fa-camera text-5xl mb-3 block"></i>
                        <p class="font-medium">Aún no tienes fotos de progreso.</p>
                        <p class="text-sm mt-1">Sube tu primera foto para comenzar a ver tu transformación.</p>
                    </div>
                    ${addCard}`;
            } else {
                const isSelected = (id) => clientSelectedIds.includes(id);
                grid.innerHTML = photos.map(photo => {
                    const [y, mo, d] = (photo.date || '').split('-');
                    const dateStr = photo.date ? `${d}/${mo}/${y}` : '—';
                    const sel = isSelected(photo._id);
                    return `
                        <div class="bg-white/5 border ${sel ? 'border-[#FFDB89] ring-2 ring-[#FFDB89]' : 'border-[#FFDB89]/20'} p-2 rounded-xl group relative cursor-pointer transition-all"
                             data-pid="${photo._id}">
                            <div class="aspect-[3/4] bg-[#FFDB89]/5 rounded-lg mb-2 overflow-hidden relative">
                                <img src="${photo.imageData}" alt="Foto de progreso" class="w-full h-full object-cover">
                                ${sel ? `<div class="absolute inset-0 bg-[#FFDB89]/20 flex items-start justify-end p-2"><div class="w-6 h-6 bg-[#FFDB89] rounded-full flex items-center justify-center text-[#030303] text-xs font-bold">${clientSelectedIds.indexOf(photo._id)+1}</div></div>` : ''}
                            </div>
                            <div class="flex justify-between items-center px-1">
                                <span class="font-bold text-white text-xs">${photo.category || 'Progreso'}</span>
                                <span class="text-[10px] text-[#FFDB89]/50">${dateStr}</span>
                            </div>
                            ${photo.notes ? `<p class="text-[10px] text-[#FFDB89]/50 mt-0.5 truncate px-1">${photo.notes}</p>` : ''}
                            ${!clientCompareMode ? `<button class="delete-photo-btn absolute top-2 right-2 w-7 h-7 bg-red-500/80 hover:bg-red-500 text-white rounded-full text-xs opacity-0 group-hover:opacity-100 transition flex items-center justify-center"
                                data-id="${photo._id}" title="Eliminar">
                                <i class="fas fa-trash text-[10px]"></i>
                            </button>` : ''}
                        </div>`;
                }).join('') + addCard;

                // Photo card click — compare or open
                grid.querySelectorAll('[data-pid]').forEach(card => {
                    card.addEventListener('click', (e) => {
                        if (e.target.closest('.delete-photo-btn')) return;
                        const id = card.dataset.pid;
                        if (!clientCompareMode) return;
                        if (clientSelectedIds.includes(id)) {
                            clientSelectedIds = clientSelectedIds.filter(x => x !== id);
                        } else if (clientSelectedIds.length < 2) {
                            clientSelectedIds.push(id);
                        }
                        renderPhotos(lastPhotos);
                    });
                });

                // Delete buttons
                grid.querySelectorAll('.delete-photo-btn').forEach(btn => {
                    btn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        const yes = await showConfirm('¿Eliminar esta foto?', { confirmLabel: 'Eliminar', danger: true });
                        if (!yes) return;
                        try {
                            const res = await apiFetch(`/api/progress-photos/${btn.dataset.id}`, { method: 'DELETE' });
                            if (res.ok) loadPhotos();
                        } catch (e2) { showToast('Error eliminando foto.', 'error'); }
                    });
                });

                // Compare action button
                const cmpBtn = document.getElementById('client-do-compare');
                if (cmpBtn) {
                    cmpBtn.addEventListener('click', () => {
                        const [a, b] = clientSelectedIds.map(id => lastPhotos.find(p => p._id === id));
                        if (a && b) openPhotoCompare(a, b);
                    });
                }
            }

            // Wire add card click
            document.getElementById('add-progress-photo-card')?.addEventListener('click', openUploadModal);
        };

        const loadPhotos = async () => {
            try {
                const res = await apiFetch(`/api/progress-photos/${session.id}`);
                const photos = res.ok ? await res.json() : [];
                renderPhotos(photos);
            } catch (e) {
                if (loading) loading.innerHTML = '<p class="text-red-400 text-sm">Error cargando fotos.</p>';
            }
        };

        // Upload modal
        const openUploadModal = () => {
            document.getElementById('client-upload-photo-modal')?.remove();
            const today = new Date().toISOString().split('T')[0];
            document.body.insertAdjacentHTML('beforeend', `
                <div id="client-upload-photo-modal" class="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
                    <div class="bg-[#1C1C1E] border border-[#FFDB89]/20 rounded-2xl w-full max-w-md shadow-2xl p-6 space-y-4">
                        <div class="flex justify-between items-center">
                            <h3 class="text-lg font-bold text-[#FFDB89]">Subir foto de progreso</h3>
                            <button id="close-upload-photo" class="text-[#FFDB89]/50 hover:text-[#FFDB89] text-xl"><i class="fas fa-times"></i></button>
                        </div>
                        <div>
                            <label class="block text-xs font-bold text-[#FFDB89]/60 uppercase mb-1">Fecha</label>
                            <input type="date" id="photo-date" value="${today}" class="w-full p-2.5 bg-white/10 border border-[#FFDB89]/30 rounded-xl text-white text-sm outline-none focus:ring-2 focus:ring-[#FFDB89]">
                        </div>
                        <div>
                            <label class="block text-xs font-bold text-[#FFDB89]/60 uppercase mb-1">Categoría</label>
                            <select id="photo-category" class="w-full p-2.5 bg-[#1C1C1E] border border-[#FFDB89]/30 rounded-xl text-white text-sm outline-none focus:ring-2 focus:ring-[#FFDB89]">
                                <option>Inicio</option>
                                <option>Semana 4</option>
                                <option>Semana 8</option>
                                <option>Semana 12</option>
                                <option>Mes 3</option>
                                <option>Mes 6</option>
                                <option>Progreso</option>
                                <option>Final</option>
                            </select>
                        </div>
                        <div>
                            <label class="block text-xs font-bold text-[#FFDB89]/60 uppercase mb-1">Foto</label>
                            <label class="flex flex-col items-center justify-center gap-2 w-full h-36 border-2 border-dashed border-[#FFDB89]/30 hover:border-[#FFDB89] rounded-xl cursor-pointer transition text-[#FFDB89]/50 hover:text-[#FFDB89]">
                                <i class="fas fa-camera text-2xl"></i>
                                <span class="text-xs font-semibold" id="photo-file-label">Toca para seleccionar foto</span>
                                <input type="file" id="photo-file-input" accept="image/*" class="hidden">
                            </label>
                        </div>
                        <div>
                            <label class="block text-xs font-bold text-[#FFDB89]/60 uppercase mb-1">Notas (opcional)</label>
                            <input type="text" id="photo-notes" placeholder="Ej: Fin de semana 4..." class="w-full p-2.5 bg-white/10 border border-[#FFDB89]/30 rounded-xl text-white text-sm outline-none focus:ring-2 focus:ring-[#FFDB89] placeholder-[#FFDB89]/30">
                        </div>
                        <button id="save-progress-photo-btn" disabled
                            class="w-full py-3 rounded-xl bg-[#FFDB89] hover:bg-[#ffe9a8] text-[#030303] font-bold text-sm transition disabled:opacity-40 disabled:cursor-not-allowed">
                            <i class="fas fa-upload mr-2"></i>Subir foto
                        </button>
                    </div>
                </div>`);

            document.getElementById('close-upload-photo')?.addEventListener('click', () => document.getElementById('client-upload-photo-modal')?.remove());

            let imageDataUrl = null;
            document.getElementById('photo-file-input')?.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (!file) return;
                document.getElementById('photo-file-label').textContent = file.name;
                const reader = new FileReader();
                reader.onload = (ev) => {
                    imageDataUrl = ev.target.result;
                    document.getElementById('save-progress-photo-btn').disabled = false;
                };
                reader.readAsDataURL(file);
            });

            document.getElementById('save-progress-photo-btn')?.addEventListener('click', async () => {
                if (!imageDataUrl) return;
                const btn = document.getElementById('save-progress-photo-btn');
                btn.disabled = true;
                btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Subiendo...';
                try {
                    const res = await apiFetch('/api/progress-photos', {
                        method: 'POST',
                        body: JSON.stringify({
                            clientId:  session.id,
                            date:      document.getElementById('photo-date').value,
                            category:  document.getElementById('photo-category').value,
                            notes:     document.getElementById('photo-notes').value,
                            imageData: imageDataUrl
                        })
                    });
                    if (res.ok) {
                        document.getElementById('client-upload-photo-modal')?.remove();
                        loadPhotos();
                    } else {
                        showToast('Error subiendo foto. Intenta de nuevo.', 'error');
                        btn.disabled = false;
                        btn.innerHTML = '<i class="fas fa-upload mr-2"></i>Subir foto';
                    }
                } catch (e) { showToast('Error de conexión.', 'error'); btn.disabled = false; }
            });
        };

        if (uploadBtn) uploadBtn.addEventListener('click', openUploadModal);
        loadPhotos();
    };

    // --- CLIENT PROGRAMS: Show workout calendar ---
    const initClientPrograms = async () => {
        const session = loadSession();
        if (!session) return;

        // Set program name
        const progNameEl = document.getElementById('client-program-name');
        try {
            const profileRes = await apiFetch('/api/me');
            if (profileRes.ok) {
                const profile = await profileRes.json();
                if (progNameEl) progNameEl.textContent = profile.program || 'Sin programa asignado';
            }
        } catch (e) { /* silently fail */ }

        // Set current date display
        const dateDisplay = document.getElementById('current-date-display');
        if (dateDisplay) {
            const today = new Date();
            dateDisplay.textContent = today.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'short' });
        }

        // --- BUILD CONTINUOUS CALENDAR (matches trainer style) ---
        const buildClientCalendar = (workoutMap) => {
            const container = document.getElementById('client-calendar-container');
            if (!container) return;

            const today = new Date();
            const todayStr = today.toISOString().split('T')[0];
            const dayNames = ['DOM', 'LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB'];
            const monthNames = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

            // Start 2 months back, aligned to Monday
            const startDate = new Date(today);
            startDate.setMonth(today.getMonth() - 2);
            startDate.setDate(1);
            const dow = startDate.getDay();
            startDate.setDate(startDate.getDate() - (dow === 0 ? 6 : dow - 1));

            const totalDays = 40 * 7; // ~10 months
            let html = '';

            for (let i = 0; i < totalDays; i++) {
                const cur = new Date(startDate);
                cur.setDate(startDate.getDate() + i);
                const dateStr = cur.toISOString().split('T')[0];
                const dayNum = cur.getDate();
                const isToday = dateStr === todayStr;
                const isFirstOfMonth = dayNum === 1;
                const dayName = dayNames[cur.getDay()];
                const workout = workoutMap[dateStr];

                if (isFirstOfMonth) {
                    html += `<div class="month-divider px-5 py-2.5 bg-[#1C1C1E] border-b border-[#FFDB89]/15 sticky top-0 z-10">
                        <span class="text-xs font-bold text-[#FFDB89]/60 uppercase tracking-widest">${monthNames[cur.getMonth()]} ${cur.getFullYear()}</span>
                    </div>`;
                }

                const dayNumDisplay = isToday
                    ? `<span class="inline-flex items-center justify-center w-7 h-7 bg-[#FFDB89] text-[#1C1C1E] rounded-full text-sm font-bold">${dayNum}</span>`
                    : `<span class="text-lg font-bold text-[#FFDB89]/80">${dayNum}</span>`;

                const rowBg = isToday ? 'bg-[#FFDB89]/[0.06] border-l-2 border-l-[#FFDB89]' : '';

                let contentHtml = '';
                if (workout) {
                    if (workout.isRest) {
                        const isActive = workout.restType === 'active_rest';
                        const icon  = isActive ? 'fa-person-walking' : 'fa-moon';
                        const color = isActive ? '#6EE7B7' : '#93C5FD';
                        const label = workout.title || (isActive ? 'Descanso Activo' : 'Descanso');
                        contentHtml = `
                            <div class="flex items-center gap-2 py-0.5">
                                <div class="w-1 h-6 rounded-full shrink-0" style="background:${color}"></div>
                                <i class="fas ${icon} text-xs shrink-0" style="color:${color}"></i>
                                <span class="text-xs font-semibold" style="color:${color}">${label}</span>
                            </div>`;
                    } else {
                        const barColor = workout.isComplete ? '#4ade80' : workout.isMissed ? '#f87171' : '#FFDB89';
                        const statusIcon = workout.isComplete
                            ? `<i class="fas fa-check-circle text-xs text-green-400" title="Completado"></i>`
                            : workout.isMissed
                            ? `<i class="fas fa-times-circle text-xs text-red-400" title="Perdido"></i>`
                            : '';
                        contentHtml = `
                            <div class="flex items-center gap-3 py-0.5">
                                <div class="w-1 h-8 rounded-full shrink-0" style="background:${barColor}"></div>
                                <div class="min-w-0 flex-1">
                                    <div class="text-sm font-bold truncate flex items-center gap-1.5" style="color:${barColor}">${workout.title || 'Entrenamiento'} ${statusIcon}</div>
                                    <div class="text-xs text-[#FFDB89]/50">${(workout.exercises || []).length} ejercicio${(workout.exercises || []).length !== 1 ? 's' : ''}</div>
                                </div>
                                <button class="client-view-workout-btn text-[#FFDB89]/40 hover:text-[#FFDB89] transition px-3" data-date="${dateStr}">
                                    <i class="fas fa-chevron-right text-xs"></i>
                                </button>
                            </div>`;
                    }
                }

                html += `
                    <div id="client-day-${dateStr}" class="flex items-stretch border-b border-[#FFDB89]/10 relative hover:bg-white/[0.02] transition-colors ${rowBg} ${isToday ? 'client-is-today' : ''}">
                        <div class="w-16 shrink-0 flex flex-col items-center justify-center py-3 gap-0.5 border-r border-[#FFDB89]/10">
                            <span class="text-[10px] font-bold uppercase tracking-wide ${isToday ? 'text-[#FFDB89]' : 'text-[#FFDB89]/40'}">${dayName}</span>
                            ${dayNumDisplay}
                        </div>
                        <div class="flex-1 py-2.5 px-4 min-w-0 flex items-center">
                            <div class="w-full">${contentHtml}</div>
                        </div>
                    </div>`;
            }

            container.innerHTML = html;

            // Scroll to today
            setTimeout(() => {
                const todayEl = container.querySelector('.client-is-today');
                if (todayEl) todayEl.scrollIntoView({ block: 'center', behavior: 'auto' });
            }, 50);

            // Workout detail expand
            container.addEventListener('click', (e) => {
                const btn = e.target.closest('.client-view-workout-btn');
                if (!btn) return;
                const date = btn.dataset.date;
                const w = workoutMap[date];
                if (!w) return;
                showClientWorkoutDetail(w);
            });
        };

        // --- BUILD UPCOMING VIEW ---
        const buildUpcomingView = (workoutMap) => {
            const container = document.getElementById('client-upcoming-container');
            if (!container) return;

            const todayStr = new Date().toISOString().split('T')[0];
            const monthNames = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
            const dayNames = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];

            const upcoming = Object.values(workoutMap)
                .filter(w => w.date > todayStr && !w.isRest)
                .sort((a, b) => a.date.localeCompare(b.date));

            if (!upcoming.length) {
                container.innerHTML = `
                    <div class="flex flex-col items-center justify-center py-16 gap-3 text-center">
                        <div class="w-16 h-16 rounded-full bg-[#FFDB89]/10 flex items-center justify-center">
                            <i class="fas fa-calendar-check text-2xl text-[#FFDB89]/40"></i>
                        </div>
                        <p class="text-[#FFDB89]/50 font-semibold">No hay entrenamientos próximos</p>
                        <p class="text-xs text-[#FFDB89]/30">Tu entrenador aún no ha programado sesiones futuras</p>
                    </div>`;
                return;
            }

            container.innerHTML = upcoming.map(w => {
                const d = new Date(w.date + 'T00:00:00');
                const dayName = dayNames[d.getDay()];
                const exCount = (w.exercises || []).length;
                const dateLabel = `${dayName} ${d.getDate()} de ${monthNames[d.getMonth()]}`;
                return `
                    <div class="flex items-center gap-4 p-4 bg-white/5 border border-[#FFDB89]/15 rounded-2xl hover:bg-[#FFDB89]/5 hover:border-[#FFDB89]/30 transition cursor-pointer client-upcoming-card"
                         data-date="${escHtml(w.date)}">
                        <div class="w-12 h-12 shrink-0 rounded-xl bg-[#FFDB89]/10 flex flex-col items-center justify-center">
                            <span class="text-[10px] font-bold text-[#FFDB89]/50 uppercase">${dayName.slice(0,3)}</span>
                            <span class="text-xl font-black text-[#FFDB89] leading-none">${d.getDate()}</span>
                        </div>
                        <div class="flex-1 min-w-0">
                            <p class="font-bold text-[#FFDB89] truncate">${escHtml(w.title || 'Entrenamiento')}</p>
                            <p class="text-xs text-[#FFDB89]/50 mt-0.5">${dateLabel} · ${exCount} ejercicio${exCount !== 1 ? 's' : ''}</p>
                        </div>
                        <i class="fas fa-chevron-right text-xs text-[#FFDB89]/40"></i>
                    </div>`;
            }).join('');

            container.addEventListener('click', (e) => {
                const card = e.target.closest('.client-upcoming-card');
                if (!card) return;
                const w = workoutMap[card.dataset.date];
                if (w) showClientWorkoutDetail(w);
            });
        };

        // --- BUILD HISTORY VIEW ---
        const buildHistoryView = (workoutMap) => {
            const container = document.getElementById('client-history-container');
            if (!container) return;

            const todayStr = new Date().toISOString().split('T')[0];
            const monthNames = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
            const dayNames = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];

            const history = Object.values(workoutMap)
                .filter(w => w.date <= todayStr && !w.isRest)
                .sort((a, b) => b.date.localeCompare(a.date));

            if (!history.length) {
                container.innerHTML = `
                    <div class="flex flex-col items-center justify-center py-16 gap-3 text-center">
                        <div class="w-16 h-16 rounded-full bg-[#FFDB89]/10 flex items-center justify-center">
                            <i class="fas fa-history text-2xl text-[#FFDB89]/40"></i>
                        </div>
                        <p class="text-[#FFDB89]/50 font-semibold">Sin historial de entrenamientos</p>
                        <p class="text-xs text-[#FFDB89]/30">Tus entrenamientos completados aparecerán aquí</p>
                    </div>`;
                return;
            }

            container.innerHTML = history.map(w => {
                const d = new Date(w.date + 'T00:00:00');
                const dayName = dayNames[d.getDay()];
                const exCount = (w.exercises || []).length;
                const dateLabel = `${dayName} ${d.getDate()} de ${monthNames[d.getMonth()]}`;
                let statusIcon, statusColor, statusLabel;
                if (w.isComplete) {
                    statusIcon = 'fa-check-circle'; statusColor = 'text-green-400'; statusLabel = 'Completado';
                } else if (w.isMissed) {
                    statusIcon = 'fa-times-circle'; statusColor = 'text-red-400'; statusLabel = 'Perdido';
                } else {
                    statusIcon = 'fa-circle-dot'; statusColor = 'text-[#FFDB89]/30'; statusLabel = 'Sin estado';
                }
                return `
                    <div class="flex items-center gap-4 p-4 bg-white/5 border border-[#FFDB89]/15 rounded-2xl hover:bg-[#FFDB89]/5 hover:border-[#FFDB89]/30 transition cursor-pointer client-history-card"
                         data-date="${escHtml(w.date)}">
                        <div class="w-12 h-12 shrink-0 rounded-xl bg-[#FFDB89]/10 flex flex-col items-center justify-center">
                            <span class="text-[10px] font-bold text-[#FFDB89]/50 uppercase">${dayName.slice(0,3)}</span>
                            <span class="text-xl font-black text-[#FFDB89] leading-none">${d.getDate()}</span>
                        </div>
                        <div class="flex-1 min-w-0">
                            <p class="font-bold text-[#FFDB89] truncate">${escHtml(w.title || 'Entrenamiento')}</p>
                            <p class="text-xs text-[#FFDB89]/50 mt-0.5">${dateLabel} · ${exCount} ejercicio${exCount !== 1 ? 's' : ''}</p>
                        </div>
                        <i class="fas ${statusIcon} ${statusColor}" title="${statusLabel}"></i>
                    </div>`;
            }).join('');

            container.addEventListener('click', (e) => {
                const card = e.target.closest('.client-history-card');
                if (!card) return;
                const w = workoutMap[card.dataset.date];
                if (w) showClientWorkoutDetail(w);
            });
        };

        // Fetch and build
        try {
            const res = await apiFetch(`/api/client-workouts/${session.id}`);
            const workouts = res.ok ? await res.json() : [];
            const workoutMap = {};
            workouts.forEach(w => { workoutMap[w.date] = w; });
            buildClientCalendar(workoutMap);
            buildUpcomingView(workoutMap);
            buildHistoryView(workoutMap);
        } catch (e) {
            console.error('Error loading client calendar:', e);
            const container = document.getElementById('client-calendar-container');
            if (container) container.innerHTML = '<p class="text-center text-red-400 py-8">Error cargando calendario.</p>';
        }

        // --- MOOD: load today's mood, wire up buttons ---
        const todayStr = new Date().toISOString().split('T')[0];
        try {
            const moodRes = await apiFetch(`/api/nutrition-logs/${session.id}`);
            if (moodRes.ok) {
                const logs = await moodRes.json();
                const todayLog = logs.find(l => l.date === todayStr);
                if (todayLog?.mood) {
                    const activeBtn = document.querySelector(`.mood-btn[data-mood="${todayLog.mood}"]`);
                    if (activeBtn) activeBtn.classList.add('ring-2', 'ring-[#FFDB89]', 'bg-[#FFDB89]/10');
                }
            }
        } catch (e) { /* silently fail */ }

        document.querySelectorAll('.mood-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                document.querySelectorAll('.mood-btn').forEach(b => b.classList.remove('ring-2', 'ring-[#FFDB89]', 'bg-[#FFDB89]/10'));
                btn.classList.add('ring-2', 'ring-[#FFDB89]', 'bg-[#FFDB89]/10');
                const indicator = document.getElementById('mood-saved-indicator');
                try {
                    await Promise.all([
                        // Keep mood in nutrition log for client's own nutrition history
                        apiFetch('/api/nutrition-logs', {
                            method: 'POST',
                            body: JSON.stringify({ clientId: session.id, date: todayStr, mood: btn.dataset.mood })
                        }),
                        // Also store mood on the workout document so the trainer can see it
                        apiFetch(`/api/client-workouts/${session.id}/${todayStr}/mood`, {
                            method: 'PATCH',
                            body: JSON.stringify({ mood: btn.dataset.mood })
                        })
                    ]);
                    if (indicator) { indicator.classList.remove('hidden'); setTimeout(() => indicator.classList.add('hidden'), 2000); }
                } catch (e) { console.error('Error saving mood:', e); }
            });
        });

        // Scroll-to-today button
        const scrollBtn = document.getElementById('scroll-to-today-btn');
        if (scrollBtn) {
            scrollBtn.addEventListener('click', () => {
                const todayEl = document.querySelector('.client-is-today');
                if (todayEl) todayEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
            });
        }

        // --- TAB SWITCHING ---
        const progTabs = [
            { btnId: 'client-tab-calendar', panelId: 'client-panel-calendar' },
            { btnId: 'client-tab-upcoming', panelId: 'client-panel-upcoming' },
            { btnId: 'client-tab-history',  panelId: 'client-panel-history'  },
        ];
        progTabs.forEach(({ btnId, panelId }) => {
            const btnEl = document.getElementById(btnId);
            if (!btnEl) return;
            btnEl.addEventListener('click', () => {
                progTabs.forEach(({ btnId: b, panelId: p }) => {
                    const bEl = document.getElementById(b);
                    const pEl = document.getElementById(p);
                    const isActive = b === btnId;
                    if (bEl) {
                        bEl.classList.toggle('bg-[#FFDB89]',     isActive);
                        bEl.classList.toggle('text-[#030303]',   isActive);
                        bEl.classList.toggle('text-[#FFDB89]/60', !isActive);
                        bEl.classList.toggle('hover:text-[#FFDB89]', !isActive);
                    }
                    if (pEl) pEl.classList.toggle('hidden', !isActive);
                });
                // Only the calendar tab needs the "Ir a Hoy" button
                if (scrollBtn) scrollBtn.style.display = btnId === 'client-tab-calendar' ? '' : 'none';
            });
        });
    };

    // --- CLIENT WORKOUT DETAIL MODAL ---
    const showClientWorkoutDetail = (workout) => {
        const existing = document.getElementById('client-workout-detail-modal');
        if (existing) existing.remove();

        // --- Rest day modal ---
        if (workout.isRest) {
            const isActive = workout.restType === 'active_rest';
            const icon  = isActive ? 'fa-person-walking' : 'fa-moon';
            const color = isActive ? '#6EE7B7' : '#93C5FD';
            const label = workout.title || (isActive ? 'Descanso Activo' : 'Descanso');
            const tips  = isActive
                ? ['Caminata suave de 20–30 min', 'Movilidad articular o yoga', 'Natación a baja intensidad', 'Estiramientos profundos']
                : ['Descansa, no hagas ejercicio intenso', 'Prioriza el sueño y la recuperación', 'Hidratación y buena nutrición', 'Escucha a tu cuerpo'];
            document.body.insertAdjacentHTML('beforeend', `
                <div id="client-workout-detail-modal" class="fixed inset-0 z-[80] flex items-end md:items-center justify-center bg-black/60 backdrop-blur-sm p-4">
                    <div class="bg-[#1C1C1E] border rounded-2xl w-full max-w-md flex flex-col shadow-2xl" style="border-color:${color}33">
                        <div class="flex items-center justify-between p-5 border-b shrink-0" style="border-color:${color}22">
                            <div>
                                <h3 class="text-xl font-bold" style="color:${color}">${label}</h3>
                                <p class="text-xs mt-0.5" style="color:${color}88">${workout.date}</p>
                            </div>
                            <button id="close-client-workout-detail" class="w-11 h-11 flex items-center justify-center rounded-full transition hover:bg-white/10" style="color:${color}aa"><i class="fas fa-times text-lg"></i></button>
                        </div>
                        <div class="p-6 flex flex-col items-center gap-4">
                            <div class="w-20 h-20 rounded-full flex items-center justify-center" style="background:${color}22">
                                <i class="fas ${icon} text-4xl" style="color:${color}"></i>
                            </div>
                            <div class="w-full space-y-2">
                                ${tips.map(t => `<div class="flex items-center gap-3 p-3 rounded-xl" style="background:${color}11;border:1px solid ${color}22">
                                    <i class="fas fa-check text-xs" style="color:${color}"></i>
                                    <span class="text-sm" style="color:${color}cc">${t}</span>
                                </div>`).join('')}
                            </div>
                        </div>
                        <div class="px-5 pb-5">
                            <button id="close-client-workout-detail-btn" class="w-full py-2.5 rounded-xl font-bold text-sm transition" style="background:${color}22;color:${color};border:1px solid ${color}44">Cerrar</button>
                        </div>
                    </div>
                </div>`);
            document.getElementById('close-client-workout-detail')?.addEventListener('click', () => document.getElementById('client-workout-detail-modal')?.remove());
            document.getElementById('close-client-workout-detail-btn')?.addEventListener('click', () => document.getElementById('client-workout-detail-modal')?.remove());
            return;
        }

        // Working copy of exercises — client can type results without mutating the original yet
        const clientExercises = (workout.exercises || []).map(ex => ({ ...ex }));

        // Debounced auto-save for client results
        let _resultsSaveTimer = null;
        const scheduleResultsSave = () => {
            clearTimeout(_resultsSaveTimer);
            const indicator = document.getElementById('client-results-indicator');
            if (indicator) { indicator.textContent = ''; indicator.className = 'text-xs text-[#FFDB89]/30'; }
            _resultsSaveTimer = setTimeout(async () => {
                if (indicator) { indicator.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Guardando...'; indicator.className = 'text-xs text-[#FFDB89]/50'; }
                try {
                    const session = loadSession();
                    const clientId = workout.clientId || session?.id;
                    const res = await apiFetch(`/api/client-workouts/${clientId}/${workout.date}`, {
                        method: 'PATCH',
                        body: JSON.stringify({ exercises: clientExercises })
                    });
                    if (res.ok) {
                        workout.exercises = clientExercises.map(e => ({ ...e }));
                        if (indicator) { indicator.innerHTML = '<i class="fas fa-check mr-1"></i>Guardado'; indicator.className = 'text-xs text-green-400/60'; }
                        setTimeout(() => { if (indicator) indicator.textContent = ''; }, 2000);
                    } else {
                        if (indicator) { indicator.innerHTML = '<i class="fas fa-exclamation mr-1"></i>Error al guardar'; indicator.className = 'text-xs text-red-400/60'; }
                    }
                } catch(e) {
                    if (indicator) { indicator.innerHTML = '<i class="fas fa-wifi mr-1"></i>Sin conexión'; indicator.className = 'text-xs text-red-400/60'; }
                }
            }, 800);
        };

        const exercisesHtml = clientExercises.map((ex, i) => {
            const hasVideo   = !!ex.videoUrl;
            const safeUrl    = (ex.videoUrl || '').replace(/'/g, "\\'");
            const safeName   = (ex.name || '').replace(/'/g, "\\'");
            const safeResults = (ex.results || '').replace(/"/g, '&quot;');
            const exLabel    = (window.getExerciseLetter ? window.getExerciseLetter(i, clientExercises) : String.fromCharCode(65 + i % 26));
            const isDone     = ex.isComplete || false;
            return `
            <div class="ex-card bg-white/5 border ${isDone ? 'border-green-500/30' : 'border-[#FFDB89]/15'} rounded-xl overflow-hidden transition-colors duration-300" data-ex-card="${i}">
                <div class="flex gap-3 p-4 ${hasVideo ? 'cursor-pointer hover:bg-[#FFDB89]/5 group/excard' : ''}"
                     ${hasVideo ? `onclick="window.previewExerciseVideo('${safeUrl}','${safeName}',this)"` : ''}>
                    <div class="w-8 h-8 shrink-0 rounded-lg ${isDone ? 'bg-green-500/20' : 'bg-[#FFDB89]/10'} flex items-center justify-center font-black text-sm transition-colors duration-300" data-ex-badge="${i}">
                        ${isDone ? '<i class="fas fa-check text-green-400"></i>' : `<span class="text-[#FFDB89]">${exLabel}</span>`}
                    </div>
                    <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-2">
                            <p class="font-bold ${isDone ? 'text-green-400/80' : 'text-white'} flex-1 transition-colors duration-300" data-ex-name="${i}">${ex.name}</p>
                            ${hasVideo ? `<i class="fas fa-play-circle text-green-400/60 group-hover/excard:text-green-400 text-base shrink-0 transition-colors"></i>` : ''}
                        </div>
                        ${ex.instructions ? `<p class="text-sm text-[#FFDB89]/60 mt-0.5">${ex.instructions}</p>` : ''}
                    </div>
                    <!-- Per-exercise complete toggle -->
                    <button class="ex-complete-btn shrink-0 w-7 h-7 rounded-full border flex items-center justify-center transition-all duration-200 ${isDone ? 'bg-green-500/20 border-green-500/50 text-green-400' : 'border-white/20 text-white/30 hover:border-green-500/50 hover:text-green-400/60'}"
                        data-ex-index="${i}" title="Marcar ejercicio como completado">
                        <i class="fas fa-check text-xs pointer-events-none"></i>
                    </button>
                </div>
                <div class="px-4 pb-3 border-t ${isDone ? 'border-green-500/10' : 'border-[#FFDB89]/10'} pt-2.5 transition-colors duration-300" data-ex-divider="${i}">
                    <p class="text-[10px] font-bold text-[#FFDB89]/40 uppercase tracking-wider mb-1.5">Mis resultados</p>
                    <textarea data-ex-index="${i}" rows="2"
                        class="client-result-input w-full bg-[#0D0D0D] border border-[#FFDB89]/10 focus:border-[#FFDB89]/30 rounded-lg px-3 py-2 text-sm text-[#FFDB89]/80 placeholder-[#FFDB89]/20 outline-none resize-none transition"
                        placeholder="Sets, reps, peso... ej: 3×12 @ 60kg">${safeResults}</textarea>
                </div>
            </div>`;
        }).join('');

        // Warmup items for client view
        const warmupItemsHtml = (workout.warmupItems || []).map(item => {
            const safeUrl = (item.videoUrl || '').replace(/'/g, "\\'");
            const safeName = (item.name || '').replace(/'/g, "\\'");
            return `<div class="flex items-center gap-2 py-1">
                <i class="fas fa-circle text-orange-400/50 text-[6px] shrink-0"></i>
                <span class="text-sm text-white/70 flex-1">${item.name || ''}</span>
                ${item.videoUrl ? `<button onclick="event.stopPropagation();window.previewExerciseVideo('${safeUrl}','${safeName}',this)" class="text-green-400/60 hover:text-green-400 transition text-sm shrink-0"><i class="fas fa-play-circle"></i></button>` : ''}
            </div>`;
        }).join('');

        // Cooldown items for client view
        const cooldownItemsHtml = (workout.cooldownItems || []).map(item => {
            const safeUrl = (item.videoUrl || '').replace(/'/g, "\\'");
            const safeName = (item.name || '').replace(/'/g, "\\'");
            return `<div class="flex items-center gap-2 py-1">
                <i class="fas fa-circle text-blue-300/50 text-[6px] shrink-0"></i>
                <span class="text-sm text-white/70 flex-1">${item.name || ''}</span>
                ${item.videoUrl ? `<button onclick="event.stopPropagation();window.previewExerciseVideo('${safeUrl}','${safeName}',this)" class="text-green-400/60 hover:text-green-400 transition text-sm shrink-0"><i class="fas fa-play-circle"></i></button>` : ''}
            </div>`;
        }).join('');

        const savedRpe = workout.rpe || null;
        const rpeLabels = { 1:'Muy fácil',2:'Fácil',3:'Moderado-bajo',4:'Moderado',5:'Algo difícil',6:'Difícil',7:'Muy difícil',8:'Muy duro',9:'Casi al máximo',10:'Máximo esfuerzo' };

        const rpeButtons = Array.from({length:10},(_,i)=>{
            const n = i+1;
            const color = n<=3 ? 'text-green-400 border-green-400/30 hover:bg-green-400/10' : n<=6 ? 'text-yellow-400 border-yellow-400/30 hover:bg-yellow-400/10' : n<=8 ? 'text-orange-400 border-orange-400/30 hover:bg-orange-400/10' : 'text-red-400 border-red-400/30 hover:bg-red-400/10';
            const active = savedRpe === n ? (n<=3?'bg-green-400/20 border-green-400/60':n<=6?'bg-yellow-400/20 border-yellow-400/60':n<=8?'bg-orange-400/20 border-orange-400/60':'bg-red-400/20 border-red-400/60') : '';
            return `<button class="rpe-btn w-9 h-9 rounded-lg border text-sm font-black transition ${color} ${active}" data-rpe="${n}" title="${rpeLabels[n]}">${n}</button>`;
        }).join('');

        // RPE section visible if already complete OR already has an RPE saved
        const rpeVisible = workout.isComplete || !!savedRpe;

        document.body.insertAdjacentHTML('beforeend', `
            <div id="client-workout-detail-modal" class="fixed inset-0 z-[80] flex items-end md:items-center justify-center bg-black/60 backdrop-blur-sm p-4">
                <div class="bg-[#1C1C1E] border border-[#FFDB89]/20 rounded-2xl w-full max-w-lg max-h-[90vh] flex flex-col shadow-2xl">
                    <!-- Header -->
                    <div class="flex items-center justify-between p-5 border-b border-[#FFDB89]/15 shrink-0">
                        <div>
                            <h3 class="text-xl font-bold text-[#FFDB89]">${workout.title || 'Entrenamiento'}</h3>
                            <p class="text-xs text-[#FFDB89]/50 mt-0.5">${workout.date}</p>
                        </div>
                        <div class="flex items-center gap-2">
                            <span id="ex-progress-badge" class="text-xs font-bold text-[#FFDB89]/40 hidden">${clientExercises.filter(e=>e.isComplete).length}/${clientExercises.length}</span>
                            <button id="close-client-workout-detail" class="w-11 h-11 flex items-center justify-center rounded-full text-[#FFDB89]/50 hover:text-[#FFDB89] hover:bg-[#FFDB89]/10 transition"><i class="fas fa-times text-lg"></i></button>
                        </div>
                    </div>

                    <!-- Scrollable body -->
                    <div class="overflow-y-auto p-5 space-y-3 flex-1">
                        ${(workout.warmup || warmupItemsHtml) ? `
                        <div class="p-3 bg-orange-500/10 border border-orange-500/20 rounded-xl">
                            <p class="text-xs font-bold text-orange-400 uppercase mb-1.5"><i class="fas fa-fire mr-1"></i>Calentamiento</p>
                            ${workout.warmup ? `<p class="text-sm text-white/80 mb-2">${workout.warmup}</p>` : ''}
                            ${warmupItemsHtml ? `<div class="space-y-0.5">${warmupItemsHtml}</div>` : ''}
                        </div>` : ''}
                        <div class="flex items-center justify-between">
                            <p class="text-xs font-bold text-[#FFDB89]/50 uppercase tracking-wider">Ejercicios</p>
                            <span id="client-results-indicator" class="text-xs text-[#FFDB89]/30"></span>
                        </div>
                        ${exercisesHtml}
                        ${(workout.cooldown || cooldownItemsHtml) ? `
                        <div class="p-3 bg-blue-500/10 border border-blue-500/20 rounded-xl">
                            <p class="text-xs font-bold text-blue-400 uppercase mb-1.5"><i class="fas fa-snowflake mr-1"></i>Enfriamiento</p>
                            ${workout.cooldown ? `<p class="text-sm text-white/80 mb-2">${workout.cooldown}</p>` : ''}
                            ${cooldownItemsHtml ? `<div class="space-y-0.5">${cooldownItemsHtml}</div>` : ''}
                        </div>` : ''}
                        ${!exercisesHtml && !workout.warmup ? '<p class="text-center text-[#FFDB89]/40 py-6">Día de descanso</p>' : ''}
                    </div>

                    <!-- Sticky footer: RPE (only when complete) + Completion button -->
                    <div class="shrink-0 border-t border-[#FFDB89]/15 bg-[#111113] rounded-b-2xl">

                        <!-- RPE section — hidden until workout is marked complete -->
                        <div id="rpe-section" class="${rpeVisible ? '' : 'hidden'} p-4 pb-0 space-y-3">
                            <div class="flex items-center justify-between">
                                <div>
                                    <p class="text-xs font-bold text-[#FFDB89]/80 uppercase tracking-wider">RPE — Esfuerzo percibido</p>
                                    <p id="rpe-label-text" class="text-xs text-[#FFDB89]/50 mt-0.5">${savedRpe ? rpeLabels[savedRpe] : 'Selecciona cómo te fue hoy'}</p>
                                </div>
                                <span id="rpe-selected-badge" class="text-2xl font-black ${savedRpe ? 'text-[#FFDB89]' : 'text-[#FFDB89]/20'}">${savedRpe ? savedRpe + '/10' : '—'}</span>
                            </div>
                            <div class="flex gap-1.5 justify-between">
                                ${rpeButtons}
                            </div>
                            <button id="save-rpe-btn" class="w-full py-2 rounded-xl bg-[#FFDB89]/10 border border-[#FFDB89]/20 text-[#FFDB89] text-sm font-bold hover:bg-[#FFDB89]/20 transition ${savedRpe ? '' : 'opacity-50 cursor-not-allowed'}" ${savedRpe ? '' : 'disabled'}>
                                <i class="fas fa-check mr-2"></i>${savedRpe ? 'RPE guardado — actualizar' : 'Guardar RPE'}
                            </button>
                        </div>

                        <!-- Completion button — always visible -->
                        <div class="p-4 ${rpeVisible ? 'pt-3 border-t border-[#FFDB89]/10' : ''}">
                            <button id="client-complete-btn"
                                class="w-full py-3 rounded-xl border font-bold text-sm transition flex items-center justify-center gap-2 ${workout.isComplete ? 'bg-green-500/20 border-green-500/50 text-green-400' : 'bg-white/5 border-[#FFDB89]/20 text-[#FFDB89]/70 hover:bg-green-500/10 hover:border-green-500/40 hover:text-green-400'}">
                                <i class="fas ${workout.isComplete ? 'fa-check-circle' : 'fa-dumbbell'} text-sm"></i>
                                ${workout.isComplete ? '¡Entrenamiento completado!' : 'Completar entrenamiento'}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `);

        document.getElementById('close-client-workout-detail').onclick = () => {
            document.getElementById('client-workout-detail-modal')?.remove();
        };
        document.getElementById('client-workout-detail-modal').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) e.currentTarget.remove();
        });

        // Wire result textareas — auto-save on input with debounce
        document.querySelectorAll('.client-result-input').forEach(textarea => {
            textarea.addEventListener('input', () => {
                const idx = parseInt(textarea.dataset.exIndex);
                if (!isNaN(idx) && clientExercises[idx]) {
                    clientExercises[idx].results = textarea.value;
                    scheduleResultsSave();
                }
            });
        });

        // ── Per-exercise completion buttons ──────────────────────────────────
        // Show progress badge in header if there are exercises
        const progressBadge = document.getElementById('ex-progress-badge');
        const updateProgressBadge = () => {
            if (!progressBadge || clientExercises.length === 0) return;
            const done = clientExercises.filter(e => e.isComplete).length;
            progressBadge.textContent = `${done}/${clientExercises.length}`;
            progressBadge.classList.toggle('hidden', done === 0);
            if (done === clientExercises.length) {
                progressBadge.className = 'text-xs font-bold text-green-400';
            } else {
                progressBadge.className = 'text-xs font-bold text-[#FFDB89]/40';
            }
        };
        updateProgressBadge();

        const exLabel = (idx) => (window.getExerciseLetter ? window.getExerciseLetter(idx, clientExercises) : String.fromCharCode(65 + idx % 26));

        document.querySelectorAll('.ex-complete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation(); // don't trigger video preview
                const idx = parseInt(btn.dataset.exIndex);
                if (isNaN(idx) || !clientExercises[idx]) return;

                // Toggle
                clientExercises[idx].isComplete = !clientExercises[idx].isComplete;
                const isDone = clientExercises[idx].isComplete;

                // Update card border
                const card = document.querySelector(`[data-ex-card="${idx}"]`);
                if (card) {
                    card.classList.toggle('border-green-500/30', isDone);
                    card.classList.toggle('border-[#FFDB89]/15', !isDone);
                }

                // Update badge (letter → check)
                const badge = document.querySelector(`[data-ex-badge="${idx}"]`);
                if (badge) {
                    badge.className = `w-8 h-8 shrink-0 rounded-lg ${isDone ? 'bg-green-500/20' : 'bg-[#FFDB89]/10'} flex items-center justify-center font-black text-sm transition-colors duration-300`;
                    badge.innerHTML = isDone
                        ? '<i class="fas fa-check text-green-400"></i>'
                        : `<span class="text-[#FFDB89]">${exLabel(idx)}</span>`;
                }

                // Update name colour
                const nameEl = document.querySelector(`[data-ex-name="${idx}"]`);
                if (nameEl) {
                    nameEl.classList.toggle('text-green-400/80', isDone);
                    nameEl.classList.toggle('text-white', !isDone);
                }

                // Update divider colour
                const divider = document.querySelector(`[data-ex-divider="${idx}"]`);
                if (divider) {
                    divider.classList.toggle('border-green-500/10', isDone);
                    divider.classList.toggle('border-[#FFDB89]/10', !isDone);
                }

                // Update the button itself
                btn.className = `ex-complete-btn shrink-0 w-7 h-7 rounded-full border flex items-center justify-center transition-all duration-200 ${isDone ? 'bg-green-500/20 border-green-500/50 text-green-400' : 'border-white/20 text-white/30 hover:border-green-500/50 hover:text-green-400/60'}`;

                updateProgressBadge();

                // Auto-save exercise completion state
                scheduleResultsSave();

                // Auto-complete workout when all exercises are done
                if (isDone && clientExercises.length > 0 && clientExercises.every(ex => ex.isComplete)) {
                    const completeBtn = document.getElementById('client-complete-btn');
                    if (completeBtn && !workoutIsComplete) {
                        setTimeout(() => completeBtn.click(), 400); // slight delay for visual feedback
                    }
                }
            });
        });

        // RPE picker interaction
        let selectedRpe = workout.rpe || null;

        document.querySelectorAll('.rpe-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                selectedRpe = parseInt(btn.dataset.rpe);
                const colorActive = selectedRpe<=3?'bg-green-400/20 border-green-400/60':selectedRpe<=6?'bg-yellow-400/20 border-yellow-400/60':selectedRpe<=8?'bg-orange-400/20 border-orange-400/60':'bg-red-400/20 border-red-400/60';
                document.querySelectorAll('.rpe-btn').forEach(b => {
                    const n = parseInt(b.dataset.rpe);
                    const col = n<=3?'text-green-400 border-green-400/30 hover:bg-green-400/10':n<=6?'text-yellow-400 border-yellow-400/30 hover:bg-yellow-400/10':n<=8?'text-orange-400 border-orange-400/30 hover:bg-orange-400/10':'text-red-400 border-red-400/30 hover:bg-red-400/10';
                    b.className = `rpe-btn w-9 h-9 rounded-lg border text-sm font-black transition ${col} ${n===selectedRpe?colorActive:''}`;
                });
                document.getElementById('rpe-label-text').textContent = rpeLabels[selectedRpe];
                document.getElementById('rpe-selected-badge').textContent = selectedRpe + '/10';
                document.getElementById('rpe-selected-badge').className = 'text-2xl font-black text-[#FFDB89]';
                const saveBtn = document.getElementById('save-rpe-btn');
                saveBtn.disabled = false;
                saveBtn.classList.remove('opacity-50','cursor-not-allowed');
                saveBtn.innerHTML = '<i class="fas fa-check mr-2"></i>Guardar RPE';
            });
        });

        document.getElementById('save-rpe-btn')?.addEventListener('click', async () => {
            if (!selectedRpe || !workout._id) return;
            const saveBtn = document.getElementById('save-rpe-btn');
            saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Guardando...';
            saveBtn.disabled = true;
            try {
                const session = loadSession();
                const res = await apiFetch(`/api/client-workouts/${workout.clientId || session?.id}/${workout.date}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ rpe: selectedRpe })
                });
                if (res.ok) {
                    saveBtn.innerHTML = '<i class="fas fa-check mr-2"></i>RPE guardado';
                    saveBtn.classList.add('bg-[#FFDB89]/20');
                    setTimeout(() => {
                        saveBtn.innerHTML = '<i class="fas fa-check mr-2"></i>RPE guardado — actualizar';
                        saveBtn.disabled = false;
                    }, 1500);
                } else {
                    saveBtn.innerHTML = '<i class="fas fa-times mr-2"></i>Error al guardar';
                    saveBtn.disabled = false;
                }
            } catch(e) {
                saveBtn.innerHTML = '<i class="fas fa-wifi mr-2"></i>Error de conexión';
                saveBtn.disabled = false;
            }
        });

        // ── Complete button ──────────────────────────────────────────────────
        let workoutIsComplete = workout.isComplete || false;
        const showRpeSection = () => {
            const rpeSection = document.getElementById('rpe-section');
            const completeDiv = rpeSection?.nextElementSibling; // the completion button wrapper
            if (!rpeSection) return;
            rpeSection.classList.remove('hidden');
            if (completeDiv) {
                completeDiv.classList.add('pt-3', 'border-t', 'border-[#FFDB89]/10');
            }
        };
        const hideRpeSection = () => {
            const rpeSection = document.getElementById('rpe-section');
            const completeDiv = rpeSection?.nextElementSibling;
            if (!rpeSection || selectedRpe) return; // keep visible if RPE was already saved
            rpeSection.classList.add('hidden');
            if (completeDiv) {
                completeDiv.classList.remove('pt-3', 'border-t', 'border-[#FFDB89]/10');
            }
        };

        document.getElementById('client-complete-btn').addEventListener('click', async () => {
            const session = loadSession();
            const btn = document.getElementById('client-complete-btn');
            const prevState = workoutIsComplete;
            workoutIsComplete = !workoutIsComplete;
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>';
            try {
                const clientId = workout.clientId || session?.id;
                const res = await apiFetch(`/api/client-workouts/${clientId}/${workout.date}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ isComplete: workoutIsComplete, isMissed: false })
                });
                if (res.ok) {
                    // Persist state back into the in-memory workout object
                    workout.isComplete = workoutIsComplete;
                    workout.isMissed   = false;

                    btn.disabled = false;
                    btn.className = `w-full py-3 rounded-xl border font-bold text-sm transition flex items-center justify-center gap-2 ${workoutIsComplete ? 'bg-green-500/20 border-green-500/50 text-green-400' : 'bg-white/5 border-[#FFDB89]/20 text-[#FFDB89]/70 hover:bg-green-500/10 hover:border-green-500/40 hover:text-green-400'}`;
                    btn.innerHTML = `<i class="fas ${workoutIsComplete ? 'fa-check-circle' : 'fa-dumbbell'} text-sm"></i> ${workoutIsComplete ? '¡Entrenamiento completado!' : 'Completar entrenamiento'}`;

                    // Show / hide RPE section based on completion state
                    if (workoutIsComplete) showRpeSection();
                    else hideRpeSection();

                    // Update calendar cell colour + status icon
                    const calCell = document.getElementById(`client-day-${workout.date}`);
                    if (calCell) {
                        const bar = calCell.querySelector('.w-1.h-8');
                        const barColor = workoutIsComplete ? '#4ade80' : '#FFDB89';
                        if (bar) bar.style.background = barColor;
                        const titleEl = calCell.querySelector('.text-sm.font-bold');
                        if (titleEl) titleEl.style.color = barColor;
                        let dot = calCell.querySelector('.completion-dot');
                        if (workoutIsComplete) {
                            if (!dot) {
                                dot = document.createElement('span');
                                dot.className = 'completion-dot text-xs text-green-400';
                                calCell.querySelector('.text-sm.font-bold')?.appendChild(dot);
                            }
                            dot.innerHTML = ' <i class="fas fa-check-circle"></i>';
                        } else {
                            dot?.remove();
                        }
                    }
                    showToast(workoutIsComplete ? '💪 ¡Entrenamiento completado!' : 'Marcado como no completado', workoutIsComplete ? 'success' : 'info');
                } else {
                    workoutIsComplete = prevState;
                    btn.disabled = false;
                    showToast('Error al guardar. Intenta de nuevo.', 'error');
                }
            } catch(e) {
                workoutIsComplete = prevState;
                btn.disabled = false;
                showToast('Error de conexión.', 'error');
            }
        });
    };

    // RENDER TRAINER HOME
    window.renderTrainerHome = async (trainerName, filterType = 'Todos') => {
        const greetingEl = document.getElementById('greeting-text');
        const feedContainer = document.getElementById('trainer-feed-container');
        if (!feedContainer) return;

        const hour = new Date().getHours();
        let greeting = "¡Buenos días";
        if (hour >= 12 && hour < 18) greeting = "¡Buenas tardes";
        else if (hour >= 18) greeting = "¡Buenas noches";
        if(greetingEl) greetingEl.textContent = `${greeting}, ${trainerName.split(' ')[0]}!`;

        // Wire up filter dropdown — done here so it always registers regardless of early returns below
        window.setClientFilter = (label) => {
            document.getElementById('client-filter-label').textContent = label;
            document.getElementById('client-filter-dropdown').classList.add('hidden');
            window.renderTrainerHome(trainerName, label);
        };
        // Show loading state
        feedContainer.innerHTML = '<p class="text-center text-[#FFDB89]/50 py-8"><i class="fas fa-spinner fa-spin mr-2"></i>Cargando actividad...</p>';

        const todayStr = new Date().toISOString().split('T')[0];

        // Filter clients by type
        const clientsToRender = filterType === 'Todos'
            ? clientsCache.filter(c => c.isActive)
            : clientsCache.filter(c => c.isActive && c.type === filterType);

        // Fetch today's workouts for filtered clients
        const feedItems = [];
        for (const client of clientsToRender) {
            try {
                const res = await apiFetch(`/api/client-workouts/${client._id}/${todayStr}`);
                const clientName = `${client.name} ${client.lastName || ''}`.trim();
                const initials = (client.name.charAt(0) + (client.lastName ? client.lastName.charAt(0) : '')).toUpperCase();
                const dueDate = client.dueDate ? new Date(client.dueDate).toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' }) : '--';

                if (res.ok) {
                    const workout = await res.json();
                    feedItems.push({
                        clientId: client._id,
                        clientName,
                        initials,
                        dueDate,
                        hasWorkout: true,
                        workoutTitle: workout.title || 'Entrenamiento',
                        warmup: workout.warmup || '',
                        cooldown: workout.cooldown || '',
                        exercises: (workout.exercises || []).map((ex, i) => ({
                            letter: (window.getExerciseLetter ? window.getExerciseLetter(i, workout.exercises) : String.fromCharCode(65 + i % 26)),
                            name: ex.name,
                            instructions: ex.instructions || ''
                        }))
                    });
                } else {
                    // Client has no workout today — show rest day card
                    feedItems.push({
                        clientId: client._id,
                        clientName,
                        initials,
                        dueDate,
                        hasWorkout: false
                    });
                }
            } catch (e) {
                console.error(`Error fetching workout for client ${client._id}:`, e);
            }
        }

        if (feedItems.length === 0) {
            feedContainer.innerHTML = '<p class="text-center text-[#FFDB89]/40 py-8">No hay clientes registrados.</p>';
            return;
        }

        // Show rest days toggle
        const showRest = document.getElementById('show-rest-days')?.checked;
        const visibleItems = showRest ? feedItems : feedItems.filter(item => item.hasWorkout);

        if (visibleItems.length === 0) {
            feedContainer.innerHTML = '<p class="text-center text-[#FFDB89]/40 py-8">No hay entrenamientos programados para hoy.</p>';
            return;
        }

        feedContainer.innerHTML = visibleItems.map(item => {
            if (!item.hasWorkout) {
                return `
                <div class="bg-[#FFDB89]/5 border border-[#FFDB89]/10 rounded-2xl overflow-hidden opacity-50">
                    <div class="px-5 py-3 border-b border-[#FFDB89]/10 flex items-center gap-3">
                        <div class="w-10 h-10 rounded-full bg-[#FFDB89]/15 text-[#FFDB89] flex items-center justify-center font-bold text-sm cursor-pointer hover:bg-[#FFDB89]/25 transition" onclick="window.openClientProfile('${item.clientId}')">${item.initials}</div>
                        <div>
                            <h3 class="font-bold text-[#FFDB89] leading-tight cursor-pointer hover:text-[#FFDB89]/80 transition" onclick="window.openClientProfile('${item.clientId}')">${item.clientName}</h3>
                            <p class="text-xs text-[#FFDB89]/40">Vence: ${item.dueDate}</p>
                        </div>
                    </div>
                    <div class="px-5 py-5 flex items-center gap-3">
                        <i class="fas fa-moon text-[#93C5FD] text-lg"></i>
                        <p class="text-[#FFDB89]/50 font-medium text-sm">Día de descanso</p>
                    </div>
                </div>`;
            }

            return `
            <div class="bg-[#FFDB89]/5 border border-[#FFDB89]/15 rounded-2xl overflow-hidden">
                <!-- Client header -->
                <div class="px-5 py-3 border-b border-[#FFDB89]/10 flex items-center gap-3">
                    <div class="w-10 h-10 rounded-full bg-[#FFDB89]/15 text-[#FFDB89] flex items-center justify-center font-bold text-sm cursor-pointer hover:bg-[#FFDB89]/25 transition shrink-0" onclick="window.openClientProfile('${item.clientId}')">${item.initials}</div>
                    <div>
                        <h3 class="font-bold text-[#FFDB89] leading-tight cursor-pointer hover:text-[#FFDB89]/80 transition" onclick="window.openClientProfile('${item.clientId}')">${item.clientName}</h3>
                        <p class="text-xs text-[#FFDB89]/40">Vence: ${item.dueDate}</p>
                    </div>
                </div>
                <!-- Workout title + warmup -->
                <div class="px-5 py-4 border-b border-[#FFDB89]/10">
                    <h2 class="text-lg font-bold text-[#FFDB89]">${item.workoutTitle}</h2>
                    ${item.warmup ? `<p class="text-sm text-orange-400 mt-1.5"><i class="fas fa-fire mr-1.5"></i>${item.warmup}</p>` : ''}
                </div>
                <!-- Exercises -->
                <div class="px-5 py-4 space-y-3">
                    ${item.exercises.map(ex => `
                        <div class="flex items-start gap-3">
                            <div class="w-7 h-7 bg-[#FFDB89]/15 text-[#FFDB89] font-black rounded-lg flex items-center justify-center text-xs shrink-0">${ex.letter}</div>
                            <div class="flex-1 min-w-0">
                                <p class="font-bold text-white text-sm">${ex.name}</p>
                                ${ex.instructions ? `<p class="text-xs text-[#FFDB89]/50 mt-0.5 leading-relaxed">${ex.instructions}</p>` : ''}
                            </div>
                        </div>`).join('')}
                </div>
                ${item.cooldown ? `<div class="px-5 pb-4"><p class="text-sm"><i class="fas fa-snowflake text-sky-400 mr-1.5"></i><span class="text-[#FFDB89]/70">${item.cooldown}</span></p></div>` : ''}
            </div>`;
        }).join('');

        // Wire up rest-days toggle (preserve active filter)
        const restToggle = document.getElementById('show-rest-days');
        if (restToggle) {
            restToggle.onchange = () => window.renderTrainerHome(trainerName, filterType);
        }

    };

    // UPDATED TIPS (Full List)
    const fitnessTips = {
        en: [ "Drink water before every meal.", "Prioritize protein in every meal.", "Sleep is your best supplement.", "Consistency beats intensity.", "Walk 10k steps daily.", "Don't drink your calories.", "Lift heavy things.", "Eat whole foods 80% of the time.", "Track your progress.", "Rest days are growth days.", "Compound lifts give best ROI.", "Form over weight, always.", "Eat more vegetables.", "Creatine is safe and effective.", "Protein shakes are just food.", "You can't out-train a bad diet.", "Progressive overload is key.", "Warm up before lifting.", "Stretch after lifting.", "Take progress photos.", "Don't fear carbohydrates.", "Fats are essential for hormones.", "Sugar isn't poison, excess is.", "Listen to your body.", "Deload weeks prevent injury.", "Training to failure is optional.", "Volume drives hypertrophy.", "Strength takes years, not weeks.", "Motivation fades, discipline stays.", "Meal prep saves time and waistlines.", "Alcohol kills gains.", "Sleep 7-9 hours.", "Hydrate first thing in the morning.", "Caffeine is a valid performance enhancer.", "Don't ego lift.", "Track your steps.", "Non-exercise activity matters (NEAT).", "Fiber keeps you full.", "Eat slowly.", "Stop when 80% full.", "Weigh yourself daily, average weekly.", "Scale weight fluctuates, don't panic.", "Take walks after meals.", "Sunlight helps sleep rhythm.", "Magnesium helps recovery.", "Consistency > Perfection.", "Enjoy your favorite foods in moderation.", "Fitness is a marathon, not a sprint.", "Focus on habits, not just goals.", "You got this." ],
        es: [ "Bebe agua antes de cada comida.", "Prioriza la proteína en cada comida.", "El sueño es tu mejor suplemento.", "La consistencia supera a la intensidad.", "Camina 10 mil pasos diarios.", "No te bebas tus calorías.", "Levanta cosas pesadas.", "Come alimentos enteros el 80% del tiempo.", "Rastrea tu progreso.", "Los días de descanso son días de crecimiento.", "Los ejercicios compuestos dan el mejor ROI.", "Técnica sobre peso, siempre.", "Come más vegetales.", "La creatina es segura y efectiva.", "Los batidos de proteína son solo comida.", "No puedes entrenar para compensar una mala dieta.", "La sobrecarga progresiva es clave.", "Calienta antes de levantar.", "Estira después de levantar.", "Toma fotos de progreso.", "No le temas a los carbohidratos.", "Las grasas son esenciales para las hormonas.", "El azúcar no es veneno, el exceso sí.", "Escucha a tu cuerpo.", "Las semanas de descarga previenen lesiones.", "Entrenar al fallo es opcional.", "El volumen impulsa la hipertrofia.", "La fuerza toma años, no semanas.", "La motivación se desvanece, la disciplina se queda.", "Preparar comidas ahorra tiempo y cintura.", "El alcohol mata las ganancias.", "Duerme 7-9 horas.", "Hidrátate a primera hora de la mañana.", "La cafeína es un potenciador de rendimiento válido.", "No levantes por ego.", "Rastrea tus pasos.", "La actividad no relacionada con el ejercicio importa (NEAT).", "La fibra te mantiene lleno.", "Come despacio.", "Detente cuando estés 80% lleno.", "Pésate diariamente, promedia semanalmente.", "El peso de la báscula fluctúa, no entres en pánico.", "Da paseos después de las comidas.", "La luz solar ayuda al ritmo del sueño.", "El magnesio ayuda a la recuperación.", "Consistencia > Perfección.", "Disfruta tus comidas favoritas con moderación.", "El fitness es un maratón, no un sprint.", "Enfócate en hábitos, no solo en metas.", "Tú puedes con esto." ]
    };

    window.updateFitnessTipLanguage = (lang) => { renderRandomTip(lang); };
    const renderRandomTip = (lang = 'es') => {
        const tipEl = document.getElementById('daily-fitness-tip');
        if (tipEl && fitnessTips[lang]) {
            const randomTip = fitnessTips[lang][Math.floor(Math.random() * fitnessTips[lang].length)];
            tipEl.textContent = `"${randomTip}"`;
        }
    };
    renderRandomTip('es');

    // FIX: initAuthListeners was called OUTSIDE this closure before — moved inside
    initAuthListeners();
});