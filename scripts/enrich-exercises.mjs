// Derive routine-generator metadata for the exercise library, from the name.
//
//   node scripts/enrich-exercises.mjs                 # DRY RUN — prints, writes nothing
//   node scripts/enrich-exercises.mjs --apply         # writes to the database
//   node scripts/enrich-exercises.mjs --field=pattern # work on one field only
//   node scripts/enrich-exercises.mjs --gaps          # list only what NO rule matched
//
// Phase 1 of the routine generator. Everything the generator needs — movement
// pattern, compound/isolation role, required equipment, unilateral, primary and
// secondary muscles — is inferred from the exercise name with regex rules, the
// same approach as tag-exercises.mjs (which fills `category` and is unaffected).
//
// SAFETY
//   - Dry run by default; --apply is required to write.
//   - Only ever FILLS EMPTY fields. Anything already set by hand is left alone,
//     so this is safe to re-run after you correct something.
//   - Reports coverage per field and lists every unmatched exercise, because the
//     generator is only as good as this data and you need to see the holes.
//
// Why regex and not AI at runtime: "Barbell Bench Press" contains every fact we
// need. Deriving it once, offline, into columns means the generator is pure,
// instant, free and reproducible. If a tag is ever wrong you fix the tag, not a
// prompt. Use AI to PROPOSE tags for the leftovers if you like — this file is
// still where they land.
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config({ quiet: true });

const APPLY    = process.argv.includes('--apply');
const GAPS     = process.argv.includes('--gaps');
const ONLY     = (process.argv.find(a => a.startsWith('--field=')) || '').split('=')[1] || null;

// ── 1. EQUIPMENT ────────────────────────────────────────────────────────────
// Tokens mirror the client equipment object exactly, so the generator can ask
// "does this client own what this exercise needs?" with no mapping layer:
//   dumbbells[] plates[] kettlebells[] cables[]
//   stations.{barra,banco,prensa,squat}
//   other.{bands,trx,mat,pullup,treadmill,bike,row,box}
const EQUIPMENT = [
  [/\bbarbell\b|\bbar\b|barra|pendlay|\bbb\b|olympic|clean|snatch|jerk/,        ['barbell']],
  [/dumbbell|mancuerna|\bdb\b|goblet/,                                          ['dumbbell']],
  [/kettlebell|\bkb\b|pesa rusa/,                                               ['kettlebell']],
  [/cable|polea|pulldown|pushdown|push ?down|face pull|crossover/,              ['cable']],
  [/machine|máquina|maquina|smith|hack|leg press|prensa|pec deck|selectorized|leg curl|leg extension|adduction|abduction|lat pulldown/, ['machine']],
  [/bench(?! over)|banco|incline|decline/,                                      ['bench']],
  [/\brack\b|squat rack|power rack|jaula/,                                      ['rack']],
  [/band|banda|resistance band/,                                                ['bands']],
  [/\btrx\b|suspension|suspensión|anilla|ring/,                                 ['trx']],
  [/pull[- ]?up|chin[- ]?up|dead hang|toes to bar|muscle[- ]?up/,               ['pullup']],
  [/\bbox\b|cajón|step[- ]?up/,                                                 ['box']],
  [/treadmill|caminadora|trotadora/,                                            ['treadmill']],
  [/\bbike\b|bicicleta|spinning|assault/,                                       ['bike']],
  [/\brower\b|remo ergo|ergometer/,                                             ['row']],
  [/mat|colchoneta|foam roll/,                                                  ['mat']],
];
// Nothing matched → it needs nothing. That is a real answer, not a gap: push-ups,
// planks and air squats genuinely require no equipment.
const BODYWEIGHT_HINT = /push[- ]?up|plank|sit[- ]?up|crunch|air squat|bodyweight|burpee|mountain climber|hollow|bird ?dog|dead ?bug|glute bridge|lunge|jumping jack/;

