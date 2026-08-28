// Auto-tag the exercise library from movement names.
//
// Every exercise currently sits in the placeholder tag "General"; this fills in
// real tags so the library becomes searchable/filterable by muscle and modality.
//
//   node scripts/tag-exercises.mjs             # DRY RUN — prints, writes nothing
//   node scripts/tag-exercises.mjs --apply     # writes to the database
//
// Safe to re-run: it only touches exercises whose tags are empty or ["General"],
// so anything you have hand-tagged is never overwritten.
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config({ quiet: true });

const APPLY = process.argv.includes('--apply');

// Rules are matched against the lowercased name; ALL matches apply, then tags are
// deduped. Patterns are deliberately specific — e.g. "leg raise" is an ab movement,
// so there is no generic /leg/ rule that would mislabel it as a quad exercise.
const RULES = [
  // ── Core / abs (checked via specific movements, never a bare "leg") ────────
  [/leg raise|knee raise|knees? to (elbow|chest)|sit[- ]?up|crunch|deadbug|dead bug|plank|hollow|woodchop|russian twist|ab wheel|toes to bar|v[- ]?up|mountain climber|flutter kick|knee tuck|scissors|windshield/, ['Abdomen', 'Core']],
  [/oblique|side plank|woodchop|russian twist|side bend/,                                   ['Oblicuos', 'Core']],
  [/kegel|pelvic floor|suelo p[eé]lvico/,                                                   ['Suelo pélvico', 'Core']],

  // ── Legs ──────────────────────────────────────────────────────────────────
  [/leg curl|hamstring|romanian deadlift|rdl|good morning|nordic/,                          ['Femorales', 'Piernas']],
  [/squat|leg press|leg extension|lunge|step[- ]?up|split squat|sissy|hack/,                ['Quadriceps', 'Piernas']],
  [/hip thrust|glute|bridge|kickback|hip extension/,                                        ['Glúteos', 'Cadera']],
  [/adduction|adductor|inner thigh/,                                                        ['Aductores', 'Piernas']],
  [/abduction|abductor|outer thigh|clam/,                                                   ['Abductores', 'Cadera']],
  [/calf|calve/,                                                                            ['Pantorrillas', 'Piernas']],
  [/tibialis|tibial/,                                                                       ['Tibiales', 'Piernas']],
  [/hip (mobility|circle|opener|flexor)|90\/90/,                                            ['Cadera', 'Movilidad']],

  // ── Back ──────────────────────────────────────────────────────────────────
  [/pulldown|pull[- ]?up|chin[- ]?up|\blat\b/,                                                    ['Dorsales', 'Espalda', 'Halón']],
  [/\brow\b|rows\b|pendlay|seal row/,                                                       ['Espalda', 'Halón']],
  [/shrug|trap /,                                                                           ['Trapecio', 'Espalda']],
  [/back extension|hyperextension|lower back|erector/,                                      ['Espalda Baja', 'Espalda']],
  [/deadlift/,                                                                              ['Espalda Baja', 'Femorales', 'Glúteos']],

  // ── Chest ─────────────────────────────────────────────────────────────────
  [/bench press|chest press|chest fly|pec |pec$|dumbbell press|incline press|decline press|push[- ]?up/, ['Pecho', 'Empuje']],
  [/(?<!rear delt )(?<!back )(?<!reverse )(\bfly\b|flys|flyes)/,                            ['Pecho']],

  // ── Shoulders ─────────────────────────────────────────────────────────────
  [/shoulder press|overhead press|arnold|military press|lateral raise|side raise|front raise|upright row|delt|rotator cuff/, ['Hombros']],
  [/rear delt|face pull|reverse fly|back fly/,                                              ['Hombros', 'Espalda']],

  // ── Arms ──────────────────────────────────────────────────────────────────
  [/(?<!leg )(?<!nordic )(?<!wrist )curl/,                                                  ['Biceps']],
  [/tricep|skull ?crusher|pushdown|push ?down|overhead extension|kickback|\bdips?\b|guillotine/, ['Triceps', 'Empuje']],
  [/wrist|forearm|reverse curl|hammer curl/,                                                ['Antebrazos']],
  [/grip (strength|work|trainer)|farmer|dead hang/,                                         ['Agarre', 'Antebrazos']],

  [/step[- ]?down/,                                                                         ['Quadriceps', 'Piernas']],
  [/hip raise|pull through/,                                                                ['Glúteos', 'Cadera']],
  [/leg swing|pigeon pose|cat cow|massage gun|a[- ]?skip/,                                  ['Movilidad']],
  [/thruster|man maker|push press/,                                                         ['Hombros', 'Empuje']],
  [/pogo|toe tap|jump|shuffle|skip/,                                                        ['HIIT', 'Cardio']],
  [/windshield/,                                                                            ['Oblicuos']],

  // ── Modality ──────────────────────────────────────────────────────────────
  [/treadmill|threadmill|run\b|running|jog|bike|cycling|elliptical|erg\b|(?<!walking )\bwalk\b|stair|cardio/, ['Cardio']],
  [/hiit|interval|burpee|sprint|tabata|circuit/,                                            ['HIIT', 'Cardio']],
  [/stretch|mobility|foam roll|movilidad|estiramiento/,                                     ['Estiramiento', 'Movilidad']],
  [/warm[- ]?up|calentamiento|activation/,                                                     ['Calentamientos']],
  [/push[- ]?up|pull[- ]?up|chin[- ]?up|dip\b|bodyweight|air squat|calisthen/,                       ['Calistenia']],
];

const tagsFor = (name) => {
  const n = String(name || '').toLowerCase();
  const out = new Set();
  for (const [re, tags] of RULES) if (re.test(n)) tags.forEach(t => out.add(t));
  return [...out];
};

await mongoose.connect(process.env.MONGO_URI);
const E = mongoose.connection.collection('exercises');

// Only consider exercises that are effectively untagged.
const untagged = await E.find({
  $or: [{ category: { $exists: false } }, { category: [] }, { category: ['General'] }],
}).project({ name: 1, category: 1 }).toArray();

const total = await E.countDocuments();
const planned = [];
const skipped = [];
for (const ex of untagged) {
  const tags = tagsFor(ex.name);
  (tags.length ? planned : skipped).push({ _id: ex._id, name: ex.name, tags });
}

console.log(`library total        : ${total}`);
console.log(`untagged (General)   : ${untagged.length}`);
console.log(`would tag            : ${planned.length}`);
console.log(`no rule matched      : ${skipped.length}\n`);

console.log('── proposed tags ─────────────────────────────────────────────');
planned.forEach(p => console.log(`  ${p.name.padEnd(42)} → ${p.tags.join(', ')}`));

if (skipped.length) {
  console.log('\n── no rule matched (tag these by hand) ───────────────────────');
  skipped.forEach(s => console.log(`  ${s.name}`));
}

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to save.');
} else {
  let n = 0;
  for (const p of planned) {
    await E.updateOne({ _id: p._id }, { $set: { category: p.tags, lastUpdated: new Date() } });
    n++;
  }
  console.log(`\n✓ applied tags to ${n} exercise(s).`);
}
await mongoose.disconnect();
