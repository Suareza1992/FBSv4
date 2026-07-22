import dotenv from 'dotenv';
// Keep the parsed values: dotenv does NOT override a variable already exported in
// the shell (e.g. an empty ANTHROPIC_API_KEY), so we fall back to .env where needed.
const dotenvParsed = dotenv.config().parsed || {};
import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import cookieParser from 'cookie-parser';           // H-2: HttpOnly JWT cookie
import helmet from 'helmet';                        // H-5: Security headers
import rateLimit from 'express-rate-limit';         // H-4: Brute-force protection
import path from 'path';
import { fileURLToPath } from 'url';
// nodemailer removed — email is sent via Resend HTTP API (SMTP blocked by Railway)
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { authenticateToken, authorizeRoles } from './middleware/auth.js';
import Stripe from 'stripe';
import { v2 as cloudinary } from 'cloudinary';
import multer from 'multer';
import Anthropic from '@anthropic-ai/sdk';

// ==========================================================================
// --- CONFIGURATION ---
// ==========================================================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_ME_IN_PRODUCTION'; // NEW: JWT secret from env
// SECURITY: a missing/default JWT secret means anyone can forge admin tokens.
// Refuse to boot in production; warn loudly elsewhere so it gets fixed.
if (!process.env.JWT_SECRET || JWT_SECRET === 'CHANGE_ME_IN_PRODUCTION' || JWT_SECRET.length < 32) {
    const msg = 'FATAL: JWT_SECRET is unset, default, or too short (<32 chars). Set a long random JWT_SECRET in the environment.';
    if (process.env.NODE_ENV === 'production') { console.error(msg); throw new Error(msg); }
    console.warn('WARNING: ' + msg + ' (allowed only in non-production)');
}
const APP_URL = process.env.APP_URL || 'http://localhost:3000';         // NEW: app URL from env
const DEBUG = process.env.DEBUG === 'true'; // Set DEBUG=true in .env for local dev verbose logging

// --- STRIPE ---
const stripe = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' })
    : null;
const stripeReady = (res) => {
    if (!stripe) { res.status(503).json({ message: 'Stripe no está configurado. Agrega STRIPE_SECRET_KEY en .env.' }); return false; }
    return true;
};

// --- CLOUDINARY ---
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// --- ANTHROPIC (meal recommender) ---
// process.env wins, but fall back to the parsed .env value — dotenv won't override
// an ANTHROPIC_API_KEY that's already exported (often empty) in the shell. Null when
// truly unset so the route can 503 gracefully.
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || dotenvParsed.ANTHROPIC_API_KEY || '';
const anthropic = ANTHROPIC_KEY ? new Anthropic({ apiKey: ANTHROPIC_KEY }) : null;

// Meal recommender controls (override via env):
//  - ENABLED: set 'false' to keep the feature dark in production until launch.
//  - DAILY:   max suggestions per client per day (fairness + abuse guard).
//  - MONTHLY: hard global cap per month. At Haiku rates (~$0.005/call) 3000 ≈ $15,
//    a safety margin under a $20 budget. The Anthropic Console spend limit is the
//    ultimate backstop — this just makes us hit it gracefully (or never).
const MEAL_SUGGESTION_ENABLED = process.env.MEAL_SUGGESTION_ENABLED !== 'false';
const intEnv = (v, d) => { const n = parseInt(v, 10); return Number.isNaN(n) ? d : n; };  // keeps a real 0
const MEAL_DAILY_LIMIT   = intEnv(process.env.MEAL_DAILY_LIMIT,   5);
const MEAL_MONTHLY_LIMIT = intEnv(process.env.MEAL_MONTHLY_LIMIT, 3000);   // shared global $ cap (recommender + parser)
// Natural-language food logging ("Describir" tab). Separate flag so it can launch
// independently; its own per-client daily cap; shares the global monthly $ cap above.
const FOOD_NLP_ENABLED     = process.env.FOOD_NLP_ENABLED !== 'false';
const FOOD_NLP_DAILY_LIMIT = intEnv(process.env.FOOD_NLP_DAILY_LIMIT, 20);
// Trainer's on-demand "Revisar equipo" workout check. Own flag + per-trainer daily
// cap; shares the global monthly $ cap above.
const EQUIPMENT_CHECK_ENABLED     = process.env.EQUIPMENT_CHECK_ENABLED !== 'false';
const EQUIPMENT_CHECK_DAILY_LIMIT = intEnv(process.env.EQUIPMENT_CHECK_DAILY_LIMIT, 50);
// Nutrition-label photo scanner ("Escanear > Etiqueta"). Client photographs a
// Nutrition Facts panel; Claude vision extracts serving + macros for confirm/edit.
// Own flag + per-client daily cap; shares the global monthly $ cap above.
const FOOD_SCAN_ENABLED     = process.env.FOOD_SCAN_ENABLED !== 'false';
const FOOD_SCAN_DAILY_LIMIT = intEnv(process.env.FOOD_SCAN_DAILY_LIMIT, 10);

// Multer: store file in memory so we can stream the buffer straight to Cloudinary
const photoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
    fileFilter: (req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) return cb(new Error('Solo se permiten imágenes.'));
        cb(null, true);
    }
});

// Helper: upload a buffer to Cloudinary and return the result
const uploadToCloudinary = (buffer, options) => new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(options, (error, result) => {
        if (error) reject(error);
        else resolve(result);
    }).end(buffer);
});

// Build a public CDN URL for a progress photo (upload type — no signing needed).
// Security: the URL contains a random Cloudinary public_id (non-guessable) and
// the API endpoints that return this URL require auth, so privacy is preserved.
const getPhotoUrl = (publicId) => cloudinary.url(publicId, {
    type:   'upload',
    secure: true,
});

// Stripe webhook needs raw body for signature verification — exclude it from json parsing
app.use((req, res, next) => {
    if (req.path === '/api/stripe/webhook') return next();
    express.json({ limit: '2mb' })(req, res, next);
});
app.use(cookieParser()); // H-2: parse cookies so auth middleware can read the JWT cookie

// H-5: Security headers via Helmet
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc:     ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
            scriptSrcAttr: ["'unsafe-inline'"], // allow onclick="..." attributes (SPA uses event delegation + inline handlers)
            styleSrc:   ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com"],
            imgSrc:     ["'self'", "data:", "blob:", "https://res.cloudinary.com",
                         "https://images.unsplash.com", "https://i.pravatar.cc",
                         "https://img.youtube.com", "https://i.ytimg.com", "https://*.ytimg.com"], // YouTube thumbnails + Cloudinary profile/progress photos
            fontSrc:    ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            // openfoodfacts domains: the browser calls OFF directly for barcode
            // lookups (world.) and the "Buscar en internet" food search (search.)
            // — client's own connection: free, keyless, and no server quota.
            connectSrc: ["'self'", "https://api.nal.usda.gov", "https://cdn.jsdelivr.net", "https://world.openfoodfacts.org", "https://search.openfoodfacts.org"],
            frameSrc:   ["'self'", "https://www.youtube.com", "https://youtube.com",
                         "https://www.youtube-nocookie.com", "https://player.vimeo.com", "https://drive.google.com"],
        }
    },
    crossOriginEmbedderPolicy: false, // needed for embedded iframes
    // Allow our origin to be sent as Referer when loading YouTube iframes.
    // Helmet's default is "no-referrer" which strips the Referer header, causing
    // YouTube's player to fail with Error 153 (can't verify the embedding domain).
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
}));

// FIX: Configure CORS with allowed origins instead of allowing everything
app.use(cors({
    origin: process.env.CORS_ORIGIN || APP_URL,
    credentials: true
}));

// H-4: Rate limiters for sensitive auth endpoints
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Demasiados intentos. Intenta nuevamente en 15 minutos.' }
});
const inviteLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Demasiadas solicitudes. Intenta nuevamente más tarde.' }
});

// H-2: Helper — sets the JWT as an HttpOnly cookie (JS cannot read it)
const IS_HTTPS = APP_URL.startsWith('https');
const setAuthCookie = (res, token) => {
    res.cookie('auth_token', token, {
        httpOnly: true,
        secure: IS_HTTPS,
        sameSite: IS_HTTPS ? 'strict' : 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });
};

app.use(express.static('public'));

// --- DEBUGGING (only printed when DEBUG=true in .env) ---
if (DEBUG) {
    console.log("Resend key loaded:", process.env.RESEND_API_KEY ? "YES" : "NO");
    console.log("Trainer email (GMAIL_USER):", process.env.GMAIL_USER || "Not Set");
}

// --- MONGODB CONNECTION ---
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/fitbysuarez')
.then(async () => {
    console.log('MongoDB Conectado');
    await seedAdmin();
})
.catch(err => console.error('Error de MongoDB:', err));

// --- SEED ADMIN/TRAINER ACCOUNT ---
async function seedAdmin() {
    const adminEmail = 'fitbysuarez@gmail.com';
    try {
        const exists = await mongoose.connection.collection('users').findOne({ email: adminEmail });
        if (!exists) {
            // FIX: Use env variable instead of hardcoded password
            const adminPassword = process.env.ADMIN_SEED_PASSWORD;
            if (!adminPassword) {
                console.error('ADMIN_SEED_PASSWORD not set in .env — skipping admin seed.');
                return;
            }
            const hashedPassword = await bcrypt.hash(adminPassword, 10);
            await mongoose.connection.collection('users').insertOne({
                name: 'Coach Suarez',
                lastName: '',
                email: adminEmail,
                password: hashedPassword,
                role: 'trainer',
                program: 'Sin Asignar',
                group: 'General',
                type: 'Remoto',
                dueDate: '',
                isActive: true,
                isFirstLogin: false,
                isDeleted: false,
                location: '',
                timezone: 'America/Puerto_Rico',
                unitSystem: 'imperial',
                hideFromDashboard: false,
                height: { feet: 0, inches: 0 },
                weight: 0,
                birthday: '',
                gender: '',
                phone: '',
                emailPreferences: { dailyRoutine: true, incompleteRoutine: false },
                createdAt: new Date()
            });
            console.log('Admin/Trainer account seeded: fitbysuarez@gmail.com');
        } else {
            console.log('Admin/Trainer account already exists — skipping seed.');
        }
    } catch (err) {
        console.error('Error seeding admin:', err);
    }

    // Seed default group
    try {
        const groupsCol = mongoose.connection.collection('groups');
        const exists = await groupsCol.findOne({ name: 'General' });
        if (!exists) {
            await groupsCol.insertOne({ name: 'General', createdAt: new Date() });
            console.log('Default group "General" seeded.');
        }
    } catch (err) {
        console.error('Error seeding default group:', err);
    }
}

// =============================================================================
// 1. DATABASE SCHEMAS
// =============================================================================
const UserSchema = new mongoose.Schema({
    name: { type: String, required: true },
    lastName: { type: String, default: "" },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, default: 'client' },
    program: { type: String, default: "Sin Asignar" },
    // Live link to the assigned program so edits to it can re-sync this client's
    // calendar. Set when a program is pushed to the calendar; cleared on unassign.
    assignedProgram: {
        programId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Program', default: null },
        startDate:    { type: String, default: null },  // YYYY-MM-DD that grid day `anchorOffset` mapped to
        anchorOffset: { type: Number, default: 0 },     // global grid index anchored to startDate
    },
    group: { type: String, default: "General" },
    type: { type: String, default: "Remoto" },
    dueDate: { type: String, default: "" },
    isActive: { type: Boolean, default: true },
    isFirstLogin: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },
    // Daily "active day" streak (Duolingo-style) — updated by POST /api/me/active.
    lastActiveDate: { type: String, default: null },   // YYYY-MM-DD of last app open
    activityStreak: { type: Number, default: 0 },      // consecutive active days
    longestStreak:  { type: Number, default: 0 },      // best run ever
    location: { type: String, default: "" },
    timezone: { type: String, default: "America/Puerto_Rico" },
    unitSystem: { type: String, default: "imperial" },
    servingUnit: { type: String, default: "g" }, // 'g' or 'oz' — client's preferred food serving unit
    hideFromDashboard: { type: Boolean, default: false },
    height: { feet: { type: Number, default: 0 }, inches: { type: Number, default: 0 } },
    weight: { type: Number, default: 0 },
    birthday: { type: String, default: "" },
    gender: { type: String, default: "" },
    restingHr: { type: Number, default: null },
    thr: { type: Number, default: null },
    mahr: { type: Number, default: null },
    phone: { type: String, default: "" },
    emailPreferences: { dailyRoutine: { type: Boolean, default: true }, incompleteRoutine: { type: Boolean, default: false } },
    profilePicture: { type: String, default: "" },
    equipment: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Per-client toggle for the trainer's AI "Revisar equipo" workout check.
    // When false, the check is skipped entirely (no flags) — e.g. for full-gym clients.
    equipmentCheckOn: { type: Boolean, default: true },
    injuredMuscles: { type: mongoose.Schema.Types.Mixed, default: {} },
    dietaryPreferences: {
        dietType:  { type: String,   default: '' },  // '' | omnivoro | vegetariano | vegano | pescetariano | keto | paleo | otro
        allergies: { type: [String], default: [] },  // e.g. ['Mariscos','Maní'] — never recommend these
        dislikes:  { type: [String], default: [] },  // foods to avoid recommending (preference, not safety)
        notes:     { type: String,   default: '' },  // free-text catch-all for the meal recommender
    },
    macroSettings: {
        goal:         { type: String, default: 'maintain' }, // maintain | cut250 | cut500 | bulk250 | bulk500
        proteinRatio: { type: Number, default: 0.4 },
        fatRatio:     { type: Number, default: 0.3 },
        carbRatio:    { type: Number, default: 0.3 },
        targetCal:    { type: Number, default: 0 },
        goalProtein:  { type: Number, default: 0 },
        goalCarbs:    { type: Number, default: 0 },
        goalFat:      { type: Number, default: 0 },
    },
    waterGoal: { type: Number, default: 64 }, // oz per day
    paymentHandles: {
        athMovil: { type: String, default: '' }, // ATH Móvil Business name / @handle
        venmo:    { type: String, default: '' }, // Venmo @handle (without @)
        paypal:   { type: String, default: '' }, // PayPal.me username (without paypal.me/)
    },
    createdAt: { type: Date, default: Date.now },
    resetPasswordToken: String,
    resetPasswordExpires: Date,
    inviteToken: String,
    inviteExpires: Date,
    stripeCustomerId: { type: String, default: null },  // Stripe customer ID for this client
});
const User = mongoose.model('User', UserSchema);

const ExerciseSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    videoUrl: { type: String, default: "" },
    category: { type: [String], default: ["General"] },
    instructions: { type: String, default: "" },
    muscleGroupId: { type: String, default: "" },
    origin: { type: String, default: "" },
    insertion: { type: String, default: "" },
    pushPull: { type: String, enum: ['push', 'pull', 'both', ''], default: "" },
    lastUpdated: { type: Date, default: Date.now }
});
const Exercise = mongoose.model('Exercise', ExerciseSchema);

const WorkoutLogSchema = new mongoose.Schema({
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    date: { type: String, required: true },
    programName: String,
    exercises: [{ name: String, completed: { type: Boolean, default: false }, notes: String }],
    isComplete: { type: Boolean, default: false }
});
const WorkoutLog = mongoose.model('WorkoutLog', WorkoutLogSchema);

const ClientWorkoutSchema = new mongoose.Schema({
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    date:     { type: String, required: true },
    title:    { type: String, default: 'Workout' },
    isRest:   { type: Boolean, default: false },
    restType: { type: String, default: '' },          // 'rest' | 'active_rest'

    // ── Program provenance (for auto-sync when the program is edited) ────────────
    // Set when this day was created by pushing a program. null sourceProgramId =
    // a manually-added/standalone day, which auto-sync must NEVER touch.
    sourceProgramId: { type: mongoose.Schema.Types.ObjectId, ref: 'Program', default: null },
    sourceWeek:      { type: Number, default: null },  // 0-based week index in the program grid
    sourceDayNum:    { type: Number, default: null },  // 1..7 day-of-week slot in the program grid
    // True once a trainer hand-edits this client's day after assignment, so a
    // later program re-sync preserves the custom version instead of overwriting.
    manualEdit:      { type: Boolean, default: false },

    // ── Warmup ─────────────────────────────────────────────────────────────────
    warmup:        { type: String, default: '' },     // general instructions text
    warmupVideoUrl:{ type: String, default: '' },     // section-level video (legacy)
    warmupItems: [{                                   // individual warmup exercises
        id:       Number,
        name:     { type: String, default: '' },
        videoUrl: { type: String, default: '' },
    }],

    // ── Exercises ──────────────────────────────────────────────────────────────
    exercises: [{
        id:           Number,
        name:         { type: String, default: '' },
        instructions: { type: String, default: '' },  // trainer's prescribed sets/reps/etc.
        results:      { type: String, default: '' },  // client's logged results
        videoUrl:     { type: String, default: '' },
        isSuperset:   { type: Boolean, default: false },
        supersetHead: { type: Boolean, default: false },
        isComplete:   { type: Boolean, default: false }, // per-exercise completion by client
        // Per-exercise effort rating logged by the client alongside their results.
        // Independent of the day-level `rpe` below (which rates the whole session).
        rpe:          { type: Number, min: 1, max: 10, default: null },
    }],

    // ── Cooldown ───────────────────────────────────────────────────────────────
    cooldown:        { type: String, default: '' },   // general instructions text
    cooldownVideoUrl:{ type: String, default: '' },   // section-level video (legacy)
    cooldownItems: [{                                 // individual cooldown exercises
        id:       Number,
        name:     { type: String, default: '' },
        videoUrl: { type: String, default: '' },
    }],

    // ── Client feedback ────────────────────────────────────────────────────────
    rpe:        { type: Number, min: 1, max: 10, default: null },
    mood:       { type: String, default: '' },        // client's mood for the day
    isComplete: { type: Boolean, default: false },
    isMissed:   { type: Boolean, default: false },

    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});
ClientWorkoutSchema.index({ clientId: 1, date: 1 }, { unique: true });
ClientWorkoutSchema.index({ clientId: 1, sourceProgramId: 1 }); // fast lookup during program re-sync
const ClientWorkout = mongoose.model('ClientWorkout', ClientWorkoutSchema);

const ProgramSchema = new mongoose.Schema({
    name: { type: String, required: true },
    description: { type: String, default: "" },
    tags: { type: String, default: "General" },
    weeks: [{
        weekNumber: Number,
        days: { type: Map, of: mongoose.Schema.Types.Mixed }
    }],
    clientCount: { type: Number, default: 0 },
    createdBy: { type: String, default: "trainer" },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});
const Program = mongoose.model('Program', ProgramSchema);

// --- Notification Schema ---
const NotificationSchema = new mongoose.Schema({
    trainerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    clientId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    clientName: { type: String, required: true },
    type: {
        type: String,
        enum: [
            'workout_completed', 'workout_missed',
            'metric_resistance', 'nutrition_logged',
            'progress_photos', 'weight_update',
            'workout_comment', 'video_upload',
            'reported_issue', 'metric_inactivity',
            'program_assigned', 'client_created', 'rpe_submitted',
            'contact_inquiry', 'muscle_restriction', 'equipment_updated'
        ],
        required: true
    },
    title:   { type: String, required: true },
    message: { type: String, default: '' },
    data:    { type: mongoose.Schema.Types.Mixed, default: {} },
    isRead:  { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
});
NotificationSchema.index({ trainerId: 1, isRead: 1, createdAt: -1 });
const Notification = mongoose.model('Notification', NotificationSchema);

// --- Weight/Metrics Log Schema ---
const WeightLogSchema = new mongoose.Schema({
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: String, required: true },
    weight: { type: Number, required: true },
    bodyFat: { type: Number, default: null },
    notes: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now }
});
WeightLogSchema.index({ clientId: 1, date: -1 });
const WeightLog = mongoose.model('WeightLog', WeightLogSchema);

// --- Nutrition Log Schema ---
const NutritionLogSchema = new mongoose.Schema({
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: String, required: true },
    calories: { type: Number, default: 0 },
    protein: { type: Number, default: 0 },
    carbs: { type: Number, default: 0 },
    fat: { type: Number, default: 0 },
    water: { type: Number, default: 0 },
    notes: { type: String, default: '' },
    mood: { type: String, default: '' },
    meals: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Extra exercise the client logged beyond their plan (e.g. a long run).
    // `exercise` holds the detail [{name, calories}]; `exerciseCalories` is the
    // total burned, used to widen the day's calorie budget.
    exercise: { type: mongoose.Schema.Types.Mixed, default: [] },
    exerciseCalories: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
});
NutritionLogSchema.index({ clientId: 1, date: -1 });
const NutritionLog = mongoose.model('NutritionLog', NutritionLogSchema);

// Reusable meal combos a client saves to re-log identical meals in one tap.
// Stores each ingredient individually so the client can edit before re-adding.
const SavedMealSchema = new mongoose.Schema({
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name:     { type: String, required: true },
    mealSlot: { type: String, default: '' }, // which meal it was saved from (e.g. "Desayuno")
    foods: [{
        name: String, calories: Number, protein: Number, carbs: Number, fat: Number,
        servingAmount: Number, servingUnit: String,
    }],
}, { timestamps: true });
SavedMealSchema.index({ clientId: 1, createdAt: -1 });
const SavedMeal = mongoose.model('SavedMeal', SavedMealSchema);

// Meal-recommender usage counters for cost caps: one 'global' doc per month and
// one 'client' doc per client per day. Drives the daily + monthly limits.
const AiUsageSchema = new mongoose.Schema({
    scope:    { type: String, required: true },                                  // 'global' | 'client'
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    period:   { type: String, required: true },                                  // 'YYYY-MM' (global) | 'YYYY-MM-DD' (client)
    count:    { type: Number, default: 0 },
});
AiUsageSchema.index({ scope: 1, clientId: 1, period: 1 }, { unique: true });
const AiUsage = mongoose.model('AiUsage', AiUsageSchema);

// --- Body Measurement Log Schema ---
const BodyMeasurementSchema = new mongoose.Schema({
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: String, required: true },
    weight: { type: Number, default: null },
    bodyFat: { type: Number, default: null },
    bmi: { type: Number, default: null },
    pecho: { type: String, default: '' },
    biceps: { type: String, default: '' },
    cintura: { type: String, default: '' },
    cadera: { type: String, default: '' },
    quads: { type: String, default: '' },
    calves: { type: String, default: '' },
    notes: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now }
});
BodyMeasurementSchema.index({ clientId: 1, date: 1 });
const BodyMeasurement = mongoose.model('BodyMeasurement', BodyMeasurementSchema);

// --- Progress Photo Schema ---
const ProgressPhotoSchema = new mongoose.Schema({
    clientId:           { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    date:               { type: String, required: true },
    imageData:          { type: String, required: true }, // Cloudinary secure_url (legacy docs may hold base64)
    cloudinaryPublicId: { type: String, default: null },  // used to delete from Cloudinary on photo delete
    notes:              { type: String, default: '' },
    category:           { type: String, default: 'general' },
    createdAt:          { type: Date, default: Date.now }
});
ProgressPhotoSchema.index({ clientId: 1, date: -1 });
const ProgressPhoto = mongoose.model('ProgressPhoto', ProgressPhotoSchema);

// --- Shared Food Library Schema ---
// Stores foods logged manually or from search, shared across all platform users.
const FoodLibrarySchema = new mongoose.Schema({
    name:      { type: String, required: true },
    nameNorm:  { type: String, required: true },   // accent-stripped lowercase, used for dedup + search
    calories:  { type: Number, default: 0 },        // macros per unit / per serving as logged
    protein:   { type: Number, default: 0 },
    carbs:     { type: Number, default: 0 },
    fat:       { type: Number, default: 0 },
    timesUsed: { type: Number, default: 1 },       // popularity counter
    updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });
FoodLibrarySchema.index({ nameNorm: 1 }, { unique: true });
const FoodLibrary = mongoose.model('FoodLibrary', FoodLibrarySchema);

// --- Personal Food Library Schema ---
// Per-client foods they've logged and manually saved for reuse (not shared).
const PersonalFoodLibrarySchema = new mongoose.Schema({
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true },
    calories: { type: Number, default: 0 },
    protein: { type: Number, default: 0 },
    carbs: { type: Number, default: 0 },
    fat: { type: Number, default: 0 },
    servingSize: { type: Number, default: 100 },      // grams or units
    servingUnit: { type: String, default: 'g' },      // g, oz, portions, etc.
    timesUsed: { type: Number, default: 1 },          // self-learning counter
    submittedToCommunity: { type: Boolean, default: false },
    communityFoodId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodLibrary', default: null },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });
PersonalFoodLibrarySchema.index({ clientId: 1, createdAt: -1 });
PersonalFoodLibrarySchema.index({ clientId: 1, name: 1 }, { unique: true });
const PersonalFoodLibrary = mongoose.model('PersonalFoodLibrary', PersonalFoodLibrarySchema);

// --- Blog Post Schema ---
const BlogPostSchema = new mongoose.Schema({
    title:       { type: String, required: true },
    slug:        { type: String, required: true, unique: true },
    category:    { type: String, default: 'General' },
    excerpt:     { type: String, default: '' },
    content:     { type: String, required: true },
    published:   { type: Boolean, default: false },
    publishedAt: { type: Date },
}, { timestamps: true });
const BlogPost = mongoose.model('BlogPost', BlogPostSchema);

// --- Group Schema ---
const GroupSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now }
});
const Group = mongoose.model('Group', GroupSchema);

// --- Payment / Invoice Schema ---
const PaymentSchema = new mongoose.Schema({
    clientId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    trainerId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount:      { type: Number, required: true },                             // in USD
    status:      { type: String, enum: ['pending', 'paid', 'overdue'], default: 'pending' },
    method:      { type: String, default: '' },                               // 'ath_movil' | 'venmo' | 'paypal' | 'cash' | 'other'
    periodLabel: { type: String, default: '' },                               // e.g. "Mayo 2026"
    dueDate:     { type: String, required: true },                            // YYYY-MM-DD
    paidDate:    { type: String, default: null },                             // YYYY-MM-DD when marked paid
    notes:       { type: String, default: '' },
    createdAt:   { type: Date, default: Date.now },
    // ── Stripe fields ──────────────────────────────────────────────────────────
    type:                    { type: String, enum: ['manual','subscription','one_time','stripe_invoice','trial'], default: 'manual' },
    planLabel:               { type: String, default: '' },         // e.g. "Monthly Coaching Plan"
    stripeCheckoutSessionId: { type: String, default: null },
    stripePaymentIntentId:   { type: String, default: null },
    stripeSubscriptionId:    { type: String, default: null },
    stripeInvoiceId:         { type: String, default: null },
    stripePaymentLink:       { type: String, default: null },       // Hosted Checkout / Invoice URL
    trialDays:               { type: Number, default: 0 },
    // ── PayPal fields ──────────────────────────────────────────────────────────
    paypalOrderId:           { type: String, default: null },       // one-time order id
    paypalSubscriptionId:    { type: String, default: null },       // recurring subscription id
    paypalSaleId:            { type: String, default: null },       // per-cycle sale id (dedupes renewals)
});
PaymentSchema.index({ trainerId: 1, dueDate: -1 });
const Payment = mongoose.model('Payment', PaymentSchema);

// Carries self-serve signup details across the PayPal approval redirect (TTL 24h).
const PendingSignupSchema = new mongoose.Schema({
    ref:       { type: String, required: true, unique: true }, // PayPal order id OR subscription id
    kind:      { type: String, enum: ['order', 'subscription'], required: true },
    name:      { type: String, default: '' },
    lastName:  { type: String, default: '' },
    email:     { type: String, required: true },
    planId:    { type: String, required: true },
    createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 },
});
const PendingSignup = mongoose.model('PendingSignup', PendingSignupSchema);

// Tiny key/value store — caches the lazily-created PayPal billing plan id.
const AppSettingSchema = new mongoose.Schema({ key: { type: String, unique: true }, value: String });
const AppSetting = mongoose.model('AppSetting', AppSettingSchema);

// =============================================================================
// 2. API ROUTES
// =============================================================================

// --- Helper: Send email via Resend API ---
const sendEmail = async ({ from, to, subject, html, text, replyTo }) => {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error('RESEND_API_KEY is not set in environment variables.');
    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            from: from || 'FitBySuárez <noreply@fitbysuarez.com>',
            to: Array.isArray(to) ? to : [to],
            subject,
            html,
            ...(text ? { text } : {}),
            ...(replyTo ? { reply_to: replyTo } : {})
        })
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `Resend error ${res.status}`);
    }
    return res.json();
};

// --- Helper: Validate password strength ---
const validatePassword = (pw) => {
    if (!pw || pw.length < 8)      return 'La contraseña debe tener al menos 8 caracteres.';
    if (!/[a-zA-Z]/.test(pw))      return 'La contraseña debe incluir al menos una letra.';
    if (!/[0-9]/.test(pw))         return 'La contraseña debe incluir al menos un número.';
    if (!/[^a-zA-Z0-9]/.test(pw))  return 'La contraseña debe incluir al menos un carácter especial (!@#$%...).';
    return null; // null = valid
};

// --- Helper: Generate random password ---
const generateTempPassword = () => {
    return crypto.randomBytes(4).toString('hex'); // 8-char random string like "a3f1b9c2"
};

// --- Helper: Create a notification for the trainer ---
const createNotification = async ({ clientId, clientName, type, title, message, data }) => {
    try {
        const trainer = await User.findOne({ role: 'trainer' });
        if (!trainer) { console.warn('No trainer found for notification'); return; }

        await Notification.create({
            trainerId: trainer._id,
            clientId,
            clientName,
            type,
            title,
            message: message || '',
            data: data || {}
        });
        if (DEBUG) console.log(`Notification created: ${type} for ${clientName}`);
    } catch (err) {
        console.error('Error creating notification:', err);
    }
};

// ==========================================================================
// --- PUBLIC AUTH ROUTES (No token required) ---
// ==========================================================================

// Option C: Self-registration is disabled. Accounts are created by the trainer via invitation only.
app.post('/api/auth/register', (req, res) => {
    return res.status(403).json({ message: 'El registro público está deshabilitado. Contacta a tu entrenador para recibir una invitación.' });
});

// H-2+H-4: Login sets an HttpOnly cookie (token never exposed to JS) + rate limited
app.post('/api/auth/login', authLimiter, async (req, res) => {
    try {
        const { email, password } = req.body;
        // Reject non-string inputs explicitly (defense-in-depth vs. NoSQL operator
        // injection like { "$gt": "" }).
        if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
            return res.status(400).json({ message: 'Email and password are required' });
        }

        const user = await User.findOne({ email: email.toLowerCase().trim() });
        if (!user) return res.status(400).json({ message: 'Invalid credentials' });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ message: 'Invalid credentials' });

        const tokenPayload = { id: user._id, email: user.email, role: user.role };
        const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '7d' });

        // H-2: Set HttpOnly cookie — JS cannot read this, so XSS can't steal it
        setAuthCookie(res, token);

        res.json({
            message: 'Login successful',
            // token intentionally omitted — delivered via cookie only
            user: {
                id: user._id,
                name: user.name,
                lastName: user.lastName,
                email: user.email,
                role: user.role,
                isFirstLogin: user.isFirstLogin,
                profilePicture: user.profilePicture || ''
            }
        });
    } catch (error) { res.status(500).json({ message: 'Server error' }); }
});

// H-2: Logout — clears the auth cookie server-side
app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('auth_token', { httpOnly: true, secure: IS_HTTPS, sameSite: IS_HTTPS ? 'strict' : 'lax' });
    res.json({ message: 'Logged out' });
});

// ==========================================================================
// --- PASSWORD RECOVERY SYSTEM (Public — no token required) ---
// ==========================================================================

