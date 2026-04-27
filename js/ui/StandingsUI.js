/* ═══════════════════════════════════════════
   StandingsUI — league table & team card
   ═══════════════════════════════════════════ */

const StandingsUI = (() => {

  function render(league) {
    renderTable(league);
    renderTeamCard(league);
    renderRecentResults(league);
    TrumpCardUI.render(league);
    renderLeaderboards(league);
    renderSchedule(league);
  }

  function renderTable(league) {
    const sorted = getSortedStandings(league);
    const human  = league.teams.find(t => t.isHuman);
    const tbody  = document.getElementById('standings-body');
    tbody.innerHTML = '';

    sorted.forEach((team, idx) => {
      const rank = idx + 1;
      const isH  = team === human;
      const db   = teamGoalDiff(team);

      const tr = document.createElement('tr');
      if (isH) tr.className = 'human-row';

      tr.innerHTML = `
        <td><span class="rank-badge ${rank <= 3 ? 'rank-' + rank : ''}">${rank}</span></td>
        <td class="col-team">
          <span class="team-dot" style="background:${team.color}"></span>${team.name}${isH ? ' ★' : ''}
        </td>
        <td>${team.matchesPlayed}</td>
        <td>${team.wins}</td>
        <td>${team.draws}</td>
        <td>${team.losses}</td>
        <td>${team.goalsFor}</td>
        <td>${team.goalsAgainst}</td>
        <td>${db > 0 ? '+' : ''}${db}</td>
        <td class="pts-cell">${team.points}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  function renderTeamCard(league) {
    const human = league.teams.find(t => t.isHuman);
    const el    = document.getElementById('team-roster-display');
    el.innerHTML = '';

    human.roster.forEach(p => {
      const div = document.createElement('div');
      div.className = 'roster-player-row';
      const avg = Math.round(playerAvgStat(p));
      const roleKey = p.role === 'GOALKEEPER' ? 'GK' : p.role === 'DEFENDER' ? 'DEF' : 'ATT';
      div.innerHTML = `
        <span class="role-badge role-${roleKey}">${roleKey}</span>
        ${p.injured ? '<span class="injury-icon" title="Blessé — absent le prochain match">🤕</span>' : ''}
        <span class="player-name-col${p.injured ? ' injured-name' : ''}">${p.name}</span>
        <span class="player-salary-col">${p.salary > 0 ? p.salary + ' or' : 'Gratuit'}</span>
        ${!p.isFreeTier && p.durability ? `<span class="dur-badge" title="Résistance aux blessures">${p.durability}</span>` : ''}
      `;
      el.appendChild(div);
    });

    // Gold
    const goldDiv = document.createElement('div');
    goldDiv.style.cssText = 'margin-top:10px;font-size:0.85rem;color:var(--text2)';
    goldDiv.innerHTML = `Or: <b style="color:var(--gold)">${human.gold}</b>`;
    el.appendChild(goldDiv);
  }

  function renderRecentResults(league) {
    const human = league.teams.find(t => t.isHuman);
    const el    = document.getElementById('recent-results-list');
    el.innerHTML = '';

    const recent = [...league.pastResults]
      .filter(f => f.homeId === human.id || f.awayId === human.id)
      .slice(-5).reverse();

    if (recent.length === 0) {
      el.innerHTML = '<div class="result-row muted">Aucun match joué</div>';
      return;
    }

    recent.forEach(f => {
      const isHome = f.homeId === human.id;
      const opp    = getTeamById(league, isHome ? f.awayId : f.homeId);
      const myG    = isHome ? f.homeScore : f.awayScore;
      const oppG   = isHome ? f.awayScore : f.homeScore;
      const result = myG > oppG ? 'W' : myG < oppG ? 'L' : 'D';
      const cls    = result === 'W' ? 'result-win' : result === 'L' ? 'result-loss' : 'result-draw';
      const div = document.createElement('div');
      div.className = `result-row ${cls}`;
      div.textContent = `${result} ${myG}-${oppG} vs ${opp ? opp.name : '?'}`;
      el.appendChild(div);
    });
  }

  function updateHeader(league) {
    const human = league.teams.find(t => t.isHuman);
    if (!human) return; // pas encore d'équipe humaine (rare, défensif)
    document.getElementById('gold-display').textContent = human.gold;
    document.getElementById('header-team-name').textContent = human.name;
    document.getElementById('matchday-display').textContent = league.currentMatchday + 1;
    const btnStart = document.getElementById('btn-start-matchday');
    if (btnStart) {
      btnStart.innerHTML = `▶ Jouer la Journée ${league.currentMatchday + 1}`;
      btnStart.style.display = league.currentMatchday >= 11 ? 'none' : '';
    }

    // ── Cup teaser : visible uniquement à partir de la journée 5 ─────────────
    const teaser      = document.getElementById('cup-teaser');
    const teaserLabel = document.getElementById('cup-teaser-label');
    if (!teaser) return;

    const md  = league.currentMatchday; // journées déjà jouées (0-based next = md+1)
    const cup = league.cup;

    if (md === 4) {
      // Dernière journée avant la mi-saison — annonce imminente
      teaser.style.display = 'block';
      teaserLabel.textContent = 'après ce match !';
    } else if (md >= 5 && !cup.done) {
      // Coupe en cours
      teaser.style.display = 'block';
      const roundLabel = { QF: 'Quarts de Finale', SF: 'Demi-Finales', FINAL: 'Finale' };
      teaserLabel.textContent = cup.round
        ? `en cours (${roundLabel[cup.round] || ''})` : 'en cours !';
    } else {
      // Avant la mi-saison ou après la coupe : rien à afficher
      teaser.style.display = 'none';
    }
  }

  function renderLeaderboards(league) {
    const stats   = league.stats || {};
    const players = Object.values(stats);

    const render = (listId, sorted, statKey, icon) => {
      const el = document.getElementById(listId);
      if (!el) return;
      el.innerHTML = '';
      if (sorted.length === 0) {
        el.innerHTML = '<div class="lb-empty">Aucune donnée</div>';
        return;
      }
      sorted.forEach((p, i) => {
        const row = document.createElement('div');
        row.className = 'lb-row';
        row.innerHTML = `
          <span class="lb-rank">${i + 1}</span>
          <span class="lb-name">${p.name}</span>
          <span class="lb-team-name">${p.teamName}</span>
          <span class="lb-count">${icon} ${p[statKey]}</span>
        `;
        el.appendChild(row);
      });
    };

    const scorers   = players.filter(p => p.goals   > 0).sort((a, b) => b.goals   - a.goals   || b.assists - a.assists).slice(0, 8);
    const assisters = players.filter(p => p.assists > 0).sort((a, b) => b.assists - a.assists || b.goals   - a.goals).slice(0, 8);

    render('scorers-list',   scorers,   'goals',   '⚽');
    render('assisters-list', assisters, 'assists', '🎯');
  }

  function renderSchedule(league) {
    const el = document.getElementById('schedule-content');
    if (!el || el.style.display === 'none') return; // ne recalculer que si ouvert
    _buildSchedule(league, el);
  }

  function _buildSchedule(league, el) {
    el.innerHTML = '';
    const human = league.teams.find(t => t.isHuman);
    const md    = league.currentMatchday;

    league.schedule.forEach((fixtures, dayIdx) => {
      const isPlayed  = dayIdx < md;
      const isCurrent = dayIdx === md;

      const dayWrap = document.createElement('div');
      dayWrap.className = 'sched-day' + (isCurrent ? ' sched-day-current' : '') + (isPlayed ? ' sched-day-played' : '');

      // ── En-tête journée ──
      const header = document.createElement('div');
      header.className = 'sched-day-header';
      const statusTxt = isPlayed  ? '<span class="sched-status sched-played">✓ Jouée</span>'
                      : isCurrent ? '<span class="sched-status sched-current">▶ Prochaine</span>'
                      :             '<span class="sched-status sched-upcoming">⏳ À venir</span>';
      header.innerHTML = `<span class="sched-day-num">Journée ${dayIdx + 1}</span>${statusTxt}`;
      dayWrap.appendChild(header);

      // ── Matchs ──
      fixtures.forEach(f => {
        const home    = getTeamById(league, f.homeId);
        const away    = getTeamById(league, f.awayId);
        const isHum   = f.homeId === human.id || f.awayId === human.id;
        const played  = f.homeScore !== null;

        const row = document.createElement('div');
        row.className = 'sched-fixture' + (isHum ? ' sched-fixture-human' : '');

        const hName = _short(home ? home.name : '?');
        const aName = _short(away ? away.name : '?');
        const hDot  = `<span class="sched-dot" style="background:${home ? home.color : '#555'}"></span>`;
        const aDot  = `<span class="sched-dot" style="background:${away ? away.color : '#555'}"></span>`;

        if (played) {
          const hWon = f.homeScore > f.awayScore;
          const aWon = f.awayScore > f.homeScore;
          let badge = '';
          if (isHum) {
            const myS  = f.homeId === human.id ? f.homeScore : f.awayScore;
            const oppS = f.homeId === human.id ? f.awayScore : f.homeScore;
            const r    = myS > oppS ? 'W' : myS < oppS ? 'L' : 'D';
            badge = `<span class="sched-result sched-${r.toLowerCase()}">${r}</span>`;
          }
          row.innerHTML =
            `<span class="sched-team ${hWon ? 'sched-winner' : ''}">${hDot}${hName}</span>` +
            `<span class="sched-score">${f.homeScore}&nbsp;–&nbsp;${f.awayScore}</span>` +
            `<span class="sched-team sched-team-right ${aWon ? 'sched-winner' : ''}">${aName}${aDot}</span>` +
            badge;
        } else {
          row.innerHTML =
            `<span class="sched-team">${hDot}${hName}</span>` +
            `<span class="sched-vs">vs</span>` +
            `<span class="sched-team sched-team-right">${aName}${aDot}</span>`;
        }

        dayWrap.appendChild(row);
      });

      el.appendChild(dayWrap);
    });
  }

  function _short(name) {
    // Abrège à 13 caractères si nécessaire
    return name.length > 13 ? name.slice(0, 12) + '…' : name;
  }

  return { render, updateHeader, renderSchedule, _buildSchedule };

})();
