// Configuração opcional do navegador. O normal é não mexer aqui:
// STUN/TURN vêm do servidor (/api/config), configurados por variáveis de ambiente (veja o README).
window.RISE_CONFIG = {
  // Usado somente se /api/config não responder.
  ICE_SERVERS: [
    { urls: 'stun:stun.l.google.com:19302' }
  ]
};
