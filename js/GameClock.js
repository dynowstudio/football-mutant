/* ═══════════════════════════════════════════
   GameClock — horloge virtuelle + programme journalier
   ═══════════════════════════════════════════ */

const GameClock = (() => {

  let _offsetMs = 0;   // ajouté au temps réel pour simuler une heure différente

  // Programme journalier (ordre chronologique)
  const SCHEDULE = [
    { id: 'MERCATO_OPEN',  h: 12, m:  0, label: 'Ouverture Mercato', icon: '🛒' },
    { id: 'MERCATO_CLOSE', h: 20, m:  0, label: 'Fermeture Mercato', icon: '🔒' },
    { id: 'MATCH_START',   h: 20, m: 30, label: 'Coup d\'envoi',     icon: '⚽' },
  ];

  // ── Temps actuel (virtuel) ──────────────────────────────────────────────────
  function now() {
    return new Date(Date.now() + _offsetMs);
  }

  // ── Prochain événement à venir ─────────────────────────────────────────────
  function nextEvent() {
    const cur = now();
    for (const ev of SCHEDULE) {
      const t = _todayAt(ev.h, ev.m);
      if (t > cur) return { ...ev, time: t, msLeft: t - cur };
    }
    // Tous passés aujourd'hui → premier événement demain
    const d = now();
    const tom = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    const ev  = SCHEDULE[0];
    const t   = new Date(tom.getFullYear(), tom.getMonth(), tom.getDate(), ev.h, ev.m, 0);
    return { ...ev, time: t, msLeft: t - now() };
  }

  // ── Période courante ────────────────────────────────────────────────────────
  // WAITING   → avant 12:00
  // MERCATO   → 12:00 – 20:00
  // PRE_MATCH → 20:00 – 20:30
  // MATCH_TIME → 20:30+
  function currentPeriod() {
    const d    = now();
    const mins = d.getHours() * 60 + d.getMinutes();
    if (mins >= 720  && mins < 1200) return 'MERCATO';
    if (mins >= 1200 && mins < 1230) return 'PRE_MATCH';
    if (mins >= 1230)                return 'MATCH_TIME';
    return 'WAITING';
  }

  // ── Admin : avancer juste après le prochain événement (mode hors ligne) ────
  function skipToNext() {
    const ms = nextEvent().msLeft;
    _offsetMs += ms + 1500;   // atterrir 1,5 s après l'événement
  }

  // ── Synchroniser l'offset depuis le serveur ──────────────────────────────
  function setOffset(ms) {
    _offsetMs = ms || 0;
  }

  function getOffset() {
    return _offsetMs;
  }

  // ── Utilitaires ────────────────────────────────────────────────────────────
  function _todayAt(h, m) {
    const d = now();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0);
  }

  function _pad(n) { return String(n).padStart(2, '0'); }

  function formatCountdown(ms) {
    if (ms <= 0) return '00m 00s';
    const s   = Math.floor(ms / 1000);
    const h   = Math.floor(s / 3600);
    const min = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${_pad(min)}m ${_pad(sec)}s`;
    return `${_pad(min)}m ${_pad(sec)}s`;
  }

  function formatTime(date) {
    return `${_pad(date.getHours())}:${_pad(date.getMinutes())}:${_pad(date.getSeconds())}`;
  }

  return { now, nextEvent, currentPeriod, skipToNext, setOffset, getOffset, formatCountdown, formatTime, SCHEDULE };

})();
