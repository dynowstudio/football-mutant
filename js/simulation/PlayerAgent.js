/* ═══════════════════════════════════════════
   PlayerAgent — AI decision making & movement
   ═══════════════════════════════════════════ */

// ── Constants ─────────────────────────────────────────────────────────────
const CAPTURE_RADIUS   = 18;  // px — ball capture range (tighter = fewer cheap intercepts)
const SHOOT_RANGE      = 225; // px — zone de tir normale (élargie)
const LONG_SHOT_RANGE  = 400; // px — zone de tir longue distance
const PASS_MAX_RANGE   = 420; // px — allow longer switch passes

// Speed: units per tick. range ~1.5 (slow) to 4.0 (elite)
function playerSpeed(p) {
  return 1.5 + (p.speed / 10) * 2.5;
}

// ── Create simulation agent (wraps a player for match use) ─────────────────
function createAgent(player, teamIndex, posX, posY) {
  return {
    // ---- player data (reference copy) ----
    id:           player.id,
    name:         player.name,
    role:         player.role,
    speed:        player.speed,
    passAccuracy: player.passAccuracy,
    shotAccuracy: player.shotAccuracy,
    power:        player.power,        // force physique (coups de poing)
    durability:   player.durability !== undefined ? player.durability : 5,
    salary:       player.salary,
    isFreeTier:   player.isFreeTier,

    // ---- team ----
    teamIndex,          // tactical index, flips at halftime
    displayTeamIndex: teamIndex, // permanent — used for rendering (color)

    // ---- formation (set by createMatchState) ----
    formationX: posX,  // home position X in sim coords
    formationY: posY,  // home position Y in sim coords

    // ---- physics ----
    x: posX, y: posY,
    vx: 0,   vy: 0,
    targetX: posX, targetY: posY,

    // ---- ball state ----
    hasBall:      false,
    controlTimer: 0,   // ticks until action when holding ball
    aiTimer:      0,   // ticks since last AI update (for non-ball holders)

    // ---- misc ----
    speedMult:      1.0,
    speedMultTimer: 0,

    // ---- combat ----
    knockdownTimer: 0,   // > 0 → player is down, cannot act
    punchTimer:     0,   // > 0 → playing punch animation
    punchArm:       1,   // 1 = right arm, -1 = left arm
    punchCooldown:  0,   // ticks before can punch again
  };
}

// ── MAIN UPDATE ──────────────────────────────────────────────────────────────
function updateAgent(agent, ms) {
  // Tick animation timers
  if (agent.punchTimer    > 0) agent.punchTimer--;
  if (agent.punchCooldown > 0) agent.punchCooldown--;

  // Knocked-down: can't act, slide to a stop
  if (agent.knockdownTimer > 0) {
    agent.knockdownTimer--;
    agent.vx *= 0.82;
    agent.vy *= 0.82;
    // Drop the ball if holding it
    if (agent.hasBall) {
      agent.hasBall     = false;
      ms.ball.owner     = null;
      ms.ball.lastOwner = agent;
      ms.ball.lastOwnerTimer = 20;
      ms.ball.vx = (_rng() - 0.5) * 4;
      ms.ball.vy = (_rng() - 0.5) * 4;
    }
    return;
  }

  // Tick down speed multiplier
  if (agent.speedMultTimer > 0) {
    agent.speedMultTimer--;
    if (agent.speedMultTimer === 0) agent.speedMult = 1.0;
  }

  if (agent.hasBall) {
    updateBallHolder(agent, ms);
  } else {
    agent.aiTimer++;
    if (agent.aiTimer >= 5) {
      agent.aiTimer = 0;
      updatePositioning(agent, ms);
    }
  }

  executeMovement(agent);

  // Punch check (only when not holding ball)
  if (!agent.hasBall) checkPunch(agent, ms);
}

