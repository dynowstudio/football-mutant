/* ═══════════════════════════════════════════
   Football Mutant — Serveur multijoueur
   Node.js + Express + Socket.io + JSON

   Lancement : npm start  (ou node server.js)
   Port      : 3000 (configurable via PORT env)
   ═══════════════════════════════════════════ */

const express = require('express');
const http    = require('http');
const { Server: IOServer } = require('socket.io');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');

// ── Config ────────────────────────────────────────────────────────────────────
const PORT      = process.env.PORT || 3000;

// ── Load simulation engine (Ball + PlayerAgent + MatchEngine) ─────────────────
// Les fichiers de simulation sont écrits pour le navigateur (pas de module.exports).
// On les exécute dans une Function() pour capturer leurs exports.
const _sim = {};
try {
  const _simCode = [
    'js/simulation/Ball.js',
    'js/simulation/PlayerAgent.js',
    'js/simulation/MatchEngine.js',
  ].map(f => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');

  new Function('_e', _simCode + `
    _e.createMatchState = (typeof createMatchState !== 'undefined') ? createMatchState : null;
    _e.matchTick        = (typeof matchTick        !== 'undefined') ? matchTick        : null;
    _e.TICKS_PER_SECOND = (typeof TICKS_PER_SECOND !== 'undefined') ? TICKS_PER_SECOND : 60;
    _e.HALFTIME_PAUSE   = (typeof HALFTIME_PAUSE   !== 'undefined') ? HALFTIME_PAUSE   : 180;
    _e.TOTAL_TICKS      = (typeof TOTAL_TICKS      !== 'undefined') ? TOTAL_TICKS      : 14400;
  `)(_sim);
  console.log('✅ Simulation engine loaded (server-side)');
} catch (e) {
  console.error('❌ Failed to load simulation engine:', e.message);
}
// Secret fixe : les tokens restent valides après un redémarrage du serveur.
// Changez cette valeur si vous voulez invalider toutes les sessions existantes.
const SECRET    = process.env.JWT_SECRET || 'football_mutant_secret_2025';

// Sur Railway : monter un Volume sur /data → les données survivent aux redémarrages.
// En local   : le fichier est dans le dossier du projet (comportement inchangé).
const DATA_DIR  = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'game_data.json');

// ── Express + Socket.io ───────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new IOServer(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

// ── Stockage JSON ─────────────────────────────────────────────────────────────
function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { users: [], claims: [], leagueJson: null, started: false, timeOffsetMs: 0 }; }
}

// ── Horloge serveur ───────────────────────────────────────────────────────────
const TIME_SCHEDULE = [
  { h: 12, m:  0 },
  { h: 20, m:  0 },
  { h: 20, m: 30 },
];

function serverNow(offsetMs) {
  return new Date(Date.now() + (offsetMs || 0));
}

// Calcule le nouvel offsetMs pour atterrir 90s après le prochain événement
function computeSkipOffset(currentOffsetMs) {
  const now      = serverNow(currentOffsetMs);
  const curMins  = now.getHours() * 60 + now.getMinutes();
  const y = now.getFullYear(), mo = now.getMonth(), d = now.getDate();

  for (const ev of TIME_SCHEDULE) {
    const evMins = ev.h * 60 + ev.m;
    if (evMins > curMins) {
      const target = new Date(y, mo, d, ev.h, ev.m, 1, 500); // 1s 500ms après
      return target.getTime() - Date.now();
    }
  }
  // Tous passés → premier événement demain
  const ev     = TIME_SCHEDULE[0];
  const target = new Date(y, mo, d + 1, ev.h, ev.m, 1, 500);
  return target.getTime() - Date.now();
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ── Server-side match simulation ─────────────────────────────────────────────
// Map : matchId (`${homeId}:${awayId}`) → { ms, interval, eventIdx, halftimeEmitted, matchday }
const _serverMatches = new Map();
const _MATCH_TICK_MS = 1000 / 60;  // ~16.67 ms

// FNV-1a seed (same algorithm as client's _computeMatchSeed)
function _serverMatchSeed(matchday, homeId, awayId) {
  let h = 0x811c9dc5;
  const s = String(matchday) + ':' + homeId + ':' + awayId;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (Math.imul(h, 0x01000193)) >>> 0;
  }
  return h;
}

