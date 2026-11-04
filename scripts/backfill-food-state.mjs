// Fill in "seco o cocido" for shared foods whose NAME already says it.
//
// The field arrived after the library did, so every entry saved before it reads
// as unknown. Many of them already answer the question in their own name —
// "Arroz blanco (cocido)", "Avena (cruda)", "pollo a la parrilla" — and this
// writes that answer into the field. It is a transcription, not an inference:
// a food whose name says nothing is LEFT ALONE for a human to decide, and a
// food that already has a state is never touched.
//
// Dry run by default. Nothing is written until you pass --write:
//
//   MONGO_URI=... node scripts/backfill-food-state.mjs            # show me
//   MONGO_URI=... node scripts/backfill-food-state.mjs --write    # do it
//
// Safe to run twice: the second run finds nothing left to do.

import { MongoClient } from 'mongodb';
import { readFileSync } from 'node:fs';

const URI = process.env.MONGO_URI;
if (!URI) { console.error('Set MONGO_URI.'); process.exit(2); }
const WRITE = process.argv.includes('--write');

const sandbox = {};
new Function('self', readFileSync(new URL('../public/food-state.js', import.meta.url), 'utf8'))(sandbox);
const F = sandbox.FoodState;

const mongo = await MongoClient.connect(URI);
const db = mongo.db();
try {
    const foods = await db.collection('foodlibraries')
        .find({ $or: [{ state: { $exists: false } }, { state: '' }] })
        .project({ name: 1, state: 1, timesUsed: 1 }).toArray();

    const fillable = [];
    const leave = [];
    for (const f of foods) {
        const read = F.fromName(f.name);
        if (read) fillable.push({ _id: f._id, name: f.name, state: read });
        else if (F.matters(f.name)) leave.push(f);
    }

    console.log(`${foods.length} shared foods with no state.\n`);
    console.log(`── Their own name answers it (${fillable.length}) ──`);
    fillable.forEach((f) => console.log(`   ${f.state.padEnd(7)} ${f.name}`));
    console.log(`\n── Nobody can tell from the name, and it matters (${leave.length}) ──`);
    console.log('   These are yours to decide, in Nutrición → Alimentos → "Sin seco/cocido".');
    leave.sort((a, b) => (b.timesUsed || 0) - (a.timesUsed || 0))
        .forEach((f) => console.log(`   ${String(f.timesUsed || 0).padStart(4)}×  ${f.name}`));

    if (!WRITE) { console.log(`\nDry run. Pass --write to apply the ${fillable.length} above.`); }
    else if (fillable.length) {
        const ops = fillable.map((f) => ({
            updateOne: { filter: { _id: f._id, $or: [{ state: { $exists: false } }, { state: '' }] },
                         update: { $set: { state: f.state } } },
        }));
        const r = await db.collection('foodlibraries').bulkWrite(ops);
        console.log(`\nWrote ${r.modifiedCount} of ${fillable.length}.`);
    } else console.log('\nNothing to write.');
} finally {
    await mongo.close();
}
