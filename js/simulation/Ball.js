/* ═══════════════════════════════════════════
   Ball — physics & state
   ═══════════════════════════════════════════ */

// ── Seeded RNG (shared with PlayerAgent & MatchEngine) ────────────────────────
// Set once per match via setSimRng(). Falls back to Math.random if never set.
let _rng = Math.random;
function setSimRng(fn) { _rng = fn; }

const PITCH_W  = 680;
const PITCH_H  = 440;
const GOAL_Y1  = 180;
const GOAL_Y2  = 260;
const GOAL_DEPTH = 22;  // pixels past goal line

function createBall(x, y) {
  return {
    x, y,
    vx: 0, vy: 0,
    owner:     null,   // Player reference or null
    lastOwner: null,   // who last kicked it
    lastOwnerTimer: 0, // ticks before lastOwner can recapture
    lastPasser: null,  // who made the last pass (for assist tracking)
    spinAngle: 0,
    trail: [],         // last N positions for rendering
    TRAIL_LEN: 7,
  };
}

function updateBall(ball) {
  // If owned, ball sits on the player (handled by MatchEngine)
  if (ball.owner) return;

  // Apply velocity
  ball.x += ball.vx;
  ball.y += ball.vy;

  // Friction — slightly reduced so passes travel further and play is more fluid
  ball.vx *= 0.979;
  ball.vy *= 0.979;

  // Clamp near-zero
  if (Math.abs(ball.vx) < 0.06) ball.vx = 0;
  if (Math.abs(ball.vy) < 0.06) ball.vy = 0;

  // Spin (visual only)
  const speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
  ball.spinAngle += speed * 0.12;

  // ── Side wall bounces (top/bottom, not goal sides) ──
  if (ball.y < 12) {
    ball.y = 12;
    ball.vy = Math.abs(ball.vy) * 0.55;
  }
  if (ball.y > PITCH_H - 12) {
    ball.y = PITCH_H - 12;
    ball.vy = -Math.abs(ball.vy) * 0.55;
  }

  // ── Left boundary (not goal opening) ──
  if (ball.x < 12) {
    const inGoal = ball.y >= GOAL_Y1 && ball.y <= GOAL_Y2;
    if (!inGoal) {
      ball.x = 12;
      ball.vx = Math.abs(ball.vx) * 0.55;
    }
  }

  // ── Right boundary (not goal opening) ──
  if (ball.x > PITCH_W - 12) {
    const inGoal = ball.y >= GOAL_Y1 && ball.y <= GOAL_Y2;
    if (!inGoal) {
      ball.x = PITCH_W - 12;
      ball.vx = -Math.abs(ball.vx) * 0.55;
    }
  }

  // ── Trail ──
  ball.trail.push({ x: ball.x, y: ball.y });
  if (ball.trail.length > ball.TRAIL_LEN) ball.trail.shift();

  // ── lastOwner timer ──
  if (ball.lastOwnerTimer > 0) ball.lastOwnerTimer--;
}

// ── Goal detection ─────────────────────────────────────────────────────────
// Returns 'LEFT' | 'RIGHT' | null
function detectGoal(ball) {
  if (ball.y < GOAL_Y1 || ball.y > GOAL_Y2) return null;
  if (ball.x <= -GOAL_DEPTH) return 'LEFT';  // right team scores
  if (ball.x >= PITCH_W + GOAL_DEPTH) return 'RIGHT'; // left team scores
  return null;
}

// ── Ball kick helpers ──────────────────────────────────────────────────────
function kickBall(ball, player, targetX, targetY, speedBase, accuracyStat) {
  const dx = targetX - player.x;
  const dy = targetY - player.y;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;
  let nx = dx / dist;
  let ny = dy / dist;

  // Angle error — tightened so passes actually reach their target
  const maxErr = (10 - accuracyStat) * 0.068; // rad (stat 5 → ±19°, stat 9 → ±3.9°)
  const err = (_rng() * 2 - 1) * maxErr;
  const cos = Math.cos(err);
  const sin = Math.sin(err);
  nx = nx * cos - ny * sin;
  ny = nx * sin + ny * cos; // note: uses original ny via closure, fine for small err

  // Recompute cleanly
  const angle = Math.atan2(dy, dx) + err;
  const spd = speedBase + _rng() * 1.5;

  ball.vx = Math.cos(angle) * spd;
  ball.vy = Math.sin(angle) * spd;
  ball.owner = null;
  ball.lastOwner = player;
  ball.lastOwnerTimer = 14; // shorter exclusion so play resumes faster
  ball.x = player.x;
  ball.y = player.y;
}

function dist2(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}