// Build the match_start payload (static data, sent once)
function _buildMatchStartPayload(ms, matchId) {
  return {
    matchId,
    homeTeam: { id: ms.homeTeam.id, name: ms.homeTeam.name, color: ms.homeTeam.color, secondaryColor: ms.homeTeam.secondaryColor || '#ffffff' },
    awayTeam: { id: ms.awayTeam.id, name: ms.awayTeam.name, color: ms.awayTeam.color, secondaryColor: ms.awayTeam.secondaryColor || '#ffffff' },
    agents: ms.agents.map(a => ({
      id:               a.id,
      name:             a.name,
      role:             a.role,
      teamIndex:        a.teamIndex,
      displayTeamIndex: a.displayTeamIndex,
      speed:            a.speed,
      passAccuracy:     a.passAccuracy,
      shotAccuracy:     a.shotAccuracy,
      power:            a.power,
      x:                a.x,
      y:                a.y,
    })),
  };
}

// Build compact tick payload (~every 3 ticks = ~20fps)
function _buildMatchTickPayload(ms, matchId) {
  return {
    mid: matchId,
    t:   ms.tick,
    s:   ms.state,
    pt:  ms.pauseTimer,
    hs:  ms.homeScore,
    aws: ms.awayScore,
    sm:  Math.round(ms.simMinutes * 10) / 10,
    pa:  ms.possessionA,
    pb:  ms.possessionB,
    htd: ms.halfTimeDone ? 1 : 0,
    b: {
      x:   Math.round(ms.ball.x  * 10) / 10,
      y:   Math.round(ms.ball.y  * 10) / 10,
      vx:  Math.round(ms.ball.vx * 100) / 100,
      vy:  Math.round(ms.ball.vy * 100) / 100,
      own: ms.ball.owner ? 1 : 0,
    },
    // Compact agent array: [id, x, y, vx, vy, hasBall, knockdownTimer, punchTimer, punchArm]
    a: ms.agents.map(a => [
      a.id,
      Math.round(a.x  * 10)  / 10,
      Math.round(a.y  * 10)  / 10,
      Math.round(a.vx * 100) / 100,
      Math.round(a.vy * 100) / 100,
      a.hasBall         ? 1 : 0,
      a.knockdownTimer  || 0,
      a.punchTimer      || 0,
      a.punchArm        || 1,
    ]),
  };
}

// ── Post-match: apply result + gold (per fixture) + salaries when all done ──────
function _serverPostMatch(matchId) {
  const entry = _serverMatches.get(matchId);
  if (!entry) return;
  _serverMatches.delete(matchId);   // retirer AVANT de lire .size plus bas

  const ms = entry.ms;
  const d  = loadData();
  if (!d.leagueJson) return;
  let league;
  try { league = JSON.parse(d.leagueJson); } catch { return; }

  const day     = league.currentMatchday;
  const fixture = (league.schedule[day] || []).find(
    f => f.homeId === ms.homeTeam.id && f.awayId === ms.awayTeam.id
  );
  if (!fixture) { console.warn('Post-match: fixture not found for day', day); return; }

  fixture.homeScore = ms.homeScore;
  fixture.awayScore = ms.awayScore;

  // Apply standings for this fixture
  const home = league.teams.find(t => t.id === ms.homeTeam.id);
  const away = league.teams.find(t => t.id === ms.awayTeam.id);
  if (home && away) {
    home.goalsFor      = (home.goalsFor      || 0) + ms.homeScore;
    home.goalsAgainst  = (home.goalsAgainst  || 0) + ms.awayScore;
    away.goalsFor      = (away.goalsFor      || 0) + ms.awayScore;
    away.goalsAgainst  = (away.goalsAgainst  || 0) + ms.homeScore;
    home.matchesPlayed = (home.matchesPlayed || 0) + 1;
    away.matchesPlayed = (away.matchesPlayed || 0) + 1;
    if (ms.homeScore > ms.awayScore) {
      home.wins   = (home.wins   || 0) + 1; home.points = (home.points || 0) + 3;
      away.losses = (away.losses || 0) + 1;
      home.recentResults = [...(home.recentResults || []).slice(-4), 'W'];
      away.recentResults = [...(away.recentResults || []).slice(-4), 'L'];
    } else if (ms.homeScore < ms.awayScore) {
      away.wins   = (away.wins   || 0) + 1; away.points = (away.points || 0) + 3;
      home.losses = (home.losses || 0) + 1;
      home.recentResults = [...(home.recentResults || []).slice(-4), 'L'];
      away.recentResults = [...(away.recentResults || []).slice(-4), 'W'];
    } else {
      home.draws  = (home.draws  || 0) + 1; home.points = (home.points || 0) + 1;
      away.draws  = (away.draws  || 0) + 1; away.points = (away.points || 0) + 1;
      home.recentResults = [...(home.recentResults || []).slice(-4), 'D'];
      away.recentResults = [...(away.recentResults || []).slice(-4), 'D'];
    }
    league.pastResults = league.pastResults || [];
    league.pastResults.push({ homeId: fixture.homeId, awayId: fixture.awayId, homeScore: ms.homeScore, awayScore: ms.awayScore });

    // Gold pour cette fixture uniquement
    [{ t: home, s: ms.homeScore, o: ms.awayScore }, { t: away, s: ms.awayScore, o: ms.homeScore }]
      .forEach(({ t, s, o }) => { t.gold = (t.gold || 0) + (s > o ? 400 : s < o ? 150 : 200); });
  }

  // Salaires + avancement matchday seulement quand tous les matchs du jour sont terminés
  let salaryReports = [];
  if (_serverMatches.size === 0) {
    salaryReports = _processSalaries(league);
    league.currentMatchday = (league.currentMatchday || 0) + 1;
  }

  d.leagueJson = JSON.stringify(league);
  saveData(d);

  // Goal events summary for rewards screen
  const goalEvents = ms.events
    .filter(e => e.type === 'GOAL')
    .map(e => ({
      type:         'GOAL',
      teamIndex:    e.teamIndex,
      scorerName:   e.scorer   ? e.scorer.name   : null,
      assisterName: e.assister ? e.assister.name : null,
      minute:       e.minute,
    }));

  io.emit('match_end', {
    matchId,
    homeScore:     ms.homeScore,
    awayScore:     ms.awayScore,
    homeTeamId:    ms.homeTeam.id,
    awayTeamId:    ms.awayTeam.id,
    events:        goalEvents,
    salaryReports: salaryReports,
    injuryReports: [],
    leagueJson:    d.leagueJson,
  });
  io.emit('game_state_updated', { leagueJson: d.leagueJson, sender: '__server__' });
}

