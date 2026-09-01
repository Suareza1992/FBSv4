// One-time: give every existing library exercise an owner.
//
// The library is shared for reading — any trainer can use any exercise — but only
// the creator (or the superadmin) may edit or delete one. Exercises created before
// that rule have trainerId: null, which means superadmin-only. This stamps them so
// ownership is explicit.
//
//   node scripts/assign-exercise-owners.mjs             # DRY RUN
//   node scripts/assign-exercise-owners.mjs --apply     # writes
//
// Safe to re-run: only touches exercises with no owner, so a trainer's own
// exercises are never reassigned.
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config({ quiet: true });

const APPLY = process.argv.includes('--apply');
const OWNER_EMAIL = process.env.OWNER_EMAIL || 'fitbysuarez@gmail.com';

await mongoose.connect(process.env.MONGO_URI);
const U = mongoose.connection.collection('users');
const E = mongoose.connection.collection('exercises');

const owner = await U.findOne({ email: OWNER_EMAIL }, { projection: { _id: 1, email: 1 } });
if (!owner) { console.error(`No account for ${OWNER_EMAIL}`); process.exit(1); }

const q = { $or: [{ trainerId: null }, { trainerId: { $exists: false } }] };
const unowned = await E.countDocuments(q);

console.log(`exercises total   : ${await E.countDocuments()}`);
console.log(`without an owner  : ${unowned}`);
console.log(`would assign to   : ${owner.email}`);

if (!APPLY) {
  const sample = await E.find(q).project({ name: 1 }).limit(5).toArray();
  console.log('\nsample:');
  sample.forEach((e) => console.log(`  ${e.name}`));
  console.log('\nDRY RUN — nothing written. Re-run with --apply to save.');
} else {
  const r = await E.updateMany(q, { $set: { trainerId: owner._id } });
  console.log(`\n✓ assigned ${r.modifiedCount} exercise(s) to ${owner.email}.`);
  console.log(`still unowned: ${await E.countDocuments(q)}`);
}
await mongoose.disconnect();
