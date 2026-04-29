/* ═══════════════════════════════════════════
   Network — couche réseau client
   Gère la communication avec le serveur
   (REST + Socket.io)
   ═══════════════════════════════════════════ */

const Network = (() => {

  let _token   = null;
  let _user    = null;   // { id, username, isAdmin }
  let _socket  = null;
  let _online  = false;

  const _handlers = {};   // event → callback

  // ── Événements internes ────────────────────────────────────────────────────
  function on(event, fn) {
    _handlers[event] = fn;
  }

  function _fire(event, data) {
    if (_handlers[event]) _handlers[event](data);
  }

  // ── Helpers HTTP ────────────────────────────────────────────────────────────
  async function _req(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (_token) headers['Authorization'] = 'Bearer ' + _token;

    const opts = { method, headers };
    if (body !== undefined) opts.body = JSON.stringify(body);

    const res  = await fetch(path, opts);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Erreur serveur');
    return json;
  }

  // ── Disponibilité du serveur ────────────────────────────────────────────────
  async function ping() {
    try {
      const r = await fetch('/api/ping', { method: 'GET' });
      _online = r.ok;
      return r.ok;
    } catch {
      _online = false;
      return false;
    }
  }

  // ── Session persistante ────────────────────────────────────────────────────
  function restoreSession() {
    const t = localStorage.getItem('fm_token');
    const u = localStorage.getItem('fm_user');
    if (t && u) {
      _token = t;
      try { _user = JSON.parse(u); } catch { return null; }
      _connectSocket();
      return _user;
    }
    return null;
  }

  function _saveSession(data) {
    _token = data.token;
    _user  = { id: data.id, username: data.username, isAdmin: data.isAdmin };
    localStorage.setItem('fm_token', _token);
    localStorage.setItem('fm_user', JSON.stringify(_user));
  }

  // ── Auth ───────────────────────────────────────────────────────────────────
  async function register(username, password) {
    const data = await _req('POST', '/api/register', { username, password });
    _saveSession(data);
    _connectSocket();
    return _user;
  }

  async function login(username, password) {
    const data = await _req('POST', '/api/login', { username, password });
    _saveSession(data);
    _connectSocket();
    return _user;
  }

  async function verifyToken() {
    if (!_token) return null;
    try {
      const data = await _req('GET', '/api/me');
      _user = { id: data.id, username: data.username, isAdmin: data.isAdmin };
      localStorage.setItem('fm_user', JSON.stringify(_user));
      return _user;
    } catch {
      // Token invalide/expiré
      logout();
      return null;
    }
  }

  function logout() {
    _token  = null;
    _user   = null;
    localStorage.removeItem('fm_token');
    localStorage.removeItem('fm_user');
    if (_socket) { _socket.disconnect(); _socket = null; }
  }

  // ── Lobby ──────────────────────────────────────────────────────────────────
  function getLobby()         { return _req('GET',  '/api/lobby'); }
  function claim(teamIndex)   { return _req('POST', '/api/claim',   { teamIndex }); }
  function unclaim()          { return _req('POST', '/api/unclaim'); }

  // ── Saison ────────────────────────────────────────────────────────────────
  function startSeason(leagueJson) {
    return _req('POST', '/api/start-season', { leagueJson });
  }
  function resetSeason() {
    return _req('POST', '/api/reset-season');
  }

  // ── État du jeu ────────────────────────────────────────────────────────────
  function getGameState()             { return _req('GET',  '/api/game-state'); }
  function pushGameState(leagueJson)  { return _req('POST', '/api/game-state', { leagueJson }); }
  function sendMercatoAction(action)  { return _req('POST', '/api/mercato-action', action); }

  // ── Carte atout ───────────────────────────────────────────────────────────
  function setTrumpCard(cardId) { return _req('POST', '/api/trump-card', { cardId }); }

  // ── Match serveur ──────────────────────────────────────────────────────────
  function startServerMatch() { return _req('POST', '/api/match/start'); }

  // ── Admin : avancer le temps au prochain événement ────────────────────────
  function skipTime() { return _req('POST', '/api/admin/skip-time'); }

  // ── Enchères ───────────────────────────────────────────────────────────────
  function getMercatoPool() { return _req('GET', '/api/mercato/pool'); }
  function placeBid(playerId, amount, rosterSlot) {
    return _req('POST', '/api/mercato/bid', { playerId, amount, rosterSlot });
  }
  function resolveMercato() { return _req('POST', '/api/mercato/resolve'); }

  // ── Socket.io ──────────────────────────────────────────────────────────────
  function _connectSocket() {
    if (_socket) _socket.disconnect();

    // socket.io est chargé depuis /socket.io/socket.io.js (servi par le serveur)
    if (typeof io === 'undefined') {
      // Socket.io pas encore chargé — réessayer après le chargement complet de la page
      window.addEventListener('load', _connectSocket, { once: true });
      return;
    }

    _socket = io({ auth: { token: _token } });

    _socket.on('connect',           ()  => console.log('🔌 Socket connecté'));
    _socket.on('disconnect',        ()  => console.log('🔌 Socket déconnecté'));
    _socket.on('lobby_update',      d   => _fire('lobby_update',      d));
    _socket.on('season_started',    d   => _fire('season_started',    d));
    _socket.on('game_state_updated',d   => _fire('game_state_updated',d));
    _socket.on('mercato_action',    d   => _fire('mercato_action',    d));
    _socket.on('season_reset',      ()  => _fire('season_reset',      {}));
    _socket.on('bid_update',        d   => _fire('bid_update',        d));
    _socket.on('mercato_pool',      d   => _fire('mercato_pool',      d));
    _socket.on('mercato_resolved',  d   => _fire('mercato_resolved',  d));
    _socket.on('time_updated',      d   => _fire('time_updated',      d));
    _socket.on('match_start',       d   => _fire('match_start',       d));
    _socket.on('match_tick',        d   => _fire('match_tick',        d));
    _socket.on('match_event',       d   => _fire('match_event',       d));
    _socket.on('match_halftime',    d   => _fire('match_halftime',    d));
    _socket.on('match_end',         d   => _fire('match_end',         d));
  }

  // ── Accesseurs ─────────────────────────────────────────────────────────────
  function getUser()    { return _user; }
  function isLoggedIn() { return !!_token; }
  function isOnline()   { return _online; }

  return {
    ping, restoreSession, verifyToken,
    register, login, logout,
    getLobby, claim, unclaim,
    startSeason, resetSeason,
    getGameState, pushGameState, sendMercatoAction,
    setTrumpCard,
    getMercatoPool, placeBid, resolveMercato,
    startServerMatch, skipTime,
    on, getUser, isLoggedIn, isOnline,
  };

})();
