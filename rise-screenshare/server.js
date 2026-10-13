/* =============================================================
   Rise Screen Share — ponto de entrada.

     npm start                  → http://localhost:4173
     PORT=8080 npm start        → porta alternativa

   Um único processo Node, sem dependências:
     - serve public/
     - guarda salas e logs em data/data.json
     - WebSocket /ws para presença e sinalização WebRTC

   A mídia (vídeo/áudio) nunca passa por aqui: vai direto entre os navegadores.
   Configuração por variáveis de ambiente: veja README.md.
   ============================================================= */

'use strict';

const { fromEnv } = require('./lib/config');
const { createApp } = require('./lib/app');

const cfg = fromEnv();
const app = createApp(cfg);

app.server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[rise] porta ${cfg.port} já está em uso — o Rise provavelmente já está rodando.`);
    process.exit(1);
  }
  throw err;
});

app.start().then(port => {
  const proto = app.useTls ? 'https' : 'http';
  console.log(`[rise] ${proto}://localhost:${port}`);
  console.log(`[rise] dados em ${cfg.dataFile}`);
  if (!app.useTls) {
    console.log('[rise] sem TLS: o compartilhamento de tela só funciona em localhost ou atrás de HTTPS (veja README).');
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log('\n[rise] encerrando, gravando dados...');
    await app.stop();
    process.exit(0);
  });
}
