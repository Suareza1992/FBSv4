import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import nodemailer from 'nodemailer';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';                                          // FIX: top-level import instead of require()
import jwt from 'jsonwebtoken';                                       // NEW: JWT for token generation
import { authenticateToken, authorizeRoles } from './middleware/auth.js'; // NEW: auth middleware

// ==========================================================================
// --- CONFIGURATION ---
// ==========================================================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_ME_IN_PRODUCTION'; // NEW: JWT secret from env
const APP_URL = process.env.APP_URL || 'http://localhost:3000';         // NEW: app URL from env

app.use(express.json({ limit: '2mb' }));

// FIX: Configure CORS with allowed origins instead of allowing everything
app.use(cors({
    origin: process.env.CORS_ORIGIN || APP_URL,
    credentials: true
}));

app.use(express.static('public'));

// --- DEBUGGING ---
console.log("Email User:", process.env.GMAIL_USER || "Not Set");
console.log("Email Pass Loaded:", process.env.GMAIL_APP_PASSWORD ? "YES" : "NO");

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
    hideFromDashboard: { type: Boolean, default: false },
    height: { feet: { type: Number, default: 0 }, inches: { type: Number, default: 0 } },
    weight: { type: Number, default: 0 },
    birthday: { type: String, default: "" },
    gender: { type: String, default: "" },
    phone: { type: String, default: "" },
    emailPreferences: { dailyRoutine: { type: Boolean, default: true }, incompleteRoutine: { type: Boolean, default: false } },
    profilePicture: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now },
    resetPasswordToken: String,
    resetPasswordExpires: Date,
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
    date: { type: String, required: true },
    title: { type: String, default: "Workout" },
    warmup: { type: String, default: "" },
    cooldown: { type: String, default: "" },
    exercises: [{
        id: Number,
        name: String,
        instructions: String,
        videoUrl: String,
        isSuperset: { type: Boolean, default: false }
    }],
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});
ClientWorkoutSchema.index({ clientId: 1, date: 1 }, { unique: true });
const ClientWorkout = mongoose.model('ClientWorkout', ClientWorkoutSchema);

const ProgramSchema = new mongoose.Schema({
    name: { type: String, required: true },
    description: { type: String, default: "" },
    tags: { type: String, default: "General" },
    weeks: [{
        weekNumber: Number,
        days: {
            type: Map,
            of: {
                name: String,
                isRest: { type: Boolean, default: false },
                exercises: [{
                    name: String,
                    stats: String,
                    video: String
                }]
            }
        }
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
    clientId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    clientName: { type: String, required: true },
    type: {
        type: String,
        enum: [
            'workout_completed', 'workout_missed',
            'metric_resistance', 'nutrition_logged',
            'progress_photos', 'weight_update',
            'workout_comment', 'video_upload',
            'reported_issue', 'metric_inactivity'
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
    createdAt: { type: Date, default: Date.now }
});
NutritionLogSchema.index({ clientId: 1, date: -1 });
const NutritionLog = mongoose.model('NutritionLog', NutritionLogSchema);

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

// =============================================================================
// 2. API ROUTES
// =============================================================================

// --- Helper: Create email transporter ---
const createEmailTransporter = () => {
    return nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
    });
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
        console.log(`Notification created: ${type} for ${clientName}`);
    } catch (err) {
        console.error('Error creating notification:', err);
    }
};

// ==========================================================================
// --- PUBLIC AUTH ROUTES (No token required) ---
// ==========================================================================

app.post('/api/auth/register', async (req, res) => {
    try {
        const { name, email, password, role } = req.body;
        if (!name || !email || !password) {
            return res.status(400).json({ message: 'Name, email, and password are required' });
        }
        const existingUser = await User.findOne({ email: email.toLowerCase().trim() });
        if (existingUser) return res.status(400).json({ message: 'User already exists' });
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ name, email: email.toLowerCase().trim(), password: hashedPassword, role: role || 'client' });
        await newUser.save();
        res.status(201).json({ message: 'User created', user: { id: newUser._id, name: newUser.name, email: newUser.email, role: newUser.role } });
    } catch (error) { res.status(500).json({ message: 'Server error', error }); }
});

// FIX: Login now returns a JWT token alongside user data
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ message: 'Email and password are required' });
        }

        const user = await User.findOne({ email: email.toLowerCase().trim() });
        if (!user) return res.status(400).json({ message: 'Invalid credentials' });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ message: 'Invalid credentials' });

        // NEW: Generate JWT token
        const tokenPayload = { id: user._id, email: user.email, role: user.role };
        const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '7d' });

        res.json({
            message: 'Login successful',
            token, // NEW: JWT token for the frontend to store
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
    } catch (error) { res.status(500).json({ message: 'Server error', error }); }
});