// FIX: Removed require() calls, using top-level imports. Fixed createTransporter typo.
app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
    try {
        const { email } = req.body;
        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user) {
            // Don't reveal whether the email exists
            return res.json({ message: 'Si existe una cuenta con ese email, recibiras un enlace de recuperacion.' });
        }

        // Generate reset token and hash it before storing
        const resetToken = crypto.randomBytes(32).toString('hex');
        const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');
        const resetTokenExpiry = Date.now() + 3600000; // 1 hour

        user.resetPasswordToken = hashedToken; // FIX: Store hashed token, not plaintext
        user.resetPasswordExpires = resetTokenExpiry;
        await user.save();

        // Send the RAW token in the email (user clicks link with raw token)
        const resetLink = `${APP_URL}/?token=${resetToken}`;
        const mailOptions = {
            from: 'FitBySuárez <noreply@fitbysuarez.com>',
            to: email,
            subject: 'Recuperación de Contraseña - FitBySuárez',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                    <div style="text-align: center; margin-bottom: 30px;">
                        <h1 style="color: #5e2d91; margin: 0;">FitBySuarez</h1>
                    </div>
                    <div style="background: #f9fafb; border-radius: 10px; padding: 30px;">
                        <h2 style="color: #111827; margin-top: 0;">Recuperacion de Contrasena</h2>
                        <p style="color: #4b5563; line-height: 1.6;">Hola ${user.name},</p>
                        <p style="color: #4b5563; line-height: 1.6;">Recibimos una solicitud para restablecer tu contrasena. Haz clic en el boton de abajo para crear una nueva contrasena:</p>
                        <div style="text-align: center; margin: 30px 0;">
                            <a href="${resetLink}" style="display: inline-block; background: linear-gradient(to right, #5e2d91, #3b82f6); color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: bold;">Restablecer Contrasena</a>
                        </div>
                        <p style="color: #6b7280; font-size: 14px; line-height: 1.6;">O copia y pega este enlace en tu navegador:</p>
                        <p style="color: #3b82f6; word-break: break-all; font-size: 12px; background: white; padding: 10px; border-radius: 5px;">${resetLink}</p>
                        <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
                            <p style="color: #ef4444; font-size: 14px; margin: 0;">Este enlace expira en 1 hora</p>
                        </div>
                        <p style="color: #6b7280; font-size: 14px; margin-top: 20px;">Si no solicitaste restablecer tu contrasena, ignora este email.</p>
                    </div>
                    <div style="text-align: center; margin-top: 30px; color: #9ca3af; font-size: 12px;">
                        <p>FitBySuarez - Tu plataforma de entrenamiento personalizado</p>
                    </div>
                </div>
            `
        };

        await sendEmail(mailOptions);
        res.json({ message: 'Enlace de recuperacion enviado a tu email' });
    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({ message: 'Error al procesar solicitud' });
    }
});

// FIX: Hash the new password with bcrypt before saving (was storing plaintext!)
// FIX: Compare incoming token against stored hash
app.post('/api/auth/reset-password', async (req, res) => {
    try {
        const { token, newPassword } = req.body;

        const pwError = validatePassword(newPassword);
        if (pwError) return res.status(400).json({ message: pwError });

        // Hash the incoming token to compare against stored hash
        const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

        // C-4: Atomically find AND clear the token in one operation — prevents replay attacks.
        // findOneAndUpdate with { new: false } returns the doc BEFORE the update.
        // If two concurrent requests arrive, only one will match (the other gets null).
        const user = await User.findOneAndUpdate(
            { resetPasswordToken: hashedToken, resetPasswordExpires: { $gt: Date.now() } },
            { $unset: { resetPasswordToken: 1, resetPasswordExpires: 1 } },
            { new: false }
        );

        if (!user) {
            return res.status(400).json({ message: 'El enlace de recuperacion es invalido o ha expirado' });
        }

        // Token was valid — now safely set the new password
        const hashed = await bcrypt.hash(newPassword, 10);
        await User.findByIdAndUpdate(user._id, { password: hashed, isFirstLogin: false });

        res.json({ message: 'Contrasena actualizada exitosamente' });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({ message: 'Error al actualizar contrasena' });
    }
});

// ==========================================================================
// --- INVITE SYSTEM (Public — no token required) ---
// ==========================================================================

// Returns the name and email for a valid invite token (used to pre-fill the setup card)
app.get('/api/auth/invite-info', async (req, res) => {
    try {
        const { token } = req.query;
        if (!token) return res.status(400).json({ message: 'Token requerido' });

        const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
        const user = await User.findOne({
            inviteToken: hashedToken,
            inviteExpires: { $gt: Date.now() }
        });

        if (!user) return res.status(400).json({ message: 'Invitación inválida o expirada' });

        res.json({ name: user.name, email: user.email });
    } catch (error) {
        console.error('Invite info error:', error);
        res.status(500).json({ message: 'Error al verificar invitación' });
    }
});

// Client accepts invite: validates token, sets their chosen password, auto-logs them in
app.post('/api/auth/accept-invite', inviteLimiter, async (req, res) => {
    try {
        const { token, password } = req.body;

        const pwError = validatePassword(password);
        if (pwError) return res.status(400).json({ message: pwError });

        const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
        const user = await User.findOne({
            inviteToken: hashedToken,
            inviteExpires: { $gt: Date.now() }
        });

        if (!user) return res.status(400).json({ message: 'Invitación inválida o expirada' });

        user.password = await bcrypt.hash(password, 10);
        user.inviteToken = undefined;
        user.inviteExpires = undefined;
        user.isFirstLogin = false;
        await user.save();

        // Auto-login: set HttpOnly cookie so client lands directly in their dashboard
        const tokenPayload = { id: user._id, email: user.email, role: user.role };
        const jwtToken = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '7d' });
        setAuthCookie(res, jwtToken);

        res.json({
            message: 'Cuenta activada exitosamente',
            // token intentionally omitted — delivered via cookie only
            user: {
                id: user._id,
                name: user.name,
                lastName: user.lastName,
                email: user.email,
                role: user.role,
                isFirstLogin: false,
                profilePicture: user.profilePicture || ''
            }
        });
    } catch (error) {
        console.error('Accept invite error:', error);
        res.status(500).json({ message: 'Error al activar cuenta' });
    }
});

// ==========================================================================
// --- PROTECTED AUTH ROUTES (Token required) ---
// ==========================================================================

// FIX: Now uses req.user.id from JWT instead of trusting userId from body
app.post('/api/auth/update-password', authenticateToken, async (req, res) => {
    try {
        const { newPassword } = req.body;
        const pwError = validatePassword(newPassword);
        if (pwError) return res.status(400).json({ message: pwError });
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await User.findByIdAndUpdate(req.user.id, { password: hashedPassword, isFirstLogin: false });
        res.json({ message: 'Password updated successfully' });
    } catch (error) { res.status(500).json({ message: 'Error updating password' }); }
});

// ==========================================================================
// --- PROTECTED: Send Welcome Email (Trainer only) ---
// ==========================================================================

app.post('/api/send-welcome', authenticateToken, authorizeRoles('trainer', 'admin'), async (req, res) => {
    const { email, name, password } = req.body;
    const mailOptions = {
        from: 'FitBySuárez <noreply@fitbysuarez.com>',
        to: email,
        subject: 'Bienvenido a FitBySuarez',
        text: `Hola ${name},\n\nTu cuenta ha sido creada.\nAccede: ${APP_URL}\nUsuario: ${email}\nContrasena temporal: ${password}\n\nPor favor cambia tu contrasena al iniciar sesion.`,
        html: `
            <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #5e2d91;">Bienvenido a FitBySuarez!</h2>
                <p>Hola ${name},</p>
                <p>Tu cuenta ha sido creada. Aqui estan tus credenciales:</p>
                <div style="background: #f9fafb; padding: 20px; border-radius: 8px; margin: 20px 0;">
                    <p><strong>Usuario:</strong> ${email}</p>
                    <p><strong>Contrasena temporal:</strong> ${password}</p>
                </div>
                <p style="color: #ef4444; font-weight: bold;">Por favor cambia tu contrasena al iniciar sesion por primera vez.</p>
                <a href="${APP_URL}" style="display: inline-block; background: #5e2d91; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold; margin-top: 10px;">Ir a la App</a>
            </div>
        `
    };

    try {
        await sendEmail(mailOptions);
        res.status(200).json({ success: true, message: 'Email sent' });
    } catch (error) {
        console.error("Email Error:", error);
        res.status(500).json({ success: false, message: 'Failed to send email', error: error.toString() });
    }
});

// ==========================================================================
// --- PROTECTED: User Profile (Any authenticated user) ---
// ==========================================================================

app.get('/api/me', authenticateToken, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('-password -resetPasswordToken -resetPasswordExpires');
        if (!user) return res.status(404).json({ message: 'User not found' });
        // Surface which AI features are live, so the client UI can hide their entry points.
        res.json({
            ...user.toObject(),
            mealSuggestionEnabled: MEAL_SUGGESTION_ENABLED && !!anthropic,
            foodNlpEnabled:        FOOD_NLP_ENABLED && !!anthropic,
            foodScanEnabled:       FOOD_SCAN_ENABLED && !!anthropic,
        });
    } catch (error) {
        console.error('Error fetching profile:', error);
        res.status(500).json({ message: 'Error fetching profile' });
    }
});

// Record an "active day" and return the streak. Idempotent per day. The client
// sends its LOCAL date so the streak respects the user's timezone, not the server's.
app.post('/api/me/active', authenticateToken, async (req, res) => {
    try {
        const today = (typeof req.body?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date))
            ? req.body.date
            : new Date().toISOString().split('T')[0];
        const user = await User.findById(req.user.id).select('lastActiveDate activityStreak longestStreak');
        if (!user) return res.status(404).json({ message: 'User not found' });

        if (user.lastActiveDate !== today) {
            // Yesterday, computed in UTC on the date string (timezone-safe).
            const d = new Date(today + 'T00:00:00Z');
            d.setUTCDate(d.getUTCDate() - 1);
            const yesterday = d.toISOString().split('T')[0];

            user.activityStreak = (user.lastActiveDate === yesterday) ? (user.activityStreak || 0) + 1 : 1;
            user.lastActiveDate = today;
            user.longestStreak = Math.max(user.longestStreak || 0, user.activityStreak);
            await user.save();
        }
        res.json({ activityStreak: user.activityStreak, longestStreak: user.longestStreak, lastActiveDate: user.lastActiveDate });
    } catch (error) {
        console.error('Error updating activity streak:', error);
        res.status(500).json({ message: 'Error updating activity' });
    }
});

app.put('/api/me', authenticateToken, async (req, res) => {
    try {
        // Safe profile fields any authenticated user can update
        // profilePicture is no longer accepted here — use POST /api/me/profile-picture instead
        const allowedFields = ['name', 'lastName', 'unitSystem', 'timezone', 'servingUnit', 'injuredMuscles', 'dietaryPreferences', 'restingHr'];
        const updates = {};
        for (const key of allowedFields) {
            if (req.body[key] !== undefined) updates[key] = req.body[key];
        }
        // Allow clients to persist their own macro gram goals without overwriting
        // the trainer-computed ratios / calorie target / goal type.
        // Dot-notation keys make Mongoose only touch these three sub-fields.
        if (req.body.macroGoals) {
            const mg = req.body.macroGoals;
            if (mg.goalProtein !== undefined) updates['macroSettings.goalProtein'] = Number(mg.goalProtein);
            if (mg.goalCarbs   !== undefined) updates['macroSettings.goalCarbs']   = Number(mg.goalCarbs);
            if (mg.goalFat     !== undefined) updates['macroSettings.goalFat']     = Number(mg.goalFat);
        }
        // Trainer payment collection handles (ATH Móvil, Venmo, PayPal)
        if (req.body.paymentHandles && req.user.role === 'trainer') {
            const ph = req.body.paymentHandles;
            if (ph.athMovil !== undefined) updates['paymentHandles.athMovil'] = ph.athMovil.trim();
            if (ph.venmo    !== undefined) updates['paymentHandles.venmo']    = ph.venmo.replace('@', '').trim();
            if (ph.paypal   !== undefined) updates['paymentHandles.paypal']   = ph.paypal.trim();
        }
        const user = await User.findByIdAndUpdate(req.user.id, updates, { new: true })
            .select('-password -resetPasswordToken -resetPasswordExpires');

        // Notify trainer when a client updates their muscle restrictions
        if (req.body.injuredMuscles !== undefined && req.user.role === 'client') {
            const flagged = Object.entries(req.body.injuredMuscles || {}).filter(([, v]) => v);
            const flagCount = flagged.length;
            const clientName = `${user.name || ''}${user.lastName ? ' ' + user.lastName : ''}`.trim() || user.email;
            await createNotification({
                clientId: user._id,
                clientName,
                type: 'muscle_restriction',
                title: `${clientName} actualizó sus restricciones`,
                message: flagCount > 0
                    ? `${flagCount} grupo${flagCount > 1 ? 's' : ''} muscular${flagCount > 1 ? 'es' : ''} con restricción.`
                    : 'Restricciones eliminadas.',
                data: { injuredMuscles: req.body.injuredMuscles }
            });
        }

        res.json(user);
    } catch (error) {
        console.error('Error updating profile:', error);
        res.status(500).json({ message: 'Error updating profile' });
    }
});

// Profile picture upload — dedicated Cloudinary endpoint
// Keeps binary upload separate from the JSON settings route
app.post('/api/me/profile-picture', authenticateToken, photoUpload.single('photo'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ message: 'No se recibió ninguna imagen.' });

        // Deterministic public_id per user — re-uploading replaces the old photo, never accumulates
        const result = await uploadToCloudinary(req.file.buffer, {
            folder:      'fitbysuarez/profile-pictures',
            public_id:   `user_${req.user.id}`,
            overwrite:   true,
            invalidate:  true,   // bust CDN cache so the new photo appears immediately
            transformation: [{ quality: 'auto', fetch_format: 'auto', width: 400, height: 400, crop: 'fill', gravity: 'face' }]
        });

        await User.findByIdAndUpdate(req.user.id, { profilePicture: result.secure_url });
        res.json({ profilePicture: result.secure_url });
    } catch (e) {
        console.error('Error uploading profile picture:', e.message);
        res.status(500).json({ message: 'Error subiendo foto de perfil.' });
    }
});

// ==========================================================================
// --- PROTECTED: Clients (Trainer only) ---
// ==========================================================================

// Sensitive fields never sent to the browser — not even as hashed values
const CLIENT_SAFE_SELECT = '-password -resetPasswordToken -resetPasswordExpires -inviteToken -inviteExpires';

app.get('/api/clients', authenticateToken, authorizeRoles('trainer', 'admin'), async (req, res) => {
    try {
        const clients = await User.find({ role: 'client', isDeleted: { $ne: true } })
            .select(CLIENT_SAFE_SELECT)
            .sort({ createdAt: -1 });
        res.json(clients);
    } catch (error) { res.status(500).json({ message: 'Error fetching clients' }); }
});

// Option B: Create client with invite token — no plaintext password ever leaves the server
app.post('/api/clients', authenticateToken, authorizeRoles('trainer', 'admin'), async (req, res) => {
    try {
        const { sendInvite, ...clientData } = req.body;

        const existing = await User.findOne({ email: clientData.email });
        if (existing) return res.status(400).json({ message: 'El email ya existe' });

        // Generate a secure one-time invite token (7-day expiry)
        const rawToken = crypto.randomBytes(32).toString('hex');
        const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');
        const inviteExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

        // Client account gets a random placeholder password — they set their own via the invite link
        const placeholderPassword = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);

        const newClient = new User({
            ...clientData,
            password: placeholderPassword,
            isFirstLogin: true,
            role: 'client',
            inviteToken: hashedToken,
            inviteExpires
        });
        await newClient.save();

        // Notify trainer that a new client was created
        const clientFullName = `${clientData.name} ${clientData.lastName || ''}`.trim();
        await createNotification({
            clientId: newClient._id,
            clientName: clientFullName,
            type: 'client_created',
            title: 'fue añadido como cliente',
            message: `${clientData.email}${clientData.program && clientData.program !== 'Sin Asignar' ? ` · Programa: ${clientData.program}` : ''}`
        });

        // Send invite email automatically if requested (default: true)
        if (sendInvite !== false) {
            const inviteLink = `${APP_URL}/?invite=${rawToken}`;
            const mailOptions = {
                from: 'FitBySuárez <noreply@fitbysuarez.com>',
                to: clientData.email,
                subject: 'Tu acceso a FitBySuárez — Activa tu cuenta',
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #0a0a0a; color: #f5f5f5;">
                        <div style="text-align: center; margin-bottom: 30px; padding: 20px 0; border-bottom: 1px solid #FFDB8930;">
                            <h1 style="color: #FFDB89; margin: 0; font-size: 28px; letter-spacing: 2px;">FitBySuárez</h1>
                        </div>
                        <div style="background: #1c1c1e; border: 1px solid #FFDB8930; border-radius: 12px; padding: 30px;">
                            <h2 style="color: #FFDB89; margin-top: 0;">¡Hola, ${clientData.name}!</h2>
                            <p style="color: #ccc; line-height: 1.7;">Tu entrenador ha creado tu cuenta en <strong style="color: #FFDB89;">FitBySuárez</strong>. Haz clic en el botón de abajo para activarla y crear tu contraseña personal.</p>
                            <div style="text-align: center; margin: 30px 0;">
                                <a href="${inviteLink}" style="display: inline-block; background: #FFDB89; color: #030303; padding: 16px 36px; text-decoration: none; border-radius: 10px; font-weight: 900; font-size: 16px; letter-spacing: 0.5px;">Activar mi cuenta</a>
                            </div>
                            <p style="color: #888; font-size: 13px; line-height: 1.6;">O copia y pega este enlace en tu navegador:</p>
                            <p style="color: #FFDB89; word-break: break-all; font-size: 12px; background: #111; padding: 12px; border-radius: 8px;">${inviteLink}</p>
                            <div style="margin-top: 25px; padding-top: 20px; border-top: 1px solid #FFDB8920;">
                                <p style="color: #ef4444; font-size: 13px; margin: 0;"><strong>Este enlace expira en 7 días.</strong></p>
                            </div>
                        </div>
                        <div style="text-align: center; margin-top: 25px; color: #555; font-size: 12px;">
                            <p>Si no esperabas este correo, puedes ignorarlo con seguridad.</p>
                            <p>FitBySuárez — Entrenamiento de alto rendimiento</p>
                        </div>
                    </div>
                `
            };
            try {
                await sendEmail(mailOptions);
                return res.json({ ...newClient.toObject(), _inviteLink: inviteLink });
            } catch (emailErr) {
                // Don't fail the whole request — client was created, trainer can resend later
                console.error('Failed to send invite email:', emailErr.message);
                return res.json({ ...newClient.toObject(), _emailFailed: true, _inviteLink: inviteLink });
            }
        }

        res.json(newClient.toObject());
    } catch (error) {
        console.error('Error creating client:', error);
        res.status(500).json({ message: 'Error creating client' });
    }
});

