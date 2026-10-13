'use strict';

/*
  WebSocket (RFC 6455) mínimo, sem dependências.
  Só texto; exige máscara do cliente; limita tamanho de mensagem e fragmentos.
*/

const crypto = require('node:crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_BUFFERED = 1 << 20; // 1 MB parado no buffer de saída = cliente lento demais

function encodeFrame(payload, opcode) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = 0x80 | opcode;
  return Buffer.concat([head, payload]);
}

/**
 * Faz o upgrade e devolve a conexão, ou null (e destrói o socket) se o pedido for inválido.
 * Callbacks: onMessage(text), onClose().
 */
function acceptWebSocket(req, socket, { maxPayload = 64 * 1024, onMessage, onClose }) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13') {
    socket.destroy();
    return null;
  }

  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);
  socket.setTimeout(0);

  let closed = false;
  let buf = Buffer.alloc(0);
  let fragOp = 0;
  let fragParts = [];
  let fragSize = 0;

  const conn = {
    socket,
    lastSeen: Date.now(),

    send(obj) {
      if (closed || socket.destroyed || !socket.writable) return false;
      if (socket.writableLength > MAX_BUFFERED) return false; // descarta em vez de acumular
      try { socket.write(encodeFrame(Buffer.from(JSON.stringify(obj), 'utf8'), 0x1)); return true; } catch { return false; }
    },

    ping() {
      if (closed || socket.destroyed || !socket.writable) return;
      try { socket.write(encodeFrame(Buffer.alloc(0), 0x9)); } catch { /* ignora */ }
    },

    /** Fechamento educado: envia frame de close e encerra o lado de escrita. */
    close(code = 1000, reason = '') {
      if (closed) return;
      closed = true;
      try {
        const r = Buffer.from(String(reason).slice(0, 100), 'utf8');
        const payload = Buffer.alloc(2 + r.length);
        payload.writeUInt16BE(code, 0);
        r.copy(payload, 2);
        socket.end(encodeFrame(payload, 0x8));
      } catch { socket.destroy(); }
      // quem não responder o close não fica pendurado
      setTimeout(() => socket.destroy(), 2000).unref();
    },

    terminate() {
      closed = true;
      socket.destroy();
    }
  };

  const fail = (code, reason) => { conn.close(code, reason); };

  socket.on('data', chunk => {
    if (closed) return;
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;

    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;

      if (b0 & 0x70) return fail(1002, 'rsv');
      if (!masked) return fail(1002, 'unmasked');

      if (len === 126) {
        if (buf.length < off + 2) return;
        len = buf.readUInt16BE(off); off += 2;
      } else if (len === 127) {
        if (buf.length < off + 8) return;
        const big = buf.readBigUInt64BE(off); off += 8;
        if (big > BigInt(maxPayload)) return fail(1009, 'too big');
        len = Number(big);
      }
      if (len > maxPayload) return fail(1009, 'too big');
      if (opcode >= 0x8 && (!fin || len > 125)) return fail(1002, 'control frame');

      if (buf.length < off + 4) return;
      const mask = buf.subarray(off, off + 4); off += 4;
      if (buf.length < off + len) return;

      const payload = Buffer.from(buf.subarray(off, off + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(off + len);
      conn.lastSeen = Date.now();

      if (opcode === 0x8) { // close
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
        conn.close(code);
        return;
      }
      if (opcode === 0x9) { // ping
        try { socket.write(encodeFrame(payload, 0xA)); } catch { /* ignora */ }
        continue;
      }
      if (opcode === 0xA) continue; // pong

      if (opcode === 0x0) { // continuação
        if (!fragOp) return fail(1002, 'bad continuation');
        fragSize += payload.length;
        if (fragSize > maxPayload) return fail(1009, 'too big');
        fragParts.push(payload);
        if (fin) {
          const full = Buffer.concat(fragParts);
          fragParts = []; fragSize = 0; fragOp = 0;
          onMessage(full.toString('utf8'));
        }
        continue;
      }

      if (opcode !== 0x1) return fail(1003, 'text only'); // binário não é usado
      if (fragOp) return fail(1002, 'unfinished fragment');
      if (!fin) { fragOp = opcode; fragParts = [payload]; fragSize = payload.length; continue; }
      onMessage(payload.toString('utf8'));
    }
  });

  const bye = () => {
    if (!conn._byeCalled) { conn._byeCalled = true; closed = true; onClose(); }
  };
  socket.on('close', bye);
  socket.on('end', bye);
  socket.on('error', () => { bye(); socket.destroy(); });

  return conn;
}

module.exports = { acceptWebSocket, encodeFrame };
