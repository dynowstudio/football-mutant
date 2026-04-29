/* ═══════════════════════════════════════════
   main.js — bootstrap, state machine, game loop
   ═══════════════════════════════════════════ */

// ── Deterministic match seed (same for all clients watching the same fixture) ─
// Uses FNV-1a on "matchday:homeId:awayId" so the seed never collides across
// different days or different match-ups.
function _computeMatchSeed(matchday, homeId, awayId) {
  let h = 0x811c9dc5;
  const s = String(matchday) + ':' + homeId + ':' + awayId;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h;
}

// ── Gold rewards ─────────────────────────────────────────────────────────────
const CUP_REWARDS = {
  QF_WIN:     150,
  SF_WIN:     250,
  SF_LOSS:    100,   // consolation for semi-finalists
  FINAL_WIN:  600,
  FINAL_LOSS: 200,
};

// ── Global game state ────────────────────────────────────────────────────────
const Game = {
  phase:         'STANDINGS', // STANDINGS | MERCATO | FORMATION | TRAINING | MATCH | REWARDS | CUP | CUP_MATCH | TRAINING_MATCH | REPLAY | SEASON_END | LOBBY | LOGIN
  todaySchedule: { dateStr: '', mercatoOpened: false, formationOpened: false, matchStarted: false },
  league:        null,
  match:         null,
  humanFixture:  null,
  cupFixture:    null,
  lastSalaryReports: [],
  lastInjuryReports: [],
  _injuredBackup: [],
  rafId:         null,
  lastTimestamp: 0,
  accumulator:   0,
  speedDouble:   false,
  // ── Multijoueur ──
  isOnline:      false,   // true si connecté à un serveur
  myTeamIndex:  -1,       // index dans TEAM_DEFS de l'équipe revendiquée (-1 = aucune)
  _formationOrigin: null,
  lastMatchReplayData: null,  // { homeTeam, awayTeam, matchday, seed } — pour rediffusion
};

// ── Initialise game ──────────────────────────────────────────────────────────
function initGame() {
  _teamIdCounter = 0;

  const teams = TEAM_DEFS.map((def) => {
    const roster = buildStartingRoster(def.isHuman);
    return createTeam(def, roster);
  });

  Game.league = createLeague(teams);

  const allPlayers = PLAYERS_DB.map(p => clonePlayer(p));
  _assignPlayersToAITeams(teams, allPlayers, Game.league);
  Game.league.freePlayerPool = allPlayers.filter(p => !p.teamId);

  StandingsUI.render(Game.league);
  StandingsUI.updateHeader(Game.league);
  ScreenManager.show('standings');
}

function buildStartingRoster(isHuman) {
  if (isHuman) {
    return [
      createFreeTierPlayer('ATTACKER'),
      createFreeTierPlayer('ATTACKER'),
      createFreeTierPlayer('DEFENDER'),
      createFreeTierPlayer('GOALKEEPER'),
    ];
  }
  return [];
}

function _assignPlayersToAITeams(teams, allPlayers, league) {
  const aiTeams = teams.filter(t => !t.isHuman);
  const pools = { ATTACKER: [], DEFENDER: [], GOALKEEPER: [] };
  allPlayers.forEach(p => pools[p.role].push(p));
  Object.values(pools).forEach(arr => arr.sort((a, b) => playerAvgStat(a) - playerAvgStat(b)));

  const cursors = {
    ATTACKER:   Math.floor(pools.ATTACKER.length   * 0.20),
    DEFENDER:   Math.floor(pools.DEFENDER.length   * 0.20),
    GOALKEEPER: Math.floor(pools.GOALKEEPER.length * 0.20),
  };

  aiTeams.forEach(team => {
    const getNext = (role) => {
      const pool = pools[role];
      const p    = pool[cursors[role]++];
      if (!p) return createFreeTierPlayer(role);
      p.teamId = team.id;
      return p;
    };
    team.roster = [
      getNext('ATTACKER'),
      getNext('ATTACKER'),
      getNext('DEFENDER'),
      getNext('GOALKEEPER'),
    ];
  });
}

// ── Phase: STANDINGS → MERCATO ───────────────────────────────────────────────
function startMatchday() {
  if (Game.league.currentMatchday >= 11) return;
  Game.phase = 'MERCATO';
  _lastPhaseBarState = null;   // force reset pour quand on revient au classement

  // Mode hors ligne uniquement : le mercato IA tourne localement.
  // En ligne, le serveur exécute le mercato IA lors de la résolution des enchères.
  if (!Game.isOnline) {
    Mercato.runAIMercato(Game.league);
  }

  MercatoUI.open(Game.league, Game.isOnline);
  StandingsUI.updateHeader(Game.league);
  ScreenManager.show('mercato');
}

// ── Phase: MERCATO → FORMATION ───────────────────────────────────────────────
async function startFormation() {
  // Empêcher les appels en double
  if (Game.phase === 'FORMATION') return;
  Game.phase = 'FORMATION';   // fixé de façon synchrone pour éviter les re-entrées

  if (Game.isOnline) {
    // Résoudre les enchères UNIQUEMENT si le mercato est officiellement fermé (≥ 20h).
    // Si le joueur navigue vers la formation avant 20h, les enchères restent ouvertes.
    const nowMins = GameClock.now().getHours() * 60 + GameClock.now().getMinutes();
    if (nowMins >= 1200) {
      try {
        const { leagueJson } = await Network.resolveMercato();
        if (leagueJson) _applyMercatoResolution(leagueJson);
      } catch (e) {
        console.warn('resolveMercato échoué, on continue avec l\'état local :', e);
      }
    }
  } else {
    _syncStateToServer();
  }

  FormationUI.open(Game.league);

  const isTraining = Game._formationOrigin === 'TRAINING';
  const btn     = document.getElementById('btn-confirm-formation');
  const timebar = document.getElementById('formation-time-bar');

  if (btn)     btn.textContent = isTraining ? '✔ Confirmer et jouer !' : '💾 Sauvegarder ma formation';
  if (timebar) timebar.style.display = isTraining ? 'none' : 'flex';

  ScreenManager.show('formation');
}

/**
 * Applique la résolution du mercato reçue du serveur :
 * met à jour gold + roster de toutes les équipes et le pool libre.
 * N'écrase pas les stats de match ni les formations existantes.
 */
function _applyMercatoResolution(leagueJson) {
  let remote;
  try { remote = JSON.parse(leagueJson); } catch { return; }

  remote.teams.forEach((rTeam, idx) => {
    const local = Game.league.teams[idx];
    if (!local) return;
    local.gold   = rTeam.gold;
    local.roster = rTeam.roster;
    // isHuman conservé côté local
  });

  Game.league.freePlayerPool = remote.freePlayerPool;
}

// ── Phase: FORMATION → sauvegarde (ou TRAINING_MATCH immédiat) ───────────────
function confirmFormation() {
  FormationUI.confirm();   // sauvegarde les positions sur human.formation
  if (Game._formationOrigin === 'TRAINING') {
    Game._formationOrigin = null;
    launchTrainingMatch();
  } else {
    // Match normal : juste sauvegarder, le match démarre à 20h30 automatiquement
    const btn = document.getElementById('btn-confirm-formation');
    if (btn) {
      const prev = btn.textContent;
      btn.textContent = '✓ Formation sauvegardée !';
      btn.style.background = '#22c55e';
      setTimeout(() => { btn.textContent = prev; btn.style.background = ''; }, 2000);
    }
  }
}

// ── Phase: MERCATO/FORMATION → MATCH ─────────────────────────────────────────
function startMatch() {
  Game.phase = 'MATCH';

  const day = Game.league.currentMatchday;

  if (Game.isOnline) {
    // ── Mode en ligne : le serveur simule et diffuse le match ──────────────
    // Si l'utilisateur a une équipe revendiquée, préparer le DOM maintenant.
    // Sinon (spectateur), on attend match_start pour préparer le DOM.
    if (Game.myTeamIndex >= 0) {
      const fixture  = getHumanFixture(Game.league, day);
      Game.humanFixture = fixture;
      _backupAndReplaceInjured();
      if (fixture) {
        try {
          const homeTeam = getTeamById(Game.league, fixture.homeId);
          const awayTeam = getTeamById(Game.league, fixture.awayId);
          _setupMatchDOM(homeTeam, awayTeam);
        } catch (e) {
          console.warn('startMatch: _setupMatchDOM failed:', e.message);
        }
      }
    }
    // Demander au serveur de démarrer (il quick-sime les autres fixtures aussi)
    Network.startServerMatch()
      .then(r => console.log('[Match] startServerMatch réponse:', r))
      .catch(err => console.error('[Match] startServerMatch erreur:', err));
    // Le rendu démarrera à la réception de match_start (socket event)
    return;
  }

  const fixture = getHumanFixture(Game.league, day);
  Game.humanFixture = fixture;

  // Back up injured human players
  _backupAndReplaceInjured();

  const homeTeam = getTeamById(Game.league, fixture.homeId);
  const awayTeam = getTeamById(Game.league, fixture.awayId);

  // ── Mode hors ligne : simulation locale ───────────────────────────────────
  getMatchdayFixtures(Game.league, day).forEach(f => {
    if (f === fixture) return;
    const h = getTeamById(Game.league, f.homeId);
    const a = getTeamById(Game.league, f.awayId);
    const result = quickSim(h, a);
    f.homeScore = result.homeScore;
    f.awayScore = result.awayScore;
    accumulateMatchStats(Game.league, result.goalEvents || []);
    applyResult(Game.league, f);
  });

  _setupMatchDOM(homeTeam, awayTeam);
  const _seed1 = _computeMatchSeed(Game.league.currentMatchday, homeTeam.id, awayTeam.id);
  Game.match = createMatchState(homeTeam, awayTeam, _seed1);
  MatchRenderer.resetAnims();

  ScreenManager.show('match');
  document.body.classList.add('match-mode');
  startMatchLoop();
}

