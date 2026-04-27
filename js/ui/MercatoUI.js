/* ═══════════════════════════════════════════
   MercatoUI — interface marché des transferts
   Deux modes :
     • Hors ligne : achat direct (comportement original)
     • En ligne   : enchères publiques avec résolution différée
   ═══════════════════════════════════════════ */

const MercatoUI = (() => {

  // ── État partagé ──────────────────────────────────────────────────────────
  let _league    = null;
  let _humanTeam = null;
  let _pool      = [];        // joueurs disponibles ce jour
  let _isOnline  = false;

  // ── État mode hors ligne ──────────────────────────────────────────────────
  let _selectedRosterIdx  = -1;
  let _selectedPoolPlayer = null;

  // ── État mode enchères ────────────────────────────────────────────────────
  let _bids      = {};        // { playerId: { amount, username, rosterSlot } }
  let _bidPlayer = null;      // joueur dont le modal est ouvert
  let _bidSlot   = -1;        // slot sélectionné dans le modal
  let _isResolved = false;    // true quand les enchères sont closes (avant formation)

  // ─────────────────────────────────────────────────────────────────────────
  //  API PUBLIQUE
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Ouvre le mercato.
   * @param {object}  league    — état courant de la ligue
   * @param {boolean} isOnline  — true = mode enchères, false = achat direct
   */
  function open(league, isOnline) {
    _league    = league;
    _humanTeam = league.teams.find(t => t.isHuman);
    _isOnline  = !!isOnline;

    _selectedRosterIdx  = -1;
    _selectedPoolPlayer = null;
    _bidPlayer          = null;
    _bidSlot            = -1;
    _isResolved         = false;

    document.getElementById('mercato-day-num').textContent = league.currentMatchday + 1;

    // Badge de mode
    const budgetEl = document.getElementById('mercato-budget');
    if (_isOnline) {
      budgetEl.innerHTML = `Budget: <b id="mercato-gold-display">${_humanTeam.gold}</b> or
        <span class="auction-mode-badge">🔨 Mode enchères</span>`;
    } else {
      budgetEl.innerHTML = `Budget: <b id="mercato-gold-display">${_humanTeam.gold}</b> or`;
    }

    // Indice dans le pool
    const hint = document.querySelector('.mercato-hint');
    if (hint) {
      hint.textContent = _isOnline
        ? 'Cliquez sur un joueur pour enchérir — les résultats sont révélés à 20h'
        : '← Sélectionnez un joueur à remplacer';
    }

    // Bouton "Prêt"
    const readyBtn = document.getElementById('btn-ready-play');
    if (readyBtn) {
      readyBtn.textContent = _isOnline ? 'Aller à la formation →' : 'Prêt à jouer !';
    }

    _hideBidModal();
    _hideConfirm();

    if (_isOnline) {
      // Récupérer le pool fixe + enchères en cours depuis le serveur
      Network.getMercatoPool()
        .then(({ pool, bids, resolved }) => {
          _pool = pool || [];
          _bids = bids || {};
          _renderOnline();
        })
        .catch(err => {
          console.warn('Pool serveur inaccessible, mode hors ligne :', err);
          _isOnline = false;
          _pool = Mercato.generatePool(league);
          _renderOffline();
        });
    } else {
      _pool = Mercato.generatePool(league);
      _renderOffline();
    }
  }

  /**
   * Appelé quand le socket reçoit `mercato_resolved`.
   * Les enchères sont closes mais on est encore sur l'écran mercato :
   * on affiche un bandeau et on désactive les nouvelles enchères.
   * Le résultat réel (joueur dans l'équipe) ne sera visible qu'après
   * avoir cliqué "Aller à la formation →".
   */
  function markResolved() {
    _isResolved = true;

    // Bandeau en haut du pool
    const poolPanel = document.getElementById('mercato-pool-panel');
    if (poolPanel && !document.getElementById('mercato-resolved-banner')) {
      const banner = document.createElement('div');
      banner.id        = 'mercato-resolved-banner';
      banner.innerHTML = '🔒 Enchères terminées — cliquez sur <b>Aller à la formation</b> pour voir vos résultats';
      poolPanel.prepend(banner);
    }

    // Mettre à jour le texte du bouton "prêt"
    const readyBtn = document.getElementById('btn-ready-play');
    if (readyBtn) readyBtn.textContent = '🏆 Voir les résultats →';

    // Griser les cartes du pool
    document.querySelectorAll('.auction-card').forEach(c => c.classList.add('ac-closed'));
  }

  /** Appelé quand le socket reçoit `mercato_pool` (reconnexion en cours de mercato) */
  function setPool(pool, bids) {
    _pool = pool || [];
    _bids = bids || {};
    if (_isOnline) _renderOnline();
  }

  /** Appelé quand le socket reçoit `bid_update` (une enchère a été posée en temps réel) */
  function updateBid(playerId, bid) {
    if (!_isOnline) return;
    if (bid) _bids[playerId] = bid;
    else     delete _bids[playerId];

    // Mettre à jour le pool visible
    _renderPoolOnline();

    // Mettre à jour le modal si c'est le joueur en cours
    if (_bidPlayer && _bidPlayer.id === playerId) {
      _renderBidModal();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  MODE EN LIGNE — enchères
  // ─────────────────────────────────────────────────────────────────────────

  function _renderOnline() {
    _renderRosterOnline();
    _renderPoolOnline();
    _updateGoldDisplay();
  }

  function _renderRosterOnline() {
    const el = document.getElementById('your-roster-list');
    el.innerHTML = '';
    _humanTeam.roster.forEach(p => {
      el.appendChild(_makeCard(p, false, false));
    });
  }

  function _renderPoolOnline() {
    const el = document.getElementById('pool-list');
    el.innerHTML = '';
    document.getElementById('pool-count').textContent = `(${_pool.length})`;

    const user = (typeof Network !== 'undefined') ? Network.getUser() : null;

    _pool.forEach(p => {
      const bid     = _bids[p.id];
      const isMyBid = !!(bid && user && bid.username === user.username);
      const minBid  = Math.max(1, playerTransferFee(p));
      const card    = _makeAuctionCard(p, bid, isMyBid, minBid);
      card.addEventListener('click', () => _openBidModal(p));
      el.appendChild(card);
    });
  }

  function _makeAuctionCard(p, bid, isMyBid, minBid) {
    const card    = document.createElement('div');
    card.className = 'mercato-player-card auction-card' + (isMyBid ? ' ac-mine' : '');

    const roleKey  = p.role === 'GOALKEEPER' ? 'GK' : p.role === 'DEFENDER' ? 'DEF' : 'ATT';
    const statHtml = [
      { label: 'VIT', val: p.speed        },
      { label: 'PAS', val: p.passAccuracy },
      { label: 'TIR', val: p.shotAccuracy },
      { label: 'FOR', val: p.power        },
    ].map(s => `<span class="stat-pill ${statLabel(s.val)}">${s.label} ${Math.round(s.val)}</span>`).join('');

    let bidHtml;
    if (bid) {
      bidHtml = `
        <div class="ac-bid-info ${isMyBid ? 'ac-bid-mine' : 'ac-bid-other'}">
          <span class="ac-bid-amount">🔨 ${bid.amount} or</span>
          <span class="ac-bid-user">${bid.username}</span>
        </div>`;
    } else {
      bidHtml = `<div class="ac-bid-info ac-bid-empty">Min. ${minBid} or — cliquez pour enchérir</div>`;
    }

    card.innerHTML = `
      <div class="mpc-left">
        <div class="mpc-name">${p.name}</div>
        <span class="role-badge role-${roleKey}">${roleKey}</span>
        <div class="mpc-stats">${statHtml}</div>
      </div>
      <div class="mpc-right">
        <div class="mpc-salary">${p.salary > 0 ? p.salary + ' or/match' : 'Gratuit'}</div>
        ${bidHtml}
      </div>
    `;
    return card;
  }

  // ── Bid modal ─────────────────────────────────────────────────────────────

  function _openBidModal(player) {
    if (_isResolved) return;   // enchères closes, on n'ouvre plus le modal
    _bidPlayer = player;

    // Auto-sélectionner le premier slot compatible
    const firstCompatible = _humanTeam.roster.findIndex(p => p.role === player.role);
    _bidSlot = firstCompatible >= 0 ? firstCompatible : -1;

    // Pré-remplir le montant avec le minimum suivant
    const bid     = _bids[player.id];
    const minBid  = Math.max(1, playerTransferFee(player));
    const nextMin = bid ? bid.amount + 1 : minBid;

    document.getElementById('bid-amount-input').value = nextMin;
    document.getElementById('bid-error').textContent  = '';

    _renderBidModal();
    document.getElementById('bid-modal').style.display = 'flex';
  }

  function _renderBidModal() {
    if (!_bidPlayer) return;
    const player  = _bidPlayer;
    const user    = (typeof Network !== 'undefined') ? Network.getUser() : null;
    const bid     = _bids[player.id];
    const minBid  = Math.max(1, playerTransferFee(player));
    const roleKey = player.role === 'GOALKEEPER' ? 'GK' : player.role === 'DEFENDER' ? 'DEF' : 'ATT';

    // ── Infos du joueur ──
    document.getElementById('bid-player-info').innerHTML = `
      <span class="mpc-name">${player.name}</span>
      <span class="role-badge role-${roleKey}" style="margin-left:6px">${roleKey}</span>
      <span class="mpc-salary" style="margin-left:8px">${player.salary > 0 ? player.salary + ' or/match' : 'Gratuit'}</span>
    `;

    // ── Enchère actuelle ──
    if (bid) {
      const isMyBid = !!(user && bid.username === user.username);
      document.getElementById('bid-current-info').innerHTML = `
        <div class="ac-bid-info ${isMyBid ? 'ac-bid-mine' : 'ac-bid-other'}">
          Meilleure enchère : <b>${bid.amount} or</b> par <b>${bid.username}</b>${isMyBid ? ' <span style="opacity:.7">(vous)</span>' : ''}
        </div>
      `;
    } else {
      document.getElementById('bid-current-info').innerHTML = `
        <div class="ac-bid-info ac-bid-empty">Aucune enchère — minimum ${minBid} or</div>
      `;
    }

    // ── Liste des slots compatibles ──
    const slotList = document.getElementById('bid-slot-list');
    slotList.innerHTML = '';
    _humanTeam.roster.forEach((p, idx) => {
      if (p.role !== player.role) return;
      const btn    = document.createElement('button');
      const roleK  = p.role === 'GOALKEEPER' ? 'GK' : p.role === 'DEFENDER' ? 'DEF' : 'ATT';
      btn.className       = 'bid-slot-btn' + (idx === _bidSlot ? ' selected' : '');
      btn.dataset.slotIdx = idx;
      btn.innerHTML = `<span class="role-badge role-${roleK}">${roleK}</span><span>${p.name}</span>`;
      slotList.appendChild(btn);
    });

    // Délégation d'événement (property — pas d'accumulation)
    slotList.onclick = e => {
      const btn = e.target.closest('.bid-slot-btn');
      if (!btn) return;
      _bidSlot = parseInt(btn.dataset.slotIdx, 10);
      slotList.querySelectorAll('.bid-slot-btn').forEach(b => {
        b.classList.toggle('selected', parseInt(b.dataset.slotIdx, 10) === _bidSlot);
      });
    };
  }

  function _hideBidModal() {
    document.getElementById('bid-modal').style.display = 'none';
    _bidPlayer = null;
    _bidSlot   = -1;
  }

  async function _confirmBid() {
    if (!_bidPlayer) return;

    const amount = parseInt(document.getElementById('bid-amount-input').value, 10);
    const errEl  = document.getElementById('bid-error');
    errEl.textContent = '';

    if (isNaN(amount) || amount <= 0) {
      errEl.textContent = 'Montant invalide';
      return;
    }

    // Vérification budget : somme des enchères où on est le plus haut enchérisseur
    // (hors le joueur actuellement sélectionné, qu'on remplace ou pour lequel c'est nouveau)
    if (_isOnline && _humanTeam) {
      const user = Network.getUser();
      const alreadyCommitted = Object.entries(_bids).reduce((sum, [pid, bid]) => {
        if (pid === _bidPlayer.id) return sum;        // remplacé ou nouveau
        if (bid.username !== user.username) return sum;
        return sum + bid.amount;
      }, 0);
      if (alreadyCommitted + amount > _humanTeam.gold) {
        const remaining = _humanTeam.gold - alreadyCommitted;
        errEl.textContent = remaining <= 0
          ? `Budget insuffisant : vos autres enchères engagent déjà tout votre or (${alreadyCommitted} or)`
          : `Budget insuffisant : vos autres enchères engagent déjà ${alreadyCommitted} or, maximum autorisé ici : ${remaining} or`;
        return;
      }
    }

    // Auto-sélectionner le premier slot si aucun choisi
    let slot = _bidSlot;
    if (slot < 0) {
      slot = _humanTeam.roster.findIndex(p => p.role === _bidPlayer.role);
    }
    if (slot < 0) {
      errEl.textContent = 'Aucun poste compatible dans votre effectif';
      return;
    }

    const btn = document.getElementById('btn-confirm-bid');
    btn.disabled     = true;
    btn.textContent  = '⏳ Envoi…';

    try {
      await Network.placeBid(_bidPlayer.id, amount, slot);
      _hideBidModal();
    } catch (e) {
      errEl.textContent = e.message;
    } finally {
      btn.disabled    = false;
      btn.textContent = '🔨 Enchérir';
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  MODE HORS LIGNE — achat direct
  // ─────────────────────────────────────────────────────────────────────────

  function _renderOffline() {
    _renderRoster();
    _renderPool();
    _updateGoldDisplay();
  }

  function _renderRoster() {
    const el = document.getElementById('your-roster-list');
    el.innerHTML = '';
    _humanTeam.roster.forEach((p, idx) => {
      const card = _makeCard(p, false, idx === _selectedRosterIdx);
      card.addEventListener('click', () => _selectRosterSlot(idx));
      el.appendChild(card);
    });
  }

  function _renderPool() {
    const el = document.getElementById('pool-list');
    el.innerHTML = '';
    document.getElementById('pool-count').textContent = `(${_pool.length})`;

    _pool.forEach(p => {
      const matchesRole = _selectedRosterIdx >= 0
        && _humanTeam.roster[_selectedRosterIdx].role === p.role;
      const card = _makeCard(p, true, p === _selectedPoolPlayer);
      if (_selectedRosterIdx >= 0 && !matchesRole) card.classList.add('dimmed');
      if (_selectedRosterIdx >= 0 && matchesRole)  card.classList.add('highlight-match');
      card.addEventListener('click', () => _selectPoolPlayer(p));
      el.appendChild(card);
    });
  }

  function _makeCard(p, showFee, selected) {
    const card    = document.createElement('div');
    card.className = 'mercato-player-card' + (selected ? ' selected' : '');

    const fee     = playerTransferFee(p);
    const roleKey = p.role === 'GOALKEEPER' ? 'GK' : p.role === 'DEFENDER' ? 'DEF' : 'ATT';
    const statHtml = [
      { label: 'VIT', val: p.speed        },
      { label: 'PAS', val: p.passAccuracy },
      { label: 'TIR', val: p.shotAccuracy },
      { label: 'FOR', val: p.power        },
      ...(p.isFreeTier ? [] : [{ label: 'RES', val: p.durability || 5 }]),
    ].map(s => `<span class="stat-pill ${statLabel(s.val)}">${s.label} ${Math.round(s.val)}</span>`).join('');

    card.innerHTML = `
      <div class="mpc-left">
        <div class="mpc-name">${p.name}${p.injured ? ' <span class="injury-icon">🤕</span>' : ''}</div>
        <span class="role-badge role-${roleKey}">${roleKey}</span>
        <div class="mpc-stats">${statHtml}</div>
      </div>
      <div class="mpc-right">
        ${showFee
          ? (fee === 0
              ? '<span class="mpc-free">Gratuit</span>'
              : `<div class="mpc-fee">${fee} or</div><div class="mpc-salary">${p.salary} or/match</div>`)
          : `<div class="mpc-salary">${p.salary > 0 ? p.salary + ' or/match' : 'Gratuit'}</div>`
        }
      </div>
    `;
    return card;
  }

  function _selectRosterSlot(idx) {
    _selectedRosterIdx  = (_selectedRosterIdx === idx) ? -1 : idx;
    _selectedPoolPlayer = null;
    _hideConfirm();
    _renderOffline();
  }

  function _selectPoolPlayer(p) {
    if (_selectedRosterIdx < 0) { _flashHint(); return; }
    const toReplace = _humanTeam.roster[_selectedRosterIdx];
    if (toReplace.role !== p.role) {
      _flashHint(`Rôle incompatible — sélectionnez un ${_roleLabel(p.role)}`);
      return;
    }
    _selectedPoolPlayer = p;
    _showConfirm(p, _selectedRosterIdx);
    _renderOffline();
  }

  function _showConfirm(p, rosterIdx) {
    const toReplace = _humanTeam.roster[rosterIdx];
    const fee       = playerTransferFee(p);
    const canAfford = _humanTeam.gold >= fee;

    document.getElementById('transfer-preview').innerHTML = `
      <b style="color:var(--red)">${toReplace.name}</b>
      <span style="color:var(--text2)"> → </span>
      <b style="color:var(--green)">${p.name}</b>
    `;
    document.getElementById('transfer-cost-line').innerHTML =
      fee === 0
        ? '<span style="color:var(--green)">Transfert gratuit</span>'
        : `Coût: <b style="color:${canAfford ? 'var(--gold)' : 'var(--red)'}">${fee} or</b>${!canAfford ? ' (insuffisant !)' : ''}`;

    document.getElementById('btn-confirm-transfer').disabled = !canAfford;
    document.getElementById('transfer-confirm').style.display = 'flex';
  }

  function _hideConfirm() {
    document.getElementById('transfer-confirm').style.display = 'none';
    _selectedPoolPlayer = null;
  }

  function _confirmTransfer() {
    if (_selectedRosterIdx < 0 || !_selectedPoolPlayer) return;
    const boughtPlayerId = _selectedPoolPlayer.id;
    const result = Mercato.buyPlayer(_humanTeam, _selectedPoolPlayer, _selectedRosterIdx, _league);
    if (result.ok) {
      const poolIdx = _pool.indexOf(_selectedPoolPlayer);
      if (poolIdx !== -1) _pool.splice(poolIdx, 1);
      _selectedRosterIdx  = -1;
      _selectedPoolPlayer = null;
    }
    _hideConfirm();
    _renderOffline();
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  HELPERS COMMUNS
  // ─────────────────────────────────────────────────────────────────────────

  function _updateGoldDisplay() {
    document.getElementById('mercato-gold-display').textContent = _humanTeam.gold;
    const gd = document.getElementById('gold-display');
    if (gd) gd.textContent = _humanTeam.gold;
  }

  function _flashHint(msg) {
    const hint = document.querySelector('.mercato-hint');
    if (!hint) return;
    const orig = hint.textContent;
    if (msg) hint.textContent = '⚠ ' + msg;
    hint.style.color = 'var(--red)';
    setTimeout(() => { hint.textContent = orig; hint.style.color = ''; }, 2500);
  }

  function _roleLabel(role) {
    return { ATTACKER: 'Attaquant', DEFENDER: 'Défenseur', GOALKEEPER: 'Gardien' }[role] || role;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  BIND BUTTONS
  // ─────────────────────────────────────────────────────────────────────────

  function bindButtons() {
    document.getElementById('btn-confirm-transfer').addEventListener('click', _confirmTransfer);
    document.getElementById('btn-cancel-transfer').addEventListener('click', _hideConfirm);
    document.getElementById('btn-confirm-bid').addEventListener('click', _confirmBid);
    document.getElementById('btn-cancel-bid').addEventListener('click', _hideBidModal);
  }

  return { open, bindButtons, setPool, updateBid, markResolved };

})();
