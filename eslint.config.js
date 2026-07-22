const js = require('@eslint/js');

// Flat config (ESLint 9). Goal: catch the high-signal bugs — undefined variables
// (typos, missing require), unreachable code, obviously-broken control flow —
// without drowning in style noise on a 12k-line legacy codebase. `no-undef` is a
// hard error (it catches real defects); the rest are warnings.
module.exports = [
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'commonjs',
            globals: {
                require: 'readonly', module: 'writable', exports: 'writable', process: 'readonly',
                console: 'readonly', __dirname: 'readonly', __filename: 'readonly', Buffer: 'readonly',
                setTimeout: 'readonly', setInterval: 'readonly', clearTimeout: 'readonly', clearInterval: 'readonly',
                setImmediate: 'readonly', queueMicrotask: 'readonly',
                URL: 'readonly', URLSearchParams: 'readonly', fetch: 'readonly', AbortController: 'readonly',
                TextEncoder: 'readonly', TextDecoder: 'readonly', structuredClone: 'readonly',
            },
        },
        rules: {
            'no-undef': 'error',
            'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
            'no-empty': ['warn', { allowEmptyCatch: true }],
            'no-constant-condition': ['warn', { checkLoops: false }],
            'no-cond-assign': ['error', 'except-parens'],
        },
    },
    { ignores: ['node_modules/**', '.omc/**', 'scratch/**'] },
];
