/*
  Teste de ponta a ponta com navegador real (Playwright + Chromium).

    npm i -D playwright     (uma vez; ou use um Playwright que já exista na máquina)
    npm run test:e2e

  Sobe o servidor numa porta livre, abre vários navegadores e confere o fluxo completo:
  criar sala, entrar com senha, transmitir (o vídeo precisa chegar!), permissão, expulsão e encerramento.
  A captura de tela é simulada com um <canvas>, então roda sem interface gráfica.
*/

import { createRequire } from 'node:module';
import { startServer } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const results = [];
const check = (cond, msg) => { results.push({ ok: !!cond, msg }); console.log(`${cond ? '  ok ' : ' FAIL'}  ${msg}`); };

const FAKE_SCREEN = () => {
  // getDisplayMedia falso: canvas animado + tom de áudio
  localStorage.setItem('rise_audio_guide', '1');
  navigator.mediaDevices.getDisplayMedia = async () => {
    const c = document.createElement('canvas');
    c.width = 1280; c.height = 720;
    const g = c.getContext('2d');
    let t = 0;
    setInterval(() => {
      g.fillStyle = `hsl(${t % 360},70%,45%)`;
      g.fillRect(0, 0, 1280, 720);
      g.fillStyle = '#fff';
      g.font = '64px sans-serif';
      g.fillText('frame ' + t, 120, 360);
      t += 3;
    }, 33);
    const stream = c.captureStream(30);
    const ac = new AudioContext();
    const osc = ac.createOscillator();
    const dest = ac.createMediaStreamDestination();
    osc.connect(dest); osc.start();
    dest.stream.getAudioTracks().forEach(tr => stream.addTrack(tr));
    return stream;
  };
};

async function newUser(browser, base, name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(FAKE_SCREEN);
  const page = await ctx.newPage();
  page.on('pageerror', e => check(false, `${name}: erro de JS não tratado: ${e.message}`));
  page.name = name;
  await page.goto(base + '/');
  return page;
}

const inRoom = page => page.waitForFunction(() => document.querySelector('#app')?.classList.contains('show') && document.querySelector('#conn')?.textContent.includes('Conectado'), null, { timeout: 8000 });
const peopleCount = (page, n) => page.waitForFunction(want => Number(document.querySelector('#peopleBadge')?.textContent) === want, n, { timeout: 8000 });

async function createRoom(page, { name, password } = {}) {
  await page.fill('#displayName', name);
  if (password) {
    await page.click('.entryMore summary');
    await page.fill('#roomPassword', password);
  }
  await page.click('#createRoom');
  await inRoom(page);
  return (await page.textContent('#roomCode')).trim();
}

async function joinByInvite(page, code, name) {
  await page.goto(page.url().split('?')[0] + '?room=' + code);
  await page.fill('#displayName', name);
  await page.click('#joinInvite');
}

async function waitForVideo(page, ms = 20000) {
  try {
    await page.waitForFunction(() => {
      const v = document.querySelector('#video');
      return v && v.srcObject && v.videoWidth > 0 && v.style.display !== 'none';
    }, null, { timeout: ms });
    return true;
  } catch { return false; }
}

const { base, stop } = await (async () => { const s = await startServer({ rateScale: 1000 }); return { base: s.base, stop: s.stop }; })();
const browser = await chromium.launch({
  args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required', '--no-sandbox']
});

