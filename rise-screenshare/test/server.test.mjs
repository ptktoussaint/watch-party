import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, rpc, createRoom, TestClient, sha } from './helpers.mjs';
import { randomUUID } from 'node:crypto';

let srv;
test.before(async () => { srv = await startServer(); });
test.after(async () => { await srv.stop(); });

test('cria sala e expõe só dados públicos', async () => {
  const room = await createRoom(srv.base, { password: 'segredo', title: '  Minha sala  ' });
  const r = await rpc(srv.base, 'rise_room_public', { p_code: room.code.toLowerCase() });
  assert.equal(r.data.length, 1);
  assert.equal(r.data[0].title, 'Minha sala');
  assert.equal(r.data[0].password_required, true);
  assert.equal(JSON.stringify(r).includes('secret'), false);
  assert.equal(JSON.stringify(r).includes(room.hostHash), false);
});

test('rejeita código fora do formato e hash inválido', async () => {
  const bad = await rpc(srv.base, 'rise_create_room', { p_code: 'RISE-AB', p_host_token_hash: sha('x') });
  assert.equal(bad.data, false);
  const bad2 = await rpc(srv.base, 'rise_create_room', { p_code: 'RISE-ABCDEF', p_host_token_hash: 'abc' });
  assert.equal(bad2.data, false);
});

test('validade é decidida pelo servidor, não pelo cliente', async () => {
  const room = await createRoom(srv.base);
  const r = await rpc(srv.base, 'rise_room_public', { p_code: room.code });
  const hours = (new Date(r.data[0].expires_at) - Date.now()) / 3600e3;
  assert.ok(hours > 2.9 && hours <= 3.01, `ttl ${hours}`);
});

test('segredos no disco não são o hash do cliente', async () => {
  const room = await createRoom(srv.base, { password: 'abc' });
  await srv.app.store.flush();
  const stored = srv.app.store.rooms[room.code];
  assert.notEqual(stored.host_secret, room.hostHash);
  assert.ok(!stored.host_secret.includes(room.hostHash));
  assert.ok(stored.password_secret.includes('$'));
});

test('ações de host exigem o token certo', async () => {
  const room = await createRoom(srv.base);
  const wrong = await rpc(srv.base, 'rise_host_action', { p_code: room.code, p_host_token_hash: sha('errado'), p_action: 'lock', p_value: 'true' });
  assert.equal(wrong.data, false);
  const ok = await rpc(srv.base, 'rise_host_action', { p_code: room.code, p_host_token_hash: room.hostHash, p_action: 'title', p_value: 'Novo' });
  assert.equal(ok.data, true);
  assert.equal((await rpc(srv.base, 'rise_is_host', { p_code: room.code, p_host_token_hash: room.hostHash })).data, true);
  assert.equal((await rpc(srv.base, 'rise_is_host', { p_code: room.code, p_host_token_hash: sha('x') })).data, false);
});

test('WebSocket: senha e sala trancada são exigidas no servidor', async () => {
  const room = await createRoom(srv.base, { password: 'segredo' });

  const semSenha = new TestClient(srv.base, room.code);
  assert.equal((await semSenha.join()).reason, 'password');

  const senhaErrada = new TestClient(srv.base, room.code, { password: 'outra' });
  assert.equal((await senhaErrada.join()).reason, 'password');

  const ok = new TestClient(srv.base, room.code, { password: 'segredo' });
  assert.equal((await ok.join()).op, 'ready');

  await rpc(srv.base, 'rise_host_action', { p_code: room.code, p_host_token_hash: room.hostHash, p_action: 'lock', p_value: 'true' });
  const trancada = new TestClient(srv.base, room.code, { password: 'segredo' });
  assert.equal((await trancada.join()).reason, 'locked');

  // o host entra mesmo trancada e sem senha
  const host = new TestClient(srv.base, room.code, { hostHash: room.hostHash });
  const ready = await host.join();
  assert.equal(ready.op, 'ready');
  assert.equal(ready.isHost, true);
  [ok, host].forEach(c => c.close());
});

test('WebSocket: sala inexistente e uid inválido são negados', async () => {
  const c = new TestClient(srv.base, 'RISE-ZZZZZZ');
  assert.equal((await c.join()).reason, 'not-found');
  const room = await createRoom(srv.base);
  const d = new TestClient(srv.base, room.code, { uid: 'x' });
  assert.equal((await d.join()).reason, 'bad-request');
});