// ── 2. MOVEMENT PATTERN ─────────────────────────────────────────────────────
// Order matters: the FIRST match wins, so specific patterns precede general ones.
const PATTERNS = [
  [/deadlift|romanian|rdl|good morning|hip thrust|hip hinge|bridge|kettlebell swing|nordic|back extension|hyperextension|pull through/, 'hinge'],
  [/squat|leg press|prensa|hack|sissy|wall sit/,                                'squat'],
  [/lunge|split squat|step[- ]?up|step[- ]?down|bulgarian|zancada/,             'lunge'],
  [/overhead press|shoulder press|military|arnold|push press|thruster|handstand|\bohp\b/, 'push_v'],
  [/pulldown|pull[- ]?up|chin[- ]?up|lat pull/,                                 'pull_v'],
  [/bench press|chest press|push[- ]?up|\bdips?\b|floor press|fondos|guillotine/, 'push_h'],
  // A bare "press" that reached here is not overhead (push_v matched first) and
  // not a leg press (squat matched first) — so it is a horizontal push. This one
  // rule catches "Incline Dumbbell Press", "Decline Press", "Machine Press"…
  [/\bpress(es)?\b/,                                                           'push_h'],
  [/\brow\b|rows\b|pendlay|seal row|face pull|remo/,                            'pull_h'],
  [/carry|farmer|suitcase|waiter|yoke|dead hang/,                               'carry'],
  [/woodchop|russian twist|rotation|pallof|oblique|side bend/,                  'rotation'],
  [/plank|crunch|sit[- ]?up|leg raise|knee raise|hollow|dead ?bug|ab wheel|toes to bar|flutter|bicycle|knees? to (elbow|chest)|knee tuck|v[- ]?up|windshield|dragon flag|scissors/, 'core'],
  [/treadmill|threadmill|bike|bicicleta|rower|remo ergo|jump|burpee|sprint|jog|run\b|mountain climber|pogo|a[- ]?skip|side shuffle|toe tap|shuttle|man maker|slam/, 'cardio'],
  [/stretch|mobility|movilidad|foam roll|cat cow|pigeon|90\/90|circle|opener|a[- ]?skip|leg swing|warm ?up|massage gun|percussion|airplane|reach over/, 'mobility'],
  // Single-joint work that reached here is isolation by definition.
  [/curl|extension|raise|fly|flye|kickback|shrug|calf|pushdown|push ?down|adduction|abduction|skull ?crusher|rotator cuff/, 'isolation'],
];

// ── 3. ROLE ─────────────────────────────────────────────────────────────────
// Derived mostly from the pattern: multi-joint patterns are compounds.
const COMPOUND_PATTERNS = new Set(['squat', 'hinge', 'lunge', 'push_h', 'push_v', 'pull_h', 'pull_v', 'carry']);
const FORCE_ISOLATION = /lateral raise|front raise|rear delt|fly|flye|curl|kickback|shrug|calf raise|leg extension|leg curl|pushdown|push ?down|adduction|abduction|wrist/;

// ── 4a. EXPLICIT MUSCLE IN THE NAME — checked FIRST ─────────────────────────
// When the author names the target muscle, that beats any inference from the
// movement. "Smith Machine Tricep Guillotine Press" is a guillotine press, which
// is a chest pattern — but it was named a TRICEP exercise, and the person who
// typed the name knew what they meant.
//
// Kept deliberately narrow. A blanket /chest/ rule would wreck "Chest Supported
// Row", where "chest-supported" describes the bench position and the target is
// the upper back. Only unambiguous cases belong here.
const EXPLICIT_MUSCLE = [
    [/\btriceps?\b/,                        'triceps'],
    [/\bbiceps?\b/,                         'biceps'],
    [/glute[- ]?(bias|biased|focused)/,      'glutes'],
    [/quad[- ]?(bias|biased|focused)/,       'quads'],
    [/hamstring[- ]?(bias|biased|focused)/,  'hamstrings'],
];