// ── Construire l'état de rendu depuis les données serveur (match_start) ───────
function _buildOnlineMatchState(data) {
  return {
    matchId:      data.matchId,   // identifiant unique du match (homeId:awayId)
    homeTeam:     data.homeTeam,
    awayTeam:     data.awayTeam,
    agents:       data.agents.map(a => ({
      ...a, vx: 0, vy: 0,
      _tx: a.x, _ty: a.y,   // positions cibles pour interpolation
      knockdownTimer: 0, punchTimer: 0, punchArm: 1,
    })),
    ball: { x: 340, y: 220, _tx: 340, _ty: 220, vx: 0, vy: 0,
            owner: null, lastOwner: null, trail: [], TRAIL_LEN: 7,
            spinAngle: 0, lastOwnerTimer: 0, lastPasser: null },
    homeScore: 0, awayScore: 0,
    tick: 0, simMinutes: 0,
    state: 'ACTIVE', pauseTimer: 0, halfTimeDone: false,
    possessionA: 0, possessionB: 0,
    events: [], particles: [],
    shakeX: 0, shakeY: 0, shakeTimer: 0,
    speedMult: 1,
    _snapBuffer: [], replaySnapshot: null, lastGoalInfo: null,
    savesHome: 0, savesAway: 0,
  };
}

// ── Appliquer un tick serveur sur Game.match (match_tick) ──────────────────────
function _applyMatchTick(data) {
  const ms = Game.match;
  if (!ms) return;

  ms.tick         = data.t;
  ms.state        = data.s;
  ms.pauseTimer   = data.pt;
  ms.homeScore    = data.hs;
  ms.awayScore    = data.aws;
  ms.simMinutes   = data.sm;
  ms.possessionA  = data.pa;
  ms.possessionB  = data.pb;
  ms.halfTimeDone = data.htd === 1;

  // Stocker la position serveur comme CIBLE (pas de snap direct)
  ms.ball._tx = data.b.x;
  ms.ball._ty = data.b.y;
  ms.ball.vx  = data.b.vx;
  ms.ball.vy  = data.b.vy;

  // Mettre à jour les agents (positions cibles + vélocités)
  data.a.forEach(([id, x, y, vx, vy, hasBall, kd, pt, pa]) => {
    const agent = ms.agents.find(a => a.id === id);
    if (!agent) return;
    agent._tx = x; agent._ty = y;   // cible interpolée
    agent.vx  = vx; agent.vy  = vy;
    agent.hasBall        = hasBall === 1;
    agent.knockdownTimer = kd;
    agent.punchTimer     = pt;
    agent.punchArm       = pa;
  });

  // Reconstruire ball.owner (null ou l'agent qui a le ballon)
  ms.ball.owner = ms.agents.find(a => a.hasBall) || null;
}

// ── Phase: CUP — start cup after matchday 5 ──────────────────────────────────
function startCup() {
  Game.phase = 'CUP';
  const cup    = Game.league.cup;
  const sorted = getSortedStandings(Game.league);

  cup.teams = sorted.slice(0, 8);

  // QF seeding: 1v8, 2v7, 3v6, 4v5
  cup.QF = [
    _makeCupFixture(cup.teams[0], cup.teams[7]),
    _makeCupFixture(cup.teams[1], cup.teams[6]),
    _makeCupFixture(cup.teams[2], cup.teams[5]),
    _makeCupFixture(cup.teams[3], cup.teams[4]),
  ];
  cup.round      = 'QF';
  cup.roundState = 'PRE';

  StandingsUI.updateHeader(Game.league);
  CupUI.open(Game.league);
}

function _makeCupFixture(home, away) {
  return { homeId: home.id, awayId: away.id, homeScore: null, awayScore: null, winnerId: null, penalties: false };
}

// ── Cup: play the current round ────────────────────────────────────────────
function playCupRound() {
  const cup    = Game.league.cup;
  const league = Game.league;
  const human  = league.teams.find(t => t.isHuman);

  const fixtures = cup.round === 'FINAL' ? [cup.FINAL] : cup[cup.round];

  // Find the human's fixture in this round (if any)
  const humanFixture = fixtures.find(
    f => f && (f.homeId === human.id || f.awayId === human.id)
  );

  // Simulate all non-human fixtures instantly
  fixtures.forEach(f => {
    if (!f || f === humanFixture) return;
    _simCupFixture(f, league);
  });

  if (humanFixture) {
    // Play human fixture visually
    Game.cupFixture = humanFixture;
    Game.phase = 'CUP_MATCH';

    _backupAndReplaceInjured();

    const homeTeam = getTeamById(league, humanFixture.homeId);
    const awayTeam = getTeamById(league, humanFixture.awayId);

    _setupMatchDOM(homeTeam, awayTeam);
    const _seedCup = _computeMatchSeed(1000 + Game.league.currentMatchday, homeTeam.id, awayTeam.id);
    Game.match = createMatchState(homeTeam, awayTeam, _seedCup);
    MatchRenderer.resetAnims();

    ScreenManager.show('match');
    document.body.classList.add('match-mode');
    startMatchLoop();
  } else {
    // Human not in this round — all matches already simulated
    _onCupRoundEnd();
  }
}

function _simCupFixture(f, league) {
  const h = getTeamById(league, f.homeId);
  const a = getTeamById(league, f.awayId);
  const r = quickSim(h, a);
  f.homeScore = r.homeScore;
  f.awayScore = r.awayScore;
  if (f.homeScore === f.awayScore) {
    // Draw → penalty shootout
    f.penalties = true;
    f.winnerId  = Math.random() < 0.5 ? f.homeId : f.awayId;
  } else {
    f.winnerId = f.homeScore > f.awayScore ? f.homeId : f.awayId;
  }
}

// Called when human's cup match ends (FULL_TIME from match loop)
function onCupMatchEnd() {
  document.body.classList.remove('match-mode');
  const ms = Game.match;
  const f  = Game.cupFixture;

  f.homeScore = ms.homeScore;
  f.awayScore = ms.awayScore;

  if (f.homeScore === f.awayScore) {
    // Draw → penalty shootout
    f.penalties = true;
    f.winnerId  = Math.random() < 0.5 ? f.homeId : f.awayId;
    const winner = getTeamById(Game.league, f.winnerId);
    MatchRenderer.pushTicker(`🏆 Tirs au but — ${winner ? winner.name : '?'} s'impose !`);
  } else {
    f.winnerId = f.homeScore > f.awayScore ? f.homeId : f.awayId;
  }

  // Restore injured players
  _restoreInjuredBackup();

  Game.phase = 'CUP';
  _onCupRoundEnd();
}

// Called after all fixtures in a cup round are resolved
function _onCupRoundEnd() {
  const cup    = Game.league.cup;
  const league = Game.league;
  const human  = league.teams.find(t => t.isHuman);

  const fixtures = cup.round === 'FINAL' ? [cup.FINAL] : cup[cup.round];

  // ── Award gold ─────────────────────────────────────────────────────────────
  if (cup.round === 'QF') {
    fixtures.forEach(f => {
      const w = getTeamById(league, f.winnerId);
      if (w) w.gold += CUP_REWARDS.QF_WIN;
    });
    const hf = fixtures.find(f => f.homeId === human.id || f.awayId === human.id);
    if (hf) {
      cup.lastEarnings = hf.winnerId === human.id
        ? { teamId: human.id, amount: CUP_REWARDS.QF_WIN, reason: 'Victoire en quart de finale' }
        : { teamId: human.id, amount: 0,                  reason: 'Éliminé en quart de finale' };
    } else {
      cup.lastEarnings = { teamId: human.id, amount: 0, reason: 'Votre équipe n\'était pas qualifiée' };
    }

  } else if (cup.round === 'SF') {
    fixtures.forEach(f => {
      const w       = getTeamById(league, f.winnerId);
      const loserId = f.homeId === f.winnerId ? f.awayId : f.homeId;
      const l       = getTeamById(league, loserId);
      if (w) w.gold += CUP_REWARDS.SF_WIN;
      if (l) l.gold += CUP_REWARDS.SF_LOSS;
    });
    const hf = fixtures.find(f => f.homeId === human.id || f.awayId === human.id);
    if (hf) {
      cup.lastEarnings = hf.winnerId === human.id
        ? { teamId: human.id, amount: CUP_REWARDS.SF_WIN,  reason: 'Victoire en demi-finale' }
        : { teamId: human.id, amount: CUP_REWARDS.SF_LOSS, reason: 'Demi-finaliste de la Coupe' };
    }

  } else if (cup.round === 'FINAL') {
    const f       = cup.FINAL;
    const w       = getTeamById(league, f.winnerId);
    const loserId = f.homeId === f.winnerId ? f.awayId : f.homeId;
    const l       = getTeamById(league, loserId);
    if (w) w.gold += CUP_REWARDS.FINAL_WIN;
    if (l) l.gold += CUP_REWARDS.FINAL_LOSS;
    cup.champion = w;
    cup.done     = true;

    if (f.homeId === human.id || f.awayId === human.id) {
      cup.lastEarnings = f.winnerId === human.id
        ? { teamId: human.id, amount: CUP_REWARDS.FINAL_WIN,  reason: '🏆 Champion de la Coupe !' }
        : { teamId: human.id, amount: CUP_REWARDS.FINAL_LOSS, reason: 'Finaliste de la Coupe' };
    }
  }

  cup.roundState = 'POST';
  StandingsUI.updateHeader(league);
  CupUI.open(league);
}