test('presença: ninguém se declara host nem transmissor sem permissão', async () => {
  const room = await createRoom(srv.base);
  const host = new TestClient(srv.base, room.code, { hostHash: room.hostHash, name: 'Dono' });
  const guest = new TestClient(srv.base, room.code, { name: 'Visita' });
  await host.join(); await guest.join();

  guest.track({ userId: 'forjado', isHost: true, sharing: true, shareAllowed: true, name: 'Hacker' });
  const sync = await host.waitFor(m => m.op === 'sync' && m.state[guest.uid]);
  const entry = sync.state[guest.uid][0];
  assert.equal(entry.userId, guest.uid);
  assert.equal(entry.isHost, false);
  assert.equal(entry.sharing, false);
  assert.equal(entry.shareAllowed, false);
  assert.equal(entry.name, 'Visita');
  [host, guest].forEach(c => c.close());
});

test('só o host libera, revoga e expulsa', async () => {
  const room = await createRoom(srv.base);
  const host = new TestClient(srv.base, room.code, { hostHash: room.hostHash });
  const a = new TestClient(srv.base, room.code, { name: 'A' });
  const b = new TestClient(srv.base, room.code, { name: 'B' });
  await host.join(); await a.join(); await b.join();
  host.track({}); a.track({}); b.track({});

  // B tenta liberar A e expulsar A: nada acontece
  b.control({ type: 'share-permission', to: a.uid, data: { allowed: true } });
  b.control({ type: 'kick', to: a.uid, data: {} });
  assert.ok(await a.expectNone(m => m.op === 'bc' && m.event === 'control'));

  // host libera A: A recebe, e passa a poder transmitir
  host.control({ type: 'share-permission', to: a.uid, data: { allowed: true } });
  const perm = await a.waitFor(m => m.op === 'bc' && m.event === 'control' && m.payload.type === 'share-permission');
  assert.equal(perm.payload.data.allowed, true);
  assert.equal(perm.payload.from, 'server');
  a.track({ sharing: true });
  const live = await b.waitFor(m => m.op === 'sync' && m.state[a.uid]?.[0].sharing === true);
  assert.ok(live);

  // status da sala é derivado de quem transmite
  const state = await b.waitFor(m => m.op === 'bc' && m.event === 'control' && m.payload.type === 'room-state' && m.payload.data.status === 'live');
  assert.ok(state);

  // revogar derruba a transmissão no estado do servidor
  host.control({ type: 'share-permission', to: a.uid, data: { allowed: false } });
  await b.waitFor(m => m.op === 'sync' && m.state[a.uid]?.[0].sharing === false && m.state[a.uid][0].shareAllowed === false);

  // expulsão: A recebe 'kick', é desconectada e não volta
  host.control({ type: 'kick', to: a.uid, data: {} });
  await a.waitFor(m => m.op === 'bc' && m.payload.type === 'kick');
  assert.equal(await a.closed, 4003);
  const again = new TestClient(srv.base, room.code, { uid: a.uid });
  assert.equal((await again.join()).reason, 'kicked');
  [host, b].forEach(c => c.close());
});

test('sinalização é entregue só ao destinatário, com `from` carimbado', async () => {
  const room = await createRoom(srv.base);
  const host = new TestClient(srv.base, room.code, { hostHash: room.hostHash });
  const a = new TestClient(srv.base, room.code);
  const b = new TestClient(srv.base, room.code);
  await host.join(); await a.join(); await b.join();

  a.signal({ from: 'forjado', to: b.uid, type: 'offer', data: { sdp: { type: 'offer', sdp: 'v=0' } } });
  const got = await b.waitFor(m => m.op === 'bc' && m.event === 'signal');
  assert.equal(got.payload.from, a.uid);
  assert.ok(await host.expectNone(m => m.op === 'bc' && m.event === 'signal'));

  // tipos desconhecidos e anúncio de transmissão sem transmitir são descartados
  a.signal({ to: b.uid, type: 'rm-rf', data: {} });
  a.signal({ type: 'stream-available', data: {} });
  assert.ok(await b.expectNone(m => m.op === 'bc' && m.payload.type !== 'offer'));
  [host, a, b].forEach(c => c.close());
});

