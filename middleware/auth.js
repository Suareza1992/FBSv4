import jwt from 'jsonwebtoken';

// Read JWT_SECRET at request time (not module load time) because ES module
// imports are hoisted — dotenv.config() in server.js hasn't run yet when
// this module is first evaluated, so process.env.JWT_SECRET would be undefined.
const getJwtSecret = () => process.env.JWT_SECRET || 'CHANGE_ME_IN_PRODUCTION';

// ── Deactivated clients ──────────────────────────────────────────────────────
// A deactivated client can still LOG IN — they must be able to reach the payments
// view and pay to be switched back on — but the API refuses everything else. The gate
// lives here, inside authenticateToken, rather than on individual routes, so a route
// added next year is closed to them by default instead of open until someone remembers.
//
// server.js registers the lookup (this file cannot import the User model without a
// circular import). Answers are cached for a few seconds so a client's burst of
// requests costs one extra read, not one per request; flipping isActive clears it.
const INACTIVE_ALLOWED = new Set([
    'GET /api/me',              // who am I — also how the UI learns it is locked
    'GET /api/payments/mine',   // my invoices, so I can pay them
]);
const GATE_TTL_MS = 15_000;
const gateCache = new Map();    // userId -> { inactive: boolean, exp: number }
let isClientInactive = null;    // async (userId) => boolean

export function setAccountGate(fn) { isClientInactive = fn; }
export function clearAccountGateCache(userId) {
    if (userId === undefined) gateCache.clear(); else gateCache.delete(String(userId));
}

async function clientIsInactive(userId) {
    const key = String(userId);
    const hit = gateCache.get(key);
    if (hit && hit.exp > Date.now()) return hit.inactive;
    const inactive = !!(await isClientInactive(key));
    gateCache.set(key, { inactive, exp: Date.now() + GATE_TTL_MS });
    return inactive;
}

/**
 * Middleware: Verifies the JWT token from the Authorization header.
 * If valid, attaches the decoded user ({ id, email, role }) to req.user.
 * If missing or invalid, returns 401. A deactivated client gets 403
 * { code: 'ACCOUNT_INACTIVE' } on everything outside INACTIVE_ALLOWED.
 */
export async function authenticateToken(req, res, next) {
    // H-2: Prefer the HttpOnly cookie; fall back to Authorization header for API clients
    const token = req.cookies?.auth_token
        || (req.headers['authorization']?.split(' ')[1]);

    if (!token) {
        return res.status(401).json({ message: 'Access denied. No token provided.' });
    }

    let decoded;
    try {
        decoded = jwt.verify(token, getJwtSecret());
    } catch (err) {
        return res.status(401).json({ message: 'Invalid or expired token.' });
    }
    req.user = decoded; // { id, email, role }

    if (decoded.role === 'client' && isClientInactive) {
        const path = req.originalUrl.split('?')[0].replace(/\/+$/, '');
        if (!INACTIVE_ALLOWED.has(`${req.method} ${path}`)) {
            try {
                if (await clientIsInactive(decoded.id)) {
                    return res.status(403).json({
                        code: 'ACCOUNT_INACTIVE',
                        message: 'Your account is inactive. Please contact your trainer to regain access.',
                    });
                }
            } catch (err) {
                // Fail closed: if we cannot tell, do not hand a possibly-deactivated
                // account the whole API. Every handler needs the database anyway.
                return res.status(503).json({ message: 'Service temporarily unavailable.' });
            }
        }
    }
    next();
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