try {
  console.log('\n# página e módulos');
  const home = await newUser(browser, base, 'home');
  const errors = [];
  home.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await home.reload();
  check(await home.locator('#createRoom').isVisible(), 'tela de entrada carrega (módulos ES resolvem sem erro)');
  check(errors.length === 0, 'sem erros no console (CSP não bloqueou nada): ' + errors.join(' | '));

  console.log('\n# sala com senha');
  const host = await newUser(browser, base, 'Ana');
  const code = await createRoom(host, { name: 'Ana', password: 'segredo123' });
  check(/^RISE-[A-HJ-NP-Z2-9]{6}$/.test(code), `código com 6 caracteres: ${code}`);

  const bruno = await newUser(browser, base, 'Bruno');
  await joinByInvite(bruno, code, 'Bruno');
  await bruno.waitForSelector('#modal.show input[type=password]');
  await bruno.fill('#modal input[type=password]', 'errada');
  await bruno.click('#modal button[type=submit]');
  await bruno.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Senha incorreta'));
  check(!(await bruno.locator('#app.show').count()), 'senha errada: não entra');

  await bruno.click('#joinInvite');
  await bruno.waitForSelector('#modal.show input[type=password]');
  await bruno.fill('#modal input[type=password]', 'segredo123');
  await bruno.click('#modal button[type=submit]');
  await inRoom(bruno);
  await peopleCount(host, 2);
  check(true, 'senha certa: entra na sala; host vê 2 pessoas');

  console.log('\n# transmissão');
  await host.click('#shareScreen2');
  check(await waitForVideo(bruno), 'Bruno recebe o vídeo do host (WebRTC ponto a ponto funcionando)');
  const audio = await bruno.evaluate(() => document.querySelector('#video').srcObject.getAudioTracks().length);
  check(audio === 1, 'Bruno recebe também a faixa de áudio');
  check(/Ao vivo/.test(await bruno.textContent('#liveBadge')), 'selo "Ao vivo" aparece');

  const maxBitrate = await host.evaluate(async () => {
    await new Promise(r => setTimeout(r, 800));
    const { S } = window.__rise;
    const out = [];
    for (const pc of S.peers.values()) for (const s of pc.getSenders()) if (s.track?.kind === 'video') out.push(s.getParameters().encodings[0].maxBitrate);
    return out;
  });
  check(maxBitrate.length === 1 && maxBitrate[0] > 0 && maxBitrate[0] <= 5_000_000, `bitrate limitado no remetente: ${maxBitrate[0]} bps`);
  const hint = await host.evaluate(() => document.querySelector('#bitrateHint').textContent);
  check(/Upload estimado/.test(hint), `estimativa de upload exibida: "${hint}"`);

  console.log('\n# permissão (validada no servidor)');
  const carla = await newUser(browser, base, 'Carla');
  await joinByInvite(carla, code, 'Carla');
  await carla.waitForSelector('#modal.show input[type=password]');
  await carla.fill('#modal input[type=password]', 'segredo123');
  await carla.click('#modal button[type=submit]');
  await inRoom(carla);
  await peopleCount(host, 3);
  check(await waitForVideo(carla), 'quem entra depois também recebe a transmissão em andamento');

  await carla.click('#shareScreen2');
  await carla.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('ainda não liberou'));
  check(true, 'Carla sem permissão: botão avisa que o host não liberou');

  // Carla tenta burlar o cliente: força a permissão localmente e transmite. O servidor não deve aceitar.
  await carla.evaluate(async () => { window.__rise.S.shareAllowed = true; document.querySelector('#shareScreen2').click(); });
  await carla.waitForFunction(() => window.__rise.S.stream);
  await new Promise(r => setTimeout(r, 1500));
  const carlaListed = await host.evaluate(() => [...document.querySelectorAll('.person')].find(p => p.textContent.includes('Carla'))?.textContent || '');
  check(!/Transmitindo/.test(carlaListed), 'servidor ignora transmissão forjada (Carla não aparece como transmitindo)');
  await carla.evaluate(() => document.querySelector('#stopShare').click());
  await carla.evaluate(() => { window.__rise.S.shareAllowed = false; });

  await host.click('#togglePeople');
  await host.evaluate(() => { document.querySelectorAll('[data-permit]').forEach(b => { if (b.closest('.person').textContent.includes('Carla')) b.click(); }); });
  await carla.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('liberou'));
  check(true, 'host libera Carla: ela é avisada pelo servidor');
  await carla.click('#shareScreen2');
  check(await waitForVideo(bruno), 'Bruno passa a ver uma transmissão (Carla ou host)');
  const sel = await bruno.evaluate(() => [...document.querySelectorAll('#activeStream option')].length);
  check(sel >= 2, 'Bruno pode escolher entre duas transmissões');

  console.log('\n# expulsão e controle de host');
  const carlaUid = await carla.evaluate(() => window.__rise.S.uid);
  await bruno.evaluate(uid => window.__rise.S.channel.send('control', { type: 'kick', to: uid, data: {} }), carlaUid);
  await new Promise(r => setTimeout(r, 800));
  check(await carla.locator('#app.show').count() === 1, 'kick forjado por quem não é host é ignorado (Carla continua na sala)');
  check(await host.evaluate(() => Number(document.querySelector('#peopleBadge').textContent)) === 3, 'ninguém saiu depois do kick forjado');

  await host.evaluate(() => { document.querySelectorAll('[data-kick]').forEach(b => { if (b.closest('.person').textContent.includes('Carla')) b.click(); }); });
  await carla.waitForFunction(() => document.querySelector('#landing')?.classList.contains('show'), null, { timeout: 8000 });
  check(true, 'host expulsa Carla: ela volta para a tela de entrada');
  await peopleCount(host, 2);

  await joinByInvite(carla, code, 'Carla');
  await carla.waitForSelector('#modal.show input[type=password]');
  await carla.fill('#modal input[type=password]', 'segredo123');
  await carla.click('#modal button[type=submit]');
  await carla.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('removido'), null, { timeout: 8000 });
  check(await carla.locator('#landing.show').count() === 1, 'expulsa não consegue voltar (banimento é validado no servidor)');

  console.log('\n# sala trancada e encerramento');
  await host.evaluate(() => document.querySelector('#lockBtn').click());
  await host.waitForFunction(() => document.querySelector('#lockBtn').classList.contains('ctrlActive'));
  const dani = await newUser(browser, base, 'Dani');
  await joinByInvite(dani, code, 'Dani');
  await dani.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('trancada'));
  check(true, 'sala trancada: novo participante é barrado');

  await host.evaluate(() => document.querySelector('#closeRoom').click());
  await host.click('#modal .btnDanger');
  await bruno.waitForFunction(() => document.querySelector('#landing')?.classList.contains('show'), null, { timeout: 8000 });
  check(true, 'host encerra a sala: todos são desconectados');
} catch (e) {
  check(false, 'exceção no teste: ' + e.message);
  console.error(e);
} finally {
  await browser.close();
  await stop();
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} verificações passaram`);
process.exit(failed.length ? 1 : 0);
