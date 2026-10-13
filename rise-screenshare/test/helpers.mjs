import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const { fromEnv } = require('../lib/config.js');
const { createApp } = require('../lib/app.js');

export const sha = v => createHash('sha256').update(v).digest('hex');

export async function startServer(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rise-test-'));
  const cfg = { ...fromEnv({}), port: 0, host: '127.0.0.1', dataFile: join(dir, 'data.json'), rateScale: 1000, ...overrides };
  const app = createApp(cfg);
  const port = await app.start();
  const base = `http://127.0.0.1:${port}`;
  return {
    app, base, port,
    async stop() { await app.stop(); rmSync(dir, { recursive: true, force: true }); }
  };
}

export async function rpc(base, name, params = {}) {
  const res = await fetch(`${base}/api/rpc/${name}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params)
  });
  return { status: res.status, ...(await res.json()) };
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const newCode = () => 'RISE-' + Array.from(randomBytes(6), b => ALPHABET[b % ALPHABET.length]).join('');

export async function createRoom(base, { password = null, title = 'Teste' } = {}) {
  const code = newCode();
  const hostToken = randomUUID() + randomUUID();
  const r = await rpc(base, 'rise_create_room', {
    p_code: code, p_title: title, p_host_name: 'Dono',
    p_host_token_hash: sha(hostToken), p_password_hash: password ? sha(password) : null
  });
  if (r.data !== true) throw new Error('não criou a sala: ' + JSON.stringify(r));
  return { code, hostToken, hostHash: sha(hostToken), password };
}

/** Cliente WebSocket de teste com fila de mensagens. */
export class TestClient {
  constructor(base, code, { uid = randomUUID(), name = 'Alguém', password, hostHash } = {}) {
    this.uid = uid; this.code = code; this.msgs = []; this.waiters = [];
    this.ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws');
    this.closed = new Promise(res => { this.ws.onclose = e => res(e.code); });
    this.ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      this.msgs.push(m);
      this.waiters = this.waiters.filter(w => !w(m));
    };
    this.opened = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.hello = { op: 'hello', topic: 'rise-' + code, uid, name, password_hash: password ? sha(password) : undefined, host_token_hash: hostHash };
  }
  async join() {
    await this.opened;
    this.send(this.hello);
    return this.waitFor(m => m.op === 'ready' || m.op === 'denied');
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  track(payload) { this.send({ op: 'track', payload }); }
  signal(payload) { this.send({ op: 'bc', event: 'signal', payload }); }
  control(payload) { this.send({ op: 'bc', event: 'control', payload }); }
  waitFor(pred, ms = 3000) {
    const found = this.msgs.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout esperando mensagem')), ms);
      this.waiters.push(m => { if (pred(m)) { clearTimeout(t); resolve(m); return true; } return false; });
    });
  }
  async expectNone(pred, ms = 300) {
    await new Promise(r => setTimeout(r, ms));
    return !this.msgs.some(pred);
  }
  close() { try { this.ws.close(); } catch { /* ignora */ } }
}