// ── 4. PRIMARY MUSCLE — the MUSCLES taxonomy ids already defined in app.js ───
const MUSCLE = [
  [/bench press|chest press|chest fly|pec |push[- ]?up|\bdips?\b|crossover|floor press|guillotine/, 'chest'],
  [/rear delt|face pull|reverse fly|back fly|bent over.*(side raise|fly)/,       'rear_delts'],
  [/shoulder press|overhead press|military|arnold|lateral raise|side raise|front raise|upright row|delt|push press|rotator cuff|thruster|supine raise|shoulder (warm|mobility|circle|rotation)/, 'shoulders'],
  [/pulldown|pull[- ]?up|chin[- ]?up|\blat\b|lat pull|pullover/,                'lats'],
  [/shrug|trap\b/,                                                              'traps'],
  [/\brow\b|rows\b|pendlay|seal row|remo/,                                      'upper_back'],
  [/back extension|hyperextension|lower back|erector|good morning/,             'lower_back'],
  [/(?<!leg )(?<!nordic )(?<!wrist )curl(?!s? (machine|press))/,                'biceps'],
  [/tricep|skull ?crusher|pushdown|push ?down|overhead extension|kickback|\bdips?\b/, 'triceps'],
  [/wrist|forearm|grip|farmer|dead hang|carry|briefcase|suitcase/,              'forearms'],
  [/oblique|side plank|woodchop|russian twist|side bend/,                       'obliques'],
  [/hip flexor|leg raise|knee raise|\bl[- ]?sit\b/,                             'hip_flexors'],
  [/plank|crunch|sit[- ]?up|hollow|dead ?bug|ab wheel|toes to bar|flutter|bicycle|\babs?\b|knees? to (elbow|chest)|knee tuck|v[- ]?up|windshield|dragon flag|scissors/, 'abs'],
  [/hip thrust|glute|bridge|kickback|hip extension|abduction|clam|hip raise|pull ?through|hip airplane/, 'glutes'],
  [/leg curl|hamstring|romanian|rdl|nordic|deadlift/,                           'hamstrings'],
  [/squat|leg press|leg extension|lunge|step[- ]?up|step[- ]?down|split squat|sissy|hack|prensa/, 'quads'],
  [/calf|calve|gastroc|soleus|pantorrilla/,                                     'calves'],
  [/tibialis|tibial/,                                                           'tibialis'],
];

// ── 4b. PATTERN → DEFAULT MUSCLE ────────────────────────────────────────────
// A name rule is always preferred, but a movement pattern already implies its
// prime mover. "Incline Dumbbell Press" matched push_h and no muscle rule — yet
// a horizontal press is a chest exercise by definition. This closes that gap
// without inventing a rule per exercise-name variation.
const PATTERN_MUSCLE = {
  push_h: 'chest',   push_v: 'shoulders', pull_v: 'lats',    pull_h: 'upper_back',
  squat:  'quads',   hinge:  'hamstrings', lunge: 'quads',   carry:  'forearms',
  core:   'abs',     rotation: 'obliques',
};

// ── 5. SECONDARY MUSCLES — for weekly volume accounting ─────────────────────
const SECONDARY = {
  'bench press': ['triceps', 'shoulders'], 'chest press': ['triceps', 'shoulders'],
  'push_h':      ['triceps', 'shoulders'], 'push_v':      ['triceps'],
  'pull_v':      ['biceps'],               'pull_h':      ['biceps', 'rear_delts'],
  'squat':       ['glutes'],               'hinge':       ['glutes', 'lower_back'],
  'lunge':       ['glutes'],               'carry':       ['forearms', 'traps'],
};

const UNILATERAL = /single[- ]?arm|single[- ]?leg|one[- ]?arm|one[- ]?leg|unilateral|split squat|bulgarian|lunge|step[- ]?up|step[- ]?down|suitcase|pistol|\ba una\b|alternating/;

// ── derivation ──────────────────────────────────────────────────────────────
const firstMatch = (rules, name) => { for (const [re, v] of rules) if (re.test(name)) return v; return null; };

function derive(rawName) {
  const n = String(rawName || '').toLowerCase();

  const equipment = [];
  for (const [re, toks] of EQUIPMENT) if (re.test(n)) equipment.push(...toks);
  if (!equipment.length && BODYWEIGHT_HINT.test(n)) equipment.push('bodyweight');

  const pattern = firstMatch(PATTERNS, n) || '';
  // Explicitly named muscle > movement-name rule > what the pattern implies.
  const muscle  = firstMatch(EXPLICIT_MUSCLE, n)
               || firstMatch(MUSCLE, n)
               || PATTERN_MUSCLE[pattern] || '';

  let role = '';
  if (pattern) {
    role = FORCE_ISOLATION.test(n) ? 'isolation'
         : COMPOUND_PATTERNS.has(pattern) ? 'compound'
         : (pattern === 'isolation' ? 'isolation' : 'accessory');
  }

  const sec = new Set([...(SECONDARY[pattern] || [])]);
  for (const [k, v] of Object.entries(SECONDARY)) if (n.includes(k)) v.forEach(x => sec.add(x));
  sec.delete(muscle);   // never list the primary twice

  return {
    pattern, role, muscleGroupId: muscle,
    equipment: [...new Set(equipment)],
    unilateral: UNILATERAL.test(n),
    secondaryMuscles: [...sec],
  };
}