// ── BALL HOLDER LOGIC ─────────────────────────────────────────────────────────
function updateBallHolder(agent, ms) {
  agent.controlTimer--;
  if (agent.controlTimer > 0) {
    // Holding: stand mostly still, ball attached
    agent.targetX = agent.x;
    agent.targetY = agent.y;
    return;
  }

  // Time to act — decide pass or shoot
  const action = decideAction(agent, ms);
  executeAction(agent, ms, action);
}

function decideAction(agent, ms) {
  const ball = ms.ball;
  const isTeamA = agent.teamIndex === 0;
  const goalX = isTeamA ? PITCH_W : 0;
  const goalCY = 220;

  const dx = goalX - agent.x;
  const dy = goalCY - agent.y;
  const distToGoal = Math.sqrt(dx * dx + dy * dy);

  // Opponents near me = pressure
  const opponents = ms.agents.filter(a => a.teamIndex !== agent.teamIndex);
  const pressure = opponents.filter(o => dist2(agent, o) < 65).length;

  // ── Shoot score (zone normale) ──────────────────────────────────────────
  let shootScore = -99;
  if (agent.role !== 'GOALKEEPER' && distToGoal < SHOOT_RANGE) {
    shootScore = (SHOOT_RANGE - distToGoal) / SHOOT_RANGE * 5;
    shootScore += agent.shotAccuracy * 0.55;
    shootScore -= pressure * 1.6;
    // Bonus for being in penalty area — encourage finishing
    const inBox = isTeamA
      ? (agent.x > 570 && agent.y > 150 && agent.y < 290)
      : (agent.x < 110 && agent.y > 150 && agent.y < 290);
    if (inBox) shootScore += 2.4;
  }

  // ── Long shot score (moitié adverse, hors zone normale) ─────────────────
  const inOpponentHalf = isTeamA ? agent.x > 340 : agent.x < 340;
  let longShotScore = -99;
  if (agent.role !== 'GOALKEEPER'
      && inOpponentHalf
      && distToGoal >= SHOOT_RANGE
      && distToGoal < LONG_SHOT_RANGE) {
    // Score de base : précision du tireur, pénalisé par la distance et la pression
    longShotScore  = agent.shotAccuracy * 0.40;
    longShotScore -= (distToGoal - SHOOT_RANGE) / (LONG_SHOT_RANGE - SHOOT_RANGE) * 2.5;
    longShotScore -= pressure * 2.2;
  }

  // ── Best pass ──
  const teammates = ms.agents.filter(a => a.teamIndex === agent.teamIndex && a !== agent);
  let bestPass = null;
  let bestPassScore = -99;

  teammates.forEach(t => {
    const d = dist2(agent, t);
    if (d > PASS_MAX_RANGE || d < 22) return;

    let score = 0;
    const isForward  = isTeamA ? t.x > agent.x + 20 : t.x < agent.x - 20;
    const isBackward = isTeamA ? t.x < agent.x - 40 : t.x > agent.x + 40;
    if (isForward)  score += 3.5;   // strongly favour forward passes
    if (isBackward) score -= 2.2;   // penalise going backward
    if (t.role === 'ATTACKER') score += 1.2;

    // Prefer medium-range passes (less to the feet, more into space)
    const idealDist = PASS_MAX_RANGE * 0.5;
    score += (1.0 - Math.abs(d - idealDist) / idealDist) * 1.2;

    // Teammate in open space = bonus (fewer opponents within 50px of target)
    const opsNearTarget = opponents.filter(o => dist2(o, t) < 55).length;
    score += Math.max(0, 1.2 - opsNearTarget * 0.8);

    // Penalty for opponents blocking the lane
    const opsInLane = opponents.filter(o => isInLane(agent, t, o, 26)).length;
    score -= opsInLane * 2.2;

    if (score > bestPassScore) {
      bestPassScore = score;
      bestPass = t;
    }
  });

  // Decision
  if (shootScore > 2.0) {
    // Lower threshold + higher probability → players shoot more readily
    if (_rng() < 0.62 + shootScore * 0.05) {
      return { type: 'SHOOT' };
    }
  }

  // Tir longue distance — rare, réservé aux joueurs techniques (shotAccuracy ≥ 5)
  if (longShotScore > 0.9 && agent.shotAccuracy >= 5 && _rng() < 0.12) {
    return { type: 'LONG_SHOT' };
  }

  if (bestPass && bestPassScore > 0.5) {
    return { type: 'PASS', target: bestPass };
  }

  // Fallback: shoot if possible, otherwise panic pass
  if (agent.role !== 'GOALKEEPER' && distToGoal < SHOOT_RANGE) {
    return { type: 'SHOOT' };
  }
  if (bestPass) {
    return { type: 'PASS', target: bestPass };
  }
  return { type: 'CLEAR' }; // kick it forward
}

