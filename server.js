import dotenv from 'dotenv';
dotenv.config();
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

// ==========================================================================
// --- CONFIGURATION ---
// ==========================================================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_ME_IN_PRODUCTION'; // NEW: JWT secret from env
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
            imgSrc:     ["'self'", "data:", "blob:", "https://images.unsplash.com", "https://i.pravatar.cc",
                         "https://img.youtube.com", "https://i.ytimg.com", "https://*.ytimg.com"], // YouTube thumbnails
            fontSrc:    ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            connectSrc: ["'self'", "https://api.nal.usda.gov", "https://cdn.jsdelivr.net"],
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
    console.log("Email User:", process.env.GMAIL_USER || "Not Set");
    console.log("Email Pass Loaded:", process.env.GMAIL_APP_PASSWORD ? "YES" : "NO");
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
    group: { type: String, default: "General" },
    type: { type: String, default: "Remoto" },
    dueDate: { type: String, default: "" },
    isActive: { type: Boolean, default: true },
    isFirstLogin: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },
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
    injuredMuscles: { type: mongoose.Schema.Types.Mixed, default: {} },
    macroSettings: {
        goal:         { type: String, default: 'maintain' }, // maintain | cut250 | cut500 | bulk250 | bulk500
        proteinRatio: { type: Number, default: 0.4 },
        fatRatio:     { type: Number, default: 0.3 },
        carbRatio:    { type: Number, default: 0.3 }
    },
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
            'contact_inquiry'
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
    createdAt: { type: Date, default: Date.now }
});
NutritionLogSchema.index({ clientId: 1, date: -1 });
const NutritionLog = mongoose.model('NutritionLog', NutritionLogSchema);

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
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: String, required: true },
    imageData: { type: String, required: true },
    notes: { type: String, default: '' },
    category: { type: String, default: 'general' },
    createdAt: { type: Date, default: Date.now }
});
ProgressPhotoSchema.index({ clientId: 1, date: -1 });
const ProgressPhoto = mongoose.model('ProgressPhoto', ProgressPhotoSchema);

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
});
PaymentSchema.index({ trainerId: 1, dueDate: -1 });
const Payment = mongoose.model('Payment', PaymentSchema);

// =============================================================================
// 2. API ROUTES
// =============================================================================

// --- Helper: Send email via Resend API ---
const sendEmail = async ({ from, to, subject, html, text }) => {
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
            ...(text ? { text } : {})
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
        if (!email || !password) {
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
        res.json(user);
    } catch (error) {
        console.error('Error fetching profile:', error);
        res.status(500).json({ message: 'Error fetching profile' });
    }
});

// H-7: Whitelist of allowed image data URI prefixes (no SVG — it can contain scripts)
const ALLOWED_IMAGE_PREFIXES = ['data:image/jpeg;base64,', 'data:image/jpg;base64,', 'data:image/png;base64,', 'data:image/gif;base64,', 'data:image/webp;base64,'];
const isValidImageData = (data) => typeof data === 'string' && ALLOWED_IMAGE_PREFIXES.some(p => data.startsWith(p));
// 5 MB max for Base64 images (5 * 1024 * 1024 * (4/3) ≈ 6.9 MB in Base64)
const MAX_IMAGE_B64_LEN = 7_000_000;

