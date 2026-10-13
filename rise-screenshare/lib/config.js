'use strict';

const path = require('node:path');

const num = (v, def, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n) || v === undefined || v === '') return def;
  return Math.min(max, Math.max(min, n));
};
const list = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
const flag = v => ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase());

/** Lê a configuração das variáveis de ambiente (todas opcionais). */
function fromEnv(env = process.env) {
  const root = path.resolve(__dirname, '..');
  return {
    port: num(env.PORT, 4173, 0, 65535),
    host: env.HOST || '0.0.0.0',
    publicDir: path.join(root, 'public'),
    dataFile: env.DATA_FILE ? path.resolve(env.DATA_FILE) : path.join(root, 'data', 'data.json'),

    roomTtlHours: num(env.ROOM_TTL_HOURS, 3, 1, 24),
    maxRooms: num(env.MAX_ROOMS, 500, 1, 100000),
    maxParticipants: num(env.MAX_PARTICIPANTS, 50, 2, 500),

    // true quando há proxy reverso na frente (Caddy/nginx): usa X-Forwarded-For para o IP real
    trustProxy: flag(env.TRUST_PROXY),
    // origens extras aceitas no WebSocket (a própria origem do site já é aceita)
    allowedOrigins: list(env.ALLOWED_ORIGINS),

    // TLS embutido (opcional; o normal é terminar TLS num proxy)
    tlsCert: env.TLS_CERT || '',
    tlsKey: env.TLS_KEY || '',

    stunUrls: list(env.STUN_URLS).length ? list(env.STUN_URLS) : ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
    turnUrls: list(env.TURN_URLS),
    turnSecret: env.TURN_SECRET || '',
    turnUsername: env.TURN_USERNAME || '',
    turnCredential: env.TURN_CREDENTIAL || '',

    maxConnPerIp: num(env.MAX_CONN_PER_IP, 25, 1, 10000),
    // multiplicador dos limites de taxa (os testes usam um valor alto)
    rateScale: num(env.RATE_SCALE, 1, 0.01, 10000)
  };
}

module.exports = { fromEnv };