// ── run ─────────────────────────────────────────────────────────────────────
await mongoose.connect(process.env.MONGO_URI);
// ENRICH_COLLECTION lets the test suite point this at a throwaway collection so
// the safety contract (never overwrite, safe to re-run) can be PROVEN without
// touching the real library. Unset in every normal run.
const E = mongoose.connection.collection(process.env.ENRICH_COLLECTION || 'exercises');
const all = await E.find({}).project({
  name: 1, pattern: 1, role: 1, muscleGroupId: 1, equipment: 1, unilateral: 1, secondaryMuscles: 1,
}).toArray();

const FIELDS = ['pattern', 'role', 'muscleGroupId', 'equipment', 'unilateral', 'secondaryMuscles'];
const fields = ONLY ? FIELDS.filter(f => f === ONLY) : FIELDS;
if (ONLY && !fields.length) { console.error(`Unknown --field=${ONLY}. One of: ${FIELDS.join(', ')}`); process.exit(1); }

const isEmpty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);

const planned = [];
const noPattern = [];
const noMuscle  = [];
const noEquip   = [];

for (const ex of all) {
  const d = derive(ex.name);
  const patch = {};
  for (const f of fields) {
    // unilateral is a boolean: false is a real value, so only fill when ABSENT.
    const empty = f === 'unilateral' ? ex[f] === undefined || ex[f] === null : isEmpty(ex[f]);
    if (empty && !isEmpty(d[f])) patch[f] = d[f];
    if (f === 'unilateral' && empty) patch[f] = d[f];    // always settle the boolean
  }
  if (Object.keys(patch).length) planned.push({ _id: ex._id, name: ex.name, patch });
  if (!d.pattern)            noPattern.push(ex.name);
  if (!d.muscleGroupId)      noMuscle.push(ex.name);
  if (!d.equipment.length)   noEquip.push(ex.name);
}

const pct = (n) => `${String(n).padStart(3)} / ${all.length}  (${String(Math.round(n / all.length * 100)).padStart(3)}%)`;
console.log(`exercise library: ${all.length}\n`);
console.log('coverage the rules can derive:');
console.log(`  pattern ............ ${pct(all.length - noPattern.length)}`);
console.log(`  primary muscle ..... ${pct(all.length - noMuscle.length)}`);
console.log(`  equipment .......... ${pct(all.length - noEquip.length)}   (no tokens = needs nothing)`);
console.log(`\nwould write to ${planned.length} exercise(s)` + (ONLY ? ` [field: ${ONLY}]` : ''));

if (GAPS) {
  const show = (label, list) => {
    if (!list.length) return;
    console.log(`\n── ${label} (${list.length}) — tag these by hand ──`);
    list.forEach(n => console.log(`  ${n}`));
  };
  show('no movement pattern matched', noPattern);
  show('no primary muscle matched',   noMuscle);
} else {
  console.log('\n── sample of what would be written (first 25) ──');
  planned.slice(0, 25).forEach(p => {
    const bits = Object.entries(p.patch)
      .map(([k, v]) => `${k}=${Array.isArray(v) ? (v.length ? v.join('/') : '—') : v}`)
      .join('  ');
    console.log(`  ${p.name.slice(0, 38).padEnd(40)} ${bits}`);
  });
  if (planned.length > 25) console.log(`  … and ${planned.length - 25} more`);
  console.log('\nRun with --gaps to list what no rule could match.');
}

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to save.');
} else {
  let n = 0;
  for (const p of planned) {
    await E.updateOne({ _id: p._id }, { $set: { ...p.patch, lastUpdated: new Date() } });
    n++;
  }
  console.log(`\n✓ enriched ${n} exercise(s).`);
}
await mongoose.disconnect();