function executeAction(agent, ms, action) {
  const isTeamA = agent.teamIndex === 0;

  if (action.type === 'SHOOT') {
    const goalX = isTeamA ? PITCH_W + 5 : -5;
    const aimY  = 220 + (_rng() * 2 - 1) * 30;
    const spd   = 13 + agent.shotAccuracy * 1.2;  // shots are now faster
    kickBall(ms.ball, agent, goalX, aimY, spd, agent.shotAccuracy);
    agent.hasBall = false;
    addEvent(ms, 'SHOT', agent);
  }
  else if (action.type === 'LONG_SHOT') {
    const goalX = isTeamA ? PITCH_W + 5 : -5;
    const aimY  = 220 + (_rng() * 2 - 1) * 42;
    const spd   = 15 + agent.shotAccuracy * 1.0;
    kickBall(ms.ball, agent, goalX, aimY, spd, agent.shotAccuracy * 0.75);
    agent.hasBall = false;
    addEvent(ms, 'LONG_SHOT', agent);
  }
  else if (action.type === 'PASS') {
    const t = action.target;
    const dist = dist2(agent, t);
    // Lead pass — aim for where the teammate WILL BE, not where they are now
    // Estimate travel time and predict target position
    const passSpd = Math.min(7 + dist * 0.026, 14);
    const travelTicks = Math.min(dist / passSpd, 14);
    const predX = t.x + t.vx * travelTicks * 0.75;
    const predY = t.y + t.vy * travelTicks * 0.75;
    ms.ball.lastPasser = agent;  // track passer for assist
    kickBall(ms.ball, agent, predX, predY, passSpd, agent.passAccuracy);
    agent.hasBall = false;
  }
  else { // CLEAR — intelligent: aim at the most forward open teammate
    const fwdTeammates = teammates.filter(t =>
      isTeamA ? t.x > agent.x : t.x < agent.x
    );
    if (fwdTeammates.length > 0) {
      // Pick the furthest-forward one
      const target = fwdTeammates.reduce((best, t) =>
        (isTeamA ? t.x > best.x : t.x < best.x) ? t : best
      );
      kickBall(ms.ball, agent, target.x + (isTeamA ? 35 : -35), target.y,
               11, agent.passAccuracy * 0.80);
    } else {
      const dirX = isTeamA ? PITCH_W : 0;
      const dirY = 220 + (_rng() * 2 - 1) * 70;
      kickBall(ms.ball, agent, dirX, dirY, 11, agent.passAccuracy * 0.70);
    }
    agent.hasBall = false;
  }
}

// ── NON-BALL HOLDER POSITIONING ──────────────────────────────────────────────
function updatePositioning(agent, ms) {
  switch (agent.role) {
    case 'GOALKEEPER': updateGK(agent, ms);  break;
    case 'DEFENDER':   updateDEF(agent, ms); break;
    case 'ATTACKER':   updateATT(agent, ms); break;
  }
}

