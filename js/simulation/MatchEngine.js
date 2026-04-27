/* ═══════════════════════════════════════════
   MatchEngine — match state, tick loop, goals
   ═══════════════════════════════════════════ */

// ── Mulberry32 — fast, high-quality 32-bit seedable PRNG ─────────────────────
function mulberry32(seed) {
  return function() {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Hash a string to a uint32 (FNV-1a) ───────────────────────────────────────
function _hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h;
}

// Match duration constants
const TICKS_PER_SECOND = 60;
const MATCH_REAL_SECS  = 240;  // 4 real minutes
const TOTAL_TICKS      = TICKS_PER_SECOND * MATCH_REAL_SECS;  // 14400
const HALFTIME_TICK    = TOTAL_TICKS / 2;                     // 7200
const HALFTIME_PAUSE   = 180;   // ticks (3 seconds)
const GOAL_PAUSE       = 180;   // ticks (3 seconds)
const KICKOFF_PAUSE    = 90;    // ticks (1.5 seconds)

// Starting positions indexed by teamIndex (0=home attacks right, 1=away attacks left)
const START_POS = [
  // Team 0 — home
  { role:'GOALKEEPER', x:26,          y:220 },
  { role:'DEFENDER',   x:155,         y:220 },
  { role:'ATTACKER',   x:255,         y:155 },
  { role:'ATTACKER',   x:255,         y:285 },
  // Team 1 — away
  { role:'GOALKEEPER', x:PITCH_W-26,  y:220 },
  { role:'DEFENDER',   x:PITCH_W-155, y:220 },
  { role:'ATTACKER',   x:PITCH_W-255, y:155 },
  { role:'ATTACKER',   x:PITCH_W-255, y:285 },
];

// ── Create match state ───────────────────────────────────────────────────────
// matchSeed must be the same for all clients watching the same fixture.
// Compute it as: _hashStr(matchday + ':' + homeTeam.id + ':' + awayTeam.id)
function createMatchState(homeTeam, awayTeam, matchSeed) {
  // Initialize the shared seeded RNG for this match
  const seed = (matchSeed !== undefined) ? (matchSeed >>> 0) : _hashStr(homeTeam.id + ':' + awayTeam.id);
  setSimRng(mulberry32(seed));
  const agents = [];

  [homeTeam, awayTeam].forEach((team, ti) => {
    const gk   = team.roster.find(p => p.role === 'GOALKEEPER') || team.roster[3];
    const def  = team.roster.find(p => p.role === 'DEFENDER')   || team.roster[2];
    const atts = team.roster.filter(p => p.role === 'ATTACKER');
    const att1 = atts[0] || team.roster[0];
    const att2 = atts[1] || team.roster[1];
    // Order matches START_POS: GK(0), DEF(1), ATT1(2), ATT2(3)
    [gk, def, att1, att2].forEach((player, ri) => {
      // Use custom formation if available; away team mirrors X axis
      let pos;
      if (team.formation && team.formation.positions && team.formation.positions[ri]) {
        const fp = team.formation.positions[ri];
        pos = { x: ti === 1 ? PITCH_W - fp.x : fp.x, y: fp.y };
      } else {
        pos = START_POS[ti * 4 + ri];
      }
      const agent = createAgent(player, ti, pos.x, pos.y);
      agent.formationX = pos.x;
      agent.formationY = pos.y;
      agents.push(agent);
    });
  });

  // ── Apply trump card modifiers (in-game stats only, durability handled post-match) ──
  [homeTeam, awayTeam].forEach((team, ti) => {
    if (!team.trumpCard || !TRUMP_CARDS[team.trumpCard]) return;
    const mods = TRUMP_CARDS[team.trumpCard].mods;
    agents.filter(a => a.displayTeamIndex === ti).forEach(agent => {
      Object.entries(mods).forEach(([stat, delta]) => {
        if (stat === 'durability') return; // handled in Salary.processInjuries
        if (agent[stat] !== undefined) {
          agent[stat] = Math.max(0, agent[stat] + delta);
        }
      });
    });
  });

  // Kickoff: home team's first attacker starts at centre circle with the ball
  const kickoffAgent = agents.find(a => a.teamIndex === 0 && a.role === 'ATTACKER');
  kickoffAgent.x = 340; kickoffAgent.y = 220;
  kickoffAgent.targetX = 340; kickoffAgent.targetY = 220;
  kickoffAgent.hasBall = true;
  kickoffAgent.controlTimer = KICKOFF_PAUSE;

  const ball = createBall(340, 220);
  ball.owner = kickoffAgent;

  return {
    homeTeam, awayTeam,
    agents,
    ball,
    homeScore: 0,
    awayScore: 0,
    tick:           0,
    simMinutes:     0,
    state:          'ACTIVE',  // 'ACTIVE'|'GOAL_PAUSE'|'HALFTIME'|'FULL_TIME'
    pauseTimer:     0,
    halfTimeDone:   false,
    nextKickoffTeam: 1,        // who kicks off after a goal (alternates & after conceding)
    events:         [],
    particles:      [],
    shakeX: 0, shakeY: 0, shakeTimer: 0,
    possessionA: 0, possessionB: 0,
    savesHome:   0,  // saves made by home GK (displayTeamIndex 0)
    savesAway:   0,  // saves made by away GK (displayTeamIndex 1)
    lastGoalInfo: null,
    speedMult: 1,  // 1 or 2 (player-controlled)
    _snapBuffer:    [],   // rolling 90-frame snapshot for goal replay
    replaySnapshot: null, // filled when a goal is scored
  };
}

// ── Master tick function (called each animation frame) ───────────────────────
function matchTick(ms) {
  const steps = ms.speedMult || 1;
  for (let s = 0; s < steps; s++) {
    _singleTick(ms);
    if (ms.state === 'FULL_TIME') break;
  }
}

function _singleTick(ms) {
  if (ms.state === 'FULL_TIME') return;

  // ── Pause countdown ──
  if (ms.state === 'GOAL_PAUSE' || ms.state === 'HALFTIME') {
    ms.pauseTimer--;
    if (ms.pauseTimer <= 0) {
      if (ms.state === 'HALFTIME') {
        ms.halfTimeDone = true;
        resumeAfterHalftime(ms);
      } else {
        doKickoff(ms);
      }
    }
    updateParticles(ms.particles);
    updateShake(ms);
    return;
  }

  ms.tick++;
  ms.simMinutes = (ms.tick / TOTAL_TICKS) * 90;

  // ── Agent AI + movement ──
  ms.agents.forEach(a => {
    if (a.hasBall) {
      // Ball follows owner
      ms.ball.x = a.x;
      ms.ball.y = a.y;
    }
    updateAgent(a, ms);
  });

  // ── Ball physics (when free) ──
  if (!ms.ball.owner) {
    updateBall(ms.ball);
  }

  // ── Ball capture ──
  checkBallCapture(ms);

  // ── Possession tracking ──
  if (ms.ball.owner) {
    if (ms.ball.owner.teamIndex === 0) ms.possessionA++;
    else ms.possessionB++;
  }

  // ── Snapshot for goal replay (record positions before any goal reset) ──
  ms._snapBuffer.push({
    ball:   { x: ms.ball.x, y: ms.ball.y },
    agents: ms.agents.map((a, i) => ({ key: a.id || i, x: a.x, y: a.y })),
  });
  if (ms._snapBuffer.length > 90) ms._snapBuffer.shift();

  // ── Goal detection ──
  if (!ms.ball.owner) {
    const goal = detectGoal(ms.ball);
    if (goal) {
      triggerGoal(ms, goal);
      return;
    }
  }

  // ── Half time ──
  if (!ms.halfTimeDone && ms.tick >= HALFTIME_TICK) {
    triggerHalftime(ms);
    return;
  }

  // ── Full time ──
  if (ms.tick >= TOTAL_TICKS) {
    ms.state = 'FULL_TIME';
    return;
  }

  // ── Particles & shake ──
  updateParticles(ms.particles);
  updateShake(ms);
}

// ── Goal ─────────────────────────────────────────────────────────────────────
function triggerGoal(ms, goalSide) {
  // Save replay snapshot BEFORE ball/agents are reset
  ms.replaySnapshot = ms._snapBuffer.length ? [...ms._snapBuffer] : null;
  ms._snapBuffer = [];

  // Use scorer's displayTeamIndex to determine home/away attribution,
  // which is stable across the half-time tactical swap.
  const scorer = ms.ball.lastOwner;

  let scoringDisplayTeam;
  if (scorer) {
    // Most reliable: use the last player who touched the ball
    scoringDisplayTeam = scorer.displayTeamIndex;
  } else {
    // Fallback: infer from which tactical teamIndex attacks which side
    // teamIndex=0 always attacks RIGHT in any given half
    const teamIdxZeroAgent = ms.agents.find(a => a.teamIndex === 0);
    const displayOfTac0 = teamIdxZeroAgent ? teamIdxZeroAgent.displayTeamIndex : 0;
    scoringDisplayTeam = goalSide === 'RIGHT' ? displayOfTac0 : 1 - displayOfTac0;
  }

  if (scoringDisplayTeam === 0) ms.homeScore++;
  else                           ms.awayScore++;

  const assister = (ms.ball.lastPasser
    && scorer
    && ms.ball.lastPasser !== scorer
    && ms.ball.lastPasser.displayTeamIndex === scorer.displayTeamIndex)
    ? ms.ball.lastPasser : null;

  ms.lastGoalInfo = {
    scorer,
    assister,
    teamIndex:  scoringDisplayTeam,   // kept as displayTeam for consistent event reads
    homeScore:  ms.homeScore,
    awayScore:  ms.awayScore,
    minute:     Math.floor(ms.simMinutes),
  };
  ms.events.push({ type: 'GOAL', ...ms.lastGoalInfo });
  ms.ball.lastPasser = null;

  // Release all ball holders
  ms.agents.forEach(a => { a.hasBall = false; });
  ms.ball.owner     = null;
  ms.ball.lastOwner = null;
  ms.ball.vx = 0; ms.ball.vy = 0;
  ms.ball.x = 340; ms.ball.y = 220;

  // Visual effects
  const teamColor = scoringDisplayTeam === 0
    ? ms.homeTeam.color : ms.awayTeam.color;
  spawnGoalParticles(ms, teamColor);
  startShake(ms, 8, 35);

  // The team that conceded kicks off next (in tactical terms)
  // Find which tactical teamIndex belongs to the conceding display team
  const concedingDisplay = 1 - scoringDisplayTeam;
  const concedingAgent   = ms.agents.find(a => a.displayTeamIndex === concedingDisplay);
  ms.nextKickoffTeam = concedingAgent ? concedingAgent.teamIndex : 1 - (ms.nextKickoffTeam);
  ms.state = 'GOAL_PAUSE';
  ms.pauseTimer = GOAL_PAUSE;
}

// ── Halftime ──────────────────────────────────────────────────────────────────
function triggerHalftime(ms) {
  ms.state = 'HALFTIME';
  ms.pauseTimer = HALFTIME_PAUSE;
  ms.agents.forEach(a => { a.hasBall = false; a.vx = 0; a.vy = 0; });
  ms.ball.owner = null; ms.ball.vx = 0; ms.ball.vy = 0;
}

function resumeAfterHalftime(ms) {
  // Swap tactical direction: each agent now attacks the opposite goal
  ms.agents.forEach(a => {
    a.teamIndex = 1 - a.teamIndex; // displayTeamIndex stays unchanged (rendering)
    a.vx = 0; a.vy = 0;
    a.hasBall = false;
  });
  // Away team kicks off second half
  ms.nextKickoffTeam = 1;
  doKickoff(ms); // resetAgentsToStart places them at correct second-half positions
}

function doKickoff(ms) {
  resetAgentsToStart(ms);
  const kickoffAgent = ms.agents.find(
    a => a.teamIndex === ms.nextKickoffTeam && a.role === 'ATTACKER'
  );
  if (kickoffAgent) {
    // Place kicker at centre circle
    kickoffAgent.x = 340; kickoffAgent.y = 220;
    kickoffAgent.targetX = 340; kickoffAgent.targetY = 220;
    kickoffAgent.vx = 0; kickoffAgent.vy = 0;
    kickoffAgent.hasBall = true;
    kickoffAgent.controlTimer = KICKOFF_PAUSE;
    ms.ball.x = 340; ms.ball.y = 220;
    ms.ball.owner = kickoffAgent;
    ms.ball.vx = 0; ms.ball.vy = 0;
    ms.ball.trail = [];
  }
  ms.state = 'ACTIVE';
}

function resetAgentsToStart(ms) {
  // Re-place agents at starting positions (accounting for possible side-swap)
  ms.agents.forEach((a, i) => {
    const posIdx = a.teamIndex * 4 + (['GOALKEEPER','DEFENDER','ATTACKER','ATTACKER'].indexOf(a.role));
    // Find role index among same team+role
    const sameRoleAgents = ms.agents.filter(b => b.teamIndex === a.teamIndex && b.role === a.role);
    const myRoleIdx = sameRoleAgents.indexOf(a);
    let baseIdx;
    if (a.role === 'GOALKEEPER') baseIdx = 0;
    else if (a.role === 'DEFENDER') baseIdx = 1;
    else baseIdx = 2 + myRoleIdx;

    const pos = START_POS[a.teamIndex * 4 + baseIdx];
    if (pos) { a.x = pos.x; a.y = pos.y; }
    a.vx = 0; a.vy = 0;
    a.hasBall = false;
    a.targetX = a.x; a.targetY = a.y;
  });
}

// ── Particles ─────────────────────────────────────────────────────────────────
function spawnGoalParticles(ms, color) {
  for (let i = 0; i < 40; i++) {
    const angle = Math.random() * Math.PI * 2;
    const spd   = 2 + Math.random() * 6;
    ms.particles.push({
      x: 340, y: 220,
      vx: Math.cos(angle) * spd,
      vy: Math.sin(angle) * spd,
      color,
      size:    3 + Math.random() * 5,
      life:    60 + Math.floor(Math.random() * 40),
      maxLife: 100,
    });
  }
}

function updateParticles(particles) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.18;  // gravity
    p.vx *= 0.96;
    p.life--;
    if (p.life <= 0) particles.splice(i, 1);
  }
}

function startShake(ms, amount, ticks) {
  ms.shakeTimer  = ticks;
  ms.shakeAmount = amount;
}
function updateShake(ms) {
  if (ms.shakeTimer > 0) {
    ms.shakeTimer--;
    ms.shakeAmount = (ms.shakeTimer / 35) * 7;
    ms.shakeX = (Math.random() * 2 - 1) * ms.shakeAmount;
    ms.shakeY = (Math.random() * 2 - 1) * ms.shakeAmount;
  } else {
    ms.shakeX = 0; ms.shakeY = 0;
  }
}