function _processSalaries(league) {
  const reports = [];
  league.teams.forEach(team => {
    const replacements = [];
    for (let i = 0; i < team.roster.length; i++) {
      const p = team.roster[i];
      if (p.isFreeTier || !p.salary) continue;
      if (team.gold >= p.salary) {
        team.gold -= p.salary;
      } else {
        p.teamId = null;
        league.freePlayerPool = league.freePlayerPool || [];
        league.freePlayerPool.push(p);
        const rep = _createFreeTierPlayer(p.role);
        team.roster[i] = rep;
        replacements.push({ released: { name: p.name, role: p.role }, replacement: rep });
        team.gold = 0;
      }
    }
    if (replacements.length) reports.push({ teamId: team.id, teamName: team.name, replacements });
  });
  return reports;
}

function _createFreeTierPlayer(role) {
  return {
    id:           'ft_' + Date.now() + '_' + Math.floor(Math.random() * 9999),
    name:         role === 'GOALKEEPER' ? 'Joueur Libre G' : role === 'DEFENDER' ? 'Remplaçant DEF' : 'Avant Gratuit',
    role,
    speed:        1.5 + Math.random(), passAccuracy: 1.5 + Math.random(),
    shotAccuracy: 1.0 + Math.random(), power:        1.5 + Math.random(),
    durability: 5, salary: 0, isFreeTier: true, teamId: null, injured: false, injuryGamesLeft: 0,
  };
}

// Quick-sim toutes les fixtures purement IA (non dans humanFixtureIds)
function _serverQuickSimOtherFixtures(league, humanFixtureIds) {
  const day = league.currentMatchday;
  (league.schedule[day] || []).forEach(f => {
    if (humanFixtureIds.has(`${f.homeId}:${f.awayId}`)) return; // match humain → simulé en live
    if (f.homeScore != null) return; // déjà simulé
    const homeTeam = league.teams.find(t => t.id === f.homeId);
    const awayTeam = league.teams.find(t => t.id === f.awayId);
    if (!homeTeam || !awayTeam) return;
    const r = _serverPoisson(homeTeam, awayTeam);
    f.homeScore = r.h; f.awayScore = r.a;
    _applyAIResult(league, f);
  });
}

