/* ═══════════════════════════════════════════
   CupUI — mid-season knockout tournament UI
   ═══════════════════════════════════════════ */

const CupUI = (() => {

  function open(league) {
    _render(league);
    ScreenManager.show('cup');
  }

  // ── Main render ──────────────────────────────────────────────────────────────
  function _render(league) {
    const cup = league.cup;

    // Round heading
    const roundLabels = { QF: 'Quarts de Finale', SF: 'Demi-Finales', FINAL: 'Finale' };
    const headingEl = document.getElementById('cup-round-label');
    if (cup.done) {
      headingEl.innerHTML = `🏆 Tournoi Terminé — Champion : <b style="color:var(--gold)">${cup.champion ? cup.champion.name : '?'}</b>`;
    } else {
      headingEl.textContent = roundLabels[cup.round] || '';
    }

    _renderBracket(league);
    _renderEarnings(league);
    _updateButton(league);
  }

  // ── Bracket ──────────────────────────────────────────────────────────────────
  function _renderBracket(league) {
    const cup   = league.cup;
    const human = league.teams.find(t => t.isHuman);
    const el    = document.getElementById('cup-bracket');
    el.innerHTML = '';

    // QF column — always has 4 real matches
    el.appendChild(_makeColumn('Quarts', cup.QF, league, human, cup.round === 'QF' && !cup.done));
    el.appendChild(_makeArrow());

    // SF column — placeholders until QF done
    const sfFixtures = cup.SF.length > 0 ? cup.SF : [null, null];
    el.appendChild(_makeColumn('Demi-Finales', sfFixtures, league, human, cup.round === 'SF' && !cup.done));
    el.appendChild(_makeArrow());

    // Final column — placeholder until SF done
    const finalFixtures = cup.FINAL ? [cup.FINAL] : [null];
    const finalCol = _makeColumn('Finale', finalFixtures, league, human, cup.round === 'FINAL' && !cup.done);
    if (cup.done && cup.champion) {
      const champDiv = document.createElement('div');
      champDiv.className = 'cup-champion-tag';
      champDiv.innerHTML = `🏆 <b>${cup.champion.name}</b>`;
      finalCol.appendChild(champDiv);
    }
    el.appendChild(finalCol);
  }

  function _makeColumn(title, fixtures, league, human, isCurrent) {
    const col = document.createElement('div');
    col.className = 'cup-column' + (isCurrent ? ' cup-column-active' : '');

    const titleEl = document.createElement('div');
    titleEl.className = 'cup-col-title';
    titleEl.textContent = title;
    col.appendChild(titleEl);

    fixtures.forEach(f => col.appendChild(_makeMatchCard(f, league, human)));
    return col;
  }

  function _makeMatchCard(f, league, human) {
    const card = document.createElement('div');
    card.className = 'cup-match-card';

    if (!f) {
      card.classList.add('cup-tbd-card');
      card.innerHTML = '<div class="cup-tbd-text">À déterminer</div>';
      return card;
    }

    const home   = getTeamById(league, f.homeId);
    const away   = getTeamById(league, f.awayId);
    const played = f.homeScore !== null && f.homeScore !== undefined;
    const isHum  = f.homeId === human.id || f.awayId === human.id;

    if (isHum) card.classList.add('cup-human-match');

    const homeWon = played && f.winnerId === f.homeId;
    const awayWon = played && f.winnerId === f.awayId;

    card.innerHTML = `
      <div class="cup-team-row ${homeWon ? 'cup-winner' : (played ? 'cup-loser' : '')}">
        <span class="cup-dot" style="background:${home ? home.color : '#555'}"></span>
        <span class="cup-tname">${home ? home.name : '?'}</span>
        ${played ? `<span class="cup-score">${f.homeScore}</span>` : ''}
      </div>
      <div class="cup-team-row ${awayWon ? 'cup-winner' : (played ? 'cup-loser' : '')}">
        <span class="cup-dot" style="background:${away ? away.color : '#555'}"></span>
        <span class="cup-tname">${away ? away.name : '?'}</span>
        ${played ? `<span class="cup-score">${f.awayScore}</span>` : ''}
      </div>
      ${f.penalties ? '<div class="cup-pen-note">t.a.b.</div>' : ''}
    `;
    return card;
  }

  function _makeArrow() {
    const el = document.createElement('div');
    el.className = 'cup-connector';
    el.textContent = '›';
    return el;
  }

  // ── Earnings panel ────────────────────────────────────────────────────────────
  function _renderEarnings(league) {
    const cup   = league.cup;
    const human = league.teams.find(t => t.isHuman);
    const el    = document.getElementById('cup-earnings');
    el.innerHTML = '';

    if (!cup.lastEarnings) return;

    const e = cup.lastEarnings;
    const row = document.createElement('div');
    row.className = 'cup-earnings-row';
    if (e.amount > 0) {
      row.innerHTML = `<span class="eco-positive">+${e.amount} or</span> — ${e.reason}`;
    } else {
      row.innerHTML = `<span style="color:var(--text2)">${e.reason}</span>`;
    }
    el.appendChild(row);

    const totalRow = document.createElement('div');
    totalRow.className = 'cup-earnings-total';
    totalRow.innerHTML = `Or total : <b style="color:var(--gold)">${human.gold} or</b>`;
    el.appendChild(totalRow);
  }

  // ── Button state ──────────────────────────────────────────────────────────────
  function _updateButton(league) {
    const cup   = league.cup;
    const human = league.teams.find(t => t.isHuman);
    const btn   = document.getElementById('btn-play-cup');

    if (cup.done) {
      btn.textContent = '→ Retour au classement';
      return;
    }

    if (cup.roundState === 'POST') {
      const nextLabel = { QF: 'les Demi-Finales', SF: 'la Finale' };
      btn.textContent = cup.round === 'FINAL'
        ? '🏆 Voir le classement'
        : `→ Jouer ${nextLabel[cup.round]}`;
      return;
    }

    // PRE state — decide "Jouer" vs "Simuler"
    const curFixtures = cup.round === 'FINAL' ? [cup.FINAL] : cup[cup.round];
    const humanIn = curFixtures && curFixtures.some(f => f && (f.homeId === human.id || f.awayId === human.id));
    const playLabel = { QF: 'les Quarts', SF: 'les Demi-Finales', FINAL: 'la Finale' };
    btn.textContent = humanIn
      ? `▶ Jouer ${playLabel[cup.round]}`
      : `▶ Simuler ${playLabel[cup.round]}`;
  }

  return { open };

})();
