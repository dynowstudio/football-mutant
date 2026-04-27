/* ═══════════════════════════════════════════
   TrumpCardUI — sélection de la carte atout
   ═══════════════════════════════════════════ */

const TrumpCardUI = (() => {

  // ── Enregistre la carte sur le serveur (si connecté) ─────────────────────
  function _syncTrumpCard(cardId) {
    if (typeof Network !== 'undefined' && Network.isLoggedIn()) {
      Network.setTrumpCard(cardId).catch(err => console.warn('Trump card sync failed:', err));
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  function render(league) {
    const human     = league.teams.find(t => t.isHuman);
    const container = document.getElementById('trump-card-panel');
    if (!container) return;

    container.innerHTML = '';

    // ── Header ────────────────────────────────────────────────────────────
    const header = document.createElement('div');
    header.className = 'panel-header';
    header.textContent = '🃏 Carte Atout';
    container.appendChild(header);

    // ── Currently equipped display ────────────────────────────────────────
    const currentEl = document.createElement('div');
    currentEl.className = 'trump-active-display';

    if (human.trumpCard && TRUMP_CARDS[human.trumpCard]) {
      const card = TRUMP_CARDS[human.trumpCard];
      const col  = new THREE.Color(card.color);
      const rgba = `rgba(${Math.round(col.r*255)},${Math.round(col.g*255)},${Math.round(col.b*255)},0.15)`;
      currentEl.style.borderLeft = `3px solid ${card.color}`;
      currentEl.style.background = rgba;
      currentEl.innerHTML = `
        <span class="trump-active-icon">${card.icon}</span>
        <div class="trump-active-info">
          <span class="trump-active-name" style="color:${card.color}">${card.name}</span>
          <span class="trump-active-desc">
            <span class="trump-bonus">${card.bonus}</span>
            &nbsp;·&nbsp;
            <span class="trump-malus">${card.malus}</span>
          </span>
        </div>
        <button class="trump-remove-btn" title="Retirer la carte">✕</button>
      `;
      currentEl.querySelector('.trump-remove-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        human.trumpCard = null;
        _syncTrumpCard(null);
        render(league);
      });
    } else {
      currentEl.innerHTML = `<span class="trump-none-label">Aucune carte équipée</span>`;
    }
    container.appendChild(currentEl);

    // ── Card selection grid ───────────────────────────────────────────────
    const expl = document.createElement('div');
    expl.className = 'trump-explanation';
    expl.textContent = 'Une carte atout applique un bonus et un malus à tous vos joueurs pendant toute la saison. Vous ne pouvez en équiper qu\'une seule à la fois.';
    container.appendChild(expl);

    const hint = document.createElement('div');
    hint.className = 'trump-grid-hint';
    hint.textContent = 'Cliquez pour équiper · cliquez à nouveau pour retirer';
    container.appendChild(hint);

    const grid = document.createElement('div');
    grid.className = 'trump-cards-grid';

    Object.values(TRUMP_CARDS).forEach(card => {
      const equipped = human.trumpCard === card.id;
      const col      = new THREE.Color(card.color);
      const rgba     = `rgba(${Math.round(col.r*255)},${Math.round(col.g*255)},${Math.round(col.b*255)},0.18)`;
      const glow     = `rgba(${Math.round(col.r*255)},${Math.round(col.g*255)},${Math.round(col.b*255)},0.30)`;

      const tile = document.createElement('div');
      tile.className = 'trump-card-tile' + (equipped ? ' active' : '');
      if (equipped) {
        tile.style.borderColor = card.color;
        tile.style.background  = rgba;
        tile.style.boxShadow   = `0 0 10px ${glow}`;
      }

      tile.innerHTML = `
        <span class="trump-tile-icon">${card.icon}</span>
        <span class="trump-tile-name" style="color:${equipped ? card.color : ''}">${card.name}</span>
        <span class="trump-tile-bonus">${card.bonus}</span>
        <span class="trump-tile-malus">${card.malus}</span>
      `;

      tile.addEventListener('click', () => {
        human.trumpCard = equipped ? null : card.id;
        _syncTrumpCard(human.trumpCard);
        render(league);
      });

      grid.appendChild(tile);
    });

    container.appendChild(grid);
  }

  return { render };

})();