// Advance to next cup round (or back to standings when cup is done)
function advanceCupRound() {
  const cup = Game.league.cup;

  if (cup.done) {
    Game.phase = 'STANDINGS';
    _lastPhaseBarState = null;
    StandingsUI.render(Game.league);
    StandingsUI.updateHeader(Game.league);
    ScreenManager.show('standings');
    return;
  }

  // Build next round's bracket
  cup.lastEarnings = null;

  if (cup.round === 'QF') {
    cup.SF = [
      _makeCupFixture(
        getTeamById(Game.league, cup.QF[0].winnerId),
        getTeamById(Game.league, cup.QF[3].winnerId)
      ),
      _makeCupFixture(
        getTeamById(Game.league, cup.QF[1].winnerId),
        getTeamById(Game.league, cup.QF[2].winnerId)
      ),
    ];
    cup.round = 'SF';
  } else if (cup.round === 'SF') {
    cup.FINAL = _makeCupFixture(
      getTeamById(Game.league, cup.SF[0].winnerId),
      getTeamById(Game.league, cup.SF[1].winnerId)
    );
    cup.round = 'FINAL';
  }

  cup.roundState = 'PRE';
  CupUI.open(Game.league);
}

// ── Match game loop ───────────────────────────────────────────────────────────
function startMatchLoop() {
  if (Game.rafId) cancelAnimationFrame(Game.rafId);
  Game.lastTimestamp = performance.now();
  Game.accumulator   = 0;

  // State for offline event detection (online events come via socket)
  let lastGoalCount = 0;
  let halftimeDone  = false;

  function frame(timestamp) {
    if (Game.phase !== 'MATCH' && Game.phase !== 'CUP_MATCH' && Game.phase !== 'TRAINING_MATCH' && Game.phase !== 'REPLAY') return;
    if (!Game.match) { Game.rafId = requestAnimationFrame(frame); return; }

    const delta  = timestamp - Game.lastTimestamp;
    Game.lastTimestamp = timestamp;

    // ── Simulation locale (hors ligne ou CUP/TRAINING en ligne) ──────────────
    const isLocalSim = !Game.isOnline || Game.phase === 'CUP_MATCH' || Game.phase === 'TRAINING_MATCH' || Game.phase === 'REPLAY';
    if (isLocalSim) {
      const TICK_MS = 1000 / TICKS_PER_SECOND;
      Game.accumulator += Math.min(delta, 100);

      while (Game.accumulator >= TICK_MS) {
        if (!MatchRenderer.isReplaying()) matchTick(Game.match);
        Game.accumulator -= TICK_MS;

        // Detect new goals / events
        if (Game.match.events.length > lastGoalCount) {
          const newEvents = Game.match.events.slice(lastGoalCount);
          newEvents.forEach(ev => {
            if (ev.type === 'GOAL') {
              const team    = ev.teamIndex === 0 ? Game.match.homeTeam : Game.match.awayTeam;
              const scorerN = ev.scorer ? ev.scorer.name : '?';
              MatchRenderer.triggerGoalFlash(team.color);
              MatchRenderer.triggerGoalAnim(team.color, `⚽ BUT !`);
              MatchRenderer.pushTicker(`⚽ ${ev.minute}' — ${scorerN} (${team.name})`);
              if (Game.match.replaySnapshot) {
                MatchRenderer.triggerReplay(Game.match.replaySnapshot);
                Game.match.replaySnapshot = null;
              }
            }
            if (ev.type === 'LONG_SHOT') {
              const lastName = n => n ? n.split(' ').pop() : '?';
              MatchRenderer.pushTicker(`🚀 ${ev.minute}' — ${lastName(ev.name)} tente sa chance de loin !`);
            }
            if (ev.type === 'PUNCH') {
              const lastName = n => n ? n.split(' ').pop() : '?';
              const msg = ev.ko
                ? `🥊 ${ev.minute}' — ${lastName(ev.name)} met ${lastName(ev.targetName)} au sol !`
                : `🥊 ${ev.minute}' — ${lastName(ev.name)} tente un coup sur ${lastName(ev.targetName)} !`;
              MatchRenderer.pushTicker(msg);
            }
          });
          lastGoalCount = Game.match.events.length;
        }

        if (Game.match.state === 'HALFTIME' && !halftimeDone) {
          halftimeDone = true;
          MatchRenderer.showHalftimeOverlay(Game.match);
        }

        if (Game.match.state === 'FULL_TIME') break;
      }
    }

    // ── Interpolation côté client (mode en ligne) ─────────────────────────────
    // Le serveur envoie ~20 fps. On lerp chaque frame vers la cible serveur
    // pour un rendu fluide 60 fps sans téléportation visible.
    if (Game.isOnline && Game.phase === 'MATCH' && Game.match && Game.match.state === 'ACTIVE') {
      const ms   = Game.match;
      const BALL_LERP  = 0.6;   // convergence en ~3 frames (= 1 intervalle serveur)
      const AGENT_LERP = 0.5;

      // Balle
      if (!ms.ball.owner) {
        const tx = ms.ball._tx !== undefined ? ms.ball._tx : ms.ball.x;
        const ty = ms.ball._ty !== undefined ? ms.ball._ty : ms.ball.y;
        ms.ball.x += (tx - ms.ball.x) * BALL_LERP;
        ms.ball.y += (ty - ms.ball.y) * BALL_LERP;
      } else {
        // Ballon porté : on lerp vers le porteur (déjà lerpé lui-même)
        ms.ball.x += (ms.ball.owner.x - ms.ball.x) * BALL_LERP;
        ms.ball.y += (ms.ball.owner.y - ms.ball.y) * BALL_LERP;
      }

      // Joueurs
      ms.agents.forEach(a => {
        if (a.knockdownTimer > 0) return;
        const tx = a._tx !== undefined ? a._tx : a.x;
        const ty = a._ty !== undefined ? a._ty : a.y;
        a.x += (tx - a.x) * AGENT_LERP;
        a.y += (ty - a.y) * AGENT_LERP;
      });
    }

    // ── Rendu Three.js ────────────────────────────────────────────────────────
    MatchRenderer.render(null, Game.match);
    MatchRenderer.updateDOM(Game.match);

    if (Game.match.state === 'FULL_TIME') {
      // En ligne : c'est match_end socket qui gère la suite
      if (Game.isOnline && Game.phase === 'MATCH') return;
      if (Game.phase === 'CUP_MATCH') {
        onCupMatchEnd();
      } else if (Game.phase === 'TRAINING_MATCH') {
        onTrainingMatchEnd();
      } else if (Game.phase === 'REPLAY') {
        onReplayEnd();
      } else {
        onMatchEnd();
      }
      return;
    }

    Game.rafId = requestAnimationFrame(frame);
  }

  Game.rafId = requestAnimationFrame(frame);
}

// ── Match end → REWARDS ───────────────────────────────────────────────────────
function onMatchEnd() {
  document.body.classList.remove('match-mode');
  Game.phase = 'REWARDS';
  const ms = Game.match;
  const f  = Game.humanFixture;

  f.homeScore = ms.homeScore;
  f.awayScore = ms.awayScore;
  applyResult(Game.league, f);

  const human    = Game.league.teams.find(t => t.isHuman);
  const isHome   = f.homeId === human.id;
  const myScore  = isHome ? f.homeScore : f.awayScore;
  const oppScore = isHome ? f.awayScore : f.homeScore;
  const reward   = myScore > oppScore ? 400 : myScore < oppScore ? 150 : 200;
  human.gold += reward;

  // Award AI teams gold
  Game.league.teams.forEach(team => {
    if (team.isHuman) return;
    const tf = getMatchdayFixtures(Game.league, Game.league.currentMatchday).find(
      fi => fi.homeId === team.id || fi.awayId === team.id
    );
    if (!tf || tf.homeScore == null) return;
    const tHome = tf.homeId === team.id;
    const ts = tHome ? tf.homeScore : tf.awayScore;
    const to = tHome ? tf.awayScore : tf.homeScore;
    team.gold += ts > to ? 400 : ts < to ? 150 : 200;
  });

  // Restore injured players
  _restoreInjuredBackup();

  const salaryReports  = Salary.processMatchday(Game.league);
  const injuryReports  = Salary.processInjuries(Game.league);
  Game.lastSalaryReports  = salaryReports;
  Game.lastInjuryReports  = injuryReports;

  Game.league.currentMatchday++;

  // Accumulate stats from the human match
  const _goalEvts = Game.match.events
    .filter(e => e.type === 'GOAL')
    .map(e => {
      const _team = e.teamIndex === 0 ? Game.match.homeTeam : Game.match.awayTeam;
      return {
        scorer:   e.scorer   ? { id: e.scorer.id,   name: e.scorer.name,   teamName: _team.name } : null,
        assister: e.assister ? { id: e.assister.id, name: e.assister.name, teamName: _team.name } : null,
      };
    });
  accumulateMatchStats(Game.league, _goalEvts);

  RewardsUI.render(Game.league, f, salaryReports, injuryReports, Game.match);
  StandingsUI.updateHeader(Game.league);
  ScreenManager.show('rewards');
  _setReplayBtnVisible(!!Game.lastMatchReplayData);

  // Synchroniser l'état avec le serveur après le match
  _syncStateToServer();
}

// ── Afficher / masquer les boutons "Revoir le match" ─────────────────────────
function _setReplayBtnVisible(visible) {
  const btn  = document.getElementById('btn-replay-match');
  const btn2 = document.getElementById('btn-standings-replay');
  if (btn)  btn.style.display  = visible ? '' : 'none';
  if (btn2) btn2.style.display = visible ? '' : 'none';
}

