'use strict';

/*
  Servidor HTTP: arquivos estáticos (só de public/), RPCs de sala e upgrade do WebSocket.
*/

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { Store } = require('./store');
const { Hub } = require('./hub');
const { iceServers } = require('./ice');
const { RateLimiter, clientIp, deriveSecret, verifySecret, isClientHash, CODE_RE } = require('./security');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const cleanText = (v, max) => String(v ?? '')
  .replace(/[\u0000-\u001f\u007f]/g, '')
  .trim()
  .slice(0, max);

function createApp(cfg) {
  const store = new Store(cfg.dataFile, { ttlHours: cfg.roomTtlHours, maxRooms: cfg.maxRooms });
  store.load();
  store.purge();

  const limiter = new RateLimiter();
  const hub = new Hub({ store, limiter, config: cfg });
  store.onRoomRemoved = code => hub.closeRoom(code);

  const scale = cfg.rateScale;
  const limit = (key, max, windowMs) => {
    if (!limiter.hit(key, max * scale, windowMs)) {
      throw new HttpError(429, 'Muitas tentativas. Aguarde um pouco e tente de novo.', 'RATE_LIMIT');
    }
  };

  const norm = c => String(c || '').trim().toUpperCase();

  async function authHost(p, ip) {
    const code = norm(p.p_code);
    const room = store.live(code);
    if (!room) return null;
    limit(`auth:${ip}:${code}`, 40, 5 * 60_000);
    return (await verifySecret(p.p_host_token_hash, room.host_secret)) ? room : null;
  }

  /* RPCs: um nome, um objeto de parâmetros, um retorno. */
  const rpcs = {
    async rise_create_room(p, ip) {
      if (!store.writable) throw new HttpError(503, 'O servidor não tem permissão para gravar dados.', 'READ_ONLY');
      limit(`create:${ip}`, 10, 3600_000);

      const code = norm(p.p_code);
      if (!CODE_RE.test(code)) return false;
      if (!isClientHash(p.p_host_token_hash)) return false;
      if (p.p_password_hash != null && !isClientHash(p.p_password_hash)) return false;

      return store.create({
        code,
        title: cleanText(p.p_title, 80) || 'Sessão Rise',
        hostName: cleanText(p.p_host_name, 28),
        hostSecret: await deriveSecret(p.p_host_token_hash),
        passwordSecret: p.p_password_hash != null ? await deriveSecret(p.p_password_hash) : null
      });
    },

    async rise_room_public(p, ip) {
      limit(`lookup:${ip}`, 60, 60_000);
      const room = store.live(norm(p.p_code));
      return room ? [store.publicView(room)] : [];
    },

    async rise_check_password(p, ip) {
      const code = norm(p.p_code);
      const room = store.live(code);
      if (!room || room.password_secret == null) return false;
      limit(`auth:${ip}:${code}`, 40, 5 * 60_000);
      return verifySecret(p.p_password_hash, room.password_secret);
    },

    async rise_is_host(p, ip) {
      return !!(await authHost(p, ip));
    },

    async rise_host_action(p, ip) {
      const room = await authHost(p, ip);
      if (!room) return false;
      const value = p.p_value == null ? null : String(p.p_value);

      switch (p.p_action) {
        case 'title': {
          const t = cleanText(value, 80);
          if (!t) return false;
          room.title = t;
          store.addLog(room.code, room.host_name, 'SESSAO_RENOMEADA', t);
          break;
        }
        case 'lock':
          room.locked = value === 'true';
          store.addLog(room.code, room.host_name, room.locked ? 'SALA_TRANCADA' : 'SALA_DESTRANCADA');
          break;
        case 'close':
          room.closed = true;
          room.status = 'closed';
          store.addLog(room.code, room.host_name, 'SALA_ENCERRADA');
          store.save();
          hub.closeRoom(room.code);
          return true;
        default:
          return false;
      }
      store.save();
      hub.roomUpdated(room.code);
      return true;
    },

    async rise_room_logs(p, ip) {
      const room = await authHost(p, ip);
      return room ? store.logsFor(room.code, p.p_limit) : [];
    }
  };

  /* ---------------------------------------------------------------- */
  /* HTTP                                                              */
  /* ---------------------------------------------------------------- */

  function securityHeaders(req) {
    const host = String(req.headers.host || '');
    const wsHost = /^[A-Za-z0-9.\-:[\]]+$/.test(host) ? host : '';
    const connect = ["'self'", wsHost && `ws://${wsHost}`, wsHost && `wss://${wsHost}`].filter(Boolean).join(' ');
    const headers = {
      'content-security-policy': [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        'font-src https://fonts.gstatic.com',
        "img-src 'self' data: blob:",
        "media-src 'self' blob: mediastream:",
        `connect-src ${connect}`,
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "object-src 'none'"
      ].join('; '),
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cross-origin-opener-policy': 'same-origin',
      'permissions-policy': 'display-capture=(self), camera=(), microphone=(), geolocation=()'
    };
    const secure = req.socket.encrypted || (cfg.trustProxy && req.headers['x-forwarded-proto'] === 'https');
    if (secure) headers['strict-transport-security'] = 'max-age=31536000';
    return headers;
  }

  function sendJson(req, res, status, body) {
    const buf = Buffer.from(JSON.stringify(body));
    res.writeHead(status, {
      ...securityHeaders(req),
      'content-type': 'application/json; charset=utf-8',
      'content-length': buf.length,
      'cache-control': 'no-store'
    });
    res.end(buf);
  }

  function readBody(req, max = 16 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', c => {
        size += c.length;
        if (size > max) { reject(new HttpError(413, 'Corpo da requisição grande demais.')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) return resolve({});
        try {
          const parsed = JSON.parse(raw);
          resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {});
        } catch { reject(new HttpError(400, 'JSON inválido.')); }
      });
      req.on('error', reject);
    });
  }

  async function serveStatic(req, res, pathname) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { rel = ''; }
    if (!rel || rel.includes('\0')) return notFound(req, res);
    if (rel.endsWith('/')) rel += 'index.html';

    const file = path.resolve(cfg.publicDir, '.' + rel);
    if (!file.startsWith(cfg.publicDir + path.sep)) return notFound(req, res);
    const type = MIME[path.extname(file).toLowerCase()];
    if (!type) return notFound(req, res);

    let stat;
    try {
      stat = await fsp.stat(file);
      if (!stat.isFile()) throw new Error('not a file');
    } catch { return notFound(req, res); }

    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const headers = {
      ...securityHeaders(req),
      'content-type': type,
      etag,
      'cache-control': type === 'image/png' ? 'public, max-age=86400' : 'no-cache'
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    headers['content-length'] = stat.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  }

  function notFound(req, res) {
    res.writeHead(404, { ...securityHeaders(req), 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
  }

  async function onRequest(req, res) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return sendJson(req, res, 400, { error: 'bad url' }); }
    const p = url.pathname;
    const ip = clientIp(req, cfg.trustProxy);

    try {
      if (p.startsWith('/api/rpc/') && req.method === 'POST') {
        const name = p.slice('/api/rpc/'.length);
        const fn = Object.hasOwn(rpcs, name) ? rpcs[name] : null;
        if (!fn) return sendJson(req, res, 404, { data: null, error: { code: 'NOT_FOUND', message: `função ${name} não existe` } });
        const params = await readBody(req);
        return sendJson(req, res, 200, { data: await fn(params, ip), error: null });
      }

      if (p === '/api/config' && req.method === 'GET') {
        limit(`config:${ip}`, 60, 60_000);
        const uid = url.searchParams.get('uid') || '';
        return sendJson(req, res, 200, {
          iceServers: iceServers(cfg, /^[A-Za-z0-9-]{8,64}$/.test(uid) ? uid : 'rise'),
          roomTtlHours: cfg.roomTtlHours,
          maxParticipants: cfg.maxParticipants
        });
      }

      if (p === '/api/health') return sendJson(req, res, 200, { ok: true, writable: store.writable });

      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(req, res, 405, { error: 'method not allowed' });
      if (p.startsWith('/api/')) return notFound(req, res);
      return await serveStatic(req, res, p);
    } catch (e) {
      if (e instanceof HttpError) {
        return sendJson(req, res, e.status, { data: null, error: { code: e.code || 'HTTP_' + e.status, message: e.message } });
      }
      console.error('[rise] erro HTTP:', e);
      return sendJson(req, res, 500, { data: null, error: { code: 'INTERNAL', message: 'Erro interno do servidor.' } });
    }
  }

  const useTls = !!(cfg.tlsCert && cfg.tlsKey);
  const server = useTls
    ? https.createServer({ cert: fs.readFileSync(cfg.tlsCert), key: fs.readFileSync(cfg.tlsKey) }, onRequest)
    : http.createServer(onRequest);
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 50;

  server.on('upgrade', (req, socket) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return socket.destroy(); }
    if (url.pathname !== '/ws') return socket.destroy();
    socket.on('error', () => socket.destroy());
    hub.handleUpgrade(req, socket, clientIp(req, cfg.trustProxy));
  });

  const purgeTimer = setInterval(() => store.purge(), 5 * 60_000);
  purgeTimer.unref();

  return {
    server,
    store,
    hub,
    useTls,
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(cfg.port, cfg.host, () => {
          server.off('error', reject);
          resolve(server.address().port);
        });
      });
    },
    async stop() {
      clearInterval(purgeTimer);
      hub.shutdown();
      await new Promise(r => setTimeout(r, 50)); // deixa os eventos de saída terminarem
      await store.close();
      await new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections?.(); });
    }
  };
}

module.exports = { createApp };