// ── GK ──────────────────────────────────────────────────────────────────────
function updateGK(gk, ms) {
  const isTeamA = gk.teamIndex === 0;
  const goalX   = isTeamA ? 22 : PITCH_W - 22;
  const ball    = ms.ball;

  // Check if shot incoming
  if (!ball.owner) {
    const headingToGoal = isTeamA ? ball.vx < -2 : ball.vx > 2;
    if (headingToGoal) {
      const dx = goalX - ball.x;
      const t  = dx / ball.vx;
      if (t > 0 && t < 50) {
        const crossY = ball.y + ball.vy * t;
        if (crossY > GOAL_Y1 - 20 && crossY < GOAL_Y2 + 20) {
          // Dive to intercept
          gk.targetX = goalX;
          gk.targetY = Math.max(GOAL_Y1 - 5, Math.min(GOAL_Y2 + 5, crossY));
          setSpeedMult(gk, 2.4, 25);
          return;
        }
      }
    }

    // Rush for close loose ball
    const d = dist2(gk, ball);
    if (d < 85) {
      gk.targetX = ball.x;
      gk.targetY = ball.y;
      setSpeedMult(gk, 1.6, 15);
      return;
    }
  }

  // Default: hug goal line, track ball vertically
  gk.targetX = goalX;
  gk.targetY = clamp(ball.y, GOAL_Y1 + 5, GOAL_Y2 - 5);
  gk.speedMult = 1.0;
}

// ── DEFENDER ────────────────────────────────────────────────────────────────
function updateDEF(def, ms) {
  const isTeamA = def.teamIndex === 0;
  // Use formation X as anchor depth, fallback to default
  const anchorX = def.formationX || (isTeamA ? 165 : PITCH_W - 165);
  const ball    = ms.ball;

  const opponentWithBall = ball.owner && ball.owner.teamIndex !== def.teamIndex;
  const teamHasBall      = ball.owner && ball.owner.teamIndex === def.teamIndex;

  if (opponentWithBall) {
    const carrier = ball.owner;
    // Only press hard when carrier is in our defensive third — not at midfield
    const inDefensiveThird = isTeamA ? carrier.x < 255 : carrier.x > PITCH_W - 255;
    if (inDefensiveThird) {
      const projX = carrier.x + carrier.vx * 8;
      const projY = carrier.y + carrier.vy * 8;
      def.targetX = clamp(projX, 20, PITCH_W - 20);
      def.targetY = clamp(projY, 20, PITCH_H - 20);
      setSpeedMult(def, 1.28, 8);
      return;
    }
  }

  if (!ball.owner) {
    const ballInOwnHalf = isTeamA ? ball.x < 320 : ball.x > PITCH_W - 320;
    if (ballInOwnHalf && dist2(def, ball) < 160) {
      def.targetX = ball.x;
      def.targetY = ball.y;
      setSpeedMult(def, 1.18, 10);
      return;
    }
  }

  // Hold shape: cover between ball and goal
  // When team has ball in opponent half, DEF pushes up to support / cut counter
  const coverX   = anchorX + (ball.x - anchorX) * 0.30;
  const coverY   = 220 + (ball.y - 220) * 0.35;
  const ballFwd  = isTeamA ? ball.x > 360 : ball.x < PITCH_W - 360;
  const maxPushA = (teamHasBall && ballFwd) ? 460 : 390;
  const maxPushB = PITCH_W - maxPushA;

  def.targetX = clamp(
    isTeamA ? Math.min(coverX, maxPushA) : Math.max(coverX, maxPushB),
    30, PITCH_W - 30
  );
  def.targetY = clamp(coverY, 55, PITCH_H - 55);
}