// ── Phase: REPLAY — lancer la rediffusion du dernier match ───────────────────
function replayLastMatch() {
  const rd = Game.lastMatchReplayData;
  if (!rd) return;

  const { homeTeam, awayTeam, seed } = rd;

  // Reconstruire un état de match local avec la même graine
  Game.match = createMatchState(homeTeam, awayTeam, seed);
  Game.match.speedMult = 2; // 2× par défaut pour ne pas rester trop longtemps

  // Réinitialiser DOM du match (noms, couleurs, score)
  _setupMatchDOM(homeTeam, awayTeam);
  MatchRenderer.resetAnims();

  Game.phase = 'REPLAY';
  ScreenManager.show('match');
  document.body.classList.add('match-mode');

  // Afficher le bandeau REDIFFUSION
  const banner = document.getElementById('replay-banner');
  if (banner) banner.style.display = 'flex';

  // Mettre le bouton vitesse en cohérence (on commence à ×2)
  const speedBtn = document.getElementById('btn-speed');
  if (speedBtn) speedBtn.textContent = '⚡ ×1';

  if (Game.rafId) cancelAnimationFrame(Game.rafId);
  Game.rafId = null;
  startMatchLoop();
}

// ── Fin de rediffusion → retour à l'écran précédent ──────────────────────────
function onReplayEnd() {
  document.body.classList.remove('match-mode');
  if (Game.rafId) { cancelAnimationFrame(Game.rafId); Game.rafId = null; }

  // Masquer le bandeau REDIFFUSION
  const banner = document.getElementById('replay-banner');
  if (banner) banner.style.display = 'none';

  // Réinitialiser bouton vitesse
  const speedBtn = document.getElementById('btn-speed');
  if (speedBtn) speedBtn.textContent = '⚡ ×2';

  Game.match = null;

  // Retourner à l'écran récompenses si la journée est terminée, sinon au classement
  if (Game.humanFixture && Game.humanFixture.homeScore !== null && Game.league) {
    Game.phase = 'REWARDS';
    RewardsUI.render(Game.league, Game.humanFixture, Game.lastSalaryReports, Game.lastInjuryReports, null);
    StandingsUI.updateHeader(Game.league);
    ScreenManager.show('rewards');
    _setReplayBtnVisible(false); // pas de replay-du-replay
  } else {
    Game.phase = 'STANDINGS';
    if (Game.league) {
      StandingsUI.render(Game.league);
      StandingsUI.updateHeader(Game.league);
    }
    ScreenManager.show('standings');
  }
}

// ── Phase: REWARDS → STANDINGS (or CUP) ──────────────────────────────────────
function continueToStandings() {
  if (Game.league.currentMatchday >= 11) {
    endSeason();
    return;
  }
  // Trigger mid-season cup after matchday 5 (5 played, currentMatchday just became 5)
  if (Game.league.currentMatchday === 5 && !Game.league.cup.done) {
    startCup();
    return;
  }
  Game.phase = 'STANDINGS';
  _lastPhaseBarState = null;   // force re-render du bouton de phase
  StandingsUI.render(Game.league);
  StandingsUI.updateHeader(Game.league);
  ScreenManager.show('standings');
  // Montrer le bouton de rediffusion si des données de match existent encore
  _setReplayBtnVisible(!!Game.lastMatchReplayData);
}

// ── Training mode ─────────────────────────────────────────────────────────────

const _TRAINING_DIFFICULTY_COLORS = [
  '#22c55e','#4ade80','#86efac',   // 1-3  vert
  '#f59e0b','#fb923c','#f97316',   // 4-6  orange
  '#ef4444','#dc2626','#b91c1c',   // 7-9  rouge
  '#7c3aed',                       // 10   violet
];

const _TRAINING_LEVEL_DESCS = [
  '😴 Niveau 1 — Débutant total',
  '🟢 Niveau 2 — Très facile',
  '🟢 Niveau 3 — Facile',
  '🟡 Niveau 4 — Amateur',
  '🟡 Niveau 5 — Semi-pro',
  '🟠 Niveau 6 — Équilibré',
  '🟠 Niveau 7 — Difficile',
  '🔴 Niveau 8 — Pro',
  '🔴 Niveau 9 — Expert',
  '💀 Niveau 10 — Élite absolue',
];

const _BOT_PLAYER_NAMES = [
  ['Ramirez','Torres','Volkov','Bauer','Osei','Durand','Mota','Ferreira'],
  ['Popov',  'Klein', 'Diop', 'Morel','Ndiaye','Gruber','Costa','Ribeiro'],
];

let _trainingDifficulty = 5;

function openTraining() {
  Game.phase = 'TRAINING';
  _trainingDifficulty = 5;
  _renderTrainingScreen();
  ScreenManager.show('training');
}

function _renderTrainingScreen() {
  // Level grid
  const grid = document.getElementById('training-level-grid');
  grid.innerHTML = '';
  for (let i = 1; i <= 10; i++) {
    const btn = document.createElement('button');
    btn.className = 'training-level-btn' + (i === _trainingDifficulty ? ' selected' : '');
    btn.textContent = i;
    btn.style.setProperty('--lvl-color', _TRAINING_DIFFICULTY_COLORS[i - 1]);
    btn.addEventListener('click', () => {
      _trainingDifficulty = i;
      _renderTrainingScreen();
    });
    grid.appendChild(btn);
  }
  document.getElementById('training-level-desc').textContent =
    _TRAINING_LEVEL_DESCS[_trainingDifficulty - 1];

  // Your team recap
  const human = Game.league.teams.find(t => t.isHuman);
  const el = document.getElementById('training-your-team');
  el.innerHTML = '';
  human.roster.forEach(p => {
    const roleKey = p.role === 'GOALKEEPER' ? 'GK' : p.role === 'DEFENDER' ? 'DEF' : 'ATT';
    const row = document.createElement('div');
    row.className = 'roster-player-row';
    row.innerHTML = `
      <span class="role-badge role-${roleKey}">${roleKey}</span>
      ${p.injured ? '<span class="injury-icon">🤕</span>' : ''}
      <span class="player-name-col${p.injured ? ' injured-name' : ''}">${p.name}</span>
    `;
    el.appendChild(row);
  });
}

function _generateTrainingOpponent(difficulty) {
  const lvl  = Math.max(1, Math.min(10, difficulty));
  const base = lvl * 0.88 + 0.5;
  const v    = () => +Math.max(1, Math.min(10, base + (Math.random() - 0.5) * 1.8)).toFixed(1);
  const names0 = _BOT_PLAYER_NAMES[0];
  const names1 = _BOT_PLAYER_NAMES[1];
  const pick   = arr => arr[Math.floor(Math.random() * arr.length)];
  const color  = _TRAINING_DIFFICULTY_COLORS[lvl - 1];

  const roster = [
    { id:'bot0', name: pick(names0), role:'ATTACKER',   speed:v(), passAccuracy:v(), shotAccuracy:v(), shotPower:v(), durability:v(), salary:0, isFreeTier:true },
    { id:'bot1', name: pick(names1), role:'ATTACKER',   speed:v(), passAccuracy:v(), shotAccuracy:v(), shotPower:v(), durability:v(), salary:0, isFreeTier:true },
    { id:'bot2', name: pick(names0), role:'DEFENDER',   speed:v(), passAccuracy:v(), shotAccuracy:v(), shotPower:v(), durability:v(), salary:0, isFreeTier:true },
    { id:'bot3', name: pick(names1), role:'GOALKEEPER', speed:v(), passAccuracy:v(), shotAccuracy:v(), shotPower:v(), durability:v(), salary:0, isFreeTier:true },
  ];

  return {
    id: 'bot_team', name: `Bots Niv.${lvl}`, color,
    roster, gold: 0, isHuman: false, trumpCard: null, formation: null,
    wins:0, draws:0, losses:0, goalsFor:0, goalsAgainst:0, points:0, matchesPlayed:0,
  };
}

function openTrainingFormation() {
  Game._formationOrigin = 'TRAINING';
  Game.phase = 'FORMATION';
  FormationUI.open(Game.league);
  ScreenManager.show('formation');
}

function launchTrainingMatch() {
  const human = Game.league.teams.find(t => t.isHuman);
  const bot   = _generateTrainingOpponent(_trainingDifficulty);
  Game.phase  = 'TRAINING_MATCH';

  _backupAndReplaceInjured();
  _setupMatchDOM(human, bot);
  // Training is single-player: seed from matchday so it's reproducible per session
  const _seedTrain = _computeMatchSeed(Game.league.currentMatchday, human.id, 'training');
  Game.match = createMatchState(human, bot, _seedTrain);
  MatchRenderer.resetAnims();

  document.getElementById('training-result-overlay').style.display = 'none';
  ScreenManager.show('match');
  document.body.classList.add('match-mode');
  startMatchLoop();
}

function onTrainingMatchEnd() {
  document.body.classList.remove('match-mode');
  _restoreInjuredBackup();

  const ms     = Game.match;
  const hs     = ms.homeScore, as_ = ms.awayScore;
  const win    = hs > as_;
  const draw   = hs === as_;
  const badge  = win ? '🏆 Victoire !' : draw ? '🤝 Match nul' : '😞 Défaite';
  const color  = win ? '#22c55e'        : draw ? '#f59e0b'      : '#ef4444';

  const overlay = document.getElementById('training-result-overlay');
  document.getElementById('training-result-badge').textContent = badge;
  document.getElementById('training-result-badge').style.color = color;
  document.getElementById('training-result-score').textContent = `${hs} – ${as_}`;
  document.getElementById('training-result-label').textContent =
    `contre ${ms.awayTeam.name}`;
  overlay.style.display = 'flex';

  Game.phase = 'TRAINING';
}