app.put('/api/clients/:id', authenticateToken, authorizeRoles('trainer', 'admin'), async (req, res) => {
    try {
        const { id } = req.params;

        // C-2: Explicit allowlist — prevents role escalation and token overwrites
        const ALLOWED = ['name','lastName','email','program','group','type','dueDate','isActive',
                         'location','timezone','unitSystem','phone','height','weight','birthday',
                         'gender','thr','mahr','restingHr','emailPreferences','hideFromDashboard',
                         'profilePicture','equipment','equipmentCheckOn','macroSettings','waterGoal','injuredMuscles','dietaryPreferences'];
        const updates = {};
        for (const key of ALLOWED) {
            if (req.body[key] !== undefined) updates[key] = req.body[key];
        }

        const prevClient = await User.findById(id);
        const updatedClient = await User.findByIdAndUpdate(id, updates, { new: true })
            .select(CLIENT_SAFE_SELECT);

        // Notify trainer if program was assigned or changed
        if (updates.program && updates.program !== 'Sin Asignar' &&
            updates.program !== prevClient?.program) {
            const clientFullName = `${updatedClient.name} ${updatedClient.lastName || ''}`.trim();
            await createNotification({
                clientId: updatedClient._id,
                clientName: clientFullName,
                type: 'program_assigned',
                title: 'fue asignado a un programa',
                message: `Programa: ${updates.program}`
            });
        }

        res.json(updatedClient);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Resend (or generate fresh) invite link for an existing client
app.post('/api/clients/:id/resend-invite', authenticateToken, authorizeRoles('trainer', 'admin'), async (req, res) => {
    try {
        const client = await User.findById(req.params.id);
        if (!client) return res.status(404).json({ message: 'Cliente no encontrado' });
        if (client.role !== 'client') return res.status(400).json({ message: 'Solo aplica para clientes' });

        // Generate a fresh 7-day token
        const rawToken = crypto.randomBytes(32).toString('hex');
        const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');
        client.inviteToken = hashedToken;
        client.inviteExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        await client.save();

        const inviteLink = `${APP_URL}/?invite=${rawToken}`;

        // Try to send by email; always return the raw link so the trainer has a fallback
        try {
            await sendEmail({
                from: 'FitBySuárez <noreply@fitbysuarez.com>',
                to: client.email,
                subject: 'Tu acceso a FitBySuárez — Activa tu cuenta',
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #0a0a0a; color: #f5f5f5;">
                        <div style="text-align: center; margin-bottom: 30px; padding: 20px 0; border-bottom: 1px solid #FFDB8930;">
                            <h1 style="color: #FFDB89; margin: 0; font-size: 28px; letter-spacing: 2px;">FitBySuárez</h1>
                        </div>
                        <div style="background: #1c1c1e; border: 1px solid #FFDB8930; border-radius: 12px; padding: 30px;">
                            <h2 style="color: #FFDB89; margin-top: 0;">¡Hola, ${client.name}!</h2>
                            <p style="color: #ccc; line-height: 1.7;">Tu entrenador te ha enviado un nuevo enlace para activar tu cuenta en <strong style="color: #FFDB89;">FitBySuárez</strong>.</p>
                            <div style="text-align: center; margin: 30px 0;">
                                <a href="${inviteLink}" style="display: inline-block; background: #FFDB89; color: #030303; padding: 16px 36px; text-decoration: none; border-radius: 10px; font-weight: 900; font-size: 16px; letter-spacing: 0.5px;">Activar mi cuenta</a>
                            </div>
                            <p style="color: #888; font-size: 13px;">O copia este enlace en tu navegador:</p>
                            <p style="color: #FFDB89; word-break: break-all; font-size: 12px; background: #111; padding: 12px; border-radius: 8px;">${inviteLink}</p>
                            <p style="color: #ef4444; font-size: 13px; margin-top: 20px;"><strong>Este enlace expira en 7 días.</strong></p>
                        </div>
                    </div>`
            });
            return res.json({ success: true, emailSent: true, inviteLink });
        } catch (emailErr) {
            console.error('Resend email failed:', emailErr.message);
            return res.json({ success: true, emailSent: false, inviteLink });
        }
    } catch (e) {
        console.error('Resend invite error:', e);
        res.status(500).json({ message: 'Error al reenviar invitación' });
    }
});

app.delete('/api/clients/:id', authenticateToken, authorizeRoles('trainer', 'admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const deleted = await User.findByIdAndUpdate(id, { isDeleted: true });
        if(!deleted) return res.status(404).json({ message: "Client not found" });
        res.json({ message: "Client deleted successfully" });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// ==========================================================================
// --- PROTECTED: Library (Any authenticated user can read, trainer can write) ---
// ==========================================================================

app.get('/api/library', authenticateToken, async (req, res) => {
    try { const exercises = await Exercise.find().sort({ name: 1 }); res.json(exercises); }
    catch (error) { res.status(500).json({ message: 'Error fetching library' }); }
});

app.post('/api/library', authenticateToken, authorizeRoles('trainer', 'admin'), async (req, res) => {
    try {
        const { name, videoUrl, category, muscleGroupId, origin, insertion, pushPull } = req.body;
        // H-3: Escape regex metacharacters to prevent ReDoS
        const safeName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const exercise = await Exercise.findOneAndUpdate(
            { name: { $regex: new RegExp(`^${safeName}$`, 'i') } },
            { name, videoUrl, category, muscleGroupId: muscleGroupId || '', origin: origin || '', insertion: insertion || '', pushPull: pushPull || '', lastUpdated: Date.now() },
            { new: true, upsert: true }
        );
        res.json(exercise);
    } catch (error) { res.status(500).json({ message: 'Error saving exercise' }); }
});

app.put('/api/library/:id', authenticateToken, authorizeRoles('trainer', 'admin'), async (req, res) => {
    try {
        const { name, videoUrl, category, muscleGroupId, origin, insertion, pushPull } = req.body;
        const exercise = await Exercise.findByIdAndUpdate(
            req.params.id,
            { name, videoUrl, category, muscleGroupId: muscleGroupId || '', origin: origin || '', insertion: insertion || '', pushPull: pushPull || '', lastUpdated: Date.now() },
            { new: true }
        );
        if (!exercise) return res.status(404).json({ message: 'Exercise not found' });
        res.json(exercise);
    } catch (error) { res.status(500).json({ message: 'Error updating exercise' }); }
});

app.delete('/api/library/:id', authenticateToken, authorizeRoles('trainer', 'admin'), async (req, res) => {
    try {
        const exercise = await Exercise.findByIdAndDelete(req.params.id);
        if (!exercise) return res.status(404).json({ message: 'Exercise not found' });
        res.json({ message: 'Exercise deleted' });
    } catch (error) { res.status(500).json({ message: 'Error deleting exercise' }); }
});

// ==========================================================================
// --- PROTECTED: Logs (Authenticated users) ---
// ==========================================================================

app.post('/api/log', authenticateToken, async (req, res) => {
    try {
        const { clientId, date, programName, exerciseName, completed } = req.body;
        let log = await WorkoutLog.findOne({ clientId, date });
        if (!log) log = new WorkoutLog({ clientId, date, programName, exercises: [] });
        const exIndex = log.exercises.findIndex(e => e.name === exerciseName);
        if (exIndex > -1) log.exercises[exIndex].completed = completed;
        else log.exercises.push({ name: exerciseName, completed });
        await log.save();
        res.json(log);
    } catch (e) { res.status(500).json({ message: 'Log Error' }); }
});

// C-3: Ownership guard — clients can only access their own data; trainers pass through
const assertOwnership = (req, res, clientId) => {
    if (req.user.role === 'client' && String(req.user.id) !== String(clientId)) {
        res.status(403).json({ message: 'Forbidden' });
        return false;
    }
    return true;
};

app.get('/api/log/:clientId', authenticateToken, async (req, res) => {
    if (!assertOwnership(req, res, req.params.clientId)) return;
    try { const logs = await WorkoutLog.find({ clientId: req.params.clientId }); res.json(logs); }
    catch (e) { res.status(500).json({ message: 'Error fetching logs' }); }
});

// ==========================================================================
// --- PROTECTED: Client-Specific Workouts ---
// ==========================================================================

app.post('/api/client-workouts', authenticateToken, async (req, res) => {
    if (!assertOwnership(req, res, req.body.clientId)) return;
    try {
        const {
            clientId, date, title, isRest, restType,
            warmup, warmupVideoUrl, warmupItems,
            exercises,
            cooldown, cooldownVideoUrl, cooldownItems,
            sourceProgramId, sourceWeek, sourceDayNum,
        } = req.body;
        const update = {
            title:            title || '',
            isRest:           !!isRest,
            restType:         restType         || '',
            warmup:           warmup            || '',
            warmupVideoUrl:   warmupVideoUrl    || '',
            warmupItems:      warmupItems       || [],
            exercises:        exercises         || [],
            cooldown:         cooldown          || '',
            cooldownVideoUrl: cooldownVideoUrl  || '',
            cooldownItems:    cooldownItems     || [],
            updatedAt:        Date.now(),
        };
        if (sourceProgramId) {
            // This day comes from a program push — record provenance for re-sync.
            update.sourceProgramId = sourceProgramId;
            update.sourceWeek      = sourceWeek ?? null;
            update.sourceDayNum    = sourceDayNum ?? null;
            update.manualEdit      = false;
        } else if (req.user.role !== 'client') {
            // A trainer hand-saving a day in the calendar — protect it so a later
            // program re-sync won't overwrite the customization. (Provenance, if
            // any, is left intact so the day still belongs to its program.)
            update.manualEdit = true;
        }
        const workout = await ClientWorkout.findOneAndUpdate(
            { clientId, date },
            update,
            { new: true, upsert: true }
        );

        // Create notification if a CLIENT completed/saved their workout
        if (req.user.role === 'client') {
            const client = await User.findById(clientId);
            if (client) {
                await createNotification({
                    clientId: client._id,
                    clientName: `${client.name} ${client.lastName || ''}`.trim(),
                    type: 'workout_completed',
                    title: `completo su entrenamiento`,
                    message: `Rutina "${title || 'Workout'}" para ${date}`,
                    data: { date, title, exerciseCount: exercises?.length || 0 }
                });
            }
        }

        res.json(workout);
    } catch (error) {
        console.error('Error saving workout:', error);
        res.status(500).json({ message: 'Error saving workout', error });
    }
});

app.get('/api/client-workouts/:clientId/:date', authenticateToken, async (req, res) => {
    if (!assertOwnership(req, res, req.params.clientId)) return;
    try {
        const { clientId, date } = req.params;
        const workout = await ClientWorkout.findOne({ clientId, date });
        if (!workout) {
            return res.status(404).json({ message: 'No workout found for this date' });
        }
        res.json(workout);
    } catch (error) {
        console.error('Error fetching workout:', error);
        res.status(500).json({ message: 'Error fetching workout', error });
    }
});

app.get('/api/client-workouts/:clientId', authenticateToken, async (req, res) => {
    if (!assertOwnership(req, res, req.params.clientId)) return;
    try {
        const { clientId } = req.params;
        const workouts = await ClientWorkout.find({ clientId }).sort({ date: 1 });
        res.json(workouts);
    } catch (error) {
        console.error('Error fetching client workouts:', error);
        res.status(500).json({ message: 'Error fetching workouts', error });
    }
});

// GET /api/exercise-history/:clientId?names=Squat,Bench+Press&before=2026-05-20
// Returns the most recent logged result for each exercise name, strictly before `before`.
app.get('/api/exercise-history/:clientId', authenticateToken, async (req, res) => {
    if (!assertOwnership(req, res, req.params.clientId)) return;
    try {
        const { clientId } = req.params;
        const { names, before } = req.query;
        if (!names || !before) return res.json({});

        const nameList = names.split(',').map(n => n.trim()).filter(Boolean);
        if (!nameList.length) return res.json({});

        // One aggregation query — find the most recent workout before `before`
        // that has a non-empty result for each requested exercise name.
        const history = {};
        await Promise.all(nameList.map(async (name) => {
            const workout = await ClientWorkout.findOne({
                clientId,
                date: { $lt: before },
                exercises: { $elemMatch: { name: { $regex: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }, results: { $not: /^\s*$/ } } }
            }).sort({ date: -1 }).lean();

            if (workout) {
                const ex = workout.exercises.find(e =>
                    e.name.toLowerCase() === name.toLowerCase() && e.results?.trim()
                );
                if (ex) history[name] = { date: workout.date, results: ex.results.trim() };
            }
        }));

        res.json(history);
    } catch (e) {
        console.error('Exercise history error:', e.message);
        res.status(500).json({});
    }
});

// GET /api/exercise-history/:clientId/all
// Returns every exercise the client has ever logged with results, grouped by exercise
// name and sorted newest-first within each group.  Used by the client Historial page.
app.get('/api/exercise-history/:clientId/all', authenticateToken, async (req, res) => {
    if (!assertOwnership(req, res, req.params.clientId)) return;
    try {
        const { clientId } = req.params;

        // Fetch all workouts that contain at least one exercise with a filled result.
        // We project only what we need to keep the payload small.
        const workouts = await ClientWorkout.find(
            { clientId },
            { date: 1, exercises: 1 }
        ).sort({ date: -1 }).lean();

        const byExercise = {};
        for (const workout of workouts) {
            for (const ex of (workout.exercises || [])) {
                if (!ex.name || !ex.results?.trim()) continue;
                if (!byExercise[ex.name]) byExercise[ex.name] = [];
                byExercise[ex.name].push({ date: workout.date, results: ex.results.trim() });
            }
        }

        // Sort exercise names alphabetically; entries are already newest-first.
        const exercises = Object.entries(byExercise)
            .map(([name, entries]) => ({ name, entries }))
            .sort((a, b) => a.name.localeCompare(b.name, 'es'));

        res.json({ exercises });
    } catch (e) {
        console.error('Exercise history /all error:', e.message);
        res.status(500).json({ exercises: [] });
    }
});

// Save client mood for the day — upserts the workout document so mood is stored
// even on rest days or days with no trainer-assigned workout.
app.patch('/api/client-workouts/:clientId/:date/mood', authenticateToken, async (req, res) => {
    if (!assertOwnership(req, res, req.params.clientId)) return;
    const ALLOWED_MOODS = ['amazing', 'great', 'neutral', 'tired', 'bad', ''];
    const { mood } = req.body;
    if (!ALLOWED_MOODS.includes(mood)) return res.status(400).json({ message: 'Invalid mood value.' });
    try {
        const { clientId, date } = req.params;
        const workout = await ClientWorkout.findOneAndUpdate(
            { clientId, date },
            { $set: { mood, updatedAt: Date.now() } },
            { new: true, upsert: true, setDefaultsOnInsert: true }
        );
        res.json(workout);
    } catch (error) {
        res.status(500).json({ message: 'Error saving mood.' });
    }
});

// Partial update (e.g. saving RPE without overwriting exercises/warmup/cooldown)
app.patch('/api/client-workouts/:clientId/:date', authenticateToken, async (req, res) => {
    if (!assertOwnership(req, res, req.params.clientId)) return;
    try {
        const { clientId, date } = req.params;
        // Read the BEFORE state so we only notify on a real status change
        const before = await ClientWorkout.findOne({ clientId, date });
        const wasComplete = before?.isComplete || false;
        const wasMissed   = before?.isMissed   || false;

        const patch = { ...req.body, updatedAt: Date.now() };
        // A trainer editing a day's prescription = a manual customization. Flag it
        // so a later program re-sync preserves it. (Client edits — results/rpe/
        // completion — never set this; the sync routine itself bypasses PATCH.)
        const PRESCRIPTION_FIELDS = ['title', 'exercises', 'warmup', 'warmupItems', 'cooldown', 'cooldownItems', 'isRest', 'restType'];
        if (req.user.role !== 'client' && PRESCRIPTION_FIELDS.some(f => f in req.body)) {
            patch.manualEdit = true;
        }
        const workout = await ClientWorkout.findOneAndUpdate(
            { clientId, date },
            { $set: patch },
            { new: true }
        );
        if (!workout) return res.status(404).json({ message: 'Workout not found' });

        const client = await User.findById(clientId);
        const clientName = client ? `${client.name} ${client.lastName || ''}`.trim() : 'Cliente';

        // Notify trainer if client submitted an RPE rating
        if (req.user.role === 'client' && req.body.rpe != null) {
            if (client) {
                const rpeLabels = { 1:'Muy fácil',2:'Fácil',3:'Moderado-bajo',4:'Moderado',5:'Algo difícil',6:'Difícil',7:'Muy difícil',8:'Muy duro',9:'Casi al máximo',10:'Máximo esfuerzo' };
                await createNotification({
                    clientId: client._id, clientName,
                    type: 'rpe_submitted',
                    title: `calificó su entrenamiento con RPE ${req.body.rpe}/10`,
                    message: `"${workout.title || 'Entrenamiento'}" · ${date} · ${rpeLabels[req.body.rpe] || ''}`
                });
            }
        }

        // Only notify on a real state transition (not on repeated toggles)
        if (req.body.isComplete === true && !wasComplete && client) {
            await createNotification({
                clientId: client._id, clientName,
                type: 'workout_completed',
                title: 'completó su entrenamiento',
                message: `"${workout.title || 'Entrenamiento'}" · ${date}`
            });
        }
        if (req.body.isMissed === true && !wasMissed && client) {
            await createNotification({
                clientId: client._id, clientName,
                type: 'workout_missed',
                title: 'marcó un entrenamiento como perdido',
                message: `"${workout.title || 'Entrenamiento'}" · ${date}`
            });
        }

        res.json(workout);
    } catch (error) {
        console.error('Error patching workout:', error);
        res.status(500).json({ message: 'Error updating workout', error });
    }
});

app.delete('/api/client-workouts/:clientId/:date', authenticateToken, authorizeRoles('trainer', 'admin'), async (req, res) => {
    try {
        const { clientId, date } = req.params;
        await ClientWorkout.findOneAndDelete({ clientId, date });
        res.json({ message: 'Workout deleted' });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting workout', error });
    }
});

// ==========================================================================
// --- PROTECTED: Weight/Metrics Logs ---
// ==========================================================================

app.get('/api/weight-logs/:clientId', authenticateToken, async (req, res) => {
    if (!assertOwnership(req, res, req.params.clientId)) return;
    try {
        const logs = await WeightLog.find({ clientId: req.params.clientId }).sort({ date: -1 }).limit(100);
        res.json(logs);
    } catch (e) { res.status(500).json({ message: 'Error fetching weight logs' }); }
});

app.post('/api/weight-logs', authenticateToken, async (req, res) => {
    if (!assertOwnership(req, res, req.body.clientId)) return;
    try {
        const { clientId, date, weight, bodyFat, notes } = req.body;
        const log = await WeightLog.findOneAndUpdate(
            { clientId, date },
            { weight, bodyFat, notes },
            { new: true, upsert: true }
        );

        // Notify trainer when client logs weight
        if (req.user.role === 'client') {
            const client = await User.findById(clientId);
            if (client) {
                await createNotification({
                    clientId: client._id,
                    clientName: `${client.name} ${client.lastName || ''}`.trim(),
                    type: 'weight_update',
                    title: `registró su peso`,
                    message: `Peso: ${weight} lbs${bodyFat ? ` | Grasa: ${bodyFat}%` : ''} - ${date}`,
                    data: { date, weight, bodyFat }
                });
            }
        }

        res.json(log);
    } catch (e) { res.status(500).json({ message: 'Error saving weight log' }); }
});

// ==========================================================================
// --- PROTECTED: Body Measurements ---
// ==========================================================================

app.get('/api/body-measurements/:clientId', authenticateToken, async (req, res) => {
    if (!assertOwnership(req, res, req.params.clientId)) return;
    try {
        const measurements = await BodyMeasurement.find({ clientId: req.params.clientId }).sort({ date: 1 });
        res.json(measurements);
    } catch (e) { res.status(500).json({ message: 'Error fetching body measurements' }); }
});

app.post('/api/body-measurements', authenticateToken, async (req, res) => {
    try {
        if (req.user.role !== 'trainer' && req.user.role !== 'admin') {
            return res.status(403).json({ message: 'Solo el entrenador puede registrar medidas.' });
        }
        const { clientId, date, weight, bodyFat, bmi, pecho, biceps, cintura, cadera, quads, calves, notes } = req.body;
        if (!clientId || !date) return res.status(400).json({ message: 'clientId y date son requeridos.' });
        const measurement = await BodyMeasurement.findOneAndUpdate(
            { clientId, date },
            { weight, bodyFat, bmi, pecho, biceps, cintura, cadera, quads, calves, notes },
            { new: true, upsert: true }
        );
        res.json(measurement);
    } catch (e) { res.status(500).json({ message: 'Error saving body measurement' }); }
});

app.patch('/api/body-measurements/:id', authenticateToken, async (req, res) => {
    try {
        if (req.user.role !== 'trainer' && req.user.role !== 'admin') {
            return res.status(403).json({ message: 'Solo el entrenador puede editar medidas.' });
        }
        const { date, weight, bodyFat, bmi, pecho, biceps, cintura, cadera, quads, calves, notes } = req.body;
        const updated = await BodyMeasurement.findByIdAndUpdate(
            req.params.id,
            { $set: { date, weight, bodyFat, bmi, pecho, biceps, cintura, cadera, quads, calves, notes } },
            { new: true }
        );
        if (!updated) return res.status(404).json({ message: 'Medida no encontrada.' });
        res.json(updated);
    } catch (e) { res.status(500).json({ message: 'Error updating measurement' }); }
});

app.delete('/api/body-measurements/:id', authenticateToken, async (req, res) => {
    try {
        if (req.user.role !== 'trainer' && req.user.role !== 'admin') {
            return res.status(403).json({ message: 'Solo el entrenador puede eliminar medidas.' });
        }
        await BodyMeasurement.findByIdAndDelete(req.params.id);
        res.json({ message: 'Medida eliminada.' });
    } catch (e) { res.status(500).json({ message: 'Error deleting measurement' }); }
});

// ==========================================================================
// --- PROTECTED: Nutrition Logs ---
// ==========================================================================

app.get('/api/nutrition-logs/:clientId', authenticateToken, async (req, res) => {
    if (!assertOwnership(req, res, req.params.clientId)) return;
    try {
        const logs = await NutritionLog.find({ clientId: req.params.clientId }).sort({ date: -1 }).limit(100);
        res.json(logs);
    } catch (e) { res.status(500).json({ message: 'Error fetching nutrition logs' }); }
});

app.post('/api/nutrition-logs', authenticateToken, async (req, res) => {
    try {
        const { clientId, date, calories, protein, carbs, fat, water, notes, mood, meals, exercise, exerciseCalories } = req.body;
        // Only update fields that were explicitly provided
        const updateFields = {};
        if (calories !== undefined) updateFields.calories = calories;
        if (protein  !== undefined) updateFields.protein  = protein;
        if (carbs    !== undefined) updateFields.carbs    = carbs;
        if (fat      !== undefined) updateFields.fat      = fat;
        if (water    !== undefined) updateFields.water    = water;
        if (notes    !== undefined) updateFields.notes    = notes;
        if (mood     !== undefined) updateFields.mood     = mood;
        if (meals    !== undefined) updateFields.meals    = meals;
        if (exercise !== undefined) updateFields.exercise = exercise;
        if (exerciseCalories !== undefined) updateFields.exerciseCalories = exerciseCalories;

        // Only create a new log (upsert) when actual nutrition/activity data is being saved.
        // Mood-only or notes-only saves should update existing logs but never create phantom 0-calorie entries.
        const hasNutritionData = calories !== undefined || protein !== undefined ||
                                 carbs !== undefined || fat !== undefined ||
                                 water !== undefined || meals !== undefined ||
                                 exercise !== undefined || exerciseCalories !== undefined;

        const log = await NutritionLog.findOneAndUpdate(
            { clientId, date },
            { $set: updateFields },
            { new: true, upsert: hasNutritionData }
        );
        if (!log) { res.json({ ok: true }); return; } // mood/notes update on non-existent log — no-op

        // Notify trainer when client logs actual nutrition (not just mood/notes)
        if (req.user.role === 'client' && hasNutritionData) {
            const client = await User.findById(clientId);
            if (client) {
                await createNotification({
                    clientId: client._id,
                    clientName: `${client.name} ${client.lastName || ''}`.trim(),
                    type: 'nutrition_logged',
                    title: `registró su nutrición`,
                    message: `${log.calories ?? 0} cal | P:${log.protein ?? 0}g C:${log.carbs ?? 0}g F:${log.fat ?? 0}g - ${date}`,
                    data: { date, calories: log.calories, protein: log.protein, carbs: log.carbs, fat: log.fat }
                });
            }
        }

        res.json(log);
    } catch (e) { res.status(500).json({ message: 'Error saving nutrition log' }); }
});

// Delete a nutrition log by its _id (trainer or the client who owns it)
app.delete('/api/nutrition-logs/:logId', authenticateToken, async (req, res) => {
    try {
        const log = await NutritionLog.findById(req.params.logId);
        if (!log) return res.status(404).json({ message: 'Log not found' });
        // Allow: the client who owns it, or a trainer
        if (req.user.role !== 'trainer' && log.clientId.toString() !== req.user.id) {
            return res.status(403).json({ message: 'Forbidden' });
        }
        await NutritionLog.findByIdAndDelete(req.params.logId);
        res.json({ message: 'Deleted' });
    } catch (e) { res.status(500).json({ message: 'Error deleting nutrition log' }); }
});

// --- Saved meal combos (per client) ---
// List the current user's saved combos, newest first.
app.get('/api/saved-meals', authenticateToken, async (req, res) => {
    try {
        const meals = await SavedMeal.find({ clientId: req.user.id }).sort({ createdAt: -1 });
        res.json(meals);
    } catch (e) { res.status(500).json({ message: 'Error fetching saved meals' }); }
});

// Save a combo (snapshot of a meal's foods). Body: { name, mealSlot, foods: [...] }
app.post('/api/saved-meals', authenticateToken, async (req, res) => {
    try {
        const { name, mealSlot, foods } = req.body;
        if (!name || !Array.isArray(foods) || foods.length === 0)
            return res.status(400).json({ message: 'Se requiere un nombre y al menos un alimento.' });
        const clean = foods.map(f => ({
            name: f.name || 'Sin nombre',
            calories: Number(f.calories) || 0, protein: Number(f.protein) || 0,
            carbs: Number(f.carbs) || 0, fat: Number(f.fat) || 0,
            servingAmount: f.servingAmount != null ? Number(f.servingAmount) : null,
            servingUnit: f.servingUnit || '',
        }));
        const meal = await SavedMeal.create({ clientId: req.user.id, name, mealSlot: mealSlot || '', foods: clean });
        res.status(201).json(meal);
    } catch (e) { res.status(500).json({ message: 'Error saving meal combo' }); }
});

// Update one of the user's own combos in place (rename / add / remove / edit items).
// Overwrites the existing saved entry. Body: { name?, mealSlot?, foods: [...] }
app.put('/api/saved-meals/:id', authenticateToken, async (req, res) => {
    try {
        const meal = await SavedMeal.findById(req.params.id);
        if (!meal) return res.status(404).json({ message: 'No encontrado' });
        if (meal.clientId.toString() !== req.user.id) return res.status(403).json({ message: 'Forbidden' });
        const { name, mealSlot, foods } = req.body;
        if (!name || !Array.isArray(foods) || foods.length === 0)
            return res.status(400).json({ message: 'Se requiere un nombre y al menos un alimento.' });
        meal.name = name;
        if (mealSlot !== undefined) meal.mealSlot = mealSlot || '';
        meal.foods = foods.map(f => ({
            name: f.name || 'Sin nombre',
            calories: Number(f.calories) || 0, protein: Number(f.protein) || 0,
            carbs: Number(f.carbs) || 0, fat: Number(f.fat) || 0,
            servingAmount: f.servingAmount != null ? Number(f.servingAmount) : null,
            servingUnit: f.servingUnit || '',
        }));
        await meal.save();
        res.json(meal);
    } catch (e) { res.status(500).json({ message: 'Error updating saved meal' }); }
});

// Delete one of the user's own combos.
app.delete('/api/saved-meals/:id', authenticateToken, async (req, res) => {
    try {
        const meal = await SavedMeal.findById(req.params.id);
        if (!meal) return res.status(404).json({ message: 'No encontrado' });
        if (meal.clientId.toString() !== req.user.id) return res.status(403).json({ message: 'Forbidden' });
        await SavedMeal.findByIdAndDelete(req.params.id);
        res.json({ message: 'Deleted' });
    } catch (e) { res.status(500).json({ message: 'Error deleting saved meal' }); }
});

// ==========================================================================
// --- PROTECTED: Personal Food Library (per-client foods saved for reuse) ---
// ==========================================================================

// List client's personal food library, sorted by requested criteria
app.get('/api/personal-foods', authenticateToken, async (req, res) => {
    try {
        const { sort } = req.query;
        let sortQuery = { createdAt: -1 };
        if (sort === 'frequent') sortQuery = { timesUsed: -1, createdAt: -1 };

        const foods = await PersonalFoodLibrary.find({ clientId: req.user.id })
            .sort(sortQuery);
        res.json(foods);
    } catch (e) { res.status(500).json({ message: 'Error fetching personal foods' }); }
});

// Save a food to personal library (or increment timesUsed if already exists)
// Body: { name, calories, protein, carbs, fat, servingSize?, servingUnit? }
app.post('/api/personal-foods', authenticateToken, async (req, res) => {
    try {
        const { name, calories, protein, carbs, fat, servingSize, servingUnit } = req.body;
        if (!name) return res.status(400).json({ message: 'Se requiere el nombre del alimento.' });

        const food = await PersonalFoodLibrary.findOneAndUpdate(
            { clientId: req.user.id, name },
            {
                $set: {
                    calories: Number(calories) || 0,
                    protein: Number(protein) || 0,
                    carbs: Number(carbs) || 0,
                    fat: Number(fat) || 0,
                    servingSize: Number(servingSize) || 100,
                    servingUnit: servingUnit || 'g',
                    updatedAt: new Date()
                },
                $inc: { timesUsed: 1 }
            },
            { new: true, upsert: true }
        );
        res.status(201).json(food);
    } catch (e) { res.status(500).json({ message: 'Error saving personal food' }); }
});

// Edit a personal food entry
// Body: { name?, calories?, protein?, carbs?, fat?, servingSize?, servingUnit? }
app.put('/api/personal-foods/:id', authenticateToken, async (req, res) => {
    try {
        const food = await PersonalFoodLibrary.findById(req.params.id);
        if (!food) return res.status(404).json({ message: 'Alimento no encontrado' });
        if (food.clientId.toString() !== req.user.id) return res.status(403).json({ message: 'Forbidden' });

        const { name, calories, protein, carbs, fat, servingSize, servingUnit } = req.body;
        const updateFields = {};
        if (name !== undefined) updateFields.name = name;
        if (calories !== undefined) updateFields.calories = Number(calories);
        if (protein !== undefined) updateFields.protein = Number(protein);
        if (carbs !== undefined) updateFields.carbs = Number(carbs);
        if (fat !== undefined) updateFields.fat = Number(fat);
        if (servingSize !== undefined) updateFields.servingSize = Number(servingSize);
        if (servingUnit !== undefined) updateFields.servingUnit = servingUnit;
        updateFields.updatedAt = new Date();

        const updated = await PersonalFoodLibrary.findByIdAndUpdate(
            req.params.id,
            { $set: updateFields },
            { new: true }
        );
        res.json(updated);
    } catch (e) { res.status(500).json({ message: 'Error updating personal food' }); }
});

// Delete a personal food entry
app.delete('/api/personal-foods/:id', authenticateToken, async (req, res) => {
    try {
        const food = await PersonalFoodLibrary.findById(req.params.id);
        if (!food) return res.status(404).json({ message: 'Alimento no encontrado' });
        if (food.clientId.toString() !== req.user.id) return res.status(403).json({ message: 'Forbidden' });

        await PersonalFoodLibrary.findByIdAndDelete(req.params.id);
        res.json({ message: 'Deleted' });
    } catch (e) { res.status(500).json({ message: 'Error deleting personal food' }); }
});

// Submit a personal food to the community library
// Updates FoodLibrary (dedup by nameNorm, increment timesUsed if exists) and marks as submitted
app.post('/api/personal-foods/:id/submit-community', authenticateToken, async (req, res) => {
    try {
        const food = await PersonalFoodLibrary.findById(req.params.id);
        if (!food) return res.status(404).json({ message: 'Alimento no encontrado' });
        if (food.clientId.toString() !== req.user.id) return res.status(403).json({ message: 'Forbidden' });

        // Normalize name for dedup (strip accents, lowercase)
        const normalizeStr = (s) => {
            return (s || '').toLowerCase()
                .normalize('NFD')
                .replace(/[̀-ͯ]/g, '');
        };
        const nameNorm = normalizeStr(food.name);

        // Upsert to community library: if name exists, increment timesUsed; otherwise create
        const communityFood = await FoodLibrary.findOneAndUpdate(
            { nameNorm },
            {
                $set: {
                    name: food.name,
                    nameNorm,
                    calories: food.calories,
                    protein: food.protein,
                    carbs: food.carbs,
                    fat: food.fat,
                    updatedAt: new Date()
                },
                $inc: { timesUsed: 1 }
            },
            { new: true, upsert: true }
        );

        // Mark personal food as submitted
        food.submittedToCommunity = true;
        food.communityFoodId = communityFood._id;
        await food.save();

        res.json({ ok: true, communityFoodId: communityFood._id });
    } catch (e) { res.status(500).json({ message: 'Error submitting to community library' }); }
});

// ==========================================================================
// --- PROTECTED: Payments / Invoices ---
// ==========================================================================

// GET all payments for the trainer (with client name populated)
app.get('/api/payments', authenticateToken, authorizeRoles('trainer', 'admin'), async (req, res) => {
    try {
        const payments = await Payment.find({ trainerId: req.user.id })
            .sort({ dueDate: -1 })
            .lean();
        // Attach client name to each record
        const clientIds = [...new Set(payments.map(p => p.clientId.toString()))];
        const clients = await User.find({ _id: { $in: clientIds } }).select('name lastName').lean();
        const clientMap = {};
        clients.forEach(c => { clientMap[c._id.toString()] = `${c.name} ${c.lastName || ''}`.trim(); });
        const populated = payments.map(p => ({ ...p, clientName: clientMap[p.clientId.toString()] || 'Cliente' }));
        res.json(populated);
    } catch (e) { res.status(500).json({ message: 'Error fetching payments' }); }
});

// GET payments for a specific client
app.get('/api/payments/client/:clientId', authenticateToken, authorizeRoles('trainer', 'admin'), async (req, res) => {
    try {
        const payments = await Payment.find({ clientId: req.params.clientId, trainerId: req.user.id })
            .sort({ dueDate: -1 }).lean();
        res.json(payments);
    } catch (e) { res.status(500).json({ message: 'Error fetching client payments' }); }
});

// A client reads their OWN invoices (for the mobile/client app).
app.get('/api/payments/mine', authenticateToken, async (req, res) => {
    try {
        const payments = await Payment.find({ clientId: req.user.id }).sort({ dueDate: -1 }).lean();
        res.json(payments);
    } catch (e) { res.status(500).json({ message: 'Error fetching payments' }); }
});

// POST create a new invoice
app.post('/api/payments', authenticateToken, authorizeRoles('trainer', 'admin'), async (req, res) => {
    try {
        const { clientId, amount, periodLabel, dueDate, notes } = req.body;
        if (!clientId || !amount || !dueDate) return res.status(400).json({ message: 'clientId, amount y dueDate son requeridos' });
        const payment = new Payment({
            clientId, trainerId: req.user.id,
            amount: Number(amount), periodLabel: periodLabel || '', dueDate, notes: notes || ''
        });
        await payment.save();
        res.status(201).json(payment);
    } catch (e) { res.status(500).json({ message: 'Error creating payment' }); }
});

// PATCH update a payment (mark paid, change status, record method)
app.patch('/api/payments/:id', authenticateToken, authorizeRoles('trainer', 'admin'), async (req, res) => {
    try {
        const allowed = ['status', 'method', 'paidDate', 'amount', 'dueDate', 'periodLabel', 'notes'];
        const updates = {};
        for (const key of allowed) { if (req.body[key] !== undefined) updates[key] = req.body[key]; }
        // Auto-set paidDate when marking paid
        if (updates.status === 'paid' && !updates.paidDate) {
            updates.paidDate = new Date().toISOString().split('T')[0];
        }
        // Clear paidDate when un-marking
        if (updates.status && updates.status !== 'paid') updates.paidDate = null;

        const payment = await Payment.findOneAndUpdate(
            { _id: req.params.id, trainerId: req.user.id },
            { $set: updates },
            { new: true }
        );
        if (!payment) return res.status(404).json({ message: 'Payment not found' });
        res.json(payment);
    } catch (e) { res.status(500).json({ message: 'Error updating payment' }); }
});

// DELETE a payment record
app.delete('/api/payments/:id', authenticateToken, authorizeRoles('trainer', 'admin'), async (req, res) => {
    try {
        const deleted = await Payment.findOneAndDelete({ _id: req.params.id, trainerId: req.user.id });
        if (!deleted) return res.status(404).json({ message: 'Payment not found' });
        res.json({ message: 'Deleted' });
    } catch (e) { res.status(500).json({ message: 'Error deleting payment' }); }
});

// POST send invoice email to client
app.post('/api/payments/:id/invoice', authenticateToken, authorizeRoles('trainer', 'admin'), async (req, res) => {
    try {
        const payment = await Payment.findOne({ _id: req.params.id, trainerId: req.user.id });
        if (!payment) return res.status(404).json({ message: 'Payment not found' });

        const client  = await User.findById(payment.clientId).select('name lastName email');
        const trainer = await User.findById(req.user.id).select('name lastName email paymentHandles');
        if (!client) return res.status(404).json({ message: 'Client not found' });

        const handles = trainer.paymentHandles || {};
        const amount  = Number(payment.amount).toFixed(2);
        const period  = payment.periodLabel || payment.dueDate;
        const due     = payment.dueDate;
        const trainerName = `${trainer.name} ${trainer.lastName || ''}`.trim();

        // Build payment method links
        const payLinks = [];
        if (handles.athMovil) payLinks.push(`
            <tr>
                <td style="padding:12px 16px;border-bottom:1px solid #333;">
                    <strong style="color:#FFDB89;">ATH Móvil</strong><br>
                    <span style="color:#ccc;">Busca <strong>${handles.athMovil}</strong> en ATH Móvil Business y envía $${amount}</span>
                </td>
            </tr>`);
        if (handles.venmo) payLinks.push(`
            <tr>
                <td style="padding:12px 16px;border-bottom:1px solid #333;">
                    <strong style="color:#FFDB89;">Venmo</strong><br>
                    <a href="https://venmo.com/${handles.venmo}?txn=pay&amount=${amount}&note=${encodeURIComponent(period)}"
                       style="color:#3b82f6;">Pagar @${handles.venmo} en Venmo →</a>
                </td>
            </tr>`);
        if (handles.paypal) payLinks.push(`
            <tr>
                <td style="padding:12px 16px;border-bottom:1px solid #333;">
                    <strong style="color:#FFDB89;">PayPal</strong><br>
                    <a href="https://paypal.me/${handles.paypal}/${amount}"
                       style="color:#3b82f6;">Pagar con PayPal →</a>
                </td>
            </tr>`);

        const paySection = payLinks.length
            ? `<table style="width:100%;border-collapse:collapse;border:1px solid #333;border-radius:8px;overflow:hidden;margin-top:20px;">${payLinks.join('')}</table>`
            : `<p style="color:#aaa;">Contacta a tu entrenador para coordinar el pago.</p>`;

        const mailOptions = {
            // Send from the verified Resend domain (a gmail.com "from" would be rejected);
            // the trainer's address goes in reply-to so the client's replies reach them.
            from: `"${trainerName}" <noreply@fitbysuarez.com>`,
            replyTo: process.env.GMAIL_USER || undefined,
            to: client.email,
            subject: `Factura de entrenamiento — ${period}`,
            html: `
            <div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#1a1a1a;border-radius:12px;overflow:hidden;">
                <div style="background:#030303;padding:28px 32px;border-bottom:2px solid #FFDB89;">
                    <h1 style="margin:0;color:#FFDB89;font-size:22px;">FitBySuarez</h1>
                    <p style="margin:4px 0 0;color:#aaa;font-size:13px;">Factura de entrenamiento</p>
                </div>
                <div style="padding:28px 32px;">
                    <p style="color:#e5e5e5;font-size:15px;margin:0 0 20px;">Hola <strong>${client.name}</strong>,</p>
                    <p style="color:#aaa;font-size:14px;margin:0 0 24px;">
                        Aquí tienes el resumen de tu factura de entrenamiento para el período <strong style="color:#FFDB89;">${period}</strong>.
                    </p>

                    <div style="background:#2a2a2a;border-radius:10px;padding:20px 24px;margin-bottom:24px;">
                        <div style="display:flex;justify-content:space-between;margin-bottom:10px;">
                            <span style="color:#aaa;font-size:13px;">Período</span>
                            <span style="color:#e5e5e5;font-weight:600;">${period}</span>
                        </div>
                        <div style="display:flex;justify-content:space-between;margin-bottom:10px;">
                            <span style="color:#aaa;font-size:13px;">Fecha límite de pago</span>
                            <span style="color:#e5e5e5;font-weight:600;">${due}</span>
                        </div>
                        <div style="display:flex;justify-content:space-between;padding-top:12px;border-top:1px solid #444;">
                            <span style="color:#FFDB89;font-size:16px;font-weight:700;">Total</span>
                            <span style="color:#FFDB89;font-size:22px;font-weight:900;">$${amount}</span>
                        </div>
                    </div>

                    <h3 style="color:#FFDB89;font-size:14px;font-weight:700;margin:0 0 8px;text-transform:uppercase;letter-spacing:.05em;">Métodos de pago</h3>
                    ${paySection}
                    ${payment.notes ? `<p style="color:#aaa;font-size:13px;margin-top:20px;padding:12px 16px;background:#2a2a2a;border-radius:8px;"><strong style="color:#FFDB89;">Notas:</strong> ${payment.notes}</p>` : ''}

                    <p style="color:#666;font-size:12px;margin-top:32px;padding-top:16px;border-top:1px solid #333;">
                        Este correo fue enviado por ${trainerName} a través de FitBySuarez.<br>
                        Cualquier pregunta, responde a este correo.
                    </p>
                </div>
            </div>`
        };

        await sendEmail(mailOptions);
        res.json({ message: 'Invoice sent' });
    } catch (e) {
        console.error('Invoice email error:', e);
        res.status(500).json({ message: 'Error sending invoice email' });
    }
});

// ==========================================================================
// --- PROTECTED: Progress Photos ---
// ==========================================================================

app.get('/api/progress-photos/:clientId', authenticateToken, async (req, res) => {
    if (!assertOwnership(req, res, req.params.clientId)) return;
    try {
        const photos = await ProgressPhoto.find({ clientId: req.params.clientId }).sort({ date: -1 }).limit(50);

        // Build fresh CDN URLs for photos that have a cloudinaryPublicId.
        // New photos use 'upload' type (public CDN, no signing needed).
        // Legacy 'authenticated' photos are handled by getPhotoUrl too — Cloudinary
        // serves them at the public URL once the resource type is 'upload' on new uploads.
        const withUrls = photos.map(p => {
            const obj = p.toObject();
            if (obj.cloudinaryPublicId) {
                obj.imageData = getPhotoUrl(obj.cloudinaryPublicId);
            }
            return obj;
        });

        res.json(withUrls);
    } catch (e) { res.status(500).json({ message: 'Error fetching progress photos' }); }
});

app.post('/api/progress-photos', authenticateToken, photoUpload.single('photo'), async (req, res) => {
    if (!assertOwnership(req, res, req.body.clientId)) return;
    try {
        const { clientId, date, notes, category } = req.body;
        if (!req.file) return res.status(400).json({ message: 'No se recibió ninguna imagen.' });

        // Upload buffer to Cloudinary as a public asset (upload type).
        // Privacy is maintained because the public_id is random and access to the
        // URL list requires server authentication.
        const result = await uploadToCloudinary(req.file.buffer, {
            folder: 'fitbysuarez/progress-photos',
            type:   'upload',
            transformation: [{ quality: 'auto', fetch_format: 'auto', width: 1200, crop: 'limit' }]
        });

        const photo = new ProgressPhoto({
            clientId,
            date,
            notes,
            category,
            imageData:          result.secure_url,
            cloudinaryPublicId: result.public_id
        });
        await photo.save();

        // Notify trainer when client uploads progress photo
        if (req.user.role === 'client') {
            const client = await User.findById(clientId);
            if (client) {
                await createNotification({
                    clientId: client._id,
                    clientName: `${client.name} ${client.lastName || ''}`.trim(),
                    type: 'progress_photos',
                    title: `subió una foto de progreso`,
                    message: `Categoría: ${category || 'general'} - ${date}`,
                    data: { date, category }
                });
            }
        }

        res.json(photo);
    } catch (e) {
        console.error('Error saving progress photo:', e.message, e.http_code || '');
        const msg = e.http_code === 401
            ? 'Error de autenticación con el servicio de imágenes. Contacta al administrador.'
            : (e.message || 'Error saving progress photo');
        res.status(500).json({ message: msg });
    }
});

app.delete('/api/progress-photos/:id', authenticateToken, async (req, res) => {
    try {
        const photo = await ProgressPhoto.findById(req.params.id);
        if (!photo) return res.status(404).json({ message: 'Photo not found' });

        // Clients may only delete their own photos; trainers/admins may delete any
        if (req.user.role === 'client' && String(req.user.id) !== String(photo.clientId)) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        // Remove from Cloudinary if we have a public_id (new photos always will; legacy base64 photos won't)
        if (photo.cloudinaryPublicId) {
            await cloudinary.uploader.destroy(photo.cloudinaryPublicId, {
                type:       'upload',
                invalidate: true,
            });
        }

        await ProgressPhoto.findByIdAndDelete(req.params.id);
        res.json({ message: 'Photo deleted' });
    } catch (e) { res.status(500).json({ message: 'Error deleting photo' }); }
});

// ==========================================================================
// --- PROTECTED: Food Search (USDA FoodData Central + local fallback) ---
// ==========================================================================

// Curated local database for instant fallback when API is unavailable
// Values are per 100g unless noted. Serving size in grams.
const LOCAL_FOODS = [
    // Proteins
    { name: 'Huevo entero',          brand: null, serving: 50,  cal100: 155, p100: 13.0, c100: 1.1,  f100: 11.0 },
    { name: 'Huevo (clara)',         brand: null, serving: 33,  cal100: 52,  p100: 11.0, c100: 0.7,  f100: 0.2  },
    { name: 'Huevo (yema)',          brand: null, serving: 17,  cal100: 322, p100: 15.9, c100: 3.6,  f100: 26.5 },
    { name: 'Pechuga de pollo',      brand: null, serving: 100, cal100: 165, p100: 31.0, c100: 0.0,  f100: 3.6  },
    { name: 'Muslo de pollo',        brand: null, serving: 100, cal100: 209, p100: 26.0, c100: 0.0,  f100: 10.9 },
    { name: 'Carne molida 80/20',    brand: null, serving: 100, cal100: 254, p100: 17.2, c100: 0.0,  f100: 20.0 },
    { name: 'Carne molida 90/10',    brand: null, serving: 100, cal100: 176, p100: 20.0, c100: 0.0,  f100: 10.0 },
    { name: 'Salmón',               brand: null, serving: 100, cal100: 208, p100: 20.0, c100: 0.0,  f100: 13.0 },
    { name: 'Atún en agua',          brand: null, serving: 85,  cal100: 116, p100: 26.0, c100: 0.0,  f100: 1.0  },
    { name: 'Camarones',            brand: null, serving: 100, cal100: 99,  p100: 24.0, c100: 0.2,  f100: 0.3  },
    { name: 'Jamón de pavo',         brand: null, serving: 56,  cal100: 107, p100: 16.0, c100: 2.0,  f100: 3.0  },
    { name: 'Jamón de cerdo',        brand: null, serving: 56,  cal100: 163, p100: 14.0, c100: 3.0,  f100: 10.0 },
    { name: 'Tocino / Bacon',        brand: null, serving: 28,  cal100: 541, p100: 37.0, c100: 1.4,  f100: 42.0 },
    { name: 'Tilapia',              brand: null, serving: 100, cal100: 128, p100: 26.0, c100: 0.0,  f100: 2.7  },
    { name: 'Pavo molido',           brand: null, serving: 100, cal100: 189, p100: 19.0, c100: 0.0,  f100: 11.8 },
    // Dairy
    { name: 'Leche entera',          brand: null, serving: 240, cal100: 61,  p100: 3.2,  c100: 4.8,  f100: 3.3  },
    { name: 'Leche descremada',      brand: null, serving: 240, cal100: 35,  p100: 3.4,  c100: 5.0,  f100: 0.1  },
    { name: 'Yogurt griego (0%)',    brand: null, serving: 170, cal100: 59,  p100: 10.0, c100: 3.6,  f100: 0.4  },
    { name: 'Yogurt griego (2%)',    brand: null, serving: 170, cal100: 73,  p100: 9.0,  c100: 4.0,  f100: 2.0  },
    { name: 'Queso cheddar',         brand: null, serving: 28,  cal100: 403, p100: 25.0, c100: 1.3,  f100: 33.0 },
    { name: 'Queso cottage',         brand: null, serving: 113, cal100: 98,  p100: 11.0, c100: 3.4,  f100: 4.3  },
    { name: 'Queso mozzarella',      brand: null, serving: 28,  cal100: 280, p100: 28.0, c100: 2.2,  f100: 17.0 },
    { name: 'Mantequilla',          brand: null, serving: 14,  cal100: 717, p100: 0.9,  c100: 0.1,  f100: 81.0 },
    // Grains / Carbs
    { name: 'Arroz blanco (cocido)', brand: null, serving: 186, cal100: 130, p100: 2.7,  c100: 28.0, f100: 0.3  },
    { name: 'Arroz integral (cocido)',brand: null, serving: 195,cal100: 111, p100: 2.6,  c100: 23.0, f100: 0.9  },
    { name: 'Avena (cruda)',         brand: null, serving: 40,  cal100: 389, p100: 16.9, c100: 66.0, f100: 6.9  },
    { name: 'Pan blanco',            brand: null, serving: 28,  cal100: 265, p100: 9.0,  c100: 49.0, f100: 3.2  },
    { name: 'Pan integral',          brand: null, serving: 28,  cal100: 247, p100: 13.0, c100: 41.0, f100: 3.4  },
    { name: 'Pasta (cocida)',        brand: null, serving: 140, cal100: 131, p100: 5.0,  c100: 25.0, f100: 1.1  },
    { name: 'Papa / Patata',         brand: null, serving: 150, cal100: 77,  p100: 2.0,  c100: 17.0, f100: 0.1  },
    { name: 'Camote / Batata',       brand: null, serving: 130, cal100: 86,  p100: 1.6,  c100: 20.0, f100: 0.1  },
    { name: 'Tortilla de maíz',      brand: null, serving: 28,  cal100: 218, p100: 5.7,  c100: 46.0, f100: 2.5  },
    { name: 'Tortilla de harina',    brand: null, serving: 45,  cal100: 309, p100: 8.0,  c100: 55.0, f100: 7.5  },
    { name: 'Quinoa (cocida)',       brand: null, serving: 185, cal100: 120, p100: 4.4,  c100: 21.3, f100: 1.9  },
    // Fats
    { name: 'Aceite de oliva',       brand: null, serving: 14,  cal100: 884, p100: 0.0,  c100: 0.0,  f100: 100.0},
    { name: 'Aguacate / Palta',      brand: null, serving: 150, cal100: 160, p100: 2.0,  c100: 9.0,  f100: 15.0 },
    { name: 'Almendras',            brand: null, serving: 28,  cal100: 579, p100: 21.0, c100: 22.0, f100: 50.0 },
    { name: 'Maní / Cacahuate',      brand: null, serving: 28,  cal100: 567, p100: 26.0, c100: 16.0, f100: 49.0 },
    { name: 'Mantequilla de maní',   brand: null, serving: 32,  cal100: 588, p100: 25.0, c100: 20.0, f100: 50.0 },
    { name: 'Nueces',               brand: null, serving: 28,  cal100: 654, p100: 15.0, c100: 14.0, f100: 65.0 },
    { name: 'Aceite de coco',        brand: null, serving: 14,  cal100: 862, p100: 0.0,  c100: 0.0,  f100: 100.0},
    // Vegetables
    { name: 'Brócoli',              brand: null, serving: 91,  cal100: 34,  p100: 2.8,  c100: 7.0,  f100: 0.4  },
    { name: 'Espinaca',             brand: null, serving: 30,  cal100: 23,  p100: 2.9,  c100: 3.6,  f100: 0.4  },
    { name: 'Lechuga romana',        brand: null, serving: 85,  cal100: 17,  p100: 1.2,  c100: 3.3,  f100: 0.3  },
    { name: 'Pepino',               brand: null, serving: 120, cal100: 15,  p100: 0.7,  c100: 3.6,  f100: 0.1  },
    { name: 'Tomate',               brand: null, serving: 123, cal100: 18,  p100: 0.9,  c100: 3.9,  f100: 0.2  },
    { name: 'Zanahoria',            brand: null, serving: 61,  cal100: 41,  p100: 0.9,  c100: 10.0, f100: 0.2  },
    { name: 'Cebolla',              brand: null, serving: 110, cal100: 40,  p100: 1.1,  c100: 9.3,  f100: 0.1  },
    { name: 'Ajo',                  brand: null, serving: 3,   cal100: 149, p100: 6.4,  c100: 33.0, f100: 0.5  },
    { name: 'Maíz (grano)',          brand: null, serving: 154, cal100: 86,  p100: 3.3,  c100: 19.0, f100: 1.4  },
    { name: 'Frijoles negros (cocidos)',brand:null,serving:172,cal100: 132, p100: 8.9,  c100: 24.0, f100: 0.5  },
    { name: 'Lentejas (cocidas)',    brand: null, serving: 198, cal100: 116, p100: 9.0,  c100: 20.0, f100: 0.4  },
    // Fruits
    { name: 'Manzana',              brand: null, serving: 182, cal100: 52,  p100: 0.3,  c100: 14.0, f100: 0.2  },
    { name: 'Banana / Plátano',      brand: null, serving: 118, cal100: 89,  p100: 1.1,  c100: 23.0, f100: 0.3  },
    { name: 'Naranja',              brand: null, serving: 131, cal100: 47,  p100: 0.9,  c100: 12.0, f100: 0.1  },
    { name: 'Mango',                brand: null, serving: 165, cal100: 60,  p100: 0.8,  c100: 15.0, f100: 0.4  },
    { name: 'Fresas / Frutillas',    brand: null, serving: 152, cal100: 32,  p100: 0.7,  c100: 7.7,  f100: 0.3  },
    { name: 'Arándanos',            brand: null, serving: 148, cal100: 57,  p100: 0.7,  c100: 14.5, f100: 0.3  },
    { name: 'Piña',                 brand: null, serving: 165, cal100: 50,  p100: 0.5,  c100: 13.0, f100: 0.1  },
    // Supplements / Shakes
    { name: 'Proteína en polvo (whey)',brand:null, serving: 30, cal100: 367, p100: 80.0, c100: 10.0, f100: 5.0  },
    { name: 'Proteína en polvo (planta)',brand:null,serving:30, cal100: 350, p100: 70.0, c100: 15.0, f100: 7.0  },
    // Common prepared
    { name: 'Huevos revueltos',      brand: null, serving: 100, cal100: 149, p100: 10.1, c100: 1.6,  f100: 11.0 },
    { name: 'Pechuga a la plancha',  brand: null, serving: 100, cal100: 165, p100: 31.0, c100: 0.0,  f100: 3.6  },
    // Beverages (serving = typical portion in ml)
    { name: 'Café negro',            brand: null, serving: 240, cal100: 1,   p100: 0.1,  c100: 0.0,  f100: 0.0  },
    { name: 'Café americano',        brand: null, serving: 240, cal100: 1,   p100: 0.1,  c100: 0.0,  f100: 0.0  },
    { name: 'Café espresso',         brand: null, serving: 30,  cal100: 9,   p100: 0.6,  c100: 0.0,  f100: 0.2  },
    { name: 'Café con leche',        brand: null, serving: 240, cal100: 40,  p100: 2.0,  c100: 3.5,  f100: 1.5  },
    { name: 'Café latte',            brand: null, serving: 360, cal100: 42,  p100: 2.5,  c100: 4.5,  f100: 1.5  },
    { name: 'Café capuchino',        brand: null, serving: 180, cal100: 40,  p100: 2.5,  c100: 4.0,  f100: 1.5  },
    { name: 'Té negro (sin azúcar)', brand: null, serving: 240, cal100: 1,   p100: 0.0,  c100: 0.3,  f100: 0.0  },
    { name: 'Té verde (sin azúcar)', brand: null, serving: 240, cal100: 1,   p100: 0.0,  c100: 0.3,  f100: 0.0  },
    { name: 'Agua',                  brand: null, serving: 240, cal100: 0,   p100: 0.0,  c100: 0.0,  f100: 0.0  },
    { name: 'Jugo de naranja',       brand: null, serving: 240, cal100: 45,  p100: 0.7,  c100: 10.4, f100: 0.2  },
    { name: 'Jugo de manzana',       brand: null, serving: 240, cal100: 46,  p100: 0.1,  c100: 11.4, f100: 0.1  },
    { name: 'Refresco / Soda',       brand: null, serving: 355, cal100: 40,  p100: 0.0,  c100: 10.6, f100: 0.0  },
    { name: 'Refresco light / Diet', brand: null, serving: 355, cal100: 0,   p100: 0.0,  c100: 0.0,  f100: 0.0  },
    { name: 'Bebida energética',     brand: null, serving: 250, cal100: 45,  p100: 0.0,  c100: 11.3, f100: 0.0  },
    { name: 'Leche de almendra',     brand: null, serving: 240, cal100: 15,  p100: 0.6,  c100: 0.6,  f100: 1.1  },
    { name: 'Leche de avena',        brand: null, serving: 240, cal100: 40,  p100: 1.0,  c100: 7.0,  f100: 1.5  },
    { name: 'Proteína shake (preparado)',brand:null,serving:330,cal100: 52,  p100: 9.0,  c100: 2.5,  f100: 1.0  },
    // Caribbean / Puerto Rican staples
    { name: 'Plátano maduro',           brand: null, serving: 100, cal100: 122, p100: 1.3,  c100: 31.9, f100: 0.4  },
    { name: 'Plátano verde',            brand: null, serving: 100, cal100: 116, p100: 1.3,  c100: 31.2, f100: 0.2  },
    { name: 'Yuca cocida',              brand: null, serving: 100, cal100: 112, p100: 0.7,  c100: 26.8, f100: 0.3  },
    { name: 'Yautía cocida',            brand: null, serving: 100, cal100: 98,  p100: 1.4,  c100: 23.0, f100: 0.1  },
    { name: 'Malanga cocida',           brand: null, serving: 100, cal100: 112, p100: 1.5,  c100: 26.5, f100: 0.2  },
    { name: 'Calabaza tropical',        brand: null, serving: 116, cal100: 26,  p100: 1.0,  c100: 6.5,  f100: 0.1  },
    { name: 'Panapén / Pan de fruta',   brand: null, serving: 100, cal100: 103, p100: 1.1,  c100: 27.1, f100: 0.2  },
    { name: 'Gandules cocidos',         brand: null, serving: 164, cal100: 143, p100: 9.0,  c100: 25.0, f100: 1.9  },
    { name: 'Habichuelas rosadas',      brand: null, serving: 172, cal100: 130, p100: 8.5,  c100: 23.6, f100: 0.5  },
    { name: 'Habichuelas negras',       brand: null, serving: 172, cal100: 132, p100: 8.9,  c100: 24.0, f100: 0.5  },
    { name: 'Guayaba',                  brand: null, serving: 55,  cal100: 68,  p100: 2.6,  c100: 14.3, f100: 1.0  },
    { name: 'Guanábana / Soursop',      brand: null, serving: 100, cal100: 66,  p100: 1.0,  c100: 16.8, f100: 0.3  },
    { name: 'Mamey sapote',             brand: null, serving: 175, cal100: 83,  p100: 1.1,  c100: 19.9, f100: 0.5  },
    { name: 'Acerola',                  brand: null, serving: 75,  cal100: 32,  p100: 0.4,  c100: 7.7,  f100: 0.3  },
    // Vegetables (missing from list)
    { name: 'Espárragos',               brand: null, serving: 90,  cal100: 20,  p100: 2.2,  c100: 3.9,  f100: 0.1  },
    { name: 'Coliflor',                 brand: null, serving: 100, cal100: 25,  p100: 1.9,  c100: 5.0,  f100: 0.3  },
    { name: 'Repollo / Col',            brand: null, serving: 90,  cal100: 25,  p100: 1.3,  c100: 5.8,  f100: 0.1  },
    { name: 'Remolacha',                brand: null, serving: 136, cal100: 43,  p100: 1.6,  c100: 9.6,  f100: 0.2  },
    { name: 'Pimientos / Ají dulce',    brand: null, serving: 119, cal100: 20,  p100: 0.9,  c100: 4.6,  f100: 0.2  },
    { name: 'Berenjenas',               brand: null, serving: 82,  cal100: 25,  p100: 1.0,  c100: 5.9,  f100: 0.2  },
    { name: 'Kale / Col rizada',        brand: null, serving: 67,  cal100: 35,  p100: 2.9,  c100: 4.4,  f100: 1.5  },
    { name: 'Setas / Hongos',           brand: null, serving: 96,  cal100: 22,  p100: 3.1,  c100: 3.3,  f100: 0.3  },
    { name: 'Apio (celery)',            brand: null, serving: 80,  cal100: 16,  p100: 0.7,  c100: 3.0,  f100: 0.2  },
    // Fruits (missing from list)
    { name: 'Melocotón / Durazno',      brand: null, serving: 150, cal100: 39,  p100: 0.9,  c100: 9.5,  f100: 0.3  },
    { name: 'Cerezas',                  brand: null, serving: 138, cal100: 50,  p100: 1.0,  c100: 12.2, f100: 0.3  },
    { name: 'Frambuesas',               brand: null, serving: 123, cal100: 52,  p100: 1.2,  c100: 11.9, f100: 0.7  },
    { name: 'Higos frescos',            brand: null, serving: 64,  cal100: 74,  p100: 0.8,  c100: 19.2, f100: 0.3  },
    { name: 'Kiwi',                     brand: null, serving: 76,  cal100: 61,  p100: 1.1,  c100: 14.7, f100: 0.5  },
    // Seeds & specialty
    { name: 'Semillas de chía',         brand: null, serving: 12,  cal100: 486, p100: 16.5, c100: 42.1, f100: 30.7 },
    { name: 'Semillas de hemp',         brand: null, serving: 30,  cal100: 553, p100: 31.6, c100: 8.7,  f100: 48.8 },
    { name: 'Edamame',                  brand: null, serving: 155, cal100: 122, p100: 11.9, c100: 8.9,  f100: 5.2  },
    // Extra protein sources
    { name: 'Sardinas (enlatadas)',      brand: null, serving: 48,  cal100: 208, p100: 24.6, c100: 0.0,  f100: 11.5 },
    { name: 'Ricotta',                  brand: null, serving: 60,  cal100: 174, p100: 11.3, c100: 3.0,  f100: 13.0 },
    { name: 'Yogurt natural (sin grasa)',brand: null, serving: 240, cal100: 56,  p100: 5.7,  c100: 7.7,  f100: 0.4  },
    // ── Costco E. Bayamón — Proteins ─────────────────────────────────────────
    { name: 'Kirkland Chicken Breast (lata)',   brand:'Kirkland Signature', serving: 56,  cal100: 140, p100: 30.0, c100: 0.0,  f100: 2.0  },
    { name: 'Kirkland Albacore Tuna (agua)',    brand:'Kirkland Signature', serving: 56,  cal100: 107, p100: 23.2, c100: 0.0,  f100: 1.8  },
    { name: 'Wild Planet Albacore Wild Tuna',   brand:'Wild Planet',        serving: 56,  cal100: 143, p100: 25.0, c100: 0.0,  f100: 4.5  },
    { name: 'Chicken of the Sea Tuna (agua)',   brand:'Chicken of the Sea', serving: 56,  cal100: 98,  p100: 21.4, c100: 0.0,  f100: 0.9  },
    { name: "Morey's Salmon Silvestre Sazonado",brand:"Morey's",            serving: 112, cal100: 161, p100: 18.8, c100: 2.7,  f100: 8.0  },
    { name: 'Kirkland Steak Strips (jerky)',    brand:'Kirkland Signature', serving: 28,  cal100: 286, p100: 35.7, c100: 14.3, f100: 8.9  },
    { name: 'Kirkland Chicken Tenderloins',     brand:'Kirkland Signature', serving: 112, cal100: 120, p100: 26.0, c100: 0.0,  f100: 1.5  },
    // ── Costco E. Bayamón — Dairy / Yogurt ───────────────────────────────────
    { name: 'Kirkland Greek Yogurt Orgánico',   brand:'Kirkland Signature', serving: 170, cal100: 76,  p100: 10.6, c100: 4.7,  f100: 1.8  },
    { name: 'Oikos Triple Zero Greek Yogurt',   brand:'Oikos',              serving: 150, cal100: 60,  p100: 10.0, c100: 6.0,  f100: 0.0  },
    { name: 'Chobani Protein Greek Yogurt',     brand:'Chobani',            serving: 190, cal100: 63,  p100: 10.5, c100: 4.2,  f100: 1.3  },
    // ── Costco E. Bayamón — Protein Bars & Shakes ────────────────────────────
    { name: 'Kirkland Chewy Protein Bar',       brand:'Kirkland Signature', serving: 40,  cal100: 475, p100: 22.5, c100: 57.5, f100: 20.0 },
    { name: 'Kirkland Protein Bar',             brand:'Kirkland Signature', serving: 60,  cal100: 317, p100: 35.0, c100: 35.0, f100: 11.7 },
    { name: 'FITCRUNCH Protein Bar',            brand:'FITCRUNCH',          serving: 46,  cal100: 413, p100: 34.8, c100: 43.5, f100: 15.2 },
    { name: 'Nature Valley Protein Bar',        brand:'Nature Valley',      serving: 40,  cal100: 475, p100: 25.0, c100: 40.0, f100: 27.5 },
    { name: 'Pure Protein Bar',                 brand:'Pure Protein',       serving: 50,  cal100: 360, p100: 40.0, c100: 30.0, f100: 10.0 },
    { name: 'BUILT Puff Protein Bar',           brand:'BUILT',              serving: 40,  cal100: 275, p100: 42.5, c100: 25.0, f100: 3.8  },
    { name: 'Premier Protein Shake 30g',        brand:'Premier Protein',    serving: 325, cal100: 49,  p100: 9.2,  c100: 1.5,  f100: 0.9  },
    { name: 'Vital Proteins Collagen Peptides', brand:'Vital Proteins',     serving: 10,  cal100: 350, p100: 90.0, c100: 0.0,  f100: 0.0  },
    { name: 'Orgain Collagen Péptidos',         brand:'Orgain',             serving: 10,  cal100: 400, p100: 90.0, c100: 0.0,  f100: 0.0  },
    { name: 'Orgain Proteína Vegetal Powder',   brand:'Orgain',             serving: 46,  cal100: 326, p100: 45.7, c100: 32.6, f100: 8.7  },
    // ── Costco E. Bayamón — Nuts & Butters ───────────────────────────────────
    { name: 'Kirkland Peanut Butter Orgánico',  brand:'Kirkland Signature', serving: 32,  cal100: 594, p100: 21.9, c100: 25.0, f100: 50.0 },
    { name: 'Kirkland Almond Butter',           brand:'Kirkland Signature', serving: 32,  cal100: 625, p100: 21.9, c100: 18.8, f100: 56.3 },
    { name: 'Kirkland Mixed Nuts',              brand:'Kirkland Signature', serving: 28,  cal100: 607, p100: 17.9, c100: 21.4, f100: 50.0 },
    { name: 'Kirkland Super Large Peanuts',     brand:'Kirkland Signature', serving: 28,  cal100: 571, p100: 25.0, c100: 17.9, f100: 46.4 },
    // ── Costco E. Bayamón — Grains & Snacks ──────────────────────────────────
    { name: 'Seeds of Change Quinoa & Brown Rice',brand:'Seeds of Change',  serving: 160, cal100: 137, p100: 3.1,  c100: 27.5, f100: 1.9  },
    { name: 'Kirkland Ancient Grain Granola',   brand:'Kirkland Signature', serving: 55,  cal100: 400, p100: 7.3,  c100: 63.6, f100: 16.4 },
    { name: 'Kirkland Soft Chewy Granola Bar',  brand:'Kirkland Signature', serving: 24,  cal100: 375, p100: 4.2,  c100: 75.0, f100: 8.3  },
    { name: 'Simple Mills Almond Flour Crackers',brand:'Simple Mills',      serving: 28,  cal100: 464, p100: 7.1,  c100: 53.6, f100: 25.0 },
    // ── Costco E. Bayamón — Produce & Frozen ─────────────────────────────────
    { name: 'Kirkland Stir-Fry Vegetable Blend',brand:'Kirkland Signature', serving: 85,  cal100: 35,  p100: 2.4,  c100: 7.1,  f100: 0.1  },
    { name: 'Kirkland Organic Broccoli (frozen)',brand:'Kirkland Signature', serving: 85,  cal100: 35,  p100: 2.4,  c100: 7.1,  f100: 0.1  },
    { name: 'Kirkland Three Berry Blend',       brand:'Kirkland Signature', serving: 130, cal100: 50,  p100: 0.8,  c100: 12.3, f100: 0.1  },
    { name: 'Kirkland Organic Diced Tomatoes',  brand:'Kirkland Signature', serving: 127, cal100: 20,  p100: 0.8,  c100: 3.9,  f100: 0.0  },
    { name: 'Kirkland Organic Strawberries (frozen)',brand:'Kirkland Signature',serving:100,cal100: 33, p100: 0.7,  c100: 7.7,  f100: 0.3  },
    { name: 'Kirkland Organic Blueberries (frozen)',brand:'Kirkland Signature',serving:100,cal100: 57,  p100: 0.7,  c100: 14.5, f100: 0.3  },
    { name: 'Del Monte Green Beans (lata)',     brand:'Del Monte',          serving: 120, cal100: 17,  p100: 0.8,  c100: 3.3,  f100: 0.0  },
    { name: 'Repollo de Bruselas (orgánico)',   brand: null,                serving: 88,  cal100: 43,  p100: 3.4,  c100: 9.1,  f100: 0.3  },
    // ── Costco E. Bayamón — Beverages ────────────────────────────────────────
    { name: 'Kirkland Organic Coconut Water',   brand:'Kirkland Signature', serving: 330, cal100: 18,  p100: 0.0,  c100: 4.5,  f100: 0.0  },
    { name: 'Vita Coco Coconut Water',          brand:'Vita Coco',          serving: 330, cal100: 18,  p100: 0.0,  c100: 4.5,  f100: 0.0  },
    { name: 'Alani Nu Energy Drink',            brand:'Alani Nu',           serving: 355, cal100: 3,   p100: 0.0,  c100: 0.6,  f100: 0.0  },
    { name: 'Kirkland Sparkling Energy Drink',  brand:'Kirkland Signature', serving: 355, cal100: 3,   p100: 0.0,  c100: 0.6,  f100: 0.0  },
    { name: 'PRIME Hydration Drink',            brand:'PRIME',              serving: 500, cal100: 5,   p100: 0.4,  c100: 1.0,  f100: 0.0  },
    // Condiments & Sauces (serving = 1 tbsp ~15g unless noted)
    { name: 'Mayonesa',              brand: null, serving: 15,  cal100: 680, p100: 0.9,  c100: 0.6,  f100: 75.0 },
    { name: 'Mayonesa light',        brand: null, serving: 15,  cal100: 320, p100: 0.9,  c100: 5.0,  f100: 32.0 },
    { name: 'Ketchup / Catsup',      brand: null, serving: 15,  cal100: 101, p100: 1.3,  c100: 25.0, f100: 0.1  },
    { name: 'Mostaza amarilla',      brand: null, serving: 5,   cal100: 66,  p100: 4.4,  c100: 5.8,  f100: 3.6  },
    { name: 'Mostaza Dijon',         brand: null, serving: 5,   cal100: 90,  p100: 5.0,  c100: 5.0,  f100: 5.0  },
    { name: 'Salsa de soya',         brand: null, serving: 15,  cal100: 53,  p100: 8.1,  c100: 4.9,  f100: 0.6  },
    { name: 'Salsa Worcestershire',  brand: null, serving: 5,   cal100: 78,  p100: 2.3,  c100: 19.0, f100: 0.1  },
    { name: 'Salsa picante / hot sauce',brand:null,serving:5,   cal100: 18,  p100: 1.0,  c100: 3.0,  f100: 0.5  },
    { name: 'Salsa BBQ',             brand: null, serving: 30,  cal100: 172, p100: 1.5,  c100: 40.0, f100: 0.5  },
    { name: 'Salsa de tomate (marinara)',brand:null,serving:60, cal100: 50,  p100: 1.7,  c100: 9.0,  f100: 1.0  },
    { name: 'Aderezo ranch',         brand: null, serving: 30,  cal100: 327, p100: 1.1,  c100: 6.3,  f100: 33.0 },
    { name: 'Aderezo cesar',         brand: null, serving: 30,  cal100: 340, p100: 3.0,  c100: 3.0,  f100: 35.0 },
    { name: 'Aderezo italiano',      brand: null, serving: 30,  cal100: 180, p100: 0.3,  c100: 4.0,  f100: 18.0 },
    { name: 'Aderezo balsámico',     brand: null, serving: 15,  cal100: 133, p100: 0.5,  c100: 27.0, f100: 0.4  },
    { name: 'Vinagre de manzana',    brand: null, serving: 15,  cal100: 21,  p100: 0.0,  c100: 0.9,  f100: 0.0  },
    { name: 'Crema agria',           brand: null, serving: 30,  cal100: 193, p100: 2.1,  c100: 4.4,  f100: 19.0 },
    { name: 'Guacamole',             brand: null, serving: 30,  cal100: 157, p100: 1.9,  c100: 8.6,  f100: 14.0 },
    { name: 'Hummus',                brand: null, serving: 30,  cal100: 166, p100: 8.0,  c100: 14.0, f100: 10.0 },
    { name: 'Mermelada / Jelly',     brand: null, serving: 20,  cal100: 250, p100: 0.4,  c100: 65.0, f100: 0.1  },
    { name: 'Miel',                  brand: null, serving: 21,  cal100: 304, p100: 0.3,  c100: 82.0, f100: 0.0  },
    { name: 'Syrup / Jarabe de maple',brand:null,  serving: 30,  cal100: 261, p100: 0.0,  c100: 67.0, f100: 0.1  },
    { name: 'Crema de cacahuate (PB)',brand:null,  serving: 32,  cal100: 588, p100: 25.0, c100: 20.0, f100: 50.0 },
    { name: 'Nutella / Hazelnut spread',brand:null,serving: 15, cal100: 539, p100: 6.3,  c100: 57.5, f100: 30.9 },

    // ── Common gaps (proteins) ───────────────────────────────────────────
    { name: 'Chuleta de cerdo',        brand: null, serving: 120, cal100: 231, p100: 26.0, c100: 0.0,  f100: 14.0 },
    { name: 'Lomo de cerdo',           brand: null, serving: 120, cal100: 170, p100: 26.0, c100: 0.0,  f100: 7.0  },
    { name: 'Bistec de res / Carne de res', brand: null, serving: 120, cal100: 206, p100: 28.0, c100: 0.0, f100: 9.0 },
    { name: 'Pechuga de pavo',         brand: null, serving: 120, cal100: 135, p100: 30.0, c100: 0.0,  f100: 1.0  },
    { name: 'Bacalao / Cod',           brand: null, serving: 120, cal100: 105, p100: 23.0, c100: 0.0,  f100: 0.9  },
    { name: 'Salchicha / Hot dog',     brand: null, serving: 45,  cal100: 290, p100: 10.0, c100: 4.0,  f100: 26.0 },
    { name: 'Chorizo',                 brand: null, serving: 60,  cal100: 455, p100: 24.0, c100: 2.0,  f100: 38.0 },
    { name: 'Garbanzos (cocidos)',     brand: null, serving: 100, cal100: 164, p100: 8.9,  c100: 27.4, f100: 2.6  },

    // ── Common gaps (dairy / cheese) ─────────────────────────────────────
    { name: 'Queso blanco / Queso del país', brand: null, serving: 40, cal100: 300, p100: 21.0, c100: 3.0, f100: 23.0 },
    { name: 'Queso parmesano',         brand: null, serving: 15,  cal100: 431, p100: 38.0, c100: 4.0,  f100: 29.0 },
    { name: 'Crema / Heavy cream',     brand: null, serving: 30,  cal100: 340, p100: 2.8,  c100: 2.8,  f100: 36.0 },
    { name: 'Helado de vainilla',      brand: null, serving: 65,  cal100: 207, p100: 3.5,  c100: 24.0, f100: 11.0 },

    // ── Common gaps (nuts / fats) ────────────────────────────────────────
    { name: 'Anacardos / Cashews',     brand: null, serving: 28,  cal100: 553, p100: 18.0, c100: 30.0, f100: 44.0 },
    { name: 'Pistachos',               brand: null, serving: 28,  cal100: 562, p100: 20.0, c100: 28.0, f100: 45.0 },
    { name: 'Aceitunas / Olives',      brand: null, serving: 15,  cal100: 115, p100: 0.8,  c100: 6.0,  f100: 11.0 },

    // ── Common gaps (carbs) ──────────────────────────────────────────────
    { name: 'Cereal (hojuelas de maíz)', brand: null, serving: 30, cal100: 357, p100: 7.0, c100: 84.0, f100: 0.9 },

    // ── Common gaps (fruits) ─────────────────────────────────────────────
    { name: 'Sandía / Watermelon',     brand: null, serving: 150, cal100: 30,  p100: 0.6,  c100: 7.6,  f100: 0.2  },
    { name: 'Melón / Cantaloupe',      brand: null, serving: 150, cal100: 34,  p100: 0.8,  c100: 8.0,  f100: 0.2  },
    { name: 'Uvas / Grapes',           brand: null, serving: 100, cal100: 69,  p100: 0.7,  c100: 18.0, f100: 0.2  },
    { name: 'Papaya / Lechosa',        brand: null, serving: 140, cal100: 43,  p100: 0.5,  c100: 11.0, f100: 0.3  },
    { name: 'Pera / Pear',             brand: null, serving: 150, cal100: 57,  p100: 0.4,  c100: 15.0, f100: 0.1  },
    { name: 'Toronja / Grapefruit',    brand: null, serving: 150, cal100: 42,  p100: 0.8,  c100: 11.0, f100: 0.1  },

    // ── Common gaps (vegetables) ─────────────────────────────────────────
    { name: 'Calabacín / Zucchini',    brand: null, serving: 100, cal100: 17,  p100: 1.2,  c100: 3.1,  f100: 0.3  },
    { name: 'Habichuelas tiernas / Green beans', brand: null, serving: 100, cal100: 35, p100: 1.9, c100: 7.9, f100: 0.2 },

    // ══ Comida criolla puertorriqueña — platos compuestos (macros aprox. por 100g) ══
    // ── Plátano y viandas ────────────────────────────────────────────────
    { name: 'Tostones',                brand: null, serving: 80,  cal100: 250, p100: 2.0,  c100: 38.0, f100: 11.0 },
    { name: 'Tostones rellenos',       brand: null, serving: 100, cal100: 270, p100: 8.0,  c100: 30.0, f100: 13.0 },
    { name: 'Amarillos / Plátanos maduros fritos', brand: null, serving: 100, cal100: 230, p100: 1.3, c100: 38.0, f100: 8.0 },
    { name: 'Mofongo',                 brand: null, serving: 150, cal100: 290, p100: 5.0,  c100: 35.0, f100: 15.0 },
    { name: 'Mofongo relleno',         brand: null, serving: 200, cal100: 250, p100: 12.0, c100: 25.0, f100: 12.0 },
    { name: 'Canoas (plátano relleno)',brand: null, serving: 150, cal100: 210, p100: 7.0,  c100: 24.0, f100: 10.0 },
    { name: 'Pastelón',                brand: null, serving: 150, cal100: 200, p100: 9.0,  c100: 18.0, f100: 11.0 },
    { name: 'Piononos',                brand: null, serving: 120, cal100: 230, p100: 8.0,  c100: 22.0, f100: 12.0 },
    { name: 'Alcapurrias',             brand: null, serving: 100, cal100: 280, p100: 6.0,  c100: 24.0, f100: 18.0 },
    { name: 'Arañitas',                brand: null, serving: 80,  cal100: 300, p100: 2.0,  c100: 36.0, f100: 17.0 },
    { name: 'Mariquitas / Plátano chips', brand: null, serving: 30, cal100: 520, p100: 2.0, c100: 64.0, f100: 29.0 },
    { name: 'Jibarito',                brand: null, serving: 250, cal100: 250, p100: 13.0, c100: 22.0, f100: 13.0 },
    // ── Frituras ─────────────────────────────────────────────────────────
    { name: 'Bacalaítos',              brand: null, serving: 60,  cal100: 290, p100: 8.0,  c100: 30.0, f100: 15.0 },
    { name: 'Sorullitos de maíz',      brand: null, serving: 60,  cal100: 310, p100: 6.0,  c100: 38.0, f100: 15.0 },
    { name: 'Empanadillas / Pastelillos', brand: null, serving: 90, cal100: 300, p100: 9.0, c100: 28.0, f100: 17.0 },
    { name: 'Rellenos de papa',        brand: null, serving: 120, cal100: 250, p100: 7.0,  c100: 24.0, f100: 14.0 },
    { name: 'Almojábanas',             brand: null, serving: 60,  cal100: 330, p100: 7.0,  c100: 35.0, f100: 18.0 },
    // ── Arroz, habichuelas y viandas ─────────────────────────────────────
    { name: 'Arroz con gandules',      brand: null, serving: 150, cal100: 160, p100: 3.5,  c100: 28.0, f100: 4.0  },
    { name: 'Arroz con pollo',         brand: null, serving: 200, cal100: 165, p100: 9.0,  c100: 20.0, f100: 5.0  },
    { name: 'Arroz mamposteao',        brand: null, serving: 150, cal100: 180, p100: 5.0,  c100: 28.0, f100: 5.0  },
    { name: 'Habichuelas guisadas',    brand: null, serving: 130, cal100: 110, p100: 5.0,  c100: 18.0, f100: 2.0  },
    { name: 'Pasteles',                brand: null, serving: 150, cal100: 180, p100: 6.0,  c100: 22.0, f100: 8.0  },
    { name: 'Funche / Polenta',        brand: null, serving: 150, cal100: 90,  p100: 2.0,  c100: 16.0, f100: 2.0  },
    // ── Carnes criollas ──────────────────────────────────────────────────
    { name: 'Pernil (cerdo asado)',    brand: null, serving: 120, cal100: 290, p100: 25.0, c100: 0.0,  f100: 21.0 },
    { name: 'Pollo guisado',           brand: null, serving: 150, cal100: 150, p100: 16.0, c100: 4.0,  f100: 8.0  },
    { name: 'Carne guisada',           brand: null, serving: 150, cal100: 185, p100: 18.0, c100: 6.0,  f100: 9.0  },
    { name: 'Pollo frito',             brand: null, serving: 120, cal100: 250, p100: 20.0, c100: 9.0,  f100: 15.0 },
    { name: 'Chuleta can-can',         brand: null, serving: 150, cal100: 350, p100: 22.0, c100: 8.0,  f100: 25.0 },
    { name: 'Bistec encebollado',      brand: null, serving: 150, cal100: 200, p100: 22.0, c100: 5.0,  f100: 10.0 },
    { name: 'Costillas BBQ',           brand: null, serving: 150, cal100: 290, p100: 22.0, c100: 8.0,  f100: 19.0 },
    // ── Pan y desayuno ───────────────────────────────────────────────────
    { name: 'Mallorca',                brand: null, serving: 80,  cal100: 350, p100: 7.0,  c100: 50.0, f100: 13.0 },
    { name: 'Pan sobao',               brand: null, serving: 60,  cal100: 280, p100: 8.0,  c100: 50.0, f100: 5.0  },
    { name: 'Quesito',                 brand: null, serving: 60,  cal100: 380, p100: 6.0,  c100: 40.0, f100: 22.0 },
    { name: 'Tripleta',                brand: null, serving: 250, cal100: 250, p100: 14.0, c100: 22.0, f100: 12.0 },
    // ── Sopas y guisos ───────────────────────────────────────────────────
    { name: 'Sancocho',                brand: null, serving: 250, cal100: 100, p100: 7.0,  c100: 10.0, f100: 3.0  },
    { name: 'Mondongo',                brand: null, serving: 250, cal100: 120, p100: 9.0,  c100: 8.0,  f100: 6.0  },
    { name: 'Asopao de pollo',         brand: null, serving: 250, cal100: 90,  p100: 7.0,  c100: 10.0, f100: 2.0  },
    // ── Postres ──────────────────────────────────────────────────────────
    { name: 'Flan',                    brand: null, serving: 100, cal100: 150, p100: 4.0,  c100: 22.0, f100: 5.0  },
    { name: 'Tembleque',               brand: null, serving: 100, cal100: 150, p100: 1.5,  c100: 22.0, f100: 6.0  },
    { name: 'Arroz con dulce',         brand: null, serving: 120, cal100: 200, p100: 2.5,  c100: 35.0, f100: 6.0  },
    { name: 'Tres leches',             brand: null, serving: 100, cal100: 290, p100: 6.0,  c100: 38.0, f100: 13.0 },
    { name: 'Besito de coco / Dulce de coco', brand: null, serving: 40, cal100: 400, p100: 3.0, c100: 55.0, f100: 19.0 },
    // ── Fast food / restaurante (EE.UU.) ─────────────────────────────────
    { name: 'Hamburguesa sencilla (con pan)',   brand: null, serving: 100, cal100: 245, p100: 12.2, c100: 30.0, f100: 9.0  },
    { name: 'Cheeseburger / Hamburguesa con queso', brand: null, serving: 113, cal100: 265, p100: 13.3, c100: 28.0, f100: 11.5 },
    { name: 'Hamburguesa doble con queso',      brand: null, serving: 219, cal100: 247, p100: 11.5, c100: 20.5, f100: 12.8 },
    { name: 'Papas fritas',                     brand: null, serving: 117, cal100: 312, p100: 3.4,  c100: 41.0, f100: 15.0 },
    { name: 'Nuggets de pollo',                 brand: null, serving: 96,  cal100: 297, p100: 15.5, c100: 18.0, f100: 18.8 },
    { name: 'Pizza de queso (slice)',           brand: null, serving: 107, cal100: 266, p100: 11.0, c100: 33.0, f100: 10.0 },
    { name: 'Pizza de pepperoni (slice)',       brand: null, serving: 113, cal100: 298, p100: 13.0, c100: 34.0, f100: 12.0 },
    { name: 'Hot dog completo (con pan)',       brand: null, serving: 100, cal100: 290, p100: 10.4, c100: 24.0, f100: 17.0 },
    { name: 'Taco de carne (crujiente)',        brand: null, serving: 78,  cal100: 218, p100: 10.3, c100: 16.7, f100: 12.8 },
    { name: 'Burrito de pollo',                 brand: null, serving: 250, cal100: 180, p100: 10.0, c100: 22.0, f100: 5.5  },
    { name: 'Quesadilla de pollo',              brand: null, serving: 180, cal100: 260, p100: 14.0, c100: 22.0, f100: 13.0 },
    { name: 'Alitas Buffalo',                   brand: null, serving: 100, cal100: 220, p100: 18.3, c100: 2.9,  f100: 14.7 },
    { name: 'Chicken tenders / Dedos de pollo', brand: null, serving: 130, cal100: 271, p100: 18.7, c100: 17.6, f100: 14.0 },
    { name: 'Sandwich de pollo (fast food)',    brand: null, serving: 190, cal100: 250, p100: 13.5, c100: 25.0, f100: 11.0 },
    { name: 'Wrap de pollo',                    brand: null, serving: 220, cal100: 190, p100: 12.5, c100: 18.5, f100: 7.5  },
    { name: 'Sub de pavo (6 pulgadas)',         brand: null, serving: 219, cal100: 114, p100: 8.2,  c100: 18.7, f100: 1.6  },
    { name: 'Ensalada César con pollo',         brand: null, serving: 300, cal100: 127, p100: 10.0, c100: 5.0,  f100: 7.5  },
    { name: 'Aros de cebolla',                  brand: null, serving: 85,  cal100: 411, p100: 4.6,  c100: 46.0, f100: 23.0 },
    // ── Comfort americano / casero ───────────────────────────────────────
    { name: 'Mac and cheese',                   brand: null, serving: 200, cal100: 176, p100: 6.6,  c100: 20.1, f100: 7.8  },
    { name: 'Lasaña de carne',                  brand: null, serving: 250, cal100: 132, p100: 8.0,  c100: 12.4, f100: 5.4  },
    { name: 'Espagueti con carne',              brand: null, serving: 250, cal100: 129, p100: 6.7,  c100: 15.9, f100: 4.3  },
    { name: 'Puré de papa',                     brand: null, serving: 210, cal100: 113, p100: 1.9,  c100: 17.0, f100: 4.2  },
    { name: 'Sopa de pollo con fideos',         brand: null, serving: 245, cal100: 36,  p100: 2.5,  c100: 3.7,  f100: 1.2  },
    { name: 'Sopa de vegetales',                brand: null, serving: 245, cal100: 30,  p100: 1.3,  c100: 5.5,  f100: 0.5  },
    { name: 'Chili con carne',                  brand: null, serving: 250, cal100: 115, p100: 8.0,  c100: 9.0,  f100: 5.4  },
    { name: 'Meatloaf / Pastel de carne',       brand: null, serving: 150, cal100: 200, p100: 15.0, c100: 8.0,  f100: 12.0 },
    { name: 'Pollo rostizado (rotisserie)',     brand: null, serving: 140, cal100: 190, p100: 24.0, c100: 0.0,  f100: 10.0 },
    { name: 'Grilled cheese / Sandwich de queso', brand: null, serving: 120, cal100: 330, p100: 12.0, c100: 30.0, f100: 18.0 },
    { name: 'Sandwich BLT',                     brand: null, serving: 150, cal100: 240, p100: 10.0, c100: 22.0, f100: 12.5 },
    { name: 'Sandwich PB&J',                    brand: null, serving: 100, cal100: 350, p100: 11.0, c100: 42.0, f100: 16.0 },
    { name: 'Ensalada de atún (con mayonesa)',  brand: null, serving: 100, cal100: 187, p100: 16.0, c100: 3.5,  f100: 12.0 },
    // ── Desayuno americano ───────────────────────────────────────────────
    { name: 'Pancakes / Panqueques',            brand: null, serving: 114, cal100: 227, p100: 6.4,  c100: 28.0, f100: 9.7  },
    { name: 'Waffles',                          brand: null, serving: 75,  cal100: 291, p100: 7.9,  c100: 33.0, f100: 14.0 },
    { name: 'Tostada francesa / French toast',  brand: null, serving: 130, cal100: 229, p100: 7.7,  c100: 25.0, f100: 11.0 },
    { name: 'Bagel',                            brand: null, serving: 105, cal100: 250, p100: 10.0, c100: 49.0, f100: 1.5  },
    { name: 'Croissant',                        brand: null, serving: 67,  cal100: 406, p100: 8.2,  c100: 45.8, f100: 21.0 },
    { name: 'Donut glaseado',                   brand: null, serving: 60,  cal100: 421, p100: 5.1,  c100: 49.0, f100: 22.8 },
    { name: 'Muffin de arándanos',              brand: null, serving: 113, cal100: 377, p100: 4.5,  c100: 54.0, f100: 16.0 },
    { name: 'Avena cocida (con agua)',          brand: null, serving: 234, cal100: 71,  p100: 2.5,  c100: 12.0, f100: 1.5  },
    { name: 'Cereal Cheerios',                  brand: null, serving: 28,  cal100: 376, p100: 12.1, c100: 73.2, f100: 6.7  },
    { name: 'Granola',                          brand: null, serving: 61,  cal100: 471, p100: 10.0, c100: 64.0, f100: 20.0 },
    { name: 'Huevo frito',                      brand: null, serving: 46,  cal100: 196, p100: 13.6, c100: 0.8,  f100: 15.0 },
    { name: 'Hash browns / Papas doradas',      brand: null, serving: 105, cal100: 265, p100: 3.0,  c100: 28.5, f100: 15.9 },
    { name: 'Salchicha de desayuno',            brand: null, serving: 48,  cal100: 325, p100: 13.0, c100: 2.0,  f100: 30.0 },
    // ── Snacks y dulces ──────────────────────────────────────────────────
    { name: 'Papitas / Potato chips',           brand: null, serving: 28,  cal100: 536, p100: 7.0,  c100: 53.0, f100: 34.0 },
    { name: 'Tortilla chips / Nachos (solos)',  brand: null, serving: 28,  cal100: 497, p100: 7.8,  c100: 63.0, f100: 24.0 },
    { name: 'Nachos con queso',                 brand: null, serving: 113, cal100: 306, p100: 8.0,  c100: 32.0, f100: 16.5 },
    { name: 'Pretzels',                         brand: null, serving: 28,  cal100: 380, p100: 10.0, c100: 80.0, f100: 2.9  },
    { name: 'Palomitas de maíz (con mantequilla)', brand: null, serving: 33, cal100: 500, p100: 9.0, c100: 57.0, f100: 28.0 },
    { name: 'Galletas saladas (soda crackers)', brand: null, serving: 28,  cal100: 421, p100: 9.4,  c100: 71.0, f100: 10.5 },
    { name: 'Galletas María',                   brand: null, serving: 26,  cal100: 443, p100: 7.0,  c100: 75.0, f100: 12.0 },
    { name: 'Galleta de chocolate chip',        brand: null, serving: 30,  cal100: 488, p100: 5.1,  c100: 65.0, f100: 23.0 },
    { name: 'Brownie',                          brand: null, serving: 56,  cal100: 466, p100: 6.0,  c100: 58.0, f100: 24.0 },
    { name: 'Cheesecake',                       brand: null, serving: 125, cal100: 321, p100: 5.5,  c100: 25.5, f100: 22.5 },
    { name: 'Pastel de manzana / Apple pie',    brand: null, serving: 125, cal100: 237, p100: 1.9,  c100: 34.0, f100: 11.0 },
    { name: 'Helado de chocolate',              brand: null, serving: 66,  cal100: 216, p100: 3.8,  c100: 28.2, f100: 11.0 },
    { name: 'Chocolate con leche (barra)',      brand: null, serving: 43,  cal100: 535, p100: 7.7,  c100: 59.0, f100: 30.0 },
    // ── Puerto Rico: platos y antojos adicionales ────────────────────────
    { name: 'Arroz blanco con habichuelas',     brand: null, serving: 300, cal100: 128, p100: 4.5,  c100: 24.0, f100: 1.5  },
    { name: 'Serenata de bacalao',              brand: null, serving: 250, cal100: 120, p100: 8.0,  c100: 10.0, f100: 5.0  },
    { name: 'Bacalao guisado',                  brand: null, serving: 250, cal100: 105, p100: 12.0, c100: 6.0,  f100: 3.5  },
    { name: 'Ensalada de coditos',              brand: null, serving: 200, cal100: 202, p100: 3.5,  c100: 22.0, f100: 11.0 },
    { name: 'Ensalada de papa',                 brand: null, serving: 200, cal100: 143, p100: 2.7,  c100: 11.0, f100: 10.0 },
    { name: 'Guineítos en escabeche',           brand: null, serving: 150, cal100: 135, p100: 1.0,  c100: 18.0, f100: 7.0  },
    { name: 'Pinchos de pollo',                 brand: null, serving: 120, cal100: 175, p100: 25.0, c100: 3.0,  f100: 7.0  },
    { name: 'Pinchos de cerdo',                 brand: null, serving: 120, cal100: 220, p100: 22.0, c100: 3.0,  f100: 13.0 },
    { name: 'Chicharrón de pollo',              brand: null, serving: 150, cal100: 290, p100: 22.0, c100: 12.0, f100: 17.0 },
    { name: 'Chicharrón de cerdo',              brand: null, serving: 28,  cal100: 544, p100: 61.0, c100: 0.0,  f100: 31.0 },
    { name: 'Carne frita de cerdo',             brand: null, serving: 150, cal100: 290, p100: 25.0, c100: 3.0,  f100: 19.0 },
    { name: 'Bistec empanizado',                brand: null, serving: 180, cal100: 250, p100: 18.0, c100: 12.0, f100: 15.0 },
    { name: 'Churrasco (con chimichurri)',      brand: null, serving: 170, cal100: 250, p100: 26.0, c100: 1.0,  f100: 16.0 },
    { name: 'Camarones al ajillo',              brand: null, serving: 150, cal100: 150, p100: 18.0, c100: 3.0,  f100: 7.0  },
    { name: 'Arroz con calamares',              brand: null, serving: 250, cal100: 145, p100: 6.0,  c100: 25.0, f100: 2.5  },
    { name: 'Arroz chino boricua (frito)',      brand: null, serving: 300, cal100: 163, p100: 6.0,  c100: 21.0, f100: 5.5  },
    { name: 'Salchichas guisadas (de lata)',    brand: null, serving: 150, cal100: 200, p100: 9.0,  c100: 6.0,  f100: 16.0 },
    { name: 'Corned beef guisado',              brand: null, serving: 150, cal100: 180, p100: 12.0, c100: 6.0,  f100: 12.0 },
    { name: 'Jamonilla / Spam (frita)',         brand: null, serving: 56,  cal100: 310, p100: 13.0, c100: 3.0,  f100: 27.0 },
    { name: 'Morcilla',                         brand: null, serving: 100, cal100: 379, p100: 14.6, c100: 1.3,  f100: 34.5 },
    { name: 'Longaniza',                        brand: null, serving: 75,  cal100: 320, p100: 15.0, c100: 2.0,  f100: 28.0 },
    { name: 'Salchichón',                       brand: null, serving: 28,  cal100: 336, p100: 19.0, c100: 2.0,  f100: 28.0 },
    { name: 'Revoltillo con jamón',             brand: null, serving: 120, cal100: 170, p100: 12.0, c100: 2.0,  f100: 12.5 },
    { name: 'Pan de agua',                      brand: null, serving: 60,  cal100: 270, p100: 8.5,  c100: 55.0, f100: 1.5  },
    { name: 'Tostada con mantequilla (pan sobao)', brand: null, serving: 60, cal100: 330, p100: 7.0, c100: 45.0, f100: 13.0 },
    { name: 'Sandwich de jamón y queso',        brand: null, serving: 150, cal100: 250, p100: 12.5, c100: 25.0, f100: 11.0 },
    { name: 'Sandwich cubano',                  brand: null, serving: 250, cal100: 240, p100: 15.0, c100: 22.0, f100: 10.5 },
    { name: 'Arepas de coco',                   brand: null, serving: 60,  cal100: 380, p100: 6.0,  c100: 50.0, f100: 17.0 },
    { name: 'Avena caliente (con leche y azúcar)', brand: null, serving: 240, cal100: 95, p100: 3.5, c100: 15.0, f100: 2.3 },
    { name: 'Farina (crema de trigo)',          brand: null, serving: 240, cal100: 65,  p100: 1.8,  c100: 13.5, f100: 0.3  },
    { name: 'Batida de frutas (con leche)',     brand: null, serving: 350, cal100: 85,  p100: 2.5,  c100: 16.0, f100: 1.5  },
    { name: 'Limber de coco',                   brand: null, serving: 100, cal100: 120, p100: 1.0,  c100: 20.0, f100: 4.0  },
    { name: 'Piragua',                          brand: null, serving: 200, cal100: 78,  p100: 0.0,  c100: 20.0, f100: 0.0  },
    { name: 'Coquito',                          brand: null, serving: 120, cal100: 220, p100: 2.5,  c100: 22.0, f100: 11.0 },
    { name: 'Malta India',                      brand: null, serving: 355, cal100: 54,  p100: 0.5,  c100: 13.0, f100: 0.0  },
    // ── Quesos, embutidos y proteínas adicionales ────────────────────────
    { name: 'Queso americano (slice)',          brand: null, serving: 21,  cal100: 297, p100: 16.4, c100: 8.7,  f100: 22.0 },
    { name: 'Queso suizo',                      brand: null, serving: 28,  cal100: 380, p100: 27.0, c100: 5.0,  f100: 28.0 },
    { name: 'Queso crema / Cream cheese',       brand: null, serving: 30,  cal100: 342, p100: 6.0,  c100: 5.5,  f100: 34.0 },
    { name: 'Tocineta de pavo / Turkey bacon',  brand: null, serving: 16,  cal100: 382, p100: 29.5, c100: 4.2,  f100: 28.0 },
    { name: 'Pepperoni',                        brand: null, serving: 28,  cal100: 504, p100: 19.3, c100: 1.2,  f100: 46.0 },
    { name: 'Salami',                           brand: null, serving: 28,  cal100: 336, p100: 21.8, c100: 2.4,  f100: 26.0 },
    { name: 'Atún en aceite',                   brand: null, serving: 85,  cal100: 198, p100: 29.0, c100: 0.0,  f100: 8.2  },
    { name: 'Surimi / Cangrejo imitación',      brand: null, serving: 85,  cal100: 95,  p100: 7.6,  c100: 15.0, f100: 0.4  },
    // ── Bebidas adicionales ──────────────────────────────────────────────
    { name: 'Leche 2%',                         brand: null, serving: 240, cal100: 50,  p100: 3.3,  c100: 4.8,  f100: 2.0  },
    { name: 'Chocolate caliente',               brand: null, serving: 250, cal100: 77,  p100: 3.5,  c100: 10.5, f100: 2.3  },
];

// Normalize: remove accents so "huevo" matches "Huevo", "proteína" matches "proteina", etc.
function normalizeStr(s) {
    return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// English/alternate aliases for bilingual search support
const FOOD_ALIASES = {
    'Huevo entero':                  ['egg','eggs','whole egg','boiled egg','hard boiled egg'],
    'Huevo (clara)':                 ['egg white','egg whites','white egg'],
    'Huevo (yema)':                  ['egg yolk','egg yolks','yolk'],
    'Pechuga de pollo':              ['chicken breast','chicken','grilled chicken','pollo'],
    'Muslo de pollo':                ['chicken thigh','chicken leg','thigh'],
    'Carne molida 80/20':            ['ground beef','hamburger','burger meat','beef'],
    'Carne molida 90/10':            ['lean ground beef','lean beef','90 10 beef'],
    'Salmon':                        ['salmon','fish','atlantic salmon'],
    'Atun en agua':                  ['tuna','canned tuna','tuna fish','tuna in water'],
    'Camarones':                     ['shrimp','prawns','seafood'],
    'Jamon de pavo':                 ['turkey ham','deli turkey','turkey'],
    'Jamon de cerdo':                ['ham','pork ham','deli ham'],
    'Tocino / Bacon':                ['bacon','crispy bacon'],
    'Tilapia':                       ['tilapia','white fish'],
    'Pavo molido':                   ['ground turkey','turkey ground'],
    'Leche entera':                  ['whole milk','milk','dairy'],
    'Leche descremada':              ['skim milk','fat free milk','low fat milk','nonfat milk'],
    'Yogurt griego (0%)':            ['greek yogurt','nonfat greek yogurt','yogurt','0 percent greek'],
    'Yogurt griego (2%)':            ['greek yogurt 2','2 percent greek yogurt','yogurt'],
    'Queso cheddar':                 ['cheddar cheese','cheddar','cheese'],
    'Queso cottage':                 ['cottage cheese','cottage'],
    'Queso mozzarella':              ['mozzarella','mozzarella cheese','mozz'],
    'Mantequilla':                   ['butter','unsalted butter'],
    'Arroz blanco (cocido)':         ['white rice','rice','cooked rice'],
    'Arroz integral (cocido)':       ['brown rice','whole grain rice'],
    'Avena (cruda)':                 ['oats','oatmeal','rolled oats','raw oats'],
    'Pan blanco':                    ['white bread','bread','loaf'],
    'Pan integral':                  ['whole wheat bread','whole grain bread','brown bread'],
    'Pasta (cocida)':                ['pasta','cooked pasta','noodles','spaghetti','penne'],
    'Papa / Patata':                 ['potato','potatoes','russet potato','baked potato'],
    'Camote / Batata':               ['sweet potato','yam','sweet potatoes'],
    'Tortilla de maiz':              ['corn tortilla','tortilla','taco shell'],
    'Tortilla de harina':            ['flour tortilla','wrap','flour tortilla'],
    'Quinoa (cocida)':               ['quinoa','cooked quinoa'],
    'Aceite de oliva':               ['olive oil','oil','extra virgin olive oil','evoo'],
    'Aguacate / Palta':              ['avocado','avo'],
    'Almendras':                     ['almonds','almond'],
    'Mani / Cacahuate':              ['peanuts','peanut','groundnut'],
    'Mantequilla de mani':           ['peanut butter','pb','nut butter'],
    'Nueces':                        ['walnuts','walnut','nuts'],
    'Aceite de coco':                ['coconut oil','coconut'],
    'Brocoli':                       ['broccoli','brocoli'],
    'Espinaca':                      ['spinach'],
    'Lechuga romana':                ['romaine lettuce','lettuce','romaine','salad'],
    'Pepino':                        ['cucumber'],
    'Tomate':                        ['tomato','tomatoes'],
    'Zanahoria':                     ['carrot','carrots'],
    'Cebolla':                       ['onion','onions'],
    'Ajo':                           ['garlic','garlic clove'],
    'Maiz (grano)':                  ['corn','sweet corn','corn kernel'],
    'Frijoles negros (cocidos)':     ['black beans','beans','cooked black beans'],
    'Lentejas (cocidas)':            ['lentils','cooked lentils'],
    'Manzana':                       ['apple','apples'],
    'Banana / Platano':              ['banana','plantain','bananas'],
    'Naranja':                       ['orange','oranges'],
    'Mango':                         ['mango','mangoes'],
    'Fresas / Frutillas':            ['strawberries','strawberry'],
    'Arandanos':                     ['blueberries','blueberry','cranberry','cranberries'],
    'Pina':                          ['pineapple','pine apple'],
    'Proteina en polvo (whey)':      ['whey protein','protein powder','protein shake','whey'],
    'Proteina en polvo (planta)':    ['plant protein','vegan protein','plant based protein'],
    'Huevos revueltos':              ['scrambled eggs','scrambled'],
    // Caribbean / Puerto Rican
    'Platano maduro':                ['platano','platano maduro','ripe plantain','plantain','maduros','tajadas'],
    'Platano verde':                 ['platano verde','green plantain','verde'],
    'Tostones':                      ['tostones','toston','patacones'],
    'Yuca cocida':                   ['yuca','cassava','cooked cassava','mandioca','tapioca root'],
    'Yautia cocida':                 ['yautia','taro','dasheen','taro root','malanga amarilla'],
    'Malanga cocida':                ['malanga','taro blanco','malanga blanca','cooked malanga'],
    'Calabaza tropical':             ['calabaza','pumpkin','tropical pumpkin','west indian pumpkin','auyama','zapallo'],
    'Panapen / Pan de fruta':        ['panapen','panapén','breadfruit','pan de fruta','buen pan'],
    'Gandules cocidos':              ['gandules','pigeon peas','gandules verdes','cooked pigeon peas','gandur'],
    'Habichuelas rosadas':           ['habichuelas','habichuelas rosadas','pink beans','red beans','habichuelas guisadas','frijoles rosados'],
    'Habichuelas negras':            ['black beans','habichuelas negras','frijoles negros'],
    'Guayaba':                       ['guayaba','guava','guava fruit'],
    'Guanabana / Soursop':           ['guanabana','guanábana','soursop','graviola','anón'],
    'Mamey sapote':                  ['mamey','mamey sapote','zapote mamey'],
    'Acerola':                       ['acerola','west indian cherry','barbados cherry','cereza de puerto rico'],
    // Vegetables
    'Esparragos':                    ['esparragos','asparagus','green asparagus'],
    'Coliflor':                      ['coliflor','cauliflower'],
    'Repollo / Col':                 ['repollo','col','cabbage','green cabbage','white cabbage'],
    'Remolacha':                     ['remolacha','beet','beets','betabel','beetroot'],
    'Pimientos / Aji dulce':         ['pimientos','aji dulce','bell pepper','sweet pepper','pimento','capsicum','ají'],
    'Berenjenas':                    ['berenjenas','eggplant','aubergine','berenjena'],
    'Kale / Col rizada':             ['kale','col rizada','rúcula','collard greens','lacinato kale'],
    'Setas / Hongos':                ['setas','hongos','mushrooms','champiñones','portobello','button mushrooms'],
    'Apio (celery)':                 ['apio','celery','apio españa','celery stalk'],
    // Fruits
    'Melocoton / Durazno':           ['melocoton','durazno','peach','peaches','melocotón'],
    'Cerezas':                       ['cerezas','cherries','cherry','sweet cherries'],
    'Frambuesas':                    ['frambuesas','raspberries','raspberry','red berries'],
    'Higos frescos':                 ['higos','figs','fresh figs','fig'],
    'Kiwi':                          ['kiwi','kiwifruit','kiwi fruit'],
    // Seeds
    'Semillas de chia':              ['chia','chia seeds','semillas chia','chía','chía seeds'],
    'Semillas de hemp':              ['hemp seeds','hemp','semillas hemp','proteina hemp','hemp hearts'],
    'Edamame':                       ['edamame','soybeans','soya beans','green soybeans'],
    // Protein
    'Sardinas (enlatadas)':          ['sardinas','sardines','canned sardines','sardines in oil'],
    'Ricotta':                       ['ricotta','requesón','ricotta cheese','queso ricotta'],
    'Yogurt natural (sin grasa)':    ['yogurt natural','plain yogurt','non fat yogurt','yogurt sin grasa','yogurt sin sabor'],
    // ── Costco / Warehouse branded aliases ───────────────────────────────────
    'Kirkland Chicken Breast (lata)':   ['kirkland chicken','kirkland chicken breast','kirkland canned chicken','pollo kirkland','kirkland pollo lata'],
    'Kirkland Albacore Tuna (agua)':    ['kirkland tuna','kirkland albacore','atun kirkland','kirkland atun','kirkland albacore tuna'],
    'Wild Planet Albacore Wild Tuna':   ['wild planet tuna','wild planet albacore','wild planet'],
    'Chicken of the Sea Tuna (agua)':   ['chicken of the sea','chicken sea tuna','chunk light tuna'],
    "Morey's Salmon Silvestre Sazonado":["moreys salmon","morey's salmon",'moreys wild salmon','wild alaskan salmon seasoned'],
    'Kirkland Steak Strips (jerky)':    ['kirkland jerky','kirkland steak strips','kirkland beef jerky','beef jerky kirkland'],
    'Kirkland Chicken Tenderloins':     ['kirkland tenderloins','kirkland chicken tenderloins','pollo tenderloins kirkland'],
    'Kirkland Greek Yogurt Orgánico':   ['kirkland greek yogurt','kirkland yogurt','yogurt kirkland','kirkland organic greek yogurt'],
    'Oikos Triple Zero Greek Yogurt':   ['oikos','oikos triple zero','oikos yogurt','triple zero yogurt','oikos greek'],
    'Chobani Protein Greek Yogurt':     ['chobani','chobani protein','chobani greek yogurt','chobani yogurt'],
    'Kirkland Chewy Protein Bar':       ['kirkland granola bar','kirkland chewy bar','kirkland protein granola'],
    'Kirkland Protein Bar':             ['kirkland protein bar','barra proteina kirkland','kirkland bar'],
    'FITCRUNCH Protein Bar':            ['fitcrunch','fit crunch','fitcrunch bar','fitcrunch protein'],
    'Nature Valley Protein Bar':        ['nature valley','nature valley protein','nature valley bar','barra nature valley'],
    'Pure Protein Bar':                 ['pure protein','pure protein bar','barra pure protein'],
    'BUILT Puff Protein Bar':           ['built bar','built puff','built protein bar'],
    'Premier Protein Shake 30g':        ['premier protein','premier protein shake','premier shake','batida premier protein'],
    'Vital Proteins Collagen Peptides': ['vital proteins','collagen peptides','vital proteins collagen','colageno vital proteins','peptidos colageno'],
    'Orgain Collagen Péptidos':         ['orgain collagen','orgain peptidos','orgain colageno','collagen orgain'],
    'Orgain Proteína Vegetal Powder':   ['orgain protein','orgain plant protein','orgain powder','polvo proteina orgain','orgain superfoods'],
    'Kirkland Peanut Butter Orgánico':  ['kirkland peanut butter','kirkland pb','mantequilla mani kirkland','kirkland mantequilla mani'],
    'Kirkland Almond Butter':           ['kirkland almond butter','mantequilla almendra kirkland','kirkland mantequilla almendra'],
    'Kirkland Mixed Nuts':              ['kirkland mixed nuts','kirkland nuts','nueces mixtas kirkland','mezcla nueces kirkland'],
    'Kirkland Super Large Peanuts':     ['kirkland peanuts','mani kirkland','kirkland mani','kirkland cacahuates'],
    'Seeds of Change Quinoa & Brown Rice':['seeds of change','seeds of change quinoa','quinoa brown rice seeds','seeds change arroz'],
    'Kirkland Ancient Grain Granola':   ['kirkland granola','kirkland ancient grain','granola kirkland','kirkland organic granola'],
    'Kirkland Soft Chewy Granola Bar':  ['kirkland granola bar chewy','kirkland soft bar','granola bar kirkland'],
    'Simple Mills Almond Flour Crackers':['simple mills','simple mills crackers','almond flour crackers','galletas simple mills'],
    'Kirkland Stir-Fry Vegetable Blend':['kirkland stir fry','kirkland vegetables','kirkland vegetable blend','vegetales kirkland','mezcla vegetales kirkland'],
    'Kirkland Organic Broccoli (frozen)':['kirkland broccoli','brocoli kirkland','kirkland frozen broccoli','kirkland brocoli organico'],
    'Kirkland Three Berry Blend':       ['kirkland berries','kirkland three berry','tres bayas kirkland','berry blend kirkland','mezcla bayas kirkland'],
    'Kirkland Organic Diced Tomatoes':  ['kirkland tomatoes','kirkland diced tomatoes','tomate kirkland','kirkland tomate organico'],
    'Kirkland Organic Strawberries (frozen)':['kirkland strawberries','fresas kirkland','kirkland fresas organicas','frozen strawberries kirkland'],
    'Kirkland Organic Blueberries (frozen)':['kirkland blueberries','arandanos kirkland','kirkland arandanos','frozen blueberries kirkland'],
    'Del Monte Green Beans (lata)':     ['del monte green beans','del monte','habichuelas del monte','green beans del monte','ejotes del monte'],
    'Repollo de Bruselas (orgánico)':   ['brussels sprouts','repollo bruselas','col bruselas','brussel sprouts organic'],
    'Kirkland Organic Coconut Water':   ['kirkland coconut water','agua coco kirkland','coconut water kirkland','kirkland agua coco'],
    'Vita Coco Coconut Water':          ['vita coco','vita coco coconut water','agua coco vita coco','vitacoco'],
    'Alani Nu Energy Drink':            ['alani nu','alani energy','alani nu energy','alani drink'],
    'Kirkland Sparkling Energy Drink':  ['kirkland energy drink','kirkland sparkling energy','energy drink kirkland'],
    'PRIME Hydration Drink':            ['prime hydration','prime drink','prime energy','logan paul prime'],
    'Pechuga a la plancha':          ['grilled chicken breast','grilled chicken'],
    'Mayonesa':                      ['mayo','mayonnaise'],
    'Mayonesa light':                ['light mayo','light mayonnaise','low fat mayo'],
    'Ketchup / Catsup':              ['ketchup','catsup','tomato ketchup'],
    'Mostaza amarilla':              ['yellow mustard','mustard'],
    'Mostaza Dijon':                 ['dijon mustard','dijon'],
    'Salsa de soya':                 ['soy sauce','soya sauce','tamari'],
    'Salsa Worcestershire':          ['worcestershire sauce','worcestershire'],
    'Salsa picante / hot sauce':     ['hot sauce','sriracha','tabasco','chili sauce'],
    'Salsa BBQ':                     ['bbq sauce','barbecue sauce','barbeque sauce'],
    'Salsa de tomate (marinara)':    ['marinara sauce','tomato sauce','pasta sauce','marinara'],
    'Aderezo ranch':                 ['ranch dressing','ranch'],
    'Aderezo cesar':                 ['caesar dressing','caesar salad dressing','caesar'],
    'Aderezo italiano':              ['italian dressing'],
    'Aderezo balsamico':             ['balsamic dressing','balsamic vinegar','balsamic'],
    'Vinagre de manzana':            ['apple cider vinegar','acv','vinegar'],
    'Crema agria':                   ['sour cream'],
    'Guacamole':                     ['guacamole','guac'],
    'Hummus':                        ['hummus','chickpea dip'],
    'Mermelada / Jelly':             ['jam','jelly','marmalade','fruit spread'],
    'Miel':                          ['honey','raw honey'],
    'Syrup / Jarabe de maple':       ['maple syrup','syrup','pancake syrup'],
    'Crema de cacahuate (PB)':       ['peanut butter','pb','nut butter'],
    'Nutella / Hazelnut spread':     ['nutella','hazelnut spread','chocolate spread','hazelnut'],
    // Beverages
    'Café negro':                    ['cafe negro','black coffee','coffee','cafe','café','plain coffee','brewed coffee','drip coffee'],
    'Café americano':                ['americano','cafe americano','coffee americano','long black'],
    'Café espresso':                 ['espresso','cafe espresso','shot of espresso','espresso shot'],
    'Café con leche':                ['cafe con leche','coffee with milk','white coffee','cafe au lait','coffee milk'],
    'Café latte':                    ['latte','cafe latte','coffee latte','cafe latte','flat white'],
    'Café capuchino':                ['cappuccino','capuchino','cappucino','cafe capuchino'],
    'Té negro (sin azúcar)':         ['black tea','te negro','te','tea','plain tea'],
    'Té verde (sin azúcar)':         ['green tea','te verde','matcha tea','matcha'],
    'Agua':                          ['water','agua','h2o','plain water'],
    'Jugo de naranja':               ['orange juice','oj','jugo naranja','jugo de naranja','fresh juice'],
    'Jugo de manzana':               ['apple juice','jugo manzana','jugo de manzana'],
    'Refresco / Soda':               ['soda','refresco','cola','coke','pepsi','sprite','gaseosa','fizzy drink'],
    'Refresco light / Diet':         ['diet soda','diet coke','diet pepsi','zero sugar','refresco light','light soda','zero coke'],
    'Bebida energética':             ['energy drink','bebida energetica','monster','red bull','bang'],
    'Leche de almendra':             ['almond milk','unsweetened almond milk','leche almendra'],
    'Leche de avena':                ['oat milk','oat drink','leche de avena','leche avena'],
    'Proteína shake (preparado)':    ['protein shake','shake','ready to drink protein','rtd protein'],
    // Fast food / restaurante
    'Hamburguesa sencilla (con pan)':   ['hamburguesa','burger','hamburger','plain burger'],
    'Cheeseburger / Hamburguesa con queso': ['cheeseburger','hamburguesa con queso','burger con queso'],
    'Hamburguesa doble con queso':      ['doble con queso','double cheeseburger','big mac','whopper','doble carne'],
    'Papas fritas':                     ['french fries','fries','papitas fritas','papas','patatas fritas'],
    'Nuggets de pollo':                 ['nuggets','chicken nuggets','nugets','mcnuggets'],
    'Pizza de queso (slice)':           ['pizza','cheese pizza','pizza queso','slice de pizza','pedazo de pizza'],
    'Pizza de pepperoni (slice)':       ['pepperoni pizza','pizza pepperoni'],
    'Hot dog completo (con pan)':       ['hot dog','hotdog','perro caliente','perrito'],
    'Taco de carne (crujiente)':        ['taco','tacos','crunchy taco','taco de carne'],
    'Burrito de pollo':                 ['burrito','chicken burrito','burrito de pollo'],
    'Quesadilla de pollo':              ['quesadilla','chicken quesadilla'],
    'Alitas Buffalo':                   ['alitas','wings','buffalo wings','chicken wings','alitas de pollo'],
    'Chicken tenders / Dedos de pollo': ['tenders','chicken tenders','chicken fingers','dedos de pollo','tiras de pollo'],
    'Sandwich de pollo (fast food)':    ['chicken sandwich','sandwich de pollo','mcchicken'],
    'Wrap de pollo':                    ['wrap','chicken wrap','wrap de pollo'],
    'Sub de pavo (6 pulgadas)':         ['subway','sub de pavo','turkey sub','sub','sandwich de pavo'],
    'Ensalada César con pollo':         ['caesar salad','ensalada cesar','ensalada con pollo','chicken caesar'],
    'Aros de cebolla':                  ['onion rings','aros cebolla'],
    // Comfort americano
    'Mac and cheese':                   ['mac and cheese','macarrones con queso','mac n cheese','macaroni and cheese'],
    'Lasaña de carne':                  ['lasagna','lasana','lasagna de carne'],
    'Espagueti con carne':              ['spaghetti','espaguetis','pasta con carne','spaghetti with meat'],
    'Puré de papa':                     ['mashed potatoes','pure de papa','majado de papa','mash'],
    'Sopa de pollo con fideos':         ['chicken noodle soup','sopa de pollo','sopa de fideos'],
    'Sopa de vegetales':                ['vegetable soup','sopa de verduras'],
    'Chili con carne':                  ['chili','chilli con carne'],
    'Meatloaf / Pastel de carne':       ['meatloaf','pastel de carne'],
    'Pollo rostizado (rotisserie)':     ['rotisserie chicken','pollo asado','pollo rostizado','pollo al horno'],
    'Grilled cheese / Sandwich de queso': ['grilled cheese','sandwich de queso','queso derretido'],
    'Sandwich BLT':                     ['blt','sandwich de tocineta','bacon sandwich'],
    'Sandwich PB&J':                    ['pbj','pb&j','peanut butter and jelly','sandwich de mantequilla de mani'],
    'Ensalada de atún (con mayonesa)':  ['tuna salad','ensalada de atun'],
    // Desayuno americano
    'Pancakes / Panqueques':            ['pancakes','panqueques','hotcakes','panquecas'],
    'Waffles':                          ['waffle','wafles','gofres'],
    'Tostada francesa / French toast':  ['french toast','tostada francesa','pan frances dulce'],
    'Bagel':                            ['bagel','bagels','rosca de pan'],
    'Croissant':                        ['croissant','cruasan','media luna','cangrejito'],
    'Donut glaseado':                   ['donut','dona','donas','doughnut','donut glaseado'],
    'Muffin de arándanos':              ['muffin','blueberry muffin','panquecito','mantecado de arandanos'],
    'Avena cocida (con agua)':          ['oatmeal cooked','avena cocida','avena hecha','avena preparada'],
    'Cereal Cheerios':                  ['cheerios','cereal cheerios'],
    'Granola':                          ['granola','musli','muesli'],
    'Huevo frito':                      ['fried egg','huevo frito','huevo estrellado'],
    'Hash browns / Papas doradas':      ['hash browns','hashbrown','papas doradas'],
    'Salchicha de desayuno':            ['breakfast sausage','salchicha desayuno','sausage links'],
    // Snacks y dulces
    'Papitas / Potato chips':           ['chips','potato chips','papitas','lays','papas de bolsa'],
    'Tortilla chips / Nachos (solos)':  ['tortilla chips','doritos','nachos solos','totopos'],
    'Nachos con queso':                 ['nachos','nachos con queso','nacho cheese'],
    'Pretzels':                         ['pretzel','pretzels'],
    'Palomitas de maíz (con mantequilla)': ['popcorn','palomitas','pop corn','rositas de maiz'],
    'Galletas saladas (soda crackers)': ['soda crackers','export soda','galletas de soda','saltines','crackers'],
    'Galletas María':                   ['galletas maria','maria cookies'],
    'Galleta de chocolate chip':        ['chocolate chip cookie','galleta de chocolate','cookie'],
    'Brownie':                          ['brownie','brownies'],
    'Cheesecake':                       ['cheesecake','pastel de queso','tarta de queso','flan de queso'],
    'Pastel de manzana / Apple pie':    ['apple pie','pie de manzana','tarta de manzana'],
    'Helado de chocolate':              ['chocolate ice cream','helado chocolate','mantecado de chocolate'],
    'Chocolate con leche (barra)':      ['chocolate bar','barra de chocolate','hershey','milk chocolate'],
    // Puerto Rico adicionales
    'Arroz blanco con habichuelas':     ['arroz con habichuelas','arroz y habichuelas','rice and beans','arroz habichuelas'],
    'Serenata de bacalao':              ['serenata','serenata de bacalao'],
    'Bacalao guisado':                  ['bacalao guisado','codfish stew'],
    'Ensalada de coditos':              ['coditos','ensalada de coditos','macaroni salad'],
    'Ensalada de papa':                 ['potato salad','ensalada de papa'],
    'Guineítos en escabeche':           ['guineitos','guineos en escabeche','green banana escabeche'],
    'Pinchos de pollo':                 ['pincho de pollo','pinchos','chicken skewer','chicken kabob'],
    'Pinchos de cerdo':                 ['pincho de cerdo','pork skewer','pork kabob'],
    'Chicharrón de pollo':              ['chicharron de pollo','chicharrones de pollo','fried chicken chunks'],
    'Chicharrón de cerdo':              ['chicharron','chicharrones','pork rinds','pork cracklings'],
    'Carne frita de cerdo':             ['carne frita','masitas de cerdo','fried pork chunks'],
    'Bistec empanizado':                ['bistec empanado','breaded steak','milanesa'],
    'Churrasco (con chimichurri)':      ['churrasco','skirt steak','entrana'],
    'Camarones al ajillo':              ['camarones al ajillo','garlic shrimp','camarones en ajo'],
    'Arroz con calamares':              ['arroz con calamares','arroz negro','squid rice'],
    'Arroz chino boricua (frito)':      ['arroz chino','arroz frito','fried rice','arroz frito con cerdo'],
    'Salchichas guisadas (de lata)':    ['salchichas guisadas','salchichas de lata','vienna sausage','salchichas vienna'],
    'Corned beef guisado':              ['corned beef','corn beef','carne bif'],
    'Jamonilla / Spam (frita)':         ['spam','jamonilla','spam frito'],
    'Morcilla':                         ['morcilla','blood sausage'],
    'Longaniza':                        ['longaniza','longanisa'],
    'Salchichón':                       ['salchichon','salami boricua'],
    'Revoltillo con jamón':             ['revoltillo','revoltillo de huevo','scrambled eggs with ham'],
    'Pan de agua':                      ['pan de agua','water bread','pan criollo'],
    'Tostada con mantequilla (pan sobao)': ['tostada con mantequilla','tostada','toast with butter'],
    'Sandwich de jamón y queso':        ['sandwich de jamon y queso','ham and cheese','sandwich de mezcla'],
    'Sandwich cubano':                  ['cubano','cuban sandwich','sandwich cubano'],
    'Arepas de coco':                   ['arepas','arepa de coco','coconut arepa'],
    'Avena caliente (con leche y azúcar)': ['avena con leche','avena caliente','oatmeal with milk'],
    'Farina (crema de trigo)':          ['farina','crema de trigo','cream of wheat'],
    'Batida de frutas (con leche)':     ['batida','batido de frutas','smoothie','fruit shake','frappé de frutas'],
    'Limber de coco':                   ['limber','limber de coco'],
    'Piragua':                          ['piragua','snow cone','raspao'],
    'Coquito':                          ['coquito','coquito navideno'],
    'Malta India':                      ['malta','malta india','malt beverage'],
    // Quesos, embutidos y proteínas
    'Queso americano (slice)':          ['american cheese','queso americano','queso amarillo','cheese slice'],
    'Queso suizo':                      ['swiss cheese','queso suizo'],
    'Queso crema / Cream cheese':       ['cream cheese','queso crema','philadelphia'],
    'Tocineta de pavo / Turkey bacon':  ['turkey bacon','tocineta de pavo','bacon de pavo'],
    'Pepperoni':                        ['pepperoni','peperoni'],
    'Salami':                           ['salami'],
    'Atún en aceite':                   ['tuna in oil','atun en aceite'],
    'Surimi / Cangrejo imitación':      ['surimi','imitation crab','carne de cangrejo','kanikama'],
    // Bebidas adicionales
    'Leche 2%':                         ['2 percent milk','leche 2','reduced fat milk','leche semidescremada'],
    'Chocolate caliente':               ['hot chocolate','chocolate caliente','cocoa','hot cocoa'],
};

function searchLocalFoods(q) {
    const normQ = normalizeStr(q);
    const terms = normQ.split(/\s+/).filter(Boolean);
    const scored = LOCAL_FOODS
        .map(f => {
            const aliasKey = Object.keys(FOOD_ALIASES).find(k => normalizeStr(k) === normalizeStr(f.name));
            const aliases  = aliasKey ? FOOD_ALIASES[aliasKey] : [];
            const normAliases = aliases.map(a => normalizeStr(a));
            const hay = normalizeStr(f.name + ' ' + (f.brand || '') + ' ' + aliases.join(' '));
            const matches = terms.every(t => hay.includes(t));
            if (!matches) return null;

            const normName = normalizeStr(f.name);
            let score = 1;
            // Exact alias match is just as good as an exact name match
            if (normName === normQ || normAliases.includes(normQ)) score = 10;
            else if (normName.startsWith(normQ)) score = 7;
            else if (normAliases.some(a => a.startsWith(normQ))) score = 6;
            else if (normName.includes(normQ)) score = 4;
            else if (normAliases.some(a => a.includes(normQ))) score = 2;
            return { food: f, score };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);
    return scored.map(s => s.food).slice(0, 10);
}

// Rerank a list of external food items so that results whose *name* closely
// matches the user's query float to the top.  This prevents recipes and
// packaged products that merely *contain* the keyword from burying the
// plain food item the user actually searched for.
function rankByNameRelevance(items, q) {
    const normQ = normalizeStr(q);
    const firstWord = normQ.split(/\s+/)[0];
    return items.map(f => {
        const normName = normalizeStr(f.name);
        let score = 0;
        if (normName === normQ)                              score = 10; // exact
        else if (normName.startsWith(normQ))                score = 8;  // name starts with full query
        else if (normName.split(/\s+/)[0] === firstWord)    score = 6;  // first word matches
        else if (normName.startsWith(firstWord))            score = 4;  // name starts with first keyword
        else if (normName.includes(normQ))                  score = 2;  // query somewhere in name
        else                                                score = 1;  // keyword buried deep
        return { ...f, _score: score };
    }).sort((a, b) => b._score - a._score).map(({ _score, ...f }) => f);
}

// Resolve a single ingredient name to verified per-100g macros, used by the
// meal recommender to ground the LLM's suggestions in real database numbers.
// Tries the curated local DB and shared library first (instant), then USDA.
// Returns { name, per100:{cal,protein,carbs,fat} } or null if no confident match.
// Preparation / packaging / connector words that don't change a food's identity.
// Stripped to build a simplified query so "Yogur griego natural" still finds
// "Yogurt griego" and "Atún enlatado en agua" still finds "Atún".
const INGREDIENT_STOPWORDS = new Set([
    'natural','cocido','cocida','cocidos','cocidas','crudo','cruda','asado','asada',
    'frito','frita','hervido','hervida','enlatado','enlatada','enlatados','enlatadas',
    'fresco','fresca','congelado','congelada','maduro','madura','light','descremado',
    'descremada','desnatado','desnatada','entero','entera','magro','magra','plancha','vapor','horneado','horneada',
    'piel','hueso','en','al','a','la','el','los','las','de','del','con','y','o','sin',
]);
const simplifyIngredient = (q) => normalizeStr(q).split(/\s+/).filter(w => w && !INGREDIENT_STOPWORDS.has(w)).join(' ');

async function resolveIngredientMacros(query) {
    const q = (query || '').trim();
    if (!q || q.length < 2) return null;
    const simplified = simplifyIngredient(q);
    const firstTerm  = (simplified || normalizeStr(q)).split(/\s+/)[0] || '';

    // 1 ── Curated local DB (instant, Spanish-friendly, USDA-quality). Try the full
    //      phrase first, then the simplified (qualifier-stripped) phrase.
    for (const term of [q, simplified]) {
        if (!term) continue;
        const local = searchLocalFoods(term);
        if (local.length) {
            const f = local[0];
            return { name: f.name, per100: { cal: f.cal100, protein: f.p100, carbs: f.c100, fat: f.f100 } };
        }
    }

    // 2 ── Shared community food library (Mongo, per-100g). Keep ALL-term matching
    //      (noisy/branded data — looser matching invites false positives).
    try {
        const terms   = normalizeStr(q).split(/\s+/).filter(Boolean);
        const pattern = terms.map(t => `(?=.*${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`).join('');
        const doc = await FoodLibrary.findOne({ nameNorm: new RegExp(pattern, 'i') }).sort({ timesUsed: -1 });
        if (doc) {
            return { name: doc.name, per100: { cal: doc.calories || 0, protein: doc.protein || 0, carbs: doc.carbs || 0, fat: doc.fat || 0 } };
        }
    } catch (_) { /* non-blocking */ }

    // 3 ── USDA FoodData Central — Foundation + SR Legacy only (generic whole foods).
    //      FNDDS/Survey is excluded: it carries restaurant/branded items that caused
    //      false matches like "papa" → "Papa John's Pizza".
    try {
        const usdaKey = process.env.USDA_API_KEY || 'DEMO_KEY';
        const url = `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${usdaKey}&query=${encodeURIComponent(q)}&pageSize=5&dataType=Foundation,SR%20Legacy&nutrients=1008,1003,1005,1004`;
        const r = await fetch(url, { signal: AbortSignal.timeout(7000) });
        const data = await r.json();
        const ranked = rankByNameRelevance(
            (data.foods || [])
                .filter(f => f.description?.trim())
                .map(f => {
                    const get = id => f.foodNutrients?.find(n => n.nutrientId === id)?.value || 0;
                    return { name: f.description.trim(), cal100: Math.round(get(1008)), p100: get(1003), c100: get(1005), f100: get(1004) };
                })
                .filter(f => f.cal100 > 0),
            q
        );
        // Relevance guard: only accept if the matched name actually contains the core
        // term — prevents a weak fuzzy hit from passing as verified.
        const top = ranked[0];
        if (top && firstTerm && normalizeStr(top.name).includes(firstTerm)) {
            return { name: top.name, per100: { cal: top.cal100, protein: top.p100, carbs: top.c100, fat: top.f100 } };
        }
    } catch (_) { /* non-blocking */ }

    return null;
}

// POST /api/food-library — upsert a food into the shared platform library
app.post('/api/food-library', authenticateToken, async (req, res) => {
    try {
        const { name, calories, protein, carbs, fat } = req.body;
        if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
        const nameNorm = normalizeStr(name.trim());
        await FoodLibrary.findOneAndUpdate(
            { nameNorm },
            {
                $set: { name: name.trim(), calories: +calories || 0, protein: +protein || 0,
                        carbs: +carbs || 0, fat: +fat || 0, updatedAt: new Date() },
                $inc: { timesUsed: 1 }
            },
            { upsert: true, new: true }
        );
        res.json({ ok: true });
    } catch (e) {
        console.error('Food library save error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/food-library?q= — search shared food library; returns [{name,calories,protein,carbs,fat}]
app.get('/api/food-library', authenticateToken, async (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        let results;
        if (!q) {
            results = await FoodLibrary.find().sort({ timesUsed: -1 }).limit(12);
        } else {
            const normQ = normalizeStr(q);
            // Build a regex that requires each search term to appear somewhere in nameNorm
            const terms = normQ.split(/\s+/).filter(Boolean);
            const pattern = terms.map(t => `(?=.*${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`).join('');
            const regex = new RegExp(pattern, 'i');
            results = await FoodLibrary.find({ nameNorm: regex }).sort({ timesUsed: -1 }).limit(10);
        }
        res.json(results.map(f => ({
            name: f.name, calories: f.calories, protein: f.protein, carbs: f.carbs, fat: f.fat
        })));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/food-search', authenticateToken, async (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json([]);

    // 1 ── Curated local DB (instant, no network)
    const localMatches = searchLocalFoods(q);
    const seenNames    = new Set(localMatches.map(f => normalizeStr(f.name)));

    // 2 ── Shared community library (foods logged by platform users)
    let libraryMatches = [];
    try {
        const normQ   = normalizeStr(q);
        const terms   = normQ.split(/\s+/).filter(Boolean);
        const pattern = terms.map(t => `(?=.*${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`).join('');
        const libDocs = await FoodLibrary.find({ nameNorm: new RegExp(pattern, 'i') })
            .sort({ timesUsed: -1 }).limit(8);
        libraryMatches = libDocs
            .filter(f => !seenNames.has(normalizeStr(f.name)))
            .map(f => ({
                name: f.name, brand: null, serving: 100,
                cal100: f.calories || 0, p100: f.protein || 0,
                c100: f.carbs || 0, f100: f.fat || 0,
                fromLibrary: true
            }));
        libraryMatches.forEach(f => seenNames.add(normalizeStr(f.name)));
    } catch (_) { /* non-blocking */ }

    // If local + library gives very strong coverage, skip external APIs
    if (localMatches.length + libraryMatches.length >= 10) {
        return res.json([...localMatches, ...libraryMatches].slice(0, 16));
    }

    // ─── Dedup helper (shared across all tiers) ───────────────────────────────
    const addUnique = (arr, src, limit) => {
        let added = 0;
        for (const f of src) {
            if (added >= limit) break;
            const key = normalizeStr(f.name);
            if (!seenNames.has(key)) { seenNames.add(key); arr.push(f); added++; }
        }
    };

    // ─── Open Food Facts search (Search-a-licious API) ────────────────────────
    // The legacy /cgi/search.pl endpoint now intermittently returns 503, so the
    // server queries the modern search API instead. Note: `brands` is an array
    // here (comma string on the legacy endpoint), and some hits only carry
    // energy in kJ — converted at 4.184 kJ/kcal.
    const searchOffProducts = async (pageSize) => {
        const url = `https://search.openfoodfacts.org/search?q=${encodeURIComponent(q)}&page_size=${pageSize}&fields=product_name,nutriments,brands,serving_quantity`;
        const r = await fetch(url, { signal: AbortSignal.timeout(7000) });
        const data = await r.json();
        return (data.hits || [])
            .filter(p => p.product_name?.trim())
            .map(p => {
                const nu = p.nutriments || {};
                return {
                    name:    p.product_name.trim(),
                    brand:   (Array.isArray(p.brands) ? p.brands[0] : p.brands?.split(',')[0])?.trim() || null,
                    serving: parseFloat(p.serving_quantity) || 100,
                    cal100:  Math.round(nu['energy-kcal_100g'] || nu['energy-kcal'] || (nu['energy-kj_100g'] ? nu['energy-kj_100g'] / 4.184 : 0)),
                    p100:    parseFloat((nu.proteins_100g      || 0).toFixed(1)),
                    c100:    parseFloat((nu.carbohydrates_100g || 0).toFixed(1)),
                    f100:    parseFloat((nu.fat_100g           || 0).toFixed(1)),
                };
            })
            .filter(f => f.cal100 > 0);
    };

    // 3 ── Nutritionix  — industry-standard fitness nutrition database, same source
    //      used by Lose It!, Under Armour, and dozens of other fitness apps.
    //      Common foods use USDA-quality data; branded foods use manufacturer data.
    //      Get your free API keys at https://developer.nutritionix.com/ (500 req/day free).
    //      Set env vars: NUTRITIONIX_APP_ID  and  NUTRITIONIX_APP_KEY
    const nixId  = process.env.NUTRITIONIX_APP_ID;
    const nixKey = process.env.NUTRITIONIX_APP_KEY;

    if (nixId && nixKey) {
        try {
            // Step A: instant search — returns branded items with full nutrition +
            //         common food names (no nutrition data in this response).
            const instantRes = await fetch(
                `https://trackapi.nutritionix.com/v2/search/instant?query=${encodeURIComponent(q)}&branded=true&common=true`,
                { headers: { 'x-app-id': nixId, 'x-app-key': nixKey }, signal: AbortSignal.timeout(6000) }
            );
            const instant = await instantRes.json();

            // Branded items — convert per-serving → per-100g
            const nixBranded = (instant.branded || [])
                .filter(f => f.nf_calories > 0 && f.serving_weight_grams > 0)
                .slice(0, 6)
                .map(f => {
                    const sw = f.serving_weight_grams;
                    return {
                        name:    f.food_name,
                        brand:   f.brand_name || null,
                        serving: 100,
                        cal100:  Math.round((f.nf_calories           / sw) * 100),
                        p100:    parseFloat(((f.nf_protein            / sw) * 100).toFixed(1)),
                        c100:    parseFloat(((f.nf_total_carbohydrate / sw) * 100).toFixed(1)),
                        f100:    parseFloat(((f.nf_total_fat          / sw) * 100).toFixed(1)),
                    };
                })
                .filter(f => f.cal100 > 0);

            // Step B: natural/nutrients for top common foods.
            //         Each "100g <name>" entry returns exact per-100g nutrition.
            //         We batch up to 5 names in one request to save quota.
            const commonNames = (instant.common || []).slice(0, 5).map(f => f.food_name);
            let nixCommon = [];
            if (commonNames.length > 0) {
                const batchQuery = commonNames.map(n => `100g ${n}`).join(', ');
                const nutriRes = await fetch(
                    'https://trackapi.nutritionix.com/v2/natural/nutrients',
                    {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/json', 'x-app-id': nixId, 'x-app-key': nixKey },
                        body:    JSON.stringify({ query: batchQuery }),
                        signal:  AbortSignal.timeout(7000),
                    }
                );
                const nutriData = await nutriRes.json();
                nixCommon = (nutriData.foods || [])
                    .map(f => ({
                        name:    f.food_name,
                        brand:   null,
                        serving: 100,
                        cal100:  Math.round(f.nf_calories           || 0),
                        p100:    parseFloat((f.nf_protein            || 0).toFixed(1)),
                        c100:    parseFloat((f.nf_total_carbohydrate || 0).toFixed(1)),
                        f100:    parseFloat((f.nf_total_fat          || 0).toFixed(1)),
                    }))
                    .filter(f => f.cal100 > 0);
            }

            // Common foods first (more accurate / generic), then branded.
            // Rerank both by name-relevance so "Egg" beats "Egg Salad Sandwich".
            const nixResults = rankByNameRelevance([...nixCommon, ...nixBranded], q);
            const combined   = [...localMatches, ...libraryMatches];
            addUnique(combined, nixResults, 10);

            // If Nutritionix gave us good coverage, return early
            if (combined.length >= 6) return res.json(combined.slice(0, 18));

            // Otherwise fall through to supplement with OFF
            const offItems = rankByNameRelevance(await searchOffProducts(12), q);
            addUnique(combined, offItems, 6);

            return res.json(combined.slice(0, 18));

        } catch (e) {
            console.error('Nutritionix error:', e.message);
            // Fall through to the Open Food Facts + USDA tier below
        }
    }

    // 4 ── Open Food Facts + USDA FoodData Central — fired in parallel.
    //      These run if Nutritionix keys are not configured or if it errored.
    //      USDA Foundation/SR Legacy = government-verified generic food data.
    //      OFF = 3 M+ branded/packaged products worldwide (no API key needed).
    const usdaKey = process.env.USDA_API_KEY || 'DEMO_KEY';

    const [offResult, usdaResult] = await Promise.allSettled([
        // ── Open Food Facts (always free, no key) ─────────────────────────────
        searchOffProducts(18),

        // ── USDA FoodData Central (Foundation + SR Legacy = gold standard) ────
        (async () => {
            const url = `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${usdaKey}&query=${encodeURIComponent(q)}&pageSize=12&dataType=Foundation,SR%20Legacy,Survey%20(FNDDS),Branded&nutrients=1008,1003,1005,1004`;
            const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
            const data = await r.json();
            return (data.foods || [])
                .filter(f => f.description?.trim())
                .map(f => {
                    const get = id => f.foodNutrients?.find(n => n.nutrientId === id)?.value || 0;
                    return {
                        name:    f.description.trim(),
                        brand:   f.brandOwner || f.brandName || null,
                        serving: 100,
                        cal100:  Math.round(get(1008)),
                        p100:    parseFloat(get(1003).toFixed(1)),
                        c100:    parseFloat(get(1005).toFixed(1)),
                        f100:    parseFloat(get(1004).toFixed(1)),
                    };
                })
                .filter(f => f.cal100 > 0);
        })(),
    ]);

    const offItems2  = rankByNameRelevance(offResult.status  === 'fulfilled' ? offResult.value  : [], q);
    const usdaItems  = rankByNameRelevance(usdaResult.status === 'fulfilled' ? usdaResult.value : [], q);

    const combined2 = [...localMatches, ...libraryMatches];
    addUnique(combined2, usdaItems,  8);
    addUnique(combined2, offItems2, 10);

    if (combined2.length) return res.json(combined2.slice(0, 18));

    if (offResult.status  === 'rejected') console.error('OFF error:',  offResult.reason?.message);
    if (usdaResult.status === 'rejected') console.error('USDA error:', usdaResult.reason?.message);

    // Final fallback — local + library only
    const fallback = [...localMatches, ...libraryMatches];
    if (fallback.length) return res.json(fallback);
    res.status(502).json({ error: 'Food search unavailable. Use manual entry.' });
});

// ==========================================================================
// --- PROTECTED: AI Meal Recommender ---
// LLM proposes meal ideas (ingredient + grams); the server recomputes the
// real macros from the food database so displayed numbers are trustworthy.
// ==========================================================================
const MEAL_SUGGESTION_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        suggestions: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    title:     { type: 'string', description: 'Nombre corto de la comida o snack, en español' },
                    rationale: { type: 'string', description: 'Una frase breve explicando por qué ayuda a cerrar los macros' },
                    items: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                food:  { type: 'string', description: 'Nombre genérico y simple del ingrediente (ej: "Pechuga de pollo", "Arroz blanco", "Aceite de oliva"), no un platillo compuesto' },
                                grams: { type: 'number', description: 'Cantidad en gramos' },
                            },
                            required: ['food', 'grams'],
                        },
                    },
                },
                required: ['title', 'rationale', 'items'],
            },
        },
    },
    required: ['suggestions'],
};

app.post('/api/meal-suggestion', authenticateToken, async (req, res) => {
    if (!MEAL_SUGGESTION_ENABLED) {
        return res.status(503).json({ message: 'El recomendador de comidas estará disponible pronto.' });
    }
    if (!anthropic) {
        return res.status(503).json({ message: 'El recomendador de comidas no está configurado. Agrega ANTHROPIC_API_KEY en .env.' });
    }
    try {
        // Resolve whose preferences to use: a trainer may request for a client; a
        // client only for themselves. Preferences are always read from the DB,
        // never trusted from the request body.
        let targetId = req.user.id;
        if (req.body.clientId && (req.user.role === 'trainer' || req.user.role === 'admin')) {
            targetId = req.body.clientId;
        } else if (req.body.clientId && String(req.body.clientId) !== String(req.user.id)) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        const user = await User.findById(targetId).select('dietaryPreferences macroSettings');
        if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });

        // ── Usage caps (cost protection) ───────────────────────────────────
        // Per-client daily limit + hard global monthly cap. Checked before the
        // paid API call; incremented only on success.
        const usageNow = new Date();
        const usageMonth = usageNow.toISOString().slice(0, 7);   // YYYY-MM
        const usageDay   = usageNow.toISOString().slice(0, 10);  // YYYY-MM-DD
        const [globalUse, clientUse] = await Promise.all([
            AiUsage.findOne({ scope: 'global', clientId: null,     period: usageMonth }),
            AiUsage.findOne({ scope: 'client', clientId: targetId, period: usageDay   }),
        ]);
        if ((globalUse?.count || 0) >= MEAL_MONTHLY_LIMIT) {
            return res.status(429).json({ message: 'El recomendador alcanzó su límite de uso este mes. Estará disponible de nuevo el próximo mes.' });
        }
        if ((clientUse?.count || 0) >= MEAL_DAILY_LIMIT) {
            return res.status(429).json({ message: `Alcanzaste el máximo de ${MEAL_DAILY_LIMIT} sugerencias por hoy. Vuelve mañana 💪` });
        }

        // Remaining macros for the day come from the client (it knows unsaved
        // foods on screen). Clamp to non-negative integers.
        const r = req.body.remaining || {};
        const remaining = {
            calories: Math.max(0, Math.round(Number(r.calories) || 0)),
            protein:  Math.max(0, Math.round(Number(r.protein)  || 0)),
            carbs:    Math.max(0, Math.round(Number(r.carbs)    || 0)),
            fat:      Math.max(0, Math.round(Number(r.fat)      || 0)),
        };
        if (remaining.calories <= 0 && remaining.protein <= 0 && remaining.carbs <= 0 && remaining.fat <= 0) {
            return res.status(400).json({ message: 'Ya alcanzaste tus macros — no hay nada que recomendar.' });
        }

        // Foods already eaten today (names only) so suggestions add variety.
        const eaten = Array.isArray(req.body.eaten)
            ? req.body.eaten.filter(x => typeof x === 'string').slice(0, 40)
            : [];

        const prefs = user.dietaryPreferences || {};
        const allergies = (prefs.allergies || []).join(', ') || 'ninguna';
        const dislikes  = (prefs.dislikes  || []).join(', ') || 'ninguno';
        const dietType  = prefs.dietType || 'sin preferencia (omnívoro)';
        const notes     = (prefs.notes || '').trim() || 'ninguna';

        const systemPrompt =
`Eres un asistente de nutrición para una app de coaching fitness. El cliente ya comió saludable hoy pero le faltan macros para llegar a su meta. Sugiere comidas o snacks COMPLETOS y realistas que ayuden a cerrar la diferencia.

REGLAS ESTRICTAS:
- NUNCA incluyas estos alérgenos ni nada derivado de ellos: ${allergies}.
- Respeta el tipo de dieta: ${dietType}.
- Evita estos alimentos que no le gustan (a menos que sea imprescindible): ${dislikes}.
- Considera estas notas del cliente: ${notes}.
- Da exactamente 3 sugerencias distintas.
- Cada sugerencia debe priorizar cerrar el macro que más falta (normalmente proteína).
- Usa el nombre MÁS SIMPLE y genérico del ingrediente, sin palabras de preparación, empaque ni adjetivos. Ejemplos:
    · "Yogur griego" (NO "Yogur griego natural")
    · "Atún" (NO "Atún enlatado en agua")
    · "Papa" (NO "Papa cocida")
    · "Pechuga de pollo" (NO "Pechuga de pollo a la plancha")
  Nada de platillos compuestos ni marcas comerciales — solo el alimento base como aparecería en una base de datos nutricional.
- Especifica gramos realistas por ingrediente.
- No calcules tú las calorías ni macros; solo propón ingredientes y gramos. El sistema calculará los macros reales.
- Responde en español.`;

        const userPrompt =
`Macros que faltan para hoy:
- Calorías: ${remaining.calories} kcal
- Proteína: ${remaining.protein} g
- Carbohidratos: ${remaining.carbs} g
- Grasas: ${remaining.fat} g

Ya comió hoy: ${eaten.length ? eaten.join(', ') : '(sin registro detallado)'}

Sugiere 3 comidas/snacks para acercarlo a su meta.`;

        // Fail fast if Anthropic is slow — don't leave the client spinning.
        const aiResp = await anthropic.messages.create({
            model: 'claude-haiku-4-5',
            max_tokens: 2000,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
            output_config: { format: { type: 'json_schema', schema: MEAL_SUGGESTION_SCHEMA } },
        }, { timeout: 25000, maxRetries: 1 });

        const textBlock = aiResp.content.find(b => b.type === 'text');
        let parsed;
        try { parsed = JSON.parse(textBlock?.text || '{}'); }
        catch { return res.status(502).json({ message: 'No se pudo interpretar la sugerencia. Intenta de nuevo.' }); }

        const rawSuggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 3) : [];

        // Verify every ingredient against the food DB, in parallel, and recompute
        // the real macros. The LLM's numbers are never used.
        const verified = await Promise.all(rawSuggestions.map(async (s) => {
            const items = Array.isArray(s.items) ? s.items.slice(0, 8) : [];
            const resolved = await Promise.all(items.map(async (it) => {
                const grams = Math.max(0, Number(it.grams) || 0);
                const macro = await resolveIngredientMacros(it.food);
                if (!macro || grams <= 0) {
                    return { food: it.food, grams, verified: false, calories: 0, protein: 0, carbs: 0, fat: 0 };
                }
                const factor = grams / 100;
                return {
                    food: it.food,
                    matchedName: macro.name,
                    grams,
                    verified: true,
                    calories: Math.round(macro.per100.cal     * factor),
                    protein:  Math.round(macro.per100.protein * factor),
                    carbs:    Math.round(macro.per100.carbs   * factor),
                    fat:      Math.round(macro.per100.fat     * factor),
                };
            }));
            const totals = resolved.reduce((acc, it) => ({
                calories: acc.calories + it.calories,
                protein:  acc.protein  + it.protein,
                carbs:    acc.carbs    + it.carbs,
                fat:      acc.fat      + it.fat,
            }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
            return {
                title: String(s.title || 'Sugerencia'),
                rationale: String(s.rationale || ''),
                items: resolved,
                totals,
                hasUnverified: resolved.some(it => !it.verified),
            };
        }));

        // Count this successful call against the daily + monthly caps.
        await Promise.all([
            AiUsage.updateOne({ scope: 'global', clientId: null,     period: usageMonth }, { $inc: { count: 1 } }, { upsert: true }),
            AiUsage.updateOne({ scope: 'client', clientId: targetId, period: usageDay   }, { $inc: { count: 1 } }, { upsert: true }),
        ]);

        res.json({ remaining, suggestions: verified });
    } catch (e) {
        console.error('Meal suggestion error:', e.message);
        const isTimeout = e?.name === 'APIConnectionTimeoutError' || /timeout|timed out/i.test(e?.message || '');
        const msg = e.status === 401
            ? 'Error de autenticación con el servicio de IA. Contacta al administrador.'
            : isTimeout
            ? 'El recomendador tardó demasiado. Intenta de nuevo.'
            : 'Error generando sugerencias. Intenta de nuevo.';
        res.status(isTimeout ? 504 : 500).json({ message: msg });
    }
});

// ==========================================================================
// --- PROTECTED: Natural-language food parsing ("Describir" tab) ---
// Client types a meal in plain Spanish; Claude splits it into base foods +
// estimated grams; the server verifies macros against the food DB. The client
// confirms the preview before anything is logged.
// ==========================================================================
const FOOD_PARSE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        items: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    food:  { type: 'string', description: 'Nombre base más simple y genérico del alimento, sin preparación ni marca (ej: "Huevo", "Avena", "Arroz blanco", "Plátano", "Leche", "Café")' },
                    grams: { type: 'number', description: 'Cantidad total estimada en gramos' },
                },
                required: ['food', 'grams'],
            },
        },
    },
    required: ['items'],
};