// ── ATTACKER ─────────────────────────────────────────────────────────────────
function updateATT(att, ms, idx) {
  const isTeamA   = att.teamIndex === 0;
  const ball      = ms.ball;
  // Spread: determine index among team's attackers
  const teamAtts  = ms.agents.filter(a => a.teamIndex === att.teamIndex && a.role === 'ATTACKER');
  const myIdx     = teamAtts.indexOf(att);
  // Formation-aware spread: use Y offset from pitch center (220)
  // If no formation set, fallback to default ±88
  const spreadY   = att.formationY !== undefined
    ? (att.formationY - 220)
    : (myIdx === 0 ? -88 : 88);

  const teamHasBall = ball.owner && ball.owner.teamIndex === att.teamIndex;
  const oppHasBall  = ball.owner && ball.owner.teamIndex !== att.teamIndex;
  // Am I the attacker closer to the ball?
  const otherAtt  = teamAtts.find(a => a !== att);
  const iNearBall = !otherAtt || dist2(att, ball) <= dist2(otherAtt, ball);

  if (teamHasBall) {
    if (iNearBall) {
      // Near attacker: stay slightly back as a passing option, then burst
      const supportX = isTeamA
        ? clamp(ball.x + 80, 260, 540)
        : clamp(ball.x - 80, 140, 420);
      att.targetX = supportX;
      att.targetY = clamp(220 + spreadY * 0.55, 80, 360);
      setSpeedMult(att, 1.12, 6);
    } else {
      // Far attacker: make a deep run into the box
      const runX = isTeamA
        ? clamp(ball.x + 200, 390, 638)
        : clamp(ball.x - 200, 42, 290);
      att.targetX = runX;
      att.targetY = clamp(220 + spreadY, 65, 375);
      setSpeedMult(att, 1.28, 8);  // sprint into depth
    }
  }
  else if (oppHasBall) {
    // High press — don't crowd centre, cut wide passing lanes
    const pressX = isTeamA
      ? clamp(ball.x - 75, 110, 400)
      : clamp(ball.x + 75, 280, 570);
    att.targetX = pressX;
    att.targetY = clamp(220 + spreadY * 0.55, 80, 360);
    setSpeedMult(att, 1.1, 6);
  }
  else {
    // Loose ball
    if (iNearBall) {
      att.targetX = ball.x;
      att.targetY = ball.y;
      setSpeedMult(att, 1.32, 6);
    } else {
      const advX = isTeamA ? clamp(ball.x + 130, 330, 620) : clamp(ball.x - 130, 60, 350);
      att.targetX = advX;
      att.targetY = clamp(220 + spreadY, 65, 375);
    }
  }
}

// ── MOVEMENT EXECUTION ────────────────────────────────────────────────────────
function executeMovement(agent) {
  const dx   = agent.targetX - agent.x;
  const dy   = agent.targetY - agent.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1.5) {
    agent.vx *= 0.7;
    agent.vy *= 0.7;
    return;
  }

  const maxSpd = playerSpeed(agent) * agent.speedMult;
  const desiredVx = (dx / dist) * maxSpd;
  const desiredVy = (dy / dist) * maxSpd;

  // Smooth acceleration
  agent.vx += (desiredVx - agent.vx) * 0.25;
  agent.vy += (desiredVy - agent.vy) * 0.25;

  agent.x += agent.vx;
  agent.y += agent.vy;

  // Clamp to pitch
  agent.x = clamp(agent.x, 14, PITCH_W - 14);
  agent.y = clamp(agent.y, 14, PITCH_H - 14);
}

