// "Your account is inactive" screen — shown to a DEACTIVATED CLIENT in place of the app.
//
// A deactivated client can still sign in (they have to be able to pay to be switched back
// on) but the server refuses every API call except /api/me and /api/payments/mine — see
// middleware/auth.js. This file is the other half: instead of a dashboard full of failed
// requests, they get one page that says what happened and gives them three ways out:
//
//   • see / pay their invoices        • WhatsApp the trainer        • email the trainer
//
// It attaches to document.body (like live-session.js), so it covers whatever the app had
// drawn and cannot be removed by a navigation. It is entered two ways:
//   1. At sign-in:    app.js asks /api/me and calls AccountInactive.show(me).
//   2. Mid-session:   a client deactivated while the app is open starts getting 403
//      { code: 'ACCOUNT_INACTIVE' } — a tiny fetch wrapper (installed below) spots that
//      on ANY request and raises the same page, so no individual call site has to know.
//
// Everything that comes from the server is escaped before it touches innerHTML.

(() => {
    'use strict';
    if (window.AccountInactive) return;

    const origFetch = window.fetch.bind(window);
    let shown = false;
    let me = null;

    const TXT = {
        es: {
            title: 'Tu cuenta está inactiva',
            body: 'Comunícate con tu entrenador para recuperar el acceso a la plataforma.',
            payBtn: 'Ver mis pagos',
            hidePay: 'Ocultar mis pagos',
            wa: 'Escribir por WhatsApp',
            mail: 'Enviar un correo',
            recheck: 'Ya me reactivaron',
            logout: 'Cerrar sesión',
            stillOff: 'Tu cuenta sigue inactiva.',
            invoices: 'Mis facturas',
            none: 'No tienes facturas registradas.',
            pay: 'Pagar',
            due: 'Vence',
            paid: 'Pagado',
            pending: 'Pendiente',
            overdue: 'Vencido',
            loadErr: 'No se pudieron cargar tus pagos.',
            other: 'Otras formas de pago',
            sendTo: 'Envía el pago a',
            waMsg: 'Hola, mi cuenta de FitBySuárez está inactiva y quiero recuperar el acceso.',
            mailSubj: 'Cuenta inactiva – FitBySuárez',
        },
        en: {
            title: 'Your account is inactive',
            body: 'Please contact your trainer to regain access to the platform.',
            payBtn: 'View my payments',
            hidePay: 'Hide my payments',
            wa: 'Message on WhatsApp',
            mail: 'Send an email',
            recheck: "I've been reactivated",
            logout: 'Sign out',
            stillOff: 'Your account is still inactive.',
            invoices: 'My invoices',
            none: 'You have no invoices on record.',
            pay: 'Pay',
            due: 'Due',
            paid: 'Paid',
            pending: 'Pending',
            overdue: 'Overdue',
            loadErr: "We couldn't load your payments.",
            other: 'Other ways to pay',
            sendTo: 'Send payment to',
            waMsg: 'Hi, my FitBySuárez account is inactive and I would like to regain access.',
            mailSubj: 'Inactive account – FitBySuárez',
        },
    };
    const lang = () => {
        let l = 'es';
        try { l = sessionStorage.getItem('fbs_lang_session') || localStorage.getItem('fbs_lang') || 'es'; } catch { /* private mode */ }
        return TXT[l] ? l : 'es';
    };
    const t = (k) => TXT[lang()][k];

    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    // Only ever link to https — a stored "javascript:" URL must not become a button.
    const safeHttps = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : '');

    const CSS = `
    #fbs-inactive{position:fixed;inset:0;z-index:2147483000;background:#030303;color:#f4f4f5;overflow-y:auto;
        display:flex;align-items:flex-start;justify-content:center;padding:24px 16px;
        font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif;-webkit-font-smoothing:antialiased}
    #fbs-inactive .fi-card{width:100%;max-width:460px;margin:auto;background:#111113;
        border:1px solid rgba(255,219,137,.18);border-radius:24px;padding:28px 22px;text-align:center}
    #fbs-inactive .fi-ico{width:64px;height:64px;margin:0 auto 16px;border-radius:50%;display:flex;
        align-items:center;justify-content:center;background:rgba(255,219,137,.10);
        border:1px solid rgba(255,219,137,.25);color:#FFDB89}
    #fbs-inactive h1{margin:0 0 8px;font-size:22px;font-weight:800;color:#FFDB89}
    #fbs-inactive p.fi-body{margin:0 0 22px;font-size:15px;line-height:1.5;color:rgba(255,255,255,.78)}
    #fbs-inactive .fi-btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;
        box-sizing:border-box;padding:13px 16px;margin-top:10px;border-radius:14px;font-size:15px;
        font-weight:700;text-decoration:none;cursor:pointer;border:1px solid transparent;font-family:inherit}
    #fbs-inactive .fi-gold{background:#FFDB89;color:#030303}
    #fbs-inactive .fi-wa{background:#25D366;color:#fff}
    #fbs-inactive .fi-ghost{background:transparent;color:#FFDB89;border-color:rgba(255,219,137,.3)}
    #fbs-inactive .fi-quiet{background:transparent;color:rgba(255,255,255,.55);font-weight:500;font-size:14px}
    #fbs-inactive .fi-btn:focus-visible{outline:2px solid #FFDB89;outline-offset:2px}
    #fbs-inactive .fi-pay{margin-top:18px;text-align:left}
    #fbs-inactive .fi-h{font-size:12px;letter-spacing:.08em;text-transform:uppercase;
        color:rgba(255,219,137,.7);margin:14px 0 8px}
    #fbs-inactive .fi-row{display:flex;align-items:center;justify-content:space-between;gap:10px;
        padding:11px 12px;margin-bottom:8px;border-radius:12px;background:#1a1a1d;
        border:1px solid rgba(255,255,255,.07)}
    #fbs-inactive .fi-amt{font-weight:800;font-size:16px}
    #fbs-inactive .fi-sub{font-size:12px;color:rgba(255,255,255,.55);margin-top:2px}
    #fbs-inactive .fi-chip{font-size:11px;font-weight:800;padding:3px 9px;border-radius:999px;
        border:1px solid;white-space:nowrap}
    #fbs-inactive .fi-paylink{display:inline-block;margin-top:6px;padding:6px 12px;border-radius:10px;
        background:#FFDB89;color:#030303;font-weight:800;font-size:13px;text-decoration:none}
    #fbs-inactive .fi-hand{font-size:14px;line-height:1.6;color:rgba(255,255,255,.8);
        padding:10px 12px;background:#1a1a1d;border-radius:12px;border:1px solid rgba(255,255,255,.07)}
    #fbs-inactive .fi-hand b{color:#FFDB89}
    #fbs-inactive .fi-msg{min-height:18px;margin-top:10px;font-size:13px;color:#fca5a5}
    @media (prefers-reduced-motion:no-preference){#fbs-inactive .fi-card{animation:fi-in .25s ease-out}}
    @keyframes fi-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}`;

    const LOCK = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

    function chip(status) {
        const m = { paid: ['paid', '#34D399'], pending: ['pending', '#FBBF24'], overdue: ['overdue', '#f87171'] };
        const [k, c] = m[status] || m.pending;
        return `<span class="fi-chip" style="color:${c};border-color:${c}">${esc(t(k))}</span>`;
    }

    async function loadPayments(box) {
        box.innerHTML = `<div class="fi-sub">…</div>`;
        try {
            const res = await origFetch('/api/payments/mine', { credentials: 'include' });
            if (!res.ok) throw new Error();
            const items = await res.json();
            const rows = (Array.isArray(items) ? items : []).map((p) => {
                const link = p.status !== 'paid' ? safeHttps(p.stripePaymentLink) : '';
                const sub = p.status === 'paid' && p.paidDate
                    ? `${t('paid')}: ${esc(p.paidDate)}` : `${t('due')}: ${esc(p.dueDate || '')}`;
                return `<div class="fi-row"><div>
                    <div class="fi-amt">$${esc(Number(p.amount || 0).toFixed(2))}</div>
                    <div class="fi-sub">${esc(p.periodLabel || p.planLabel || '')} · ${sub}</div>
                    ${link ? `<a class="fi-paylink" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${esc(t('pay'))}</a>` : ''}
                </div>${chip(p.status)}</div>`;
            }).join('');

            const h = me?.payHandles || {};
            const hand = [];
            if (h.athMovil) hand.push(`ATH Móvil: <b>${esc(h.athMovil)}</b>${h.athMovilPhone ? ` · ${esc(h.athMovilPhone)}` : ''}`);
            if (h.venmo)    hand.push(`Venmo: <b>@${esc(h.venmo)}</b>`);
            if (h.paypal)   hand.push(`PayPal: <b>paypal.me/${esc(h.paypal)}</b>`);

            box.innerHTML = `<div class="fi-h">${esc(t('invoices'))}</div>${rows || `<div class="fi-sub">${esc(t('none'))}</div>`}`
                + (hand.length ? `<div class="fi-h">${esc(t('other'))}</div><div class="fi-hand">${hand.join('<br>')}</div>` : '');
        } catch {
            box.innerHTML = `<div class="fi-msg" role="alert">${esc(t('loadErr'))}</div>`;
        }
    }

    function render() {
        let root = document.getElementById('fbs-inactive');
        if (!root) {
            if (!document.getElementById('fbs-inactive-css')) {
                const st = document.createElement('style');
                st.id = 'fbs-inactive-css';
                st.textContent = CSS;
                document.head.appendChild(st);
            }
            root = document.createElement('div');
            root.id = 'fbs-inactive';
            root.setAttribute('role', 'alertdialog');
            root.setAttribute('aria-modal', 'true');
            root.setAttribute('aria-labelledby', 'fi-title');
            document.body.appendChild(root);
        }
        const c = me?.contact || {};
        const wa = String(c.whatsapp || '').replace(/\D/g, '');
        const mail = String(c.email || '');
        const waHref = wa ? `https://wa.me/${wa}?text=${encodeURIComponent(t('waMsg'))}` : '';
        const mailHref = mail ? `mailto:${encodeURIComponent(mail).replace(/%40/g, '@')}?subject=${encodeURIComponent(t('mailSubj'))}` : '';

        root.innerHTML = `<div class="fi-card">
            <div class="fi-ico">${LOCK}</div>
            <h1 id="fi-title">${esc(t('title'))}</h1>
            <p class="fi-body">${esc(t('body'))}</p>
            <button type="button" class="fi-btn fi-gold" id="fi-pay-btn" aria-expanded="false">${esc(t('payBtn'))}</button>
            <div class="fi-pay" id="fi-pay" hidden></div>
            ${waHref ? `<a class="fi-btn fi-wa" href="${esc(waHref)}" target="_blank" rel="noopener noreferrer">${esc(t('wa'))}</a>` : ''}
            ${mailHref ? `<a class="fi-btn fi-ghost" href="${esc(mailHref)}">${esc(t('mail'))}</a>` : ''}
            <button type="button" class="fi-btn fi-ghost" id="fi-recheck">${esc(t('recheck'))}</button>
            <div class="fi-msg" id="fi-msg" role="status"></div>
            <button type="button" class="fi-btn fi-quiet" id="fi-logout">${esc(t('logout'))}</button>
        </div>`;

        const payBox = root.querySelector('#fi-pay');
        const payBtn = root.querySelector('#fi-pay-btn');
        let loaded = false;
        payBtn.addEventListener('click', () => {
            const open = payBox.hidden;
            payBox.hidden = !open;
            payBtn.textContent = t(open ? 'hidePay' : 'payBtn');
            payBtn.setAttribute('aria-expanded', String(open));
            if (open && !loaded) { loaded = true; loadPayments(payBox); }
        });

        root.querySelector('#fi-recheck').addEventListener('click', async () => {
            const msg = root.querySelector('#fi-msg');
            msg.textContent = '';
            try {
                const res = await origFetch('/api/me', { credentials: 'include' });
                const fresh = res.ok ? await res.json() : null;
                if (fresh && !fresh.accountInactive) { location.reload(); return; }
                msg.textContent = t('stillOff');
            } catch { msg.textContent = t('stillOff'); }
        });

        root.querySelector('#fi-logout').addEventListener('click', () => {
            origFetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).finally(() => {
                try { localStorage.removeItem('auth_user'); sessionStorage.removeItem('fbs_last_module'); } catch { /* ignore */ }
                location.reload();
            });
        });
        payBtn.focus();
    }

    function show(meData) {
        me = meData || me;
        // The app's own screens are now meaningless — stop what they were doing.
        try { window.LiveSession?.end?.(); window.LiveSession?.disconnect?.(); } catch { /* not loaded */ }
        document.body.style.overflow = 'hidden';
        shown = true;
        render();
    }

    // Mid-session: any 403 { code:'ACCOUNT_INACTIVE' } raises the page.
    async function raiseFromApi() {
        if (shown) return;
        shown = true;
        try {
            const res = await origFetch('/api/me', { credentials: 'include' });
            const fresh = res.ok ? await res.json() : null;
            if (fresh?.accountInactive) { show(fresh); return; }
        } catch { /* fall through */ }
        shown = false;   // could not confirm — let the next 403 try again
    }

    window.fetch = async function (...args) {
        const res = await origFetch(...args);
        if (res.status === 403 && !shown) {
            res.clone().json().then((b) => { if (b?.code === 'ACCOUNT_INACTIVE') raiseFromApi(); }).catch(() => {});
        }
        return res;
    };

    window.AccountInactive = { show, isShown: () => shown };
})();
