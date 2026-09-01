// One-time: give every existing program an owner.
//
// Programs became private per-trainer. Existing ones predate that field, so they
// have trainerId: null. The superadmin still sees them (the list query skips the
// filter entirely for a superadmin), but stamping ownership makes it explicit and
// keeps them working if the account ever stops being superadmin.
//
//   node scripts/assign-program-owners.mjs             # DRY RUN
//   node scripts/assign-program-owners.mjs --apply     # writes
//
// Safe to re-run: only touches programs with no owner.
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config({ quiet: true });

const APPLY = process.argv.includes('--apply');
const OWNER_EMAIL = process.env.OWNER_EMAIL || 'fitbysuarez@gmail.com';

await mongoose.connect(process.env.MONGO_URI);
const U = mongoose.connection.collection('users');
const P = mongoose.connection.collection('programs');

const owner = await U.findOne({ email: OWNER_EMAIL }, { projection: { _id: 1, email: 1 } });
if (!owner) { console.error(`No account for ${OWNER_EMAIL}`); process.exit(1); }

const q = { $or: [{ trainerId: null }, { trainerId: { $exists: false } }] };
const unowned = await P.find(q).project({ name: 1 }).toArray();

console.log(`programs total    : ${await P.countDocuments()}`);
console.log(`without an owner  : ${unowned.length}`);
console.log(`would assign to   : ${owner.email}\n`);
unowned.forEach((p) => console.log(`  ${p.name}`));

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to save.');
} else {
  const r = await P.updateMany(q, { $set: { trainerId: owner._id } });
  console.log(`\n✓ assigned ${r.modifiedCount} program(s) to ${owner.email}.`);
  console.log(`still unowned: ${await P.countDocuments(q)}`);
}
await mongoose.disconnect();
