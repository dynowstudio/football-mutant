/* ═══════════════════════════════════════════
   Salary — post-match deductions & replacements
   ═══════════════════════════════════════════ */

const Salary = (() => {

  // Process an entire matchday (all fixtures)
  // Returns an array of economyReports for each team
  function processMatchday(league) {
    const reports = [];

    league.teams.forEach(team => {
      const report = processTeam(team, league);
      reports.push({ teamId: team.id, ...report });
    });

    return reports;
  }

  // Process one team: award gold, deduct salaries, replace unaffordable players
  function processTeam(team, league) {
    const replacements = [];
    let totalSalary = 0;

    for (let i = 0; i < team.roster.length; i++) {
      const p = team.roster[i];
      if (p.isFreeTier || p.salary === 0) continue;

      totalSalary += p.salary;

      if (team.gold >= p.salary) {
        team.gold -= p.salary;
      } else {
        // Cannot afford → release and replace
        const released = p;
        released.teamId = null;
        league.freePlayerPool.push(released);

        const replacement = createFreeTierPlayer(released.role);
        team.roster[i] = replacement;

        replacements.push({
          released,
          replacement,
          deficit: p.salary - team.gold,
        });
        team.gold = 0; // drain to zero
      }
    }

    return { totalSalary, replacements };
  }

  // ── Injuries ──────────────────────────────────────────────────────────────
  // 1) Guérit les joueurs dont injuryGamesLeft arrive à 0
  // 2) Tire au sort de nouvelles blessures pour les joueurs aptes
  // Retourne la liste des nouvelles blessures (tous les équipes)
  function processInjuries(league) {
    const newInjuries = [];

    league.teams.forEach(team => {
      team.roster.forEach(p => {
        if (p.isFreeTier || p.salary === 0) return;

        // Récupération
        if (p.injured && p.injuryGamesLeft > 0) {
          p.injuryGamesLeft--;
          if (p.injuryGamesLeft === 0) p.injured = false;
          return; // ce joueur ne peut pas se re-blesser ce tour
        }

        // Probabilité de blessure : (11 - durabilité) * 0.8 %
        // La carte atout peut modifier la durabilité effective
        let effectiveDur = p.durability || 5;
        if (team.trumpCard && TRUMP_CARDS[team.trumpCard]) {
          const durMod = TRUMP_CARDS[team.trumpCard].mods.durability || 0;
          effectiveDur = Math.max(1, Math.min(10, effectiveDur + durMod));
        }
        const chance = (11 - effectiveDur) * 0.008;
        if (Math.random() < chance) {
          p.injured         = true;
          p.injuryGamesLeft = 1;
          newInjuries.push({ player: p, teamId: team.id, teamName: team.name });
        }
      });
    });

    return newInjuries;
  }

  return { processMatchday, processInjuries };

})();
