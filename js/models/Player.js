/* ═══════════════════════════════════════════
   Player model
   ═══════════════════════════════════════════ */

let _playerIdCounter = 1000;

function createPlayer(data) {
  return {
    id:              data.id || ('gen_' + (_playerIdCounter++)),
    name:            data.name,
    role:            data.role,          // 'ATTACKER' | 'DEFENDER' | 'GOALKEEPER'
    speed:           data.speed,
    passAccuracy:    data.passAccuracy,
    shotAccuracy:    data.shotAccuracy,
    power:           data.power,
    durability:      data.durability !== undefined ? data.durability : 5,
    salary:          data.salary,
    isFreeTier:      data.isFreeTier || false,
    teamId:          data.teamId || null,
    injured:         false,
    injuryGamesLeft: 0,
  };
}

// Create a free-tier replacement player (weak, 0 salary)
const FREE_TIER_NAMES = {
  ATTACKER:   ['Joueur Libre A', 'Remplaçant Att', 'Libre Avant', 'Attaquant Libre', 'Avant Gratuit'],
  DEFENDER:   ['Joueur Libre D', 'Remplaçant Déf', 'Libre Défense', 'Défenseur Libre', 'Défense Gratuite'],
  GOALKEEPER: ['Joueur Libre G', 'Remplaçant GK',  'Libre But',    'Gardien Libre',   'But Gratuit'],
};

function createFreeTierPlayer(role) {
  const names = FREE_TIER_NAMES[role];
  const name = names[Math.floor(Math.random() * names.length)];
  return createPlayer({
    name,
    role,
    speed:        1 + Math.random() * 1.5,
    passAccuracy: 1 + Math.random() * 1.5,
    shotAccuracy: 1 + Math.random() * 1.5,
    power:        1 + Math.random() * 1.5,
    salary:       0,
    isFreeTier:   true,
  });
}

function playerAvgStat(p) {
  return (p.speed + p.passAccuracy + p.shotAccuracy + p.power) / 4;
}

function playerTransferFee(p) {
  if (p.isFreeTier) return 0;
  return Math.round(p.salary * 3 + playerAvgStat(p) * 20);
}

// Stat label (for display)
function statLabel(val) {
  val = Math.round(val);
  if (val >= 9) return 'great';
  if (val >= 7) return 'good';
  return '';
}