// ==========================================================================
// --- PASSWORD RECOVERY SYSTEM (Public — no token required) ---
// ==========================================================================

// FIX: Removed require() calls, using top-level imports. Fixed createTransporter typo.
app.post('/api/auth/forgot-password', async (req, res) => {
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
        const transporter = createEmailTransporter();

        const mailOptions = {
            from: `"Coach Suarez" <${process.env.GMAIL_USER}>`,
            to: email,
            subject: 'Recuperacion de Contrasena - FitBySuarez',
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

        await transporter.sendMail(mailOptions);
        console.log(`Password reset email sent to: ${email}`);
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

        if (!newPassword || newPassword.length < 6) {
            return res.status(400).json({ message: 'La contrasena debe tener al menos 6 caracteres' });
        }

        // Hash the incoming token to compare against stored hash
        const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

        const user = await User.findOne({
            resetPasswordToken: hashedToken,
            resetPasswordExpires: { $gt: Date.now() }
        });

        if (!user) {
            return res.status(400).json({ message: 'El enlace de recuperacion es invalido o ha expirado' });
        }

        // FIX: Hash the new password before saving (was plaintext before!)
        user.password = await bcrypt.hash(newPassword, 10);
        user.resetPasswordToken = undefined;
        user.resetPasswordExpires = undefined;
        user.isFirstLogin = false;
        await user.save();

        console.log(`Password reset successful for: ${user.email}`);
        res.json({ message: 'Contrasena actualizada exitosamente' });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({ message: 'Error al actualizar contrasena' });
    }
});

// ==========================================================================
// --- PROTECTED AUTH ROUTES (Token required) ---
// ==========================================================================