function _applyAIResult(league, fixture) {
  const home = league.teams.find(t => t.id === fixture.homeId);
  const away = league.teams.find(t => t.id === fixture.awayId);
  if (!home || !away) return;
  home.goalsFor      = (home.goalsFor      || 0) + fixture.homeScore;
  home.goalsAgainst  = (home.goalsAgainst  || 0) + fixture.awayScore;
  away.goalsFor      = (away.goalsFor      || 0) + fixture.awayScore;
  away.goalsAgainst  = (away.goalsAgainst  || 0) + fixture.homeScore;
  home.matchesPlayed = (home.matchesPlayed || 0) + 1;
  away.matchesPlayed = (away.matchesPlayed || 0) + 1;
  const hs = fixture.homeScore, as = fixture.awayScore;
  if (hs > as) {
    home.wins=(home.wins||0)+1; home.points=(home.points||0)+3; away.losses=(away.losses||0)+1;
    home.recentResults=[...(home.recentResults||[]).slice(-4),'W']; away.recentResults=[...(away.recentResults||[]).slice(-4),'L'];
  } else if (hs < as) {
    away.wins=(away.wins||0)+1; away.points=(away.points||0)+3; home.losses=(home.losses||0)+1;
    home.recentResults=[...(home.recentResults||[]).slice(-4),'L']; away.recentResults=[...(away.recentResults||[]).slice(-4),'W'];
  } else {
    home.draws=(home.draws||0)+1; home.points=(home.points||0)+1;
    away.draws=(away.draws||0)+1; away.points=(away.points||0)+1;
    home.recentResults=[...(home.recentResults||[]).slice(-4),'D']; away.recentResults=[...(away.recentResults||[]).slice(-4),'D'];
  }
  league.pastResults=league.pastResults||[]; league.pastResults.push({...fixture});
}

function _serverPoisson(homeTeam, awayTeam) {
  const attRating = t => t.roster.reduce((s, p) => p.role === 'ATTACKER' ? s + ((p.speed||0)+(p.shotAccuracy||0))/2 : s, 0);
  const defRating = t => t.roster.reduce((s, p) => p.role !== 'GOALKEEPER' ? s + ((p.speed||0)+(p.power||0))/2 : s, 0);
  const attH = attRating(homeTeam) || 1, defH = defRating(homeTeam) || 1;
  const attA = attRating(awayTeam) || 1, defA = defRating(awayTeam) || 1;
  const lH = Math.max(0.2, 1.2 * (attH / (attH + defA)) * 2.8 + 0.15);
  const lA = Math.max(0.2, 1.2 * (attA / (attA + defH)) * 2.8);
  const ps = l => { let k=0, p=Math.exp(-l), s=p, r=Math.random(); while(s<r){k++;p*=l/k;s+=p;} return k; };
  return { h: ps(lH), a: ps(lA) };
}

// ── Démarrer un match serveur (supporte plusieurs en parallèle) ───────────────
function _startServerMatch(homeTeam, awayTeam, matchday) {
  const matchId = `${homeTeam.id}:${awayTeam.id}`;
  if (_serverMatches.has(matchId)) {
    // Match déjà en cours — re-diffuser match_start pour les clients reconnectés
    const entry = _serverMatches.get(matchId);
    console.log(`🔄 Match déjà en cours (${matchId}), re-diffusion match_start`);
    io.emit('match_start', _buildMatchStartPayload(entry.ms, matchId));
    return;
  }

  let ms;
  try {
    const seed = _serverMatchSeed(matchday, homeTeam.id, awayTeam.id);
    ms = _sim.createMatchState(homeTeam, awayTeam, seed);
  } catch (e) {
    console.error(`❌ Erreur createMatchState pour ${matchId}:`, e.message, e.stack);
    return;
  }

  const entry = { ms, matchday, eventIdx: 0, halftimeEmitted: false, ticksSinceEmit: 0 };
  _serverMatches.set(matchId, entry);

  io.emit('match_start', _buildMatchStartPayload(ms, matchId));
  console.log(`⚽ Match serveur démarré : ${homeTeam.name} vs ${awayTeam.name} (id ${matchId})`);

  entry.interval = setInterval(() => {
    _sim.matchTick(ms);
    entry.ticksSinceEmit++;

    // ── Mi-temps ────────────────────────────────────────────────────────────
    if (ms.state === 'HALFTIME' && !entry.halftimeEmitted) {
      entry.halftimeEmitted = true;
      io.emit('match_halftime', {
        matchId,
        homeScore: ms.homeScore,
        awayScore: ms.awayScore,
        homeName:  ms.homeTeam.name,
        awayName:  ms.awayTeam.name,
      });
    }
    if (ms.halfTimeDone) entry.halftimeEmitted = false;

    // ── Nouveaux événements (buts, tirs, coups) ─────────────────────────────
    if (ms.events.length > entry.eventIdx) {
      ms.events.slice(entry.eventIdx).forEach(ev => {
        if (ev.type === 'GOAL') {
          const team = ev.teamIndex === 0 ? ms.homeTeam : ms.awayTeam;
          io.emit('match_event', {
            matchId,
            type:         'GOAL',
            teamIndex:    ev.teamIndex,
            teamColor:    team.color,
            scorerName:   ev.scorer   ? ev.scorer.name   : null,
            assisterName: ev.assister ? ev.assister.name : null,
            minute:       ev.minute,
            homeScore:    ms.homeScore,
            awayScore:    ms.awayScore,
            replay:       ms.replaySnapshot || null,
          });
          ms.replaySnapshot = null;
        } else {
          io.emit('match_event', {
            matchId,
            type:      ev.type,
            name:      ev.name,
            targetName:ev.targetName,
            teamIndex: ev.displayTeamIndex,
            minute:    ev.minute,
            ko:        ev.ko,
          });
        }
      });
      entry.eventIdx = ms.events.length;
    }

    // ── Diffusion état toutes les 3 ticks (~20 fps) ─────────────────────────
    if (entry.ticksSinceEmit >= 3) {
      entry.ticksSinceEmit = 0;
      io.emit('match_tick', _buildMatchTickPayload(ms, matchId));
    }

    // ── Fin du match ────────────────────────────────────────────────────────
    if (ms.state === 'FULL_TIME') {
      clearInterval(entry.interval);
      _serverPostMatch(matchId);
    }
  }, _MATCH_TICK_MS);
}