// ── BALL CAPTURE ─────────────────────────────────────────────────────────────
function checkBallCapture(ms) {
  const ball = ms.ball;
  if (ball.owner) return;

  let closest = null;
  let closestDist = CAPTURE_RADIUS;

  ms.agents.forEach(agent => {
    if (ball.lastOwner === agent && ball.lastOwnerTimer > 0) return;
    const d = dist2(agent, ball);
    if (d < closestDist) {
      closestDist = d;
      closest = agent;
    }
  });

  if (closest) {
    // ── GK save probability ──────────────────────────────────────────────────
    // When the GK would catch a shot heading into their goal, apply a
    // stats-based save chance. Misses let the ball continue to goal-line.
    if (closest.role === 'GOALKEEPER') {
      const gkTeamA = closest.displayTeamIndex === 0;
      const headingIn = gkTeamA ? ball.vx < -1.5 : ball.vx > 1.5;
      const inZone    = gkTeamA
        ? ball.x < 90
        : ball.x > PITCH_W - 90;

      if (headingIn && inZone) {
        const ballSpd = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
        // savePct: faster ball = harder save; higher GK speed = better reflexes
        const savePct = clamp(
          0.58 + (closest.speed - 5) * 0.055 - Math.max(0, ballSpd - 7) * 0.030,
          0.14, 0.84
        );
        if (_rng() > savePct) {
          // GK dives but can't hold it — ball continues toward goal
          return;
        }
        // ── GK save: count it for post-match stats ──────────────────────────
        if (ms.savesHome !== undefined) {
          if (closest.displayTeamIndex === 0) ms.savesHome++;
          else                                ms.savesAway++;
        }
      }
    }

    ball.owner = closest;
    closest.hasBall = true;
    // Reset assist chain if ball captured by opponent (interception)
    if (ms.ball.lastPasser && ms.ball.lastPasser.displayTeamIndex !== closest.displayTeamIndex) {
      ms.ball.lastPasser = null;
    }
    // Control time: longer with no pressure (time to build play), shorter when pressed
    const pressure = ms.agents.filter(a => a.teamIndex !== closest.teamIndex && dist2(a, closest) < 55).length;
    closest.controlTimer = Math.max(6, 20 - pressure * 5 + Math.floor(_rng() * 8));
  }
}

// ── PUNCH MECHANIC ────────────────────────────────────────────────────────────
function checkPunch(agent, ms) {
  if (agent.punchCooldown > 0) return;

  const enemies = ms.agents.filter(
    a => a.teamIndex !== agent.teamIndex && a.knockdownTimer === 0
  );

  for (const enemy of enemies) {
    if (dist2(agent, enemy) < 24) {
      // Rare random chance — ~0.7% per tick when in contact range
      if (_rng() < 0.007) {
        agent.punchCooldown = 150;   // 2.5 s cooldown
        agent.punchTimer    = 22;
        agent.punchArm      = _rng() > 0.5 ? 1 : -1;

        // Knockdown if attacker is stronger
        if (agent.power >= enemy.power) {
          enemy.knockdownTimer = 80;
        }

        // Log event for ticker
        ms.events.push({
          type:             'PUNCH',
          name:             agent.name,
          targetName:       enemy.name,
          teamIndex:        agent.teamIndex,
          displayTeamIndex: agent.displayTeamIndex,
          tick:             ms.tick,
          minute:           Math.floor(ms.simMinutes || 0),
          ko:               agent.power >= enemy.power,
        });
        break;
      }
    }
  }
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function isInLane(from, to, obstacle, width) {
  // Check if `obstacle` is within `width` px of segment from→to
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = dx / len, ny = dy / len;
  const ex = obstacle.x - from.x;
  const ey = obstacle.y - from.y;
  const proj  = ex * nx + ey * ny;
  if (proj < 0 || proj > len) return false;
  const perp = Math.abs(ex * (-ny) + ey * nx);
  return perp < width;
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function setSpeedMult(agent, mult, ticks) {
  agent.speedMult = mult;
  agent.speedMultTimer = ticks;
}

function addEvent(ms, type, agent) {
  ms.events.push({
    type,
    agentId:          agent.id,
    name:             agent.name,
    teamIndex:        agent.teamIndex,         // tactical (flips at halftime)
    displayTeamIndex: agent.displayTeamIndex,  // stable home/away — use for stats
    tick:             ms.tick,
    minute:           Math.floor(ms.simMinutes || 0),
  });
}