// FIX: Now uses req.user.id from JWT instead of trusting userId from body
app.post('/api/auth/update-password', authenticateToken, async (req, res) => {
    try {
        const { newPassword } = req.body;
        if (!newPassword || newPassword.length < 6) {
            return res.status(400).json({ message: 'Password must be at least 6 characters' });
        }
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
    const transporter = createEmailTransporter();

    // FIX: Use APP_URL instead of localhost
    const mailOptions = {
        from: `"Coach Suarez" <${process.env.GMAIL_USER}>`,
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
        await transporter.sendMail(mailOptions);
        console.log(`Email sent to ${email}`);
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

app.put('/api/me', authenticateToken, async (req, res) => {
    try {
        // Only allow safe profile fields to be updated (not role, password, etc.)
        const allowedFields = ['name', 'lastName', 'unitSystem', 'timezone', 'profilePicture'];
        const updates = {};
        for (const key of allowedFields) {
            if (req.body[key] !== undefined) updates[key] = req.body[key];
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

app.get('/api/clients', authenticateToken, authorizeRoles('trainer', 'admin'), async (req, res) => {
    try {
        const clients = await User.find({ role: 'client', isDeleted: { $ne: true } }).sort({ createdAt: -1 });
        res.json(clients);
    } catch (error) { res.status(500).json({ message: 'Error fetching clients' }); }
});

// FIX: Generate random temp password instead of hardcoded "123"
app.post('/api/clients', authenticateToken, authorizeRoles('trainer', 'admin'), async (req, res) => {
    try {
        const clientData = req.body;
        const existing = await User.findOne({ email: clientData.email });
        if (existing) return res.status(400).json({ message: 'El email ya existe' });

        const tempPassword = generateTempPassword(); // NEW: random temp password
        const hashedPassword = await bcrypt.hash(tempPassword, 10);
        const newClient = new User({ ...clientData, password: hashedPassword, isFirstLogin: true, role: 'client' });
        await newClient.save();

        // Return the temp password so the frontend can include it in the welcome email
        res.json({ ...newClient.toObject(), _tempPassword: tempPassword });
    } catch (error) { res.status(500).json({ message: 'Error creating client' }); }
});

app.put('/api/clients/:id', authenticateToken, authorizeRoles('trainer', 'admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        const updatedClient = await User.findByIdAndUpdate(id, updates, { new: true });
        res.json(updatedClient);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/clients/:id', authenticateToken, authorizeRoles('trainer', 'admin'), async (req, res) => {
    try {
        const { id } = req.params;
        console.log(`Deleting Client ID: ${id}`);
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
        const exercise = await Exercise.findOneAndUpdate(
            { name: { $regex: new RegExp(`^${name}$`, 'i') } },
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

app.get('/api/log/:clientId', authenticateToken, async (req, res) => {
    try { const logs = await WorkoutLog.find({ clientId: req.params.clientId }); res.json(logs); }
    catch (e) { res.status(500).json({ message: 'Error fetching logs' }); }
});

// ==========================================================================
// --- PROTECTED: Client-Specific Workouts ---
// ==========================================================================

app.post('/api/client-workouts', authenticateToken, async (req, res) => {
    try {
        const { clientId, date, title, warmup, cooldown, exercises } = req.body;
        const workout = await ClientWorkout.findOneAndUpdate(
            { clientId, date },
            { title, warmup, cooldown, exercises, updatedAt: Date.now() },
            { new: true, upsert: true }
        );
        console.log(`Workout saved for client ${clientId} on ${date}`);

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
    try {
        const { clientId } = req.params;
        const workouts = await ClientWorkout.find({ clientId }).sort({ date: 1 });
        res.json(workouts);
    } catch (error) {
        console.error('Error fetching client workouts:', error);
        res.status(500).json({ message: 'Error fetching workouts', error });
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
    try {
        const logs = await WeightLog.find({ clientId: req.params.clientId }).sort({ date: -1 }).limit(100);
        res.json(logs);
    } catch (e) { res.status(500).json({ message: 'Error fetching weight logs' }); }
});

app.post('/api/weight-logs', authenticateToken, async (req, res) => {
    try {
        const { clientId, date, weight, bodyFat, notes } = req.body;
        const log = await WeightLog.findOneAndUpdate(
            { clientId, date },
            { weight, bodyFat, notes },
            { new: true, upsert: true }
        );
        res.json(log);
    } catch (e) { res.status(500).json({ message: 'Error saving weight log' }); }
});

// ==========================================================================
// --- PROTECTED: Nutrition Logs ---
// ==========================================================================

app.get('/api/nutrition-logs/:clientId', authenticateToken, async (req, res) => {
    try {
        const logs = await NutritionLog.find({ clientId: req.params.clientId }).sort({ date: -1 }).limit(100);
        res.json(logs);
    } catch (e) { res.status(500).json({ message: 'Error fetching nutrition logs' }); }
});

app.post('/api/nutrition-logs', authenticateToken, async (req, res) => {
    try {
        const { clientId, date, calories, protein, carbs, fat, water, notes } = req.body;
        const log = await NutritionLog.findOneAndUpdate(
            { clientId, date },
            { calories, protein, carbs, fat, water, notes },
            { new: true, upsert: true }
        );
        res.json(log);
    } catch (e) { res.status(500).json({ message: 'Error saving nutrition log' }); }
});

// ==========================================================================
// --- PROTECTED: Progress Photos ---
// ==========================================================================

app.get('/api/progress-photos/:clientId', authenticateToken, async (req, res) => {
    try {
        const photos = await ProgressPhoto.find({ clientId: req.params.clientId }).sort({ date: -1 }).limit(50);
        res.json(photos);
    } catch (e) { res.status(500).json({ message: 'Error fetching progress photos' }); }
});

app.post('/api/progress-photos', authenticateToken, async (req, res) => {
    try {
        const { clientId, date, imageData, notes, category } = req.body;
        const photo = new ProgressPhoto({ clientId, date, imageData, notes, category });
        await photo.save();
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
// --- PROTECTED: Programs ---
// ==========================================================================

app.get('/api/programs', authenticateToken, async (req, res) => {
    try {
        const programs = await Program.find().sort({ createdAt: -1 });
        console.log(`Fetched ${programs.length} programs`);
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
        console.log(`Program created: ${name}`);
        res.json(program);
    } catch (error) {
        console.error('Error creating program:', error);
        res.status(500).json({ message: 'Error creating program', error });
    }
});

app.put('/api/programs/:id', authenticateToken, authorizeRoles('trainer', 'admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const updateData = { ...req.body, updatedAt: Date.now() };
        const program = await Program.findByIdAndUpdate(id, updateData, { new: true });
        if (!program) {
            return res.status(404).json({ message: 'Program not found' });
        }
        console.log(`Program updated: ${program.name}`);
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
        console.log(`Program deleted: ${id}`);
        res.json({ message: 'Program deleted' });
    } catch (error) {
        console.error('Error deleting program:', error);
        res.status(500).json({ message: 'Error deleting program', error });
    }
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
        await Notification.findByIdAndUpdate(req.params.id, { isRead: true });
        res.json({ message: 'Marked as read' });
    } catch (error) {
        console.error('Error marking notification as read:', error);
        res.status(500).json({ message: 'Error marking notification as read' });
    }
});

// ==========================================================================
// --- FALLBACK ---
// ==========================================================================
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`Server running on http://localhost:${PORT}`); });
