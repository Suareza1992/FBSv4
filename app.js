document.addEventListener('DOMContentLoaded', () => {

    // =============================================================================
    // 1. CONFIGURATION & STATE
    // =============================================================================
    
    // DOM Elements
    const authScreen = document.getElementById('auth-screen');
    const dashboardContainer = document.getElementById('dashboard-container');
    const sidebarPlaceholder = document.getElementById('sidebar-placeholder');
    const mainContentArea = document.getElementById('main-content');
    
    // Auth Form Elements
    const authTitle = document.getElementById('auth-title');
    const authSubmitBtn = document.getElementById('auth-submit-btn');
    const authToggleBtn = document.getElementById('auth-toggle-btn');
    const authNameInput = document.getElementById('auth-name');
    const authEmailInput = document.getElementById('auth-email');
    const authPasswordInput = document.getElementById('auth-password'); 
    const authMessage = document.getElementById('auth-message');

    // --- DATA STORES (Local Cache) ---
    const defaultClients = [
        { id: 1, name: "Juan", lastName: "Del Pueblo", email: "juan@example.com", type: "Remoto", program: "Fuerza Máxima", dueDate: "2025-12-15", isActive: true },
        { id: 2, name: "Maria", lastName: "Rivera", email: "maria@example.com", type: "Híbrido", program: "", dueDate: "2025-11-30", isActive: false }
    ];

    const defaultPrograms = [
        { 
            id: 1, name: "Fuerza Máxima", description: "5x5 levantamiento pesado.", clientCount: 5, tags: "Avanzado",
            weeks: [
                { 
                    id: 101, 
                    days: { 
                        1: { name: "Pierna Pesado", warmup: "5 min bici", cooldown: "Estiramiento", exercises: [{name: "Squat", stats: "5x5", video: ""}], isRest: false },
                        3: { name: "Empuje (Push)", warmup: "Rotaciones", cooldown: "Yoga", exercises: [{name: "Bench Press", stats: "4x8", video: ""}], isRest: false }
                    } 
                }
            ] 
        }
    ];

    // Data Variables
    let mockClientsDb = [];
    let mockProgramsDb = [];
    let mockVideoLibrary = []; 

    // State Variables
    const MODULE_CACHE = {}; 
    let isSigningUp = false; 
    let currentWeekCount = 0;
    let exerciseCount = 0;
    let currentProgramId = null;
    let currentEditingDay = null; 
    let currentEditingWeekIndex = 0;
    let currentVideoExerciseBtn = null;


    // =============================================================================
    // 2. PERSISTENCE & SESSION
    // =============================================================================

    const saveData = () => {
        localStorage.setItem('fitbysuarez_clients', JSON.stringify(mockClientsDb));
        localStorage.setItem('fitbysuarez_programs', JSON.stringify(mockProgramsDb));
        localStorage.setItem('fitbysuarez_library', JSON.stringify(mockVideoLibrary));
    };

    const loadData = () => {
        const c = localStorage.getItem('fitbysuarez_clients');
        const p = localStorage.getItem('fitbysuarez_programs');
        const l = localStorage.getItem('fitbysuarez_library');
        
        mockClientsDb = c ? JSON.parse(c) : defaultClients;
        mockProgramsDb = p ? JSON.parse(p) : defaultPrograms;
        mockVideoLibrary = l ? JSON.parse(l) : []; 
    };

    const saveSession = (user) => { try { localStorage.setItem('auth_user', JSON.stringify(user)); } catch (e) {} };
    const loadSession = () => { try { return JSON.parse(localStorage.getItem('auth_user')); } catch (e) { return null; } };
    const clearSession = () => { localStorage.removeItem('auth_user'); location.reload(); };


    // =============================================================================
    // 3. THEME LOGIC
    // =============================================================================

    const updateThemeIcon = () => {
        const btns = document.querySelectorAll('#theme-toggle');
        const isDark = document.documentElement.classList.contains('dark');
        const sidebar = document.getElementById('sidebar');
        const isCollapsed = sidebar && sidebar.classList.contains('w-20');
        const textClass = isCollapsed ? 'nav-text ml-3 hidden' : 'nav-text ml-3';

        btns.forEach(btn => {
            if (isDark) {
                btn.innerHTML = `<i class="fas fa-moon text-gray-400 text-xl w-6 text-center"></i><span class="${textClass}">Modo Oscuro</span>`;
            } else {
                btn.innerHTML = `<i class="fas fa-sun text-yellow-500 text-xl w-6 text-center"></i><span class="${textClass}">Modo Claro</span>`;
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
        `;
        document.head.appendChild(style);
    };

    const updateContent = (title, contentHtml) => {
        mainContentArea.innerHTML = `
        <div class="p-6 bg-white dark:bg-gray-800 rounded-xl shadow-lg h-full flex flex-col">
            <h1 class="text-4xl font-bold text-gray-800 dark:text-gray-100 mb-6 border-b border-gray-200 dark:border-gray-700 pb-3 flex-shrink-0">${title}</h1>
            <div class="flex-grow overflow-auto pr-2">${contentHtml}</div>
        </div>`;
    };

    const updateDashboard = (welcomeTitle, userName) => {
        const trainerNameSpan = document.getElementById('trainer-name');
        if(trainerNameSpan) trainerNameSpan.textContent = userName;
        
        const sidebar = document.getElementById('sidebar');
        if(sidebar) sidebar.querySelectorAll('nav a').forEach(a => a.classList.add('nav-link-item'));
        
        if (document.getElementById('main-content').innerHTML.length > 0 && !mainContentArea.innerHTML.includes('<h1')) {
            updateContent(welcomeTitle, mainContentArea.innerHTML);
        }
        setTimeout(updateThemeIcon, 100); 
    };

    // 🟢 REAL BACKEND AUTHENTICATION
    const apiAuth = async (action, payload) => {
        if(authMessage) authMessage.textContent = '';
        const endpoint = action === 'register' ? '/api/auth/register' : '/api/auth/login';
        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.message || 'Authentication failed');
            return data.user; 
        } catch (error) {
            console.error("Auth Error:", error);
            throw error;
        }
    };

    const loadModule = async (name, target) => {
        if (MODULE_CACHE[name]) { target.innerHTML = MODULE_CACHE[name]; return; }
        try {
            const res = await fetch(`${name}.html`);
            if (!res.ok) throw new Error(`Error loading ${name}`);
            const html = await res.text();
            MODULE_CACHE[name] = html;
            target.innerHTML = html;
        } catch (e) { target.innerHTML = `<p class="text-red-500">Error: ${e.message}</p>`; }
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
        await loadModule(dashModule, sidebarPlaceholder);

        if (user.role === 'trainer') {
            await loadModule('notifications_content', mainContentArea);
            updateDashboard('Actividad Reciente', user.name);
        } else {
            await loadModule('client_programas', mainContentArea);
            updateDashboard('Mis Programas', user.name);
        }
        setTimeout(updateThemeIcon, 100); 
    };

    // =============================================================================
    // 5. CLIENT SIDE LOGIC
    // =============================================================================
    window.selectMood = (mood) => {
        const btns = document.querySelectorAll('.mood-btn');
        btns.forEach(b => b.classList.remove('bg-gray-200', 'scale-110'));
        const quoteEl = document.getElementById('mood-quote');
        const quotes = { 'happy': "¡Energía contagiosa!", 'tired': "Baja el peso, mantén la técnica.", 'angry': "Usa esa energía.", 'thrilled': "¡A romper records!", 'stoic': "Disciplina sobre motivación.", 'scared': "El miedo es combustible." };
        if(quoteEl) { quoteEl.textContent = quotes[mood] || ""; quoteEl.classList.remove('opacity-0'); }
    };

    const initCharts = () => {
        const ctxWeight = document.getElementById('weightChart');
        if (!ctxWeight || typeof Chart === 'undefined') return;
        new Chart(ctxWeight, { type: 'line', data: { labels: ['S1', 'S2', 'S3'], datasets: [{ label: 'Peso', data: [190, 188, 186], borderColor: 'blue' }] } });
        const ctxFat = document.getElementById('fatChart');
        if (ctxFat) new Chart(ctxFat, { type: 'line', data: { labels: ['S1', 'S2', 'S3'], datasets: [{ label: '% Grasa', data: [20, 19, 18], borderColor: 'green' }] } });
    };
    
    let isMetricDumbbells = false;
    const renderEquipmentOptions = () => {
        const dbContainer = document.getElementById('dumbbells-container');
        if (dbContainer) {
            dbContainer.innerHTML = '';
            [5, 10, 15, 20, 25, 30].forEach(w => {
                dbContainer.innerHTML += `<label class="p-2 border rounded"><input type="checkbox"> ${w} lbs</label>`;
            });
        }
    };
    const toggleWeightUnit = () => { isMetricDumbbells = !isMetricDumbbells; renderEquipmentOptions(); };

    // =============================================================================
    // 6. TRAINER SIDE LOGIC (PROGRAMS & CLIENTS)
    // =============================================================================

    // --- A. PROGRAM LIST ---
    const renderProgramsList = () => {
        const container = document.getElementById('programs-list-container');
        if (!container) return;
        container.innerHTML = '';
        mockProgramsDb.forEach(prog => {
            const card = document.createElement('div');
            card.className = "program-card bg-white dark:bg-gray-800 p-5 rounded-xl shadow-lg hover:shadow-xl transition duration-300 border-t-4 border-blue-500 cursor-pointer relative group";
            card.dataset.id = prog.id;
            card.innerHTML = `
                <div class="pointer-events-none">
                    <h3 class="font-bold text-lg text-gray-800 dark:text-white">${prog.name}</h3>
                    <span class="text-xs px-2 py-1 bg-gray-100 text-gray-800 rounded-full dark:bg-gray-700 dark:text-gray-300">${prog.tags || 'General'}</span>
                </div>
                <div class="mt-4 text-xs text-gray-500 dark:text-gray-400 pointer-events-none">
                    <span>${prog.weeks.length} Semanas</span> | <span>${prog.clientCount} Clientes</span>
                </div>
            `;
            container.appendChild(card);
        });
    };

    const handleCreateProgram = () => {
        const name = document.getElementById('program-name-input').value.trim();
        if(!name) { alert("Nombre requerido"); return; }
        const newProg = { id: Date.now(), name: name, description: "", weeks: [], clientCount: 0, tags: "Borrador" };
        mockProgramsDb.push(newProg);
        saveData(); 
        document.getElementById('create-program-modal').classList.add('hidden');
        renderProgramsList();
        openProgramBuilder(newProg.id);
    };

    // --- B. PROGRAM BUILDER ---
    const openProgramBuilder = (id) => {
        const prog = mockProgramsDb.find(p => p.id == id);
        if (!prog) return;
        currentProgramId = id;
        document.getElementById('programs-main-view').classList.add('hidden');
        document.getElementById('program-builder-view').classList.remove('hidden');
        document.getElementById('builder-program-name').textContent = prog.name;
        document.getElementById('calendar-container').innerHTML = '';
        currentWeekCount = 0;
        if (prog.weeks.length > 0) prog.weeks.forEach(() => addWeekToCalendar()); 
        else addWeekToCalendar(); 
    };

    const addWeekToCalendar = () => {
        currentWeekCount++;
        const weekDiv = document.createElement('div');
        weekDiv.className = "week-block mb-8";
        weekDiv.innerHTML = `<h4 class="text-xl font-bold text-gray-700 dark:text-gray-300 mb-4 px-2">Semana ${currentWeekCount}</h4><div class="grid grid-cols-1 md:grid-cols-7 gap-4">${Array.from({length: 7}, (_, i) => renderDayCell(i + 1)).join('')}</div>`;
        document.getElementById('calendar-container').appendChild(weekDiv);
    };

    const renderDayCell = (dayNum) => {
        return `<div class="relative bg-white dark:bg-gray-800 h-40 rounded-xl shadow border border-gray-100 dark:border-gray-700 group overflow-hidden hover:shadow-lg transition">
            <div class="p-3 h-full flex flex-col justify-between"><span class="text-xs font-bold text-gray-400">Día ${dayNum}</span><div class="text-center text-gray-300 dark:text-gray-600"><i class="fas fa-plus text-2xl"></i></div><div></div></div>
            <div class="absolute inset-0 bg-white/95 dark:bg-gray-800/95 backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity flex flex-col cursor-pointer z-10">
                <div class="flex-1 flex border-b border-gray-200 dark:border-gray-600">
                    <div class="action-add flex-1 flex flex-col items-center justify-center hover:bg-blue-50 dark:hover:bg-gray-700 text-blue-600 transition border-r border-gray-200 dark:border-gray-600" data-day="${dayNum}"><i class="fas fa-dumbbell"></i><span class="text-[10px] font-bold">Añadir</span></div>
                    <div class="action-rest flex-1 flex flex-col items-center justify-center hover:bg-green-50 dark:hover:bg-gray-700 text-green-600 transition"><i class="fas fa-bed"></i><span class="text-[10px] font-bold">Descanso</span></div>
                </div>
                <div class="flex-1 flex">
                    <div class="action-nutri flex-1 flex flex-col items-center justify-center hover:bg-orange-50 dark:hover:bg-gray-700 text-orange-500 border-r border-gray-200 dark:border-gray-600"><i class="fas fa-apple-alt"></i><span class="text-[10px] font-bold">Nutrición</span></div>
                    <div class="action-paste flex-1 flex flex-col items-center justify-center hover:bg-purple-50 dark:hover:bg-gray-700 text-purple-600 transition"><i class="fas fa-paste"></i><span class="text-[10px] font-bold">Pegar</span></div>
                </div>
            </div>
        </div>`;
    };

    // --- C. EXERCISE MODAL ---
    const openExerciseBuilder = (dayNum) => {
        document.getElementById('edit-routine-modal').classList.remove('hidden');
        document.getElementById('exercise-list').innerHTML = ''; 
        document.getElementById('routine-name-input').value = `Entrenamiento Día ${dayNum}`;
        exerciseCount = 0;
        addExerciseToBuilder(); 
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
                        <input type="text" list="exercise-suggestions" class="exercise-name-input w-full p-3 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg dark:text-white font-semibold focus:ring-2 focus:ring-blue-500 outline-none" placeholder="Nombre" value="${data ? data.name : ''}">
                        <button class="p-3 bg-gray-100 dark:bg-gray-800 text-gray-400 hover:text-blue-500 rounded-lg border border-gray-200 dark:border-gray-600 transition open-video-modal"><i class="fas fa-video"></i></button>
                    </div>
                    <textarea class="exercise-stats-input w-full p-3 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg dark:text-white text-sm resize-none focus:border-blue-500 outline-none" rows="3" placeholder="Sets...">${data ? data.stats : ''}</textarea>
                </div>
            </div>`;
        list.appendChild(item);
    };

    const openVideoModal = (btn) => {
        currentVideoExerciseBtn = btn;
        const currentUrl = btn.dataset.video || "";
        document.getElementById('video-url-input').value = currentUrl;
        document.getElementById('video-upload-modal').classList.remove('hidden');
    };

    const saveVideo = () => {
        const url = document.getElementById('video-url-input').value;
        const title = document.getElementById('video-modal-title').textContent;
        if(currentVideoExerciseBtn && url) {
            currentVideoExerciseBtn.dataset.video = url;
            currentVideoExerciseBtn.querySelector('i').classList.add('text-blue-500');
            const exists = mockVideoLibrary.some(v => v.url === url);
            if (!exists) { mockVideoLibrary.push({ id: Date.now(), name: title, url: url }); saveData(); }
        }
        document.getElementById('video-upload-modal').classList.add('hidden');
    };

    const saveRoutine = () => {
        const name = document.getElementById('routine-name-input').value;
        const warmup = document.getElementById('routine-warmup').value;
        const cooldown = document.getElementById('routine-cooldown').value;
        const exercises = [];
        document.querySelectorAll('.exercise-item').forEach(item => {
            const nameInput = item.querySelector('.exercise-name-input');
            const statsInput = item.querySelector('.exercise-stats-input');
            const videoBtn = item.querySelector('.open-video-modal');
            exercises.push({
                name: nameInput.value,
                stats: statsInput.value,
                video: videoBtn.dataset.video || ""
            });
        });

        const prog = mockProgramsDb.find(p => p.id == currentProgramId);
        if (!prog.weeks[currentEditingWeekIndex].days[currentEditingDay]) prog.weeks[currentEditingWeekIndex].days[currentEditingDay] = {};
        const dayData = prog.weeks[currentEditingWeekIndex].days[currentEditingDay];
        dayData.name = name; dayData.warmup = warmup; dayData.cooldown = cooldown; dayData.exercises = exercises; dayData.isRest = false;

        saveData(); 
        document.getElementById('edit-routine-modal').classList.add('hidden');
        document.getElementById('calendar-container').innerHTML = '';
        currentWeekCount = 0;
        prog.weeks.forEach((_, idx) => addWeekToCalendar(idx));
    };

    const renderPaymentsView = () => {
        const tbody = document.getElementById('payments-table-body');
        if (!tbody) return;
        
        const totalPaid = mockClientsDb.filter(c => c.isActive).length;
        const totalUnpaid = mockClientsDb.filter(c => !c.isActive).length;
        
        const countPaidEl = document.getElementById('count-paid');
        const countUnpaidEl = document.getElementById('count-unpaid');
        
        if(countPaidEl) countPaidEl.textContent = totalPaid;
        if(countUnpaidEl) countUnpaidEl.textContent = totalUnpaid;

        tbody.innerHTML = '';
        mockClientsDb.forEach(client => {
            const tr = document.createElement('tr');
            tr.className = "hover:bg-gray-50 dark:hover:bg-gray-700 transition";
            const statusBadge = client.isActive 
                ? `<span class="px-3 py-1 inline-flex text-xs leading-5 font-semibold rounded-full bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"><i class="fas fa-check mr-1"></i> Al día</span>`
                : `<span class="px-3 py-1 inline-flex text-xs leading-5 font-semibold rounded-full bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"><i class="fas fa-exclamation-triangle mr-1"></i> Pendiente</span>`;

            const waMessage = `Hola ${client.name}, recordatorio amable de que tu mensualidad de FitbySuarez vence el ${client.dueDate}.`;
            const waLink = `https://wa.me/?text=${encodeURIComponent(waMessage)}`;

            tr.innerHTML = `
                <td class="p-4 whitespace-nowrap text-sm font-bold text-gray-900 dark:text-gray-100">${client.name} ${client.lastName}</td>
                <td class="p-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">${client.dueDate || 'N/A'}</td>
                <td class="p-4 whitespace-nowrap text-center">${statusBadge}</td>
                <td class="p-4 whitespace-nowrap text-right text-sm font-medium">
                    <a href="${waLink}" target="_blank" class="text-green-600 hover:text-green-900 dark:text-green-400 dark:hover:text-green-300 font-bold flex items-center justify-end gap-2">
                        <i class="fab fa-whatsapp text-lg"></i> <span class="hidden md:inline">Notificar</span>
                    </a>
                </td>`;
            tbody.appendChild(tr);
        });
    };

    // =============================================================================
    // 7. CLIENT MANAGEMENT & CALENDAR (UPDATED)
    // =============================================================================

    const openClientProfile = (clientId) => {
        const client = mockClientsDb.find(c => c.id == clientId);
        if (!client) return;

        // Header Structure
        updateContent(`Perfil: ${client.name} ${client.lastName}`, `
            <div class="space-y-6">
                <div class="flex justify-between items-center bg-gray-50 dark:bg-gray-700 p-4 rounded-lg border border-gray-200 dark:border-gray-600">
                    <div class="flex items-center gap-4">
                        <div class="w-12 h-12 rounded-full bg-blue-600 text-white flex items-center justify-center font-bold text-xl">${client.name.charAt(0)}</div>
                        <div>
                            <h3 class="font-bold text-gray-800 dark:text-white">${client.name} ${client.lastName}</h3>
                            <p class="text-sm text-gray-500 dark:text-gray-300">${client.type} | ${client.program || 'Sin Programa'}</p>
                        </div>
                    </div>
                    <button id="back-to-clients-btn" class="text-sm bg-white dark:bg-gray-600 hover:bg-gray-100 border border-gray-300 dark:border-gray-500 px-4 py-2 rounded-lg transition">
                        <i class="fas fa-arrow-left mr-2"></i> Volver
                    </button>
                </div>
                
                <div id="client-detail-container" class="space-y-4"></div>
            </div>
        `);

        const container = document.getElementById('client-detail-container');
        const assignedProgram = mockProgramsDb.find(p => p.name === client.program);

        // Logic Switch: Filled Calendar vs Empty Calendar
        if (assignedProgram && assignedProgram.weeks.length > 0) {
            renderClientProgramView(container, assignedProgram); 
        } else {
            renderClientEmptyCalendar(container); 
        }
    };

    // View A: Client has a Program (Image 1 & 2 Style)
    const renderClientProgramView = (container, program) => {
        let dayCounter = 1;
        
        program.weeks.forEach(week => {
            if(!week.days) return;
            
            // Sort days to ensure order (Day 1, Day 2...)
            Object.keys(week.days).sort((a,b) => a-b).forEach(dKey => {
                const day = week.days[dKey];
                
                // Skip basic rest days if hidden, or show them if desired. 
                // For TrueCoach style, we usually show everything.
                
                const html = `
                <div class="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden bg-white dark:bg-gray-800 shadow-sm mb-4 transition-all">
                    
                    <button onclick="this.nextElementSibling.classList.toggle('hidden'); this.querySelector('.chevron').classList.toggle('rotate-180')" class="w-full flex justify-between items-center p-4 bg-gray-50 dark:bg-gray-750 hover:bg-gray-100 dark:hover:bg-gray-700 transition cursor-pointer">
                        <div class="flex items-center gap-3">
                            <div class="w-8 h-8 rounded bg-white border border-gray-200 dark:bg-gray-700 dark:border-gray-600 flex items-center justify-center">
                                <span class="font-bold text-sm text-gray-500 dark:text-gray-300">${dayCounter}</span>
                            </div>
                            <div class="text-left">
                                <h4 class="font-bold text-gray-800 dark:text-white text-lg">${day.name || 'Entrenamiento'}</h4>
                            </div>
                        </div>
                        <i class="fas fa-chevron-down chevron transition-transform text-gray-400"></i>
                    </button>

                    <div class="hidden p-6 border-t border-gray-100 dark:border-gray-700 space-y-6 bg-white dark:bg-gray-800">
                        
                        ${day.warmup ? `<p class="text-sm text-gray-500 italic">Calentamiento: ${day.warmup}</p>` : ''}
                        
                        <div class="space-y-4">
                            ${day.exercises.map((ex, index) => {
                                const letter = "ABCDEFGH"[index] || "-";
                                return `
                                <div class="flex items-start gap-4">
                                    <div class="mt-1 w-6 h-6 rounded-full bg-gray-100 dark:bg-gray-700 flex items-center justify-center text-xs font-bold text-gray-500">${letter}</div>
                                    <div>
                                        <p class="font-bold text-gray-800 dark:text-gray-100 text-base">${ex.name}</p>
                                        <p class="text-sm text-gray-500 dark:text-gray-400">${ex.stats}</p>
                                    </div>
                                </div>`;
                            }).join('')}
                        </div>

                        <p class="text-xs text-gray-400 mt-4 border-t border-gray-100 dark:border-gray-700 pt-2">
                            Camina 30 minutos después de entrenar. Puede ser en cualquier momento del día.
                        </p>
                    </div>
                </div>`;
                
                container.innerHTML += html;
                dayCounter++;
            });
        });
    };

    // View B: Client has NO Program (Image 3 Style - Empty Grid with Actions)
    const renderClientEmptyCalendar = (container) => {
        const today = new Date();
        // Generate next 7 days dynamically
        const daysOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

        for (let i = 0; i < 7; i++) {
            const date = new Date(); 
            date.setDate(today.getDate() + i);
            
            const dayName = daysOfWeek[date.getDay()];
            const monthName = months[date.getMonth()];
            const dayNum = date.getDate();
            const dateStr = `${dayName}, ${monthName} ${dayNum}`;

            container.innerHTML += `
            <div class="mb-4 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
                <div class="p-3 border-b border-gray-200 dark:border-gray-700 flex items-center gap-2">
                    <i class="far fa-bookmark text-gray-400"></i>
                    <span class="font-bold text-gray-700 dark:text-gray-300">${dateStr}</span>
                </div>

                <div class="flex items-center justify-around p-4">
                    
                    <button class="w-10 h-10 rounded hover:bg-gray-200 dark:hover:bg-gray-700 flex items-center justify-center transition group relative" title="Añadir Entrenamiento">
                        <i class="fas fa-dumbbell text-xl text-gray-400 dark:text-gray-500 group-hover:text-blue-500"></i>
                        <span class="absolute -top-8 left-1/2 transform -translate-x-1/2 bg-black text-white text-xs py-1 px-2 rounded opacity-0 group-hover:opacity-100 transition pointer-events-none">Workout</span>
                    </button>

                    <button class="w-10 h-10 rounded hover:bg-gray-200 dark:hover:bg-gray-700 flex items-center justify-center transition group relative" title="Día de Descanso">
                        <i class="fas fa-battery-full text-xl text-gray-400 dark:text-gray-500 group-hover:text-green-500"></i>
                        <span class="absolute -top-8 left-1/2 transform -translate-x-1/2 bg-black text-white text-xs py-1 px-2 rounded opacity-0 group-hover:opacity-100 transition pointer-events-none">Rest</span>
                    </button>

                    <button class="w-10 h-10 rounded hover:bg-gray-200 dark:hover:bg-gray-700 flex items-center justify-center transition group relative" title="Nutrición (Próximamente)">
                        <i class="fas fa-apple-alt text-xl text-gray-400 dark:text-gray-500 group-hover:text-red-500"></i>
                        <span class="absolute -top-8 left-1/2 transform -translate-x-1/2 bg-black text-white text-xs py-1 px-2 rounded opacity-0 group-hover:opacity-100 transition pointer-events-none">Nutrition</span>
                    </button>

                    <button class="w-10 h-10 rounded hover:bg-gray-200 dark:hover:bg-gray-700 flex items-center justify-center transition group relative" title="Pegar">
                        <i class="fas fa-paste text-xl text-gray-400 dark:text-gray-500 group-hover:text-purple-500"></i>
                        <span class="absolute -top-8 left-1/2 transform -translate-x-1/2 bg-black text-white text-xs py-1 px-2 rounded opacity-0 group-hover:opacity-100 transition pointer-events-none">Paste</span>
                    </button>

                    <button class="w-10 h-10 rounded hover:bg-gray-200 dark:hover:bg-gray-700 flex items-center justify-center transition group relative" title="Asignar Programa">
                        <i class="fas fa-calendar-plus text-xl text-gray-400 dark:text-gray-500 group-hover:text-blue-500"></i>
                        <span class="absolute -top-8 left-1/2 transform -translate-x-1/2 bg-black text-white text-xs py-1 px-2 rounded opacity-0 group-hover:opacity-100 transition pointer-events-none">Assign</span>
                    </button>

                </div>
            </div>`;
        }
    };

    // =============================================================================
    // 8. EVENT DELEGATION
    // =============================================================================
    
    document.addEventListener('click', async (e) => {
        const target = e.target.closest('a, button, [id], .program-card, .open-video-modal, .client-row, .action-add');
        if (!target) return;

        // --- GLOBAL ---
        if (target.id === 'trigger-upload-btn') { document.getElementById('hidden-video-file').click(); return; }
        if (target.id === 'save-video-btn') { saveVideo(); return; }
        if (target.id === 'cancel-video-btn') { document.getElementById('video-upload-modal').classList.add('hidden'); return; }
        if (target.classList.contains('open-video-modal')) { openVideoModal(target.closest('button')); return; }

        // 🟢 CLIENT ROW CLICK -> Opens New Calendar UI
        if (target.classList.contains('client-row')) {
            if (e.target.closest('button')) return; 
            openClientProfile(target.getAttribute('data-id'));
            return;
        }

        // 🟢 BACK BUTTON
        if (target.id === 'back-to-clients-btn') {
            renderClientsTable(); 
            updateContent('Gestión de Clientes', document.getElementById('main-content').innerHTML);
            return;
        }

        if (target.tagName === 'A' || target.tagName === 'BUTTON') {
             if(target.getAttribute('href') === '#') e.preventDefault();
        }

        // 1. Sidebar
        if (target.id === 'collapse-btn') {
            const sidebar = document.getElementById('sidebar');
            if(sidebar) { sidebar.classList.toggle('w-60'); sidebar.classList.toggle('w-20'); }
            document.querySelectorAll('.nav-text').forEach(el => el.classList.toggle('hidden'));
            return;
        }

        // 2. Global
        if (target.id === 'logout-btn') { localStorage.removeItem('auth_user'); location.reload(); return; }
        if (target.id === 'theme-toggle') { 
            const isDark = document.documentElement.classList.toggle('dark');
            localStorage.setItem('theme', isDark ? 'dark' : 'light');
            updateThemeIcon();
            return; 
        }

        // 3. Navigation
        const navLink = target.closest('.nav-link-item');
        if (navLink) {
            e.preventDefault();
            const linkText = navLink.querySelector('.nav-text').textContent.trim();
            let moduleToLoad = null;

            // Trainer Nav
            if (linkText.includes('Notificaciones')) moduleToLoad = 'notifications_content';
            else if (linkText === 'Clientes') moduleToLoad = 'clientes_content';
            else if (linkText === 'Programas') moduleToLoad = 'programas_content';
            else if (linkText === 'Ajustes') moduleToLoad = 'ajustes_content';
            else if (linkText === 'Pagos') moduleToLoad = 'pagos_content';
            
            // Client Nav
            else if (linkText.includes('Mis Programas')) moduleToLoad = 'client_programas';
            else if (linkText.includes('Métricas')) moduleToLoad = 'client_metricas';
            else if (linkText.includes('Nutrición')) moduleToLoad = 'client_nutricion';
            else if (linkText.includes('Equipo')) moduleToLoad = 'client_equipo';
            else if (linkText.includes('Fotos Progreso')) moduleToLoad = 'client_progress';
            
            if (moduleToLoad) {
                try {
                    const res = await fetch(`${moduleToLoad}.html`);
                    if(res.ok) {
                        const html = await res.text();
                        updateContent(linkText, html);
                        
                        if (moduleToLoad === 'clientes_content') renderClientsTable();
                        if (moduleToLoad === 'programas_content') renderProgramsList(); 
                        if (moduleToLoad === 'ajustes_content') renderSettings();
                        if (moduleToLoad === 'pagos_content') renderPaymentsView(); 
                        if (moduleToLoad === 'client_metricas') initCharts();
                        if (moduleToLoad === 'client_equipo') renderEquipmentOptions();
                    }
                } catch(e) { console.error(e); }
            }
            return;
        }

        // 4. Modals
        if (target.id === 'open-add-client-modal') { document.getElementById('add-client-modal').classList.remove('hidden'); return; }
        if (target.id === 'save-new-client-btn') { handleSaveClient(); return; }
        if (target.id === 'close-add-client-modal' || target.id === 'cancel-add-client') { document.getElementById('add-client-modal').classList.add('hidden'); return; }

        // 5. Program Builder
        if (target.classList.contains('program-card')) { openProgramBuilder(target.dataset.id); return; }
        if (target.id === 'open-create-program-modal') { document.getElementById('create-program-modal').classList.remove('hidden'); return; }
        if (target.id === 'save-and-add-workouts') { handleCreateProgram(); return; }
        if (target.id === 'cancel-create-program') { document.getElementById('create-program-modal').classList.add('hidden'); return; }
        if (target.id === 'back-to-program-list') { document.getElementById('program-builder-view').classList.add('hidden'); document.getElementById('programs-main-view').classList.remove('hidden'); return; }
        if (target.id === 'add-week-btn') { addWeekToCalendar(); return; }
        if (target.classList.contains('action-add')) { openExerciseBuilder(target.closest('.relative').querySelector('span').innerText.replace('Día ', '')); return; }
        if (target.id === 'cancel-routine-edit' || target.id === 'cancel-routine-btn-footer') { document.getElementById('edit-routine-modal').classList.add('hidden'); return; }
        if (target.id === 'add-exercise-btn') { addExerciseToBuilder(); return; }
        if (target.id === 'save-routine-btn') { saveRoutine(); return; }
    });

    // =============================================================================
    // 9. INITIALIZATION & AUTH HANDLERS
    // =============================================================================
    
    // Auth Toggle (Sign Up / Sign In)
    if(authToggleBtn) {
        authToggleBtn.addEventListener('click', () => {
            isSigningUp = !isSigningUp;
            authTitle.textContent = isSigningUp ? 'Sign Up' : 'Sign In';
            authSubmitBtn.textContent = isSigningUp ? 'Create Account' : 'Sign In';
            authToggleBtn.textContent = isSigningUp ? 'Already have an account? Sign In' : 'Need an account? Sign Up';
            if(authNameInput) authNameInput.classList.toggle('hidden');
            if(authMessage) authMessage.textContent = '';
        });
    }

    // Auth Submit (Real Backend)
    if(authSubmitBtn) {
        authSubmitBtn.disabled = false;
        authSubmitBtn.classList.remove('cursor-not-allowed', 'opacity-50');
        
        authSubmitBtn.onclick = async (e) => { 
            e.preventDefault(); 
            const email = authEmailInput.value;
            const password = authPasswordInput.value;
            const name = authNameInput.value;
            
            const originalText = authSubmitBtn.textContent;
            authSubmitBtn.textContent = 'Verifying...';
            
            try {
                const action = isSigningUp ? 'register' : 'login';
                const payload = isSigningUp 
                    ? { name, email, password } 
                    : { email, password };
                
                const user = await apiAuth(action, payload);
                saveSession(user); 
                router(user);
            } catch (err) {
                authSubmitBtn.textContent = originalText;
                if(authMessage) authMessage.textContent = err.message;
            }
        };
    }

    applyThemePreferenceEarly();
    injectGlobalStyles();
    loadData(); 
    const user = loadSession(); 
    router(user);
});