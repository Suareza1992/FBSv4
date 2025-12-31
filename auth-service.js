import mongoose from 'mongoose';
import bcrypt from 'bcrypt';

// Define the User Schema for MongoDB
const UserSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true },
    role: { type: String, default: 'trainer' },
    created: { type: Date, default: Date.now }
});

// Method to verify password on login
UserSchema.methods.comparePassword = function(password) {
    return bcrypt.compare(password, this.passwordHash);
};

const User = mongoose.model('User', UserSchema);

// --- User Registration ---
async function registerUser(name, email, password) {
    // 1. Check if user already exists
    if (await User.findOne({ email })) {
        throw new Error('User already exists');
    }

    // 2. Hash the password (cost 10)
    const passwordHash = await bcrypt.hash(password, 10);

    // 3. Create and save the new user
    const newUser = new User({
        name,
        email,
        passwordHash,
        role: 'trainer' // Hardcode trainer role
    });

    await newUser.save();
    
    // Return safe user data (without hash)
    return {
        id: newUser._id,
        name: newUser.name,
        email: newUser.email,
        role: newUser.role
    };
}

// --- User Login ---
async function loginUser(email, password) {
    const user = await User.findOne({ email });

    if (!user) {
        throw new Error('User not found');
    }

    const isMatch = await user.comparePassword(password);

    if (!isMatch) {
        throw new Error('Invalid credentials');
    }

    // Return safe user data
    return {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role
    };
}

// 💥 FIX: Exporting the functions via default export object 💥
export default {
    registerUser,
    loginUser
};