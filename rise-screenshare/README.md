# Rise — Sistema de Transmissão de Tela

Aplicação web para transmitir a tela do computador para outras pessoas, em salas, de forma simples:
uma pessoa cria a sala, os outros entram por **código**, **link** ou **QR Code** e veem a tela dela.
O vídeo e o áudio vão **direto entre os navegadores** (WebRTC); o servidor só faz a sinalização.

<div align="center">

<table>
  <tr>
    <td><img src="https://github.com/user-attachments/assets/c22f25d5-cddf-4087-b998-e1f1cec784e9" width="480"></td>
    <td><img src="https://github.com/user-attachments/assets/54430724-712f-41ef-8508-83c8235b5891" width="480"></td>
  </tr>
  <tr>
    <td><img src="https://github.com/user-attachments/assets/e74770c5-9e09-4af1-b945-4336c662f36e" width="480"></td>
    <td><img src="https://github.com/user-attachments/assets/de1d246f-e56c-4d54-a542-f10f34f4b763" width="480"></td>
  </tr>
</table>

</div>

## Começando

Precisa de Node 22 ou superior. **Não há dependências para rodar.**

```bash
cd rise-screenshare
npm start            # http://localhost:4173
PORT=8080 npm start  # outra porta
```

Abra `http://localhost:4173` (não abra o `index.html` direto do disco). Em `localhost` o navegador libera o
compartilhamento de tela; **fora de `localhost` é obrigatório HTTPS** — veja [Colocando no ar](#colocando-no-ar).

## Como funciona

```
 navegador do host ──┐                         ┌── navegador do espectador
   (getDisplayMedia) │   vídeo/áudio (WebRTC)  │
                     └─────────────────────────┘      ← direto, nunca passa pelo servidor

 todos os navegadores ──► server.js ◄── presença + sinalização (WebSocket /ws)
                          └─ salas e logs em data/data.json
```

- **`server.js`** (Node puro): serve `public/`, guarda salas/logs em `data/data.json`, faz presença e sinalização por WebSocket.
- **`public/js/`** (módulos ES, sem build): `state` · `util` · `client` (rede) · `realtime` (presença/controle) · `rtc` (WebRTC e bitrate) · `share` (captura) · `stage`/`people`/`panels` (UI) · `room` (criar/entrar/sair) · `main`.
- Cada espectador abre uma conexão direta com quem transmite (malha P2P). Isso é simples e sem custo de servidor de mídia,
  mas limita o tamanho da audiência — veja [Limites](#limites-e-escalabilidade).

## Segurança

Tudo que importa é decidido **no servidor**, não no navegador:

| Regra | Onde é imposta |
|---|---|
| Senha, sala trancada, banido e lotação | no `hello` do WebSocket (`lib/hub.js`) — não dá para entrar pulando a tela de senha |
| Quem é host | prova do token de host; o cliente não "se declara" host |
| Expulsar, liberar/revogar transmissão | só conexões de host; o servidor executa e avisa o alvo |
| "Quem está transmitindo" | o servidor monta a presença; sem permissão, `sharing` é descartado |
| Sinais WebRTC (offer/answer/ICE) | entregues só ao destinatário, com `from` carimbado pelo servidor |
| Validade da sala | o servidor decide (`ROOM_TTL_HOURS`), o cliente não escolhe |
| Senha e token no disco | `scrypt(hash, salt)`; ler o `data.json` não revela credenciais reutilizáveis |
| Código da sala | `RISE-` + 6 caracteres sorteados com `crypto` (~1 bilhão de combinações) |
| Abuso | limite de tentativas por IP/sala, limite de criação de salas, token bucket por conexão, tamanho máximo de mensagem, verificação de `Origin` no WebSocket |
| Navegador | CSP restritiva, `nosniff`, `frame-ancestors 'none'`, `Permissions-Policy`, HSTS sob HTTPS; só `public/` é servido |

### Limitações conhecidas

- A expulsão bane o **identificador da aba**. Quem abrir outra aba/janela anônima pode tentar entrar de novo;
  para fechar de verdade, **tranque a sala** (ou use senha) depois de expulsar.
- O token de host fica no `localStorage` do navegador que criou a sala: limpar os dados do site ou trocar de navegador perde o controle.
- O servidor guarda presença em memória: roda em **uma instância**. Para várias instâncias seria preciso um broker (ex.: Redis).
- O SHA-256 que o cliente envia trafega pela rede: **use HTTPS** em produção.

## Configuração (variáveis de ambiente)

| Variável | Padrão | O que faz |
|---|---|---|
| `PORT` / `HOST` | `4173` / `0.0.0.0` | onde escutar |
| `DATA_FILE` | `data/data.json` | arquivo de salas e logs |
| `ROOM_TTL_HOURS` | `3` | validade de cada sala (1–24) |
| `MAX_PARTICIPANTS` | `50` | pessoas por sala (o host nunca fica de fora) |
| `MAX_ROOMS` | `500` | salas simultâneas |
| `MAX_CONN_PER_IP` | `25` | conexões WebSocket por IP |
| `TRUST_PROXY` | _(off)_ | `1` quando há proxy reverso: usa `X-Forwarded-For` para o IP real |
| `ALLOWED_ORIGINS` | _(só o próprio site)_ | origens extras aceitas no WebSocket, separadas por vírgula |
| `TLS_CERT` / `TLS_KEY` | _(off)_ | HTTPS embutido (alternativa ao proxy) |
| `STUN_URLS` | STUN do Google | servidores STUN, separados por vírgula |
| `TURN_URLS` | _(off)_ | ex.: `turn:turn.exemplo.com:3478,turns:turn.exemplo.com:5349?transport=tcp` |
| `TURN_SECRET` | | segredo do coturn (`use-auth-secret`): o servidor gera credenciais **temporárias** (6 h) |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | | alternativa: credencial TURN fixa |

> Atrás de um proxy, sem `TRUST_PROXY=1` todos os usuários parecem ter o mesmo IP e os limites de tentativa passam a valer para o grupo todo.

## Colocando no ar

1. **HTTPS é obrigatório** (o navegador bloqueia `getDisplayMedia` e `crypto.subtle` fora de HTTPS/`localhost`).
   O jeito mais simples é um proxy: `deploy/Caddyfile` faz HTTPS automático. Com nginx, lembre de repassar o WebSocket e o `Host`:
   ```nginx
   location / {
     proxy_pass http://127.0.0.1:4173;
     proxy_http_version 1.1;
     proxy_set_header Upgrade $http_upgrade;
     proxy_set_header Connection "upgrade";
     proxy_set_header Host $host;
     proxy_set_header X-Forwarded-For $remote_addr;
     proxy_read_timeout 120s;
   }
   ```
   Rode o Rise com `TRUST_PROXY=1`. Ou use `TLS_CERT`/`TLS_KEY` para HTTPS direto no Node.
2. **TURN**: sem ele, quem está atrás de NAT simétrico, firewall corporativo ou algumas redes 4G **não vê a transmissão**.
   Suba um coturn (`deploy/turnserver.conf`) e configure `TURN_URLS` + `TURN_SECRET` (o mesmo valor do `static-auth-secret`).
3. Docker: há um `Dockerfile` e um `deploy/docker-compose.yml` (Rise + Caddy + coturn) como ponto de partida.
   **Não foram testados** no ambiente em que este código foi escrito; ajuste domínios e segredos antes de usar.

## Limites e escalabilidade

Quem transmite **sobe um fluxo de vídeo por espectador**. Para manter isso viável:

- O app limita o bitrate de cada fluxo (`RTCRtpSender.setParameters`): 1080p ≈ 5 Mbps, 720p ≈ 2,5 Mbps, 480p ≈ 1,2 Mbps
  (menos em 30/24 fps). Em **Automática**, ~12 Mbps de upload são divididos entre os espectadores.
- Os **Ajustes** mostram a estimativa de upload e avisam quando passa de ~15 Mbps.
- Qualidade e FPS valem na hora, inclusive durante a transmissão.
- Na prática, **4 a 6 espectadores** em 1080p com uma conexão doméstica; mais que isso pede qualidade menor.
- Para plateias grandes, o passo seguinte é trocar a malha por um **SFU** (ex.: LiveKit, mediasoup): o servidor recebe um fluxo
  e distribui para todos. A sinalização e a camada de salas/permissões deste projeto continuam úteis.

## Testes

```bash
npm test             # 18 testes de servidor (node:test, sem dependências)
npm i                # instala eslint e playwright (só desenvolvimento)
npm run lint
npm run test:e2e     # navegador real: cria sala, entra com senha, transmite, permissão, expulsão
```

Os testes de servidor cobrem senha e sala trancada no WebSocket, presença forjada, permissões e expulsão só do host,
roteamento de sinais, banimento, lotação, limite de tentativas, validação de `Origin`, estáticos e credenciais TURN temporárias.
O teste e2e simula a captura de tela com um `<canvas>` e confere que vídeo **e** áudio chegam ao outro navegador.

## Estrutura

```
server.js            entrada
lib/
  app.js             HTTP, RPCs, estáticos, cabeçalhos de segurança
  hub.js             sala em tempo real: autenticação, presença, permissões, relay de sinais
  ws.js              WebSocket (RFC 6455) mínimo
  store.js           salas e logs em JSON (gravação atômica)
  security.js        scrypt, limites de taxa, códigos
  ice.js             STUN/TURN (credenciais temporárias)
  config.js          variáveis de ambiente
public/              interface (HTML/CSS/JS, módulos ES, sem build)
test/                testes de servidor e e2e
deploy/              Caddy, coturn, docker-compose (exemplos)
```