test('encerrar a sala avisa e desconecta todos', async () => {
  const room = await createRoom(srv.base);
  const a = new TestClient(srv.base, room.code);
  await a.join();
  await rpc(srv.base, 'rise_host_action', { p_code: room.code, p_host_token_hash: room.hostHash, p_action: 'close', p_value: 'true' });
  await a.waitFor(m => m.op === 'bc' && m.payload.type === 'room-closed');
  assert.equal(await a.closed, 1000);
  assert.equal((await rpc(srv.base, 'rise_room_public', { p_code: room.code })).data.length, 0);
});

test('logs só para o host e gerados pelo servidor', async () => {
  const room = await createRoom(srv.base);
  const a = new TestClient(srv.base, room.code, { name: 'Ana' });
  await a.join();
  const denied = await rpc(srv.base, 'rise_room_logs', { p_code: room.code, p_host_token_hash: sha('x') });
  assert.deepEqual(denied.data, []);
  const logs = await rpc(srv.base, 'rise_room_logs', { p_code: room.code, p_host_token_hash: room.hostHash });
  assert.ok(logs.data.some(l => l.event_type === 'ENTROU_NA_SALA' && l.actor_name === 'Ana'));
  a.close();
});

test('mesma pessoa reconectando substitui a conexão antiga', async () => {
  const room = await createRoom(srv.base);
  const uid = randomUUID();
  const a1 = new TestClient(srv.base, room.code, { uid });
  await a1.join();
  const a2 = new TestClient(srv.base, room.code, { uid });
  assert.equal((await a2.join()).op, 'ready');
  assert.equal(await a1.closed, 1000);
  a2.close();
});

test('capacidade máxima da sala', async () => {
  const small = await startServer({ maxParticipants: 2 });
  try {
    const room = await createRoom(small.base);
    const a = new TestClient(small.base, room.code); const b = new TestClient(small.base, room.code); const c = new TestClient(small.base, room.code);
    await a.join(); await b.join();
    assert.equal((await c.join()).reason, 'full');
    const host = new TestClient(small.base, room.code, { hostHash: room.hostHash });
    assert.equal((await host.join()).op, 'ready'); // host não fica de fora
    [a, b, host].forEach(x => x.close());
  } finally { await small.stop(); }
});

test('limite de tentativas contra força bruta de senha', async () => {
  const strict = await startServer({ rateScale: 0.1 }); // 4 tentativas
  try {
    const room = await createRoom(strict.base, { password: 'certa' });
    let last;
    for (let i = 0; i < 6; i++) last = await rpc(strict.base, 'rise_check_password', { p_code: room.code, p_password_hash: sha('x' + i) });
    assert.equal(last.status, 429);
  } finally { await strict.stop(); }
});

test('origem estranha no WebSocket é recusada', async () => {
  const room = await createRoom(srv.base);
  const status = await new Promise(resolve => {
    import('node:http').then(({ default: http }) => {
      const req = http.request(srv.base + '/ws', {
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', Origin: 'https://evil.example' }
      });
      req.on('response', res => resolve(res.statusCode));
      req.on('upgrade', () => resolve(101));
      req.on('error', () => resolve(0));
      req.end();
    });
  });
  assert.ok(room);
  assert.equal(status, 403);
});

test('estáticos: só public/, sem path traversal e com cabeçalhos de segurança', async () => {
  const idx = await fetch(srv.base + '/');
  assert.equal(idx.status, 200);
  assert.match(idx.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(idx.headers.get('x-content-type-options'), 'nosniff');
  for (const p of ['/server.js', '/data/data.json', '/package.json', '/lib/app.js', '/%2e%2e/server.js', '/..%2fserver.js']) {
    const r = await fetch(srv.base + p);
    assert.equal(r.status, 404, p);
  }
  const health = await (await fetch(srv.base + '/api/health')).json();
  assert.deepEqual(Object.keys(health).sort(), ['ok', 'writable']);
});

test('/api/config entrega STUN e credenciais TURN temporárias', async () => {
  const t = await startServer({ turnUrls: ['turn:turn.example.com:3478'], turnSecret: 's3cret' });
  try {
    const cfg = await (await fetch(t.base + '/api/config?uid=' + randomUUID())).json();
    const turn = cfg.iceServers.find(s => s.username);
    assert.ok(turn.username.includes(':'));
    assert.ok(turn.credential.length > 10);
    assert.ok(Number(turn.username.split(':')[0]) > Date.now() / 1000);
  } finally { await t.stop(); }
});