app.post('/api/parse-food', authenticateToken, async (req, res) => {
    if (!FOOD_NLP_ENABLED) {
        return res.status(503).json({ message: 'El registro por texto estará disponible pronto.' });
    }
    if (!anthropic) {
        return res.status(503).json({ message: 'La función no está configurada. Agrega ANTHROPIC_API_KEY en .env.' });
    }
    try {
        const text = (req.body.text || '').trim();
        if (text.length < 2)   return res.status(400).json({ message: 'Escribe lo que comiste.' });
        if (text.length > 500) return res.status(400).json({ message: 'El texto es demasiado largo.' });

        const targetId = req.user.id;  // clients log their own meals

        // Usage caps — shared global monthly $ cap + per-client daily NLP cap.
        const usageNow = new Date();
        const usageMonth = usageNow.toISOString().slice(0, 7);
        const usageDay   = usageNow.toISOString().slice(0, 10);
        const [globalUse, clientUse] = await Promise.all([
            AiUsage.findOne({ scope: 'global',     clientId: null,     period: usageMonth }),
            AiUsage.findOne({ scope: 'client_nlp', clientId: targetId, period: usageDay   }),
        ]);
        if ((globalUse?.count || 0) >= MEAL_MONTHLY_LIMIT) {
            return res.status(429).json({ message: 'El registro por texto alcanzó su límite de uso este mes.' });
        }
        if ((clientUse?.count || 0) >= FOOD_NLP_DAILY_LIMIT) {
            return res.status(429).json({ message: `Alcanzaste el máximo de ${FOOD_NLP_DAILY_LIMIT} análisis por hoy. Vuelve mañana.` });
        }

        const systemPrompt =
`Conviertes descripciones de comidas en español en una lista estructurada de alimentos.
REGLAS:
- Devuelve cada alimento por separado con su cantidad total estimada en GRAMOS.
- Usa el nombre MÁS SIMPLE y genérico del alimento base, sin preparación, empaque ni marca (ej: "Huevo", "Avena", "Arroz blanco", "Pechuga de pollo", "Plátano", "Leche", "Café").
- Si el usuario nombra un PLATO PREPARADO conocido (ej: mofongo, tostones, alcapurrias, pastelón, canoas, arroz con gandules, pernil, sancocho, mallorca, tripleta), trátalo como UN SOLO alimento con ese nombre. NO lo descompongas en ingredientes (aceite, sal, ajo, etc.).
- Solo separa cuando el usuario menciona alimentos distintos juntos (ej: "arroz y habichuelas" → "Arroz" y "Habichuelas"; "café con leche" → "Café" y "Leche"; "avena con plátano" → "Avena" y "Plátano").
- No agregues ingredientes, condimentos, aceite ni sal que el usuario no haya mencionado.
- Estima gramos usando PESO COCIDO y PORCIÓN COMESTIBLE (sin hueso ni cáscara), con porciones TÍPICAS, no máximas. Guía de referencia:
    · 1 huevo ≈ 50g  ·  1 rebanada de pan ≈ 30g  ·  1 plátano ≈ 120g  ·  1 papa mediana ≈ 150g
    · 1 cucharada ≈ 15g  ·  1 cucharada grande / de servir ≈ 30g
    · 1 taza de líquido ≈ 240g  ·  1 taza de arroz o avena COCIDOS ≈ 150g
    · 1 muslo de pollo (carne sin hueso) ≈ 120g  ·  1 pechuga de pollo ≈ 150g  ·  1 porción de carne o pescado ≈ 150g
- Si la unidad es ambigua, elige una porción típica conservadora (no la más grande).
- Si no se menciona cantidad, asume 1 porción típica.
- No inventes alimentos que no se mencionan, y no calcules calorías ni macros.`;
        const userPrompt = `Comida descrita: "${text}"\n\nConviértela en una lista de alimentos con gramos.`;

        const aiResp = await anthropic.messages.create({
            model: 'claude-haiku-4-5',
            max_tokens: 1500,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
            output_config: { format: { type: 'json_schema', schema: FOOD_PARSE_SCHEMA } },
        }, { timeout: 25000, maxRetries: 1 });

        const textBlock = aiResp.content.find(b => b.type === 'text');
        let parsed;
        try { parsed = JSON.parse(textBlock?.text || '{}'); }
        catch { return res.status(502).json({ message: 'No se pudo interpretar la comida. Intenta de nuevo.' }); }

        const rawItems = Array.isArray(parsed.items) ? parsed.items.slice(0, 15) : [];

        // Verify each parsed food against the DB and compute real macros (in parallel).
        const items = await Promise.all(rawItems.map(async (it) => {
            const grams = Math.max(0, Number(it.grams) || 0);
            const macro = await resolveIngredientMacros(it.food);
            if (!macro || grams <= 0) {
                return { food: it.food, grams, verified: false, calories: 0, protein: 0, carbs: 0, fat: 0 };
            }
            const factor = grams / 100;
            return {
                food: it.food,
                matchedName: macro.name,
                grams,
                verified: true,
                calories: Math.round(macro.per100.cal     * factor),
                protein:  Math.round(macro.per100.protein * factor),
                carbs:    Math.round(macro.per100.carbs   * factor),
                fat:      Math.round(macro.per100.fat     * factor),
            };
        }));

        await Promise.all([
            AiUsage.updateOne({ scope: 'global',     clientId: null,     period: usageMonth }, { $inc: { count: 1 } }, { upsert: true }),
            AiUsage.updateOne({ scope: 'client_nlp', clientId: targetId, period: usageDay   }, { $inc: { count: 1 } }, { upsert: true }),
        ]);

        res.json({ items });
    } catch (e) {
        console.error('Food parse error:', e.message);
        const isTimeout = e?.name === 'APIConnectionTimeoutError' || /timeout|timed out/i.test(e?.message || '');
        res.status(isTimeout ? 504 : 500).json({
            message: isTimeout ? 'El análisis tardó demasiado. Intenta de nuevo.' : 'Error analizando la comida. Intenta de nuevo.',
        });
    }
});

