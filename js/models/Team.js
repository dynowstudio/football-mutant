/* ═══════════════════════════════════════════
   Team model
   ═══════════════════════════════════════════ */

const TEAM_DEFS = [
  // index 0 = human team
  { name:'FC Genève',         color:'#9f1239', secondaryColor:'#ffffff', isHuman: true  },
  // 11 cantons suisses
  { name:'FC Zurich',         color:'#0369a1', secondaryColor:'#ffffff', isHuman: false },
  { name:'FC Berne',          color:'#dc2626', secondaryColor:'#111827', isHuman: false },
  { name:'FC Lausanne',       color:'#16a34a', secondaryColor:'#ffffff', isHuman: false },
  { name:'FC Aarau',          color:'#e8c517', secondaryColor:'#1a1a1a', isHuman: false },
  { name:'FC Sion',           color:'#b91c1c', secondaryColor:'#f8fafc', isHuman: false },
  { name:'FC Lucerne',        color:'#2563eb', secondaryColor:'#f8fafc', isHuman: false },
  { name:'FC Bâle',           color:'#991b1b', secondaryColor:'#1e40af', isHuman: false },
  { name:'FC Saint-Gall',     color:'#15803d', secondaryColor:'#ffffff', isHuman: false },
  { name:'FC Lugano',         color:'#1e3a5f', secondaryColor:'#f59e0b', isHuman: false },
  { name:'FC Neuchâtel',      color:'#dc2626', secondaryColor:'#111827', isHuman: false },
  { name:'FC Fribourg',       color:'#1c1c1c', secondaryColor:'#f8fafc', isHuman: false },
];

let _teamIdCounter = 0;

function createTeam(def, roster) {
  return {
    id:             'team_' + (_teamIdCounter++),
    name:           def.name,
    color:          def.color,
    secondaryColor: def.secondaryColor,
    isHuman:        def.isHuman || false,
    gold:           def.isHuman ? 500 : 400 + Math.floor(Math.random() * 300),
    roster:         roster, // array of 4 Player objects [att, att, def, gk]
    wins:   0,
    draws:  0,
    losses: 0,
    goalsFor:     0,
    goalsAgainst: 0,
    points: 0,
    matchesPlayed: 0,
    recentResults: [], // 'W'|'D'|'L' last 5
    trumpCard: null,   // keyof TRUMP_CARDS or null
  };
}

function teamPoints(team) {
  return team.wins * 3 + team.draws;
}

function teamGoalDiff(team) {
  return team.goalsFor - team.goalsAgainst;
}

function teamAttackRating(team) {
  const atts = team.roster.filter(p => p.role === 'ATTACKER');
  if (!atts.length) return 1;
  // Injured players comptent comme free-tier (rating ~1.5)
  const avg = atts.reduce((s, p) => p.injured
    ? s + 1.5
    : s + p.shotAccuracy * 0.5 + p.shotPower * 0.3 + p.speed * 0.2, 0) / atts.length;
  return avg;
}

function teamDefenseRating(team) {
  const def = team.roster.find(p => p.role === 'DEFENDER');
  const gk  = team.roster.find(p => p.role === 'GOALKEEPER');
  let rating = 0;
  if (def) rating += def.injured ? 1.5 : def.speed * 0.4 + def.passAccuracy * 0.2;
  if (gk)  rating += gk.injured  ? 1.5 : gk.speed  * 0.4;
  return rating || 1;
}

// Sort comparator for league table
function compareTeams(a, b) {
  if (b.points !== a.points) return b.points - a.points;
  const dbA = teamGoalDiff(a), dbB = teamGoalDiff(b);
  if (dbB !== dbA) return dbB - dbA;
  if (b.goalsFor !== a.goalsFor) return b.goalsFor - a.goalsFor;
  return a.name.localeCompare(b.name);
}
