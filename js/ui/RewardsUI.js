/* ═══════════════════════════════════════════
   RewardsUI — post-match results screen
   ═══════════════════════════════════════════ */

const RewardsUI = (() => {

  function render(league, humanFixture, salaryReports, injuryReports, matchState) {
    document.getElementById('rewards-day-num').textContent = league.currentMatchday;

    _renderYourResult(league, humanFixture, matchState);
    _renderEconomy(league, humanFixture, salaryReports, injuryReports || []);
    _renderAllResults(league);
  }

  // ── Your result + match stats ────────────────────────────────────────────
  function _renderYourResult(league, fixture, ms) {
    const human    = league.teams.find(t => t.isHuman);
    const el       = document.getElementById('rewards-your-result');
    const isHome   = fixture.homeId === human.id;
    const myScore  = isHome ? fixture.homeScore : fixture.awayScore;
    const oppScore = isHome ? fixture.awayScore : fixture.homeScore;
    const opp      = getTeamById(league, isHome ? fixture.awayId : fixture.homeId);
    const result   = myScore > oppScore ? 'VICTOIRE' : myScore < oppScore ? 'DÉFAITE' : 'NUL';
    const cls      = myScore > oppScore ? 'win' : myScore < oppScore ? 'loss' : 'draw';

    el.innerHTML = `
      <div class="panel-header">Votre match</div>
      <div class="result-team-names">${human.name} vs ${opp ? opp.name : '?'}</div>
      <div class="result-score-big">${isHome ? myScore : oppScore} – ${isHome ? oppScore : myScore}</div>
      <div class="result-badge-big ${cls}">${result}</div>
    `;

    // ── Match statistics ──────────────────────────────────────────────────
    if (ms) {
      const statsEl = document.createElement('div');
      statsEl.className = 'match-stats-section';
      statsEl.appendChild(_buildStatsTable(ms, human, opp, isHome));
      el.appendChild(statsEl);
    }
  }

  // ── Compute & build stats table ──────────────────────────────────────────
  function _buildStatsTable(ms, human, opp, humanIsHome) {
    const humanDTI = humanIsHome ? 0 : 1;
    const oppDTI   = 1 - humanDTI;

    // Count events by type & display team index (stable across halftime)
    const ev = (types, dti) => {
      const arr = Array.isArray(types) ? types : [types];
      return ms.events.filter(e => {
        const eDTI = (e.displayTeamIndex !== undefined) ? e.displayTeamIndex : e.teamIndex;
        return arr.includes(e.type) && eDTI === dti;
      }).length;
    };

    const goalsH  = humanIsHome ? ms.homeScore : ms.awayScore;
    const goalsO  = humanIsHome ? ms.awayScore : ms.homeScore;
    const savesH  = humanIsHome ? (ms.savesHome || 0) : (ms.savesAway || 0);
    const savesO  = humanIsHome ? (ms.savesAway || 0) : (ms.savesHome || 0);
    // Shots on target = goals scored + opponent GK saves (those that were tested)
    const sotH    = goalsH + savesO;
    const sotO    = goalsO + savesH;
    const shotsH  = ev(['SHOT', 'LONG_SHOT'], humanDTI);
    const shotsO  = ev(['SHOT', 'LONG_SHOT'], oppDTI);
    const lsH     = ev('LONG_SHOT', humanDTI);
    const lsO     = ev('LONG_SHOT', oppDTI);
    const punchH  = ev('PUNCH', humanDTI);
    const punchO  = ev('PUNCH', oppDTI);

    const totalPoss = (ms.possessionA + ms.possessionB) || 1;
    const possH   = Math.round((humanIsHome ? ms.possessionA : ms.possessionB) / totalPoss * 100);
    const possO   = 100 - possH;

    const humanColor = human ? human.color : '#3b82f6';
    const oppColor   = opp   ? opp.color   : '#94a3b8';

    const stats = [
      { label: 'Possession',      h: possH + '%', o: possO + '%', hv: possH,  ov: possO  },
      { label: 'Tirs',            h: shotsH,       o: shotsO,      hv: shotsH, ov: shotsO },
      { label: 'Tirs cadrés',     h: sotH,         o: sotO,        hv: sotH,   ov: sotO   },
      { label: 'Buts',            h: goalsH,       o: goalsO,      hv: goalsH, ov: goalsO },
      { label: 'Arrêts',          h: savesH,       o: savesO,      hv: savesH, ov: savesO },
      { label: 'Tirs lointains',  h: lsH,          o: lsO,         hv: lsH,    ov: lsO    },
      { label: 'Coups de poing',  h: punchH,       o: punchO,      hv: punchH, ov: punchO },
    ];

    const wrap = document.createElement('div');
    wrap.className = 'ms-stats-wrap';

    // Header: team names
    const header = document.createElement('div');
    header.className = 'ms-header';
    header.innerHTML = `
      <span class="ms-team-name ms-human-name" style="color:${humanColor}">
        ${human ? human.name : 'Vous'}
      </span>
      <span class="ms-header-mid">Statistiques</span>
      <span class="ms-team-name ms-opp-name" style="color:${oppColor}">
        ${opp ? opp.name : 'Adversaire'}
      </span>
    `;
    wrap.appendChild(header);

    stats.forEach(s => {
      const total   = (s.hv + s.ov) || 1;
      const pctH    = Math.round(s.hv / total * 100);
      const pctO    = 100 - pctH;
      const winCls  = s.hv > s.ov ? 'ms-winning' : s.hv < s.ov ? 'ms-losing' : '';

      const row = document.createElement('div');
      row.className = 'ms-stat-block';
      row.innerHTML = `
        <div class="ms-vals">
          <span class="ms-human-val ${winCls}">${s.h}</span>
          <span class="ms-stat-lbl">${s.label}</span>
          <span class="ms-opp-val">${s.o}</span>
        </div>
        <div class="ms-bar-wrap">
          <div class="ms-bar-h" style="width:${pctH}%;background:${humanColor}"></div>
          <div class="ms-bar-o" style="width:${pctO}%;background:${oppColor}"></div>
        </div>
      `;
      wrap.appendChild(row);
    });

    return wrap;
  }

  // ── Economy ──────────────────────────────────────────────────────────────
  function _renderEconomy(league, fixture, salaryReports, injuryReports) {
    const human    = league.teams.find(t => t.isHuman);
    const el       = document.getElementById('rewards-economy-panel');
    const isHome   = fixture.homeId === human.id;
    const myScore  = isHome ? fixture.homeScore : fixture.awayScore;
    const oppScore = isHome ? fixture.awayScore : fixture.homeScore;
    const reward   = myScore > oppScore ? 400 : myScore < oppScore ? 150 : 200;

    const myReport    = salaryReports.find(r => r.teamId === human.id) || {};
    const totalSalary = myReport.totalSalary || 0;
    const replacements = myReport.replacements || [];
    const netChange   = reward - totalSalary;

    el.innerHTML = `
      <div class="panel-header">Bilan financier</div>
      <div class="economy-row">
        <span class="economy-label">Récompense du match</span>
        <span class="economy-value eco-positive">+${reward} or</span>
      </div>
      <div class="economy-row">
        <span class="economy-label">Salaires payés</span>
        <span class="economy-value eco-negative">${totalSalary > 0 ? '-' + totalSalary : '0'} or</span>
      </div>
      <div class="economy-row eco-sep">
        <span class="economy-label"><b>Bilan net</b></span>
        <span class="economy-value eco-total">${netChange >= 0 ? '+' : ''}${netChange} or</span>
      </div>
      <div class="economy-row">
        <span class="economy-label">Or total</span>
        <span class="economy-value" style="color:var(--gold)"><b>${human.gold} or</b></span>
      </div>
    `;

    // Replacements (insolvabilité)
    if (replacements.length > 0) {
      replacements.forEach(r => {
        const div = document.createElement('div');
        div.className = 'replacement-notice';
        div.innerHTML = `⚠ <b>${r.released.name}</b> n'a pas pu être payé (${r.released.salary} or) et est retourné dans la base de données. Remplacé par <b>${r.replacement.name}</b> (gratuit).`;
        el.appendChild(div);
      });
    }

    // Blessures
    const humanId = league.teams.find(t => t.isHuman).id;
    const myInjuries = injuryReports.filter(r => r.teamId === humanId);
    if (myInjuries.length > 0) {
      const title = document.createElement('div');
      title.className = 'panel-header';
      title.style.marginTop = '12px';
      title.textContent = 'Blessures';
      el.appendChild(title);
      myInjuries.forEach(r => {
        const div = document.createElement('div');
        div.className = 'replacement-notice injury-notice';
        div.innerHTML = `🤕 <b>${r.player.name}</b> s'est blessé et sera absent le prochain match. <span style="color:var(--text2)">(résistance ${r.player.durability}/10)</span>`;
        el.appendChild(div);
      });
    }
  }

  // ── All results ──────────────────────────────────────────────────────────
  function _renderAllResults(league) {
    const el  = document.getElementById('all-results-list');
    const day = league.currentMatchday - 1;
    if (day < 0) { el.innerHTML = '<div class="muted">—</div>'; return; }
    const fixtures = league.schedule[day] || [];
    const human    = league.teams.find(t => t.isHuman);

    el.innerHTML = '';
    fixtures.forEach(f => {
      const home   = getTeamById(league, f.homeId);
      const away   = getTeamById(league, f.awayId);
      const isH    = f.homeId === human.id || f.awayId === human.id;
      const row    = document.createElement('div');
      row.className = 'all-result-row' + (isH ? ' human-game' : '');
      row.innerHTML = `
        <div class="all-result-teams">
          <span class="all-result-home">${home ? home.name : '?'}</span>
          <span class="all-result-score">${f.homeScore} – ${f.awayScore}</span>
          <span class="all-result-away">${away ? away.name : '?'}</span>
        </div>
      `;
      el.appendChild(row);
    });
  }

  return { render };

})();
