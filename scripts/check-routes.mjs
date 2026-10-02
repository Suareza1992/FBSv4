/**
 * check-routes.mjs — keep the server's partial allowlist and the SPA router in sync.
 *
 *   npm run check:routes
 *
 * The section files in public/ are HTML FRAGMENTS. Opening one as a page used to
 * show raw markup, so server.js redirects a NAVIGATION to `/#/<slug>` and app.js
 * reads that hash back into a module. Those are two lists in two files, and they
 * drift: library_content.html was already being redirected to a hash the router
 * had no module for, which would have dropped the user on a blank frame.
 *
 * This script re-derives both lists from the source and asserts they agree. Run
 * it after adding a section. No server or database needed.
 */
import fs from 'fs';
const lines = fs.readFileSync(new URL('../public/app.js', import.meta.url),'utf8').split('\n');
// MODULE_TITLES through the end of stateFromHash()
const start = lines.findIndex(l => l.includes('const MODULE_TITLES = {'));
const end   = lines.findIndex((l,i) => i > start && l.trim() === '};' && lines.slice(start,i).join('\n').includes('const stateFromHash'));
const code  = lines.slice(start, end+1).join('\n');
if (!code.includes('stateFromHash')) throw new Error('extraction missed stateFromHash');

const location = { hash: '' };
const api = new Function('location', code + '\nreturn { stateFromHash, moduleAllowedFor, RESTORABLE_MODULES };')(location);

const cases = [
  ['#/trainer_home','trainer_home','trainer'], ['#/notifications','notifications_content','trainer'],
  ['#/clientes','clientes_content','trainer'], ['#/entrenadores','entrenadores_content','trainer'],
  ['#/programas','programas_content','trainer'], ['#/pagos','pagos_content','trainer'],
  ['#/blog','blog_content','trainer'], ['#/ajustes','ajustes_content','trainer'],
  ['#/client_inicio','client_inicio','client'], ['#/client_programas','client_programas','client'],
  ['#/client_metricas','client_metricas','client'], ['#/client_nutricion','client_nutricion','client'],
  ['#/client_equipo','client_equipo','client'], ['#/client_progress','client_progress','client'],
  ['#/client_clock','client_clock','client'], ['#/client_historial','client_historial','client'],
];
let pass=0, fail=0;
const check = (ok,label,extra='') => { ok?pass++:fail++; console.log((ok?'PASS':'FAIL').padEnd(5), label, extra); };
for (const [hash, mod, role] of cases) {
  location.hash = hash;
  const got = api.stateFromHash()?.module ?? null;
  const allowed = role ? api.moduleAllowedFor(role, mod) : null;
  check(got === mod && (role ? allowed === true : true),
        hash.padEnd(22) + '-> ' + String(got).padEnd(22), role ? (allowed?'allowed':'DENIED') : '(no role gate)');
}
location.hash='#/library'; check(api.stateFromHash() === null, 'orphaned #/library has no module (server sends it to /)');
check(api.moduleAllowedFor('client','clientes_content') === false, 'client blocked from a trainer module');
check(api.moduleAllowedFor('trainer','client_nutricion') === false, 'trainer blocked from a client module');
location.hash='#/cliente/abc123';  check(api.stateFromHash()?.clientId === 'abc123', 'deep link #/cliente/:id');
location.hash='#/programa/p_9';    check(api.stateFromHash()?.programId === 'p_9', 'deep link #/programa/:id');
location.hash='#/../../etc/passwd';check(api.stateFromHash() === null, 'path traversal rejected');
location.hash='#/nope';            check(api.stateFromHash() === null, 'unknown module rejected');
location.hash='';                  check(api.stateFromHash() === null, 'empty hash -> null');

// ── The two allowlists must agree ────────────────────────────────────────────
// The server redirects a partial to `#/<slug>`; if the client router has no
// module for that slug the user lands on a blank frame. This is exactly how
// library_content slipped through, so assert the pairing instead of eyeballing it.
const server = fs.readFileSync(new URL('../server.js', import.meta.url),'utf8');
const setOf = (name) => {
  const m = server.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`));
  return new Set([...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]));
};
const partials = setOf('SPA_PARTIALS'), noModule = setOf('NO_MODULE');
for (const slug of partials) {
  if (noModule.has(slug)) continue;
  location.hash = `#/${slug.replace(/_content$/,'')}`;
  check(api.stateFromHash()?.module === slug, `server slug "${slug}" resolves in the client router`);
}
for (const slug of noModule) check(partials.has(slug), `NO_MODULE "${slug}" is listed in SPA_PARTIALS`);
// And every routable module should be reachable by its own file name.
for (const mod of api.RESTORABLE_MODULES) check(partials.has(mod), `module "${mod}" is covered by SPA_PARTIALS`);
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
