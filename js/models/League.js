/* ═══════════════════════════════════════════
   League model + round-robin schedule
   ═══════════════════════════════════════════ */

function createLeague(teams) {
  return {
    teams,
    schedule:        generateSchedule(teams), // Fixture[11][6]
    currentMatchday: 0,   // 0-based, 0 = first matchday not played
    freePlayerPool:  [],  // players not on any team
    pastResults:     [],  // all played fixtures [{home,away,hs,as}]
    cup:             _newCupState(),
    stats:           {},  // per-player goals/assists accumulator
  };
}

function _newCupState() {
  return {
    done:        false,
    round:       null,        // 'QF' | 'SF' | 'FINAL'
    roundState:  'PRE',       // 'PRE' | 'POST'
    teams:       [],          // top-8 team objects
    QF:          [],          // 4 fixtures
    SF:          [],          // 2 fixtures (built after QF)
    FINAL:       null,        // 1 fixture  (built after SF)
    champion:    null,
    lastEarnings: null,       // { teamId, amount, reason }
  };
}

// ── Round-robin schedule (Berger algorithm) ──────────────────────────────────
// 12 teams → 11 matchdays × 6 fixtures each
function generateSchedule(teams) {
  const n = teams.length; // 12
  const rounds = [];
  const ids = teams.map(t => t.id);

  // Fix team[0], rotate the rest
  const fixed = ids[0];
  let rotating = ids.slice(1);

  for (let round = 0; round < n - 1; round++) {
    const fixtures = [];
    const circle = [fixed, ...rotating];
    for (let i = 0; i < n / 2; i++) {
      const home = circle[i];
      const away = circle[n - 1 - i];
      fixtures.push({ homeId: home, awayId: away, homeScore: null, awayScore: null });
    }
    rounds.push(fixtures);
    // Rotate: move last to front of rotating
    rotating = [rotating[rotating.length - 1], ...rotating.slice(0, -1)];
  }
  return rounds;
}

// Return all fixtures for the given matchday (0-based)
function getMatchdayFixtures(league, day) {
  return league.schedule[day] || [];
}

// Return the human team's fixture for the given matchday
function getHumanFixture(league, day) {
  const humanTeam = league.teams.find(t => t.isHuman);
  const fixtures = getMatchdayFixtures(league, day);
  return fixtures.find(f => f.homeId === humanTeam.id || f.awayId === humanTeam.id);
}

function getTeamById(league, id) {
  return league.teams.find(t => t.id === id);
}

// Apply a match result to team standings
function applyResult(league, fixture) {
  const home = getTeamById(league, fixture.homeId);
  const away = getTeamById(league, fixture.awayId);
  const hs = fixture.homeScore;
  const as = fixture.awayScore;

  home.goalsFor     += hs;  home.goalsAgainst += as;
  away.goalsFor     += as;  away.goalsAgainst += hs;
  home.matchesPlayed++;     away.matchesPlayed++;

  if (hs > as) {
    home.wins++;   home.points += 3; pushResult(home, 'W');
    away.losses++;                   pushResult(away, 'L');
  } else if (hs < as) {
    away.wins++;   away.points += 3; pushResult(away, 'W');
    home.losses++;                   pushResult(home, 'L');
  } else {
    home.draws++; home.points += 1;  pushResult(home, 'D');
    away.draws++; away.points += 1;  pushResult(away, 'D');
  }

  league.pastResults.push({ ...fixture });
}

function pushResult(team, result) {
  team.recentResults.push(result);
  if (team.recentResults.length > 5) team.recentResults.shift();
}

// Quick-simulate a match using Poisson distribution (for AI vs AI)
function quickSim(homeTeam, awayTeam) {
  const attH = teamAttackRating(homeTeam);
  const defH = teamDefenseRating(homeTeam);
  const attA = teamAttackRating(awayTeam);
  const defA = teamDefenseRating(awayTeam);

  const HOME_ADV = 0.15;
  const lambdaH = Math.max(0.2, 1.2 * (attH / (attH + defA)) * 2.8 + HOME_ADV);
  const lambdaA = Math.max(0.2, 1.2 * (attA / (attA + defH)) * 2.8);

  const homeScore = poissonSample(lambdaH);
  const awayScore = poissonSample(lambdaA);

  // ── Synthetic goal events for stats tracking ─────────────────────────────
  const goalEvents = [];

  const _pickScorer = (team) => {
    const cands = team.roster.filter(p => p.role === 'ATTACKER' && !p.injured);
    if (!cands.length) return team.roster[0] || null;
    const weights = cands.map(p => Math.max(1, p.shotAccuracy || 1));
    const total   = weights.reduce((s, w) => s + w, 0);
    let r = Math.random() * total;
    for (let i = 0; i < cands.length; i++) { r -= weights[i]; if (r <= 0) return cands[i]; }
    return cands[0];
  };

  const _pickAssister = (team, scorerId) => {
    if (Math.random() > 0.62) return null;
    const cands = team.roster.filter(p => p.id !== scorerId && !p.injured);
    return cands.length ? cands[Math.floor(Math.random() * cands.length)] : null;
  };

  const _addGoal = (team, score) => {
    for (let i = 0; i < score; i++) {
      const sc = _pickScorer(team); if (!sc) continue;
      const as = _pickAssister(team, sc.id);
      goalEvents.push({
        scorer:   { id: sc.id, name: sc.name, teamName: team.name },
        assister: as ? { id: as.id, name: as.name, teamName: team.name } : null,
      });
    }
  };

  _addGoal(homeTeam, homeScore);
  _addGoal(awayTeam, awayScore);

  return { homeScore, awayScore, goalEvents };
}

function poissonSample(lambda) {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}

// Sorted standings
function getSortedStandings(league) {
  return [...league.teams].sort(compareTeams);
}

// Accumulate per-player stats after a match
function accumulateMatchStats(league, goalEvents) {
  if (!league.stats) league.stats = {};
  (goalEvents || []).forEach(({ scorer, assister }) => {
    if (scorer && scorer.id) {
      if (!league.stats[scorer.id]) {
        league.stats[scorer.id] = { name: scorer.name, teamName: scorer.teamName || '', goals: 0, assists: 0 };
      }
      league.stats[scorer.id].goals++;
      league.stats[scorer.id].name     = scorer.name;
      league.stats[scorer.id].teamName = scorer.teamName || league.stats[scorer.id].teamName;
    }
    if (assister && assister.id) {
      if (!league.stats[assister.id]) {
        league.stats[assister.id] = { name: assister.name, teamName: assister.teamName || '', goals: 0, assists: 0 };
      }
      league.stats[assister.id].assists++;
      league.stats[assister.id].name     = assister.name;
      league.stats[assister.id].teamName = assister.teamName || league.stats[assister.id].teamName;
    }
  });
}
