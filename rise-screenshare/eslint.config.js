'use strict';

const globals = {
  browser: {
    window: 'readonly', document: 'readonly', navigator: 'readonly', location: 'readonly', history: 'readonly',
    localStorage: 'readonly', sessionStorage: 'readonly', crypto: 'readonly', console: 'readonly',
    setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
    fetch: 'readonly', WebSocket: 'readonly', URL: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
    MediaStream: 'readonly', RTCPeerConnection: 'readonly', RTCSessionDescription: 'readonly', RTCIceCandidate: 'readonly',
    Uint8Array: 'readonly', Event: 'readonly', performance: 'readonly', structuredClone: 'readonly'
  },
  node: {
    require: 'readonly', module: 'writable', process: 'readonly', Buffer: 'readonly', __dirname: 'readonly',
    console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
    URL: 'readonly', fetch: 'readonly', WebSocket: 'readonly', structuredClone: 'readonly'
  }
};

const rules = {
  'no-undef': 'error',
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
  'no-redeclare': 'error',
  'no-dupe-keys': 'error',
  'no-unreachable': 'error',
  'eqeqeq': ['error', 'always', { null: 'ignore' }]
};

module.exports = [
  { ignores: ['node_modules/**', 'data/**', 'public/vendor/**', 'public/js/app.orig.js'] },
  { files: ['public/js/**/*.js'], languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: globals.browser }, rules },
  { files: ['public/config.js'], languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: globals.browser }, rules },
  { files: ['server.js', 'lib/**/*.js', 'eslint.config.js'], languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: globals.node }, rules },
  { files: ['test/**/*.mjs'], languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.node, ...globals.browser, AudioContext: 'readonly' } }, rules }
];