// ==========================================================================
// --- PROTECTED: Nutrition Label Scanner (client's "Escanear > Etiqueta") ---
// Client photographs a Nutrition Facts panel; Claude vision extracts the
// serving size and macros AS PRINTED. The client confirms or edits the values
// before anything is logged — the AI result is a pre-fill, never a silent write.
// ==========================================================================
const LABEL_SCAN_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        found:        { type: 'boolean', description: 'true solo si la imagen contiene una tabla de información nutricional legible (Nutrition Facts / Datos de Nutrición)' },
        name:         { type: 'string',  description: 'Nombre del producto si es visible en la foto; si no, un nombre corto descriptivo del alimento; vacío si found=false' },
        servingText:  { type: 'string',  description: 'Tamaño de porción tal como aparece impreso, ej: "2/3 cup (55g)"; vacío si no visible' },
        servingGrams: { type: 'number',  description: 'Equivalente en gramos (o ml) del tamaño de porción impreso; 0 si el peso no aparece' },
        calories:     { type: 'number',  description: 'Calorías POR PORCIÓN tal como están impresas' },
        protein:      { type: 'number',  description: 'Proteína en gramos POR PORCIÓN' },
        carbs:        { type: 'number',  description: 'Carbohidratos totales (Total Carbohydrate) en gramos POR PORCIÓN' },
        fat:          { type: 'number',  description: 'Grasa total (Total Fat) en gramos POR PORCIÓN. Si "Total Fat" no es legible pero hay subtipos (saturada, trans, poliinsaturada, monoinsaturada), devuelve la SUMA de los subtipos visibles' },
    },
    required: ['found', 'name', 'servingText', 'servingGrams', 'calories', 'protein', 'carbs', 'fat'],
};

