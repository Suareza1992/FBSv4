import jwt from 'jsonwebtoken';

// Read JWT_SECRET at request time (not module load time) because ES module
// imports are hoisted — dotenv.config() in server.js hasn't run yet when
// this module is first evaluated, so process.env.JWT_SECRET would be undefined.
const getJwtSecret = () => process.env.JWT_SECRET || 'CHANGE_ME_IN_PRODUCTION';

/**
 * Middleware: Verifies the JWT token from the Authorization header.
 * If valid, attaches the decoded user ({ id, email, role }) to req.user.
 * If missing or invalid, returns 401.
 */
export function authenticateToken(req, res, next) {
    // H-2: Prefer the HttpOnly cookie; fall back to Authorization header for API clients
    const token = req.cookies?.auth_token
        || (req.headers['authorization']?.split(' ')[1]);

    if (!token) {
        return res.status(401).json({ message: 'Access denied. No token provided.' });
    }

    try {
        const decoded = jwt.verify(token, getJwtSecret());
        req.user = decoded; // { id, email, role }
        next();
    } catch (err) {
        return res.status(401).json({ message: 'Invalid or expired token.' });
    }
}

/**
 * Middleware Factory: Restricts access to users with specific roles.
 * Usage: authorizeRoles('trainer', 'admin')
 */
export function authorizeRoles(...roles) {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({ message: 'Insufficient permissions.' });
        }
        next();
    };
}