// ── Helpers jeu ───────────────────────────────────────────────────────────────
function playerAvg(p) {
  return ((p.speed || 0) + (p.passAccuracy || 0) + (p.shotAccuracy || 0) + (p.power || 0)) / 4;
}
function playerTransferFee(p) {
  if (!p || p.isFreeTier || !p.salary) return 0;
  return Math.round(p.salary * 3 + playerAvg(p) * 20);
}

// Shuffle déterministe pour pool identique pour tous (graine = matchday)
function seededShuffle(arr, seed) {
  const a = [...arr];
  let s = (seed + 1) >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Génère ou récupère le pool fixe pour le matchday actuel
function getMercatoPool(d) {
  if (!d.leagueJson) return [];
  let league;
  try { league = JSON.parse(d.leagueJson); } catch { return []; }

  const matchday = league.currentMatchday || 0;
  if (d.mercatoPool && d.mercatoMatchday === matchday) return d.mercatoPool;

  const shuffled = seededShuffle(league.freePlayerPool || [], matchday);
  const pool = shuffled.slice(0, Math.min(20, shuffled.length));

  d.mercatoPool      = pool;
  d.mercatoMatchday  = matchday;
  d.bids             = {};
  d.mercatoResolved  = false;
  saveData(d);
  return pool;
}

// Résolution des enchères (idempotent)
function resolveMercato(d) {
  if (d.mercatoResolved) return { changed: false, leagueJson: d.leagueJson };
  if (!d.leagueJson)     return { changed: false, leagueJson: d.leagueJson };

  let league;
  try { league = JSON.parse(d.leagueJson); } catch { return { changed: false }; }

  const bids = d.bids || {};
  const pool = d.mercatoPool || [];

  // ── Appliquer les enchères gagnantes ─────────────────────────────────────
  Object.entries(bids).forEach(([playerId, bid]) => {
    if (!bid || bid.amount <= 0) return;
    const player = pool.find(p => p.id === playerId);
    if (!player) return;

    const claim   = d.claims.find(c => c.username === bid.username);
    if (!claim) return;
    const teamIdx = claim.teamIndex !== undefined ? claim.teamIndex : claim.team_index;
    const team    = league.teams[teamIdx];
    if (!team) return;

    if (team.gold < bid.amount) return;      // pas assez d'or
    const slot = bid.rosterSlot;
    const toReplace = team.roster[slot];
    if (!toReplace || toReplace.role !== player.role) return;  // rôle incompatible

    // Exécuter le transfert
    team.gold -= bid.amount;
    toReplace.teamId = null;
    if (!toReplace.isFreeTier) league.freePlayerPool.push(toReplace);
    league.freePlayerPool = league.freePlayerPool.filter(p => p.id !== player.id);
    team.roster[slot] = { ...player, teamId: team.id };
  });

  // ── Mercato IA (après les humains) ───────────────────────────────────────
  league.teams.forEach(team => {
    if (team.isHuman) return;
    const weakest = [...team.roster].sort((a, b) => playerAvg(a) - playerAvg(b))[0];
    if (!weakest) return;
    const candidates = (league.freePlayerPool || [])
      .filter(p => p.role === weakest.role && playerAvg(p) > playerAvg(weakest))
      .filter(p => playerTransferFee(p) <= team.gold * 0.45)
      .sort((a, b) => playerAvg(b) - playerAvg(a));
    if (!candidates.length) return;
    const pick = candidates[0];
    const fee  = playerTransferFee(pick);
    team.gold -= fee;
    const rIdx = team.roster.indexOf(weakest);
    weakest.teamId = null;
    if (!weakest.isFreeTier) league.freePlayerPool.push(weakest);
    league.freePlayerPool = league.freePlayerPool.filter(p => p.id !== pick.id);
    if (rIdx !== -1) team.roster[rIdx] = { ...pick, teamId: team.id };
  });

  d.leagueJson      = JSON.stringify(league);
  d.mercatoResolved = true;
  d.bids            = {};
  saveData(d);
  return { changed: true, leagueJson: d.leagueJson };
}

// ── Auth middleware ───────────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = (req.headers.authorization || '').split(' ')[1];
  try { req.user = jwt.verify(token, SECRET); next(); }
  catch { res.status(401).json({ error: 'Token invalide ou expiré' }); }
}
function adminAuth(req, res, next) {
  auth(req, res, () => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Réservé à l\'administrateur' });
    next();
  });
}

