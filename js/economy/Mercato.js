/* ═══════════════════════════════════════════
   Mercato — transfer market logic
   ═══════════════════════════════════════════ */

const Mercato = (() => {

  // Generate a pool of 20 random players from freePlayerPool
  function generatePool(league) {
    const pool = [...league.freePlayerPool];
    shuffleArray(pool);
    return pool.slice(0, Math.min(20, pool.length));
  }

  // Buy: replace a roster player with a pool player
  // Returns { ok: true } or { ok: false, reason: string }
  function buyPlayer(humanTeam, playerToBuy, rosterIdx, league) {
    const toReplace = humanTeam.roster[rosterIdx];
    if (!toReplace) return { ok: false, reason: 'Position invalide.' };

    if (toReplace.role !== playerToBuy.role) {
      return { ok: false, reason: `Rôle incompatible: besoin d'un ${roleLabel(toReplace.role)}.` };
    }

    const fee = playerTransferFee(playerToBuy);
    if (humanTeam.gold < fee) {
      return { ok: false, reason: `Pas assez d'or (besoin de ${fee}, vous avez ${humanTeam.gold}).` };
    }

    // Execute
    humanTeam.gold -= fee;

    // Released player → free pool
    toReplace.teamId = null;
    league.freePlayerPool.push(toReplace);

    // New player joins team
    playerToBuy.teamId = humanTeam.id;
    const poolIdx = league.freePlayerPool.indexOf(playerToBuy);
    if (poolIdx !== -1) league.freePlayerPool.splice(poolIdx, 1);

    humanTeam.roster[rosterIdx] = playerToBuy;

    return { ok: true, fee, released: toReplace, acquired: playerToBuy };
  }

  // AI mercato: each AI team tries to upgrade their weakest player
  function runAIMercato(league) {
    league.teams.forEach(team => {
      if (team.isHuman) return;
      aiUpgrade(team, league);
    });
  }

  function aiUpgrade(team, league) {
    if (league.freePlayerPool.length === 0) return;

    // Find weakest player
    const weakest = [...team.roster].sort((a, b) => playerAvgStat(a) - playerAvgStat(b))[0];
    if (!weakest) return;

    // Find best affordable upgrade of same role
    const candidates = league.freePlayerPool
      .filter(p => p.role === weakest.role && playerAvgStat(p) > playerAvgStat(weakest))
      .filter(p => playerTransferFee(p) <= team.gold * 0.45)
      .sort((a, b) => playerAvgStat(b) - playerAvgStat(a));

    if (candidates.length === 0) return;

    const pick = candidates[0];
    const fee  = playerTransferFee(pick);
    team.gold -= fee;

    const rosterIdx = team.roster.indexOf(weakest);
    weakest.teamId = null;
    league.freePlayerPool.push(weakest);

    pick.teamId = team.id;
    const poolIdx = league.freePlayerPool.indexOf(pick);
    if (poolIdx !== -1) league.freePlayerPool.splice(poolIdx, 1);

    team.roster[rosterIdx] = pick;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  function roleLabel(role) {
    return { ATTACKER: 'Attaquant', DEFENDER: 'Défenseur', GOALKEEPER: 'Gardien' }[role] || role;
  }

  return { generatePool, buyPlayer, runAIMercato };

})();
