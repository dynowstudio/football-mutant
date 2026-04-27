/* ═══════════════════════════════════════════
   FormationUI — éditeur de formation drag-and-drop (terrain complet)
   ═══════════════════════════════════════════ */

const FormationUI = (() => {

  const CANVAS_W = 680;   // = largeur complète du terrain simulé
  const CANVAS_H = 440;   // = hauteur du terrain simulé
  const R = 22;           // rayon des tokens joueurs

  // Prédéfinitions de formation [GK, DEF, ATT1, ATT2] — coords sim (attaque vers la droite)
  const PRESETS = [
    { name: '⚖️ Équilibré',    pos: [{x:30,y:220},{x:155,y:220},{x:260,y:152},{x:260,y:288}] },
    { name: '⚔️ Attaquant',    pos: [{x:30,y:220},{x:190,y:220},{x:308,y:138},{x:308,y:302}] },
    { name: '🛡️ Défensif',     pos: [{x:30,y:220},{x:108,y:220},{x:208,y:162},{x:208,y:278}] },
    { name: '↔️ Côtés larges', pos: [{x:30,y:220},{x:155,y:220},{x:272,y: 78},{x:272,y:362}] },
    { name: '🔷 Central',      pos: [{x:30,y:220},{x:148,y:220},{x:238,y:192},{x:312,y:248}] },
  ];

  const ROLE_COLORS  = ['#ffd700', '#3b82f6', '#22c55e', '#22c55e'];
  const ROLE_LABELS  = ['G', 'D', 'A', 'A'];
  const ROLE_NAMES   = ['Gardien', 'Défenseur', 'Attaquant', 'Attaquant'];

  // X limites (sim) par poste — terrain complet 0..680
  const X_LIMITS = [
    [12,  140],   // GK  — rester près du propre but (gauche)
    [60,  500],   // DEF — défense jusqu'au milieu de terrain
    [100, 668],   // ATT1 — milieu jusqu'à l'avant
    [100, 668],   // ATT2
  ];

  let _league    = null;
  let _canvas    = null;
  let _ctx       = null;
  let _positions = [];    // [{x,y}] en coords sim
  let _players   = [];    // [player] dans l'ordre [GK, DEF, ATT1, ATT2]
  let _dragging  = -1;
  let _dragOX    = 0, _dragOY = 0;
  let _teamColor = '#3b82f6';
  let _presetBtns = [];

  // ══════════════════════════════════════════════════════════════════════════
  //  OPEN
  // ══════════════════════════════════════════════════════════════════════════
  function open(league) {
    _league = league;
    const human = league.teams.find(t => t.isHuman);
    _teamColor  = human.color;

    // Ordre stable : GK, DEF, ATT1, ATT2
    const gk   = human.roster.find(p => p.role === 'GOALKEEPER');
    const def  = human.roster.find(p => p.role === 'DEFENDER');
    const atts = human.roster.filter(p => p.role === 'ATTACKER');
    _players   = [gk, def, atts[0], atts[1]].map(p => p || null);

    // Charger formation existante ou preset par défaut
    if (human.formation && human.formation.positions && human.formation.positions.length === 4) {
      _positions = human.formation.positions.map(p => ({ x: p.x, y: p.y }));
    } else {
      _applyPreset(0);
    }

    document.getElementById('formation-day-num').textContent = league.currentMatchday + 1;
    _buildPresetButtons();
    _buildPlayerList();
    _initCanvas();
    _draw();
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  PRESET BUTTONS
  // ══════════════════════════════════════════════════════════════════════════
  function _applyPreset(idx) {
    _positions = PRESETS[idx].pos.map(p => ({ x: p.x, y: p.y }));
  }

  function _buildPresetButtons() {
    const wrap = document.getElementById('formation-presets');
    wrap.innerHTML = '';
    _presetBtns = [];
    PRESETS.forEach((pr, i) => {
      const btn = document.createElement('button');
      btn.className = 'formation-preset-btn';
      btn.textContent = pr.name;
      btn.addEventListener('click', () => {
        _applyPreset(i);
        _draw();
      });
      wrap.appendChild(btn);
      _presetBtns.push(btn);
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  PLAYER LIST (sidebar)
  // ══════════════════════════════════════════════════════════════════════════
  function _buildPlayerList() {
    const el = document.getElementById('formation-players-list');
    el.innerHTML = '';
    _players.forEach((p, i) => {
      const card = document.createElement('div');
      card.className = 'formation-player-card';
      card.style.borderLeftColor = ROLE_COLORS[i];
      if (!p) {
        card.innerHTML = `<span class="fp-badge" style="background:${ROLE_COLORS[i]}">${ROLE_LABELS[i]}</span>
          <span class="fp-name" style="color:var(--text2)">— vide —</span>`;
      } else {
        card.innerHTML = `
          <span class="fp-badge" style="background:${ROLE_COLORS[i]}">${ROLE_LABELS[i]}</span>
          <div class="fp-info">
            <span class="fp-name">${p.name}</span>
            <span class="fp-stats">
              VIT&nbsp;${Math.round(p.speed)}
              &nbsp;·&nbsp;PAS&nbsp;${Math.round(p.passAccuracy)}
              &nbsp;·&nbsp;TIR&nbsp;${Math.round(p.shotAccuracy)}
            </span>
          </div>
        `;
      }
      el.appendChild(card);
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  CANVAS SETUP
  // ══════════════════════════════════════════════════════════════════════════
  function _initCanvas() {
    _canvas = document.getElementById('formation-canvas');
    _ctx    = _canvas.getContext('2d');
    _canvas.width  = CANVAS_W;
    _canvas.height = CANVAS_H;

    // Remove old listeners by replacing the node
    const fresh = _canvas.cloneNode(true);
    _canvas.parentNode.replaceChild(fresh, _canvas);
    _canvas = fresh;
    _ctx    = _canvas.getContext('2d');

    _canvas.addEventListener('mousedown',  _onDown);
    _canvas.addEventListener('mousemove',  _onMove);
    _canvas.addEventListener('mouseup',    _onUp);
    _canvas.addEventListener('mouseleave', _onUp);
    _canvas.addEventListener('touchstart', e => { const t = e.touches[0]; _onDown({ clientX: t.clientX, clientY: t.clientY }); e.preventDefault(); }, { passive: false });
    _canvas.addEventListener('touchmove',  e => { const t = e.touches[0]; _onMove({ clientX: t.clientX, clientY: t.clientY }); e.preventDefault(); }, { passive: false });
    _canvas.addEventListener('touchend',   _onUp);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  DRAW
  // ══════════════════════════════════════════════════════════════════════════
  function _draw() {
    if (!_ctx) return;
    _drawPitch();
    _drawPlayers();
  }

  function _drawPitch() {
    const c = _ctx;
    const W = CANVAS_W, H = CANVAS_H;

    // Background
    c.fillStyle = '#182e1a';
    c.fillRect(0, 0, W, H);

    // Grass stripes (vertical)
    const nS = 14, sw = W / nS;
    for (let i = 0; i < nS; i++) {
      c.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.025)';
      c.fillRect(i * sw, 0, sw, H);
    }

    // Zone bands — notre camp (gauche) / milieu / leur camp (droite)
    const zones = [
      { x: 0,   w: 200, color: 'rgba(255,200,0,0.05)',  label: 'NOTRE CAMP'  },
      { x: 200, w: 280, color: 'rgba(100,180,255,0.05)', label: 'MILIEU'      },
      { x: 480, w: 200, color: 'rgba(50,220,80,0.05)',   label: 'LEUR CAMP'   },
    ];
    zones.forEach(z => {
      c.fillStyle = z.color;
      c.fillRect(z.x, 0, z.w, H);
      c.fillStyle = 'rgba(255,255,255,0.12)';
      c.font = 'bold 10px Arial';
      c.textAlign = 'center';
      c.textBaseline = 'top';
      c.fillText(z.label, z.x + z.w / 2, 6);
    });

    // ── Lignes du terrain ──
    c.lineWidth = 1.5;
    c.strokeStyle = 'rgba(255,255,255,0.55)';

    // Bordure extérieure
    c.strokeRect(0, 0, W, H);

    // Ligne médiane
    c.beginPath();
    c.moveTo(W / 2, 0); c.lineTo(W / 2, H);
    c.stroke();

    // Cercle central
    c.beginPath();
    c.arc(W / 2, H / 2, 55, 0, Math.PI * 2);
    c.strokeStyle = 'rgba(255,255,255,0.35)';
    c.stroke();

    // Point central
    c.fillStyle = 'rgba(255,255,255,0.65)';
    c.beginPath(); c.arc(W / 2, H / 2, 3, 0, Math.PI * 2); c.fill();

    c.strokeStyle = 'rgba(255,255,255,0.45)';

    // ── But gauche (notre but) ──
    c.lineWidth = 2.5;
    c.strokeStyle = 'rgba(255,220,100,0.75)';  // légèrement doré = notre but
    c.beginPath();
    c.moveTo(0, 180); c.lineTo(-14, 180);
    c.lineTo(-14, 260); c.lineTo(0, 260);
    c.stroke();

    // ── But droit (but adverse) ──
    c.strokeStyle = 'rgba(255,255,255,0.55)';
    c.beginPath();
    c.moveTo(W, 180); c.lineTo(W + 14, 180);
    c.lineTo(W + 14, 260); c.lineTo(W, 260);
    c.stroke();

    c.lineWidth = 1.5;
    c.strokeStyle = 'rgba(255,255,255,0.40)';

    // ── Surface de réparation gauche ──
    c.strokeRect(0, 155, 100, 130);
    // Surface de but gauche
    c.strokeRect(0, 190, 45, 60);
    // Point de penalty gauche
    c.fillStyle = 'rgba(255,255,255,0.55)';
    c.beginPath(); c.arc(111, H / 2, 2.5, 0, Math.PI * 2); c.fill();

    // ── Surface de réparation droite ──
    c.strokeStyle = 'rgba(255,255,255,0.40)';
    c.strokeRect(W - 100, 155, 100, 130);
    // Surface de but droite
    c.strokeRect(W - 45, 190, 45, 60);
    // Point de penalty droit
    c.fillStyle = 'rgba(255,255,255,0.55)';
    c.beginPath(); c.arc(W - 111, H / 2, 2.5, 0, Math.PI * 2); c.fill();

    // ── Flèche d'attaque ──
    c.fillStyle = 'rgba(100,220,100,0.25)';
    c.font = 'bold 12px Arial';
    c.textAlign = 'center';
    c.textBaseline = 'bottom';
    c.fillText('⟶  Sens d\'attaque', W * 0.72, H - 5);

    // ── Label but gauche ──
    c.fillStyle = 'rgba(255,220,100,0.50)';
    c.font = 'bold 9px Arial';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('VOTRE\nBUT', 18, H / 2);

    // ── Label but droit ──
    c.fillStyle = 'rgba(255,255,255,0.28)';
    c.font = 'bold 9px Arial';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('BUT\nADV.', W - 18, H / 2);
  }

  function _drawPlayers() {
    const c = _ctx;
    _positions.forEach((pos, i) => {
      if (!pos) return;
      const px = pos.x, py = pos.y;
      const rc = ROLE_COLORS[i];
      const p  = _players[i];
      const col3 = new THREE.Color(_teamColor);
      const fillHex = `rgb(${Math.round(col3.r*255)},${Math.round(col3.g*255)},${Math.round(col3.b*255)})`;

      // Shadow
      c.beginPath();
      c.ellipse(px, py + R - 2, R * 0.65, R * 0.22, 0, 0, Math.PI * 2);
      c.fillStyle = 'rgba(0,0,0,0.35)';
      c.fill();

      // Outer glow
      c.beginPath();
      c.arc(px, py, R + 5, 0, Math.PI * 2);
      c.fillStyle = rc + '2a';
      c.fill();

      // Main circle
      c.beginPath();
      c.arc(px, py, R, 0, Math.PI * 2);
      c.fillStyle = fillHex;
      c.fill();
      c.strokeStyle = rc;
      c.lineWidth = 2.5;
      c.stroke();

      // Role letter
      c.fillStyle = '#ffffff';
      c.font = 'bold 15px Arial';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(ROLE_LABELS[i], px, py);

      // Name tag
      if (p) {
        const last = p.name.split(' ').pop().toUpperCase();
        const tagW = Math.max(last.length * 6.2 + 12, 36);
        const tagH = 15;
        const tx   = px - tagW / 2;
        const ty   = py - R - tagH - 5;

        c.fillStyle = 'rgba(0,0,0,0.78)';
        if (c.roundRect) {
          c.beginPath(); c.roundRect(tx, ty, tagW, tagH, 3); c.fill();
        } else {
          c.fillRect(tx, ty, tagW, tagH);
        }
        c.fillStyle = '#ffffff';
        c.font = '8.5px Arial';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(last, px, ty + tagH / 2);
      }
    });
    c.textBaseline = 'alphabetic';
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  DRAG LOGIC
  // ══════════════════════════════════════════════════════════════════════════
  function _canvasXY(e) {
    const rect = _canvas.getBoundingClientRect();
    return {
      cx: (e.clientX - rect.left) * (CANVAS_W / rect.width),
      cy: (e.clientY - rect.top)  * (CANVAS_H / rect.height),
    };
  }

  function _hitTest(cx, cy) {
    for (let i = _positions.length - 1; i >= 0; i--) {
      const { x, y } = _positions[i];
      if (Math.hypot(cx - x, cy - y) < R + 6) return i;
    }
    return -1;
  }

  function _clamp(idx, x, y) {
    const [minX, maxX] = X_LIMITS[idx] || [12, 668];
    return {
      x: Math.max(minX, Math.min(maxX, x)),
      y: Math.max(R + 5, Math.min(CANVAS_H - R - 5, y)),
    };
  }

  function _onDown(e) {
    const { cx, cy } = _canvasXY(e);
    _dragging = _hitTest(cx, cy);
    if (_dragging >= 0) {
      _dragOX = cx - _positions[_dragging].x;
      _dragOY = cy - _positions[_dragging].y;
    }
  }

  function _onMove(e) {
    if (_dragging < 0) return;
    const { cx, cy } = _canvasXY(e);
    _positions[_dragging] = _clamp(_dragging, cx - _dragOX, cy - _dragOY);
    _draw();
  }

  function _onUp() { _dragging = -1; }

  // ══════════════════════════════════════════════════════════════════════════
  //  CONFIRM → sauvegarde sur l'équipe
  // ══════════════════════════════════════════════════════════════════════════
  function confirm() {
    const human = _league.teams.find(t => t.isHuman);
    const roles = ['GOALKEEPER', 'DEFENDER', 'ATTACKER', 'ATTACKER'];
    human.formation = {
      positions: _positions.map((p, i) => ({
        role: roles[i],
        x:    Math.round(p.x),
        y:    Math.round(p.y),
      })),
    };
  }

  return { open, confirm };

})();