// ── Système temporel ──────────────────────────────────────────────────────────

function _initClock() {
  // Marquer les événements passés comme déjà traités
  _syncTodayScheduleToRealTime();
  // On démarre toujours sur le classement — pas de navigation automatique ici.
  // Le bouton dans la page de classement permet d'accéder à la phase en cours.
  _onClockTick();
  setInterval(_onClockTick, 1000);
}

// Lors du chargement, marque comme déjà traités les événements passés de la journée
// pour que seul ce qui est encore à venir déclenche quelque chose.
function _syncTodayScheduleToRealTime() {
  const t       = GameClock.now();
  const dateStr = t.toDateString();
  const mins    = t.getHours() * 60 + t.getMinutes();
  Game.todaySchedule = {
    dateStr,
    mercatoOpened:   mins >= 720,   // déjà 12h → mercato déjà ouvert
    formationOpened: mins >= 1200,  // déjà 20h → formation déjà ouverte
    matchStarted:    mins >= 1230,  // déjà 20h30 → match déjà déclenché
  };
}

function _onClockTick() {
  // Toujours mettre à jour l'affichage de l'horloge (admin panel, header…)
  _updateClockUI();
  if (!Game.league) return;

  const t       = GameClock.now();
  const dateStr = t.toDateString();
  const mins    = t.getHours() * 60 + t.getMinutes();

  // Nouveau jour → réinitialiser les événements quotidiens
  if (dateStr !== Game.todaySchedule.dateStr) {
    Game.todaySchedule = { dateStr, mercatoOpened: false, formationOpened: false, matchStarted: false };
  }

  const md = Game.league.currentMatchday;

  // 12:00 → Mercato disponible
  // On ne navigue plus automatiquement : le joueur voit le bouton dans le classement.
  if (mins >= 720 && !Game.todaySchedule.mercatoOpened && md < 11) {
    Game.todaySchedule.mercatoOpened = true;
    // Pas de startMatchday() ici — juste mettre à jour le bouton d'accès
  }

  // 20:00 → Fermeture du mercato
  if (mins >= 1200 && !Game.todaySchedule.formationOpened && md < 11) {
    Game.todaySchedule.formationOpened = true;
    if (Game.phase === 'MERCATO') {
      // Transition automatique si déjà sur l'écran mercato
      startFormation();
    }
    // Depuis le classement → le bouton d'accès change pour "Formation"
  }

  // 20:30 → Lancement du match
  if (mins >= 1230 && !Game.todaySchedule.matchStarted && md < 11) {
    const p = Game.phase;
    if (p === 'FORMATION' && Game._formationOrigin !== 'TRAINING') {
      Game.todaySchedule.matchStarted = true;
      FormationUI.confirm();   // auto-sauvegarde la formation courante
      startMatch();
    } else if (p === 'STANDINGS' || p === 'MERCATO') {
      // Le match démarre automatiquement même depuis le classement (c'est l'événement clé)
      Game.todaySchedule.matchStarted = true;
      startMatch();
    }
  }

  _updatePhaseAccessBar();
}

function _updateClockUI() {
  const cur    = GameClock.now();
  const next   = GameClock.nextEvent();
  const period = GameClock.currentPeriod();

  // ── Chip header ──
  const hcd = document.getElementById('header-countdown');
  if (hcd) hcd.textContent = next.icon + ' ' + GameClock.formatCountdown(next.msLeft);

  // ── Décompte écran formation ──
  const fval = document.getElementById('formation-time-val');
  if (fval && Game.phase === 'FORMATION' && Game._formationOrigin !== 'TRAINING') {
    const matchTime = _todayAt(20, 30);
    const msLeft    = matchTime - cur;
    fval.textContent = msLeft > 0 ? GameClock.formatCountdown(msLeft) : '⚽ Coup d\'envoi !';
  }

  // ── Time panel (classement) ──
  const panelEl = document.getElementById('time-panel');
  if (!panelEl) return;

  // Surligner l'événement actif dans la barre de programme
  const SLOT_PERIOD = {
    'sch-mercato-open':  'MERCATO',
    'sch-mercato-close': 'PRE_MATCH',
    'sch-match-start':   'MATCH_TIME',
  };
  Object.entries(SLOT_PERIOD).forEach(([id, p]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('sch-active', period === p);
    el.classList.toggle('sch-past',   _slotIsPast(id, period));
  });

  // Label + décompte
  const lbl = document.getElementById('time-next-label');
  const val = document.getElementById('time-countdown-val');
  if (lbl) lbl.textContent = next.icon + ' ' + next.label + ' dans';
  if (val) val.textContent = GameClock.formatCountdown(next.msLeft);
}

// ── Bouton d'accès rapide à la phase active (affiché dans le classement) ─────
let _lastPhaseBarState = null;   // évite les re-renders inutiles chaque seconde

function _updatePhaseAccessBar() {
  const bar = document.getElementById('phase-access-bar');
  if (!bar || !Game.league) return;

  // N'afficher que sur l'écran classement, hors fin de saison
  if (Game.phase !== 'STANDINGS' || Game.league.currentMatchday >= 11) {
    if (_lastPhaseBarState !== 'hidden') {
      bar.style.display = 'none';
      _lastPhaseBarState = 'hidden';
    }
    return;
  }

  const t    = GameClock.now();
  const mins = t.getHours() * 60 + t.getMinutes();
  const ts   = Game.todaySchedule;

  // Calculer l'état courant
  let state;
  if (mins >= 1230 && ts.mercatoOpened)      state = 'match';
  else if (mins >= 1200 && ts.mercatoOpened) state = 'formation';
  else if (mins >= 720  && ts.mercatoOpened) state = 'mercato';
  else                                        state = 'hidden';

  if (state === _lastPhaseBarState) return;   // pas de changement
  _lastPhaseBarState = state;

  if (state === 'hidden') {
    bar.style.display = 'none';
    return;
  }

  const configs = {
    mercato:   { icon: '🛒', label: 'Mercato ouvert',         sub: 'Gérez votre effectif',         cls: 'phase-btn-mercato',   fn: startMatchday   },
    formation: { icon: '📋', label: 'Heure de la formation',  sub: 'Définissez votre tactique',     cls: 'phase-btn-formation', fn: startFormation  },
    match:     { icon: '⚽', label: 'Match en cours',          sub: 'Coup d\'envoi imminent !',     cls: 'phase-btn-match',     fn: startMatch      },
  };
  const { icon, label, sub, cls, fn } = configs[state];

  bar.style.display = 'flex';
  bar.innerHTML = `
    <button id="btn-go-phase" class="btn-phase-access ${cls}">
      <span class="phase-btn-icon">${icon}</span>
      <span class="phase-btn-text">
        <span class="phase-btn-label">${label}</span>
        <span class="phase-btn-sub">${sub}</span>
      </span>
      <span class="phase-btn-arrow">›</span>
    </button>
  `;
  document.getElementById('btn-go-phase').onclick = fn;
}

function _todayAt(h, m) {
  const d = GameClock.now();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0);
}

function _slotIsPast(slotId, period) {
  if (slotId === 'sch-mercato-open')  return period === 'PRE_MATCH' || period === 'MATCH_TIME';
  if (slotId === 'sch-mercato-close') return period === 'MATCH_TIME';
  return false;
}

// ── Season end ────────────────────────────────────────────────────────────────
function endSeason() {
  Game.phase = 'SEASON_END';
  const sorted    = getSortedStandings(Game.league);
  const champion  = sorted[0];
  const human     = Game.league.teams.find(t => t.isHuman);
  const humanRank = sorted.indexOf(human) + 1;

  document.getElementById('season-winner-text').innerHTML =
    `🏆 Champion : <b style="color:var(--gold)">${champion.name}</b><br>
     Votre classement : <b style="color:var(--blue)">${humanRank}e place</b>`;

  const snap = document.getElementById('season-final-standings');
  snap.innerHTML = getSortedStandings(Game.league)
    .map((t, i) => `<div style="padding:3px 0;font-size:0.82rem;color:${t===human?'#93c5fd':'var(--text2)'}">
      ${i+1}. ${t.name} — ${t.points} pts
    </div>`).join('');

  ScreenManager.show('season-end');
}

// ── New season ────────────────────────────────────────────────────────────────
function newSeason() {
  Game.league.teams.forEach(team => {
    team.wins = 0; team.draws = 0; team.losses = 0;
    team.goalsFor = 0; team.goalsAgainst = 0;
    team.points = 0; team.matchesPlayed = 0;
    team.recentResults = [];
  });
  Game.league.currentMatchday = 0;
  Game.league.schedule = generateSchedule(Game.league.teams);
  Game.league.pastResults = [];
  Game.league.cup = _newCupState();
  Game.league.stats = {};
  Game.todaySchedule = { dateStr: '', mercatoOpened: false, formationOpened: false, matchStarted: false };
  _lastPhaseBarState = null;

  Game.phase = 'STANDINGS';
  StandingsUI.render(Game.league);
  StandingsUI.updateHeader(Game.league);
  ScreenManager.show('standings');
}