const SCAN_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

app.post('/api/scan-label', authenticateToken, async (req, res) => {
    if (!FOOD_SCAN_ENABLED) {
        return res.status(503).json({ message: 'El escáner de etiquetas estará disponible pronto.' });
    }
    if (!anthropic) {
        return res.status(503).json({ message: 'La función no está configurada. Agrega ANTHROPIC_API_KEY en .env.' });
    }
    try {
        // Accept either a raw base64 string or a data URL; normalize to raw base64.
        let image = (req.body.image || '');
        let mediaType = (req.body.mediaType || 'image/jpeg');
        const dataUrlMatch = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(image);
        if (dataUrlMatch) { mediaType = dataUrlMatch[1].toLowerCase(); image = dataUrlMatch[2]; }
        if (!SCAN_MEDIA_TYPES.includes(mediaType)) {
            return res.status(400).json({ message: 'Formato de imagen no soportado. Usa JPG, PNG o WebP.' });
        }
        // Base64 sanity: non-empty and under the 2MB JSON body limit's practical ceiling.
        if (typeof image !== 'string' || image.length < 100) {
            return res.status(400).json({ message: 'No se recibió la imagen.' });
        }
        if (image.length > 1.9 * 1024 * 1024) {
            return res.status(413).json({ message: 'La imagen es demasiado grande. Toma la foto de nuevo.' });
        }

        const targetId = req.user.id;

        // Usage caps — shared global monthly $ cap + per-client daily scan cap.
        const usageNow   = new Date();
        const usageMonth = usageNow.toISOString().slice(0, 7);
        const usageDay   = usageNow.toISOString().slice(0, 10);
        const [globalUse, clientUse] = await Promise.all([
            AiUsage.findOne({ scope: 'global',      clientId: null,     period: usageMonth }),
            AiUsage.findOne({ scope: 'client_scan', clientId: targetId, period: usageDay   }),
        ]);
        if ((globalUse?.count || 0) >= MEAL_MONTHLY_LIMIT) {
            return res.status(429).json({ message: 'El escáner de etiquetas alcanzó su límite de uso este mes.' });
        }
        if ((clientUse?.count || 0) >= FOOD_SCAN_DAILY_LIMIT) {
            return res.status(429).json({ message: `Alcanzaste el máximo de ${FOOD_SCAN_DAILY_LIMIT} escaneos por hoy. Vuelve mañana.` });
        }

        const systemPrompt =
`Lees fotos de tablas de información nutricional (Nutrition Facts de EE.UU./Puerto Rico o Datos de Nutrición en español) y extraes los valores impresos.
REGLAS:
- Devuelve los valores POR PORCIÓN exactamente como están impresos. NO los conviertas a 100g ni los escales.
- Grasa: usa "Total Fat" / "Grasa Total". Si ese renglón NO aparece o no es legible, devuelve la SUMA de TODOS los subtipos de grasa visibles, INCLUYENDO la grasa trans (saturada + trans + poliinsaturada + monoinsaturada). Ejemplo: saturada 2g + trans 0.5g + poliinsaturada 1.5g + monoinsaturada 4g = 8.
- Carbohidratos: usa "Total Carbohydrate" / "Carbohidrato Total" (no restes fibra ni azúcares).
- servingGrams: el peso en gramos (o ml para líquidos) del tamaño de porción, ej: de "2/3 cup (55g)" devuelve 55. Si el peso no aparece impreso, devuelve 0 — NO lo estimes.
- Si un valor no es legible, devuelve 0 para ese valor. No inventes números.
- Si la imagen NO contiene una tabla nutricional legible, devuelve found=false con todos los valores en 0.`;

        const aiResp = await anthropic.messages.create({
            model: 'claude-haiku-4-5',
            max_tokens: 500,
            system: systemPrompt,
            messages: [{
                role: 'user',
                content: [
                    { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
                    { type: 'text', text: 'Extrae los datos de esta etiqueta nutricional.' },
                ],
            }],
            output_config: { format: { type: 'json_schema', schema: LABEL_SCAN_SCHEMA } },
        }, { timeout: 30000, maxRetries: 1 });

        const textBlock = aiResp.content.find(b => b.type === 'text');
        let parsed;
        try { parsed = JSON.parse(textBlock?.text || '{}'); }
        catch { return res.status(502).json({ message: 'No se pudo leer la etiqueta. Intenta con una foto más clara.' }); }

        // Count usage even for found=false — the vision call was made either way.
        await Promise.all([
            AiUsage.updateOne({ scope: 'global',      clientId: null,     period: usageMonth }, { $inc: { count: 1 } }, { upsert: true }),
            AiUsage.updateOne({ scope: 'client_scan', clientId: targetId, period: usageDay   }, { $inc: { count: 1 } }, { upsert: true }),
        ]);

        if (!parsed.found) {
            return res.json({ found: false });
        }
        // Sanitize numbers: no negatives, one decimal max.
        const num = v => Math.max(0, Math.round((Number(v) || 0) * 10) / 10);
        res.json({
            found:        true,
            name:         String(parsed.name || '').slice(0, 120).trim() || 'Producto escaneado',
            servingText:  String(parsed.servingText || '').slice(0, 60).trim(),
            servingGrams: num(parsed.servingGrams),
            calories:     num(parsed.calories),
            protein:      num(parsed.protein),
            carbs:        num(parsed.carbs),
            fat:          num(parsed.fat),
        });
    } catch (e) {
        console.error('Label scan error:', e.message);
        const isTimeout = e?.name === 'APIConnectionTimeoutError' || /timeout|timed out/i.test(e?.message || '');
        res.status(isTimeout ? 504 : 500).json({
            message: isTimeout ? 'El escaneo tardó demasiado. Intenta de nuevo.' : 'Error leyendo la etiqueta. Intenta de nuevo.',
        });
    }
});

// ==========================================================================
// --- PROTECTED: AI Equipment Check (trainer's "Revisar equipo") ---
// Given a client's equipment inventory and the day's exercises + free-text
// instructions, the AI flags exercises the client lacks equipment for, or whose
// prescribed weight exceeds what they own. Advisory only; trainer-initiated.
// ==========================================================================
const EQUIPMENT_CHECK_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        results: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    name:  { type: 'string', description: 'Nombre del ejercicio, igual al recibido' },
                    ok:    { type: 'boolean', description: 'true si el cliente puede realizarlo con su equipo y pesos' },
                    issue: { type: 'string', description: 'Si ok=false, explicación breve en español (equipo faltante o peso que excede lo disponible). Vacío si ok=true.' },
                },
                required: ['name', 'ok', 'issue'],
            },
        },
    },
    required: ['results'],
};

