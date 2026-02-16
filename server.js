import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import nodemailer from 'nodemailer'; 
import bcrypt from 'bcryptjs';       

// --- CONFIGURATION ---
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
    const adminEmail = 'fitbysuarez@gmail.com';
    try {
        const exists = await mongoose.connection.collection('users').findOne({ email: adminEmail });
        if (!exists) {
            const hashedPassword = await bcrypt.hash('surfac3tens!0N', 10);
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
            console.log('✅ Admin/Trainer account seeded: fitbysuarez@gmail.com');
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
    createdAt: { type: Date, default: Date.now }
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

const ProgramSchema = new mongoose.Schema({
    trainerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    name: { type: String, required: true },
    description: { type: String, default: "" },
    tags: { type: String, default: "General" },
    clientCount: { type: Number, default: 0 },
    weeks: [{ id: Number, days: { type: Object, default: {} } }],
    createdAt: { type: Date, default: Date.now }
});
const Program = mongoose.model('Program', ProgramSchema);

const WorkoutLogSchema = new mongoose.Schema({
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    date: { type: String, required: true }, 
    programName: String,
    exercises: [{ name: String, completed: { type: Boolean, default: false }, notes: String }],
    isComplete: { type: Boolean, default: false }
});
const WorkoutLog = mongoose.model('WorkoutLog', WorkoutLogSchema);


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

// --- Auth ---
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

// --- Clients ---
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

// --- Library ---
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

// --- Programs ---
app.get('/api/programs', async (req, res) => {
    try { const programs = await Program.find().sort({ createdAt: -1 }); res.json(programs); } 
    catch (error) { res.status(500).json({ message: 'Error fetching programs' }); }
});
app.post('/api/programs', async (req, res) => {
    try {
        const { _id, name, description, weeks, tags } = req.body;
        if (_id) { await Program.findByIdAndUpdate(_id, { name, description, weeks, tags }); } 
        else { await new Program({ name, description, weeks, tags }).save(); }
        res.json({ success: true });
    } catch (error) { res.status(500).json({ message: 'Error saving program', error }); }
});
app.delete('/api/programs/:id', async (req, res) => {
    try { await Program.findByIdAndDelete(req.params.id); res.json({ message: 'Program deleted' }); } 
    catch (error) { res.status(500).json({ message: 'Error deleting program' }); }
});

// --- Logs ---
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

// --- FALLBACK ---
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`🚀 Server running on http://localhost:${PORT}`); });