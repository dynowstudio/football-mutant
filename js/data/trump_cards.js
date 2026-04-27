/* ═══════════════════════════════════════════
   TRUMP_CARDS — définitions des cartes atout
   ═══════════════════════════════════════════ */

const TRUMP_CARDS = {
  SPEED: {
    id:    'SPEED',
    name:  'Carte Vitesse',
    icon:  '⚡',
    color: '#f59e0b',
    bonus: '+1 Vitesse',
    malus: '−1 Tir',
    mods:  { speed: +1, shotAccuracy: -1 },
  },
  SHOT: {
    id:    'SHOT',
    name:  'Carte Tir',
    icon:  '🎯',
    color: '#ef4444',
    bonus: '+1 Tir',
    malus: '−1 Résistance',
    mods:  { shotAccuracy: +1, durability: -1 },
  },
  POWER: {
    id:    'POWER',
    name:  'Carte Force',
    icon:  '💪',
    color: '#8b5cf6',
    bonus: '+1 Force',
    malus: '−1 Passe',
    mods:  { power: +1, passAccuracy: -1 },
  },
  RESILIENCE: {
    id:    'RESILIENCE',
    name:  'Carte Résistance',
    icon:  '🛡️',
    color: '#10b981',
    bonus: '+1 Résistance',
    malus: '−1 Vitesse',
    mods:  { durability: +1, speed: -1 },
  },
  PASS: {
    id:    'PASS',
    name:  'Carte Passes',
    icon:  '🎽',
    color: '#3b82f6',
    bonus: '+1 Passe',
    malus: '−1 Force',
    mods:  { passAccuracy: +1, power: -1 },
  },
};
