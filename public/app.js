document.addEventListener('DOMContentLoaded', () => {

    // =============================================================================
    // 1. CONFIGURATION & STATE
    // =============================================================================
    
    const authScreen = document.getElementById('auth-screen');
    const dashboardContainer = document.getElementById('dashboard-container');
    const sidebarPlaceholder = document.getElementById('sidebar-placeholder');
    const mainContentArea = document.getElementById('main-content');
    const authMessage = document.getElementById('auth-message');

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
    let copiedWorkoutData = null; 

    // 🟢 NEW: Workout Editor State
    let editorExercises = []; 
    let editorDateStr = "";

    // 🟢 MUSCLE GROUPS
    const muscleGroups = [
        "Pecho", "Espalda", "Piernas", "Quadriceps", "Femorales", "Tibiales", 
        "Pantorrillas", "Glúteos", "Triceps", "Biceps", "Hombros", "Antebrazos", 
        "Empuje", "Halón", "Abdomen", "Espalda Baja", "Calentamientos", "Cardio"
    ];

    // =============================================================================
    // 2. PERSISTENCE & SESSION
    // =============================================================================

    const saveData = () => {
        localStorage.setItem('fitbysuarez_programs', JSON.stringify(mockProgramsDb));
        localStorage.setItem('fitbysuarez_groups', JSON.stringify(mockGroupsDb));
    };

    const loadData = () => {
        const p = localStorage.getItem('fitbysuarez_programs');
        if(p) mockProgramsDb = JSON.parse(p);
        
        const g = localStorage.getItem('fitbysuarez_groups');
        if(g) mockGroupsDb = JSON.parse(g);

        fetchLibraryFromDB(); 
        fetchClientsFromDB(); 
    };

    const fetchClientsFromDB = async () => {
        try {
            const res = await fetch('/api/clients');
            if(res.ok) {
                mockClientsDb = await res.json();
                console.log("✅ Clients loaded:", mockClientsDb.length);
                if(typeof window.renderClientsTable === 'function') {
                    window.renderClientsTable();
                }
            }
        } catch(e) { console.error("Error cargando clientes:", e); }
    };

    const fetchLibraryFromDB = async () => {
        try {
            const res = await fetch('/api/library');
            if(res.ok) globalExerciseLibrary = await res.json();
        } catch(e) { console.error("Error cargando librería:", e); }
    };

    const loadSession = () => { try { return JSON.parse(localStorage.getItem('auth_user')); } catch (e) { return null; } };

    // =============================================================================
    // 3. THEME LOGIC
    // =============================================================================

    const updateThemeIcon = () => {
        const btns = document.querySelectorAll('#theme-toggle');
        const isDark = document.documentElement.classList.contains('dark');
        btns.forEach(btn => {
            // 🟢 Fix: We set the innerHTML dynamically to avoid the double text glitch
            if (isDark) {
                btn.innerHTML = `<i class="fas fa-moon text-gray-400 text-xl w-6 text-center"></i><span class="nav-text ml-3 font-medium group-[.w-20]:hidden">Modo oscuro</span>`;
            } else {
                btn.innerHTML = `<i class="fas fa-sun text-yellow-500 text-xl w-6 text-center"></i><span class="nav-text ml-3 font-medium group-[.w-20]:hidden">Modo claro</span>`;
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
            
            /* 🟢 NEW STYLES: Cleaner Calendar Menu */
            .category-pill { cursor: pointer; border: 1px solid rgba(255,255,255,0.2); transition: all 0.2s; }
            .category-pill:hover { background: rgba(255,255,255,0.1); }
            .category-pill.selected { background: #5e2d91; border-color: #ffde00; color: white; }
            
            .day-cell-menu { display: none; }
            .day-cell:hover .day-cell-menu { display: flex; }
            
            /* Transparent default, visible on hover */
            .cal-action-btn { 
                transition: all 0.2s; 
                padding: 12px; 
                border-radius: 50%; /* Circle */
                background: transparent; 
                color: rgba(255,255,255,0.7);
            }
            .cal-action-btn:hover { 
                transform: scale(1.1); 
                background: rgba(0,0,0,0.8); /* Dark background only on hover */
                color: white; 
                box-shadow: 0 4px 6px rgba(0,0,0,0.3);
            }
            
            .editor-expanded { max-width: 900px !important; }
            .slide-in-right { animation: slideIn 0.3s ease-out forwards; }
            @keyframes slideIn { from { transform: translateX(100%); } to { transform: translateX(0); } }
        `;
        document.head.appendChild(style);
    };

    const updateContent = (title, contentHtml) => {
        if(contentHtml.includes('id="clock-module-root"')) {
            mainContentArea.innerHTML = contentHtml;
            return;
        }
        // 🟢 Remove padding for calendar view to allow full edge-to-edge scrolling
        const isCalendar = contentHtml.includes('client-calendar-grid');
        const paddingClass = isCalendar ? 'p-0' : 'p-14'; 
        const titleClass = (isCalendar || !title) ? 'hidden' : 'text-4xl font-bold text-gray-800 dark:text-gray-100 mb-6 border-b border-gray-200 dark:border-gray-700 pb-3 flex-shrink-0';
        const bgClass = isCalendar ? 'bg-gray-50 dark:bg-gray-900' : 'bg-white dark:bg-gray-800 rounded-xl shadow-lg';

        mainContentArea.innerHTML = `
        <div class="${paddingClass} ${bgClass} h-full flex flex-col relative overflow-hidden">
            <h1 class="${titleClass}">${title}</h1>
            <div class="flex-grow overflow-auto pr-2 relative h-full">${contentHtml}</div>
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
        } else {
            const progHtml = await loadModule('client_programas');
            updateContent('Mis Programas', progHtml);
            updateDashboard('Mis Programas', user.name);
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
                        const res = await fetch('/api/auth/update-password', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ userId: user.id, newPassword: newPw })
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
    // 5. CLIENT & TRAINER LOGIC (PERSISTENT CLIENTS)
    // =============================================================================

    const populateTimezones = () => {
        const select = document.getElementById('opt-timezone');
        if (!select || select.options.length > 0) return; 
        try {
            const timezones = Intl.supportedValuesOf('timeZone');
            const userTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
            timezones.forEach(tz => {
                const option = document.createElement('option');
                option.value = tz;
                option.textContent = tz.replace(/_/g, " "); 
                option.className = "bg-gray-900";
                if(tz === userTz) option.selected = true;
                select.appendChild(option);
            });
        } catch(e) {
            select.innerHTML = '<option value="America/New_York" class="bg-gray-900">America/New York</option>';
        }
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

    // 🟢 1. DEFINE openClientProfile BEFORE it is called
    window.openClientProfile = (clientId) => {
        console.log("👇 CLICKED ID:", clientId);
        const client = mockClientsDb.find(c => (c._id == clientId) || (c.id == clientId));
        if (!client) { console.error("❌ Client NOT found"); return; }
        currentClientViewId = clientId;

        // 🟢 TRUECOACH STYLE CONTINUOUS CALENDAR
        updateContent(`Perfil: ${client.name} ${client.lastName}`, `
            <div id="client-calendar-grid" class="flex flex-col h-full bg-gray-50 dark:bg-gray-900 overflow-hidden">
                <div class="flex items-center justify-between p-4 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 shadow-sm z-10">
                    <div class="flex items-center gap-4">
                        <button id="back-to-clients-btn" class="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-white"><i class="fas fa-arrow-left text-xl"></i></button>
                        <h2 class="text-2xl font-bold text-gray-800 dark:text-white">${client.name} ${client.lastName}</h2>
                    </div>
                    <div class="flex items-center gap-2">
                        <button class="px-3 py-1 text-sm font-semibold bg-gray-100 dark:bg-gray-700 rounded hover:bg-gray-200 dark:hover:bg-gray-600 dark:text-white transition" onclick="document.querySelector('.is-today')?.scrollIntoView({block:'center', behavior:'smooth'})">Hoy</button>
                    </div>
                </div>
                <div class="grid grid-cols-7 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 shadow-sm z-10 shrink-0">
                    ${['LUN','MAR','MIÉ','JUE','VIE','SÁB','DOM'].map(d => `<div class="py-3 text-center text-xs font-bold text-gray-400 dark:text-gray-500 tracking-wider">${d}</div>`).join('')}
                </div>
                <div id="infinite-calendar-scroll" class="flex-grow overflow-y-auto overflow-x-hidden relative bg-gray-100 dark:bg-gray-900 pb-20">
                    <div id="calendar-grid-container" class="grid grid-cols-7 auto-rows-min gap-px bg-gray-200 dark:bg-gray-700 border-b border-gray-200 dark:border-gray-700">
                        ${generateContinuousCalendar(client)}
                    </div>
                </div>
                <div id="workout-editor-modal" class="hidden absolute inset-0 z-50 flex justify-end bg-black/20 backdrop-blur-[1px]"></div>
            </div>
        `);
        setTimeout(() => {
            const todayCell = document.querySelector('.is-today');
            if(todayCell) todayCell.scrollIntoView({ block: "center", behavior: "auto" });
        }, 100);
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
                toggle.classList.remove('bg-gray-600'); toggle.classList.add('bg-green-500');
                thumb.classList.add('translate-x-6'); thumb.classList.remove('translate-x-0');
            } else {
                toggle.classList.add('bg-gray-600'); toggle.classList.remove('bg-green-500');
                thumb.classList.remove('translate-x-6'); thumb.classList.add('translate-x-0');
            }
        };

        setToggle(0, client.emailPreferences?.dailyRoutine);
        setToggle(1, client.emailPreferences?.incompleteRoutine);
        setToggle(2, client.hideFromDashboard);
    };

    window.deleteClient = async (id) => {
        if(!confirm("¿Estás seguro de que deseas eliminar este cliente? Se moverá a la papelera.")) return;
        try {
            const res = await fetch(`/api/clients/${id}`, { method: 'DELETE' });
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

        const payload = {
            name: firstName, lastName: lastName || "", email: email, type: type, program: program, group: group,
            location, timezone, unitSystem, 
            height: { feet: heightFt, inches: heightIn }, 
            weight: weight, 
            birthday, gender, phone,
            hideFromDashboard: hideDash,
            emailPreferences: { dailyRoutine: sendDaily, incompleteRoutine: sendIncomplete },
            isFirstLogin: true, isActive: true, dueDate: "2026-02-21"
        };

        try {
            let res;
            if (currentClientViewId) {
                res = await fetch(`/api/clients/${currentClientViewId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            } else {
                res = await fetch('/api/clients', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            }

            if (res.ok) {
                const savedClient = await res.json();
                if (currentClientViewId) {
                    const idx = mockClientsDb.findIndex(c => c._id === currentClientViewId);
                    if (idx > -1) mockClientsDb[idx] = savedClient;
                    alert("Cliente actualizado exitosamente.");
                } else {
                    mockClientsDb.unshift(savedClient); 
                    try {
                        await fetch('/api/send-welcome', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email, name: firstName, password: "123" }) });
                        alert(`Cliente creado y correo enviado a ${email}.`);
                    } catch (err) { alert("Cliente creado, error enviando correo."); }
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

    // 🟢 RENDER CLIENTS TABLE
    window.renderClientsTable = () => {
        const tbody = document.getElementById('clients-table-body');
        if(!tbody) return;
        tbody.innerHTML = '';
        if(mockClientsDb.length === 0) { tbody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-gray-500">No hay clientes aún.</td></tr>`; return; }

        mockClientsDb.forEach(client => {
            const tr = document.createElement('tr');
            tr.className = "hover:bg-gray-50 dark:hover:bg-gray-700 transition cursor-pointer client-row";
            tr.setAttribute('data-id', client._id); 
            // 🟢 CLICK LISTENER FOR ROW
            tr.onclick = (e) => {
                if(!e.target.closest('button')) {
                    window.openClientProfile(client._id);
                }
            };
            const initials = (client.name.charAt(0) + (client.lastName ? client.lastName.charAt(0) : '')).toUpperCase();
            tr.innerHTML = `
                <td class="p-4 whitespace-nowrap"><div class="flex items-center"><div class="h-10 w-10 rounded-full bg-brand-purple text-white flex items-center justify-center font-bold mr-3">${initials}</div><div class="text-sm font-medium text-gray-900 dark:text-white">${client.name} ${client.lastName || ''}</div></div></td>
                <td class="p-4 whitespace-nowrap text-sm font-bold text-gray-600 dark:text-gray-300"><span class="bg-gray-100 dark:bg-gray-600 px-2 py-1 rounded text-xs">${client.group || 'General'}</span></td>
                <td class="p-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-300">${client.program}</td>
                <td class="p-4 whitespace-nowrap"><span class="px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${client.isActive ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}">${client.isActive ? 'Activo' : 'Inactivo'}</span></td>
                <td class="p-4 whitespace-nowrap text-right text-sm font-medium">
                    <button onclick="window.openEditClientModal('${client._id}'); event.stopPropagation();" class="text-indigo-600 hover:text-indigo-900 dark:text-indigo-400 mr-2"><i class="fas fa-edit"></i></button>
                    <button onclick="window.deleteClient('${client._id}'); event.stopPropagation();" class="text-red-600 hover:text-red-900 dark:text-red-400"><i class="fas fa-trash"></i></button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    };

    // =============================================================================
    // 6. EXERCISE LIBRARY LOGIC
    // =============================================================================

    window.renderExerciseLibrary = () => {
        const listContainer = document.getElementById('exercise-library-list');
        const searchInput = document.getElementById('library-search-input');
        if (!listContainer) return;

        // 🟢 Render Pills
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
                                ${ex.videoUrl ? `<span class="text-blue-400 flex items-center gap-1"><i class="fas fa-video"></i> Video</span>` : ''}
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
            const res = await fetch('/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, videoUrl: url, category: categories }) });
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

    // =============================================================================
    // 7. PROGRAMS, CALENDAR & BUILDER (MODIFIED SECTION)
    // =============================================================================

    const handleCreateProgram = () => { /* ... (Existing Logic) ... */
        const name = document.getElementById('program-name-input').value.trim();
        if(!name) { alert("Nombre requerido"); return; }
        const newProg = { id: Date.now(), name: name, description: "", weeks: [], clientCount: 0, tags: "Borrador" };
        mockProgramsDb.push(newProg);
        saveData(); 
        document.getElementById('create-program-modal').classList.add('hidden');
        renderProgramsList();
        openProgramBuilder(newProg.id);
    };

    const renderProgramsList = () => { /* ... (Existing Logic) ... */
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
                <div class="mt-4 text-xs text-gray-500 dark:text-gray-400 pointer-events-none"><span>${prog.weeks.length} Semanas</span> | <span>${prog.clientCount} Clientes</span></div>`;
            container.appendChild(card);
        });
    };

    const openProgramBuilder = (id) => { /* ... (Existing Logic) ... */
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

    const addWeekToCalendar = () => { /* ... (Existing Logic) ... */
        currentWeekCount++;
        const weekDiv = document.createElement('div');
        weekDiv.className = "week-block mb-8";
        weekDiv.innerHTML = `<h4 class="text-xl font-bold text-gray-700 dark:text-gray-300 mb-4 px-2">Semana ${currentWeekCount}</h4><div class="grid grid-cols-1 md:grid-cols-7 gap-4">${Array.from({length: 7}, (_, i) => renderDayCell(i + 1)).join('')}</div>`;
        document.getElementById('calendar-container').appendChild(weekDiv);
    };

    // Original Render Day Cell (For Program Builder)
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
                            videoBtn.querySelector('i').classList.add('text-blue-500');
                        }
                    });
                    suggestionsBox.appendChild(div);
                });
            }
        });
        document.addEventListener('click', (e) => { if (!item.contains(e.target)) suggestionsBox.classList.add('hidden'); });
    };

    const openVideoModal = (btn) => {
        currentVideoExerciseBtn = btn;
        const currentUrl = btn.dataset.video || "";
        document.getElementById('video-url-input').value = currentUrl;
        document.getElementById('video-upload-modal').classList.remove('hidden');
    };

    const saveVideo = () => {
        const url = document.getElementById('video-url-input').value;
        if(currentVideoExerciseBtn && url) {
            currentVideoExerciseBtn.dataset.video = url;
            currentVideoExerciseBtn.querySelector('i').classList.add('text-blue-500');
        }
        document.getElementById('video-upload-modal').classList.add('hidden');
    };

    const saveRoutine = () => {
        const name = document.getElementById('routine-name-input').value;
        const exercises = [];
        document.querySelectorAll('.exercise-item').forEach(item => {
            const nameInput = item.querySelector('.exercise-name-input');
            const statsInput = item.querySelector('.exercise-stats-input');
            const videoBtn = item.querySelector('.open-video-modal');
            exercises.push({ name: nameInput.value, stats: statsInput.value, video: videoBtn.dataset.video || "" });
        });

        if(currentProgramId) {
            const prog = mockProgramsDb.find(p => p.id == currentProgramId);
            if(prog) {
                if (!prog.weeks[currentEditingWeekIndex].days[currentEditingDay]) prog.weeks[currentEditingWeekIndex].days[currentEditingDay] = {};
                const dayData = prog.weeks[currentEditingWeekIndex].days[currentEditingDay];
                dayData.name = name; dayData.exercises = exercises; dayData.isRest = false;
                saveData(); 
            }
        }
        document.getElementById('edit-routine-modal').classList.add('hidden');
        if(currentClientViewId) openClientProfile(currentClientViewId); 
    };

    const renderPaymentsView = () => { 
        const tbody = document.getElementById('payments-table-body');
        if (!tbody) return;
        const totalPaid = mockClientsDb.filter(c => c.isActive).length;
        const totalUnpaid = mockClientsDb.filter(c => !c.isActive).length;
        document.getElementById('count-paid').textContent = totalPaid;
        document.getElementById('count-unpaid').textContent = totalUnpaid;

        tbody.innerHTML = '';
        mockClientsDb.forEach(client => {
            const tr = document.createElement('tr');
            tr.className = "hover:bg-gray-50 dark:hover:bg-gray-700 transition";
            const statusBadge = client.isActive 
                ? `<span class="px-3 py-1 inline-flex items-center text-xs font-semibold rounded-full bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"><i class="fas fa-check mr-2"></i> Al día</span>`
                : `<span class="px-3 py-1 inline-flex items-center text-xs font-semibold rounded-full bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"><i class="fas fa-exclamation-triangle mr-2"></i> Pendiente</span>`;
            const waLink = `https://wa.me/?text=${encodeURIComponent(`Hola ${client.name}, recordatorio de pago.`)}`;
            tr.innerHTML = `
                <td class="p-4 whitespace-nowrap text-sm font-bold text-gray-900 dark:text-gray-100">${client.name} ${client.lastName || ''}</td>
                <td class="p-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">${client.dueDate || 'N/A'}</td>
                <td class="p-4 whitespace-nowrap text-center">${statusBadge}</td>
                <td class="p-4 whitespace-nowrap text-right text-sm font-medium">
                    <a href="${waLink}" target="_blank" class="text-green-600 hover:text-green-900 dark:text-green-400 dark:hover:text-green-300 font-bold flex items-center justify-end gap-2"><i class="fab fa-whatsapp text-lg"></i> <span class="hidden md:inline">Notificar</span></a>
                </td>`;
            tbody.appendChild(tr);
        });
    };

    // 🟢 HELPER: Generate Continuous Calendar Days (6 Months)
    const generateContinuousCalendar = (client) => {
        let html = '';
        const today = new Date();
        const startDate = new Date(today);
        startDate.setMonth(today.getMonth() - 1);
        startDate.setDate(1); 
        
        const dayOfWeek = startDate.getDay(); 
        const diff = startDate.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1); 
        startDate.setDate(diff);

        const totalDays = 26 * 7; 
        
        for(let i=0; i < totalDays; i++) {
            const currentDate = new Date(startDate);
            currentDate.setDate(startDate.getDate() + i);
            const dayNum = currentDate.getDate();
            const monthName = currentDate.toLocaleString('default', { month: 'short' }).toUpperCase();
            const isToday = currentDate.toDateString() === new Date().toDateString();
            const isFirstOfMonth = dayNum === 1;
            const cellId = `day-${currentDate.toISOString().split('T')[0]}`;
            
            // 🟢 5-BUTTON HOVER MENU
            const hoverMenu = `
                <div class="day-cell-menu absolute inset-0 bg-gray-900/95 flex flex-col items-center justify-center gap-4 opacity-0 group-hover:opacity-100 transition-opacity z-20">
                    <div class="flex gap-6">
                        <button class="cal-action-btn text-white" data-action="add" data-date="${cellId}" title="Añadir"><i class="fas fa-plus text-2xl"></i></button>
                        <button class="cal-action-btn text-white" data-action="rest" data-date="${cellId}" title="Descanso"><i class="fas fa-battery-full text-2xl"></i></button>
                        <button class="cal-action-btn text-white" data-action="nutrition" data-date="${cellId}" title="Nutrición"><i class="fab fa-apple text-2xl"></i></button>
                    </div>
                    <div class="flex gap-6">
                        <button class="cal-action-btn text-white" data-action="paste" data-date="${cellId}" title="Pegar"><i class="fas fa-clipboard text-2xl"></i></button>
                        <button class="cal-action-btn text-white" data-action="program" data-date="${cellId}" title="Programa"><i class="far fa-calendar-plus text-2xl"></i></button>
                    </div>
                </div>
            `;

            const bgClass = isToday ? 'bg-blue-50 dark:bg-gray-800/80 border-t-4 border-blue-500' : 'bg-white dark:bg-gray-800';
            const textClass = isToday ? 'text-blue-600 font-bold' : 'text-gray-500 dark:text-gray-400';
            
            html += `
                <div id="${cellId}" class="day-cell ${bgClass} min-h-[160px] p-2 relative group transition hover:shadow-inner ${isToday ? 'is-today' : ''}">
                    <div class="flex justify-between items-start pointer-events-none">
                        <span class="text-xs font-bold ${textClass}">${dayNum} ${isFirstOfMonth ? monthName : ''}</span>
                    </div>
                    <div class="mt-2 space-y-1 content-area"></div>
                    ${hoverMenu}
                </div>
            `;
        }
        return html;
    };

    // 🟢 CALENDAR ACTIONS HANDLER
    const handleCalendarAction = (action, dateId) => {
        const dateStr = dateId.replace('day-', '');
        if (action === 'add') {
            editorExercises = [{ id: Date.now(), name: "", isSuperset: false }];
            editorDateStr = dateStr;
            openWorkoutEditor(dateStr); 
        } else if (action === 'rest') {
            const cell = document.getElementById(dateId);
            if(cell) {
                const content = cell.querySelector('.content-area');
                const exists = content.querySelector('.rest-badge');
                if(exists) exists.remove();
                else content.insertAdjacentHTML('beforeend', `<div class="rest-badge bg-green-100 text-green-800 text-xs px-2 py-1 rounded text-center font-bold mt-2 border border-green-200">REST DAY</div>`);
            }
        } else {
            alert(`Acción: ${action} para ${dateStr} (Próximamente)`);
        }
    };

    // 🟢 NEW WORKOUT EDITOR UI
    const openWorkoutEditor = (dateStr) => {
        const modal = document.getElementById('workout-editor-modal');
        modal.classList.remove('hidden');
        renderWorkoutEditorUI();
    };

    const renderWorkoutEditorUI = () => {
        const modal = document.getElementById('workout-editor-modal');
        
        // Dynamic Exercise List
        const listHtml = editorExercises.map((ex, index) => {
            const letter = getLetter(index, editorExercises); 
            return `
            <div class="p-6 border-b border-gray-700 bg-[#32323c] relative">
                <div class="flex justify-between items-start mb-2">
                    <div class="flex gap-2 items-center">
                        <input type="checkbox" class="ex-checkbox w-4 h-4 rounded bg-gray-700 border-gray-500" data-id="${ex.id}" ${ex.isSuperset ? 'checked' : ''}>
                        <i class="fas fa-grip-lines text-gray-500 cursor-move hover:text-white" title="Move"></i>
                        <h3 class="text-white font-bold text-lg">${letter})</h3> 
                        <input type="text" value="${ex.name}" class="bg-transparent text-white font-bold ml-1 outline-none w-full" placeholder="Exercise title (required)" oninput="window.updateExName(${ex.id}, this.value)">
                    </div>
                    <i class="fas fa-video text-gray-500 cursor-pointer hover:text-blue-400" onclick="window.openVideoModalForEx(${ex.id})"></i>
                </div>
                <button class="w-full py-2 bg-[#3b4c75] text-[#8faae3] font-bold rounded text-sm hover:bg-[#475a87] transition mb-3 flex items-center justify-center gap-2" onclick="alert('Historial')">
                    <i class="fas fa-history"></i> See History
                </button>
                <textarea class="w-full bg-transparent text-gray-400 text-xs resize-none outline-none" placeholder="Sets, Reps, Tempo, Rest etc."></textarea>
            </div>`;
        }).join('');

        modal.innerHTML = `
            <div id="editor-panel" class="bg-[#2d2d35] w-full max-w-md h-full shadow-2xl flex flex-col border-l border-gray-700 slide-in-right transition-all duration-300">
                <div class="bg-[#ff6b4a] px-4 py-3 flex justify-between items-center text-white shrink-0">
                    <div class="flex items-center gap-2"><span class="text-sm font-bold">Workout has unsaved changes</span></div>
                    <div class="flex gap-3 text-white/90">
                        <button onclick="document.getElementById('editor-panel').classList.toggle('editor-expanded')"><i class="fas fa-expand-alt"></i></button>
                        <button><i class="far fa-file-alt"></i></button>
                        <button onclick="document.getElementById('workout-editor-modal').classList.add('hidden')"><i class="fas fa-times"></i></button>
                    </div>
                </div>
                <div class="flex-grow overflow-y-auto p-0 custom-scrollbar">
                    <div class="p-6 border-b border-gray-700 hover:bg-[#363640] transition group relative">
                        <div class="flex items-center gap-3">
                            <div class="w-6 h-6 bg-white rounded flex-shrink-0"></div>
                            <input type="text" placeholder="Name (optional)" class="bg-transparent text-xl font-bold text-white placeholder-gray-500 w-full outline-none">
                            <i class="fas fa-battery-empty text-gray-500"></i>
                        </div>
                        <p class="text-gray-500 text-sm mt-2 pl-9 cursor-pointer hover:text-gray-300">Add warmup</p>
                    </div>
                    <div id="editor-exercises-list">${listHtml}</div>
                    <div class="flex justify-center gap-2 p-6">
                        <button class="px-3 py-1 border border-gray-500 rounded text-gray-300 text-xs hover:bg-gray-700 transition" onclick="window.addEditorExercise()">+ Exercise</button>
                        <button class="px-3 py-1 border border-gray-500 rounded text-gray-300 text-xs hover:bg-gray-700 transition" onclick="window.createSuperset()">+ Superset</button>
                    </div>
                    <div class="p-6"><p class="text-gray-500 text-sm cursor-pointer hover:text-gray-300">Add cooldown</p></div>
                </div>
                <div class="p-4 border-t border-gray-700 flex gap-4 bg-[#26262c] shrink-0">
                    <button class="px-6 py-2 bg-[#4a6399] text-white font-bold rounded hover:bg-[#5a73a9] transition shadow-lg" onclick="window.saveDayWorkout()">Save</button>
                    <button class="px-4 py-2 text-gray-300 font-bold hover:text-white transition" onclick="document.getElementById('workout-editor-modal').classList.add('hidden')">Cancel</button>
                </div>
            </div>
        `;
    };

    // 🟢 SUPERSET LETTER LOGIC
    const getLetter = (index, arr) => {
        let charCode = 65; // 'A'
        let subIndex = 0;
        let letters = [];
        for(let i=0; i<arr.length; i++) {
            if(i > 0 && arr[i].isSuperset && arr[i-1].isSuperset) {
                subIndex++;
            } else {
                if(i > 0) charCode++;
                subIndex = 1;
            }
            if(arr[i].isSuperset) {
               letters.push(String.fromCharCode(charCode) + subIndex);
            } else {
               letters.push(String.fromCharCode(charCode));
            }
        }
        return letters[index];
    };

    // Editor Actions
    window.addEditorExercise = () => {
        editorExercises.push({ id: Date.now(), name: "", isSuperset: false });
        renderWorkoutEditorUI();
    };

    window.updateExName = (id, val) => {
        const ex = editorExercises.find(e => e.id === id);
        if(ex) ex.name = val;
    };

    window.createSuperset = () => {
        const checkboxes = document.querySelectorAll('.ex-checkbox:checked');
        if(checkboxes.length < 2) return alert("Selecciona al menos 2 ejercicios para crear un Superset.");
        checkboxes.forEach(box => {
            const id = parseInt(box.dataset.id);
            const ex = editorExercises.find(e => e.id === id);
            if(ex) ex.isSuperset = true;
        });
        renderWorkoutEditorUI();
    };

    window.saveDayWorkout = async () => {
        if(!currentClientViewId) return;
        const payload = { clientId: currentClientViewId, date: editorDateStr, programName: "Custom Day", exercises: editorExercises };
        try {
            await fetch('/api/log', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload) });
            const cell = document.getElementById(`day-${editorDateStr}`);
            if(cell) {
                const area = cell.querySelector('.content-area');
                area.innerHTML = `<div class="bg-gray-800 text-white text-[10px] p-1 rounded border-l-2 border-orange-500 mb-1 pl-2">${editorExercises.length} Exercises</div>`;
            }
            document.getElementById('workout-editor-modal').classList.add('hidden');
        } catch(e) { console.error(e); }
    };

    window.openVideoModalForEx = (id) => {
        document.getElementById('video-upload-modal').classList.remove('hidden');
    };

    // 🟢 RENDER SETTINGS (Restored)
    const renderSettings = () => {
        updateContent('Ajustes', `
            <div class="p-8 text-center text-gray-500 dark:text-gray-400">
                <i class="fas fa-cogs text-6xl mb-4 text-gray-300 dark:text-gray-600"></i>
                <p>Configuración en construcción...</p>
            </div>
        `);
    };

    // =============================================================================
    // 8. EVENT DELEGATION
    // =============================================================================
    
    document.addEventListener('click', async (e) => {
        const target = e.target.closest('a, button, [id], .program-card, .open-video-modal, .client-row, .action-add, .pill-option, .toggle-switch, .cal-action-btn');
        if (!target) return;

        // 🟢 THEME TOGGLE (Top Priority)
        if (target.id === 'theme-toggle' || target.closest('#theme-toggle')) { 
            e.preventDefault(); // Stop router from catching it
            const isDark = document.documentElement.classList.toggle('dark');
            localStorage.setItem('theme', isDark ? 'dark' : 'light');
            updateThemeIcon();
            return; 
        }

        // 🟢 LOGOUT (Top Priority)
        if (target.id === 'logout-btn' || target.closest('#logout-btn')) { 
            localStorage.removeItem('auth_user'); 
            location.reload(); 
            return; 
        }

        // 🟢 CALENDAR ACTION BUTTONS
        if (target.classList.contains('cal-action-btn')) {
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
            else if (linkText === 'Inicio' || linkText === document.getElementById('trainer-name')?.textContent.trim()) moduleToLoad = 'trainer_home';
            else if (linkText === 'Clientes') moduleToLoad = 'clientes_content';
            else if (linkText === 'Programas') moduleToLoad = 'library_content'; 
            else if (linkText === 'Ajustes') {
                 moduleToLoad = 'ajustes_content'; // 🟢 FIX: Trigger fetch, not function
            }
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
                        if (moduleToLoad === 'clientes_content') renderClientsTable();
                        if (moduleToLoad === 'library_content') window.renderExerciseLibrary();
                        if (moduleToLoad === 'pagos_content') renderPaymentsView(); 
                        if (moduleToLoad === 'client_metricas') initCharts();
                        if (moduleToLoad === 'client_equipo') renderEquipmentOptions();
                        if (moduleToLoad === 'client_clock') window.initClockModule(); 
                        if (moduleToLoad === 'trainer_home') renderTrainerHome(loadSession().name); 
                        if (moduleToLoad === 'ajustes_content') {
                            // Hook for settings specific JS logic if needed
                            console.log("Settings loaded");
                        }
                    }
                } catch(e) { console.error(e); }
            }
            return;
        }

        // ... (Keep existing Exercise Modal logic, Save Client logic, etc.) ...
        
        if (target.id === 'add-new-exercise-btn') { document.getElementById('add-exercise-modal').classList.remove('hidden'); return; }
        if (target.id === 'close-exercise-modal-x' || target.id === 'cancel-exercise-btn') { document.getElementById('add-exercise-modal').classList.add('hidden'); return; }
        if (target.id === 'save-exercise-db-btn') { window.handleSaveNewExercise(); return; }

        if (target.id === 'save-new-client-btn') { window.handleSaveClient(); return; }
        if (target.id === 'close-add-client-modal' || target.id === 'cancel-add-client') { 
            document.getElementById('add-client-modal').classList.add('hidden'); 
            return; 
        }
        
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
            return; 
        }

        if (target.id === 'open-group-modal') { document.getElementById('add-group-modal').classList.remove('hidden'); return; }
        if (target.id === 'close-group-modal') { document.getElementById('add-group-modal').classList.add('hidden'); return; }
        if (target.id === 'save-group-btn') {
            const groupName = document.getElementById('new-group-name').value.trim();
            if (groupName) {
                mockGroupsDb.push(groupName);
                saveData(); 
                document.getElementById('add-group-modal').classList.add('hidden');
                document.getElementById('new-group-name').value = '';
                alert(`Group "${groupName}" created!`);
            } else { alert("Please enter a group name."); }
            return;
        }

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

        if (target.id === 'logout-btn' || target.closest('#logout-btn')) { localStorage.removeItem('auth_user'); location.reload(); return; }
        if (target.id === 'theme-toggle') { 
            const isDark = document.documentElement.classList.toggle('dark');
            localStorage.setItem('theme', isDark ? 'dark' : 'light');
            updateThemeIcon();
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
                updateContent('Clientes', html);
                renderClientsTable();
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
                target.classList.remove('bg-gray-600'); target.classList.add('bg-green-500');
                thumb.classList.add('translate-x-6'); thumb.classList.remove('translate-x-0');
            } else {
                target.classList.add('bg-gray-600'); target.classList.remove('bg-green-500');
                thumb.classList.remove('translate-x-6'); thumb.classList.add('translate-x-0');
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
    });

    applyThemePreferenceEarly();
    injectGlobalStyles();
    loadData(); 
    const user = loadSession(); 
    router(user);
    
    // ... (Clock Logic kept same) ...
    // 🟢 CLOCK LOGIC
    let clockIntervalId = null;
    let stopwatchInterval = null;
    let timerInterval = null;
    let clockMode = 'CLOCK';
    let stopwatchTime = 0;
    let timerTime = 0;
    let isClockRunning = false;
    let clockCanvas = null;
    let clockCtx = null;

    window.initClockModule = function() {
        clockCanvas = document.getElementById('clockCanvas');
        if(!clockCanvas) return;
        clockCtx = clockCanvas.getContext('2d');
        clockMode = 'CLOCK';
        stopwatchTime = 0;
        timerTime = 0;
        isClockRunning = false;
        if(stopwatchInterval) clearInterval(stopwatchInterval);
        if(timerInterval) clearInterval(timerInterval);
        if(clockIntervalId) cancelAnimationFrame(clockIntervalId);
        window.clockDrawLoop();
    };

    window.clockSetMode = function(mode) {
        clockMode = mode;
        const modeLabel = document.getElementById('modeLabel');
        const timerInputArea = document.getElementById('timerInputArea');
        const actionBtn = document.getElementById('actionBtn');
        const timeDisplay = document.getElementById('timeDisplay');
        if(modeLabel) modeLabel.innerText = mode;
        window.clockResetLogic();
        if (mode === 'TIMER') {
            if(timerInputArea) timerInputArea.style.display = 'block';
            if(timeDisplay) timeDisplay.innerText = "00:00";
        } else {
            if(timerInputArea) timerInputArea.style.display = 'none';
        }
        if(actionBtn) actionBtn.innerText = (mode === 'CLOCK') ? "---" : "Start";
    };

    window.clockHandleAction = function() {
        if (clockMode === 'CLOCK') return;
        if (isClockRunning) window.clockStopLogic();
        else window.clockStartLogic();
    };

    window.clockStartLogic = function() {
        const actionBtn = document.getElementById('actionBtn');
        const timerInput = document.getElementById('timerInput');
        isClockRunning = true;
        if(actionBtn) actionBtn.innerText = "Stop";
        if (clockMode === 'STOPWATCH') {
            const startTime = Date.now() - stopwatchTime;
            stopwatchInterval = setInterval(() => {
                stopwatchTime = Date.now() - startTime;
                window.clockUpdateDisplay(stopwatchTime);
            }, 100);
        } else if (clockMode === 'TIMER') {
            if (timerTime === 0) timerTime = parseInt(timerInput ? timerInput.value || 0 : 0) * 1000;
            const endTime = Date.now() + timerTime;
            timerInterval = setInterval(() => {
                timerTime = endTime - Date.now();
                if (timerTime <= 0) {
                    timerTime = 0;
                    clearInterval(timerInterval);
                    alert("Time is up!");
                    window.clockResetLogic();
                }
                window.clockUpdateDisplay(timerTime);
            }, 100);
        }
    };

    window.clockStopLogic = function() {
        isClockRunning = false;
        const actionBtn = document.getElementById('actionBtn');
        if(actionBtn) actionBtn.innerText = "Start";
        clearInterval(stopwatchInterval);
        clearInterval(timerInterval);
    };

    window.clockResetLogic = function() {
        window.clockStopLogic();
        stopwatchTime = 0;
        timerTime = 0;
        const timeDisplay = document.getElementById('timeDisplay');
        if (clockMode !== 'CLOCK' && timeDisplay) timeDisplay.innerText = "00:00";
    };

    window.clockUpdateDisplay = function(ms) {
        const timeDisplay = document.getElementById('timeDisplay');
        if(!timeDisplay) return;
        const totalSeconds = Math.floor(ms / 1000);
        const m = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
        const s = (totalSeconds % 60).toString().padStart(2, '0');
        timeDisplay.innerText = `${m}:${s}`;
    };

    window.clockDrawLoop = function() {
        if(!document.getElementById('clockCanvas')) return; 
        const centerX = 400; 
        const centerY = 400;
        clockCtx.clearRect(0, 0, 800, 800);
        window.clockDrawGear(clockCtx, centerX, centerY, 12, 360, 320, 40, '#5e2d91');
        clockCtx.fillStyle = "white";
        clockCtx.font = "bold 24px Arial";
        clockCtx.textAlign = "center";
        for (let i = 0; i < 60; i += 5) {
            const angle = (i - 15) * (Math.PI * 2 / 60);
            const x = centerX + Math.cos(angle) * 385;
            const y = centerY + Math.sin(angle) * 385 + 10;
            clockCtx.fillText(i, x, y);
        }
        const now = new Date();
        let activeSeconds = 0;
        if (clockMode === 'CLOCK') {
            activeSeconds = now.getSeconds();
            const timeDisplay = document.getElementById('timeDisplay');
            if(timeDisplay) timeDisplay.innerText = now.toTimeString().split(' ')[0].substring(0, 5);
        } else if (clockMode === 'STOPWATCH') {
            activeSeconds = Math.floor(stopwatchTime / 1000) % 60;
        } else if (clockMode === 'TIMER') {
            activeSeconds = Math.floor(timerTime / 1000) % 60;
        }
        for (let i = 0; i < 60; i++) {
            window.clockDrawMarker(clockCtx, centerX, centerY, i, i <= activeSeconds);
        }
        clockIntervalId = requestAnimationFrame(window.clockDrawLoop);
    };

    window.clockDrawGear = function(ctx, x, y, teeth, outerRadius, innerRadius, toothHeight, color) {
        ctx.save();
        ctx.beginPath();
        ctx.translate(x, y);
        ctx.fillStyle = color;
        ctx.strokeStyle = "rgba(0,0,0,0.3)";
        ctx.lineWidth = 5;
        for (let i = 0; i < teeth; i++) {
            ctx.rotate(Math.PI / teeth);
            ctx.lineTo(innerRadius, 0);
            ctx.lineTo(outerRadius, toothHeight);
            ctx.rotate(Math.PI / teeth);
            ctx.lineTo(outerRadius, -toothHeight);
            ctx.lineTo(innerRadius, 0);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    };

    window.clockDrawMarker = function(ctx, centerX, centerY, index, isActive) {
        const angle = (index - 15) * (Math.PI * 2 / 60);
        ctx.beginPath();
        ctx.strokeStyle = isActive ? "white" : "rgba(255,255,255,0.15)";
        ctx.lineWidth = 15;
        ctx.arc(centerX, centerY, 280, angle - 0.04, angle + 0.04);
        ctx.stroke();
    };

    // 🟢 RENDER TRAINER HOME
    window.renderTrainerHome = (trainerName) => {
        const greetingEl = document.getElementById('greeting-text');
        const feedContainer = document.getElementById('trainer-feed-container');
        
        if (!feedContainer) return;

        const hour = new Date().getHours();
        let greeting = "¡Buenos días";
        if (hour >= 12 && hour < 17) greeting = "¡Buenas tardes";
        else if (hour >= 17) greeting = "¡Buenas noches";
        if(greetingEl) greetingEl.textContent = `${greeting}, ${trainerName.split(' ')[0]}!`;

        const mockFeed = [
            {
                clientName: "Gabriel Ciuró",
                initials: "GC",
                timeAgo: "hace 4 horas",
                workoutTitle: "Día 2: Piernas & Core",
                exercises: [
                    {
                        letter: "A",
                        name: "Plate Decline Sit Ups",
                        instructions: "4 sets de 15-25 repeticiones. No utilices el momentum del plato para subir. Deja el plato fijo.",
                        result: "2x25 sin platoncontrolando la bajada\n1x20"
                    },
                    {
                        letter: "B",
                        name: "Smith Machine Split Squat",
                        instructions: "4 sets de 15-25 repeticiones. Hagamos un tempo de 3-0-1 (tarda 3 segundos bajando...).",
                        result: "3x15 25lbs db"
                    },
                    {
                        letter: "C1",
                        name: "DB Romanian Deadlifts",
                        instructions: "4 sets de 12 repeticiones. Comienza con los dumbbells de 50 libras.",
                        result: "3x12 50lbs"
                    }
                ]
            }
        ];

        feedContainer.innerHTML = mockFeed.map(item => `
            <div class="bg-gray-800 dark:bg-gray-800 rounded-lg border border-gray-700 overflow-hidden shadow-lg">
                <div class="p-4 bg-gray-750 dark:bg-gray-750 border-b border-gray-700 flex justify-between items-center">
                    <div class="flex items-center gap-3">
                        <div class="w-10 h-10 rounded-full bg-gray-600 text-white flex items-center justify-center font-bold">${item.initials}</div>
                        <div>
                            <h3 class="font-bold text-white text-lg leading-tight">${item.clientName}</h3>
                            <p class="text-xs text-gray-400">Vence el Mar, 13 Ene | Última actividad: ${item.timeAgo}</p>
                        </div>
                    </div>
                </div>
                <div class="p-6 border-b border-gray-700">
                    <h2 class="text-2xl font-bold text-white">${item.workoutTitle}</h2>
                </div>
                <div class="p-6 space-y-8">
                    ${item.exercises.map(ex => `
                        <div class="relative pl-12">
                            <div class="absolute left-0 top-0 w-8 h-8 bg-gray-700 rounded text-white font-bold flex items-center justify-center text-sm">${ex.letter}</div>
                            <div class="flex justify-between items-start mb-2">
                                <h4 class="text-xl font-bold text-white">${ex.name}</h4>
                                <i class="fas fa-check text-green-500 text-lg"></i>
                            </div>
                            <div class="flex items-center gap-2 mb-3 text-xs">
                                <i class="fas fa-history text-blue-400"></i>
                                <span class="text-blue-400 hover:underline cursor-pointer">Ver el historial de este ejercicio.</span>
                            </div>
                            <p class="text-gray-300 text-sm mb-4 leading-relaxed">${ex.instructions}</p>
                            <div class="bg-gray-900 border-l-4 border-green-500 p-4 rounded text-white font-mono text-sm whitespace-pre-line shadow-inner">
                                ${ex.result}
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `).join('');
    };

    // 🟢 UPDATED TIPS (Full List)
    const fitnessTips = {
        en: [ "Drink water before every meal.", "Prioritize protein in every meal.", "Sleep is your best supplement.", "Consistency beats intensity.", "Walk 10k steps daily.", "Don't drink your calories.", "Lift heavy things.", "Eat whole foods 80% of the time.", "Track your progress.", "Rest days are growth days.", "Compound lifts give best ROI.", "Form over weight, always.", "Eat more vegetables.", "Creatine is safe and effective.", "Protein shakes are just food.", "You can't out-train a bad diet.", "Progressive overload is key.", "Warm up before lifting.", "Stretch after lifting.", "Take progress photos.", "Don't fear carbohydrates.", "Fats are essential for hormones.", "Sugar isn't poison, excess is.", "Listen to your body.", "Deload weeks prevent injury.", "Training to failure is optional.", "Volume drives hypertrophy.", "Strength takes years, not weeks.", "Motivation fades, discipline stays.", "Meal prep saves time and waistlines.", "Alcohol kills gains.", "Sleep 7-9 hours.", "Hydrate first thing in the morning.", "Caffeine is a valid performance enhancer.", "Don't ego lift.", "Track your steps.", "Non-exercise activity matters (NEAT).", "Fiber keeps you full.", "Eat slowly.", "Stop when 80% full.", "Weigh yourself daily, average weekly.", "Scale weight fluctuates, don't panic.", "Take walks after meals.", "Sunlight helps sleep rhythm.", "Magnesium helps recovery.", "Consistency > Perfection.", "Enjoy your favorite foods in moderation.", "Fitness is a marathon, not a sprint.", "Focus on habits, not just goals.", "You got this." ],
        es: [ "Bebe agua antes de cada comida.", "Prioriza la proteína en cada comida.", "El sueño es tu mejor suplemento.", "La consistencia supera a la intensidad.", "Camina 10 mil pasos diarios.", "No te bebas tus calorías.", "Levanta cosas pesadas.", "Come alimentos enteros el 80% del tiempo.", "Rastrea tu progreso.", "Los días de descanso son días de crecimiento.", "Los ejercicios compuestos dan el mejor ROI.", "Técnica sobre peso, siempre.", "Come más vegetales.", "La creatina es segura y efectiva.", "Los batidos de proteína son solo comida.", "No puedes entrenar para compensar una mala dieta.", "La sobrecarga progresiva es clave.", "Calienta antes de levantar.", "Estira después de levantar.", "Toma fotos de progreso.", "No le temas a los carbohidratos.", "Las grasas son esenciales para las hormonas.", "El azúcar no es veneno, el exceso sí.", "Escucha a tu cuerpo.", "Las semanas de descarga previenen lesiones.", "Entrenar al fallo es opcional.", "El volumen impulsa la hipertrofia.", "La fuerza toma años, no semanas.", "La motivación se desvanece, la disciplina se queda.", "Preparar comidas ahorra tiempo y cintura.", "El alcohol mata las ganancias.", "Duerme 7-9 horas.", "Hidrátate a primera hora de la mañana.", "La cafeína es un potenciador de rendimiento válido.", "No levantes por ego.", "Rastrea tus pasos.", "La actividad no relacionada con el ejercicio importa (NEAT).", "La fibra te mantiene lleno.", "Come despacio.", "Detente cuando estés 80% lleno.", "Pésate diariamente, promedia semanalmente.", "El peso de la báscula fluctúa, no entres en pánico.", "Da paseos después de las comidas.", "La luz solar ayuda al ritmo del sueño.", "El magnesio ayuda a la recuperación.", "Consistencia > Perfección.", "Disfruta tus comidas favoritas con moderación.", "El fitness es un maratón, no un sprint.", "Enfócate en hábitos, no solo en metas.", "Tú puedes con esto." ]
    };

    window.updateFitnessTipLanguage = (lang) => {
        renderRandomTip(lang);
    };

    const renderRandomTip = (lang = 'es') => {
        const tipEl = document.getElementById('daily-fitness-tip');
        if (tipEl && fitnessTips[lang]) {
            const randomTip = fitnessTips[lang][Math.floor(Math.random() * fitnessTips[lang].length)];
            tipEl.textContent = `"${randomTip}"`;
        }
    };

    renderRandomTip('es');
});