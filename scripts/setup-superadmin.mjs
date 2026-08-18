// One-time setup for the owner account.
//   1. Grants superadmin as an ADDITIVE flag — role stays 'trainer', so the
//      account keeps its full trainer UI and its own client roster.
//   2. Claims legacy clients that have no trainerId recorded (every client
//      created before the field existed) and assigns them to the owner.
//
// Safe to re-run: idempotent, additive only, never deletes and never reassigns
// a client that already has an owner. Run with:  node scripts/setup-superadmin.mjs
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const EMAIL = 'fitbysuarez@gmail.com';
const DRY_RUN = process.argv.includes('--dry-run');

await mongoose.connect(process.env.MONGO_URI);
const U = mongoose.connection.collection('users');

const me = await U.findOne({ email: EMAIL });
if (!me) { console.error(`No account for ${EMAIL}`); process.exit(1); }

const orphanQuery = {
  role: 'client', isDeleted: { $ne: true },
  $or: [{ trainerId: null }, { trainerId: { $exists: false } }],
};
const orphans = await U.countDocuments(orphanQuery);

console.log(`account : ${EMAIL}`);
console.log(`BEFORE  : role=${me.role}  isSuperadmin=${!!me.isSuperadmin}`);
console.log(`clients without an owner: ${orphans}`);

if (DRY_RUN) {
  console.log('\n--dry-run: nothing written.');
  await mongoose.disconnect(); process.exit(0);
}

await U.updateOne({ _id: me._id }, { $set: { isSuperadmin: true } });
const r = await U.updateMany(orphanQuery, { $set: { trainerId: me._id } });

const after = await U.findOne({ _id: me._id }, { projection: { role: 1, isSuperadmin: 1 } });
console.log(`\nAFTER   : role=${after.role}  isSuperadmin=${after.isSuperadmin}`);
console.log(`assigned to you : ${r.modifiedCount}`);
console.log(`you now own     : ${await U.countDocuments({ role:'client', isDeleted:{$ne:true}, trainerId: me._id })}`);
console.log(`still unassigned: ${await U.countDocuments(orphanQuery)}`);
await mongoose.disconnect();