// ── Helpers lobby ─────────────────────────────────────────────────────────────
function getLobbyData() {
  const d = loadData();
  return { claims: d.claims, started: !!d.started };
}
function broadcastLobby() { io.emit('lobby_update', getLobbyData()); }

// ── REST : Utilitaires ────────────────────────────────────────────────────────
app.get('/api/ping', (_req, res) => res.json({ ok: true }));

app.get('/api/me', auth, (req, res) => {
  const user = loadData().users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  res.json({ id: user.id, username: user.username, isAdmin: user.isAdmin });
});

// ── REST : Auth ───────────────────────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Pseudo et mot de passe requis' });
  if (username.trim().length < 3)
    return res.status(400).json({ error: 'Pseudo : 3 caractères minimum' });
  if (password.length < 4)
    return res.status(400).json({ error: 'Mot de passe : 4 caractères minimum' });

  const d    = loadData();
  const name = username.trim();
  if (d.users.find(u => u.username.toLowerCase() === name.toLowerCase()))
    return res.status(409).json({ error: 'Ce pseudo est déjà pris' });

  const isAdmin      = d.users.length === 0;
  const passwordHash = bcrypt.hashSync(password, 10);
  const id           = Date.now();
  d.users.push({ id, username: name, passwordHash, isAdmin });
  saveData(d);

  const token = jwt.sign({ id, username: name, isAdmin }, SECRET, { expiresIn: '30d' });
  res.json({ token, id, username: name, isAdmin });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const d    = loadData();
  const user = d.users.find(u => u.username.toLowerCase() === (username || '').trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password || '', user.passwordHash))
    return res.status(401).json({ error: 'Identifiants incorrects' });

  const token = jwt.sign(
    { id: user.id, username: user.username, isAdmin: user.isAdmin },
    SECRET, { expiresIn: '30d' }
  );
  res.json({ token, id: user.id, username: user.username, isAdmin: user.isAdmin });
});

// ── REST : Lobby ──────────────────────────────────────────────────────────────
app.get('/api/lobby', auth, (_req, res) => res.json(getLobbyData()));

app.post('/api/claim', auth, (req, res) => {
  const { teamIndex } = req.body || {};
  if (typeof teamIndex !== 'number' || teamIndex < 0 || teamIndex > 11)
    return res.status(400).json({ error: 'Index invalide' });
  const d = loadData();
  if (d.started) return res.status(400).json({ error: 'La saison a déjà commencé' });
  if (d.claims.find(c => c.teamIndex === teamIndex && c.userId !== req.user.id))
    return res.status(409).json({ error: 'Cette équipe est déjà prise' });
  d.claims = d.claims.filter(c => c.userId !== req.user.id);
  d.claims.push({ teamIndex, userId: req.user.id, username: req.user.username });
  saveData(d);
  broadcastLobby();
  res.json({ ok: true });
});

app.post('/api/unclaim', auth, (req, res) => {
  const d = loadData();
  d.claims = d.claims.filter(c => c.userId !== req.user.id);
  saveData(d);
  broadcastLobby();
  res.json({ ok: true });
});

// ── REST : Saison ─────────────────────────────────────────────────────────────
app.post('/api/start-season', adminAuth, (req, res) => {
  const { leagueJson } = req.body || {};
  if (!leagueJson) return res.status(400).json({ error: 'leagueJson manquant' });
  const d = loadData();
  d.leagueJson       = leagueJson;
  d.started          = true;
  d.mercatoPool      = null;
  d.mercatoMatchday  = -1;
  d.bids             = {};
  d.mercatoResolved  = false;
  d.timeOffsetMs     = 0;
  saveData(d);
  io.emit('season_started', { leagueJson, claims: d.claims });
  res.json({ ok: true });
});

app.post('/api/reset-season', adminAuth, (_req, res) => {
  const d = loadData();
  d.leagueJson      = null;
  d.started         = false;
  d.claims          = [];
  d.mercatoPool     = null;
  d.mercatoMatchday = -1;
  d.bids            = {};
  d.mercatoResolved = false;
  d.timeOffsetMs    = 0;
  saveData(d);
  broadcastLobby();
  io.emit('season_reset');
  res.json({ ok: true });
});