// Render a client's equipment object into readable text for the prompt.
function describeEquipment(eq) {
    if (!eq) return '';
    const unit = eq.unit || 'lbs';
    const lines = [];
    const list = (label, arr) => { if (arr && arr.length) lines.push(`${label}: ${arr.join(', ')} ${unit}`); };
    list('Mancuernas', eq.dumbbells);
    list('Discos/Platos para barra', eq.plates);
    list('Kettlebells', eq.kettlebells);
    list('Pesos en poleas/cables', eq.cables);
    const STATION = { barra: 'Barra', banco: 'Banco plano', prensa: 'Prensa de pierna', squat: 'Rack de sentadilla' };
    const OTHER = { bands: 'Bandas', trx: 'TRX', mat: 'Colchoneta', pullup: 'Barra de dominadas', treadmill: 'Trotadora', bike: 'Bicicleta', row: 'Máquina de remo', box: 'Cajón pliométrico' };
    const stations = Object.entries(eq.stations || {}).filter(([, v]) => v).map(([k]) => STATION[k] || k);
    const other = Object.entries(eq.other || {}).filter(([, v]) => v).map(([k]) => OTHER[k] || k);
    if (stations.length) lines.push(`Estaciones: ${stations.join(', ')}`);
    if (other.length) lines.push(`Otro equipo: ${other.join(', ')}`);
    return lines.join('\n');
}

app.post('/api/equipment-check', authenticateToken, authorizeRoles('trainer', 'admin'), async (req, res) => {
    if (!EQUIPMENT_CHECK_ENABLED) {
        return res.status(503).json({ message: 'La revisión de equipo estará disponible pronto.' });
    }
    if (!anthropic) {
        return res.status(503).json({ message: 'La función no está configurada. Agrega ANTHROPIC_API_KEY en .env.' });
    }
    try {
        const { clientId } = req.body;
        const exercises = Array.isArray(req.body.exercises) ? req.body.exercises.slice(0, 30) : [];
        if (!clientId) return res.status(400).json({ message: 'Falta el cliente.' });
        if (!exercises.length) return res.status(400).json({ message: 'No hay ejercicios para revisar.' });

        const client = await User.findById(clientId).select('equipment name equipmentCheckOn');
        if (!client) return res.status(404).json({ message: 'Cliente no encontrado' });

        // Per-client toggle: trainer disabled the check for this client (e.g. full-gym member).
        if (client.equipmentCheckOn === false) {
            return res.json({ results: [], disabled: true });
        }

        const equipText = describeEquipment(client.equipment);
        if (!equipText) {
            // No inventory on file — nothing to check against; tell the trainer instead of guessing.
            return res.json({ results: [], noEquipment: true });
        }

        // Usage caps — per-trainer daily + shared global monthly $ cap.
        const usageNow = new Date();
        const usageMonth = usageNow.toISOString().slice(0, 7);
        const usageDay   = usageNow.toISOString().slice(0, 10);
        const [globalUse, trainerUse] = await Promise.all([
            AiUsage.findOne({ scope: 'global',          clientId: null,        period: usageMonth }),
            AiUsage.findOne({ scope: 'equipment_check', clientId: req.user.id, period: usageDay   }),
        ]);
        if ((globalUse?.count || 0) >= MEAL_MONTHLY_LIMIT) {
            return res.status(429).json({ message: 'Se alcanzó el límite de uso de IA este mes.' });
        }
        if ((trainerUse?.count || 0) >= EQUIPMENT_CHECK_DAILY_LIMIT) {
            return res.status(429).json({ message: 'Alcanzaste el máximo de revisiones por hoy.' });
        }

        const exerciseList = exercises.map((e, i) =>
            `${i + 1}. ${String(e.name || '').trim()}${e.instructions ? ` — instrucciones: ${String(e.instructions).trim()}` : ''}`
        ).join('\n');

        const systemPrompt =
`Revisas si un cliente puede realizar los ejercicios asignados con el equipo y los pesos que tiene disponibles.
Para cada ejercicio decide ok=true o ok=false:
- ok=false si el ejercicio REQUIERE equipo que el cliente NO tiene (ej: pide cable/polea y no tiene; pide barra y no tiene; pide kettlebell y no tiene).
- ok=false si las instrucciones piden un PESO mayor al máximo que el cliente tiene disponible para ese tipo de equipo (ej: "mancuernas 40 kg" pero su mancuerna más pesada es 30 kg).
- Los ejercicios de peso corporal siempre son ok=true.
- Si NO estás seguro de que falte algo, marca ok=true (evita falsas alarmas).
Cuando ok=false, escribe en 'issue' una explicación breve en español (qué falta o qué peso excede). Cuando ok=true, 'issue' vacío.
Devuelve un resultado por cada ejercicio, con el mismo nombre recibido.`;
        const userPrompt =
`Equipo disponible del cliente:
${equipText}

Ejercicios asignados:
${exerciseList}`;

        const aiResp = await anthropic.messages.create({
            model: 'claude-haiku-4-5',
            max_tokens: 1500,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
            output_config: { format: { type: 'json_schema', schema: EQUIPMENT_CHECK_SCHEMA } },
        }, { timeout: 25000, maxRetries: 1 });

        const textBlock = aiResp.content.find(b => b.type === 'text');
        let parsed;
        try { parsed = JSON.parse(textBlock?.text || '{}'); }
        catch { return res.status(502).json({ message: 'No se pudo interpretar la revisión. Intenta de nuevo.' }); }

        const results = (Array.isArray(parsed.results) ? parsed.results : []).map(r => ({
            name: String(r.name || ''),
            ok: r.ok !== false,
            issue: r.ok === false ? String(r.issue || 'Equipo o peso no disponible.') : '',
        }));

        await Promise.all([
            AiUsage.updateOne({ scope: 'global',          clientId: null,        period: usageMonth }, { $inc: { count: 1 } }, { upsert: true }),
            AiUsage.updateOne({ scope: 'equipment_check', clientId: req.user.id, period: usageDay   }, { $inc: { count: 1 } }, { upsert: true }),
        ]);

        res.json({ results });
    } catch (e) {
        console.error('Equipment check error:', e.message);
        const isTimeout = e?.name === 'APIConnectionTimeoutError' || /timeout|timed out/i.test(e?.message || '');
        res.status(isTimeout ? 504 : 500).json({
            message: isTimeout ? 'La revisión tardó demasiado. Intenta de nuevo.' : 'Error revisando el equipo. Intenta de nuevo.',
        });
    }
});

// ==========================================================================
// --- PROGRAM → CLIENT CALENDAR SYNC ---
// ==========================================================================
// When a trainer edits a program, every client who has it assigned gets their
// FUTURE calendar days re-synced from the new program content. Past days,
// completed/missed days, client-logged days, and trainer-customized days are
// always preserved. Manually-added standalone days (no sourceProgramId) are
// never touched. See the design decisions captured in STUDY_GUIDE / README.

// Add `n` days to a 'YYYY-MM-DD' string and return the resulting 'YYYY-MM-DD'.
const addDaysStr = (dateStr, n) => {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + n);
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
};

// Does a program day-cell have real content worth pushing?
const dayHasContent = (dd) =>
    !!dd && (((dd.isRest || dd.isActiveRest) && !(dd.exercises?.length)) || (dd.exercises?.length > 0));

// A client's day is "protected" (sync must not overwrite or delete it) when the
// client has engaged with it or the trainer customized it.
const isProtectedWorkout = (w) =>
    w.isComplete || w.isMissed || w.manualEdit || w.rpe != null ||
    (Array.isArray(w.exercises) && w.exercises.some(e => (e.results || '').trim() || e.isComplete));

// Map a program day-cell to a ClientWorkout field object (mirrors the client-side
// pushProgramToCalendar mapping so assigned and synced days are identical).
const programDayToWorkout = (dd, programId, wIdx, dayNum) => {
    const base = { sourceProgramId: programId, sourceWeek: wIdx, sourceDayNum: dayNum, manualEdit: false, updatedAt: Date.now() };
    if ((dd.isRest || dd.isActiveRest) && !(dd.exercises?.length)) {
        return {
            ...base,
            title: dd.name || (dd.isActiveRest ? 'Descanso Activo' : 'Descanso'),
            isRest: true, restType: dd.isActiveRest ? 'active_rest' : 'rest',
            exercises: [], warmup: '', warmupItems: [], cooldown: '', cooldownItems: [],
        };
    }
    return {
        ...base,
        title: dd.name || `Semana ${wIdx + 1} — Día ${dayNum}`,
        isRest: false, restType: '',
        warmup:        dd.warmup        || '',
        warmupVideoUrl: dd.warmupVideo  || '',
        warmupItems:   (dd.warmupItems  || []).map(i => ({ id: i.id, name: i.name || '', videoUrl: i.videoUrl || '' })),
        cooldown:      dd.cooldown      || '',
        cooldownVideoUrl: dd.cooldownVideo || '',
        cooldownItems: (dd.cooldownItems || []).map(i => ({ id: i.id, name: i.name || '', videoUrl: i.videoUrl || '' })),
        exercises: dd.exercises.map((ex, idx) => ({
            id:           Date.now() + idx,
            name:         ex.name,
            instructions: ex.stats || ex.instructions || '',
            videoUrl:     ex.video || ex.videoUrl || '',
            isSuperset:   ex.isSuperset   || false,
            supersetHead: ex.supersetHead || false,
        })),
    };
};

// Re-sync one program to every client that has it assigned. `todayStr` is the
// trainer's local date (passed from the browser) used as the "future" cutoff.
const syncProgramToClients = async (program, todayStr) => {
    const summary = { clients: 0, updated: 0, created: 0, removed: 0 };
    const clients = await User.find({ 'assignedProgram.programId': program._id });
    for (const client of clients) {
        const startDate    = client.assignedProgram?.startDate;
        const anchorOffset = client.assignedProgram?.anchorOffset || 0;
        if (!startDate) continue;
        summary.clients++;

        // Build the program's current slots keyed by "week-day" with target dates.
        const slots = new Map();
        for (let wIdx = 0; wIdx < (program.weeks?.length || 0); wIdx++) {
            const week = program.weeks[wIdx];
            for (let dayNum = 1; dayNum <= 7; dayNum++) {
                const dd = week?.days?.[String(dayNum)] ?? week?.days?.[dayNum];
                const globalIndex = wIdx * 7 + (dayNum - 1);
                const dateStr = addDaysStr(startDate, globalIndex - anchorOffset);
                slots.set(`${wIdx}-${dayNum}`, { dd, wIdx, dayNum, dateStr, hasContent: dayHasContent(dd) });
            }
        }

        const existing = await ClientWorkout.find({ clientId: client._id, sourceProgramId: program._id });
        const existingByKey = new Map(existing.map(w => [`${w.sourceWeek}-${w.sourceDayNum}`, w]));

        // 1) UPDATE existing & CREATE new program days (future, content slots only).
        for (const [key, slot] of slots) {
            if (!slot.hasContent || slot.dateStr < todayStr) continue;
            const cur = existingByKey.get(key);
            const fields = programDayToWorkout(slot.dd, program._id, slot.wIdx, slot.dayNum);
            if (cur) {
                if (isProtectedWorkout(cur)) continue;          // keep client/trainer changes
                Object.assign(cur, fields);
                await cur.save();
                summary.updated++;
            } else {
                // New day — never clobber whatever already sits on that date.
                const occupied = await ClientWorkout.findOne({ clientId: client._id, date: slot.dateStr });
                if (occupied) continue;
                await ClientWorkout.create({ clientId: client._id, date: slot.dateStr, ...fields });
                summary.created++;
            }
        }

        // 2) REMOVE days dropped/emptied from the program (future & untouched only).
        for (const w of existing) {
            const slot = slots.get(`${w.sourceWeek}-${w.sourceDayNum}`);
            if (slot && slot.hasContent) continue;              // still part of the program
            if (w.date < todayStr || isProtectedWorkout(w)) continue;
            await ClientWorkout.deleteOne({ _id: w._id });
            summary.removed++;
        }
    }
    return summary;
};

// ==========================================================================
// --- PROTECTED: Programs ---
// ==========================================================================

app.get('/api/programs', authenticateToken, async (req, res) => {
    try {
        const programs = await Program.find().sort({ createdAt: -1 });
        res.json(programs);
    } catch (error) {
        console.error('Error fetching programs:', error);
        res.status(500).json({ message: 'Error fetching programs', error});
    }
});

app.post('/api/programs', authenticateToken, authorizeRoles('trainer', 'admin'), async (req, res) => {
    try {
        const { name, description, tags, weeks } = req.body;
        const program = new Program({
            name,
            description: description || "",
            tags: tags || "Borrador",
            weeks: weeks || [],
            clientCount: 0
        });
        await program.save();
        res.json(program);
    } catch (error) {
        console.error('Error creating program:', error);
        res.status(500).json({ message: 'Error creating program', error });
    }
});

app.put('/api/programs/:id', authenticateToken, authorizeRoles('trainer', 'admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const program = await Program.findById(id);
        if (!program) return res.status(404).json({ message: 'Program not found' });

        // Assign each top-level field explicitly so Mongoose tracks the changes
        const { name, description, tags, weeks } = req.body;
        if (name      !== undefined) program.name        = name;
        if (description !== undefined) program.description = description;
        if (tags      !== undefined) program.tags        = tags;
        if (weeks     !== undefined) program.weeks       = weeks;
        program.updatedAt = Date.now();

        // markModified is required for Map-of-Mixed fields so Mongoose
        // doesn't skip them during dirty-tracking
        program.markModified('weeks');
        await program.save();

        // Auto-propagate the edit to every client who has this program assigned —
        // but only when the day grid actually changed (a rename can't move days).
        // The cutoff uses the trainer's local date (X-Client-Date header) so the
        // "future only" rule matches what the trainer sees. Non-fatal: a sync
        // failure must never fail the program save itself.
        let sync = null;
        if (weeks !== undefined) {
            try {
                const hdr = req.headers['x-client-date'];
                const todayStr = (typeof hdr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(hdr))
                    ? hdr
                    : new Date().toISOString().slice(0, 10);
                sync = await syncProgramToClients(program, todayStr);
            } catch (e) {
                console.error('Program sync failed (program still saved):', e.message);
            }
        }

        // flattenMaps: true converts the `days` Map to a plain object. Without it,
        // .toObject() leaves `days` as a JS Map, and spreading into a plain object
        // hides it from Express's toJSON path, so JSON.stringify serializes each
        // Map to `{}` — the response would come back with every day wiped, which
        // then poisons the client's programsCache and erases days on the next save.
        res.json({ ...program.toObject({ flattenMaps: true }), _sync: sync });
    } catch (error) {
        console.error('Error updating program:', error);
        res.status(500).json({ message: 'Error updating program', error });
    }
});

// Which clients actually receive auto-sync for this program, and which ones carry
// the program only as a legacy `program` NAME string with no assignedProgram link.
// The unlinked ones silently miss every program edit — the builder surfaces them
// so the trainer can re-assign once and turn auto-sync on for good.
app.get('/api/programs/:id/assignment-status', authenticateToken, authorizeRoles('trainer', 'admin'), async (req, res) => {
    try {
        const program = await Program.findById(req.params.id).select('name').lean();
        if (!program) return res.status(404).json({ message: 'Program not found' });

        const clients = await User.find({ role: 'client', isDeleted: { $ne: true } })
            .select('name lastName program assignedProgram').lean();

        const linked = [], unlinked = [];
        for (const c of clients) {
            const label = `${c.name || ''} ${c.lastName || ''}`.trim() || 'Cliente';
            if (String(c.assignedProgram?.programId || '') === String(program._id)) {
                linked.push({ _id: c._id, name: label, startDate: c.assignedProgram?.startDate || null });
            } else if (!c.assignedProgram?.programId && c.program && c.program === program.name) {
                // Same program by name, but no link → auto-sync cannot reach them.
                unlinked.push({ _id: c._id, name: label });
            }
        }
        res.json({ programName: program.name, linked, unlinked });
    } catch (e) {
        console.error('assignment-status error:', e.message);
        res.status(500).json({ message: 'Error fetching assignment status' });
    }
});

// Record (or clear) which program is assigned to a client. Drives the auto-sync
// above: a client is only re-synced if assignedProgram.programId points here.
app.put('/api/clients/:clientId/assigned-program', authenticateToken, authorizeRoles('trainer', 'admin'), async (req, res) => {
    try {
        const { clientId } = req.params;
        const { programId, startDate, anchorOffset } = req.body;
        const assignedProgram = (programId && startDate)
            ? { programId, startDate, anchorOffset: anchorOffset || 0 }
            : { programId: null, startDate: null, anchorOffset: 0 };
        const user = await User.findByIdAndUpdate(clientId, { assignedProgram }, { new: true });
        if (!user) return res.status(404).json({ message: 'Client not found' });
        res.json({ ok: true, assignedProgram: user.assignedProgram });
    } catch (e) {
        console.error('Error setting assigned program:', e.message);
        res.status(500).json({ message: 'Error setting assigned program' });
    }
});

app.delete('/api/programs/:id', authenticateToken, authorizeRoles('trainer', 'admin'), async (req, res) => {
    try {
        const { id } = req.params;
        await Program.findByIdAndDelete(id);
        res.json({ message: 'Program deleted' });
    } catch (error) {
        console.error('Error deleting program:', error);
        res.status(500).json({ message: 'Error deleting program', error });
    }
});

// ==========================================================================
// --- PROTECTED: Groups ---
// ==========================================================================

app.get('/api/groups', authenticateToken, async (req, res) => {
    try {
        const groups = await Group.find().sort({ name: 1 });
        res.json(groups);
    } catch (e) { res.status(500).json({ message: 'Error fetching groups' }); }
});

app.post('/api/groups', authenticateToken, authorizeRoles('trainer', 'admin'), async (req, res) => {
    try {
        const { name } = req.body;
        const existing = await Group.findOne({ name });
        if (existing) return res.status(400).json({ message: 'Group already exists' });
        const group = new Group({ name, createdBy: req.user.id });
        await group.save();
        res.json(group);
    } catch (e) { res.status(500).json({ message: 'Error creating group' }); }
});

app.delete('/api/groups/:id', authenticateToken, authorizeRoles('trainer', 'admin'), async (req, res) => {
    try {
        await Group.findByIdAndDelete(req.params.id);
        res.json({ message: 'Group deleted' });
    } catch (e) { res.status(500).json({ message: 'Error deleting group' }); }
});

// ==========================================================================
// --- PROTECTED: Notifications ---
// ==========================================================================

// GET unread count (MUST be before :id route)
app.get('/api/notifications/unread-count', authenticateToken, async (req, res) => {
    try {
        const count = await Notification.countDocuments({ trainerId: req.user.id, isRead: false });
        res.json({ count });
    } catch (error) {
        console.error('Error fetching unread count:', error);
        res.status(500).json({ message: 'Error fetching unread count' });
    }
});

// Mark ALL as read
app.put('/api/notifications/read-all', authenticateToken, async (req, res) => {
    try {
        await Notification.updateMany({ trainerId: req.user.id, isRead: false }, { isRead: true });
        res.json({ message: 'All marked as read' });
    } catch (error) {
        console.error('Error marking all as read:', error);
        res.status(500).json({ message: 'Error marking all as read' });
    }
});

// GET all notifications for the logged-in trainer
app.get('/api/notifications', authenticateToken, async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
        const skip  = Math.max(parseInt(req.query.skip, 10) || 0, 0);
        const filter = req.query.filter;

        const query = { trainerId: req.user.id };
        if (filter === 'unread') {
            query.isRead = false;
        } else if (filter === '7days') {
            const sevenDaysAgo = new Date();
            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
            query.createdAt = { $gte: sevenDaysAgo };
        }

        // Fetch one extra to detect whether more pages exist.
        const docs = await Notification.find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit + 1);
        const hasMore = docs.length > limit;
        res.json({ notifications: hasMore ? docs.slice(0, limit) : docs, hasMore });
    } catch (error) {
        console.error('Error fetching notifications:', error);
        res.status(500).json({ message: 'Error fetching notifications' });
    }
});

// Mark ONE as read
app.put('/api/notifications/:id/read', authenticateToken, async (req, res) => {
    try {
        // H-6: Only mark read if this notification belongs to the requesting trainer
        const updated = await Notification.findOneAndUpdate(
            { _id: req.params.id, trainerId: req.user.id },
            { isRead: true }
        );
        if (!updated) return res.status(404).json({ message: 'Notification not found' });
        res.json({ message: 'Marked as read' });
    } catch (error) {
        console.error('Error marking notification as read:', error);
        res.status(500).json({ message: 'Error marking notification as read' });
    }
});

// ==========================================================================
// --- PROTECTED: Client Equipment ---
// ==========================================================================

app.get('/api/equipment', authenticateToken, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('equipment');
        res.json(user?.equipment || {});
    } catch (e) { res.status(500).json({ message: 'Error fetching equipment' }); }
});

app.put('/api/equipment', authenticateToken, async (req, res) => {
    try {
        const { equipment } = req.body;
        const user = await User.findByIdAndUpdate(req.user.id, { equipment }, { new: true })
            .select('name lastName email');

        // Notify the trainer when a CLIENT updates their equipment — throttled so a
        // setup session (which auto-saves on every change) collapses into one notice.
        if (req.user.role === 'client' && user) {
            const TWO_HOURS = 2 * 60 * 60 * 1000;
            const recent = await Notification.findOne({
                clientId: user._id,
                type: 'equipment_updated',
                createdAt: { $gte: new Date(Date.now() - TWO_HOURS) },
            });
            if (!recent) {
                const clientName = `${user.name || ''}${user.lastName ? ' ' + user.lastName : ''}`.trim() || user.email;
                await createNotification({
                    clientId: user._id,
                    clientName,
                    type: 'equipment_updated',
                    title: `${clientName} actualizó su equipo`,
                    message: 'Revisa su equipo y pesos disponibles.',
                    data: { equipment },
                });
            }
        }
        res.json({ message: 'Equipment saved' });
    } catch (e) { res.status(500).json({ message: 'Error saving equipment' }); }
});

// ==========================================================================
// --- PUBLIC CONTACT / INTEREST FORM (no auth required) ---
// ==========================================================================
const contactLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: { message: 'Demasiados mensajes. Intenta más tarde.' } });

