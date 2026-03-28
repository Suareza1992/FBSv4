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

    // --- AUTH TOKEN HELPER ---
    // NEW: Every API call goes through this wrapper, which automatically
    // attaches the JWT token and handles expired sessions.
    const getToken = () => localStorage.getItem('auth_token');

    const apiFetch = async (url, options = {}) => {
        const token = getToken();
        const headers = {
            'Content-Type': 'application/json',
            ...(options.headers || {}),
        };
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        const res = await fetch(url, { ...options, headers });

        // If token expired or invalid, force logout — but ONLY if there was a token
        // (if no token, user just isn't logged in yet — don't reload or we get an infinite loop)
        if (res.status === 401) {
            if (token) {
                localStorage.removeItem('auth_token');
                localStorage.removeItem('auth_user');
                location.reload();
            }
            throw new Error('Session expired');
        }

        return res;
    };

    // --- DATA STORES ---
    let mockClientsDb = [];
    let mockProgramsDb = [];
    let globalExerciseLibrary = [];
    let mockGroupsDb = ['General', 'Planet Fitness', 'Morning Crew']; 

    // --- STATE VARIABLES ---
    const MODULE_CACHE = {}; 
    let currentWeekCount = 0;
    let exerciseCount = 0;
    let currentProgramId = null;
    let currentEditingDay = null; 
    let currentEditingWeekIndex = 0;
    let currentVideoExerciseBtn = null;
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
    let editorWorkoutTitle = "";
    let editorCooldown = "";
    let currentEditorExId = null; // Track which exercise is being edited for Video/History
    let editorIsDirty = false;
    let editorAutosaveInterval = null;

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
                mockGroupsDb = groups.map(g => g.name);
                // Ensure 'General' always exists
                if (!mockGroupsDb.includes('General')) mockGroupsDb.unshift('General');
                console.log("Groups loaded:", mockGroupsDb.length);
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
                mockClientsDb = await res.json();
                console.log("Clients loaded:", mockClientsDb.length);
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
            if(res.ok) mockProgramsDb = await res.json();
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
                    if (empty) empty.classList.remove('hidden');
                    feed.innerHTML = '';
                    return;
                }
                if (empty) empty.classList.add('hidden');
                feed.innerHTML = notifications.map(n => renderNotificationItem(n)).join('');
            }
        } catch (e) { console.error('Error fetching notifications:', e); }
    };

    const renderNotificationItem = (n) => {
        const config = getNotificationConfig(n.type);
        const readClass = n.isRead ? 'opacity-60' : 'cursor-pointer hover:brightness-95';
        const timeAgo = getTimeAgo(new Date(n.createdAt));
        const clickHandler = !n.isRead ? `onclick="window.markNotificationRead('${n._id}')"` : '';

        return `
            <div class="flex items-start p-4 ${config.bgClass} rounded-lg border-l-4 ${config.borderClass} ${readClass} transition-all"
                 data-notification-id="${n._id}" ${clickHandler}>
                <i class="${config.icon} ${config.iconColor} mt-1 mr-4 text-xl shrink-0"></i>
                <div class="flex-grow">
                    <p class="font-medium text-gray-900 dark:text-gray-100">
                        <span class="cursor-pointer text-blue-600 dark:text-blue-400 hover:underline font-semibold"
                              onclick="event.stopPropagation(); window.openClientProfile('${n.clientId}')">${n.clientName}</span>
                        ${n.title}
                    </p>
                    <p class="text-sm text-gray-700 dark:text-gray-400">${n.message}</p>
                    <p class="text-xs text-gray-400 mt-1">${timeAgo}</p>
                </div>
                ${!n.isRead ? `<span class="w-2.5 h-2.5 rounded-full bg-blue-500 mt-1.5 ml-3 shrink-0"></span>` : ''}
            </div>
        `;
    };

    const getNotificationConfig = (type) => {
        const configs = {
            workout_missed:    { icon: 'fas fa-calendar-times', iconColor: 'text-red-700 dark:text-red-400',       bgClass: 'bg-red-50 dark:bg-red-900/20',       borderClass: 'border-red-500' },
            workout_completed: { icon: 'fas fa-check-circle',   iconColor: 'text-green-700 dark:text-green-400',   bgClass: 'bg-green-50 dark:bg-green-900/20',   borderClass: 'border-green-500' },
            metric_resistance: { icon: 'fas fa-chart-line',     iconColor: 'text-teal-700 dark:text-teal-400',     bgClass: 'bg-teal-50 dark:bg-teal-900/20',     borderClass: 'border-teal-500' },
            nutrition_logged:  { icon: 'fas fa-utensils',       iconColor: 'text-blue-700 dark:text-blue-400',     bgClass: 'bg-blue-50 dark:bg-blue-900/20',     borderClass: 'border-blue-500' },
            progress_photos:   { icon: 'fas fa-camera',         iconColor: 'text-pink-700 dark:text-pink-400',     bgClass: 'bg-pink-50 dark:bg-pink-900/20',     borderClass: 'border-pink-500' },
            weight_update:     { icon: 'fas fa-weight',         iconColor: 'text-yellow-700 dark:text-yellow-400', bgClass: 'bg-yellow-50 dark:bg-yellow-900/20', borderClass: 'border-yellow-500' },
            workout_comment:   { icon: 'fas fa-comment-dots',   iconColor: 'text-gray-700 dark:text-gray-300',     bgClass: 'bg-gray-100 dark:bg-gray-700',       borderClass: 'border-gray-400' },
            video_upload:      { icon: 'fas fa-video',          iconColor: 'text-indigo-700 dark:text-indigo-400', bgClass: 'bg-indigo-50 dark:bg-indigo-900/20', borderClass: 'border-indigo-500' },
            reported_issue:    { icon: 'fas fa-exclamation-triangle', iconColor: 'text-orange-700 dark:text-orange-400', bgClass: 'bg-orange-50 dark:bg-orange-900/20', borderClass: 'border-orange-500' },
            metric_inactivity: { icon: 'fas fa-history',        iconColor: 'text-yellow-800 dark:text-yellow-400', bgClass: 'bg-yellow-100 dark:bg-yellow-900/30', borderClass: 'border-yellow-700' }
        };
        return configs[type] || configs.workout_completed;
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

            // Set avatar: show profile picture or initials
            if (avatar) {
                if (profile.profilePicture) {
                    avatar.innerHTML = `<img src="${profile.profilePicture}" class="w-full h-full object-cover" alt="Profile">`;
                } else {
                    const initials = `${(profile.name || '')[0] || ''}${(profile.lastName || '')[0] || ''}`.toUpperCase() || '?';
                    avatar.textContent = initials;
                }
            }

            // Profile picture upload
            const changePhotoBtn = document.getElementById('change-photo-btn');
            const profilePicInput = document.getElementById('profile-pic-input');
            window._pendingProfilePicture = null;

            if (changePhotoBtn && profilePicInput) {
                changePhotoBtn.onclick = () => profilePicInput.click();

                profilePicInput.onchange = (e) => {
                    const file = e.target.files[0];
                    if (!file) return;

                    if (file.size > 1024 * 1024) {
                        alert('La imagen debe ser menor a 1MB.');
                        return;
                    }
                    if (!['image/jpeg', 'image/png', 'image/gif'].includes(file.type)) {
                        alert('Solo se permiten archivos JPG, PNG o GIF.');
                        return;
                    }

                    const reader = new FileReader();
                    reader.onload = (ev) => {
                        const base64 = ev.target.result;
                        if (avatar) {
                            avatar.innerHTML = `<img src="${base64}" class="w-full h-full object-cover" alt="Profile">`;
                        }
                        window._pendingProfilePicture = base64;
                    };
                    reader.readAsDataURL(file);
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
                        alert('El nombre es requerido.');
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

                            alert('Configuracion guardada exitosamente.');
                        } else {
                            const err = await saveRes.json();
                            alert(err.message || 'Error guardando configuracion');
                        }
                    } catch (e) {
                        console.error(e);
                        alert('Error de conexion');
                    }
                };
            }

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
            .autocomplete-list { position: absolute; top: 100%; left: 0; right: 0; background-color: #1f2937; border: 1px solid #374151; border-top: none; border-radius: 0 0 0.5rem 0.5rem; max-height: 200px; overflow-y: auto; z-index: 50; }
            .autocomplete-item { padding: 0.75rem 1rem; cursor: pointer; color: #f3f4f6; }
            .autocomplete-item:hover { background-color: #374151; }
            .autocomplete-item strong { color: #a78bfa; }
            
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
        const paddingClass = isCalendar ? 'p-0' : 'p-14'; 
        const titleClass = (isCalendar || !title) ? 'hidden' : 'text-4xl font-bold text-[#FFDB89] dark:text-[#FFDB89] mb-6 border-b border-[#FFDB89]/10 pb-3 flex-shrink-0';
        const bgClass = isCalendar
            ? 'bg-[#030303]/85 dark:bg-[#2C2C2E]/85 backdrop-blur-2xl border border-white/[0.06]'
            : 'bg-[#030303]/85 dark:bg-[#2C2C2E]/85 backdrop-blur-2xl border border-white/[0.06] rounded-2xl shadow-2xl';

        mainContentArea.innerHTML = `
        <div class="${paddingClass} ${bgClass} h-full flex flex-col relative overflow-hidden">
            <h1 class="${titleClass}">${title}</h1>
            <div class="flex-grow overflow-auto relative h-full">${contentHtml}</div>
        </div>`;
    };

    const updateDashboard = (welcomeTitle, userName) => {
        const trainerNameSpan = document.getElementById('trainer-name');
        if(trainerNameSpan) trainerNameSpan.textContent = userName;
        const sidebar = document.getElementById('sidebar');
        if(sidebar) sidebar.querySelectorAll('nav a').forEach(a => a.classList.add('nav-link-item'));
        setTimeout(updateThemeIcon, 100); 
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
            updateContent('Inicio', homeHtml);
            initClientHome();
            updateDashboard('Inicio', user.name);
        }
        setTimeout(updateThemeIcon, 100); 

        // FORCE PASSWORD CHANGE MODAL
        if (user.role === 'client' && user.isFirstLogin) {
            if (!document.getElementById('change-password-modal')) {
                document.body.insertAdjacentHTML('beforeend', `
                    <div id="change-password-modal" class="fixed inset-0 bg-black/90 z-[100] flex items-center justify-center p-4 backdrop-blur-sm">
                        <div class="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-full max-w-md p-8 border-2 border-red-500">
                            <div class="text-center mb-6">
                                <h2 class="text-2xl font-bold text-gray-900 dark:text-white">Acción Requerida</h2>
                                <p class="text-gray-500 dark:text-gray-400 mt-2">Por seguridad, debes cambiar tu contraseña temporal.</p>
                            </div>
                            <div class="space-y-4">
                                <input type="password" id="new-password-input" class="w-full p-4 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-xl dark:text-white focus:ring-2 focus:ring-red-500 outline-none transition" placeholder="Nueva Contraseña">
                                <button id="confirm-password-change-btn" class="w-full bg-red-600 hover:bg-red-700 text-white font-bold py-4 rounded-xl shadow-lg transition transform hover:scale-[1.02]">
                                    Guardar y Continuar
                                </button>
                            </div>
                        </div>
                    </div>
                `);
            }

            const confirmBtn = document.getElementById('confirm-password-change-btn');
            if (confirmBtn) {
                confirmBtn.onclick = async () => {
                    const newPw = document.getElementById('new-password-input').value;
                    if (newPw.length < 4) return alert("La contraseña debe tener al menos 4 caracteres.");
                    try {
                        const res = await apiFetch('/api/auth/update-password', {
                            method: 'POST',
                            body: JSON.stringify({ newPassword: newPw })
                        });
                        if (res.ok) {
                            user.isFirstLogin = false;
                            localStorage.setItem('auth_user', JSON.stringify(user)); 
                            document.getElementById('change-password-modal').remove();
                            alert("¡Contraseña actualizada! Bienvenido.");
                        } else {
                            alert("Error al actualizar contraseña.");
                        }
                    } catch (e) { console.error(e); alert("Error de conexión."); }
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
            'bg-blue-100 text-blue-700 border border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800'
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

                // NEW: Store JWT token for authenticated API requests
                localStorage.setItem('auth_token', data.token);
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

        if(newPassword.length < 6) {
            showMessage('reset-message', 'La contraseña debe tener al menos 6 caracteres', 'error');
            return;
        }

        if(newPassword !== confirmPassword) {
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
        const cards = ['login-card', 'forgot-password-card', 'reset-password-card'];
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
        
        if(resetToken) {
            showCard('reset-password-card');
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

        const supportLink = document.getElementById('contact-support-link');
        if(supportLink) {
            supportLink.addEventListener('click', () => {
                alert('Contacta a: soporte@fitbysuarez.com');
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
        mockGroupsDb.forEach(group => {
            const opt = document.createElement('option');
            opt.value = group;
            opt.textContent = group;
            opt.className = "bg-gray-900";
            select.appendChild(opt);
        });
    };

    // 1. OPEN CLIENT PROFILE (Updated with Modals)
    window.openClientProfile = (clientId) => {
        console.log("CLICKED ID:", clientId);
        // LOOSE MATCHING (==)
        const client = mockClientsDb.find(c => (c._id == clientId) || (c.id == clientId));
        
        if (!client) { 
            console.error("Client NOT found in local DB. Available:", mockClientsDb); 
            return; 
        }
        
        console.log("Client Found:", client.name);
        currentClientViewId = clientId;
        console.log("currentClientViewId SET TO:", currentClientViewId);

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

                <!-- Modals (shared) -->
                <div id="history-modal" class="hidden fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
                    <div class="bg-white dark:bg-gray-800 w-full max-w-lg rounded-xl shadow-2xl overflow-hidden border border-gray-200 dark:border-gray-700">
                        <div class="bg-gray-100 dark:bg-gray-700 p-4 border-b border-gray-200 dark:border-gray-600 flex justify-between items-center">
                            <h3 class="font-bold text-lg dark:text-white">Historial de Ejercicio</h3>
                            <button onclick="document.getElementById('history-modal').classList.add('hidden')" class="text-gray-500 hover:text-red-500 transition"><i class="fas fa-times text-xl"></i></button>
                        </div>
                        <div class="p-6">
                            <div class="overflow-x-auto">
                                <table class="w-full text-sm text-left text-gray-500 dark:text-gray-400">
                                    <thead class="text-xs text-gray-700 uppercase bg-gray-50 dark:bg-gray-700 dark:text-gray-400">
                                        <tr>
                                            <th class="px-3 py-2">Fecha</th>
                                            <th class="px-3 py-2">Peso</th>
                                            <th class="px-3 py-2">Reps</th>
                                            <th class="px-3 py-2">Sets</th>
                                            <th class="px-3 py-2">Notas</th>
                                        </tr>
                                    </thead>
                                    <tbody id="history-table-body">
                                        <tr class="bg-white dark:bg-gray-800 border-b dark:border-gray-700">
                                            <td class="px-3 py-2">01/02/2026</td>
                                            <td class="px-3 py-2">135 lbs</td>
                                            <td class="px-3 py-2">10</td>
                                            <td class="px-3 py-2">3</td>
                                            <td class="px-3 py-2 italic">Easy</td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>

                <div id="video-upload-modal" class="hidden fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
                     <div class="bg-[#030303]/95 backdrop-blur-2xl p-6 rounded-2xl shadow-2xl w-96 border border-[#FFDB89]/20">
                        <h3 id="video-modal-title" class="text-lg font-bold mb-1 text-[#FFDB89]">Añadir Video URL</h3>
                        <p class="text-xs text-[#FFDB89]/40 mb-4">Enlace de YouTube o Vimeo</p>
                        <input type="text" id="video-url-input" class="w-full p-2.5 bg-white/10 border border-[#FFDB89]/30 rounded-lg text-[#FFDB89] text-sm outline-none focus:ring-2 focus:ring-[#FFDB89] placeholder-[#FFDB89]/30 mb-4" placeholder="https://youtube.com/...">
                        <div class="flex justify-end gap-2">
                            <button onclick="document.getElementById('video-upload-modal').classList.add('hidden')" class="px-4 py-2 text-[#FFDB89]/60 hover:text-[#FFDB89] font-medium transition">Cancelar</button>
                            <button onclick="window.saveEditorVideo()" class="px-4 py-2 bg-[#3a3a3c] hover:bg-[#3a3a3c]/80 text-[#FFDB89] rounded-lg font-bold transition">Guardar</button>
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
            };
        });

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
                            area.innerHTML = `
                                <div class="workout-card-wrapper">
                                    <div class="workout-card-header flex items-center gap-3 cursor-pointer py-0.5 group/wk" onclick="window.toggleWorkoutExpand(this)">
                                        <div class="w-1 h-8 bg-[#FFDB89] rounded-full shrink-0"></div>
                                        <div class="min-w-0 flex-1">
                                            <div class="text-sm font-bold text-[#FFDB89] truncate">${workout.title}</div>
                                            <div class="text-xs text-[#FFDB89]/50">${workout.exercises.length} ejercicios</div>
                                        </div>
                                        <i class="fas fa-chevron-right text-[#FFDB89]/40 text-xs shrink-0 workout-chevron transition-transform duration-200"></i>
                                    </div>
                                    <div class="workout-expand-content hidden mt-1 border-t border-[#FFDB89]/10"></div>
                                </div>
                            `;
                            // Show copy checkbox on hover for days with workouts
                            const cb = cell.querySelector('.copy-day-checkbox');
                            if(cb) cb.classList.remove('hidden');
                        }
                    });
                }
            } catch(e) {
                console.error('Error loading workouts:', e);
            }
        };

        // Load saved workouts onto the calendar
        loadClientWorkoutsToCalendar(clientId);

        // Scroll to Today automatically
        setTimeout(() => {
            const todayCell = document.querySelector('.is-today');
            if(todayCell) todayCell.scrollIntoView({ block: "center", behavior: "auto" });
        }, 100);
    };

    // --- Client Detail Tab Data Loaders ---

    const loadClientMetrics = async (clientId) => {
        const container = document.getElementById('tab-metrics');
        if (!container) return;
        try {
            const res = await apiFetch(`/api/body-measurements/${clientId}`);
            const measurements = res.ok ? await res.json() : [];
            const client = mockClientsDb.find(c => c._id == clientId);

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
                    <div class="flex flex-wrap justify-between items-center gap-3">
                        <div>
                            <h3 class="text-xl font-bold text-[#FFDB89]">Medidas Corporales</h3>
                            ${client ? `<p class="text-sm text-[#FFDB89]/60 mt-0.5">
                                ${client.height ? `Estatura: ${hFt}'${hIn}"` : ''}
                                ${client.thr ? ` · THR: ${client.thr} bpm` : ''}
                                ${client.mahr ? ` · MaxHR: ${client.mahr} bpm` : ''}
                            </p>` : ''}
                        </div>
                        <button onclick="window.showAddMeasurementModal('${clientId}', ${totalInches})"
                            class="px-4 py-2 bg-[#3a3a3c] hover:bg-[#3a3a3c]/80 text-[#FFDB89] rounded-lg text-sm font-bold transition flex items-center gap-2">
                            <i class="fas fa-plus"></i> Agregar medición
                        </button>
                    </div>

                    <div class="overflow-x-auto">
                        <table class="w-full text-sm border-collapse">
                            <thead>
                                <tr class="border-b border-[#FFDB89]/20">
                                    <th class="px-3 py-3 text-left text-xs font-bold text-[#FFDB89] uppercase whitespace-nowrap">Fecha</th>
                                    <th class="px-3 py-3 text-center text-xs font-bold text-[#FFDB89] uppercase whitespace-nowrap">BMI</th>
                                    <th class="px-3 py-3 text-center text-xs font-bold text-[#FFDB89] uppercase whitespace-nowrap">%G</th>
                                    <th class="px-3 py-3 text-center text-xs font-bold text-[#FFDB89] uppercase whitespace-nowrap">Peso</th>
                                    <th class="px-3 py-3 text-center text-xs font-bold text-[#FFDB89] uppercase whitespace-nowrap">Pecho</th>
                                    <th class="px-3 py-3 text-center text-xs font-bold text-[#FFDB89] uppercase whitespace-nowrap">Bíceps</th>
                                    <th class="px-3 py-3 text-center text-xs font-bold text-[#FFDB89] uppercase whitespace-nowrap">Cintura</th>
                                    <th class="px-3 py-3 text-center text-xs font-bold text-[#FFDB89] uppercase whitespace-nowrap">Cadera</th>
                                    <th class="px-3 py-3 text-center text-xs font-bold text-[#FFDB89] uppercase whitespace-nowrap">Quads</th>
                                    <th class="px-3 py-3 text-center text-xs font-bold text-[#FFDB89] uppercase whitespace-nowrap">Calves</th>
                                    <th class="px-3 py-3 text-center text-xs font-bold text-[#FFDB89] uppercase"></th>
                                </tr>
                            </thead>
                            <tbody class="divide-y divide-[#FFDB89]/10">${tableRows}</tbody>
                        </table>
                    </div>
                </div>
            `;
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
                            <label class="${labelCls}">Calves</label>
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
        if (!date) { alert('La fecha es requerida.'); return; }
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
                alert(err.message || 'Error guardando medición.');
            }
        } catch (e) { alert('Error de conexión.'); }
    };

    window.deleteMeasurement = async (clientId, measurementId) => {
        if (!confirm('¿Eliminar este registro?')) return;
        try {
            await apiFetch(`/api/body-measurements/${measurementId}`, { method: 'DELETE' });
            loadClientMetrics(clientId);
        } catch (e) { alert('Error eliminando registro.'); }
    };

    const loadClientNutrition = async (clientId) => {
        const container = document.getElementById('tab-nutrition');
        if (!container) return;
        try {
            const res = await apiFetch(`/api/nutrition-logs/${clientId}`);
            const logs = res.ok ? await res.json() : [];
            container.innerHTML = `
                <div class="space-y-6 max-w-4xl mx-auto">
                    <div class="flex justify-between items-center">
                        <h3 class="text-xl font-bold text-[#FFDB89]">Nutrición</h3>
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
                                </tr>
                            </thead>
                            <tbody class="divide-y divide-[#FFDB89]/10">
                                ${logs.length === 0 ? '<tr><td colspan="7" class="p-6 text-center text-[#FFDB89]/40">Sin registros de nutrición. Haz clic en "Registrar nutrición" para comenzar.</td></tr>' :
                                logs.map(l => `<tr class="hover:bg-[#FFDB89]/5 transition">
                                    <td class="px-4 py-3 text-[#FFDB89]">${l.date}</td>
                                    <td class="px-4 py-3 font-bold text-[#FFDB89]">${l.calories}</td>
                                    <td class="px-4 py-3 text-[#FFDB89]/70">${l.protein}g</td>
                                    <td class="px-4 py-3 text-[#FFDB89]/70">${l.carbs}g</td>
                                    <td class="px-4 py-3 text-[#FFDB89]/70">${l.fat}g</td>
                                    <td class="px-4 py-3 text-[#FFDB89]/70">${l.water || '--'}</td>
                                    <td class="px-4 py-3 text-[#FFDB89]/50">${l.notes || '--'}</td>
                                </tr>`).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            `;
        } catch (e) { container.innerHTML = '<p class="text-red-500">Error cargando nutricion.</p>'; }
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
        if (!date) { alert('Fecha es requerida.'); return; }
        try {
            const res = await apiFetch('/api/nutrition-logs', {
                method: 'POST',
                body: JSON.stringify({ clientId, date, calories, protein, carbs, fat, water, notes })
            });
            if (res.ok) {
                document.getElementById('add-nutrition-modal')?.remove();
                loadClientNutrition(clientId);
            } else { alert('Error guardando registro.'); }
        } catch (e) { alert('Error de conexion.'); }
    };

    const loadClientPhotos = async (clientId) => {
        const container = document.getElementById('tab-photos');
        if (!container) return;
        try {
            const res = await apiFetch(`/api/progress-photos/${clientId}`);
            const photos = res.ok ? await res.json() : [];
            container.innerHTML = `
                <div class="space-y-6 max-w-4xl mx-auto">
                    <div class="flex justify-between items-center">
                        <h3 class="text-xl font-bold text-[#FFDB89]">Fotos de Progreso</h3>
                        <button onclick="window.showAddPhotoModal('${clientId}')" class="px-4 py-2 bg-[#3a3a3c] hover:bg-[#3a3a3c]/80 text-[#FFDB89] rounded-lg text-sm font-bold transition">
                            <i class="fas fa-camera mr-1"></i> Subir foto
                        </button>
                    </div>
                    <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                        ${photos.length === 0 ? '<div class="col-span-full text-center py-12 text-[#FFDB89]/40"><i class="fas fa-camera text-5xl mb-3 block"></i><p>Sin fotos de progreso. Haz clic en "Subir foto" para comenzar.</p></div>' :
                        photos.map(p => `
                            <div class="relative group bg-[#2C2C2E] rounded-xl overflow-hidden border border-[#FFDB89]/20 shadow-sm">
                                <img src="${p.imageData}" alt="Progress" class="w-full aspect-[3/4] object-cover">
                                <div class="p-2">
                                    <p class="text-xs font-bold text-[#FFDB89]/70">${p.date}</p>
                                    ${p.notes ? `<p class="text-xs text-[#FFDB89]/50 truncate">${p.notes}</p>` : ''}
                                </div>
                                <button onclick="window.deleteProgressPhoto('${p._id}', '${clientId}')" class="absolute top-2 right-2 w-7 h-7 bg-red-600 text-white rounded-full text-xs opacity-0 group-hover:opacity-100 transition flex items-center justify-center">
                                    <i class="fas fa-trash text-[10px]"></i>
                                </button>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
        } catch (e) { container.innerHTML = '<p class="text-red-500">Error cargando fotos.</p>'; }
    };

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
                            <input type="file" id="photo-file" accept="image/jpeg,image/png,image/gif" class="w-full p-2.5 bg-white/10 border border-[#FFDB89]/30 rounded-lg text-[#FFDB89] text-sm outline-none">
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
                    if (file.size > 2 * 1024 * 1024) { alert('La imagen debe ser menor a 2MB.'); return; }
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
        if (!date || !fileInput?.files[0]) { alert('Fecha y foto son requeridas.'); return; }
        const file = fileInput.files[0];
        if (file.size > 2 * 1024 * 1024) { alert('La imagen debe ser menor a 2MB.'); return; }
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
                } else { alert('Error subiendo foto.'); }
            } catch (e) { alert('Error de conexion.'); }
        };
        reader.readAsDataURL(file);
    };

    window.deleteProgressPhoto = async (photoId, clientId) => {
        if (!confirm('Eliminar esta foto?')) return;
        try {
            const res = await apiFetch(`/api/progress-photos/${photoId}`, { method: 'DELETE' });
            if (res.ok) loadClientPhotos(clientId);
        } catch (e) { alert('Error eliminando foto.'); }
    };

    window.openEditClientModal = (clientId) => {
        const client = mockClientsDb.find(c => c._id === clientId);
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

        document.getElementById('new-client-name').value = client.name || "";
        document.getElementById('new-client-lastname').value = client.lastName || "";
        document.getElementById('new-client-email').value = client.email || "";
        document.getElementById('new-client-program').value = client.program || "Sin Asignar";
        setTimeout(() => document.getElementById('new-client-group').value = client.group || "General", 100);
        
        document.querySelectorAll('.client-type-btn').forEach(b => {
            b.classList.remove('ring-2', 'ring-brand-purple');
            if(b.dataset.type === client.type) b.classList.add('ring-2', 'ring-brand-purple');
        });

        document.getElementById('opt-location').value = client.location || "";
        document.getElementById('opt-timezone').value = client.timezone || "";
        document.getElementById('opt-birthday').value = client.birthday || "";
        document.getElementById('opt-phone').value = client.phone || "";
        if (document.getElementById('opt-due-date')) document.getElementById('opt-due-date').value = client.dueDate || "";
        if (document.getElementById('opt-thr'))  document.getElementById('opt-thr').value  = client.thr  || "";
        if (document.getElementById('opt-mahr')) document.getElementById('opt-mahr').value = client.mahr || "";

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
    };

    window.deleteClient = async (id) => {
        if(!confirm("¿Estás seguro de que deseas eliminar este cliente? Se moverá a la papelera.")) return;
        try {
            const res = await apiFetch(`/api/clients/${id}`, { method: 'DELETE' });
            if (res.ok) {
                mockClientsDb = mockClientsDb.filter(c => c._id !== id);
                renderClientsTable();
            } else {
                const contentType = res.headers.get("content-type");
                if (contentType && contentType.indexOf("application/json") !== -1) {
                    const err = await res.json();
                    alert("Error: " + err.message);
                } else { alert("Error de servidor."); }
            }
        } catch (e) { console.error(e); alert("Error de conexión."); }
    };

    window.handleSaveClient = async () => {
        const firstName = document.getElementById('new-client-name')?.value;
        const lastName = document.getElementById('new-client-lastname')?.value;
        const email = document.getElementById('new-client-email')?.value;
        const typeBtn = document.querySelector('.client-type-btn.ring-2');
        const type = typeBtn ? typeBtn.dataset.type : "Remoto";
        const program = document.getElementById('new-client-program')?.value || "Sin Asignar";
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

        if(!firstName || !email) { alert("Nombre y Email son requeridos"); return; }

        const thr  = parseFloat(document.getElementById('opt-thr')?.value) || null;
        const mahr = parseFloat(document.getElementById('opt-mahr')?.value) || null;

        const payload = {
            name: firstName, lastName: lastName || "", email: email, type: type, program: program, group: group,
            location, timezone, unitSystem,
            height: { feet: heightFt, inches: heightIn },
            weight: weight,
            birthday, gender, phone,
            thr, mahr,
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
                res = await apiFetch('/api/clients', { method: 'POST', body: JSON.stringify(payload) });
            }

            if (res.ok) {
                const savedClient = await res.json();
                if (currentClientViewId) {
                    const idx = mockClientsDb.findIndex(c => c._id === currentClientViewId);
                    if (idx > -1) mockClientsDb[idx] = savedClient;
                    alert("Cliente actualizado exitosamente.");
                } else {
                    mockClientsDb.unshift(savedClient);
                    const sendInvite = document.getElementById('send-invite-toggle')?.dataset.on === 'true';
                    if (sendInvite) {
                        try {
                            await apiFetch('/api/send-welcome', { method: 'POST', body: JSON.stringify({ email: email, name: firstName, password: savedClient._tempPassword || "temp123" }) });
                            alert(`Cliente creado y correo enviado a ${email}.`);
                        } catch (err) { alert("Cliente creado, error enviando correo."); }
                    } else {
                        alert(`Cliente creado. Invitación no enviada.`);
                    }
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
            } else {
                const err = await res.json();
                alert(err.message || "Error al guardar");
            }
        } catch (error) { console.error(error); alert("Error de conexión con el servidor"); }
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
        let filtered = mockClientsDb;
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
                if(!e.target.closest('button')) {
                    window.openClientProfile(client._id);
                }
            };
            const initials = (client.name.charAt(0) + (client.lastName ? client.lastName.charAt(0) : '')).toUpperCase();
            tr.innerHTML = `
                <td class="px-6 py-4 whitespace-nowrap"><div class="flex items-center"><div class="h-10 w-10 rounded-full bg-[#FFDB89]/30 text-[#FFDB89] flex items-center justify-center font-bold mr-3">${initials}</div><div class="text-sm font-medium text-[#FFDB89]">${client.name} ${client.lastName || ''}</div></div></td>
                <td class="px-6 py-4 whitespace-nowrap"><span class="bg-[#FFDB89]/10 text-[#FFDB89] px-2 py-1 rounded text-xs font-bold">${client.group || 'General'}</span></td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-[#FFDB89]/80">${client.program}</td>
                <td class="px-6 py-4 whitespace-nowrap">
                    <button onclick="event.stopPropagation(); window.toggleClientStatus('${client._id}', ${client.isActive})" class="px-2 inline-flex text-xs leading-5 font-semibold rounded-full cursor-pointer transition ${client.isActive ? 'bg-green-900/40 text-green-300 hover:bg-green-900/60' : 'bg-red-900/40 text-red-300 hover:bg-red-900/60'}">
                        ${client.isActive ? 'Activo' : 'Inactivo'}
                    </button>
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
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
                const idx = mockClientsDb.findIndex(c => c._id === clientId);
                if (idx > -1) mockClientsDb[idx] = updated;
                renderClientsTable();
            }
        } catch (e) { console.error('Error toggling status:', e); }
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
                btn.className = "category-pill px-3 py-1 bg-gray-800 rounded-full text-xs text-gray-300 border border-gray-600 m-1";
                btn.textContent = muscle;
                btn.onclick = () => btn.classList.toggle('selected');
                catContainer.appendChild(btn);
            });
        }

        const renderList = (filterText = '') => {
            listContainer.innerHTML = '';
            const filtered = globalExerciseLibrary.filter(ex => ex.name.toLowerCase().includes(filterText.toLowerCase()));
            if(filtered.length === 0) { listContainer.innerHTML = `<div class="p-8 text-center text-gray-500 dark:text-gray-400">No hay ejercicios. ¡Añade uno!</div>`; return; }

            filtered.forEach(ex => {
                const catDisplay = Array.isArray(ex.category) ? ex.category.join(", ") : ex.category;
                const item = document.createElement('div');
                item.className = "p-4 hover:bg-gray-50 dark:hover:bg-gray-750 flex justify-between items-center transition group border-b border-gray-100 dark:border-gray-700 last:border-none";
                item.innerHTML = `
                    <div class="flex items-center gap-4">
                        <div class="w-10 h-10 rounded-full bg-gray-100 dark:bg-gray-700 flex items-center justify-center text-brand-purple font-bold">${ex.name.charAt(0).toUpperCase()}</div>
                        <div>
                            <h4 class="font-bold text-gray-900 dark:text-white">${ex.name}</h4>
                            <div class="flex gap-2 text-xs text-gray-500 dark:text-gray-400">
                                <span class="px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-700">${catDisplay}</span>
                                ${ex.videoUrl ? `<span class="text-[#FFDB89]/70 flex items-center gap-1"><i class="fas fa-video"></i> Video</span>` : ''}
                            </div>
                        </div>
                    </div>
                    <div class="flex gap-2 opacity-0 group-hover:opacity-100 transition"><button class="p-2 text-gray-400 hover:text-white" title="Edit"><i class="fas fa-edit"></i></button></div>`;
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

        if(!name) return alert("Nombre requerido");

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
                alert("Ejercicio guardado!");
            } else { alert("Error guardando ejercicio"); }
        } catch(e) { console.error(e); }
    };

    window.copyWorkout = async (dateStr, clientId) => {
        try {
            const response = await apiFetch(`/api/client-workouts/${clientId}/${dateStr}`);
            if(response.ok) {
                copiedWorkoutData = await response.json();
                copiedMultiDayData = null; // Clear multi-day when single copy is used
                alert('Workout copiado! Usa el boton "Pegar" en cualquier otro dia.');
            } else {
                alert('No hay workout en este dia para copiar.');
            }
        } catch(e) {
            console.error(e);
            alert('Error al copiar workout');
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
            alert('No se encontraron workouts para copiar.');
            return;
        }

        copiedMultiDayData = workoutsWithOffsets;
        copiedWorkoutData = null; // Clear single-day copy
        window.clearCopySelection();
        alert(`${workoutsWithOffsets.length} dia${workoutsWithOffsets.length > 1 ? 's' : ''} copiado${workoutsWithOffsets.length > 1 ? 's' : ''}! Usa el boton "Pegar" en el dia donde quieres que inicie.`);
    };

    window.clearCopySelection = () => {
        selectedCopyDays.clear();
        document.querySelectorAll('.copy-day-checkbox').forEach(cb => cb.checked = false);
        window.updateCopyBar();
    };

    // =============================================================================
    // 7. PROGRAMS, CALENDAR & BUILDER (MODIFIED SECTION)
    // =============================================================================

    const handleCreateProgram = async () => {
        const name = document.getElementById('program-name-input').value.trim();
        if(!name) { alert("Nombre requerido"); return; }
        
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
                mockProgramsDb.push(newProg);
                document.getElementById('create-program-modal').classList.add('hidden');
                document.getElementById('program-name-input').value = '';
                renderProgramsList();
                openProgramBuilder(newProg._id); // Use MongoDB _id
                alert("Programa creado!");
            } else {
                alert("Error creando programa");
            }
        } catch(e) {
            console.error(e);
            alert("Error de conexión");
        }
    };

    const renderProgramsList = () => { /* ... (Existing Logic) ... */
        const container = document.getElementById('programs-list-container');
        if (!container) return;
        container.innerHTML = '';
        mockProgramsDb.forEach(prog => {
            const card = document.createElement('div');
            card.className = "program-card bg-white dark:bg-gray-800 p-5 rounded-xl shadow-lg hover:shadow-xl transition duration-300 border-t-4 border-blue-500 cursor-pointer relative group";
            card.dataset.id = prog._id || prog.id;
            card.innerHTML = `
                <div class="pointer-events-none">
                    <h3 class="font-bold text-lg text-gray-800 dark:text-white">${prog.name}</h3>
                    <span class="text-xs px-2 py-1 bg-gray-100 text-gray-800 rounded-full dark:bg-gray-700 dark:text-gray-300">${prog.tags || 'General'}</span>
                </div>
                <div class="mt-4 text-xs text-gray-500 dark:text-gray-400 pointer-events-none"><span>${prog.weeks.length} Semanas</span> | <span>${prog.clientCount} Clientes</span></div>`;
            container.appendChild(card);
        });
    };

    const renderProgramBuilder = (prog) => {
        document.getElementById('builder-program-name').textContent = prog.name;
        document.getElementById('calendar-container').innerHTML = '';
        currentWeekCount = 0;
        if (prog.weeks && prog.weeks.length > 0) {
            prog.weeks.forEach(week => addWeekToCalendar(week));
        } else {
            addWeekToCalendar();
        }
    };

    const openProgramBuilder = (id) => {
        const prog = mockProgramsDb.find(p => (p.id == id) || (p._id == id));
        if (!prog) return;
        currentProgramId = id;
        document.getElementById('programs-main-view').classList.add('hidden');
        document.getElementById('program-builder-view').classList.remove('hidden');
        renderProgramBuilder(prog);
    };

    const addWeekToCalendar = (weekData = null) => {
        currentWeekCount++;
        const weekDiv = document.createElement('div');
        weekDiv.className = "week-block mb-8";
        const days = weekData?.days || {};
        const getDayData = (i) => days[String(i + 1)] || days[i + 1] || null;
        weekDiv.innerHTML = `<h4 class="text-xl font-bold text-gray-700 dark:text-gray-300 mb-4 px-2">Semana ${currentWeekCount}</h4><div class="grid grid-cols-1 md:grid-cols-7 gap-4">${Array.from({length: 7}, (_, i) => renderDayCell(i + 1, getDayData(i))).join('')}</div>`;
        document.getElementById('calendar-container').appendChild(weekDiv);
    };

    // Original Render Day Cell (For Program Builder)
    const renderDayCell = (dayNum, existingDay = null) => {
        let bodyContent;
        if (existingDay?.isRest) {
            bodyContent = `<div class="text-center text-green-500"><i class="fas fa-bed text-2xl"></i><div class="text-xs font-bold mt-1">Descanso</div></div>`;
        } else if (existingDay?.exercises?.length > 0) {
            const preview = existingDay.exercises.slice(0, 3).map(ex => `<div class="truncate text-[10px] text-gray-600 dark:text-gray-300">• ${ex.name}</div>`).join('');
            const more = existingDay.exercises.length > 3 ? `<div class="text-[10px] text-gray-400">+${existingDay.exercises.length - 3} más</div>` : '';
            bodyContent = `<div class="text-left w-full">${preview}${more}</div>`;
        } else {
            bodyContent = `<div class="text-center text-gray-300 dark:text-gray-600"><i class="fas fa-plus text-2xl"></i></div>`;
        }
        const nameLabel = existingDay?.name ? `<div class="text-[10px] text-gray-500 truncate">${existingDay.name}</div>` : '';
        return `<div class="relative bg-white dark:bg-gray-800 h-40 rounded-xl shadow border border-gray-100 dark:border-gray-700 group overflow-hidden hover:shadow-lg transition">
            <div class="p-3 h-full flex flex-col justify-between"><div><span class="text-xs font-bold text-gray-400">Día ${dayNum}</span>${nameLabel}</div>${bodyContent}<div></div></div>
            <div class="absolute inset-0 bg-white/95 dark:bg-gray-800/95 backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity flex flex-col cursor-pointer z-10">
                <div class="flex-1 flex border-b border-gray-200 dark:border-gray-600">
                    <div class="action-add flex-1 flex flex-col items-center justify-center hover:bg-[#FFDB89]/10 text-[#FFDB89] transition border-r border-[#FFDB89]/20" data-day="${dayNum}"><i class="fas fa-dumbbell"></i><span class="text-[10px] font-bold">Añadir</span></div>
                    <div class="action-rest flex-1 flex flex-col items-center justify-center hover:bg-green-50 dark:hover:bg-gray-700 text-green-600 transition"><i class="fas fa-bed"></i><span class="text-[10px] font-bold">Descanso</span></div>
                </div>
                <div class="flex-1 flex">
                    <div class="action-nutri flex-1 flex flex-col items-center justify-center hover:bg-orange-50 dark:hover:bg-gray-700 text-orange-500 border-r border-gray-200 dark:border-gray-600"><i class="fas fa-apple-alt"></i><span class="text-[10px] font-bold">Nutrición</span></div>
                    <div class="action-paste flex-1 flex flex-col items-center justify-center hover:bg-purple-50 dark:hover:bg-gray-700 text-purple-600 transition"><i class="fas fa-paste"></i><span class="text-[10px] font-bold">Pegar</span></div>
                </div>
            </div>
        </div>`;
    };

    const openExerciseBuilder = (dayNum) => {
        document.getElementById('edit-routine-modal').classList.remove('hidden');
        document.getElementById('exercise-list').innerHTML = '';
        exerciseCount = 0;
        const prog = currentProgramId ? mockProgramsDb.find(p => (p.id == currentProgramId) || (p._id == currentProgramId)) : null;
        const existingDay = prog?.weeks?.[currentEditingWeekIndex]?.days?.[String(dayNum)];
        if (existingDay) {
            document.getElementById('routine-name-input').value = existingDay.name || `Entrenamiento Día ${dayNum}`;
            if (existingDay.exercises?.length > 0) {
                existingDay.exercises.forEach(ex => addExerciseToBuilder(ex));
            } else {
                addExerciseToBuilder();
            }
        } else {
            document.getElementById('routine-name-input').value = `Entrenamiento Día ${dayNum}`;
            addExerciseToBuilder();
        }
    };

    const addExerciseToBuilder = (data = null) => {
        const list = document.getElementById('exercise-list');
        const label = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[exerciseCount++ % 26];
        const item = document.createElement('div');
        item.className = "exercise-item bg-white dark:bg-gray-700 p-4 rounded-xl border border-gray-200 dark:border-gray-600 group relative shadow-sm";
        item.innerHTML = `
            <div class="absolute -left-12 top-0 h-full w-10 flex flex-col justify-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <button class="w-8 h-8 rounded-full bg-gray-100 dark:bg-gray-600 text-gray-500 dark:text-gray-300 hover:text-blue-500 shadow flex items-center justify-center"><i class="fas fa-arrows-alt"></i></button>
                <button class="w-8 h-8 rounded-full bg-gray-100 dark:bg-gray-600 text-gray-500 dark:text-gray-300 hover:text-red-500 shadow flex items-center justify-center" onclick="this.closest('.exercise-item').remove()"><i class="fas fa-trash"></i></button>
            </div>
            <div class="flex gap-4">
                <div class="pt-2"><span class="text-2xl font-bold text-gray-300 dark:text-gray-500 exercise-label">${label})</span></div>
                <div class="flex-grow space-y-3">
                    <div class="flex gap-2 relative">
                        <input type="text" class="exercise-name-input w-full p-3 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg dark:text-white font-semibold focus:ring-2 focus:ring-blue-500 outline-none" placeholder="Nombre" value="${data ? data.name : ''}" autocomplete="off">
                        <div class="autocomplete-list hidden"></div> 
                        <button class="p-3 bg-gray-100 dark:bg-gray-800 text-gray-400 hover:text-blue-500 rounded-lg border border-gray-200 dark:border-gray-600 transition open-video-modal"><i class="fas fa-video"></i></button>
                    </div>
                    <textarea class="exercise-stats-input w-full p-3 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg dark:text-white text-sm resize-none focus:border-blue-500 outline-none" rows="3" placeholder="Sets...">${data ? data.stats : ''}</textarea>
                </div>
            </div>`;
        list.appendChild(item);

        const input = item.querySelector('.exercise-name-input');
        const suggestionsBox = item.querySelector('.autocomplete-list');
        const videoBtn = item.querySelector('.open-video-modal');

        input.addEventListener('input', (e) => {
            const val = e.target.value.trim();
            suggestionsBox.innerHTML = '';
            suggestionsBox.classList.add('hidden');
            if (!val) return;
            const matches = globalExerciseLibrary.filter(ex => ex.name.toLowerCase().startsWith(val.toLowerCase()));
            if (matches.length > 0) {
                suggestionsBox.classList.remove('hidden');
                matches.forEach(match => {
                    const div = document.createElement('div');
                    div.className = "autocomplete-item text-gray-800 dark:text-gray-200";
                    div.innerHTML = `<strong>${match.name.substr(0, val.length)}</strong>${match.name.substr(val.length)}`;
                    div.addEventListener('click', () => {
                        input.value = match.name;
                        suggestionsBox.classList.add('hidden');
                        if(match.videoUrl) {
                            videoBtn.dataset.video = match.videoUrl;
                            videoBtn.querySelector('i').classList.remove('text-gray-400');
                            videoBtn.querySelector('i').classList.add('text-[#FFDB89]');
                        }
                    });
                    suggestionsBox.appendChild(div);
                });
            }
        });
        document.addEventListener('click', (e) => { if (!item.contains(e.target)) suggestionsBox.classList.add('hidden'); });
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
            const prog = mockProgramsDb.find(p => (p.id == currentProgramId) || (p._id == currentProgramId));
            if(prog) {
                if (!prog.weeks[currentEditingWeekIndex]) {
                    prog.weeks[currentEditingWeekIndex] = { weekNumber: currentEditingWeekIndex + 1, days: {} };
                }
                if (!prog.weeks[currentEditingWeekIndex].days) {
                    prog.weeks[currentEditingWeekIndex].days = {};
                }

                const dayData = {
                    name: name,
                    exercises: exercises,
                    isRest: false
                };

                prog.weeks[currentEditingWeekIndex].days[currentEditingDay] = dayData;

                // SAVE TO DATABASE
                try {
                    const res = await apiFetch(`/api/programs/${prog._id || prog.id}`, {
                        method: 'PUT',
                        body: JSON.stringify(prog)
                    });

                    if(res.ok) {
                        console.log("Program routine saved to database");
                    } else {
                        console.error("Error saving program routine");
                    }
                } catch(e) {
                    console.error("Database save error:", e);
                }
            }
        }

        document.getElementById('edit-routine-modal').classList.add('hidden');
        if(currentClientViewId) openClientProfile(currentClientViewId);
        // Re-render program builder if we're in program view
        if(currentProgramId && document.getElementById('program-builder-view') && !document.getElementById('program-builder-view').classList.contains('hidden')) {
            const prog = mockProgramsDb.find(p => (p.id == currentProgramId) || (p._id == currentProgramId));
            if(prog) renderProgramBuilder(prog);
        }
    };

    const renderPaymentsView = () => {
        const tbody = document.getElementById('payments-table-body');
        if (!tbody) return;

        // --- Get filter values ---
        const searchVal = (document.getElementById('pagos-search')?.value || '').toLowerCase();
        const statusFilter = document.getElementById('pagos-status-filter')?.value || 'all';

        // --- Determine payment status for each client ---
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const clientsWithStatus = mockClientsDb.map(client => {
            const due = client.dueDate ? new Date(client.dueDate + 'T00:00:00') : null;
            let paymentStatus = 'paid'; // default
            if (!client.isActive) {
                paymentStatus = 'unpaid';
            } else if (due && due < today) {
                paymentStatus = 'overdue';
            }
            return { ...client, _paymentStatus: paymentStatus };
        });

        // --- Apply filters ---
        let filtered = clientsWithStatus;
        if (searchVal) {
            filtered = filtered.filter(c =>
                `${c.name} ${c.lastName || ''}`.toLowerCase().includes(searchVal)
            );
        }
        if (statusFilter !== 'all') {
            filtered = filtered.filter(c => c._paymentStatus === statusFilter);
        }

        // --- Update stat cards (always use full list, not filtered) ---
        const totalPaid = clientsWithStatus.filter(c => c._paymentStatus === 'paid').length;
        const totalUnpaid = clientsWithStatus.filter(c => c._paymentStatus === 'unpaid').length;
        const totalOverdue = clientsWithStatus.filter(c => c._paymentStatus === 'overdue').length;
        const countPaidEl = document.getElementById('count-paid');
        const countUnpaidEl = document.getElementById('count-unpaid');
        const countOverdueEl = document.getElementById('count-overdue');
        if (countPaidEl) countPaidEl.textContent = totalPaid;
        if (countUnpaidEl) countUnpaidEl.textContent = totalUnpaid;
        if (countOverdueEl) countOverdueEl.textContent = totalOverdue;

        // --- Render table ---
        tbody.innerHTML = '';
        if (filtered.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" class="p-8 text-center text-gray-400 dark:text-gray-500">No se encontraron clientes.</td></tr>`;
            return;
        }

        filtered.forEach(client => {
            const tr = document.createElement('tr');
            tr.className = "hover:bg-[#FFDB89]/20 transition";

            // Status badge
            let statusBadge;
            if (client._paymentStatus === 'paid') {
                statusBadge = `<span class="px-3 py-1 inline-flex items-center text-xs font-semibold rounded-full bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"><i class="fas fa-check mr-2"></i> Al dia</span>`;
            } else if (client._paymentStatus === 'overdue') {
                statusBadge = `<span class="px-3 py-1 inline-flex items-center text-xs font-semibold rounded-full bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200"><i class="fas fa-clock mr-2"></i> Vencido</span>`;
            } else {
                statusBadge = `<span class="px-3 py-1 inline-flex items-center text-xs font-semibold rounded-full bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"><i class="fas fa-exclamation-triangle mr-2"></i> Pendiente</span>`;
            }

            // WhatsApp link
            const waLink = `https://wa.me/?text=${encodeURIComponent(`Hola ${client.name}, este es un recordatorio de tu pago para FitBySuarez. Tu fecha de vencimiento es ${client.dueDate || 'pendiente'}. Gracias!`)}`;

            tr.innerHTML = `
                <td class="p-4 whitespace-nowrap text-sm font-bold">
                    <span class="text-[#FFDB89] hover:underline cursor-pointer" onclick="window.openClientProfile('${client._id}')">${client.name} ${client.lastName || ''}</span>
                </td>
                <td class="p-4 whitespace-nowrap text-sm">
                    <input type="date" value="${client.dueDate || ''}"
                           class="bg-[#3a3a3c] border border-[#FFDB89]/30 rounded px-2 py-1 text-sm text-[#FFDB89] focus:ring-2 focus:ring-[#FFDB89] focus:outline-none"
                           onchange="window.updateClientDueDate('${client._id}', this.value)">
                </td>
                <td class="p-4 whitespace-nowrap text-center">
                    <button onclick="window.toggleClientPaymentStatus('${client._id}', ${client.isActive})" title="Click para cambiar estado">
                        ${statusBadge}
                    </button>
                </td>
                <td class="p-4 whitespace-nowrap text-right text-sm font-medium">
                    <a href="${waLink}" target="_blank" class="text-green-600 hover:text-green-900 dark:text-green-400 dark:hover:text-green-300 font-bold inline-flex items-center gap-2" onclick="event.stopPropagation()"><i class="fab fa-whatsapp text-lg"></i> <span class="hidden md:inline">Notificar</span></a>
                </td>`;
            tbody.appendChild(tr);
        });

        // --- Wire up search and filter listeners (only once) ---
        const searchInput = document.getElementById('pagos-search');
        const statusSelect = document.getElementById('pagos-status-filter');
        if (searchInput && !searchInput.dataset.wired) {
            searchInput.dataset.wired = 'true';
            searchInput.addEventListener('input', () => renderPaymentsView());
        }
        if (statusSelect && !statusSelect.dataset.wired) {
            statusSelect.dataset.wired = 'true';
            statusSelect.addEventListener('change', () => renderPaymentsView());
        }
    };

    // --- Payments: Update a client's due date ---
    window.updateClientDueDate = async (clientId, newDate) => {
        try {
            const res = await apiFetch(`/api/clients/${clientId}`, {
                method: 'PUT',
                body: JSON.stringify({ dueDate: newDate })
            });
            if (res.ok) {
                const updated = await res.json();
                const idx = mockClientsDb.findIndex(c => c._id === clientId);
                if (idx > -1) mockClientsDb[idx] = updated;
                renderPaymentsView();
            } else {
                const err = await res.json();
                alert(err.message || 'Error actualizando fecha');
            }
        } catch (e) { console.error(e); alert('Error de conexion'); }
    };

    // --- Payments: Toggle client active/inactive status ---
    window.toggleClientPaymentStatus = async (clientId, currentStatus) => {
        const newStatus = !currentStatus;
        const label = newStatus ? 'Al dia' : 'Pendiente';
        if (!confirm(`Cambiar estado del cliente a "${label}"?`)) return;
        try {
            const res = await apiFetch(`/api/clients/${clientId}`, {
                method: 'PUT',
                body: JSON.stringify({ isActive: newStatus })
            });
            if (res.ok) {
                const updated = await res.json();
                const idx = mockClientsDb.findIndex(c => c._id === clientId);
                if (idx > -1) mockClientsDb[idx] = updated;
                renderPaymentsView();
            } else {
                const err = await res.json();
                alert(err.message || 'Error actualizando estado');
            }
        } catch (e) { console.error(e); alert('Error de conexion'); }
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
            console.log("Opening workout editor for client:", currentClientViewId)
            editorExercises = [{ id: Date.now(), name: "", instructions: "", results: "", isSuperset: false, videoUrl: "" }];
            editorDateStr = dateStr;
            editorWarmup = "";
            editorWarmupVideoUrl = "";
            editorCooldown = "";
            editorWorkoutTitle = dateStr;
            openWorkoutEditor(dateStr); 
            
        } else if (action === 'rest') {
            const cell = document.getElementById(dateId);
            if(cell) {
                const content = cell.querySelector('.content-area');
                const exists = content.querySelector('.rest-badge');
                if(exists) exists.remove();
                else content.insertAdjacentHTML('beforeend', `<div class="rest-badge flex items-center gap-2"><div class="w-1 h-6 bg-[#FFDB89]/30 rounded-full shrink-0"></div><span class="text-xs font-bold text-[#FFDB89]/50">Día de descanso</span></div>`);
            }
            
        } else if (action === 'nutrition') {
            alert('Nutrición feature - Coming soon!');
            
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
                                        <div class="workout-card-header flex items-center gap-3 cursor-pointer py-0.5 group/wk" onclick="window.toggleWorkoutExpand(this)">
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
                alert(`${successCount} workout${successCount > 1 ? 's' : ''} pegado${successCount > 1 ? 's' : ''} exitosamente!`);

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
                        alert('Workout pegado exitosamente!');
                    }
                } catch(e) {
                    console.error(e);
                    alert('Error al pegar workout');
                }

            } else {
                alert('No hay workout copiado. Selecciona dias con el checkbox o haz clic derecho en un dia con workout.');
            }
            
        } else if (action === 'program') {
            // ASSIGN PROGRAM (Show program selector)
            showProgramAssignmentModal(dateStr);
        }
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
                    editorWarmup = workout.warmup || '';
                    editorWarmupVideoUrl = workout.warmupVideoUrl || '';
                    editorCooldown = workout.cooldown || '';
                    editorExercises = workout.exercises || [{ id: Date.now(), name: "", instructions: "", results: "", isSuperset: false, videoUrl: "" }];
                } else {
                    // New workout - initialize empty
                    editorExercises = [{ id: Date.now(), name: "", instructions: "", results: "", isSuperset: false, videoUrl: "" }];
                    editorWarmup = "";
                    editorWarmupVideoUrl = "";
                    editorCooldown = "";
                }
            } catch(e) {
                // Network error - initialize empty
                editorExercises = [{ id: Date.now(), name: "", instructions: "", results: "", isSuperset: false, videoUrl: "" }];
                editorWarmup = "";
                editorWarmupVideoUrl = "";
                editorCooldown = "";
            }
        }
        
        editorIsDirty = false;
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
                }
            }

            return `
            <div class="p-6 border-b border-[#FFDB89]/15 bg-[#32323c] relative">
                <div class="flex items-start gap-2 mb-2 min-w-0">
                    <div class="flex flex-col items-center gap-1 pt-1 shrink-0">
                        <input type="checkbox" class="ex-checkbox w-4 h-4 rounded accent-[#FFDB89] bg-gray-700 border-[#FFDB89]/30" data-id="${ex.id}" ${ex.isSuperset ? 'checked' : ''}>
                        <i class="fas fa-grip-lines text-[#FFDB89]/30 cursor-move hover:text-[#FFDB89] text-xs" title="Move"></i>
                    </div>
                    <h3 class="text-[#FFDB89] font-bold text-lg shrink-0">${letter})</h3>
                    <input type="text" value="${ex.name}" class="bg-transparent text-[#FFDB89] font-bold outline-none min-w-0 flex-1 placeholder-[#FFDB89]/30" placeholder="Título del ejercicio" oninput="window.updateExName(${ex.id}, this.value); window.markEditorDirty();">
                    <i class="fas fa-video ${ex.videoUrl ? 'text-[#FFDB89]' : 'text-[#FFDB89]/30'} cursor-pointer hover:text-[#FFDB89] shrink-0 mt-1" onclick="window.openVideoModalForEditor(${ex.id})"></i>
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

        // If the panel already exists just swap the exercise list — no full re-render, no animation
        const existingList = document.getElementById('editor-exercises-list');
        if (existingList) { existingList.innerHTML = listHtml; return; }

        modal.innerHTML = `
            <div id="editor-panel" class="bg-[#2d2d35] w-full max-w-md h-full shadow-2xl flex flex-col border-l border-[#FFDB89]/15 slide-in-right transition-all duration-300">

                <!-- TITLE always on top -->
                <div class="px-5 py-4 border-b border-[#FFDB89]/15 bg-[#26262c] shrink-0 flex items-center gap-3">
                    <input type="text" id="workout-title-input" value="${editorDateStr}" oninput="window.updateWorkoutTitle(this.value); window.markEditorDirty();" class="bg-transparent text-2xl font-bold text-[#FFDB89] placeholder-[#FFDB89]/30 w-full outline-none" placeholder="Nombre del Entrenamiento">
                    <div class="flex gap-3 text-[#FFDB89]/40 shrink-0">
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
                    <div class="p-6 border-b border-[#FFDB89]/15 hover:bg-[#363640] transition group relative">
                        <div class="flex items-center gap-3">
                            <div class="w-6 h-6 bg-orange-500 rounded flex-shrink-0 flex items-center justify-center text-white text-xs font-bold"><i class="fas fa-fire"></i></div>
                            <textarea oninput="window.updateWarmup(this.value); window.markEditorDirty();" class="bg-transparent text-base text-[#FFDB89]/70 placeholder-[#FFDB89]/30 w-full outline-none resize-none" rows="2" placeholder="Calentamiento o instrucciones generales...">${editorWarmup}</textarea>
                            <i class="fas fa-video ${editorWarmupVideoUrl ? 'text-[#FFDB89]' : 'text-[#FFDB89]/30'} cursor-pointer hover:text-[#FFDB89] flex-shrink-0" onclick="window.openWarmupVideoModal()" title="Video URL"></i>
                        </div>
                    </div>

                    <div id="editor-exercises-list">${listHtml}</div>

                    <div class="flex justify-center gap-2 p-6">
                        <button class="px-3 py-1 border border-[#FFDB89]/30 rounded text-[#FFDB89] text-xs hover:bg-[#FFDB89]/10 transition" onclick="window.addEditorExercise()">+ Ejercicio</button>
                    </div>

                    <!-- COOLDOWN -->
                    <div class="p-6 border-t border-[#FFDB89]/15">
                        <div class="flex items-center gap-3">
                            <div class="w-6 h-6 bg-[#3a3a3c] border border-[#FFDB89]/30 rounded flex-shrink-0 flex items-center justify-center text-[#FFDB89] text-xs font-bold"><i class="fas fa-snowflake"></i></div>
                            <textarea oninput="window.updateCooldown(this.value); window.markEditorDirty();" class="bg-transparent text-base text-[#FFDB89]/70 placeholder-[#FFDB89]/30 w-full outline-none resize-none" rows="2" placeholder="Enfriamiento (estiramientos, cardio ligero...)">${editorCooldown || ''}</textarea>
                        </div>
                    </div>
                </div>

                <!-- FOOTER -->
                <div class="p-4 border-t border-[#FFDB89]/15 flex flex-col gap-3 bg-[#26262c] shrink-0">
                    <button class="w-full py-3 bg-[#3a3a3c] text-[#FFDB89] font-bold rounded hover:bg-[#3a3a3c]/80 transition shadow-lg" onclick="window.saveDayWorkout()">Guardar</button>
                    <button class="w-full py-2 text-[#FFDB89]/60 font-bold hover:text-[#FFDB89] transition rounded hover:bg-[#FFDB89]/10" onclick="window.closeWorkoutEditor()">Cancelar</button>
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
                alert('Error loading programs');
                return;
            }
            
            const programs = await response.json();
            
            if(programs.length === 0) {
                alert('No hay programas creados. Ve a la sección "Programas" para crear uno primero.');
                return;
            }
            
            // Create modal
            const modal = document.createElement('div');
            modal.id = 'program-assignment-modal';
            modal.className = 'fixed inset-0 bg-black/80 z-[70] flex items-center justify-center p-4';
            modal.innerHTML = `
                <div class="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-md p-6">
                    <h3 class="text-xl font-bold mb-4 dark:text-white">Asignar Programa</h3>
                    <p class="text-sm text-gray-500 dark:text-gray-400 mb-4">Selecciona un programa para asignar a partir del ${startDate}</p>
                    
                    <div class="space-y-3 max-h-96 overflow-y-auto mb-6">
                        ${programs.map(prog => `
                            <div class="p-4 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer transition" onclick="window.assignProgramToClient('${prog._id}', '${startDate}')">
                                <div class="font-bold dark:text-white">${prog.name}</div>
                                <div class="text-xs text-gray-500">${prog.weeks?.length || 0} semanas · ${prog.clientCount || 0} clientes</div>
                            </div>
                        `).join('')}
                    </div>
                    
                    <button onclick="document.getElementById('program-assignment-modal').remove()" class="w-full py-2 bg-gray-200 dark:bg-gray-700 rounded-lg font-bold dark:text-white hover:bg-gray-300 dark:hover:bg-gray-600">Cancelar</button>
                </div>
            `;
            
            document.body.appendChild(modal);
            
        } catch(e) {
            console.error(e);
            alert('Error loading programs');
        }
    };

    // SUPERSET LETTER LOGIC
    const getLetter = (index, arr) => {
        let charCode = 65; 
        let subIndex = 0;
        let letters = [];
        for(let i=0; i<arr.length; i++) {
            if(i > 0 && arr[i].isSuperset && arr[i-1].isSuperset) { subIndex++; } 
            else { if(i > 0) charCode++; subIndex = 1; }
            if(arr[i].isSuperset) { letters.push(String.fromCharCode(charCode) + subIndex); } 
            else { letters.push(String.fromCharCode(charCode)); }
        }
        return letters[index];
    };

    // HELPERS
    window.updateWarmup = (val) => { editorWarmup = val; };
    window.addEditorExercise = () => { editorExercises.push({ id: Date.now(), name: "", instructions: "", results: "", isSuperset: false, videoUrl: "" }); renderWorkoutEditorUI(); window.markEditorDirty(); };
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

        const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        let html = '';

        if (workout.warmup) {
            html += `<div class="py-2 text-xs text-[#FFDB89]/50 italic border-b border-[#FFDB89]/10">${workout.warmup}</div>`;
        }

        (workout.exercises || []).forEach((ex, i) => {
            html += `<div class="py-2 flex items-start gap-2 border-b border-[#FFDB89]/10 last:border-0">
                <span class="text-xs font-bold text-[#FFDB89]/50 shrink-0 mt-0.5">${L[i] || '?'})</span>
                <div class="min-w-0">
                    <div class="text-xs font-bold text-[#FFDB89]/80">${ex.name || '<span class="opacity-40 italic">Sin nombre</span>'}</div>
                    ${ex.instructions ? `<div class="text-xs text-[#FFDB89]/40 mt-0.5 leading-relaxed">${ex.instructions}</div>` : ''}
                </div>
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

    window.performWorkoutSave = async (silent = false) => {
        if (!currentClientViewId) { if (!silent) alert('Error: No hay cliente seleccionado.'); return; }
        const titleInput = document.getElementById('workout-title-input');
        const workoutData = {
            clientId: currentClientViewId,
            date: editorDateStr,
            title: titleInput?.value || editorDateStr,
            warmup: editorWarmup,
            warmupVideoUrl: editorWarmupVideoUrl,
            cooldown: editorCooldown,
            exercises: editorExercises.map(ex => ({
                id: ex.id, name: ex.name, instructions: ex.instructions || '',
                results: ex.results || '', videoUrl: ex.videoUrl || '', isSuperset: ex.isSuperset || false
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
                            <div class="workout-card-header flex items-center gap-3 cursor-pointer py-0.5 group/wk" onclick="window.toggleWorkoutExpand(this)">
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
                        status.textContent = '✓ Autoguardado';
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
                    alert('Workout guardado exitosamente!');
                }
            } else {
                if (!silent) { const err = await response.text(); alert('Error al guardar: ' + err); }
            }
        } catch(e) {
            if (!silent) alert('Error de conexión: ' + e.message);
        }
    };
    // LINK SUPERSET BUTTON ACTION
    window.linkSuperset = (index) => {
        if (editorExercises[index + 1]) {
            editorExercises[index + 1].isSuperset = true;
            if (index > 0 && editorExercises[index].isSuperset) { /* already in chain */ }
            else { editorExercises[index].isSuperset = true; } 
            renderWorkoutEditorUI();
        }
    };

    // MODAL ACTIONS
    window.openVideoModalForEditor = (id) => {
        currentEditorExId = id;
        const ex = editorExercises.find(e => e.id === id);
        document.getElementById('video-url-input').value = ex ? ex.videoUrl : "";
        const titleEl = document.getElementById('video-modal-title');
        if (titleEl) titleEl.textContent = ex?.name?.trim() || 'Añadir Video URL';
        document.getElementById('video-upload-modal').classList.remove('hidden');
    };

    window.saveEditorVideo = () => {
        const url = document.getElementById('video-url-input').value;
        if(currentEditorExId === 'warmup') {
            editorWarmupVideoUrl = url;
            currentEditorExId = null;
        } else if(currentEditorExId) {
            const ex = editorExercises.find(e => e.id === currentEditorExId);
            if(ex) ex.videoUrl = url;
        }
        document.getElementById('video-upload-modal').classList.add('hidden');
        renderWorkoutEditorUI();
        window.markEditorDirty();
    };

    window.openWarmupVideoModal = () => {
        currentEditorExId = 'warmup';
        document.getElementById('video-url-input').value = editorWarmupVideoUrl || '';
        const titleEl = document.getElementById('video-modal-title');
        if (titleEl) titleEl.textContent = 'Calentamiento';
        document.getElementById('video-upload-modal').classList.remove('hidden');
    };

    window.openHistoryModal = (id) => {
        document.getElementById('history-modal').classList.remove('hidden');
    };

    window.saveDayWorkout = async () => {
        await window.performWorkoutSave(false);
    };

    window._saveDayWorkoutLegacy = async () => {
        console.log("DEBUG: Save clicked");
        console.log("currentClientViewId:", currentClientViewId);
        console.log("editorDateStr:", editorDateStr);
        console.log("editorExercises:", editorExercises);
        
        if(!currentClientViewId) {
            alert('Error: No hay cliente seleccionado. Por favor abre el calendario de un cliente primero.');
            console.error("currentClientViewId is null/undefined");
            return;
        }
        
        const titleInput = document.getElementById('workout-title-input');
        console.log("titleInput element:", titleInput);
        console.log("titleInput value:", titleInput?.value);
        
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
                isSuperset: ex.isSuperset || false
            }))
        };
        
        console.log("Sending workout data:", workoutData);
        
        try {
            const response = await apiFetch('/api/client-workouts', {
                method: 'POST',
                body: JSON.stringify(workoutData)
            });
            
            console.log("Response status:", response.status);
            console.log("Response ok:", response.ok);
            
            if(response.ok) {
                const savedWorkout = await response.json();
                console.log("Workout saved:", savedWorkout);
                
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
                alert('Workout guardado exitosamente!');
            } else {
                const errorText = await response.text();
                console.error("Server error:", errorText);
                alert('Error al guardar workout: ' + errorText);
            }
        } catch(e) { 
            console.error("Fetch error:", e); 
            alert('Error de conexión: ' + e.message);
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
            // Fetch the program
            const progResponse = await apiFetch('/api/programs');
            const programs = await progResponse.json();
            const program = programs.find(p => p._id === programId);
            
            if(!program) {
                alert('Programa no encontrado');
                return;
            }
            
            // Convert program weeks into client workouts
            const startDateObj = new Date(startDate);
            let currentDate = new Date(startDateObj);
            let workoutsCreated = 0;
            
            for(let weekIndex = 0; weekIndex < program.weeks.length; weekIndex++) {
                const week = program.weeks[weekIndex];
                
                // Each week has 7 days
                for(let dayNum = 1; dayNum <= 7; dayNum++) {
                    const dayData = week.days?.[dayNum];
                    
                    if(dayData && dayData.exercises && dayData.exercises.length > 0) {
                        const dateStr = currentDate.toISOString().split('T')[0];
                        
                        const workout = {
                            clientId: currentClientViewId,
                            date: dateStr,
                            title: dayData.name || `Semana ${weekIndex + 1} - Día ${dayNum}`,
                            warmup: '',
                            cooldown: '',
                            exercises: dayData.exercises.map((ex, idx) => ({
                                id: Date.now() + idx,
                                name: ex.name,
                                instructions: ex.stats || '',
                                videoUrl: ex.video || '',
                                isSuperset: false
                            }))
                        };
                        
                        // Save workout
                        await apiFetch('/api/client-workouts', {
                            method: 'POST',
                            body: JSON.stringify(workout)
                        });
                        
                        workoutsCreated++;
                    }
                    
                    // Move to next day
                    currentDate.setDate(currentDate.getDate() + 1);
                }
            }
            
            // Close modal and refresh calendar
            document.getElementById('program-assignment-modal').remove();
            alert(`Programa asignado! ${workoutsCreated} workouts creados.`);
            
            // Reload client profile to show new workouts
            openClientProfile(currentClientViewId);
            
        } catch(e) {
            console.error(e);
            alert('Error asignando programa');
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

        const target = e.target.closest('a, button, [id], .program-card, .open-video-modal, .client-row, .action-add, .pill-option, .toggle-switch, .cal-action-btn');
        if (!target) return;

        if (target.id === 'theme-toggle' || target.closest('#theme-toggle')) { 
            e.preventDefault(); 
            const isDark = document.documentElement.classList.toggle('dark');
            localStorage.setItem('theme', isDark ? 'dark' : 'light');
            updateThemeIcon();
            return; 
        }

        if (target.id === 'logout-btn' || target.closest('#logout-btn')) {
            localStorage.removeItem('auth_token');  // NEW: clear JWT
            localStorage.removeItem('auth_user');
            location.reload();
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
            else if (linkText.includes('Mis Programas')) moduleToLoad = 'client_programas';
            else if (linkText.includes('Métricas')) moduleToLoad = 'client_metricas';
            else if (linkText.includes('Nutrición')) moduleToLoad = 'client_nutricion';
            else if (linkText.includes('Equipo')) moduleToLoad = 'client_equipo';
            else if (linkText.includes('Fotos Progreso')) moduleToLoad = 'client_progress';
            else if (linkText.includes('Timer / Reloj')) moduleToLoad = 'client_clock'; 
            
            if (moduleToLoad) {
                try {
                    const res = await fetch(`${moduleToLoad}.html`);
                    if(res.ok) {
                        const html = await res.text();
                        updateContent(linkText, html);
                        if (moduleToLoad === 'clientes_content') { renderClientsTable(); attachClientFilterListeners(); }
                        if (moduleToLoad === 'programas_content') {
                            await fetchProgramsFromDB();
                            renderProgramsList();
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
                        mockGroupsDb.push(groupName);
                        document.getElementById('add-group-modal').classList.add('hidden');
                        document.getElementById('new-group-name').value = '';
                        alert(`Grupo "${groupName}" creado!`);
                    } else {
                        const err = await res.json();
                        alert(err.message || 'Error al crear grupo');
                    }
                } catch (e) { alert('Error al crear grupo'); }
            } else { alert("Por favor ingresa un nombre de grupo."); }
            return;
        }

        if (target.classList.contains('program-card')) { openProgramBuilder(target.dataset.id); return; }
        if (target.id === 'open-create-program-modal') { document.getElementById('create-program-modal').classList.remove('hidden'); return; }
        if (target.id === 'save-and-add-workouts') { handleCreateProgram(); return; }
        if (target.id === 'cancel-create-program') { document.getElementById('create-program-modal').classList.add('hidden'); return; }
        if (target.id === 'back-to-program-list') { document.getElementById('program-builder-view').classList.add('hidden'); document.getElementById('programs-main-view').classList.remove('hidden'); return; }
        if (target.id === 'add-week-btn') { addWeekToCalendar(); return; }
        if (target.classList.contains('action-add')) {
            const weekBlocks = Array.from(document.querySelectorAll('.week-block'));
            currentEditingWeekIndex = weekBlocks.indexOf(target.closest('.week-block'));
            currentEditingDay = target.dataset.day;
            openExerciseBuilder(target.dataset.day);
            return;
        }
        if (target.id === 'cancel-routine-edit' || target.id === 'cancel-routine-btn-footer') { document.getElementById('edit-routine-modal').classList.add('hidden'); return; }
        if (target.id === 'add-exercise-btn') { addExerciseToBuilder(); return; }
        if (target.id === 'save-routine-btn') { saveRoutine(); return; }
        
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
                updateContent('Clientes', html);
                renderClientsTable();
                attachClientFilterListeners();
            }
            return;
        }

        if (target.classList.contains('pill-option')) {
            e.preventDefault();
            const group = target.dataset.group;
            const val = target.dataset.val;
            document.querySelectorAll(`.pill-option[data-group="${group}"]`).forEach(b => b.classList.remove('active', 'text-white'));
            target.classList.add('active', 'text-white');
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

        // TOGGLE BETWEEN PROGRAMS AND EXERCISES VIEW
        if (target.id === 'toggle-programs-view') {
            document.getElementById('programs-view').classList.remove('hidden');
            document.getElementById('exercises-view').classList.add('hidden');
            
            target.classList.add('bg-white', 'dark:bg-gray-700', 'text-purple-600', 'dark:text-purple-400', 'shadow');
            target.classList.remove('text-gray-600', 'dark:text-gray-400');
            
            document.getElementById('toggle-exercises-view').classList.remove('bg-white', 'dark:bg-gray-700', 'text-purple-600', 'dark:text-purple-400', 'shadow');
            document.getElementById('toggle-exercises-view').classList.add('text-gray-600', 'dark:text-gray-400');
            
            document.getElementById('add-btn-text').textContent = "Nuevo Programa";
            document.getElementById('add-new-item-btn').onclick = () => document.getElementById('create-program-modal').classList.remove('hidden');
            
            return;
        }
        
        if (target.id === 'toggle-exercises-view') {
            document.getElementById('programs-view').classList.add('hidden');
            document.getElementById('exercises-view').classList.remove('hidden');
            
            target.classList.add('bg-white', 'dark:bg-gray-700', 'text-purple-600', 'dark:text-purple-400', 'shadow');
            target.classList.remove('text-gray-600', 'dark:text-gray-400');
            
            document.getElementById('toggle-programs-view').classList.remove('bg-white', 'dark:bg-gray-700', 'text-purple-600', 'dark:text-purple-400', 'shadow');
            document.getElementById('toggle-programs-view').classList.add('text-gray-600', 'dark:text-gray-400');
            
            document.getElementById('add-btn-text').textContent = "Nuevo Ejercicio";
            document.getElementById('add-new-item-btn').onclick = () => document.getElementById('add-exercise-modal').classList.remove('hidden');
            
            return;
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
            const confirmed = confirm('¿Copiar este workout?');
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
    let clockIntervalId = null; let stopwatchInterval = null; let timerInterval = null; let clockMode = 'CLOCK'; let stopwatchTime = 0; let timerTime = 0; let isClockRunning = false; let clockCanvas = null; let clockCtx = null;
    window.initClockModule = function() { clockCanvas = document.getElementById('clockCanvas'); if(!clockCanvas) return; clockCtx = clockCanvas.getContext('2d'); clockMode = 'CLOCK'; stopwatchTime = 0; timerTime = 0; isClockRunning = false; if(stopwatchInterval) clearInterval(stopwatchInterval); if(timerInterval) clearInterval(timerInterval); if(clockIntervalId) cancelAnimationFrame(clockIntervalId); window.clockDrawLoop(); };
    window.clockSetMode = function(mode) { clockMode = mode; const modeLabel = document.getElementById('modeLabel'); const timerInputArea = document.getElementById('timerInputArea'); const actionBtn = document.getElementById('actionBtn'); const timeDisplay = document.getElementById('timeDisplay'); if(modeLabel) modeLabel.innerText = mode; window.clockResetLogic(); if (mode === 'TIMER') { if(timerInputArea) timerInputArea.style.display = 'block'; if(timeDisplay) timeDisplay.innerText = "00:00"; } else { if(timerInputArea) timerInputArea.style.display = 'none'; } if(actionBtn) actionBtn.innerText = (mode === 'CLOCK') ? "---" : "Start"; };
    window.clockHandleAction = function() { if (clockMode === 'CLOCK') return; if (isClockRunning) window.clockStopLogic(); else window.clockStartLogic(); };
    window.clockStartLogic = function() { const actionBtn = document.getElementById('actionBtn'); const timerInput = document.getElementById('timerInput'); isClockRunning = true; if(actionBtn) actionBtn.innerText = "Stop"; if (clockMode === 'STOPWATCH') { const startTime = Date.now() - stopwatchTime; stopwatchInterval = setInterval(() => { stopwatchTime = Date.now() - startTime; window.clockUpdateDisplay(stopwatchTime); }, 100); } else if (clockMode === 'TIMER') { if (timerTime === 0) timerTime = parseInt(timerInput ? timerInput.value || 0 : 0) * 1000; const endTime = Date.now() + timerTime; timerInterval = setInterval(() => { timerTime = endTime - Date.now(); if (timerTime <= 0) { timerTime = 0; clearInterval(timerInterval); alert("Time is up!"); window.clockResetLogic(); } window.clockUpdateDisplay(timerTime); }, 100); } };
    window.clockStopLogic = function() { isClockRunning = false; const actionBtn = document.getElementById('actionBtn'); if(actionBtn) actionBtn.innerText = "Start"; clearInterval(stopwatchInterval); clearInterval(timerInterval); };
    window.clockResetLogic = function() { window.clockStopLogic(); stopwatchTime = 0; timerTime = 0; const timeDisplay = document.getElementById('timeDisplay'); if (clockMode !== 'CLOCK' && timeDisplay) timeDisplay.innerText = "00:00"; };
    window.clockUpdateDisplay = function(ms) { const timeDisplay = document.getElementById('timeDisplay'); if(!timeDisplay) return; const totalSeconds = Math.floor(ms / 1000); const m = Math.floor(totalSeconds / 60).toString().padStart(2, '0'); const s = (totalSeconds % 60).toString().padStart(2, '0'); timeDisplay.innerText = `${m}:${s}`; };
    window.clockDrawLoop = function() { if(!document.getElementById('clockCanvas')) return; const centerX = 400; const centerY = 400; clockCtx.clearRect(0, 0, 800, 800); window.clockDrawGear(clockCtx, centerX, centerY, 12, 360, 320, 40, '#5e2d91'); clockCtx.fillStyle = "white"; clockCtx.font = "bold 24px Arial"; clockCtx.textAlign = "center"; for (let i = 0; i < 60; i += 5) { const angle = (i - 15) * (Math.PI * 2 / 60); const x = centerX + Math.cos(angle) * 385; const y = centerY + Math.sin(angle) * 385 + 10; clockCtx.fillText(i, x, y); } const now = new Date(); let activeSeconds = 0; if (clockMode === 'CLOCK') { activeSeconds = now.getSeconds(); const timeDisplay = document.getElementById('timeDisplay'); if(timeDisplay) timeDisplay.innerText = now.toTimeString().split(' ')[0].substring(0, 5); } else if (clockMode === 'STOPWATCH') { activeSeconds = Math.floor(stopwatchTime / 1000) % 60; } else if (clockMode === 'TIMER') { activeSeconds = Math.floor(timerTime / 1000) % 60; } for (let i = 0; i < 60; i++) { window.clockDrawMarker(clockCtx, centerX, centerY, i, i <= activeSeconds); } clockIntervalId = requestAnimationFrame(window.clockDrawLoop); };
    window.clockDrawGear = function(ctx, x, y, teeth, outerRadius, innerRadius, toothHeight, color) { ctx.save(); ctx.beginPath(); ctx.translate(x, y); ctx.fillStyle = color; ctx.strokeStyle = "rgba(0,0,0,0.3)"; ctx.lineWidth = 5; for (let i = 0; i < teeth; i++) { ctx.rotate(Math.PI / teeth); ctx.lineTo(innerRadius, 0); ctx.lineTo(outerRadius, toothHeight); ctx.rotate(Math.PI / teeth); ctx.lineTo(outerRadius, -toothHeight); ctx.lineTo(innerRadius, 0); } ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore(); };
    window.clockDrawMarker = function(ctx, centerX, centerY, index, isActive) { const angle = (index - 15) * (Math.PI * 2 / 60); ctx.beginPath(); ctx.strokeStyle = isActive ? "white" : "rgba(255,255,255,0.15)"; ctx.lineWidth = 15; ctx.arc(centerX, centerY, 280, angle - 0.04, angle + 0.04); ctx.stroke(); };

    // CLIENT HOME / INICIO
    const initClientHome = async () => {
        const session = loadSession();
        if (!session) return;

        // Set greeting
        const greetingEl = document.getElementById('client-greeting');
        const dateEl = document.getElementById('client-today-date');

        if (greetingEl) {
            const hour = new Date().getHours();
            let greeting = 'Buenos dias';
            if (hour >= 12 && hour < 17) greeting = 'Buenas tardes';
            else if (hour >= 17) greeting = 'Buenas noches';
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
                    content.innerHTML = `
                        <h4 class="text-lg font-bold text-gray-800 dark:text-white mb-3">${workout.title || 'Workout'}</h4>
                        ${workout.warmup ? `<p class="text-sm text-orange-500 mb-2"><i class="fas fa-fire mr-1"></i> Warmup: ${workout.warmup}</p>` : ''}
                        <div class="space-y-2">
                            ${(workout.exercises || []).map((ex, i) => `
                                <div class="flex items-center gap-3 p-2 bg-gray-50 dark:bg-gray-700 rounded-lg">
                                    <span class="w-6 h-6 bg-blue-500 text-white rounded text-xs flex items-center justify-center font-bold shrink-0">${i + 1}</span>
                                    <span class="text-sm font-medium dark:text-white">${ex.name}</span>
                                </div>
                            `).join('')}
                        </div>
                        ${workout.cooldown ? `<p class="text-sm text-blue-500 mt-2"><i class="fas fa-snowflake mr-1"></i> Cooldown: ${workout.cooldown}</p>` : ''}
                    `;
                }
            } else {
                if (content) {
                    content.innerHTML = `
                        <div class="text-center py-6">
                            <i class="fas fa-calendar-check text-5xl text-gray-300 dark:text-gray-600 mb-3 block"></i>
                            <p class="text-gray-500 dark:text-gray-400 font-medium">No hay entrenamiento programado para hoy.</p>
                            <p class="text-gray-400 dark:text-gray-500 text-sm mt-1">Disfruta tu dia de descanso!</p>
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
                const totalEl = document.getElementById('stat-total-workouts');
                if (totalEl) totalEl.textContent = workouts.length;

                // Workouts this week
                const now = new Date();
                const dayOfWeek = now.getDay();
                const weekStart = new Date(now);
                weekStart.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
                const weekStartStr = weekStart.toISOString().split('T')[0];
                const thisWeek = workouts.filter(w => w.date >= weekStartStr && w.date <= todayStr).length;
                const weekEl = document.getElementById('stat-workouts-week');
                if (weekEl) weekEl.textContent = thisWeek;

                // Simple streak: count consecutive days with workouts going back from today
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

                // Recent activity
                const activityEl = document.getElementById('client-recent-activity');
                if (activityEl) {
                    const recent = workouts.slice(0, 5);
                    if (recent.length === 0) {
                        activityEl.innerHTML = '<p class="text-gray-400 text-sm text-center py-4">Sin actividad reciente.</p>';
                    } else {
                        activityEl.innerHTML = recent.map(w => `
                            <div class="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                                <div class="w-10 h-10 bg-blue-100 dark:bg-blue-900 rounded-full flex items-center justify-center shrink-0">
                                    <i class="fas fa-dumbbell text-blue-500 text-sm"></i>
                                </div>
                                <div class="flex-grow min-w-0">
                                    <p class="text-sm font-bold text-gray-800 dark:text-white truncate">${w.title || 'Workout'}</p>
                                    <p class="text-xs text-gray-500">${w.date} - ${(w.exercises || []).length} ejercicios</p>
                                </div>
                            </div>
                        `).join('');
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
                if (progEl) progEl.textContent = profile.program || 'Sin Asignar';
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

            // --- Shared chart options builder ---
            const buildChart = (canvasId, label, data, labels, color) => {
                const ctx = document.getElementById(canvasId);
                if (!ctx) return;
                new Chart(ctx, {
                    type: 'line',
                    data: {
                        labels,
                        datasets: [{
                            label,
                            data,
                            borderColor: color,
                            backgroundColor: color + '18',
                            borderWidth: 2,
                            tension: 0.4,
                            fill: true,
                            pointRadius: 4,
                            pointBackgroundColor: color,
                            pointBorderColor: '#0d0d0d',
                            pointBorderWidth: 2
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: { legend: { display: false } },
                        scales: {
                            x: {
                                ticks: { color: '#FFDB89', font: { size: 10 } },
                                grid: { color: 'rgba(255,219,137,0.08)' }
                            },
                            y: {
                                beginAtZero: false,
                                ticks: { color: '#FFDB89', font: { size: 10 } },
                                grid: { color: 'rgba(255,219,137,0.08)' }
                            }
                        }
                    }
                });
            };

            // Build chart data from measurements (sorted oldest→newest)
            const chartLabels = measurements.map(m => {
                const [y, mo, d] = m.date.split('-');
                return `${d}/${mo}/${y.slice(2)}`;
            });
            const weightData  = measurements.map(m => m.weight   || null);
            const fatData     = measurements.map(m => m.bodyFat  || null);

            buildChart('weightChart', 'Peso (lbs)', weightData,  chartLabels, '#FFDB89');
            buildChart('fatChart',    '% Grasa',    fatData,     chartLabels, '#FFDB89');

            // --- Render table ---
            const countEl  = document.getElementById('metrics-record-count');
            const emptyEl  = document.getElementById('metrics-empty');
            const wrapEl   = document.getElementById('metrics-table-wrap');
            const bodyEl   = document.getElementById('metrics-table-body');

            if (countEl) countEl.textContent = `${measurements.length} registro${measurements.length !== 1 ? 's' : ''}`;

            if (measurements.length === 0) {
                if (emptyEl) emptyEl.classList.remove('hidden');
                if (wrapEl)  wrapEl.classList.add('hidden');
                return;
            }

            if (emptyEl) emptyEl.classList.add('hidden');
            if (wrapEl)  wrapEl.classList.remove('hidden');

            // Render newest first in table
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

    // --- EQUIPO: Render weight selection grids ---
    const renderEquipmentOptions = () => {
        const lbsDumbbells = [5,10,15,20,25,30,35,40,45,50,55,60,65,70,75,80,85,90,95,100];
        const lbsPlates = [2.5, 5, 10, 15, 25, 35, 45];
        const lbsKettlebells = [10,15,20,25,30,35,40,45,50,53,60,70,80,90,100];
        const cableWeights = [5,10,15,20,25,30,35,40,45,50,55,60,65,70,75,80,85,90,95,100];

        const renderGrid = (containerId, weights, unit = 'lbs') => {
            const container = document.getElementById(containerId);
            if (!container) return;
            container.innerHTML = weights.map(w => `
                <button class="equipment-btn p-3 rounded-lg border-2 border-gray-200 dark:border-gray-600 text-center font-bold text-gray-700 dark:text-gray-200 hover:border-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition cursor-pointer select-none" data-weight="${w}" data-selected="false" onclick="this.dataset.selected = this.dataset.selected === 'true' ? 'false' : 'true'; this.classList.toggle('border-blue-500'); this.classList.toggle('bg-blue-50'); this.classList.toggle('dark:bg-blue-900/30'); this.classList.toggle('text-blue-700');">
                    ${w} <span class="text-xs text-gray-400">${unit}</span>
                </button>
            `).join('');
        };

        renderGrid('dumbbells-container', lbsDumbbells);
        renderGrid('plates-container', lbsPlates);
        renderGrid('kettlebells-container', lbsKettlebells);
        renderGrid('cables-container', cableWeights);
    };

    // --- CLIENT NUTRITION: Initialize calculations ---
    const initClientNutrition = async () => {
        const session = loadSession();
        if (!session) return;

        // Load latest weight data
        try {
            const res = await apiFetch(`/api/weight-logs/${session.id}`);
            if (res.ok) {
                const logs = await res.json();
                if (logs.length > 0) {
                    const latest = logs[0]; // sorted desc by date
                    const weightInput = document.getElementById('nutri-weight');
                    const fatInput = document.getElementById('nutri-fat');
                    if (weightInput && latest.weight) weightInput.value = latest.weight;
                    if (fatInput && latest.bodyFat) fatInput.value = latest.bodyFat;
                }
            }
        } catch (e) { console.error('Error loading nutrition data:', e); }

        // Calculate macros on input change
        const recalc = () => {
            const weight = parseFloat(document.getElementById('nutri-weight')?.value) || 0;
            const bf = parseFloat(document.getElementById('nutri-fat')?.value) || 0;
            const meals = parseInt(document.getElementById('meals-per-day')?.value) || 4;

            // Lean body mass
            const lbm = weight * (1 - bf / 100);
            const lbmEl = document.getElementById('calc-lbm');
            if (lbmEl) lbmEl.textContent = `${lbm.toFixed(1)} lbs`;

            // BMI (estimate with average height 5'9" = 69 inches)
            const bmiEl = document.getElementById('calc-bmi');
            if (bmiEl) bmiEl.textContent = (weight / (69 * 69) * 703).toFixed(1);

            // Water recommendation: ~0.5 oz per pound of body weight
            const waterEl = document.getElementById('calc-water');
            if (waterEl) waterEl.textContent = `${Math.round(weight * 0.5)} oz`;

            // Maintenance calories: ~15 cal per pound of body weight
            const maintenance = Math.round(weight * 15);
            const cutCal = Math.round(maintenance * 0.8);
            const bulkCal = Math.round(maintenance * 1.15);

            const mainEl = document.getElementById('val-main');
            const cutEl = document.getElementById('val-cut');
            const bulkEl = document.getElementById('val-bulk');
            if (mainEl) mainEl.textContent = maintenance;
            if (cutEl) cutEl.textContent = cutCal;
            if (bulkEl) bulkEl.textContent = bulkCal;

            // Macro distribution (40/40/20 of maintenance)
            const proCal = maintenance * 0.4;
            const carbCal = maintenance * 0.4;
            const fatCal = maintenance * 0.2;

            const setCells = (prefix, totalCal, calPerGram) => {
                const totalEl = document.getElementById(`total-${prefix}-cal`);
                const mealCalEl = document.getElementById(`meal-${prefix}-cal`);
                const mealGEl = document.getElementById(`meal-${prefix}-g`);
                const mealOzEl = document.getElementById(`meal-${prefix}-oz`);
                if (totalEl) totalEl.textContent = Math.round(totalCal);
                if (mealCalEl) mealCalEl.textContent = Math.round(totalCal / meals);
                if (mealGEl) mealGEl.textContent = Math.round(totalCal / calPerGram / meals);
                if (mealOzEl) mealOzEl.textContent = (totalCal / calPerGram / meals / 28.35).toFixed(1);
            };

            setCells('pro', proCal, 4);
            setCells('carb', carbCal, 4);
            setCells('fat', fatCal, 9);
        };

        // Attach listeners
        ['nutri-weight', 'nutri-fat'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('input', recalc);
        });
        const mealsSelect = document.getElementById('meals-per-day');
        if (mealsSelect) mealsSelect.addEventListener('change', recalc);

        // Save button
        const saveBtn = document.getElementById('save-nutrition-btn');
        if (saveBtn) {
            saveBtn.addEventListener('click', async () => {
                const weight = parseFloat(document.getElementById('nutri-weight')?.value);
                const bodyFat = parseFloat(document.getElementById('nutri-fat')?.value);
                if (!weight) return;
                try {
                    const today = new Date().toISOString().split('T')[0];
                    await apiFetch('/api/weight-logs', {
                        method: 'POST',
                        body: JSON.stringify({ clientId: session.id, date: today, weight, bodyFat })
                    });
                    saveBtn.textContent = 'Guardado!';
                    setTimeout(() => { saveBtn.textContent = 'Guardar Cambios'; }, 2000);
                } catch (e) { console.error('Error saving nutrition:', e); }
            });
        }

        recalc(); // Initial calculation
    };

    // --- CLIENT PROGRESS PHOTOS: Fetch and render from API ---
    const initClientProgress = async () => {
        const session = loadSession();
        if (!session) return;

        try {
            const res = await apiFetch(`/api/progress-photos/${session.id}`);
            if (!res.ok) return;
            const photos = await res.json();

            const grid = document.querySelector('#programs-main-view ~ .grid, .grid.grid-cols-1.md\\:grid-cols-3');
            // Find the grid that contains the photo cards
            const containers = document.querySelectorAll('.grid.grid-cols-1');
            let photoGrid = null;
            containers.forEach(c => {
                if (c.querySelector('.aspect-\\[3\\/4\\]') || c.classList.contains('md:grid-cols-3')) {
                    photoGrid = c;
                }
            });

            if (!photoGrid) return;

            photoGrid.innerHTML = photos.map(photo => `
                <div class="bg-white dark:bg-gray-800 p-4 rounded-xl shadow-lg">
                    <div class="aspect-[3/4] bg-gray-200 dark:bg-gray-700 rounded-lg mb-4 overflow-hidden">
                        <img src="${photo.imageData}" alt="Progreso" class="w-full h-full object-cover">
                    </div>
                    <div class="flex justify-between items-center">
                        <span class="font-bold text-gray-700 dark:text-gray-200">${photo.category || 'Progreso'}</span>
                        <span class="text-xs text-gray-500">${photo.date}</span>
                    </div>
                </div>
            `).join('') + `
                <div class="border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-xl flex flex-col items-center justify-center p-8 text-gray-400 hover:border-blue-500 hover:text-blue-500 transition cursor-pointer" id="add-progress-photo-btn">
                    <i class="fas fa-plus-circle text-4xl mb-2"></i>
                    <span class="font-semibold">Añadir Nueva</span>
                </div>
            `;

            if (photos.length === 0) {
                photoGrid.innerHTML = `
                    <div class="col-span-3 text-center py-12">
                        <i class="fas fa-camera text-5xl text-gray-300 dark:text-gray-600 mb-3 block"></i>
                        <p class="text-gray-500 font-medium">No hay fotos de progreso aun.</p>
                        <p class="text-gray-400 text-sm mt-1">Sube tu primera foto para comenzar a ver tu transformacion!</p>
                    </div>
                    <div class="border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-xl flex flex-col items-center justify-center p-8 text-gray-400 hover:border-blue-500 hover:text-blue-500 transition cursor-pointer" id="add-progress-photo-btn">
                        <i class="fas fa-plus-circle text-4xl mb-2"></i>
                        <span class="font-semibold">Añadir Nueva</span>
                    </div>
                `;
            }
        } catch (e) { console.error('Error loading progress photos:', e); }
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

        // Set current date
        const dateDisplay = document.getElementById('current-date-display');
        if (dateDisplay) {
            const today = new Date();
            dateDisplay.textContent = today.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'short' });
        }

        // Load workouts and populate the desktop calendar grid
        try {
            const res = await apiFetch(`/api/client-workouts/${session.id}`);
            if (!res.ok) return;
            const workouts = await res.json();

            // Populate mobile view with today's workout
            const todayStr = new Date().toISOString().split('T')[0];
            const todayWorkout = workouts.find(w => w.date === todayStr);
            const mobileContainer = document.getElementById('mobile-exercises-container');
            if (mobileContainer) {
                if (todayWorkout) {
                    mobileContainer.innerHTML = `
                        <h4 class="font-bold text-gray-800 dark:text-white mb-2">${todayWorkout.title || 'Entrenamiento'}</h4>
                        ${todayWorkout.warmup ? `<p class="text-sm text-orange-500 mb-2"><i class="fas fa-fire mr-1"></i>${todayWorkout.warmup}</p>` : ''}
                        ${(todayWorkout.exercises || []).map((ex, i) => `
                            <div class="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                                <span class="w-7 h-7 bg-blue-500 text-white rounded text-xs flex items-center justify-center font-bold shrink-0">${i + 1}</span>
                                <div class="flex-grow">
                                    <span class="text-sm font-bold dark:text-white">${ex.name}</span>
                                    ${ex.instructions ? `<p class="text-xs text-gray-500">${ex.instructions}</p>` : ''}
                                </div>
                            </div>
                        `).join('')}
                        ${todayWorkout.cooldown ? `<p class="text-sm text-blue-500 mt-2"><i class="fas fa-snowflake mr-1"></i>${todayWorkout.cooldown}</p>` : ''}
                    `;
                } else {
                    mobileContainer.innerHTML = '<p class="text-gray-400 text-sm text-center py-4">No hay entrenamiento hoy. Dia de descanso!</p>';
                }
            }

            // Populate desktop calendar
            const calGrid = document.getElementById('desktop-calendar-grid');
            if (calGrid) {
                const today = new Date();
                // Get Monday of the current week
                const dayOfWeek = today.getDay();
                const monday = new Date(today);
                monday.setDate(today.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));

                // Show 4 weeks
                const workoutMap = {};
                workouts.forEach(w => { workoutMap[w.date] = w; });

                let calHTML = '';
                for (let week = 0; week < 4; week++) {
                    for (let day = 0; day < 7; day++) {
                        const cellDate = new Date(monday);
                        cellDate.setDate(monday.getDate() + (week * 7) + day);
                        const dateStr = cellDate.toISOString().split('T')[0];
                        const isToday = dateStr === todayStr;
                        const workout = workoutMap[dateStr];

                        calHTML += `
                            <div class="bg-white dark:bg-gray-800 p-2 min-h-[100px] ${isToday ? 'ring-2 ring-blue-500' : ''} relative">
                                <div class="text-xs font-bold ${isToday ? 'text-blue-500' : 'text-gray-500 dark:text-gray-400'} mb-1">${cellDate.getDate()}</div>
                                ${workout ? `
                                    <div class="bg-blue-50 dark:bg-blue-900/30 rounded p-1.5 cursor-pointer hover:bg-blue-100 dark:hover:bg-blue-900/50 transition">
                                        <p class="text-xs font-bold text-blue-700 dark:text-blue-300 truncate">${workout.title || 'Workout'}</p>
                                        <p class="text-[10px] text-blue-500">${(workout.exercises || []).length} ejercicios</p>
                                    </div>
                                ` : ''}
                            </div>
                        `;
                    }
                }
                calGrid.innerHTML = calHTML;
            }
        } catch (e) { console.error('Error loading client programs:', e); }

        // Mood selector
        document.querySelectorAll('.mood-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.mood-btn').forEach(b => b.classList.remove('ring-2', 'ring-blue-400', 'bg-blue-50', 'dark:bg-blue-900/30'));
                btn.classList.add('ring-2', 'ring-blue-400', 'bg-blue-50', 'dark:bg-blue-900/30');
            });
        });
    };

    // RENDER TRAINER HOME
    window.renderTrainerHome = async (trainerName, filterType = 'Todos') => {
        const greetingEl = document.getElementById('greeting-text');
        const feedContainer = document.getElementById('trainer-feed-container');
        if (!feedContainer) return;
ƒ
        const hour = new Date().getHours();
        let greeting = "¡Buenos días";
        if (hour >= 12 && hour < 17) greeting = "¡Buenas tardes";
        else if (hour >= 17) greeting = "¡Buenas noches";
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
        const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

        // Filter clients by type
        const clientsToRender = filterType === 'Todos'
            ? mockClientsDb.filter(c => c.isActive)
            : mockClientsDb.filter(c => c.isActive && c.type === filterType);

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
                            letter: letters[i] || (i + 1),
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
            feedContainer.innerHTML = '<p class="text-center text-[#282D32]/50 py-8">No hay clientes registrados.</p>';
            return;
        }

        // Show rest days toggle
        const showRest = document.getElementById('show-rest-days')?.checked;
        const visibleItems = showRest ? feedItems : feedItems.filter(item => item.hasWorkout);

        if (visibleItems.length === 0) {
            feedContainer.innerHTML = '<p class="text-center text-[#282D32]/50 py-8">No hay entrenamientos programados para hoy.</p>';
            return;
        }

        feedContainer.innerHTML = visibleItems.map(item => {
            if (!item.hasWorkout) {
                return `
                <div class="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden shadow-lg opacity-60">
                    <div class="p-4 border-b border-gray-700 flex justify-between items-center">
                        <div class="flex items-center gap-3">
                            <div class="w-10 h-10 rounded-full bg-gray-600 text-white flex items-center justify-center font-bold cursor-pointer hover:bg-gray-500 transition" onclick="window.openClientProfile('${item.clientId}')">${item.initials}</div>
                            <div>
                                <h3 class="font-bold text-white text-lg leading-tight cursor-pointer hover:text-blue-400 transition" onclick="window.openClientProfile('${item.clientId}')">${item.clientName}</h3>
                                <p class="text-xs text-gray-400">Vence: ${item.dueDate}</p>
                            </div>
                        </div>
                    </div>
                    <div class="p-6 text-center">
                        <i class="fas fa-bed text-3xl text-gray-600 mb-2"></i>
                        <p class="text-gray-400 font-medium">Dia de descanso</p>
                    </div>
                </div>`;
            }

            return `
            <div class="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden shadow-lg">
                <div class="p-4 border-b border-gray-700 flex justify-between items-center">
                    <div class="flex items-center gap-3">
                        <div class="w-10 h-10 rounded-full bg-gray-600 text-white flex items-center justify-center font-bold cursor-pointer hover:bg-gray-500 transition" onclick="window.openClientProfile('${item.clientId}')">${item.initials}</div>
                        <div>
                            <h3 class="font-bold text-white text-lg leading-tight cursor-pointer hover:text-blue-400 transition" onclick="window.openClientProfile('${item.clientId}')">${item.clientName}</h3>
                            <p class="text-xs text-gray-400">Vence: ${item.dueDate}</p>
                        </div>
                    </div>
                </div>
                <div class="p-4 border-b border-gray-700">
                    <h2 class="text-xl font-bold text-white">${item.workoutTitle}</h2>
                    ${item.warmup ? `<p class="text-sm text-orange-400 mt-1"><i class="fas fa-fire mr-1"></i>${item.warmup}</p>` : ''}
                </div>
                <div class="p-4 space-y-3">
                    ${item.exercises.map(ex => `
                        <div class="flex items-start gap-3">
                            <div class="w-7 h-7 bg-gray-700 rounded text-white font-bold flex items-center justify-center text-xs shrink-0">${ex.letter}</div>
                            <div class="flex-1">
                                <h4 class="font-bold text-white text-sm">${ex.name}</h4>
                                ${ex.instructions ? `<p class="text-xs text-gray-400 mt-0.5">${ex.instructions}</p>` : ''}
                            </div>
                        </div>`).join('')}
                </div>
                ${item.cooldown ? `<div class="px-4 pb-4"><p class="text-sm text-blue-400"><i class="fas fa-snowflake mr-1"></i>${item.cooldown}</p></div>` : ''}
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