app.get('/api/game-state', auth, (_req, res) => {
  const d = loadData();
  res.json({ leagueJson: d.leagueJson || null, started: !!d.started, claims: d.claims, timeOffsetMs: d.timeOffsetMs || 0 });
});


app.post('/api/game-state', auth, (req, res) => {
  const { leagueJson } = req.body || {};
  if (!leagueJson) return res.status(400).json({ error: 'leagueJson manquant' });
  const d = loadData();
  d.leagueJson = leagueJson;
  saveData(d);
  io.emit('game_state_updated', { leagueJson, sender: req.user.username });
  res.json({ ok: true });
});

// ── REST : Enchères ───────────────────────────────────────────────────────────

// GET /api/mercato/pool — pool fixe + enchères actuelles
app.get('/api/mercato/pool', auth, (req, res) => {
  const d    = loadData();
  if (!d.started) return res.status(400).json({ error: 'Saison non démarrée' });
  const pool = getMercatoPool(d);
  res.json({ pool, bids: d.bids || {}, resolved: !!d.mercatoResolved });
});

// POST /api/mercato/bid — placer/surenchérir
app.post('/api/mercato/bid', auth, (req, res) => {
  const { playerId, amount, rosterSlot } = req.body || {};
  if (!playerId || typeof amount !== 'number' || typeof rosterSlot !== 'number')
    return res.status(400).json({ error: 'Paramètres invalides' });

  const d = loadData();
  if (!d.started)       return res.status(400).json({ error: 'Saison non démarrée' });
  if (d.mercatoResolved) return res.status(400).json({ error: 'Les enchères sont terminées' });

  const pool   = getMercatoPool(d);
  const player = pool.find(p => p.id === playerId);
  if (!player) return res.status(404).json({ error: 'Joueur non trouvé dans le pool' });

  const claim = d.claims.find(c => c.username === req.user.username);
  if (!claim) return res.status(400).json({ error: 'Vous n\'avez pas d\'équipe' });

  let league;
  try { league = JSON.parse(d.leagueJson); } catch { return res.status(500).json({ error: 'Erreur état jeu' }); }

  const teamIdx = claim.teamIndex !== undefined ? claim.teamIndex : claim.team_index;
  const team    = league.teams[teamIdx];
  if (!team) return res.status(404).json({ error: 'Équipe introuvable' });

  const minBid     = Math.max(1, playerTransferFee(player));
  const currentBid = (d.bids || {})[playerId];

  if (amount < minBid)
    return res.status(400).json({ error: `Enchère minimum : ${minBid} or` });
  if (currentBid && amount <= currentBid.amount)
    return res.status(400).json({ error: `L'enchère doit dépasser ${currentBid.amount} or` });
  if (team.gold < amount)
    return res.status(400).json({ error: `Pas assez d'or (vous avez ${team.gold} or)` });

  // Vérification du budget global : somme de toutes les enchères où ce joueur
  // est le PLUS HAUT enchérisseur (hors le joueur concerné par cette enchère,
  // puisque la nouvelle enchère le remplace ou c'est une première enchère).
  const bids = d.bids || {};
  const alreadyCommitted = Object.entries(bids).reduce((sum, [pid, bid]) => {
    if (pid === playerId) return sum;          // cette enchère va être remplacée ou est nouvelle
    if (bid.username !== req.user.username) return sum; // pas notre enchère
    return sum + bid.amount;                  // on est le plus haut sur ce joueur
  }, 0);
  if (alreadyCommitted + amount > team.gold) {
    return res.status(400).json({
      error: `Budget insuffisant : vos enchères actives totalisent déjà ${alreadyCommitted} or, vous ne pouvez pas miser plus de ${team.gold - alreadyCommitted} or supplémentaires`,
    });
  }

  const toReplace = team.roster[rosterSlot];
  if (!toReplace || toReplace.role !== player.role)
    return res.status(400).json({ error: 'Rôle incompatible avec ce poste' });

  if (!d.bids) d.bids = {};
  d.bids[playerId] = { amount, username: req.user.username, userId: req.user.id, rosterSlot };
  saveData(d);

  io.emit('bid_update', { playerId, bid: d.bids[playerId] });
  res.json({ ok: true });
});

