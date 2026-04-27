/* ═══════════════════════════════════════════
   PLAYERS_DB — 100 joueurs uniques
   40 Attaquants · 30 Défenseurs · 30 Gardiens
   ═══════════════════════════════════════════ */

const PLAYERS_DB = [

  // ─────────────────────────────────────────
  //  ATTAQUANTS (40)
  // ─────────────────────────────────────────

  // Élite (salary 150-200)
  { id:'p001', name:'Dylan Ravasio',        role:'ATTACKER', speed:9, passAccuracy:6, shotAccuracy:8, power:5, salary:180 },
  { id:'p002', name:'Johan Ravasio',        role:'ATTACKER', speed:6, passAccuracy:7, shotAccuracy:9, power:7, salary:195 },
  { id:'p003', name:'Yoric Gagnebin',       role:'ATTACKER', speed:8, passAccuracy:5, shotAccuracy:8, power:9, salary:175 },
  { id:'p004', name:'Marco Cibelli',        role:'ATTACKER', speed:7, passAccuracy:9, shotAccuracy:7, power:4, salary:170 },
  { id:'p005', name:'Chris Villa',          role:'ATTACKER', speed:7, passAccuracy:7, shotAccuracy:8, power:7, salary:185 },
  { id:'p006', name:'Sylvain Guex-Crosier', role:'ATTACKER', speed:8, passAccuracy:6, shotAccuracy:8, power:6, salary:168 },

  // Bons (salary 80-140)
  { id:'p007', name:'David Hornung',        role:'ATTACKER', speed:7, passAccuracy:6, shotAccuracy:7, power:6, salary:120 },
  { id:'p008', name:'Raphaël Hornung',      role:'ATTACKER', speed:8, passAccuracy:5, shotAccuracy:6, power:6, salary:110 },
  { id:'p009', name:'Robin Pittet',         role:'ATTACKER', speed:6, passAccuracy:7, shotAccuracy:7, power:5, salary:100 },
  { id:'p010', name:'Cyril Petignat',       role:'ATTACKER', speed:6, passAccuracy:8, shotAccuracy:6, power:4, salary:105 },
  { id:'p011', name:'Jonathan Ullmann',     role:'ATTACKER', speed:7, passAccuracy:6, shotAccuracy:7, power:6, salary:100 },
  { id:'p012', name:'Matteo Garcia',        role:'ATTACKER', speed:6, passAccuracy:6, shotAccuracy:7, power:6, salary:110 },
  { id:'p013', name:'Sébastien Emery',      role:'ATTACKER', speed:6, passAccuracy:7, shotAccuracy:6, power:5, salary:105 },
  { id:'p014', name:'Marc Guillermin',      role:'ATTACKER', speed:7, passAccuracy:5, shotAccuracy:7, power:8, salary:115 },
  { id:'p015', name:'Deyan Birchmeier',     role:'ATTACKER', speed:7, passAccuracy:7, shotAccuracy:7, power:5, salary:112 },
  { id:'p016', name:'Romain Degraz',        role:'ATTACKER', speed:8, passAccuracy:5, shotAccuracy:6, power:5, salary:105 },

  // Moyens (salary 30-70)
  { id:'p017', name:'Leeroy Cathrein',      role:'ATTACKER', speed:5, passAccuracy:5, shotAccuracy:6, power:4, salary:55 },
  { id:'p018', name:'Anne-Marie Nell',      role:'ATTACKER', speed:6, passAccuracy:5, shotAccuracy:5, power:5, salary:50 },
  { id:'p019', name:'Danaé Meynet',         role:'ATTACKER', speed:5, passAccuracy:6, shotAccuracy:5, power:4, salary:45 },
  { id:'p020', name:'Ella Loup',            role:'ATTACKER', speed:5, passAccuracy:5, shotAccuracy:5, power:4, salary:50 },
  { id:'p021', name:'Mariele Van Der Tas',  role:'ATTACKER', speed:6, passAccuracy:4, shotAccuracy:5, power:5, salary:45 },
  { id:'p022', name:'Maëlle Lecoultre',     role:'ATTACKER', speed:5, passAccuracy:5, shotAccuracy:6, power:4, salary:50 },
  { id:'p023', name:'Naomi Lecoultre',      role:'ATTACKER', speed:5, passAccuracy:5, shotAccuracy:5, power:4, salary:40 },
  { id:'p024', name:'Mathilde Revillard',   role:'ATTACKER', speed:6, passAccuracy:5, shotAccuracy:5, power:4, salary:45 },
  { id:'p025', name:'Audrey Burla',         role:'ATTACKER', speed:5, passAccuracy:5, shotAccuracy:5, power:5, salary:45 },
  { id:'p026', name:'Esther Burla',         role:'ATTACKER', speed:5, passAccuracy:6, shotAccuracy:5, power:4, salary:45 },
  { id:'p027', name:'Lola Deboneville',     role:'ATTACKER', speed:5, passAccuracy:5, shotAccuracy:5, power:3, salary:40 },
  { id:'p028', name:'Lysa Gillet',          role:'ATTACKER', speed:6, passAccuracy:4, shotAccuracy:5, power:5, salary:40 },

  // Faibles (salary 10-25)
  { id:'p029', name:'Federico Seragnoli',   role:'ATTACKER', speed:4, passAccuracy:4, shotAccuracy:4, power:3, salary:20 },
  { id:'p030', name:'Alekos Nicolaides',    role:'ATTACKER', speed:4, passAccuracy:3, shotAccuracy:4, power:3, salary:15 },
  { id:'p031', name:'Patricia Gagnebin',    role:'ATTACKER', speed:3, passAccuracy:4, shotAccuracy:4, power:2, salary:15 },
  { id:'p032', name:'Leïla Ravasio',        role:'ATTACKER', speed:4, passAccuracy:4, shotAccuracy:3, power:3, salary:15 },
  { id:'p033', name:'Romane Petignat',      role:'ATTACKER', speed:3, passAccuracy:3, shotAccuracy:4, power:3, salary:15 },
  { id:'p034', name:'Aurélie Guex-Crosier', role:'ATTACKER', speed:4, passAccuracy:3, shotAccuracy:3, power:3, salary:10 },
  { id:'p035', name:'Maeva Ullmann',        role:'ATTACKER', speed:3, passAccuracy:4, shotAccuracy:3, power:2, salary:10 },
  { id:'p036', name:'Meghan Meynet',        role:'ATTACKER', speed:3, passAccuracy:3, shotAccuracy:3, power:3, salary:10 },
  { id:'p037', name:'Ugo Mazier',           role:'ATTACKER', speed:3, passAccuracy:3, shotAccuracy:3, power:2, salary:10 },
  { id:'p038', name:'Alexis Guillod',       role:'ATTACKER', speed:4, passAccuracy:3, shotAccuracy:3, power:3, salary:10 },
  { id:'p039', name:'Kevin Rossier',        role:'ATTACKER', speed:3, passAccuracy:3, shotAccuracy:4, power:2, salary:10 },
  { id:'p040', name:'Kevin Excoffier',      role:'ATTACKER', speed:3, passAccuracy:3, shotAccuracy:3, power:2, salary:10 },

  // ─────────────────────────────────────────
  //  DÉFENSEURS (30)
  // ─────────────────────────────────────────

  // Élite (salary 100-140)
  { id:'p041', name:'Robin Stoeckli',       role:'DEFENDER', speed:7, passAccuracy:7, shotAccuracy:3, power:7, salary:130 },
  { id:'p042', name:'Pierre Loria',         role:'DEFENDER', speed:8, passAccuracy:7, shotAccuracy:3, power:7, salary:125 },
  { id:'p043', name:'Raphaël Loria',        role:'DEFENDER', speed:6, passAccuracy:8, shotAccuracy:3, power:8, salary:120 },
  { id:'p044', name:'Robin Mikes',          role:'DEFENDER', speed:7, passAccuracy:7, shotAccuracy:3, power:7, salary:120 },
  { id:'p045', name:'Virginie Perlotti',    role:'DEFENDER', speed:6, passAccuracy:8, shotAccuracy:3, power:9, salary:115 },

  // Bons (salary 60-100)
  { id:'p046', name:'Sylvain Pfund',        role:'DEFENDER', speed:6, passAccuracy:6, shotAccuracy:3, power:6, salary:80 },
  { id:'p047', name:'Adrian Ortiz',         role:'DEFENDER', speed:7, passAccuracy:5, shotAccuracy:3, power:6, salary:85 },
  { id:'p048', name:'Omega Pittet',         role:'DEFENDER', speed:6, passAccuracy:7, shotAccuracy:3, power:7, salary:80 },
  { id:'p049', name:'Aella Guex-Crosier',   role:'DEFENDER', speed:6, passAccuracy:6, shotAccuracy:3, power:8, salary:85 },
  { id:'p050', name:'Abyss Ravasio',        role:'DEFENDER', speed:7, passAccuracy:6, shotAccuracy:3, power:7, salary:80 },
  { id:'p051', name:'Mona Petignat',        role:'DEFENDER', speed:6, passAccuracy:7, shotAccuracy:3, power:6, salary:75 },
  { id:'p052', name:'Théo Marchand',        role:'DEFENDER', speed:6, passAccuracy:6, shotAccuracy:3, power:6, salary:75 },
  { id:'p053', name:'Baptiste Renard',      role:'DEFENDER', speed:6, passAccuracy:6, shotAccuracy:3, power:6, salary:75 },

  // Moyens (salary 20-55)
  { id:'p054', name:'Léa Fontaine',         role:'DEFENDER', speed:5, passAccuracy:5, shotAccuracy:3, power:5, salary:40 },
  { id:'p055', name:'Chloé Durand',         role:'DEFENDER', speed:5, passAccuracy:5, shotAccuracy:3, power:5, salary:35 },
  { id:'p056', name:'Emma Rousseau',        role:'DEFENDER', speed:5, passAccuracy:5, shotAccuracy:3, power:6, salary:40 },
  { id:'p057', name:'Hugo Lefebvre',        role:'DEFENDER', speed:5, passAccuracy:5, shotAccuracy:3, power:5, salary:35 },
  { id:'p058', name:'Maxime Chevalier',     role:'DEFENDER', speed:5, passAccuracy:5, shotAccuracy:2, power:6, salary:35 },
  { id:'p059', name:'Louis Garnier',        role:'DEFENDER', speed:5, passAccuracy:5, shotAccuracy:2, power:5, salary:30 },
  { id:'p060', name:'Clara Morin',          role:'DEFENDER', speed:5, passAccuracy:5, shotAccuracy:2, power:5, salary:30 },
  { id:'p061', name:'Alice Bernard',        role:'DEFENDER', speed:5, passAccuracy:5, shotAccuracy:2, power:5, salary:30 },
  { id:'p062', name:'Clément Faure',        role:'DEFENDER', speed:5, passAccuracy:4, shotAccuracy:2, power:5, salary:25 },
  { id:'p063', name:'Ethan Roche',          role:'DEFENDER', speed:5, passAccuracy:5, shotAccuracy:2, power:5, salary:30 },

  // Faibles (salary 10-20)
  { id:'p064', name:'Inès Perrin',          role:'DEFENDER', speed:4, passAccuracy:4, shotAccuracy:2, power:5, salary:15 },
  { id:'p065', name:'Jade Legrand',         role:'DEFENDER', speed:3, passAccuracy:4, shotAccuracy:2, power:4, salary:10 },
  { id:'p066', name:'Noa Bourgeois',        role:'DEFENDER', speed:4, passAccuracy:3, shotAccuracy:2, power:5, salary:10 },
  { id:'p067', name:'Oscar Dupuis',         role:'DEFENDER', speed:3, passAccuracy:3, shotAccuracy:2, power:4, salary:10 },
  { id:'p068', name:'Paul Giraud',          role:'DEFENDER', speed:4, passAccuracy:3, shotAccuracy:2, power:5, salary:10 },
  { id:'p069', name:'Quentin Blanchard',    role:'DEFENDER', speed:3, passAccuracy:4, shotAccuracy:2, power:4, salary:10 },
  { id:'p070', name:'Raphaëlle Simon',      role:'DEFENDER', speed:3, passAccuracy:3, shotAccuracy:2, power:4, salary:10 },

  // ─────────────────────────────────────────
  //  GARDIENS (30)
  // ─────────────────────────────────────────

  // Élite (salary 120-160)
  { id:'p071', name:'Sarah Michaud',        role:'GOALKEEPER', speed:8, passAccuracy:7, shotAccuracy:2, power:6, salary:150 },
  { id:'p072', name:'Thibault Colin',       role:'GOALKEEPER', speed:7, passAccuracy:6, shotAccuracy:2, power:5, salary:140 },
  { id:'p073', name:'Victor Henry',         role:'GOALKEEPER', speed:6, passAccuracy:8, shotAccuracy:2, power:5, salary:130 },
  { id:'p074', name:'William Lacroix',      role:'GOALKEEPER', speed:7, passAccuracy:6, shotAccuracy:2, power:6, salary:135 },
  { id:'p075', name:'Xavier Masson',        role:'GOALKEEPER', speed:8, passAccuracy:6, shotAccuracy:2, power:5, salary:145 },

  // Bons (salary 70-110)
  { id:'p076', name:'Yanis Gautier',        role:'GOALKEEPER', speed:6, passAccuracy:6, shotAccuracy:2, power:5, salary:90 },
  { id:'p077', name:'Zoé Perrot',           role:'GOALKEEPER', speed:6, passAccuracy:5, shotAccuracy:2, power:4, salary:85 },
  { id:'p078', name:'Adrien Tessier',       role:'GOALKEEPER', speed:6, passAccuracy:6, shotAccuracy:2, power:5, salary:85 },
  { id:'p079', name:'Bastien Meunier',      role:'GOALKEEPER', speed:6, passAccuracy:6, shotAccuracy:2, power:5, salary:85 },
  { id:'p080', name:'Camille Aubert',       role:'GOALKEEPER', speed:6, passAccuracy:5, shotAccuracy:2, power:4, salary:80 },
  { id:'p081', name:'Damien Chevallier',    role:'GOALKEEPER', speed:7, passAccuracy:5, shotAccuracy:2, power:5, salary:90 },
  { id:'p082', name:'Elise Bouchard',       role:'GOALKEEPER', speed:6, passAccuracy:6, shotAccuracy:2, power:4, salary:85 },
  { id:'p083', name:'Florian Charpentier',  role:'GOALKEEPER', speed:6, passAccuracy:5, shotAccuracy:2, power:4, salary:80 },

  // Moyens (salary 20-60)
  { id:'p084', name:'Gaëtan Normand',       role:'GOALKEEPER', speed:5, passAccuracy:5, shotAccuracy:2, power:4, salary:45 },
  { id:'p085', name:'Hélène Remy',          role:'GOALKEEPER', speed:5, passAccuracy:4, shotAccuracy:2, power:3, salary:40 },
  { id:'p086', name:'Isabelle Colin',       role:'GOALKEEPER', speed:5, passAccuracy:5, shotAccuracy:2, power:4, salary:40 },
  { id:'p087', name:'Julien Vidal',         role:'GOALKEEPER', speed:5, passAccuracy:4, shotAccuracy:2, power:3, salary:35 },
  { id:'p088', name:'Kevin Lambert',        role:'GOALKEEPER', speed:5, passAccuracy:4, shotAccuracy:2, power:3, salary:35 },
  { id:'p089', name:'Laura Roussel',        role:'GOALKEEPER', speed:5, passAccuracy:4, shotAccuracy:2, power:3, salary:30 },
  { id:'p090', name:'Manon Dupont',         role:'GOALKEEPER', speed:4, passAccuracy:5, shotAccuracy:2, power:3, salary:30 },
  { id:'p091', name:'Nicolas Lemaire',      role:'GOALKEEPER', speed:4, passAccuracy:4, shotAccuracy:2, power:2, salary:25 },
  { id:'p092', name:'Océane Pichon',        role:'GOALKEEPER', speed:5, passAccuracy:4, shotAccuracy:2, power:3, salary:25 },
  { id:'p093', name:'Priya Beaumont',       role:'GOALKEEPER', speed:4, passAccuracy:4, shotAccuracy:2, power:2, salary:25 },

  // Faibles (salary 10-15)
  { id:'p094', name:'Quentin Duval',        role:'GOALKEEPER', speed:4, passAccuracy:4, shotAccuracy:2, power:2, salary:15 },
  { id:'p095', name:'Renaud Arnaud',        role:'GOALKEEPER', speed:3, passAccuracy:3, shotAccuracy:2, power:2, salary:10 },
  { id:'p096', name:'Sophie Moreau',        role:'GOALKEEPER', speed:3, passAccuracy:4, shotAccuracy:2, power:2, salary:10 },
  { id:'p097', name:'Théa Guillot',         role:'GOALKEEPER', speed:4, passAccuracy:3, shotAccuracy:2, power:3, salary:10 },
  { id:'p098', name:'Ulysse Martin',        role:'GOALKEEPER', speed:3, passAccuracy:3, shotAccuracy:2, power:2, salary:10 },
  { id:'p099', name:'Violette Perez',       role:'GOALKEEPER', speed:4, passAccuracy:3, shotAccuracy:2, power:3, salary:10 },
  { id:'p100', name:'Zacharie Bonnet',      role:'GOALKEEPER', speed:3, passAccuracy:3, shotAccuracy:2, power:2, salary:10 },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function getPlayersByRole(role) {
  return PLAYERS_DB.filter(p => p.role === role);
}

function avgStat(p) {
  return (p.speed + p.passAccuracy + p.shotAccuracy + p.power) / 4;
}

function calcTransferFee(p) {
  return Math.round(p.salary * 3 + avgStat(p) * 20);
}

// Deep clone a player definition (to avoid mutating DB)
function clonePlayer(p) {
  return { ...p };
}