app.put('/api/me', authenticateToken, async (req, res) => {
    try {
        // H-7: Validate profile picture MIME type before saving
        if (req.body.profilePicture) {
            if (!isValidImageData(req.body.profilePicture) || req.body.profilePicture.length > MAX_IMAGE_B64_LEN) {
                return res.status(400).json({ message: 'Formato de imagen no válido.' });
            }
        }
        // Safe profile fields any authenticated user can update
        const allowedFields = ['name', 'lastName', 'unitSystem', 'timezone', 'profilePicture', 'servingUnit', 'injuredMuscles'];
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
        res.json(user);
    } catch (error) {
        console.error('Error updating profile:', error);
        res.status(500).json({ message: 'Error updating profile' });
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
                         'profilePicture','equipment','macroSettings','waterGoal','injuredMuscles'];
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
        const { name, videoUrl, category } = req.body;
        // H-3: Escape regex metacharacters to prevent ReDoS
        const safeName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const exercise = await Exercise.findOneAndUpdate(
            { name: { $regex: new RegExp(`^${safeName}$`, 'i') } },
            { name, videoUrl, category, lastUpdated: Date.now() },
            { new: true, upsert: true }
        );
        res.json(exercise);
    } catch (error) { res.status(500).json({ message: 'Error saving exercise' }); }
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
        } = req.body;
        const workout = await ClientWorkout.findOneAndUpdate(
            { clientId, date },
            {
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
            },
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

        const workout = await ClientWorkout.findOneAndUpdate(
            { clientId, date },
            { $set: { ...req.body, updatedAt: Date.now() } },
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
        const { clientId, date, calories, protein, carbs, fat, water, notes, mood, meals } = req.body;
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
        const log = await NutritionLog.findOneAndUpdate(
            { clientId, date },
            { $set: updateFields },
            { new: true, upsert: true }
        );

        // Notify trainer when client logs nutrition
        if (req.user.role === 'client') {
            const client = await User.findById(clientId);
            if (client) {
                await createNotification({
                    clientId: client._id,
                    clientName: `${client.name} ${client.lastName || ''}`.trim(),
                    type: 'nutrition_logged',
                    title: `registró su nutrición`,
                    message: `${calories} cal | P:${protein}g C:${carbs}g F:${fat}g - ${date}`,
                    data: { date, calories, protein, carbs, fat }
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
            from: `"${trainerName}" <${process.env.GMAIL_USER}>`,
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
        res.json(photos);
    } catch (e) { res.status(500).json({ message: 'Error fetching progress photos' }); }
});

app.post('/api/progress-photos', authenticateToken, async (req, res) => {
    if (!assertOwnership(req, res, req.body.clientId)) return;
    try {
        const { clientId, date, imageData, notes, category } = req.body;
        // H-7: Validate image MIME type and size server-side
        if (!isValidImageData(imageData) || imageData.length > MAX_IMAGE_B64_LEN) {
            return res.status(400).json({ message: 'Formato de imagen no válido.' });
        }
        const photo = new ProgressPhoto({ clientId, date, imageData, notes, category });
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
    } catch (e) { res.status(500).json({ message: 'Error saving progress photo' }); }
});

app.delete('/api/progress-photos/:id', authenticateToken, authorizeRoles('trainer', 'admin'), async (req, res) => {
    try {
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
    { name: 'Aceite de oliva',       brand: null, serving: 14,  cal100: 884, p100: 0.0,  c100: 0.0,  f100: 100.0},
    { name: 'Vinagre de manzana',    brand: null, serving: 15,  cal100: 21,  p100: 0.0,  c100: 0.9,  f100: 0.0  },
    { name: 'Crema agria',           brand: null, serving: 30,  cal100: 193, p100: 2.1,  c100: 4.4,  f100: 19.0 },
    { name: 'Guacamole',             brand: null, serving: 30,  cal100: 157, p100: 1.9,  c100: 8.6,  f100: 14.0 },
    { name: 'Hummus',                brand: null, serving: 30,  cal100: 166, p100: 8.0,  c100: 14.0, f100: 10.0 },
    { name: 'Mermelada / Jelly',     brand: null, serving: 20,  cal100: 250, p100: 0.4,  c100: 65.0, f100: 0.1  },
    { name: 'Miel',                  brand: null, serving: 21,  cal100: 304, p100: 0.3,  c100: 82.0, f100: 0.0  },
    { name: 'Syrup / Jarabe de maple',brand:null,  serving: 30,  cal100: 261, p100: 0.0,  c100: 67.0, f100: 0.1  },
    { name: 'Crema de cacahuate (PB)',brand:null,  serving: 32,  cal100: 588, p100: 25.0, c100: 20.0, f100: 50.0 },
    { name: 'Nutella / Hazelnut spread',brand:null,serving: 15, cal100: 539, p100: 6.3,  c100: 57.5, f100: 30.9 },
];

// Normalize: remove accents so "huevo" matches "Huevo", "proteína" matches "proteina", etc.
function normalizeStr(s) {
    return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function searchLocalFoods(q) {
    const normQ = normalizeStr(q);
    const terms = normQ.split(/\s+/).filter(Boolean);
    const scored = LOCAL_FOODS
        .map(f => {
            const hay = normalizeStr(f.name + ' ' + (f.brand || ''));
            const matches = terms.every(t => hay.includes(t));
            if (!matches) return null;
            // Score: starts-with match ranks higher
            const score = hay.startsWith(normQ) ? 2 : (hay.includes(normQ) ? 1 : 0);
            return { food: f, score };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);
    return scored.map(s => s.food).slice(0, 8);
}

app.get('/api/food-search', authenticateToken, async (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json([]);

    const localMatches = searchLocalFoods(q);

    // If local database has good coverage, return immediately — no external API needed
    if (localMatches.length >= 4) {
        return res.json(localMatches);
    }

    // Supplement with USDA FoodData Central for English brand/food names
    try {
        const usdaKey = process.env.USDA_API_KEY;
        if (!usdaKey) throw new Error('USDA_API_KEY is not set in environment variables.');
        const url = `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${usdaKey}&query=${encodeURIComponent(q)}&pageSize=10&dataType=Foundation,SR%20Legacy&nutrients=1008,1003,1005,1004`;
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
        const data = await r.json();
        const apiResults = (data.foods || [])
            .filter(f => f.description?.trim())
            .map(f => {
                const get = (id) => f.foodNutrients?.find(n => n.nutrientId === id)?.value || 0;
                return {
                    name:    f.description,
                    brand:   null,
                    serving: 100,
                    cal100:  Math.round(get(1008)),
                    p100:    parseFloat(get(1003).toFixed(1)),
                    c100:    parseFloat(get(1005).toFixed(1)),
                    f100:    parseFloat(get(1004).toFixed(1)),
                };
            })
            .filter(f => f.cal100 > 0)
            .slice(0, 10);

        const localNames = new Set(localMatches.map(f => normalizeStr(f.name)));
        const merged = [
            ...localMatches,
            ...apiResults.filter(f => !localNames.has(normalizeStr(f.name)))
        ].slice(0, 12);
        res.json(merged);
    } catch (e) {
        console.error('Food search API error:', e.message, '— returning local results only');
        if (localMatches.length > 0) return res.json(localMatches);
        res.status(502).json({ error: 'Food search unavailable. Use manual entry.' });
    }
});

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

        res.json(program);
    } catch (error) {
        console.error('Error updating program:', error);
        res.status(500).json({ message: 'Error updating program', error });
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
        const notifications = await Notification.find({ trainerId: req.user.id })
            .sort({ createdAt: -1 })
            .limit(50);
        res.json(notifications);
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
        await User.findByIdAndUpdate(req.user.id, { equipment });
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
// --- FALLBACK ---
// ==========================================================================
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`Server running on http://localhost:${PORT}`); });