// ── POST /api/match/start — démarre tous les matchs humains du jour ───────────
app.post('/api/match/start', auth, (req, res) => {
  if (!_sim.createMatchState) return res.status(500).json({ error: 'Simulation engine non chargé' });

  const d = loadData();
  if (!d.leagueJson) return res.status(400).json({ error: 'Pas de ligue active' });

  let league;
  try { league = JSON.parse(d.leagueJson); } catch { return res.status(500).json({ error: 'leagueJson invalide' }); }

  const day = league.currentMatchday;
  if (day >= (league.schedule || []).length)
    return res.status(400).json({ error: 'Saison terminée' });

  const fixtures     = league.schedule[day] || [];
  const humanTeamIds = new Set(d.claims.map(c => league.teams[c.teamIndex]?.id).filter(Boolean));

  // Toutes les fixtures impliquant au moins une équipe humaine
  let humanFixtures = fixtures.filter(f => humanTeamIds.has(f.homeId) || humanTeamIds.has(f.awayId));
  if (humanFixtures.length === 0) humanFixtures = [fixtures[0]].filter(Boolean); // fallback

  // Quick-sim uniquement les fixtures purement IA
  const humanFixtureIds = new Set(humanFixtures.map(f => `${f.homeId}:${f.awayId}`));
  _serverQuickSimOtherFixtures(league, humanFixtureIds);
  d.leagueJson = JSON.stringify(league);
  saveData(d);
  io.emit('game_state_updated', { leagueJson: d.leagueJson, sender: '__server__' });

  // Démarrer un match serveur pour chaque fixture humaine (pas déjà terminé / en cours)
  const started = [];
  humanFixtures.forEach(f => {
    if (f.homeScore != null) return; // déjà joué
    const homeTeam = league.teams.find(t => t.id === f.homeId);
    const awayTeam = league.teams.find(t => t.id === f.awayId);
    if (!homeTeam || !awayTeam) return;
    _startServerMatch(homeTeam, awayTeam, day);
    started.push(`${homeTeam.name} vs ${awayTeam.name}`);
  });

  res.json({ ok: true, matches: started });
});

// ── POST /api/trump-card — enregistre la carte atout de l'équipe du joueur ─────
app.post('/api/trump-card', auth, (req, res) => {
  const { cardId } = req.body;   // string ou null
  const d = loadData();
  if (!d.leagueJson) return res.status(400).json({ error: 'Pas de ligue active' });

  const claim = d.claims.find(c => c.username === req.user.username);
  if (!claim) return res.status(400).json({ error: 'Aucune équipe revendiquée' });

  let league;
  try { league = JSON.parse(d.leagueJson); } catch { return res.status(500).json({ error: 'JSON invalide' }); }

  const team = league.teams[claim.teamIndex];
  if (!team) return res.status(404).json({ error: 'Équipe introuvable' });

  team.trumpCard = cardId || null;
  d.leagueJson = JSON.stringify(league);
  saveData(d);

  // Diffuser aux autres joueurs pour qu'ils voient la mise à jour
  io.emit('game_state_updated', { leagueJson: d.leagueJson, sender: req.user.username });
  res.json({ ok: true, trumpCard: team.trumpCard });
});

// POST /api/mercato/resolve — clôture des enchères (idempotent)
app.post('/api/mercato/resolve', auth, (req, res) => {
  const d      = loadData();
  const result = resolveMercato(d);
  if (result.changed) {
    io.emit('game_state_updated', { leagueJson: result.leagueJson, sender: req.user.username });
    io.emit('mercato_resolved', { bids: d.bids || {} });
  }
  res.json({ ok: true, leagueJson: result.leagueJson || d.leagueJson });
});

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('🔌 Connecté :', socket.id);
  const d = loadData();
  socket.emit('lobby_update', getLobbyData());
  // Toujours synchroniser l'offset de temps dès la connexion
  socket.emit('time_updated', { timeOffsetMs: d.timeOffsetMs || 0 });
  if (d.started && d.leagueJson) {
    socket.emit('game_state_updated', { leagueJson: d.leagueJson, claims: d.claims });
    if (!d.mercatoResolved && d.mercatoPool) {
      socket.emit('mercato_pool', { pool: d.mercatoPool, bids: d.bids || {} });
    }
  }
  // Envoyer l'état de tous les matchs en cours si le joueur reconnecte
  _serverMatches.forEach((entry, matchId) => {
    if (entry.ms.state !== 'FULL_TIME') {
      socket.emit('match_start', _buildMatchStartPayload(entry.ms, matchId));
      socket.emit('match_tick',  _buildMatchTickPayload(entry.ms, matchId));
    }
  });
  socket.on('disconnect', () => console.log('🔌 Déconnecté :', socket.id));
});

// ── Démarrage ─────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n⚽  Football Mutant → http://localhost:${PORT}`);
  console.log(`    Premier compte créé = administrateur.\n`);
});