// ── Speed toggle ──────────────────────────────────────────────────────────────
function toggleSpeed() {
  if (!Game.match) return;
  // En mode en ligne, le serveur contrôle la vitesse — désactivé
  if (Game.isOnline && Game.phase === 'MATCH') return;
  Game.match.speedMult = Game.match.speedMult === 2 ? 1 : 2;
  document.getElementById('btn-speed').textContent =
    Game.match.speedMult === 2 ? '⚡ ×1' : '⚡ ×2';
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _backupAndReplaceInjured() {
  const human = Game.league.teams.find(t => t.isHuman);
  Game._injuredBackup = [];
  human.roster.forEach((p, i) => {
    if (p.injured) {
      Game._injuredBackup.push({ idx: i, original: p });
      human.roster[i] = createFreeTierPlayer(p.role);
    }
  });
}

function _restoreInjuredBackup() {
  if (!Game._injuredBackup || Game._injuredBackup.length === 0) return;
  const human = Game.league.teams.find(t => t.isHuman);
  Game._injuredBackup.forEach(({ idx, original }) => { human.roster[idx] = original; });
  Game._injuredBackup = [];
}

function _setupMatchDOM(homeTeam, awayTeam) {
  document.getElementById('match-home-name').textContent = homeTeam.name;
  document.getElementById('match-away-name').textContent = awayTeam.name;
  document.getElementById('match-home-score').textContent = '0';
  document.getElementById('match-away-score').textContent = '0';
  document.getElementById('match-time-display').textContent = "0'";
  document.getElementById('poss-label-home').textContent = homeTeam.name.split(' ')[0];
  document.getElementById('poss-label-away').textContent = awayTeam.name.split(' ')[0];
  document.getElementById('match-home-color').style.background = homeTeam.color;
  document.getElementById('match-away-color').style.background = awayTeam.color;
  document.getElementById('possession-fill').style.width = '50%';
  document.getElementById('match-events-ticker').innerHTML = '';
  document.getElementById('halftime-overlay').style.display = 'none';
}

// ═══════════════════════════════════════════
//  MULTIJOUEUR — Boot online / offline
// ═══════════════════════════════════════════

// Point d'entrée principal : vérifie si le serveur est disponible
function checkServerAndBoot() {
  Network.ping().then(available => {
    if (available) {
      Game.isOnline = true;   // marquer "en ligne" dès que le serveur répond
      _setupNetworkHandlers();
      // Essayer de restaurer la session enregistrée
      const saved = Network.restoreSession();
      if (saved) {
        // Vérifier que le token est toujours valide
        Network.verifyToken().then(user => {
          if (user) {
            _enterLobby();
          } else {
            ScreenManager.show('login');
          }
        });
      } else {
        ScreenManager.show('login');
      }
    } else {
      // Aucun serveur — mode solo local
      _bootOffline();
    }
  }).catch(() => _bootOffline());
}

function _bootOffline() {
  Game.isOnline = false;
  initGame();
  _initClock();
}

// ── Connexion au lobby après authentification ─────────────────────────────────
function _enterLobby() {
  Network.getLobby().then(data => {
    if (data.started) {
      // Saison déjà lancée — rejoindre l'état courant
      Network.getGameState().then(({ leagueJson, claims, timeOffsetMs }) => {
        if (leagueJson) {
          _initOnlineGame(leagueJson, claims, timeOffsetMs);
        } else {
          _showLobby(data);
        }
      }).catch(() => _showLobby(data));
    } else {
      _showLobby(data);
    }
  }).catch(err => {
    console.warn('Lobby inaccessible, mode solo :', err);
    _bootOffline();
  });
}

function _showLobby(data) {
  Game.phase = 'LOBBY';
  _renderLobby(data);
  ScreenManager.show('lobby');
}

// ── Rendu du lobby ────────────────────────────────────────────────────────────
function _renderLobby({ claims, started }) {
  const user = Network.getUser();
  if (!user) return;

  // Barre de bienvenue
  const chip = document.getElementById('lobby-welcome-chip');
  if (chip) chip.textContent = '👤 ' + user.username + (user.isAdmin ? ' ⚙️' : '');

  // Grille des équipes
  const grid = document.getElementById('lobby-teams-grid');
  if (!grid) return;
  grid.innerHTML = '';

  TEAM_DEFS.forEach((def, idx) => {
    const claim  = claims.find(c => (c.teamIndex ?? c.team_index) === idx);
    const isMine = claim && claim.username === user.username;
    const isTaken = !!claim && !isMine;

    const card = document.createElement('div');
    card.className = 'lobby-team-card'
      + (isMine  ? ' mine'      : '')
      + (isTaken ? ' taken'     : '')
      + (!claim && !started ? ' available' : '');

    const ownerText = claim
      ? (isMine ? '✓ Votre équipe' : '👤 ' + claim.username)
      : (started ? 'IA' : 'Disponible');

    card.innerHTML = `
      <div class="lobby-team-color" style="background:${def.color}"></div>
      <div class="lobby-team-name">${def.name}</div>
      <div class="lobby-team-owner">${ownerText}</div>
    `;

    if (!started) {
      if (!claim) {
        card.addEventListener('click', () => {
          Network.claim(idx).catch(e => _showLobbyError(e.message));
        });
      } else if (isMine) {
        card.title = 'Cliquer pour libérer';
        card.addEventListener('click', () => {
          Network.unclaim().catch(e => _showLobbyError(e.message));
        });
      }
    }
    grid.appendChild(card);
  });

  // Mon équipe sélectionnée
  const myClaim  = claims.find(c => c.username === user.username);
  const claimEl  = document.getElementById('lobby-my-claim');
  if (claimEl) {
    if (myClaim) {
      const def = TEAM_DEFS[myClaim.teamIndex ?? myClaim.team_index];
      claimEl.textContent = '✓ Votre équipe : ' + def.name;
      claimEl.style.color = def.color;
    } else {
      claimEl.textContent = 'Aucune équipe sélectionnée — cliquez sur une équipe disponible';
      claimEl.style.color = '';
    }
  }

  // Compteur joueurs
  const countEl = document.getElementById('lobby-players-count');
  if (countEl) countEl.textContent = `${claims.length} joueur(s) connecté(s) / 12 équipes`;

  // Admin : bouton lancer la saison
  const adminZone = document.getElementById('lobby-admin-zone');
  const waitText  = document.getElementById('lobby-wait-text');
  if (user.isAdmin) {
    if (adminZone) adminZone.style.display = started ? 'none' : 'flex';
    if (waitText)  waitText.style.display  = 'none';
  } else {
    if (adminZone) adminZone.style.display = 'none';
    if (waitText)  waitText.style.display  = started ? 'none' : '';
  }
}

function _showLobbyError(msg) {
  console.error('Lobby:', msg);
  // Affichage non intrusif (on pourrait ajouter un toast)
}

// ── Démarrage de la saison par l'admin ───────────────────────────────────────
function _adminStartSeason() {
  Network.getLobby().then(({ claims }) => {
    // Générer la ligue côté client admin
    _teamIdCounter = 0;

    const claimedIndices = new Set(claims.map(c => c.teamIndex ?? c.team_index));

    const teams = TEAM_DEFS.map((def, idx) => {
      const isHumanTeam = claimedIndices.has(idx);
      const roster = buildStartingRoster(isHumanTeam);
      return createTeam({ ...def, isHuman: isHumanTeam }, roster);
    });

    const league     = createLeague(teams);
    const allPlayers = PLAYERS_DB.map(p => clonePlayer(p));
    _assignPlayersToAITeams(teams, allPlayers, league);
    league.freePlayerPool = allPlayers.filter(p => !p.teamId);

    Network.startSeason(JSON.stringify(league)).catch(err => {
      console.error('Erreur démarrage saison :', err);
    });
  });
}

// ── Initialisation du jeu en ligne ────────────────────────────────────────────
function _initOnlineGame(leagueJson, claims, timeOffsetMs) {
  const user     = Network.getUser();
  const myClaim  = claims ? claims.find(c => c.username === user.username) : null;

  // Parser l'état de la ligue
  let league;
  try { league = JSON.parse(leagueJson); } catch (e) {
    console.error('Impossible de parser le JSON de la ligue :', e);
    _bootOffline();
    return;
  }

  // Synchroniser l'offset de temps du serveur
  if (timeOffsetMs !== undefined) GameClock.setOffset(timeOffsetMs);

  Game.league       = league;
  Game.isOnline     = true;
  Game.myTeamIndex  = myClaim ? (myClaim.teamIndex ?? myClaim.team_index) : -1;

  // Marquer SEULEMENT notre équipe comme isHuman (les autres sont gérées par d'autres joueurs)
  Game.league.teams.forEach((team, idx) => {
    team.isHuman = (idx === Game.myTeamIndex);
  });
  // Si pas de revendication → mode spectateur : myTeamIndex reste -1,
  // _isMyMatch() retournera true pour le premier match reçu.

  Game.phase = 'STANDINGS';

  // Ajouter le badge "En ligne" dans le header
  _updateOnlineHeader();

  StandingsUI.render(Game.league);
  StandingsUI.updateHeader(Game.league);
  _initClock();

  // Si des match_start sont arrivés avant que la ligue soit prête,
  // on cherche celui qui concerne notre équipe et on l'affiche.
  const pendings = Game._pendingMatchStarts || [];
  Game._pendingMatchStarts = [];
  console.log('[Match] Pending match_start à traiter :', pendings.length,
    pendings.map(d => d.matchId));
  const myPending = pendings.find(d => _isMyMatch(d));
  if (myPending) {
    console.log('[Match] Pending match trouvé →', myPending.matchId);
    _processMatchStart(myPending);
  } else {
    ScreenManager.show('standings');

    // Aucun match_start reçu en attente, mais on est peut-être passé 20h30
    // (reconnexion tardive, serveur redémarré…).
    // On tente de rejoindre/démarrer le match via l'API.
    const nowMins = GameClock.now().getHours() * 60 + GameClock.now().getMinutes();
    const day = Game.league.currentMatchday;
    if (nowMins >= 1230 && day < 11) {
      const myTeamId = Game.league.teams[Game.myTeamIndex]?.id;
      const fixtures  = (Game.league.schedule || [])[day] || [];
      const humanFix  = fixtures.find(f =>
        (f.homeId === myTeamId || f.awayId === myTeamId) && f.homeScore == null
      );
      if (humanFix) {
        console.log('[Match] Reconnexion tardive détectée — tentative de rejoindre le match en cours…');
        Network.startServerMatch()
          .then(() => console.log('[Match] startServerMatch OK (auto-join)'))
          .catch(err => console.warn('[Match] startServerMatch échoué (auto-join):', err));
      }
    }
  }
}

function _updateOnlineHeader() {
  const user = Network.getUser();
  if (!user || !Game.isOnline) return;

  // Ajouter / mettre à jour un chip "En ligne" dans le header
  let badge = document.getElementById('header-online-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.id = 'header-online-badge';
    const hr = document.getElementById('header-right');
    if (hr) hr.prepend(badge);
  }
  badge.innerHTML = `<span style="color:#22c55e">●</span> ${user.username}`;

  document.body.classList.add('is-online');
}

// ── Fusion de l'état distant ──────────────────────────────────────────────────
function _mergeRemoteState(leagueJson, sender) {
  if (!leagueJson || !Game.isOnline || !Game.league) return;

  let remote;
  try { remote = JSON.parse(leagueJson); } catch { return; }

  // Mettre à jour les équipes AUTRES QUE la nôtre
  remote.teams.forEach((rTeam, idx) => {
    if (idx === Game.myTeamIndex) return;
    const local = Game.league.teams[idx];
    if (!local) return;
    // Copier stats, roster, gold depuis remote
    Object.assign(local, rTeam, { isHuman: false });
  });

  // Pool libre, calendrier, résultats passés, stats
  Game.league.freePlayerPool = remote.freePlayerPool;
  Game.league.schedule       = remote.schedule;
  Game.league.pastResults    = remote.pastResults;
  Game.league.stats          = remote.stats;

  // Avancer le matchday si remote est plus loin
  if (remote.currentMatchday > Game.league.currentMatchday) {
    Game.league.currentMatchday = remote.currentMatchday;
  }

  // Re-render si sur standings
  if (Game.phase === 'STANDINGS') {
    StandingsUI.render(Game.league);
    StandingsUI.updateHeader(Game.league);
  }
}

// ── Sync après événements importants ─────────────────────────────────────────
function _syncStateToServer() {
  if (!Game.isOnline || !Game.league) return;
  Network.pushGameState(JSON.stringify(Game.league)).catch(err => {
    console.warn('Sync échoué :', err);
  });
}

// ── Vérifie si un matchId concerne notre équipe (ou si on est spectateur) ──────
function _isMyMatch(data) {
  if (!Game.league || Game.myTeamIndex < 0) return true; // spectateur → accepte le 1er match
  const myTeamId = Game.league.teams[Game.myTeamIndex]?.id;
  if (!myTeamId) return true;
  return data.homeTeam.id === myTeamId || data.awayTeam.id === myTeamId;
}

// ── Traitement d'un match_start (appelé dès que Game.league est prêt) ──────────
function _processMatchStart(data) {
  console.log('[Match] _processMatchStart appelé pour', data.matchId,
    '— home:', data.homeTeam?.id, 'away:', data.awayTeam?.id);
  // Marquer le match du jour comme démarré — empêche _onClockTick de
  // re-déclencher un startMatch() quand on revient au classement après le match.
  Game.todaySchedule.matchStarted = true;
  try {
    Game.match = _buildOnlineMatchState(data);

    // ── Sauvegarder les données pour la rediffusion ──────────────────────────
    if (Game.league) {
      const matchday = Game.league.currentMatchday;
      const htFull = Game.league.teams.find(t => t.id === data.homeTeam.id) || data.homeTeam;
      const atFull = Game.league.teams.find(t => t.id === data.awayTeam.id) || data.awayTeam;
      Game.lastMatchReplayData = {
        homeTeam: JSON.parse(JSON.stringify(htFull)),
        awayTeam: JSON.parse(JSON.stringify(atFull)),
        matchday,
        seed: _computeMatchSeed(matchday, data.homeTeam.id, data.awayTeam.id),
      };
    }

    // Mémoriser la fixture
    if (!Game.humanFixture && Game.league) {
      const day      = Game.league.currentMatchday;
      const fixtures = (Game.league.schedule || [])[day] || [];
      Game.humanFixture = fixtures.find(f =>
        f.homeId === data.homeTeam.id || f.awayId === data.homeTeam.id
      ) || { homeId: data.homeTeam.id, awayId: data.awayTeam.id, homeScore: null, awayScore: null };
    }

    // Toujours initialiser le DOM (noms, couleurs, score…)
    const homeTeam = (Game.league && Game.league.teams.find(t => t.id === data.homeTeam.id)) || data.homeTeam;
    const awayTeam = (Game.league && Game.league.teams.find(t => t.id === data.awayTeam.id)) || data.awayTeam;
    _setupMatchDOM(homeTeam, awayTeam);

    Game.phase = 'MATCH';
    MatchRenderer.resetAnims();
    ScreenManager.show('match');
    document.body.classList.add('match-mode');

    // S'assurer que le bandeau REDIFFUSION est caché pour un vrai match en direct
    const _rb = document.getElementById('replay-banner');
    if (_rb) _rb.style.display = 'none';

    if (Game.rafId) cancelAnimationFrame(Game.rafId);
    Game.rafId = null;
    startMatchLoop();
    console.log('[Match] Écran de match affiché ✓');
  } catch (e) {
    console.error('[Match] Erreur dans _processMatchStart:', e.message, e.stack);
  }
}

// ── Handlers réseau ────────────────────────────────────────────────────────────
function _setupNetworkHandlers() {
  Network.on('lobby_update', data => {
    if (Game.phase === 'LOBBY') _renderLobby(data);
  });

  Network.on('season_started', ({ leagueJson, claims, timeOffsetMs }) => {
    _initOnlineGame(leagueJson, claims, timeOffsetMs);
  });

  Network.on('game_state_updated', ({ leagueJson, sender }) => {
    if (!Game.isOnline) return;
    const user = Network.getUser();
    // Ne pas appliquer notre propre mise à jour
    if (sender && user && sender === user.username) return;
    _mergeRemoteState(leagueJson, sender);
  });

  Network.on('mercato_action', ({ username, action, playerId }) => {
    if (!Game.isOnline || !Game.league) return;
    const user = Network.getUser();
    if (username === user.username) return;  // ignorer nos propres actions
    // Retirer le joueur du pool libre si quelqu'un d'autre l'a acheté (mode hors ligne)
    if (action === 'buy' && playerId) {
      Game.league.freePlayerPool = Game.league.freePlayerPool.filter(p => p.id !== playerId);
      if (Game.phase === 'MERCATO') MercatoUI.open(Game.league, false);
    }
  });

  // Mise à jour d'une enchère en temps réel
  Network.on('bid_update', ({ playerId, bid }) => {
    if (!Game.isOnline) return;
    if (Game.phase === 'MERCATO') {
      MercatoUI.updateBid(playerId, bid);
    }
  });

  // Pool + enchères envoyés au moment de la connexion (si mercato déjà ouvert)
  Network.on('mercato_pool', ({ pool, bids }) => {
    if (!Game.isOnline) return;
    if (Game.phase === 'MERCATO') {
      MercatoUI.setPool(pool, bids);
    }
  });

  // Le mercato a été résolu (clôture des enchères)
  Network.on('mercato_resolved', ({ bids }) => {
    if (!Game.isOnline || !Game.league) return;
    if (Game.phase === 'MERCATO') {
      // Ne pas appliquer le résultat maintenant : le joueur est encore sur l'écran
      // mercato et ne doit pas voir le joueur apparaître dans son équipe avant
      // d'avoir cliqué sur "Aller à la formation".
      // On indique simplement que les enchères sont closes.
      MercatoUI.markResolved();
    }
    // Dans les autres phases (FORMATION, etc.), la résolution a déjà été appliquée
    // via startFormation() → Network.resolveMercato().
  });

  // Synchronisation de l'heure depuis le serveur (admin a avancé le temps)
  Network.on('time_updated', ({ timeOffsetMs }) => {
    GameClock.setOffset(timeOffsetMs);
    // Réinitialiser le planning du jour si la date virtuelle a changé
    Game.todaySchedule = { dateStr: '', mercatoOpened: false, formationOpened: false, matchStarted: false };
    _lastPhaseBarState = null;
    _onClockTick();
  });

  Network.on('season_reset', () => {
    // Admin a réinitialisé — retourner au lobby
    if (Game.isOnline) {
      Network.getLobby().then(data => _showLobby(data));
    }
  });

  // ── Match serveur ──────────────────────────────────────────────────────────

  Network.on('match_start', data => {
    console.log('[Match] match_start reçu :', data.matchId,
      '— home:', data.homeTeam?.id, 'away:', data.awayTeam?.id,
      '— league chargée:', !!Game.league);
    // Si la ligue est déjà chargée, filtrer et traiter immédiatement
    if (Game.league) {
      const mine = _isMyMatch(data);
      console.log('[Match] _isMyMatch:', mine, '(myTeamIndex:', Game.myTeamIndex,
        'myTeamId:', Game.league.teams[Game.myTeamIndex]?.id, ')');
      if (mine) _processMatchStart(data);
      return;
    }
    // Ligue pas encore chargée (race condition socket > HTTP) :
    // accumuler TOUS les match_start — _initOnlineGame choisira le bon.
    if (!Game._pendingMatchStarts) Game._pendingMatchStarts = [];
    Game._pendingMatchStarts.push(data);
  });

  Network.on('match_tick', data => {
    if (Game.phase !== 'MATCH' || !Game.match) return;
    if (data.mid && Game.match.matchId && data.mid !== Game.match.matchId) return;
    _applyMatchTick(data);
  });

  Network.on('match_event', ev => {
    if (!Game.match) return;
    if (ev.matchId && Game.match.matchId && ev.matchId !== Game.match.matchId) return;
    const lastName = n => n ? n.split(' ').pop() : '?';
    if (ev.type === 'GOAL') {
      const team = ev.teamIndex === 0 ? Game.match.homeTeam : Game.match.awayTeam;
      MatchRenderer.triggerGoalFlash(ev.teamColor || team.color);
      MatchRenderer.triggerGoalAnim(ev.teamColor || team.color, '⚽ BUT !');
      MatchRenderer.pushTicker(`⚽ ${ev.minute}' — ${lastName(ev.scorerName)} (${team.name})`);
      if (ev.replay) MatchRenderer.triggerReplay(ev.replay);
      Game.match.events.push({ type: 'GOAL', teamIndex: ev.teamIndex, minute: ev.minute,
        scorer: ev.scorerName ? { name: ev.scorerName } : null,
        assister: ev.assisterName ? { name: ev.assisterName } : null });
    } else if (ev.type === 'LONG_SHOT') {
      MatchRenderer.pushTicker(`🚀 ${ev.minute}' — ${lastName(ev.name)} tente sa chance de loin !`);
    } else if (ev.type === 'PUNCH') {
      const msg = ev.ko
        ? `🥊 ${ev.minute}' — ${lastName(ev.name)} met ${lastName(ev.targetName)} au sol !`
        : `🥊 ${ev.minute}' — ${lastName(ev.name)} tente un coup sur ${lastName(ev.targetName)} !`;
      MatchRenderer.pushTicker(msg);
    }
  });

  Network.on('match_halftime', data => {
    if (!Game.match) return;
    if (data.matchId && Game.match.matchId && data.matchId !== Game.match.matchId) return;
    MatchRenderer.showHalftimeOverlay({
      homeTeam:  Game.match.homeTeam || { name: data.homeName },
      awayTeam:  Game.match.awayTeam || { name: data.awayName },
      homeScore: data.homeScore,
      awayScore: data.awayScore,
    });
  });

  Network.on('match_end', data => {
    if (Game.phase !== 'MATCH' || !Game.match) return;
    // Ignorer si ce n'est pas notre match
    if (data.matchId && Game.match.matchId && data.matchId !== Game.match.matchId) return;

    // Arrêter la boucle de rendu
    if (Game.rafId) { cancelAnimationFrame(Game.rafId); Game.rafId = null; }

    // Appliquer l'état final
    Game.match.state     = 'FULL_TIME';
    Game.match.homeScore = data.homeScore;
    Game.match.awayScore = data.awayScore;

    // Appliquer le leagueJson autoritaire du serveur
    if (data.leagueJson) {
      try {
        const remote = JSON.parse(data.leagueJson);
        // Conserver isHuman sur la bonne équipe
        if (Game.league) {
          remote.teams.forEach((rt, i) => {
            if (Game.league.teams[i]) rt.isHuman = Game.league.teams[i].isHuman;
          });
        }
        Game.league = remote;
      } catch { /* keep current */ }
    }

    document.body.classList.remove('match-mode');
    Game.phase = 'REWARDS';

    _restoreInjuredBackup();

    const f = Game.humanFixture || { homeId: data.homeTeamId, awayId: data.awayTeamId, homeScore: data.homeScore, awayScore: data.awayScore };
    f.homeScore = data.homeScore;
    f.awayScore = data.awayScore;

    Game.lastSalaryReports = data.salaryReports || [];
    Game.lastInjuryReports = data.injuryReports || [];

    RewardsUI.render(Game.league, f, Game.lastSalaryReports, Game.lastInjuryReports, Game.match);
    StandingsUI.updateHeader(Game.league);
    ScreenManager.show('rewards');
    _setReplayBtnVisible(!!Game.lastMatchReplayData);

    _lastPhaseBarState = null;
    Game.match = null;
  });
}

// ═══════════════════════════════════════════
//  Wire up buttons & boot
// ═══════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {

  // Bouton accueil — retour au classement depuis n'importe quel écran
  document.getElementById('btn-home').addEventListener('click', () => {
    // Ne rien faire si on est déjà sur standings, login, lobby ou en plein match
    const blocked = ['LOGIN', 'LOBBY', 'MATCH', 'CUP_MATCH', 'TRAINING_MATCH', 'REPLAY'];
    if (blocked.includes(Game.phase)) return;
    if (Game.phase === 'STANDINGS') return;

    Game._formationOrigin = null;
    Game.phase = 'STANDINGS';
    _lastPhaseBarState = null;
    StandingsUI.render(Game.league);
    StandingsUI.updateHeader(Game.league);
    ScreenManager.show('standings');
  });

  // Standings
  document.getElementById('btn-training').addEventListener('click', openTraining);

  // Calendrier toggle
  document.getElementById('btn-toggle-schedule').addEventListener('click', () => {
    const content = document.getElementById('schedule-content');
    const btn     = document.getElementById('btn-toggle-schedule');
    const open    = content.style.display === 'none';
    content.style.display = open ? 'block' : 'none';
    btn.textContent = open ? '▲ Masquer' : '▼ Afficher';
    if (open && Game.league) StandingsUI._buildSchedule(Game.league, content);
  });

  // Training
  document.getElementById('btn-back-training').addEventListener('click', () => {
    Game.phase = 'STANDINGS';
    ScreenManager.show('standings');
  });
  document.getElementById('btn-launch-training').addEventListener('click', openTrainingFormation);
  document.getElementById('btn-training-done').addEventListener('click', () => {
    document.getElementById('training-result-overlay').style.display = 'none';
    Game.phase = 'STANDINGS';
    StandingsUI.render(Game.league);
    StandingsUI.updateHeader(Game.league);
    ScreenManager.show('standings');
  });

  // Mercato
  MercatoUI.bindButtons();
  document.getElementById('btn-ready-play').addEventListener('click', startFormation);

  // Formation
  document.getElementById('btn-confirm-formation').addEventListener('click', confirmFormation);
  document.getElementById('btn-back-formation').addEventListener('click', () => {
    if (Game._formationOrigin === 'TRAINING') {
      Game._formationOrigin = null;
      Game.phase = 'TRAINING';
      ScreenManager.show('training');
    } else {
      Game.phase = 'MERCATO';
      ScreenManager.show('mercato');
    }
  });

  // Match
  document.getElementById('btn-speed').addEventListener('click', toggleSpeed);

  // Rewards
  document.getElementById('btn-continue').addEventListener('click', continueToStandings);
  document.getElementById('btn-replay-match').addEventListener('click', replayLastMatch);

  // Standings — bouton de rediffusion du dernier match
  document.getElementById('btn-standings-replay').addEventListener('click', replayLastMatch);

  // Cup
  document.getElementById('btn-play-cup').addEventListener('click', () => {
    const cup = Game.league.cup;
    if (cup.done || cup.roundState === 'POST') {
      advanceCupRound();
    } else {
      playCupRound();
    }
  });

  // Season end
  document.getElementById('btn-new-season').addEventListener('click', newSeason);

  // ── Login screen ────────────────────────────────────────────────────────────
  const tabLogin    = document.getElementById('tab-login');
  const tabRegister = document.getElementById('tab-register');
  const formLogin   = document.getElementById('form-login');
  const formReg     = document.getElementById('form-register');

  tabLogin.addEventListener('click', () => {
    tabLogin.classList.add('active');    tabRegister.classList.remove('active');
    formLogin.style.display = 'flex';   formReg.style.display = 'none';
  });
  tabRegister.addEventListener('click', () => {
    tabRegister.classList.add('active'); tabLogin.classList.remove('active');
    formReg.style.display = 'flex';      formLogin.style.display = 'none';
  });

  document.getElementById('btn-login').addEventListener('click', async () => {
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    const errEl    = document.getElementById('login-error');
    errEl.textContent = '';
    try {
      await Network.login(username, password);
      _enterLobby();
    } catch (e) {
      errEl.textContent = e.message;
    }
  });

  // Connexion sur Entrée
  ['login-username','login-password'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('btn-login').click();
    });
  });

  document.getElementById('btn-register').addEventListener('click', async () => {
    const username = document.getElementById('reg-username').value.trim();
    const password = document.getElementById('reg-password').value;
    const errEl    = document.getElementById('register-error');
    errEl.textContent = '';
    try {
      await Network.register(username, password);
      _enterLobby();
    } catch (e) {
      errEl.textContent = e.message;
    }
  });

  ['reg-username','reg-password'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('btn-register').click();
    });
  });

  document.getElementById('btn-play-offline').addEventListener('click', () => {
    _bootOffline();
  });

  // ── Lobby screen ─────────────────────────────────────────────────────────────
  document.getElementById('btn-logout').addEventListener('click', () => {
    Network.logout();
    ScreenManager.show('login');
  });

  document.getElementById('btn-start-season').addEventListener('click', () => {
    _adminStartSeason();
  });

  document.getElementById('btn-reset-season').addEventListener('click', () => {
    if (confirm('Réinitialiser la saison ? Tous les joueurs retourneront au lobby.')) {
      Network.resetSeason().catch(e => console.error(e));
    }
  });

  // Init Three.js 3D renderer
  MatchRenderer.initThreeJS();

  // Boot : vérifier si serveur disponible
  checkServerAndBoot();
});
