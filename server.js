import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import nodemailer from 'nodemailer';
import bcrypt from 'bcryptjs';
import { resourceLimits } from 'worker_threads';
// ==========================================================================
// --- CONFIGURATION ---
// ==========================================================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));
// --- DEBUGGING ---
console.log("📧 Email User:", process.env.GMAIL_USER || "Not Set");
console.log("🔑 Email Pass Loaded:", process.env.GMAIL_APP_PASSWORD ? "YES" : "NO");
// --- MONGODB CONNECTION ---
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/fitbysuarez')
.then(async () => {
    console.log('✅ MongoDB Conectado');
await seedAdmin();
})
.catch(err => console.error('❌ Error de MongoDB:', err));
// --- SEED ADMIN/TRAINER ACCOUNT ---
async function seedAdmin() {
    const adminEmail = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminEmail || !adminPassword) {
        console.log('⚠️  ADMIN_EMAIL or ADMIN_PASSWORD not set in .env — skipping seed.');
        return;
    }
    try {
        const exists = await mongoose.connection.collection('users').findOne({ email: adminEmail });
        if (!exists) {
            const hashedPassword = await bcrypt.hash(adminPassword, 10);
            await mongoose.connection.collection('users').insertOne({
                name: 'Coach Suárez',
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
            console.log(`✅ Admin/Trainer account seeded: ${adminEmail}`);
        } else {
            console.log('ℹ️  Admin/Trainer account already exists — skipping seed.');
        }
    } catch (err) {
        console.error('❌ Error seeding admin:', err);
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
    createdAt: { type: Date, default: Date.now },
    resetPasswordToken: String,
    resetPasswordExpires: Date,
});
const User = mongoose.model('User', UserSchema);
// 🟢 UPDATED: category is now an Array of Strings
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
// Compound index to ensure one workout per client per date
ClientWorkoutSchema.index({ clientId: 1, date: 1 }, { unique: true });
const ClientWorkout = mongoose.model('ClientWorkout', ClientWorkoutSchema);
// PROGRAM SCHEMA (Templates/Routines)
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
// =============================================================================
// 2. API ROUTES
// =============================================================================
app.post('/api/send-welcome', async (req, res) => {
const { email, name, password } = req.body;
const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: 'fitbysuarez@gmail.com', pass: process.env.GMAIL_APP_PASSWORD }
    });
const mailOptions = {
        from: '"Coach Suárez" <fitbysuarez@gmail.com>',
        to: email,
        subject: 'Bienvenido a FitBySuárez 🏋️‍♂️',
        text: `Hola ${name},\n\nTu cuenta ha sido creada.\nAccede: http://localhost:3000\nUsuario: ${email}\nContraseña: ${password}`,
        html: `<div style="font-family: Arial, sans-serif; padding: 20px;"><h2>Bienvenido!</h2><p>Hola ${name},</p><p>Usuario: ${email}<br>Password: ${password}</p><a href="http://localhost:3000">Ir a la App</a></div>`
    };
