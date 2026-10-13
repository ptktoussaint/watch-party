'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

/** O cliente envia SHA-256 hex (64 caracteres) de senha / token de host. */
const HASH_RE = /^[0-9a-f]{64}$/;
const isClientHash = v => typeof v === 'string' && HASH_RE.test(v);

/**
 * O que vai para o disco nunca é o hash do cliente em si: é scrypt(hash, salt).
 * Quem ler o data.json não consegue reaproveitar o valor como credencial.
 */
async function deriveSecret(clientHash) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(clientHash, salt, 32);
  return `${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifySecret(clientHash, stored) {
  if (!isClientHash(clientHash) || typeof stored !== 'string') return false;
  const [saltHex, keyHex] = stored.split('$');
  if (!saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(clientHash, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

/** Janela fixa por chave; suficiente para frear força bruta e abuso simples. */
class RateLimiter {
  constructor() {
    this.buckets = new Map();
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref();
  }

  /** true = dentro do limite. */
  hit(key, limit, windowMs) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, b);
    }
    b.count++;
    return b.count <= limit;
  }

  sweep() {
    const now = Date.now();
    for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
  }
}

/** Token bucket por conexão (mensagens por segundo). */
class TokenBucket {
  constructor(capacity, refillPerSec) {
    this.capacity = capacity;
    this.refill = refillPerSec;
    this.tokens = capacity;
    this.last = Date.now();
  }

  take() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refill);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress || 'unknown';
}

/** Código de sala: RISE- + 6 caracteres sem ambiguidade (I, O, 0 e 1 ficam de fora). */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RE = /^RISE-[A-HJ-NP-Z2-9]{6}$/;

module.exports = {
  isClientHash,
  deriveSecret,
  verifySecret,
  RateLimiter,
  TokenBucket,
  clientIp,
  CODE_ALPHABET,
  CODE_RE
};
