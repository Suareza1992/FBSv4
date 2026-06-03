import js from '@eslint/js';
import globals from 'globals';

export default [
    // Paths ESLint should never look at.
    {
        ignores: [
            'node_modules/**',
            '.git/**',
            '.claude/**',
            '.claire/**',
            'public/output.css',
            'FBS_Playground.mongodb.js', // MongoDB shell script, not app code
        ],
    },

    js.configs.recommended,

    // Shared rules/parser options for all our JS.
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
        },
        rules: {
            // Existing codebase wasn't written under a linter — keep these informative
            // (warnings, non-blocking) and ignore the common harmless cases. Real errors
            // (no-undef, syntax, etc.) still fail the lint so new mistakes stand out.
            'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
            'no-empty': ['warn', { allowEmptyCatch: true }],
            'no-useless-escape': 'warn',      // mostly harmless backslashes in HTML template strings
            'no-useless-assignment': 'warn',  // minor dead-store cleanups
        },
    },

    // Backend — Node.js, ESM.
    {
        files: ['server.js', 'auth-service.js', 'seed-test-client.js', 'middleware/**/*.js'],
        languageOptions: {
            sourceType: 'module',
            globals: {
                ...globals.node,
                fetch: 'readonly',
                AbortController: 'readonly',
                AbortSignal: 'readonly',
            },
        },
    },

    // Frontend — browser SPA loaded via classic <script> tags (not ES modules).
    {
        files: ['public/**/*.js'],
        languageOptions: {
            sourceType: 'script',
            globals: {
                ...globals.browser,
                // Third-party globals loaded from CDNs at runtime.
                Chart: 'readonly',
                ZXing: 'readonly',
                BarcodeDetector: 'readonly',
                // App-wide helpers attached to `window` in app.js and called bare elsewhere.
                showToast: 'readonly',
                showConfirm: 'readonly',
                openClientProfile: 'readonly',
                renderClientsTable: 'readonly',
                renderExerciseLibrary: 'readonly',
                renderTrainerHome: 'readonly',
            },
        },
    },
];
