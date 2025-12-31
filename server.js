import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import AuthService from './auth-service.js'; // Imports the default object
const { registerUser, loginUser } = AuthService; // Destructures the functions

const app = express();
const PORT = 3000;
const MONGODB_URI = 'mongodb://localhost:27017/fitbysuarez_db'; // <<< CHANGE THIS to your Atlas URI

// Middleware
app.use(cors()); // Allows frontend to make requests
app.use(express.json()); // Parses incoming JSON data

// API Endpoints
app.post('/api/auth/register', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        const user = await registerUser(name, email, password);
        res.status(201).json({ user, message: 'Registration successful' });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await loginUser(email, password);
        res.status(200).json({ user, message: 'Login successful' });
    } catch (error) {
        res.status(401).json({ message: 'Invalid email or password.' });
    }
});

// Serve frontend files (assuming they are in the same directory)
app.use(express.static('./')); 


// Connect to MongoDB and start server
mongoose.connect(MONGODB_URI)
    .then(() => {
        console.log('MongoDB connected successfully.');
        app.listen(PORT, () => {
            console.log(`Server running at http://localhost:${PORT}`);
            console.log(`Open http://localhost:${PORT}/index.html to view the app.`);
        });
    })
    .catch(err => {
        console.error('MongoDB connection error:', err);
        process.exit(1);
    });