try {
await transporter.sendMail(mailOptions);
        console.log(`✅ Email sent to ${email}`);
        res.status(200).json({ success: true, message: 'Email sent' });
    } catch (error) {
        console.error("❌ Email Error:", error);
        res.status(500).json({ success: false, message: 'Failed to send email', error: error.toString() });
    }
});
// ==========================================================================
// --- Auth ---
// ==========================================================================
app.post('/api/auth/register', async (req, res) => {
try {
const { name, email, password, role } = req.body;
const existingUser = await User.findOne({ email });
if (existingUser) return res.status(400).json({ message: 'User already exists' });
const hashedPassword = await bcrypt.hash(password, 10);
const newUser = new User({ name, email, password: hashedPassword, role: role || 'client' });
await newUser.save();
        res.status(201).json({ message: 'User created', user: { id: newUser._id, name: newUser.name, email: newUser.email, role: newUser.role } });
    } catch (error) { res.status(500).json({ message: 'Server error', error }); }
});
app.post('/api/auth/login', async (req, res) => {
try {
const { email, password } = req.body;
const user = await User.findOne({ email });
if (!user) return res.status(400).json({ message: 'Invalid credentials' });
const isMatch = await bcrypt.compare(password, user.password);
if (!isMatch) return res.status(400).json({ message: 'Invalid credentials' });
        res.json({ message: 'Login successful', user: { id: user._id, name: user.name, lastName: user.lastName, email: user.email, role: user.role, isFirstLogin: user.isFirstLogin } });
    } catch (error) { res.status(500).json({ message: 'Server error', error }); }
});
app.post('/api/auth/update-password', async (req, res) => {
try {
const { userId, newPassword } = req.body;
const hashedPassword = await bcrypt.hash(newPassword, 10);
await User.findByIdAndUpdate(userId, { password: hashedPassword, isFirstLogin: false });
        res.json({ message: 'Password updated successfully' });
    } catch (error) { res.status(500).json({ message: 'Error updating password' }); }
});
// ==========================================================================
// --- PASSWORD RECOVERY SYSTEM ---
// ==========================================================================
app.post('/api/auth/forgot-password', async (req, res) => {
try {
const { email } = req.body;
const user = await User.findOne({ email: email.toLowerCase() });
if (!user) {
return res.json({ message: 'Si existe una cuenta con ese email, recibirás un enlace de recuperación.' });
        }
const crypto = require('crypto');
const resetToken = crypto.randomBytes(32).toString('hex');
const resetTokenExpiry = Date.now() + 3600000; // 1 hour
        user.resetPasswordToken = resetToken;
        user.resetPasswordExpires = resetTokenExpiry;
await user.save();
const resetLink = `${req.protocol}://${req.get('host')}/?token=${resetToken}`;
const nodemailer = require('nodemailer');
const transporter = nodemailer.createTransporter({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASSWORD
            }
        });
const mailOptions = {
            from: process.env.EMAIL_USER,
            to: email,
            subject: 'Recuperación de Contraseña - FitBySuárez',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                    <div style="text-align: center; margin-bottom: 30px;">
                        <h1 style="color: #5e2d91; margin: 0;">FitBySuárez</h1>
                    </div>
                    <div style="background: #f9fafb; border-radius: 10px; padding: 30px;">
                        <h2 style="color: #111827; margin-top: 0;">Recuperación de Contraseña</h2>
                        <p style="color: #4b5563; line-height: 1.6;">Hola ${user.name},</p>
                        <p style="color: #4b5563; line-height: 1.6;">Recibimos una solicitud para restablecer tu contraseña. Haz clic en el botón de abajo para crear una nueva contraseña:</p>
                        <div style="text-align: center; margin: 30px 0;">
                            <a href="${resetLink}" style="display: inline-block; background: linear-gradient(to right, #5e2d91, #3b82f6); color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: bold;">Restablecer Contraseña</a>
                        </div>
                        <p style="color: #6b7280; font-size: 14px; line-height: 1.6;">O copia y pega este enlace en tu navegador:</p>
                        <p style="color: #3b82f6; word-break: break-all; font-size: 12px; background: white; padding: 10px; border-radius: 5px;">${resetLink}</p>
                        <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
                            <p style="color: #ef4444; font-size: 14px; margin: 0;">⏰ Este enlace expira en 1 hora</p>
                        </div>
                        <p style="color: #6b7280; font-size: 14px; margin-top: 20px;">Si no solicitaste restablecer tu contraseña, ignora este email.</p>
                    </div>
                    <div style="text-align: center; margin-top: 30px; color: #9ca3af; font-size: 12px;">
                        <p>FitBySuárez - Tu plataforma de entrenamiento personalizado</p>
                    </div>
                </div>
            `
        };
await transporter.sendMail(mailOptions);
        console.log(`✅ Password reset email sent to: ${email}`);
        res.json({ message: 'Enlace de recuperación enviado a tu email' });
    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({ message: 'Error al procesar solicitud' });
    }
});
app.post('/api/auth/reset-password', async (req, res) => {
try {
const { token, newPassword } = req.body;
const user = await User.findOne({
            resetPasswordToken: token,
            resetPasswordExpires: { $gt: Date.now() }
        });
if (!user) {
return res.status(400).json({ message: 'El enlace de recuperación es inválido o ha expirado' });
        }
        user.password = newPassword;
        user.resetPasswordToken = undefined;
        user.resetPasswordExpires = undefined;
        user.isFirstLogin = false;
await user.save();
        console.log(`✅ Password reset successful for: ${user.email}`);
        res.json({ message: 'Contraseña actualizada exitosamente' });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({ message: 'Error al actualizar contraseña' });
    }
});
// ==========================================================================
// --- Trainers ---
// ==========================================================================
app.get('/api/trainers', async (req, res) => {
    try {
        const trainers = await User.find({ role: 'trainer', isDeleted: { $ne: true } }).sort({ createdAt: -1 });
        res.json(trainers.map(t => ({ _id: t._id, name: t.name, lastName: t.lastName, email: t.email, isActive: t.isActive, createdAt: t.createdAt })));
    } catch (error) { res.status(500).json({ message: 'Error fetching trainers' }); }
});
app.post('/api/trainers', async (req, res) => {
    try {
        const { name, lastName, email, password } = req.body;
        if (!name || !email || !password) return res.status(400).json({ message: 'Nombre, email y contraseña son requeridos' });
        const existing = await User.findOne({ email });
        if (existing) return res.status(400).json({ message: 'El email ya existe' });
        const hashedPassword = await bcrypt.hash(password, 10);
        const newTrainer = new User({ name, lastName: lastName || '', email, password: hashedPassword, role: 'trainer', isFirstLogin: false });
        await newTrainer.save();
        res.status(201).json({ message: 'Trainer creado', trainer: { _id: newTrainer._id, name: newTrainer.name, email: newTrainer.email } });
    } catch (error) { res.status(500).json({ message: 'Error creating trainer', error }); }
});
app.delete('/api/trainers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const trainer = await User.findById(id);
        if (!trainer || trainer.role !== 'trainer') return res.status(404).json({ message: 'Trainer not found' });
        await User.findByIdAndUpdate(id, { isDeleted: true });
        res.json({ message: 'Trainer eliminado' });
    } catch (error) { res.status(500).json({ message: 'Error deleting trainer', error }); }
});
// ==========================================================================
// --- Clients ---
// ==========================================================================
app.get('/api/clients', async (req, res) => {
try {
const clients = await User.find({ role: 'client', isDeleted: { $ne: true } }).sort({ createdAt: -1 });
        res.json(clients);
    } catch (error) { res.status(500).json({ message: 'Error fetching clients' }); }
});
app.post('/api/clients', async (req, res) => {
try {
const clientData = req.body;
const existing = await User.findOne({ email: clientData.email });
if (existing) return res.status(400).json({ message: 'El email ya existe' });
const hashedPassword = await bcrypt.hash("123", 10);
const newClient = new User({ ...clientData, password: hashedPassword, isFirstLogin: true, role: 'client' });
await newClient.save();
        res.json(newClient);
    } catch (error) { res.status(500).json({ message: 'Error creating client' }); }
});
app.put('/api/clients/:id', async (req, res) => {
try {
const { id } = req.params;
const updates = req.body;
const updatedClient = await User.findByIdAndUpdate(id, updates, { new: true });
        res.json(updatedClient);
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/clients/:id', async (req, res) => {
try {
const { id } = req.params;
        console.log(`🗑️ Deleting Client ID: ${id}`);
const deleted = await User.findByIdAndUpdate(id, { isDeleted: true });
if(!deleted) return res.status(404).json({ message: "Client not found" });
        res.json({ message: "Client deleted successfully" });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});
// ==========================================================================
// --- Library ---
// ==========================================================================
app.get('/api/library', async (req, res) => {
try { const exercises = await Exercise.find().sort({ name: 1 }); res.json(exercises); }
catch (error) { res.status(500).json({ message: 'Error fetching library' }); }
});
app.post('/api/library', async (req, res) => {
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
// --- Logs ---
// ==========================================================================
app.post('/api/log', async (req, res) => {
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
app.get('/api/log/:clientId', async (req, res) => {
try { const logs = await WorkoutLog.find({ clientId: req.params.clientId }); res.json(logs); }
catch (e) { res.status(500).json({ message: 'Error fetching logs' }); }
});
// ==========================================================================
// --- Client-Specific Workouts (PERSISTENT!) ---
// ==========================================================================
// CREATE or UPDATE a client workout
app.post('/api/client-workouts', async (req, res) => {
try {
const { clientId, date, title, warmup, cooldown, exercises } = req.body;
// Use upsert to create or update
const workout = await ClientWorkout.findOneAndUpdate(
            { clientId, date }, // Find by client + date
            {
                title,
                warmup,
                cooldown,
                exercises,
                updatedAt: Date.now()
            },
            {
                new: true, // Return updated doc
                upsert: true // Create if doesn't exist
            }
        );
        console.log(`✅ Workout saved for client ${clientId} on ${date}`);
        res.json(workout);
    } catch (error) {
        console.error('Error saving workout:', error);
        res.status(500).json({ message: 'Error saving workout', error });
    }
});
// GET a specific workout by client + date
app.get('/api/client-workouts/:clientId/:date', async (req, res) => {
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
// GET ALL workouts for a client (for calendar population)
app.get('/api/client-workouts/:clientId', async (req, res) => {
try {
const { clientId } = req.params;
const workouts = await ClientWorkout.find({ clientId }).sort({ date: 1 });
        res.json(workouts);
    } catch (error) {
        console.error('Error fetching client workouts:', error);
        res.status(500).json({ message: 'Error fetching workouts', error });
    }
});
// DELETE a workout
app.delete('/api/client-workouts/:clientId/:date', async (req, res) => {
try {
const { clientId, date } = req.params;
await ClientWorkout.findOneAndDelete({ clientId, date });
        res.json({ message: 'Workout deleted' });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting workout', error });
    }
});
// ==========================================================================
// --- PROGRAMS (PERSISTENT) ---
// ==========================================================================
// GET all programs
app.get('/api/programs', async (req, res) => {
try {
const programs = await Program.find().sort({ createdAt: -1 });
        console.log(`✅ Fetched ${programs.length} programs`);
        res.json(programs);
    } catch (error) {
        console.error('Error fetching programs:', error);
        res.status(500).json({ message: 'Error fetching programs', error});
    }
});
// CREATE new program
app.post('/api/programs', async (req, res) => {
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
        console.log(`✅ Program created: ${name}`);
        res.json(program);
    } catch (error) {
        console.error('Error creating program:', error);
        res.status(500).json({ message: 'Error creating program', error });
    }
});
// UPDATE program
app.put('/api/programs/:id', async (req, res) => {
try {
const { id } = req.params;
const updateData = { ...req.body, updatedAt: Date.now() };
const program = await Program.findByIdAndUpdate(id, updateData, { new: true });
if (!program) {
return res.status(404).json({ message: 'Program not found' });
        }
        console.log(`✅ Program updated: ${program.name}`);
        res.json(program);
    } catch (error) {
        console.error('Error updating program:', error);
        res.status(500).json({ message: 'Error updating program', error });
    }
});
// DELETE program
app.delete('/api/programs/:id', async (req, res) => {
try {
const { id } = req.params;
await Program.findByIdAndDelete(id);
        console.log(`✅ Program deleted: ${id}`);
        res.json({ message: 'Program deleted' });
    } catch (error) {
        console.error('Error deleting program:', error);
        res.status(500).json({ message: 'Error deleting program', error });
    }
});
// ==========================================================================
// --- FALLBACK ---
// ==========================================================================
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`🚀 Server running on http://localhost:${PORT}`); });
