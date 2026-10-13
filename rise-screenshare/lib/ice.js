'use strict';

const crypto = require('node:crypto');

const TURN_TTL_SECONDS = 6 * 3600;

/**
 * Lista de ICE servers entregue ao navegador.
 * TURN com TURN_SECRET usa credenciais temporárias (coturn `use-auth-secret`),
 * então nada permanente fica exposto no navegador.
 */
function iceServers(cfg, uid = 'rise') {
  const servers = [{ urls: cfg.stunUrls }];

  if (cfg.turnUrls.length) {
    if (cfg.turnSecret) {
      const username = `${Math.floor(Date.now() / 1000) + TURN_TTL_SECONDS}:${String(uid).slice(0, 64)}`;
      const credential = crypto.createHmac('sha1', cfg.turnSecret).update(username).digest('base64');
      servers.push({ urls: cfg.turnUrls, username, credential });
    } else if (cfg.turnUsername && cfg.turnCredential) {
      servers.push({ urls: cfg.turnUrls, username: cfg.turnUsername, credential: cfg.turnCredential });
    }
  }
  return servers;
}

module.exports = { iceServers };
