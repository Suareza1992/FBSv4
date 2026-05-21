/**
 * migrate-photos.js
 * -----------------
 * One-time script: uploads existing base64 progress photos from MongoDB
 * to Cloudinary and replaces imageData with the Cloudinary URL.
 *
 * Run ONCE from the project root:
 *   node migrate-photos.js
 *
 * Safe to re-run — photos that already have a cloudinaryPublicId are skipped.
 */

import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { v2 as cloudinary } from 'cloudinary';

// ── Cloudinary config ──────────────────────────────────────────────────────────
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── Minimal schema (only fields we need) ──────────────────────────────────────
const ProgressPhotoSchema = new mongoose.Schema({
    clientId:           mongoose.Schema.Types.ObjectId,
    date:               String,
    imageData:          String,
    cloudinaryPublicId: { type: String, default: null },
    notes:              String,
    category:           String,
    createdAt:          Date,
});
const ProgressPhoto = mongoose.model('ProgressPhoto', ProgressPhotoSchema);

// ── Helper: upload a base64 data URI to Cloudinary ────────────────────────────
const uploadBase64ToCloudinary = (base64DataUri) => new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(
        {
            folder: 'fitbysuarez/progress-photos',
            transformation: [{ quality: 'auto', fetch_format: 'auto', width: 1200, crop: 'limit' }]
        },
        (error, result) => {
            if (error) reject(error);
            else resolve(result);
        }
    ).end(Buffer.from(base64DataUri.split(',')[1], 'base64'));
});

// ── Main ──────────────────────────────────────────────────────────────────────
async function migrate() {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/fitbysuarez');
    console.log('MongoDB connected.\n');

    // Only process photos that still hold base64 (no cloudinaryPublicId yet)
    const photos = await ProgressPhoto.find({ cloudinaryPublicId: null });
    console.log(`Found ${photos.length} photo(s) to migrate.\n`);

    let success = 0, failed = 0;

    for (const photo of photos) {
        // Skip anything that doesn't look like a base64 data URI
        if (!photo.imageData?.startsWith('data:image/')) {
            console.log(`  SKIP  ${photo._id} — not a base64 image`);
            continue;
        }

        try {
            process.stdout.write(`  Uploading ${photo._id} (${photo.date}) ... `);
            const result = await uploadBase64ToCloudinary(photo.imageData);

            photo.imageData          = result.secure_url;
            photo.cloudinaryPublicId = result.public_id;
            await photo.save();

            console.log(`done → ${result.secure_url}`);
            success++;
        } catch (err) {
            console.log(`FAILED — ${err.message}`);
            failed++;
        }
    }

    console.log(`\nMigration complete. ✅ ${success} uploaded, ❌ ${failed} failed.`);
    await mongoose.disconnect();
}

migrate().catch((err) => {
    console.error('Migration error:', err);
    process.exit(1);
});