app.post('/api/contact', contactLimiter, async (req, res) => {
    const { name, email, phone, message, _honeypot, _formLoadTime } = req.body;

    // ── Bot defenses ──────────────────────────────────────────────────────
    // 1) Honeypot: hidden field that real users never fill; bots always do
    if (_honeypot) {
        // Silent accept so bots think they succeeded
        return res.json({ message: 'Mensaje enviado correctamente.' });
    }
    // 2) Timing check: real humans take at least 4 seconds to fill a form
    const elapsed = Date.now() - Number(_formLoadTime || 0);
    if (elapsed < 4000) {
        return res.status(429).json({ message: 'Enviado demasiado rápido. Por favor intenta de nuevo.' });
    }
    // ─────────────────────────────────────────────────────────────────────

    if (!name || !email || !message) {
        return res.status(400).json({ message: 'Nombre, email y mensaje son requeridos.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ message: 'Email inválido.' });
    }
    if (message.length > 1000) {
        return res.status(400).json({ message: 'El mensaje no puede superar 1000 caracteres.' });
    }

    try {
        // 1) Send email to trainer
        await sendEmail({
            from: 'FitBySuárez <noreply@fitbysuarez.com>',
            to: process.env.GMAIL_USER,
            subject: `Nuevo interesado: ${name}`,
            html: `
                <div style="font-family:sans-serif;max-width:560px;margin:auto;background:#1C1C1E;padding:32px;border-radius:12px;color:#fff;">
                    <h2 style="color:#FFDB89;margin-top:0;">📩 Nuevo mensaje de interés</h2>
                    <table style="width:100%;border-collapse:collapse;">
                        <tr><td style="padding:8px 0;color:#FFDB89;font-weight:bold;width:110px;">Nombre</td><td style="padding:8px 0;">${name}</td></tr>
                        <tr><td style="padding:8px 0;color:#FFDB89;font-weight:bold;">Email</td><td style="padding:8px 0;"><a href="mailto:${email}" style="color:#FFDB89;">${email}</a></td></tr>
                        ${phone ? `<tr><td style="padding:8px 0;color:#FFDB89;font-weight:bold;">Teléfono</td><td style="padding:8px 0;">${phone}</td></tr>` : ''}
                        <tr><td style="padding:8px 0;color:#FFDB89;font-weight:bold;vertical-align:top;">Mensaje</td><td style="padding:8px 0;white-space:pre-wrap;">${message}</td></tr>
                    </table>
                </div>
            `
        });

        // 2) Create trainer notification
        const trainer = await User.findOne({ role: 'trainer' }).select('_id').lean();
        if (trainer) {
            await Notification.create({
                trainerId:  trainer._id,
                clientId:   null,
                clientName: name,
                type:       'contact_inquiry',
                title:      'envió un mensaje de interés',
                message:    `${email}${phone ? ' · ' + phone : ''} — ${message.slice(0, 120)}${message.length > 120 ? '…' : ''}`,
                data:       { name, email, phone: phone || '', message }
            });
        }

        res.json({ message: 'Mensaje enviado correctamente.' });
    } catch (err) {
        console.error('Contact form error:', err);
        res.status(500).json({ message: 'Error enviando el mensaje. Intenta más tarde.' });
    }
});

// ==========================================================================
// --- STRIPE ROUTES ---
// ==========================================================================

// Helper: find or create a Stripe Customer for a client user
const getOrCreateStripeCustomer = async (clientUser) => {
    if (clientUser.stripeCustomerId) {
        try { return await stripe.customers.retrieve(clientUser.stripeCustomerId); } catch (_) {}
    }
    const customer = await stripe.customers.create({
        name:  `${clientUser.name} ${clientUser.lastName || ''}`.trim(),
        email: clientUser.email,
        metadata: { clientId: clientUser._id.toString() },
    });
    await User.findByIdAndUpdate(clientUser._id, { stripeCustomerId: customer.id });
    return customer;
};

// ==========================================================================
// --- PUBLIC SELF-SERVE SIGNUP (pricing page → Stripe → auto-create account)
// ==========================================================================

// EDIT these to match your real offering. `mode` is 'subscription' (recurring
// monthly) or 'payment' (one-time). Amounts are in USD.
const SIGNUP_PLANS = [
    { id: 'monthly',       label: 'Coaching Mensual',  amount: 99,  mode: 'subscription', blurb: 'Entrenamiento + nutrición personalizados, con ajustes cada semana. Se renueva cada mes.' },
    {
        id: 'progressions3', label: '3 Progresiones', amount: 250, mode: 'payment',
        blurb: 'Tres progresiones de programa completas en un solo pago. Sin renovación.',
        // ─────────────────────────────────────────────────────────────────────────────
        //  EDITA AQUÍ ↓  — Este texto aparece al pulsar "Más información" en el plan $250.
        //  Explica qué es una "progresión". Usa saltos de línea normales para párrafos.
        // ─────────────────────────────────────────────────────────────────────────────
        moreInfo: `Una "progresión" es un bloque de entrenamiento diseñado para un objetivo específico (normalmente ~4 semanas).

Cada progresión sube la dificultad de forma planificada — más peso, más volumen o nuevos ejercicios — para que sigas avanzando sin estancarte.

Con este plan recibes 3 progresiones consecutivas: empezamos donde estás hoy y construimos sobre cada bloque. Es un pago único, sin renovación automática.`,
    },
];
const findSignupPlan = (id) => SIGNUP_PLANS.find(p => p.id === id);

// Create the client account + send the activation email + record the paid invoice.
// Called from the Stripe webhook once a self-serve checkout completes. Idempotent:
// safe to run twice for the same session (Stripe retries webhooks).
// Activation email (set-your-password link) for a freshly created self-signup account.
async function sendActivationEmail(client, inviteRawToken) {
    const inviteLink = `${APP_URL}/?invite=${inviteRawToken}`;
    try {
        await sendEmail({
            from: 'FitBySuárez <noreply@fitbysuarez.com>',
            to: client.email,
            subject: '¡Bienvenido a FitBySuárez! — Activa tu cuenta',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #0a0a0a; color: #f5f5f5;">
                    <div style="text-align: center; margin-bottom: 30px; padding: 20px 0; border-bottom: 1px solid #FFDB8930;">
                        <h1 style="color: #FFDB89; margin: 0; font-size: 28px; letter-spacing: 2px;">FitBySuárez</h1>
                    </div>
                    <div style="background: #1c1c1e; border: 1px solid #FFDB8930; border-radius: 12px; padding: 30px;">
                        <h2 style="color: #FFDB89; margin-top: 0;">¡Hola, ${client.name}!</h2>
                        <p style="color: #ccc; line-height: 1.7;">Gracias por unirte a <strong style="color: #FFDB89;">FitBySuárez</strong>. Tu pago se procesó con éxito. Haz clic abajo para activar tu cuenta y crear tu contraseña.</p>
                        <div style="text-align: center; margin: 30px 0;">
                            <a href="${inviteLink}" style="display: inline-block; background: #FFDB89; color: #030303; padding: 16px 36px; text-decoration: none; border-radius: 10px; font-weight: 900; font-size: 16px;">Activar mi cuenta</a>
                        </div>
                        <p style="color: #888; font-size: 13px;">O copia este enlace: <span style="color:#FFDB89; word-break:break-all;">${inviteLink}</span></p>
                        <p style="color: #ef4444; font-size: 13px; margin-top: 20px;"><strong>El enlace expira en 7 días.</strong></p>
                    </div>
                </div>`,
        });
    } catch (e) { console.error('[signup] activation email failed', e.message); }
}

// Generic self-serve provisioning — shared by Stripe and PayPal. Creates the client
// account (if new) + records the paid invoice + sends the activation email. Idempotent
// via `dedupeQuery` (so webhook/finalize retries don't double-charge or double-create).
// opts: { email, name, lastName, planId, amount, method, stripeCustomerId, dedupeQuery, paymentFields }
async function provisionSignupAccount(opts) {
    const email = (opts.email || '').toLowerCase().trim();
    if (!email) { console.error('[signup] provision with no email'); return null; }
    if (opts.dedupeQuery && await Payment.findOne(opts.dedupeQuery)) return null; // already done

    const trainer = await User.findOne({ role: { $in: ['trainer', 'admin'] } }).select('_id');
    if (!trainer) { console.error('[signup] no trainer/admin to own the new client'); return null; }

    const plan   = findSignupPlan(opts.planId);
    const amount = opts.amount != null ? opts.amount : (plan?.amount || 0);
    const today  = new Date().toISOString().split('T')[0];

    let client = await User.findOne({ email });
    let inviteRawToken = null;
    if (!client) {
        inviteRawToken = crypto.randomBytes(32).toString('hex');
        client = new User({
            name: opts.name || 'Nuevo', lastName: opts.lastName || '', email,
            password: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10),
            isFirstLogin: true, role: 'client', trainerId: trainer._id,
            ...(opts.stripeCustomerId ? { stripeCustomerId: opts.stripeCustomerId } : {}),
            inviteToken: crypto.createHash('sha256').update(inviteRawToken).digest('hex'),
            inviteExpires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        });
        await client.save();
        await createNotification({
            clientId: client._id,
            clientName: `${client.name} ${client.lastName || ''}`.trim(),
            type: 'client_created',
            title: 'se registró y pagó en línea',
            message: `${email}${plan ? ` · ${plan.label}` : ''} · $${amount} · ${opts.method}`,
        });
    }

    await new Payment({
        clientId: client._id, trainerId: trainer._id,
        amount, status: 'paid', method: opts.method, paidDate: today, dueDate: today,
        periodLabel: plan?.label || '',
        type: plan?.mode === 'subscription' ? 'subscription' : 'one_time',
        planLabel: plan?.label || '',
        ...(opts.paymentFields || {}),
    }).save();

    if (inviteRawToken) await sendActivationEmail(client, inviteRawToken);
    return client;
}

// Stripe adapter — called from the Stripe webhook on checkout.session.completed.
async function provisionSelfSignupClient(session) {
    const md = session.metadata || {};
    await provisionSignupAccount({
        email: md.email || session.customer_details?.email,
        name: md.name, lastName: md.lastName, planId: md.planId,
        amount: session.amount_total != null ? session.amount_total / 100 : null,
        method: 'stripe',
        stripeCustomerId: session.customer || null,
        dedupeQuery: { stripeCheckoutSessionId: session.id },
        paymentFields: {
            stripeCheckoutSessionId: session.id,
            stripeSubscriptionId: session.subscription || null,
            stripePaymentIntentId: session.payment_intent || null,
        },
    });
}

// Public: list the plans shown on the pricing page.
app.get('/api/signup/plans', (req, res) => res.json(SIGNUP_PLANS));

// Public: start a self-serve checkout. Body: { name, lastName, email, planId }
// On success Stripe fires checkout.session.completed → provisionSelfSignupClient().
app.post('/api/signup/checkout', authLimiter, async (req, res) => {
    if (!stripeReady(res)) return;
    try {
        const { name, lastName, email, planId } = req.body;
        const cleanEmail = (email || '').toLowerCase().trim();
        if (!name || !cleanEmail || !planId) return res.status(400).json({ message: 'Nombre, email y plan son requeridos.' });
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) return res.status(400).json({ message: 'Email inválido.' });

        const plan = findSignupPlan(planId);
        if (!plan) return res.status(400).json({ message: 'Plan no válido.' });

        if (await User.findOne({ email: cleanEmail })) {
            return res.status(409).json({ message: 'Ya existe una cuenta con ese email. Inicia sesión.' });
        }

        const isRecurring = plan.mode === 'subscription';
        const session = await stripe.checkout.sessions.create({
            mode: isRecurring ? 'subscription' : 'payment',
            customer_email: cleanEmail,
            line_items: [{
                price_data: {
                    currency: 'usd',
                    unit_amount: Math.round(plan.amount * 100),
                    product_data: { name: `FitBySuárez — ${plan.label}` },
                    ...(isRecurring ? { recurring: { interval: 'month' } } : {}),
                },
                quantity: 1,
            }],
            success_url: `${APP_URL}/signup.html?status=success`,
            cancel_url:  `${APP_URL}/signup.html?status=cancelled`,
            metadata: { signup: 'true', name, lastName: lastName || '', email: cleanEmail, planId, planLabel: plan.label },
        });
        res.json({ checkoutUrl: session.url });
    } catch (e) {
        console.error('Signup checkout error:', e);
        res.status(500).json({ message: e.message || 'Error iniciando el pago.' });
    }
});

// ── Native PayPal (self-serve signup) ────────────────────────────────────────
// Money lands in the trainer's PayPal directly. Requires env: PAYPAL_CLIENT_ID,
// PAYPAL_SECRET, and optionally PAYPAL_ENV ('sandbox' | 'live', default 'live').
const PAYPAL_ENV  = process.env.PAYPAL_ENV || 'live';
const PAYPAL_BASE = PAYPAL_ENV === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
const paypalConfigured = () => !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_SECRET);
const paypalReady = (res) => {
    if (!paypalConfigured()) { res.status(503).json({ message: 'PayPal no está configurado. Agrega PAYPAL_CLIENT_ID y PAYPAL_SECRET.' }); return false; }
    return true;
};

async function paypalToken() {
    const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`).toString('base64');
    const r = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials',
    });
    if (!r.ok) throw new Error('PayPal auth failed');
    return (await r.json()).access_token;
}
async function paypalApi(path, method, token, body) {
    const r = await fetch(`${PAYPAL_BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.message || `PayPal ${method} ${path} → ${r.status}`);
    return data;
}
// Lazily create (once) a PayPal product + monthly billing plan for a subscription
// plan, caching the resulting plan id in AppSetting so we don't recreate it.
async function getPaypalPlanId(token, plan) {
    const key = `paypal_plan_${plan.id}`;
    const cached = await AppSetting.findOne({ key });
    if (cached?.value) return cached.value;
    const product = await paypalApi('/v1/catalogs/products', 'POST', token, {
        name: `FitBySuárez — ${plan.label}`, type: 'SERVICE', category: 'EXERCISE_AND_FITNESS',
    });
    const created = await paypalApi('/v1/billing/plans', 'POST', token, {
        product_id: product.id,
        name: `FitBySuárez ${plan.label}`,
        billing_cycles: [{
            frequency: { interval_unit: 'MONTH', interval_count: 1 },
            tenure_type: 'REGULAR', sequence: 1, total_cycles: 0,
            pricing_scheme: { fixed_price: { value: plan.amount.toFixed(2), currency_code: 'USD' } },
        }],
        payment_preferences: { auto_bill_outstanding: true, setup_fee_failure_action: 'CANCEL', payment_failure_threshold: 1 },
    });
    await AppSetting.create({ key, value: created.id });
    return created.id;
}

// Public: start a PayPal signup. Body: { name, lastName, email, planId }.
// Returns { approveUrl } to redirect the browser to PayPal for approval.
app.post('/api/signup/paypal/create', authLimiter, async (req, res) => {
    if (!paypalReady(res)) return;
    try {
        const { name, lastName, email, planId } = req.body;
        const cleanEmail = (email || '').toLowerCase().trim();
        if (!name || !cleanEmail || !planId) return res.status(400).json({ message: 'Nombre, email y plan son requeridos.' });
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) return res.status(400).json({ message: 'Email inválido.' });
        const plan = findSignupPlan(planId);
        if (!plan) return res.status(400).json({ message: 'Plan no válido.' });
        if (await User.findOne({ email: cleanEmail })) return res.status(409).json({ message: 'Ya existe una cuenta con ese email. Inicia sesión.' });

        const token = await paypalToken();
        let ref, approveUrl, kind;

        if (plan.mode === 'subscription') {
            kind = 'subscription';
            const paypalPlanId = await getPaypalPlanId(token, plan);
            const sub = await paypalApi('/v1/billing/subscriptions', 'POST', token, {
                plan_id: paypalPlanId,
                subscriber: { name: { given_name: name, surname: lastName || '' }, email_address: cleanEmail },
                application_context: {
                    brand_name: 'FitBySuárez', user_action: 'SUBSCRIBE_NOW',
                    return_url: `${APP_URL}/signup.html?paypal=subscription`,
                    cancel_url: `${APP_URL}/signup.html?status=cancelled`,
                },
            });
            ref = sub.id;
            approveUrl = (sub.links || []).find(l => l.rel === 'approve')?.href;
        } else {
            kind = 'order';
            const order = await paypalApi('/v2/checkout/orders', 'POST', token, {
                intent: 'CAPTURE',
                purchase_units: [{ amount: { currency_code: 'USD', value: plan.amount.toFixed(2) }, description: `FitBySuárez — ${plan.label}` }],
                application_context: {
                    brand_name: 'FitBySuárez', user_action: 'PAY_NOW',
                    return_url: `${APP_URL}/signup.html?paypal=order`,
                    cancel_url: `${APP_URL}/signup.html?status=cancelled`,
                },
            });
            ref = order.id;
            approveUrl = (order.links || []).find(l => l.rel === 'approve' || l.rel === 'payer-action')?.href;
        }

        if (!ref || !approveUrl) throw new Error('PayPal no devolvió un enlace de aprobación.');
        await PendingSignup.create({ ref, kind, name, lastName: lastName || '', email: cleanEmail, planId });
        res.json({ approveUrl });
    } catch (e) {
        console.error('PayPal create error:', e);
        res.status(500).json({ message: e.message || 'Error iniciando el pago con PayPal.' });
    }
});

// Public: finalize after PayPal approval. Body: { ref, kind }.
// Captures the order / verifies the subscription, then provisions the account.
app.post('/api/signup/paypal/finalize', authLimiter, async (req, res) => {
    if (!paypalReady(res)) return;
    try {
        const { ref } = req.body;
        if (!ref) return res.status(400).json({ message: 'Falta la referencia del pago.' });
        const pending = await PendingSignup.findOne({ ref });
        if (!pending) return res.json({ status: 'ok' }); // already finalized (retry) — treat as success

        const token = await paypalToken();

        if (pending.kind === 'subscription') {
            const sub = await paypalApi(`/v1/billing/subscriptions/${ref}`, 'GET', token);
            if (!['ACTIVE', 'APPROVED'].includes(sub.status)) return res.status(402).json({ message: 'La suscripción no está activa todavía.' });
            await provisionSignupAccount({
                email: pending.email, name: pending.name, lastName: pending.lastName, planId: pending.planId,
                amount: findSignupPlan(pending.planId)?.amount, method: 'paypal',
                dedupeQuery: { paypalSubscriptionId: ref }, paymentFields: { paypalSubscriptionId: ref },
            });
        } else {
            const cap = await paypalApi(`/v2/checkout/orders/${ref}/capture`, 'POST', token, {});
            if (cap.status !== 'COMPLETED') return res.status(402).json({ message: 'El pago no se completó.' });
            const captured = parseFloat(cap.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value);
            await provisionSignupAccount({
                email: pending.email, name: pending.name, lastName: pending.lastName, planId: pending.planId,
                amount: Number.isNaN(captured) ? undefined : captured, method: 'paypal',
                dedupeQuery: { paypalOrderId: ref }, paymentFields: { paypalOrderId: ref },
            });
        }
        await PendingSignup.deleteOne({ ref });
        res.json({ status: 'ok' });
    } catch (e) {
        console.error('PayPal finalize error:', e);
        res.status(500).json({ message: e.message || 'Error confirmando el pago con PayPal.' });
    }
});

// Record a recurring PayPal subscription payment. The FIRST cycle's record was
// already created by /finalize (no saleId yet) — so we backfill that one and only
// create NEW Payment rows for month 2+. Deduped by saleId for webhook retries.
async function recordPaypalSubscriptionPayment(subId, sale) {
    const saleId = sale.id;
    if (!saleId || await Payment.findOne({ paypalSaleId: saleId })) return; // already recorded
    const original = await Payment.findOne({ paypalSubscriptionId: subId }).sort({ createdAt: 1 });
    if (!original) return;                                   // unknown subscription — ignore
    if (!original.paypalSaleId) {                            // first cycle → tag the existing record
        original.paypalSaleId = saleId;
        await original.save();
        return;
    }
    const months = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    const now = new Date(), today = now.toISOString().split('T')[0];
    await new Payment({
        clientId: original.clientId, trainerId: original.trainerId,
        amount: parseFloat(sale.amount?.total) || original.amount,
        status: 'paid', method: 'paypal', paidDate: today, dueDate: today,
        periodLabel: `${months[now.getMonth()]} ${now.getFullYear()}`,
        type: 'subscription', planLabel: original.planLabel,
        paypalSubscriptionId: subId, paypalSaleId: saleId,
    }).save();
}

// POST /api/paypal/webhook — PayPal posts subscription lifecycle events here.
// Records renewals (PAYMENT.SALE.COMPLETED) and flags cancellations. Verified
// against PAYPAL_WEBHOOK_ID; uses the parsed JSON body (PayPal verifies the event,
// not a raw-byte signature like Stripe — so no special body middleware needed).
app.post('/api/paypal/webhook', async (req, res) => {
    if (!paypalConfigured()) return res.status(503).end();
    const webhookId = process.env.PAYPAL_WEBHOOK_ID;
    if (!webhookId) { console.error('[paypal webhook] PAYPAL_WEBHOOK_ID not set'); return res.status(503).end(); }
    try {
        const token = await paypalToken();
        const verify = await paypalApi('/v1/notifications/verify-webhook-signature', 'POST', token, {
            auth_algo:         req.headers['paypal-auth-algo'],
            cert_url:          req.headers['paypal-cert-url'],
            transmission_id:   req.headers['paypal-transmission-id'],
            transmission_sig:  req.headers['paypal-transmission-sig'],
            transmission_time: req.headers['paypal-transmission-time'],
            webhook_id:        webhookId,
            webhook_event:     req.body,
        });
        if (verify.verification_status !== 'SUCCESS') {
            console.error('[paypal webhook] signature verification failed');
            return res.status(400).end();
        }

        const event = req.body;
        if (event.event_type === 'PAYMENT.SALE.COMPLETED') {
            const sale = event.resource || {};
            if (sale.billing_agreement_id) await recordPaypalSubscriptionPayment(sale.billing_agreement_id, sale);
        } else if (['BILLING.SUBSCRIPTION.CANCELLED', 'BILLING.SUBSCRIPTION.SUSPENDED'].includes(event.event_type)) {
            await Payment.updateMany(
                { paypalSubscriptionId: event.resource?.id, status: 'pending' },
                { $set: { status: 'overdue', notes: 'Suscripción de PayPal cancelada/suspendida.' } }
            );
        }
        res.json({ received: true });
    } catch (e) {
        console.error('[paypal webhook] handler error', e);
        res.status(200).json({ received: true }); // 200 so PayPal doesn't hammer retries on our bugs
    }
});

// POST /api/stripe/checkout — create a Stripe Checkout Session or Invoice
// Body: { clientId, amount, periodLabel, dueDate, notes, type, planLabel, trialDays }
app.post('/api/stripe/checkout', authenticateToken, authorizeRoles('trainer', 'admin'), async (req, res) => {
    if (!stripeReady(res)) return;
    try {
        const { clientId, amount, periodLabel, dueDate, notes, type, planLabel, trialDays } = req.body;
        if (!clientId || !amount || !dueDate || !type) return res.status(400).json({ message: 'Faltan campos requeridos.' });

        const client = await User.findById(clientId).select('name lastName email stripeCustomerId');
        if (!client) return res.status(404).json({ message: 'Cliente no encontrado.' });

        const trainer = await User.findById(req.user.id).select('name lastName');
        const amountCents = Math.round(Number(amount) * 100);
        const description = planLabel || periodLabel || `Entrenamiento — ${periodLabel}`;
        const trainerName = `${trainer.name} ${trainer.lastName || ''}`.trim();

        let stripePaymentLink = null;
        let stripeCheckoutSessionId = null;
        let stripeInvoiceId = null;
        let stripeSubscriptionId = null;

        // ── Stripe Invoice (send directly via Stripe) ────────────────────────
        if (type === 'stripe_invoice') {
            const customer = await getOrCreateStripeCustomer(client);
            await stripe.invoiceItems.create({
                customer: customer.id,
                amount:   amountCents,
                currency: 'usd',
                description,
            });
            const invoice = await stripe.invoices.create({
                customer:          customer.id,
                collection_method: 'send_invoice',
                days_until_due:    7,
                description:       `FitBySuarez — ${trainerName}`,
                metadata:          { trainerId: req.user.id, period: periodLabel || '' },
            });
            const finalizedInvoice = await stripe.invoices.finalizeInvoice(invoice.id);
            await stripe.invoices.sendInvoice(finalizedInvoice.id);
            stripeInvoiceId    = finalizedInvoice.id;
            stripePaymentLink  = finalizedInvoice.hosted_invoice_url;

        // ── Checkout Session (subscription / one-time / trial) ───────────────
        } else {
            const customer = await getOrCreateStripeCustomer(client);
            const isRecurring = type === 'subscription' || type === 'trial';
            const priceData = {
                currency:     'usd',
                unit_amount:  amountCents,
                product_data: { name: description, metadata: { trainerId: req.user.id } },
                ...(isRecurring ? { recurring: { interval: 'month' } } : {}),
            };

            const sessionParams = {
                customer:   customer.id,
                mode:       isRecurring ? 'subscription' : 'payment',
                line_items: [{ price_data: priceData, quantity: 1 }],
                success_url: `${process.env.APP_URL}?stripe=success&session_id={CHECKOUT_SESSION_ID}`,
                cancel_url:  `${process.env.APP_URL}?stripe=cancelled`,
                metadata:    { trainerId: req.user.id, clientId: clientId.toString(), period: periodLabel || '' },
            };

            if (type === 'trial' && trialDays > 0) {
                sessionParams.subscription_data = { trial_period_days: Number(trialDays) };
            }

            const session = await stripe.checkout.sessions.create(sessionParams);
            stripeCheckoutSessionId = session.id;
            stripePaymentLink       = session.url;
        }

        // ── Save Payment record to MongoDB ───────────────────────────────────
        const payment = new Payment({
            clientId:  clientId,
            trainerId: req.user.id,
            amount:    Number(amount),
            status:    'pending',
            method:    'stripe',
            periodLabel,
            dueDate,
            notes:     notes || '',
            type,
            planLabel: planLabel || '',
            trialDays: Number(trialDays) || 0,
            stripeCheckoutSessionId,
            stripeInvoiceId,
            stripeSubscriptionId,
            stripePaymentLink,
        });
        await payment.save();
        res.status(201).json({ payment, checkoutUrl: stripePaymentLink });
    } catch (e) {
        console.error('Stripe checkout error:', e);
        res.status(500).json({ message: e.message || 'Error creando sesión de Stripe.' });
    }
});

// POST /api/stripe/webhook — Stripe sends events here automatically
// Raw body required — registered BEFORE express.json() via middleware exclusion above
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig    = req.headers['stripe-signature'];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!stripe || !secret) return res.status(503).send('Stripe webhook not configured.');

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, secret);
    } catch (err) {
        console.error('Stripe webhook signature error:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
        switch (event.type) {
            // ── Checkout completed (one-time or subscription first payment) ──
            case 'checkout.session.completed': {
                const session = event.data.object;
                // Self-serve signup → create the account + record payment, then stop.
                if (session.metadata?.signup === 'true') {
                    await provisionSelfSignupClient(session);
                    break;
                }
                const payment = await Payment.findOne({ stripeCheckoutSessionId: session.id });
                if (payment) {
                    payment.status = 'paid';
                    payment.paidDate = new Date().toISOString().split('T')[0];
                    if (session.subscription)  payment.stripeSubscriptionId  = session.subscription;
                    if (session.payment_intent) payment.stripePaymentIntentId = session.payment_intent;
                    await payment.save();
                }
                break;
            }
            // ── Recurring subscription invoice paid ──────────────────────────
            case 'invoice.paid': {
                const invoice = event.data.object;
                if (!invoice.subscription) break;
                // Mark existing record paid (first cycle) or create a new one for subsequent cycles
                const existing = await Payment.findOne({ stripeSubscriptionId: invoice.subscription });
                if (existing) {
                    if (existing.status !== 'paid') {
                        existing.status  = 'paid';
                        existing.paidDate = new Date().toISOString().split('T')[0];
                        await existing.save();
                    } else {
                        // Subsequent cycle — create a new payment record for this billing period
                        const periodEnd   = new Date(invoice.period_end * 1000).toISOString().split('T')[0];
                        const periodStart = new Date(invoice.period_start * 1000);
                        const months = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
                        const newPayment = new Payment({
                            clientId:            existing.clientId,
                            trainerId:           existing.trainerId,
                            amount:              invoice.amount_paid / 100,
                            status:              'paid',
                            method:              'stripe',
                            paidDate:            new Date().toISOString().split('T')[0],
                            dueDate:             periodEnd,
                            periodLabel:         `${months[periodStart.getMonth()]} ${periodStart.getFullYear()}`,
                            type:                'subscription',
                            planLabel:           existing.planLabel,
                            stripeSubscriptionId: invoice.subscription,
                            stripeInvoiceId:     invoice.id,
                            stripePaymentLink:   invoice.hosted_invoice_url,
                        });
                        await newPayment.save();
                    }
                }
                break;
            }
            // ── Subscription cancelled ───────────────────────────────────────
            case 'customer.subscription.deleted': {
                const sub = event.data.object;
                await Payment.updateMany(
                    { stripeSubscriptionId: sub.id, status: 'pending' },
                    { $set: { status: 'overdue', notes: 'Suscripción cancelada en Stripe.' } }
                );
                break;
            }
        }
    } catch (e) {
        console.error('Stripe webhook handler error:', e);
    }
    res.json({ received: true });
});

// POST /api/stripe/portal — open Stripe Billing Portal for a client
app.post('/api/stripe/portal', authenticateToken, authorizeRoles('trainer', 'admin'), async (req, res) => {
    if (!stripeReady(res)) return;
    try {
        const { clientId } = req.body;
        const client = await User.findById(clientId).select('stripeCustomerId name');
        if (!client?.stripeCustomerId) return res.status(404).json({ message: 'Este cliente no tiene cuenta en Stripe aún.' });
        const session = await stripe.billingPortal.sessions.create({
            customer:   client.stripeCustomerId,
            return_url: process.env.APP_URL,
        });
        res.json({ portalUrl: session.url });
    } catch (e) {
        console.error('Stripe portal error:', e);
        res.status(500).json({ message: e.message || 'Error abriendo el portal de Stripe.' });
    }
});

// POST /api/stripe/subscription/cancel — cancel subscription at period end
app.post('/api/stripe/subscription/cancel', authenticateToken, authorizeRoles('trainer', 'admin'), async (req, res) => {
    if (!stripeReady(res)) return;
    try {
        const { paymentId } = req.body;
        const payment = await Payment.findOne({ _id: paymentId, trainerId: req.user.id });
        if (!payment?.stripeSubscriptionId) return res.status(404).json({ message: 'No hay suscripción de Stripe para cancelar.' });
        await stripe.subscriptions.update(payment.stripeSubscriptionId, { cancel_at_period_end: true });
        payment.notes = (payment.notes ? payment.notes + ' | ' : '') + 'Cancelación solicitada — termina al final del período.';
        await payment.save();
        res.json({ message: 'Suscripción programada para cancelar al final del período.' });
    } catch (e) {
        console.error('Stripe cancel error:', e);
        res.status(500).json({ message: e.message || 'Error cancelando la suscripción.' });
    }
});

// ==========================================================================
// --- BLOG ROUTES (must be before the catch-all GET * below) ---
// ==========================================================================

// GET /api/blog — public: all published posts (newest first)
app.get('/api/blog', async (req, res) => {
    try {
        const posts = await BlogPost.find({ published: true })
            .sort({ publishedAt: -1 })
            .select('title slug category excerpt content publishedAt updatedAt');
        res.json(posts);
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// GET /api/blog/all — admin only: all posts including drafts
app.get('/api/blog/all', authenticateToken, async (req, res) => {
    if (req.user.role !== 'trainer' && req.user.role !== 'admin')
        return res.status(403).json({ message: 'Acceso restringido.' });
    try {
        const posts = await BlogPost.find().sort({ createdAt: -1 });
        res.json(posts);
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// GET /api/blog/:slug — public: single full post
app.get('/api/blog/:slug', async (req, res) => {
    try {
        const post = await BlogPost.findOne({ slug: req.params.slug, published: true });
        if (!post) return res.status(404).json({ message: 'Post no encontrado.' });
        res.json(post);
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// POST /api/blog — admin only: create post
app.post('/api/blog', authenticateToken, async (req, res) => {
    if (req.user.role !== 'trainer' && req.user.role !== 'admin')
        return res.status(403).json({ message: 'Acceso restringido.' });
    try {
        const { title, category, excerpt, content, published } = req.body;
        const slug = title.toLowerCase()
            .normalize('NFD').replace(/[̀-ͯ]/g, '')
            .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const uniqueSlug = `${slug}-${Date.now()}`;
        const post = new BlogPost({
            title, slug: uniqueSlug, category: category || 'General',
            excerpt: excerpt || content.slice(0, 160).replace(/\n/g, ' '),
            content, published: !!published,
            publishedAt: published ? new Date() : null,
        });
        await post.save();
        res.status(201).json(post);
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// PATCH /api/blog/:id — admin only: update post
app.patch('/api/blog/:id', authenticateToken, async (req, res) => {
    if (req.user.role !== 'trainer' && req.user.role !== 'admin')
        return res.status(403).json({ message: 'Acceso restringido.' });
    try {
        const { title, category, excerpt, content, published } = req.body;
        const existing = await BlogPost.findById(req.params.id);
        if (!existing) return res.status(404).json({ message: 'Post no encontrado.' });

        const update = { title, category, content, published: !!published };
        if (excerpt !== undefined) update.excerpt = excerpt;
        else if (content) update.excerpt = content.slice(0, 160).replace(/\n/g, ' ');
        // Preserve the ORIGINAL publish date — only stamp it the first time the post
        // goes live. Subsequent edits leave publishedAt untouched (updatedAt auto-bumps
        // via timestamps), so we keep both dates for clarity/honesty.
        if (published && !existing.publishedAt) update.publishedAt = new Date();

        const post = await BlogPost.findByIdAndUpdate(req.params.id, { $set: update }, { new: true });
        res.json(post);
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// DELETE /api/blog/:id — admin only
app.delete('/api/blog/:id', authenticateToken, async (req, res) => {
    if (req.user.role !== 'trainer' && req.user.role !== 'admin')
        return res.status(403).json({ message: 'Acceso restringido.' });
    try {
        await BlogPost.findByIdAndDelete(req.params.id);
        res.json({ message: 'Post eliminado.' });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// ==========================================================================
// --- FALLBACK (must stay last — serves index.html for all unmatched GETs) ---
// ==========================================================================
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`Server running on http://localhost:${PORT}`); });
