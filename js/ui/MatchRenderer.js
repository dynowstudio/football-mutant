/* ═══════════════════════════════════════════
   MatchRenderer — Three.js 3D pipeline
   ═══════════════════════════════════════════ */

const MatchRenderer = (() => {

  // ── Three.js core ──────────────────────────────────────────────────────────
  let _scene, _camera, _renderer;
  let _inited   = false;
  let _animTime = 0;

  // ── Scene objects ──────────────────────────────────────────────────────────
  let _ballGroup;
  let _playerMeshes = {}; // agentId → { group, animPhase, celebTimer, … }
  let _goalFlashLight;
  let _confetti = [];
  let _replay   = null;  // { frames, frameIdx, subTick } — goal slow-mo replay

  // ── Kit clash detection ───────────────────────────────────────────────────
  // If both teams wear similar colors, the away side switches to white kit.
  let _colorConflictChecked = false;
  let _awayKitColor         = null;  // null = use team color; string = override

  // ── Ball visual state (separate from simulation) ──────────────────────────
  // Tracks smoothed 3D position + height physics so motion is fluid
  let _ballVis = { x: 0, z: 0, h: 0.4, vy: 0, prevOwner: null };

  // ── Effects state ──────────────────────────────────────────────────────────
  let _flashTimer = 0;
  let _shakeTimer = 0;
  let _baseCamPos;

  // ── Coord helpers ──────────────────────────────────────────────────────────
  // Map 2D sim coords → 3D world
  function _x(x2d) { return (x2d / PITCH_W) * 68 - 34; }
  function _z(y2d) { return (y2d / PITCH_H) * 44 - 22; }

  // ══════════════════════════════════════════════════════════════════════════
  //  INIT — called once when DOM is ready
  // ══════════════════════════════════════════════════════════════════════════
  function initThreeJS() {
    if (_inited) return;
    _inited = true;

    const canvas = document.getElementById('pitch');

    // Scene
    _scene = new THREE.Scene();
    _scene.background = new THREE.Color(0x060810);
    _scene.fog = new THREE.FogExp2(0x060810, 0.0095);

    // Camera — slightly narrower FOV for cinematic look
    _camera = new THREE.PerspectiveCamera(54, canvas.width / canvas.height, 0.1, 280);
    _camera.position.set(0, 28, 42);
    _camera.lookAt(0, 0, 0);
    _baseCamPos = _camera.position.clone();

    // Renderer
    _renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    _renderer.shadowMap.enabled = true;
    _renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    _renderer.outputEncoding = (THREE.sRGBEncoding !== undefined) ? THREE.sRGBEncoding : 3001;
    _renderer.toneMapping       = THREE.ACESFilmicToneMapping;
    _renderer.toneMappingExposure = 0.72;

    // ── Lighting — night stadium atmosphere ──────────────────────────────────

    // Very dark ambient — just enough to see outlines in shadowed areas
    _scene.add(new THREE.AmbientLight(0x0d1a2e, 0.18));

    // Faint sky bounce — cool blue, barely visible
    _scene.add(new THREE.HemisphereLight(0x1a2d50, 0x0a1a0a, 0.10));

    // ── Stadium mast SpotLights (4 corners, pointing at centre) ──────────────
    const mastPositions = [[-42,-28],[42,-28],[-42,28],[42,28]];
    mastPositions.forEach(([sx, sz], i) => {
      // Spot — warm stadium white
      const spot = new THREE.SpotLight(0xfff5e0, 1.7, 200, Math.PI / 4.8, 0.45, 1.4);
      spot.position.set(sx, 40, sz);
      const tgt = new THREE.Object3D(); tgt.position.set(0, 0, 0); _scene.add(tgt);
      spot.target = tgt;
      // Enable shadows on 2 diagonal spots (front-left & back-right) — good coverage, low cost
      if (i === 0 || i === 3) {
        spot.castShadow = true;
        spot.shadow.mapSize.set(1024, 1024);
        spot.shadow.camera.near = 10;
        spot.shadow.camera.far  = 120;
        spot.shadow.bias = -0.0008;
      } else {
        spot.castShadow = false;
      }
      _scene.add(spot);

      // Glowing bulb at mast tip
      const bulb = new THREE.Mesh(
        new THREE.SphereGeometry(0.22, 7, 7),
        new THREE.MeshBasicMaterial({ color: 0xfff8cc })
      );
      bulb.position.set(sx, 40.3, sz);
      _scene.add(bulb);

      // Subtle halo corona (slightly larger translucent sphere)
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(0.55, 7, 7),
        new THREE.MeshBasicMaterial({ color: 0xfff4a0, transparent: true, opacity: 0.14 })
      );
      halo.position.set(sx, 40.3, sz);
      _scene.add(halo);
    });

    // Goal flash point light (off by default)
    _goalFlashLight = new THREE.PointLight(0xffffff, 0, 120);
    _goalFlashLight.position.set(0, 14, 0);
    _scene.add(_goalFlashLight);

    // ── Build world ───────────────────────────────────────────────────────────
    _buildPitch();
    _buildGoals();
    _buildBall();
    _buildStadium();
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  KIT CLASH — colour-distance helper (normalised RGB, range 0–√3 ≈ 1.73)
  // ══════════════════════════════════════════════════════════════════════════
  function _colorDistance(hex1, hex2) {
    const a = new THREE.Color(hex1);
    const b = new THREE.Color(hex2);
    const dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
    return Math.sqrt(dr * dr + dg * dg + db * db);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  PITCH
  // ══════════════════════════════════════════════════════════════════════════
  function _buildPitch() {
    // Alternating grass stripes — dark night-time turf, lit by stadium lights
    const grassColors = [0x163a20, 0x1c4828];
    const nStripes = 10, stripeW = 68 / nStripes;

    for (let i = 0; i < nStripes; i++) {
      const mat = new THREE.MeshPhongMaterial({
        color:    grassColors[i % 2],
        shininess: 8,
        specular:  new THREE.Color(0.04, 0.09, 0.04),
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(stripeW, 44), mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.x = -34 + stripeW * i + stripeW / 2;
      mesh.receiveShadow = true;
      _scene.add(mesh);
    }

    // Subtle dark vignette plane slightly below grass to darken edges
    const vignetteMat = new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false
    });
    const vigW = 92, vigH = 60;
    // Create a ring-like darkening using a large plane that's slightly below
    // We simulate it by adding darkness just beyond the touch lines
    const vigMesh = new THREE.Mesh(new THREE.PlaneGeometry(vigW, vigH), vignetteMat);
    vigMesh.rotation.x = -Math.PI / 2;
    vigMesh.position.y = -0.015;
    _scene.add(vigMesh);
    // White line inside is brighter than vignette
    const vigClear = new THREE.Mesh(new THREE.PlaneGeometry(68, 44),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, depthWrite: false }));
    vigClear.rotation.x = -Math.PI / 2;
    vigClear.position.y = -0.01;
    _scene.add(vigClear);

    // White lines — use a slightly emissive material so they stand out at night
    const lineMat = new THREE.LineBasicMaterial({ color: 0xffffff });
    const addLine = pts => {
      const geo = new THREE.BufferGeometry().setFromPoints(
        pts.map(([x, z]) => new THREE.Vector3(x, 0.04, z))
      );
      _scene.add(new THREE.Line(geo, lineMat));
    };

    // Boundary
    addLine([[-34,-22],[34,-22],[34,22],[-34,22],[-34,-22]]);
    // Halfway line
    addLine([[0,-22],[0,22]]);
    // Centre circle
    const cc = [];
    for (let a = 0; a <= Math.PI*2+0.01; a += 0.08) cc.push([Math.cos(a)*5.5, Math.sin(a)*5.5]);
    addLine(cc);
    // Centre spot
    const cs = new THREE.Mesh(new THREE.CircleGeometry(0.28, 8),
                              new THREE.MeshBasicMaterial({ color: 0xffffff }));
    cs.rotation.x = -Math.PI/2; cs.position.y = 0.05; _scene.add(cs);

    // Penalty areas (mapped from 2D)
    const lp = [_x(10),_x(100)], rp = [_x(580),_x(670)];
    const gz = [_z(155),_z(285)], sz = [_z(190),_z(250)];

    addLine([[lp[0],gz[0]],[lp[1],gz[0]],[lp[1],gz[1]],[lp[0],gz[1]],[lp[0],gz[0]]]);
    addLine([[rp[1],gz[0]],[rp[0],gz[0]],[rp[0],gz[1]],[rp[1],gz[1]],[rp[1],gz[0]]]);
    addLine([[lp[0],sz[0]],[_x(45),sz[0]],[_x(45),sz[1]],[lp[0],sz[1]],[lp[0],sz[0]]]);
    addLine([[rp[1],sz[0]],[_x(635),sz[0]],[_x(635),sz[1]],[rp[1],sz[1]],[rp[1],sz[0]]]);

    // Penalty spots
    [_x(111), _x(569)].forEach(px => {
      const s = new THREE.Mesh(new THREE.CircleGeometry(0.22, 8),
                               new THREE.MeshBasicMaterial({ color: 0xffffff }));
      s.rotation.x = -Math.PI/2; s.position.set(px, 0.05, 0); _scene.add(s);
    });

    // Corner arcs
    const corners = [[-34,-22],[34,-22],[-34,22],[34,22]];
    corners.forEach(([cx,cz]) => {
      const arc = [];
      // each corner arc sweeps inward 90°
      const startA = (cx < 0 ? 0 : Math.PI) + (cz < 0 ? -Math.PI/2 : Math.PI/2);
      for (let a = startA; a <= startA + Math.PI/2; a += 0.1)
        arc.push([cx + Math.cos(a)*1.5, cz + Math.sin(a)*1.5]);
      if (arc.length > 1) addLine(arc);
    });

    // Touch-line surround
    const borderMat = new THREE.MeshPhongMaterial({ color: 0x0d1e0d, shininess: 4 });
    const borderW = 4, borderH = 44 + borderW*2;
    [[-34-borderW/2,0,0],[34+borderW/2,0,0]].forEach(([x,,z]) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(borderW, borderH), borderMat);
      m.rotation.x = -Math.PI/2; m.position.set(x, -0.01, z); _scene.add(m);
    });
    [[-34-borderW,0,-22-borderW/2],[34+borderW,0,-22-borderW/2],
     [-34-borderW,0, 22+borderW/2],[34+borderW,0, 22+borderW/2]].forEach(() => {});
    const topBot = new THREE.Mesh(new THREE.PlaneGeometry(68+borderW*2, borderW), borderMat);
    topBot.rotation.x = -Math.PI/2;
    [-22-borderW/2, 22+borderW/2].forEach(z => {
      const m = topBot.clone(); m.position.set(0, -0.01, z); _scene.add(m);
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  GOALS
  // ══════════════════════════════════════════════════════════════════════════
  function _buildGoals() {
    _buildOneGoal(_x(0),      -1);  // left goal  — net extends outward (negative x)
    _buildOneGoal(_x(PITCH_W), 1);  // right goal — net extends outward (positive x)
  }

  function _buildOneGoal(xPos, netDir) {
    // Shiny white posts — MeshPhongMaterial for specular highlights
    const postMat = new THREE.MeshPhongMaterial({
      color: 0xf8f8f8, shininess: 110, specular: new THREE.Color(0.7, 0.7, 0.7)
    });
    const postR   = 0.13;
    const gzTop   = _z(GOAL_Y1);  // -4
    const gzBot   = _z(GOAL_Y2);  //  4
    const gH      = 2.9;

    // Left post
    const lPost = new THREE.Mesh(new THREE.CylinderGeometry(postR, postR, gH, 8), postMat);
    lPost.position.set(xPos, gH/2, gzTop); lPost.castShadow = true; _scene.add(lPost);

    // Right post
    const rPost = lPost.clone();
    rPost.position.set(xPos, gH/2, gzBot); _scene.add(rPost);

    // Crossbar
    const barLen = gzBot - gzTop + postR*2;
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(postR, postR, barLen, 8), postMat);
    bar.rotation.x = Math.PI/2;
    bar.position.set(xPos, gH, (gzTop+gzBot)/2);
    bar.castShadow = true; _scene.add(bar);

    // Back post (depth)
    const backX = xPos + netDir * 2.2;
    const bkPost1 = new THREE.Mesh(new THREE.CylinderGeometry(postR*0.7, postR*0.7, gH, 6), postMat);
    bkPost1.position.set(backX, gH/2, gzTop); _scene.add(bkPost1);
    const bkPost2 = bkPost1.clone(); bkPost2.position.set(backX, gH/2, gzBot); _scene.add(bkPost2);

    // Subtle ambient glow inside the goal
    const goalGlow = new THREE.PointLight(0x8899ee, 0.18, 8, 2);
    goalGlow.position.set(xPos + netDir * 1.2, 1.4, (GOAL_Y1 > 0 ? (_z(GOAL_Y1) + _z(GOAL_Y2)) / 2 : 0));
    _scene.add(goalGlow);

    // Net — semi-transparent planes
    const netMat = new THREE.MeshBasicMaterial({
      color: 0xddeeff, transparent: true, opacity: 0.15, side: THREE.DoubleSide
    });
    const netDepth = 2.2;
    // Back net
    const backNet = new THREE.Mesh(new THREE.PlaneGeometry(netDepth, gH), netMat);
    backNet.rotation.y = Math.PI/2;
    backNet.position.set(xPos + netDir*(netDepth/2), gH/2, (gzTop+gzBot)/2);
    _scene.add(backNet);
    // Side nets
    [gzTop, gzBot].forEach(z => {
      const sn = new THREE.Mesh(new THREE.PlaneGeometry(netDepth, gH), netMat);
      sn.position.set(xPos + netDir*(netDepth/2), gH/2, z);
      _scene.add(sn);
    });
    // Top net
    const topNet = new THREE.Mesh(new THREE.PlaneGeometry(netDepth, barLen), netMat);
    topNet.rotation.x = Math.PI/2;
    topNet.rotation.y = Math.PI/2;
    topNet.position.set(xPos + netDir*(netDepth/2), gH, (gzTop+gzBot)/2);
    _scene.add(topNet);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  BALL
  // ══════════════════════════════════════════════════════════════════════════
  function _buildBall() {
    _ballGroup = new THREE.Group();

    // White sphere — more segments + specular shine
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.4, 18, 18),
      new THREE.MeshPhongMaterial({
        color: 0xfefefe, shininess: 70,
        specular: new THREE.Color(0.65, 0.65, 0.65),
      })
    );
    sphere.castShadow = true;
    _ballGroup.add(sphere);
    _ballGroup.userData.sphere = sphere;

    // Classic black pentagonal patches — subtle shine
    const patchMat = new THREE.MeshPhongMaterial({
      color: 0x111111, shininess: 35, specular: 0x333333
    });
    const patchOffsets = [
      [0,1,0],[0,-1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],
      [0.7,0.7,0],[0.7,-0.7,0],[-0.7,0.7,0],[-0.7,-0.7,0],
      [0,0.7,0.7],[0,0.7,-0.7],[0,-0.7,0.7],[0,-0.7,-0.7],
    ];
    patchOffsets.forEach(([px,py,pz]) => {
      const len = Math.sqrt(px*px+py*py+pz*pz);
      const p = new THREE.Mesh(new THREE.CircleGeometry(0.12, 5), patchMat);
      p.position.set(px/len*0.38, py/len*0.38, pz/len*0.38);
      p.lookAt(px*2, py*2, pz*2);
      _ballGroup.add(p);
    });

    // Ground shadow (moves with ball height)
    const gShadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.45, 12),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45 })
    );
    gShadow.rotation.x = -Math.PI/2;
    gShadow.position.y = 0.02;
    _ballGroup.add(gShadow);
    _ballGroup.userData.groundShadow = gShadow;

    // Dynamic glow light — intensity ∝ ball speed (lights up the pitch when shot hard)
    const ballGlow = new THREE.PointLight(0xfffde0, 0, 12, 2.2);
    ballGlow.position.set(0, 0.5, 0);
    _ballGroup.add(ballGlow);
    _ballGroup.userData.ballGlow = ballGlow;

    _scene.add(_ballGroup);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  NAME LABEL (Sprite + canvas texture)
  // ══════════════════════════════════════════════════════════════════════════
  // scaleCompX / scaleCompY: inverse of parent group scale so label appears world-constant size
  function _makeNameLabel(name, teamColor, scaleCompX, scaleCompY) {
    scaleCompX = scaleCompX || 1;
    scaleCompY = scaleCompY || 1;
    // Last name only (last word of the full name)
    const label = name ? name.split(' ').pop().toUpperCase() : '';

    const FONT_SIZE = 52;
    const PAD_X = 14, PAD_Y = 7;

    // Measure text first to size the canvas tightly
    const tmpCv = document.createElement('canvas');
    const tmpC  = tmpCv.getContext('2d');
    tmpC.font = `bold ${FONT_SIZE}px Arial, sans-serif`;
    const textW = tmpC.measureText(label).width;

    const W = Math.ceil(textW + PAD_X * 2);
    const H = FONT_SIZE + PAD_Y * 2;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d');

    // Tight rounded-rect pill
    const r = 5;
    c.fillStyle = 'rgba(0,0,0,0.72)';
    c.beginPath();
    c.moveTo(r, 0); c.lineTo(W - r, 0);
    c.arcTo(W, 0, W, r, r);
    c.lineTo(W, H - r);
    c.arcTo(W, H, W - r, H, r);
    c.lineTo(r, H);
    c.arcTo(0, H, 0, H - r, r);
    c.lineTo(0, r);
    c.arcTo(0, 0, r, 0, r);
    c.closePath();
    c.fill();

    // Team-colour bottom accent bar
    const col = new THREE.Color(teamColor);
    c.strokeStyle = `rgb(${Math.round(col.r*255)},${Math.round(col.g*255)},${Math.round(col.b*255)})`;
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(r + 2, H - 1.5); c.lineTo(W - r - 2, H - 1.5);
    c.stroke();

    // Last name — fills almost the full pill height
    c.font = `bold ${FONT_SIZE}px Arial, sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.shadowColor = 'rgba(0,0,0,0.95)';
    c.shadowBlur  = 4;
    c.fillStyle = '#ffffff';
    c.fillText(label, W / 2, H / 2 - 1);

    const tex = new THREE.CanvasTexture(cv);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    // Scale sprite so world height = ~0.75 units regardless of canvas H
    const worldH = 1.30;
    // Compensate group scale so label is always the same world-space size
    sprite.scale.set(worldH * (W / H) / scaleCompX, worldH / scaleCompY, 1);
    sprite.position.y = 3.80 / scaleCompY; // stays above head regardless of player height
    return sprite;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  PLAYER MESH FACTORY
  // ══════════════════════════════════════════════════════════════════════════
  // bodyType: 'slim' (speed-dominant) | 'stocky' (power-dominant) | 'normal'
  function _createPlayerMesh(teamColor, role, name, bodyType) {
    const col      = new THREE.Color(teamColor);
    // MeshPhongMaterial everywhere → specular highlights bring the scene to life
    const shirtMat  = new THREE.MeshPhongMaterial({
      color: col, shininess: 42,
      specular: new THREE.Color(col).multiplyScalar(0.35),
    });
    const skinMat   = new THREE.MeshPhongMaterial({
      color: 0xd4a472, shininess: 14, specular: 0x221100,
    });
    const shortsMat = new THREE.MeshPhongMaterial({
      color: 0x14172a, shininess: 22, specular: 0x222244,
    });
    const sockMat   = new THREE.MeshPhongMaterial({
      color: 0xdde0e8, shininess: 20, specular: 0x888888,
    });
    const bootMat   = new THREE.MeshPhongMaterial({
      color: 0x0d0d0d, shininess: 95, specular: new THREE.Color(0.45, 0.45, 0.45),
    });

    const g = new THREE.Group();

    // ── Body-type scale ───────────────────────────────────────────────────────
    // slim  (speed dominant) : short & thin   → fast, agile silhouette
    // stocky (power dominant): wide & tall    → imposing, brawny silhouette
    const bsXZ = bodyType === 'slim' ? 0.78 : bodyType === 'stocky' ? 1.26 : 1.0;
    const bsY  = bodyType === 'slim' ? 0.88 : bodyType === 'stocky' ? 1.12 : 1.0;
    g.scale.set(bsXZ, bsY, bsXZ);
    g.userData.baseScaleXZ = bsXZ;
    g.userData.baseScaleY  = bsY;

    // ── Torso ────────────────────────────────────────────────────────────────
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.88, 0.40), shirtMat);
    torso.position.y = 1.58; torso.castShadow = true; g.add(torso);

    // ── Head ─────────────────────────────────────────────────────────────────
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.29, 10, 10), skinMat);
    head.position.y = 2.24; head.castShadow = true; g.add(head);

    // Goalkeeper: gold headband
    if (role === 'GOALKEEPER') {
      const hb = new THREE.Mesh(new THREE.TorusGeometry(0.30, 0.055, 6, 12),
                                new THREE.MeshLambertMaterial({ color: 0xFFD700 }));
      hb.rotation.x = Math.PI/2; hb.position.y = 2.28; g.add(hb);
    }

    // ── Arms (pivot at shoulder) ──────────────────────────────────────────────
    const makeArm = (side) => {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.52, 1.95, 0);
      const upper = new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.50, 0.21), shirtMat);
      upper.position.y = -0.25; upper.castShadow = true;
      const lower = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.40, 0.18), skinMat);
      lower.position.y = -0.70; lower.castShadow = true;
      pivot.add(upper, lower);
      return pivot;
    };
    const lArmPivot = makeArm(-1), rArmPivot = makeArm(1);
    g.add(lArmPivot, rArmPivot);

    // ── Legs (pivot at hip, knee sub-pivot) ───────────────────────────────────
    const makeLeg = (side) => {
      const hip = new THREE.Group();
      hip.position.set(side * 0.21, 1.00, 0);

      const thigh = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.52, 0.26), shortsMat);
      thigh.position.y = -0.26; thigh.castShadow = true;

      const knee = new THREE.Group();
      knee.position.y = -0.52;

      const calf = new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.48, 0.21), sockMat);
      calf.position.y = -0.24; calf.castShadow = true;

      const boot = new THREE.Mesh(new THREE.BoxGeometry(0.23, 0.14, 0.40), bootMat);
      boot.position.set(0, -0.54, 0.08); boot.castShadow = true;

      knee.add(calf, boot);
      hip.add(thigh, knee);
      hip.userData.knee = knee;
      return hip;
    };
    const lLegPivot = makeLeg(-1), rLegPivot = makeLeg(1);
    g.add(lLegPivot, rLegPivot);

    // ── Ground shadow disk ────────────────────────────────────────────────────
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.60, 10),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.20 })
    );
    shadow.rotation.x = -Math.PI/2; shadow.position.y = 0.02; g.add(shadow);

    // ── Name label (sprite, always faces camera) ─────────────────────────────
    if (name) {
      const label = _makeNameLabel(name, teamColor, bsXZ, bsY);
      g.add(label);
    }

    // Store animation refs
    g.userData = { lArmPivot, rArmPivot, lLegPivot, rLegPivot, torso, head };
    return g;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  STADIUM — stands, crowd, mast poles
  // ══════════════════════════════════════════════════════════════════════════
  function _buildStadium() {
    // ── Concrete stand backing ───────────────────────────────────────────────
    const concreteMat = new THREE.MeshPhongMaterial({
      color: 0x0c1018, shininess: 6, specular: 0x111111,
    });
    [
      [0,   -(22 + 8.5), 82, 14, 4.2],   // north
      [0,    (22 + 8.5), 82, 14, 4.2],   // south
      [-(34 + 8.5), 0,   14, 48, 4.2],   // west
      [ (34 + 8.5), 0,   14, 48, 4.2],   // east
    ].forEach(([x, z, w, d, h]) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), concreteMat);
      m.position.set(x, h / 2 - 0.6, z);
      m.receiveShadow = true;
      _scene.add(m);
    });

    // ── Crowd (InstancedMesh grouped by colour for performance) ──────────────
    const SEAT_COLS = [
      0x2563eb, 0x16a34a, 0xdc2626, 0xd97706,
      0x7c3aed, 0xdb2777, 0x0891b2, 0xfbbf24,
      0xffffff, 0x64748b,
    ];
    const crowdGeo = new THREE.BoxGeometry(0.52, 0.68, 0.40);
    // Accumulate positions per colour
    const byColor = SEAT_COLS.map(() => []);
    const rng = () => Math.random();

    const addBlock = (x, y, z) => {
      const ci = Math.floor(rng() * SEAT_COLS.length);
      byColor[ci].push(x + (rng()-0.5)*0.18, y + rng()*0.22, z + (rng()-0.5)*0.18);
    };

    // North stand (rows away from pitch in -Z direction)
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 44; col++) {
        addBlock(-32.5 + col * 1.50, 0.34 + row * 0.60, -(22 + 3.2 + row * 1.25));
      }
    }
    // South stand
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 44; col++) {
        addBlock(-32.5 + col * 1.50, 0.34 + row * 0.60, (22 + 3.2 + row * 1.25));
      }
    }
    // West stand
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 22; col++) {
        addBlock(-(34 + 3.2 + row * 1.25), 0.34 + row * 0.60, -15.5 + col * 1.46);
      }
    }
    // East stand
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 22; col++) {
        addBlock((34 + 3.2 + row * 1.25), 0.34 + row * 0.60, -15.5 + col * 1.46);
      }
    }

    // Build one InstancedMesh per colour
    const dummy = new THREE.Object3D();
    byColor.forEach((positions, ci) => {
      if (positions.length === 0) return;
      const count = positions.length / 3;
      const mat = new THREE.MeshPhongMaterial({
        color:    SEAT_COLS[ci],
        shininess: 14,
        specular:  0x222222,
      });
      const iMesh = new THREE.InstancedMesh(crowdGeo, mat, count);
      iMesh.castShadow = false;
      for (let i = 0; i < count; i++) {
        dummy.position.set(positions[i*3], positions[i*3+1], positions[i*3+2]);
        dummy.rotation.y = (rng() - 0.5) * 0.55;
        dummy.scale.setScalar(0.88 + rng() * 0.24);
        dummy.updateMatrix();
        iMesh.setMatrixAt(i, dummy.matrix);
      }
      iMesh.instanceMatrix.needsUpdate = true;
      _scene.add(iMesh);
    });

    // ── Light mast poles ─────────────────────────────────────────────────────
    const mastMat = new THREE.MeshPhongMaterial({
      color: 0x445566, shininess: 30, specular: 0x334455
    });
    [[-42,-28],[42,-28],[-42,28],[42,28]].forEach(([x, z]) => {
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.22, 0.32, 42, 8),
        mastMat
      );
      pole.position.set(x, 21, z);
      pole.castShadow = true;
      _scene.add(pole);
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  UPDATE: BALL  (smooth lerp + real gravity/bounce)
  // ══════════════════════════════════════════════════════════════════════════
  function _updateBall(ball) {
    const tx    = _x(ball.x);
    const tz    = _z(ball.y);
    const spd2d = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);

    // ── XZ position — adaptive lerp ─────────────────────────────────────────
    // Closes gap faster when ball is far ahead (just got kicked),
    // gentler when already close to avoid micro-jitter on slow rolls.
    const dx   = tx - _ballVis.x;
    const dz   = tz - _ballVis.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const alpha = Math.min(0.88, 0.38 + dist * 0.14);
    _ballVis.x += dx * alpha;
    _ballVis.z += dz * alpha;

    // ── Height — gravity + bounce physics ────────────────────────────────────
    const isOwned  = ball.owner !== null;
    const wasOwned = _ballVis.prevOwner !== null;

    // Kick detected: player just released ball with speed
    if (wasOwned && !isOwned && spd2d > 2.5) {
      // Convert 2D speed to 3D scale, clamp arc height
      const spd3d = spd2d * (68 / PITCH_W);
      _ballVis.vy = Math.min(0.22 + spd3d * 0.42, 2.0);
    }

    if (isOwned) {
      // Ball held by player — smoothly pin to ground level
      _ballVis.h  = 0.4 + (_ballVis.h  - 0.4) * 0.82;
      _ballVis.vy = _ballVis.vy * 0.78;
    } else {
      // Free ball — apply gravity each visual frame
      _ballVis.vy -= 0.058;
      _ballVis.h  += _ballVis.vy;

      // Bounce off the grass
      if (_ballVis.h < 0.4) {
        _ballVis.h = 0.4;
        const energy = Math.abs(_ballVis.vy);
        // Only keep bouncing if there is meaningful energy
        _ballVis.vy = energy > 0.10 ? energy * 0.50 : 0;
      }

      // Safety ceiling — ball should never float above the crossbar
      if (_ballVis.h > 5.0) {
        _ballVis.h  = 5.0;
        _ballVis.vy = Math.min(_ballVis.vy, 0);
      }
    }

    _ballVis.prevOwner = ball.owner;

    // ── Apply to mesh ─────────────────────────────────────────────────────────
    _ballGroup.position.set(_ballVis.x, _ballVis.h, _ballVis.z);

    // Rolling rotation (proportional to 2D velocity)
    _ballGroup.userData.sphere.rotation.z -= ball.vx * 0.018;
    _ballGroup.userData.sphere.rotation.x += ball.vy * 0.018;

    // Ground shadow: shrinks and fades as ball rises
    const gs   = _ballGroup.userData.groundShadow;
    const relH = _ballVis.h - 0.4;
    gs.position.y = 0.02 - _ballVis.h;
    gs.scale.setScalar(Math.max(0.22, 1.0 - relH * 0.17));

    // Dynamic ball glow: lights up the pitch when the ball is moving fast
    const glow = _ballGroup.userData.ballGlow;
    if (glow) {
      const targetIntensity = ball.owner ? 0 : Math.min(spd2d * 0.075, 1.1);
      glow.intensity += (targetIntensity - glow.intensity) * 0.14;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  UPDATE: PLAYERS  (state-machine animations)
  // ══════════════════════════════════════════════════════════════════════════
  function _updatePlayers(ms) {
    // ── Kit-clash check — runs once per match on first call ──────────────────
    if (!_colorConflictChecked && ms.homeTeam && ms.awayTeam) {
      _colorConflictChecked = true;
      const dist = _colorDistance(ms.homeTeam.color, ms.awayTeam.color);
      // Threshold: 0.42 on normalised RGB catches similar hues (e.g. two blues)
      _awayKitColor = dist < 0.42 ? '#f0f0f0' : null;
    }

    ms.agents.forEach((agent, idx) => {
      const key = agent.id || idx;

      // ── Lazy-create mesh ──────────────────────────────────────────────────
      if (!_playerMeshes[key]) {
        const team     = agent.displayTeamIndex === 0 ? ms.homeTeam : ms.awayTeam;
        const isAway   = agent.displayTeamIndex === 1;
        const kitColor = (isAway && _awayKitColor) ? _awayKitColor : team.color;

        // Body-type: speed-dominant → slim; power-dominant → stocky
        const sp = agent.speed        || 0;
        const pa = agent.passAccuracy || 0;
        const sa = agent.shotAccuracy || 0;
        const pw = agent.power        || 0;
        const mx = Math.max(sp, pa, sa, pw);
        const bodyType = (sp >= mx && sp > pw) ? 'slim'
                       : (pw >= mx && pw > sp) ? 'stocky'
                       : 'normal';

        const mesh = _createPlayerMesh(kitColor, agent.role, agent.name, bodyType);
        _scene.add(mesh);
        _playerMeshes[key] = {
          key,                 // stored for replay lookup
          group:               mesh,
          animPhase:           Math.random() * Math.PI * 2,
          celebTimer:          0,
          kickTimer:           0,   kickLeg: 1,
          gkDiveTimer:         0,   gkDiveDir: 0,
          gkAlertLevel:        0,
          prevHasBall:         false,
          knockdownSide:       1,   // which way to fall
          prevKnockdownTimer:  0,
        };
      }

      const info = _playerMeshes[key];
      const grp  = info.group;
      const ud   = grp.userData;

      // ── Position lerp ─────────────────────────────────────────────────────
      const tx = _x(agent.x), tz = _z(agent.y);
      grp.position.x += (tx - grp.position.x) * 0.24;
      grp.position.z += (tz - grp.position.z) * 0.24;

      // ── Facing direction ──────────────────────────────────────────────────
      const vx = agent.vx || 0, vy = agent.vy || 0;
      const spd = Math.sqrt(vx * vx + vy * vy);
      if (spd > 0.25) {
        const tAngle = Math.atan2(_x(agent.x + vx) - _x(agent.x),
                                  _z(agent.y + vy) - _z(agent.y));
        const da = tAngle - grp.rotation.y;
        grp.rotation.y += Math.atan2(Math.sin(da), Math.cos(da)) * 0.20;
      }

      // ── Kick detection ────────────────────────────────────────────────────
      if (info.prevHasBall && !agent.hasBall && info.kickTimer === 0 && agent.knockdownTimer === 0) {
        info.kickTimer = 28;
        info.kickLeg   = Math.random() > 0.5 ? 1 : -1;
      }
      info.prevHasBall = !!agent.hasBall;

      // ── Knockdown side (pick direction at moment of impact) ──────────────
      if (agent.knockdownTimer > 0 && info.prevKnockdownTimer === 0) {
        info.knockdownSide = Math.random() > 0.5 ? 1 : -1;
      }
      info.prevKnockdownTimer = agent.knockdownTimer;

      // ── GK alert + dive detection ─────────────────────────────────────────
      const isGK = agent.role === 'GOALKEEPER';
      if (isGK && info.gkDiveTimer <= 0) {
        const myGoalX      = agent.displayTeamIndex === 0 ? -34 : 34;
        const approachDist = Math.abs(_ballVis.x - myGoalX);
        const targetAlert  = approachDist < 22
          ? Math.min(1, (22 - approachDist) / 14) : 0;
        info.gkAlertLevel += (targetAlert - info.gkAlertLevel) * 0.07;

        const ballVx3d  = ms.ball.vx * (68 / PITCH_W);
        const headingIn = myGoalX < 0 ? ballVx3d < -0.25 : ballVx3d > 0.25;
        const dZ        = _ballVis.z - grp.position.z;
        if (approachDist < 11 && headingIn && Math.abs(dZ) > 1.2) {
          info.gkDiveTimer = 42;
          info.gkDiveDir   = dZ > 0 ? 1 : -1;
        }
      }

      // ── Ball possession scale pulse (preserves body-type base scale) ────────
      const baseXZ = grp.userData.baseScaleXZ || 1.0;
      const ts = agent.hasBall ? 1.07 : 1.0;
      grp.scale.x += (ts * baseXZ - grp.scale.x) * 0.12;
      grp.scale.z += (ts * baseXZ - grp.scale.z) * 0.12;
      grp.scale.y  = grp.userData.baseScaleY  || 1.0;

      // ── Animation state machine  (priority: celebrate > knockdown > dive > punch > kick > alert > run) ──
      const run   = Math.min(spd * 0.45, 1.0);
      const freq  = 5 + run * 9;
      const phase = _animTime * freq + info.animPhase;

      if (info.celebTimer > 0) {
        info.celebTimer--;
        _animCelebrate(grp, ud, info.celebTimer, phase);

      } else if (agent.knockdownTimer > 0) {
        _animKnockdown(grp, ud, agent.knockdownTimer, info.knockdownSide);

      } else if (info.gkDiveTimer > 0) {
        info.gkDiveTimer--;
        _animGKDive(grp, ud, info.gkDiveDir, info.gkDiveTimer);

      } else if (agent.punchTimer > 0) {
        _animPunch(grp, ud, agent.punchTimer, agent.punchArm);
        grp.rotation.z += (0 - grp.rotation.z) * 0.14;

      } else if (info.kickTimer > 0) {
        info.kickTimer--;
        _animKick(grp, ud, info.kickTimer, info.kickLeg);
        grp.rotation.z += (0 - grp.rotation.z) * 0.14;

      } else if (isGK && info.gkAlertLevel > 0.10) {
        _animGKAlert(grp, ud, info.gkAlertLevel, run, phase);
        grp.rotation.z += (0 - grp.rotation.z) * 0.14;

      } else {
        _animRunIdle(grp, ud, run, phase, info.animPhase);
        grp.rotation.z += (0 - grp.rotation.z) * 0.14;
      }
    });
  }

  // ── Animation helpers ──────────────────────────────────────────────────────

  // Running + idle breathing
  function _animRunIdle(grp, ud, run, phase, animPhase) {
    if (!ud.lLegPivot) return;
    const legAmp  = run * 0.95;
    const armAmp  = run * 0.60;
    const kneeBnd = legAmp * 0.70;
    const breathe = (1 - run) * Math.sin(_animTime * 1.8 + animPhase) * 0.05;

    ud.lLegPivot.rotation.x =  Math.sin(phase) * legAmp;
    ud.rLegPivot.rotation.x = -Math.sin(phase) * legAmp;
    ud.lArmPivot.rotation.x = -Math.sin(phase) * armAmp;
    ud.rArmPivot.rotation.x =  Math.sin(phase) * armAmp;
    // Arms rest slightly spread when idle
    ud.lArmPivot.rotation.z =  (1 - run) * 0.22 + breathe;
    ud.rArmPivot.rotation.z = -(1 - run) * 0.22 - breathe;
    ud.lLegPivot.userData.knee.rotation.x = Math.max(0, -Math.sin(phase)) * kneeBnd;
    ud.rLegPivot.userData.knee.rotation.x = Math.max(0,  Math.sin(phase)) * kneeBnd;

    grp.position.y = Math.abs(Math.sin(phase * 2)) * run * 0.07;
    if (ud.torso) {
      ud.torso.rotation.x = -run * 0.13 + breathe;
      ud.head.rotation.x  = -run * 0.07;
    }
  }

  // Kick / pass / shot animation  (28-frame state)
  function _animKick(grp, ud, timer, leg) {
    if (!ud.lLegPivot) return;
    const t  = 1 - timer / 28;   // 0 = start, 1 = end
    const kL = leg > 0 ? ud.rLegPivot : ud.lLegPivot;
    const oL = leg > 0 ? ud.lLegPivot : ud.rLegPivot;
    const kA = leg > 0 ? ud.lArmPivot : ud.rArmPivot;   // opposite arm balances
    const oA = leg > 0 ? ud.rArmPivot : ud.lArmPivot;

    if (t < 0.35) {
      // Wind-up: leg swings back, knee bent
      const p = t / 0.35;
      kL.rotation.x = -0.80 * p;
      kL.userData.knee.rotation.x = 1.10 * p;
      oL.rotation.x = 0.20 * p;
      oL.userData.knee.rotation.x = 0;
      kA.rotation.x =  0.60 * p;  oA.rotation.x = -0.30 * p;
      kA.rotation.z = 0;           oA.rotation.z = 0;
      if (ud.torso) ud.torso.rotation.x = 0.12 * p;
    } else if (t < 0.68) {
      // Strike: leg snaps forward
      const p = (t - 0.35) / 0.33;
      kL.rotation.x = -0.80 + 2.00 * p;
      kL.userData.knee.rotation.x = Math.max(0, 1.10 - p * 2.80);
      oL.rotation.x = 0.20 - 0.45 * p;
      oL.userData.knee.rotation.x = 0.30 * p;
      kA.rotation.x =  0.60 - 1.10 * p;  oA.rotation.x = -0.30 + 0.60 * p;
      if (ud.torso) ud.torso.rotation.x = 0.12 - 0.30 * p;
    } else {
      // Recovery: smooth back to neutral
      const p = (t - 0.68) / 0.32;
      const e = p * p;
      kL.rotation.x = 1.20 * (1 - e);
      kL.userData.knee.rotation.x = 0.30 * (1 - e);
      oL.rotation.x = -0.25 * (1 - e);
      oL.userData.knee.rotation.x = 0;
      kA.rotation.x = -0.50 * (1 - e);  oA.rotation.x = 0.30 * (1 - e);
      kA.rotation.z = 0;                 oA.rotation.z = 0;
      if (ud.torso) ud.torso.rotation.x = -0.18 * (1 - e);
    }
    // Small hop at contact
    grp.position.y = Math.sin(Math.PI * Math.min(t / 0.60, 1)) * 0.09;
  }

  // GK ready / alert crouch
  function _animGKAlert(grp, ud, alertLevel, run, phase) {
    if (!ud.lLegPivot) return;
    const c = alertLevel;
    // Wide crouch — low centre of gravity, arms spread to block
    ud.lLegPivot.rotation.x = 0.42 * c + Math.sin(phase) * run * 0.22;
    ud.rLegPivot.rotation.x = 0.42 * c - Math.sin(phase) * run * 0.22;
    ud.lLegPivot.userData.knee.rotation.x = 0.56 * c;
    ud.rLegPivot.userData.knee.rotation.x = 0.56 * c;
    ud.lArmPivot.rotation.x = -0.48 * c;
    ud.rArmPivot.rotation.x = -0.48 * c;
    ud.lArmPivot.rotation.z =  0.68 * c;
    ud.rArmPivot.rotation.z = -0.68 * c;
    if (ud.torso) {
      ud.torso.rotation.x = 0.24 * c;
      ud.head.rotation.x  = -0.14 * c;
    }
    grp.position.y = -0.09 * c;  // body lowers
  }

  // GK full dive  (42-frame state)
  function _animGKDive(grp, ud, dir, timer) {
    if (!ud.lLegPivot) return;
    const t  = 1 - timer / 42;   // 0 = start, 1 = end
    const dA = dir > 0 ? ud.rArmPivot : ud.lArmPivot;  // dive-side arm leads
    const oA = dir > 0 ? ud.lArmPivot : ud.rArmPivot;

    if (t < 0.38) {
      const p = t / 0.38;
      grp.rotation.z = dir * (-1.15) * p;
      grp.position.y = Math.sin(p * Math.PI) * 0.55;
      dA.rotation.x = -1.90 * p;   dA.rotation.z = dir * (-0.72) * p;
      oA.rotation.x = -0.85 * p;   oA.rotation.z = dir *   0.32  * p;
      ud.lLegPivot.rotation.x = 0.32 * p;
      ud.rLegPivot.rotation.x = 0.32 * p;
      ud.lLegPivot.userData.knee.rotation.x = 0.48 * p;
      ud.rLegPivot.userData.knee.rotation.x = 0.48 * p;
    } else if (t < 0.72) {
      // Fully extended
      grp.rotation.z = dir * (-1.15);
      grp.position.y = 0;
      dA.rotation.x = -1.90;   dA.rotation.z = dir * (-0.72);
      oA.rotation.x = -0.85;   oA.rotation.z = dir *   0.32;
      ud.lLegPivot.rotation.x = 0.32;
      ud.rLegPivot.rotation.x = 0.32;
      ud.lLegPivot.userData.knee.rotation.x = 0.48;
      ud.rLegPivot.userData.knee.rotation.x = 0.48;
    } else {
      // Get back up
      const p = (t - 0.72) / 0.28;
      const e = p * p;
      grp.rotation.z = dir * (-1.15) * (1 - e);
      grp.position.y = 0;
      dA.rotation.x = -1.90 * (1 - e);   dA.rotation.z = dir * (-0.72) * (1 - e);
      oA.rotation.x = -0.85 * (1 - e);   oA.rotation.z = dir *   0.32  * (1 - e);
      ud.lLegPivot.rotation.x = 0.32 * (1 - e);
      ud.rLegPivot.rotation.x = 0.32 * (1 - e);
      ud.lLegPivot.userData.knee.rotation.x = 0.48 * (1 - e);
      ud.rLegPivot.userData.knee.rotation.x = 0.48 * (1 - e);
    }
  }

  // Punch / haymaker animation  (22-frame)
  function _animPunch(grp, ud, timer, arm) {
    if (!ud.lArmPivot) return;
    const t  = 1 - timer / 22;
    const pA = arm > 0 ? ud.rArmPivot : ud.lArmPivot;  // punching arm
    const oA = arm > 0 ? ud.lArmPivot : ud.rArmPivot;  // other arm (balance)

    if (t < 0.45) {
      const p = t / 0.45;
      pA.rotation.x = -(Math.PI / 2) * p;   // arm swings forward-up fast
      pA.rotation.z =  arm * (-0.28) * p;
      oA.rotation.x =  0.40 * p;
      oA.rotation.z =  arm *   0.18  * p;
      if (ud.torso) ud.torso.rotation.z = arm * 0.18 * p;
    } else {
      const p = (t - 0.45) / 0.55;
      const e = 1 - (1 - p) * (1 - p);
      pA.rotation.x = -(Math.PI / 2) * (1 - e);
      pA.rotation.z =  arm * (-0.28) * (1 - e);
      oA.rotation.x =  0.40 * (1 - e);
      oA.rotation.z =  arm *   0.18  * (1 - e);
      if (ud.torso) ud.torso.rotation.z = arm * 0.18 * (1 - e);
    }
  }

  // Knockdown animation  (80-frame)
  function _animKnockdown(grp, ud, timer, side) {
    if (!ud.lLegPivot) return;
    const t = 1 - timer / 80;   // 0 = moment of impact, 1 = back on feet

    if (t < 0.18) {
      // Stagger — body rocks
      const p = t / 0.18;
      grp.rotation.z  = side * Math.sin(p * Math.PI * 2.5) * 0.38;
      grp.position.y  = 0;
      ud.lArmPivot.rotation.x = -0.5 * p;
      ud.rArmPivot.rotation.x = -0.5 * p;
      ud.lArmPivot.rotation.z =  0.4 * p;
      ud.rArmPivot.rotation.z = -0.4 * p;
    } else if (t < 0.45) {
      // Fall sideways
      const p = (t - 0.18) / 0.27;
      grp.rotation.z  = side * p * (Math.PI / 2);
      grp.position.y  = Math.sin(p * Math.PI) * 0.25;
      ud.lLegPivot.rotation.x = 0.30 * p;
      ud.rLegPivot.rotation.x = 0.30 * p;
      ud.lArmPivot.rotation.x = -0.80 * p;
      ud.rArmPivot.rotation.x = -0.80 * p;
      ud.lArmPivot.rotation.z =  0.5;
      ud.rArmPivot.rotation.z = -0.5;
      if (ud.torso) ud.torso.rotation.x = 0.20 * p;
    } else if (t < 0.72) {
      // Lying on ground
      grp.rotation.z  = side * (Math.PI / 2);
      grp.position.y  = 0;
      ud.lLegPivot.rotation.x = 0.30;
      ud.rLegPivot.rotation.x = 0.30;
      ud.lArmPivot.rotation.x = -0.80;
      ud.rArmPivot.rotation.x = -0.80;
      if (ud.torso) ud.torso.rotation.x = 0.20;
    } else {
      // Get back up
      const p = (t - 0.72) / 0.28;
      const e = p * p;
      grp.rotation.z  = side * (Math.PI / 2) * (1 - e);
      grp.position.y  = Math.sin(p * Math.PI) * 0.18;
      ud.lLegPivot.rotation.x = 0.30 * (1 - e);
      ud.rLegPivot.rotation.x = 0.30 * (1 - e);
      ud.lArmPivot.rotation.x = -0.80 * (1 - e);
      ud.rArmPivot.rotation.x = -0.80 * (1 - e);
      ud.lArmPivot.rotation.z =  0.5  * (1 - e);
      ud.rArmPivot.rotation.z = -0.5  * (1 - e);
      if (ud.torso) ud.torso.rotation.x = 0.20 * (1 - e);
    }
  }

  // Goal celebration
  function _animCelebrate(grp, ud, timer, phase) {
    if (!ud.lArmPivot) return;
    grp.position.y = Math.abs(Math.sin(timer * 0.18)) * 1.2;
    grp.rotation.z += (0 - grp.rotation.z) * 0.15;
    // Arms raised high, waving wildly
    ud.lArmPivot.rotation.x = -1.90 + Math.sin(_animTime * 8.0) * 0.26;
    ud.rArmPivot.rotation.x = -1.90 + Math.sin(_animTime * 8.0 + 0.5) * 0.26;
    ud.lArmPivot.rotation.z =  0.22 + Math.sin(_animTime * 6.0) * 0.20;
    ud.rArmPivot.rotation.z = -0.22 - Math.sin(_animTime * 6.0 + 0.3) * 0.20;
    // Excited jog in place
    ud.lLegPivot.rotation.x =  Math.sin(phase * 1.4) * 0.38;
    ud.rLegPivot.rotation.x = -Math.sin(phase * 1.4) * 0.38;
    ud.lLegPivot.userData.knee.rotation.x = 0.28;
    ud.rLegPivot.userData.knee.rotation.x = 0.28;
    if (ud.head) ud.head.rotation.x = -0.28;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  EFFECTS
  // ══════════════════════════════════════════════════════════════════════════

  // Goal flash
  function triggerGoalFlash(teamColor) {
    _flashTimer = 65;
    _goalFlashLight.color.set(new THREE.Color(teamColor));
    _shakeTimer = 38;

    // All players celebrate
    Object.values(_playerMeshes).forEach(info => { info.celebTimer = 90; });

    // Spawn confetti
    _spawnConfetti(teamColor);
  }

  function _updateFlash() {
    if (_flashTimer > 0) {
      _goalFlashLight.intensity = (_flashTimer / 65) * 4.5;
      _flashTimer--;
    } else {
      _goalFlashLight.intensity = 0;
    }
  }

  // Camera shake
  function _updateShake() {
    if (_shakeTimer > 0) {
      const mag = (_shakeTimer / 38) * 0.40;
      _camera.position.x = _baseCamPos.x + (Math.random()-0.5)*mag;
      _camera.position.y = _baseCamPos.y + (Math.random()-0.5)*mag;
      _shakeTimer--;
    } else {
      _camera.position.copy(_baseCamPos);
    }
  }

  // Confetti particles (3D paper strips)
  function _spawnConfetti(color) {
    const baseCol = new THREE.Color(color);
    for (let i = 0; i < 90; i++) {
      const c = baseCol.clone().offsetHSL(
        (Math.random()-0.5)*0.30, (Math.random()-0.5)*0.2, (Math.random()-0.5)*0.35
      );
      // Emissive confetti glows slightly — visible even in shadowed areas
      const mat  = new THREE.MeshPhongMaterial({
        color: c, emissive: c.clone().multiplyScalar(0.45),
        side: THREE.DoubleSide, shininess: 60,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.20, 0.38), mat);
      mesh.position.set(
        (Math.random()-0.5)*24,
        9 + Math.random()*12,
        (Math.random()-0.5)*16
      );
      mesh.rotation.set(Math.random()*Math.PI, Math.random()*Math.PI, Math.random()*Math.PI);
      _scene.add(mesh);
      _confetti.push({
        mesh,
        vx: (Math.random()-0.5)*0.45,
        vy: -(0.12 + Math.random()*0.20),
        vz: (Math.random()-0.5)*0.45,
        rx: (Math.random()-0.5)*0.18,
        rz: (Math.random()-0.5)*0.18,
        life: 130 + Math.floor(Math.random()*70),
      });
    }
  }

  function _updateConfetti() {
    for (let i = _confetti.length - 1; i >= 0; i--) {
      const p = _confetti[i];
      p.mesh.position.x += p.vx;
      p.mesh.position.y += p.vy;
      p.mesh.position.z += p.vz;
      p.mesh.rotation.x += p.rx;
      p.mesh.rotation.z += p.rz;
      p.life--;
      if (p.life <= 0 || p.mesh.position.y < -3) {
        _scene.remove(p.mesh);
        p.mesh.geometry.dispose();
        p.mesh.material.dispose();
        _confetti.splice(i, 1);
      }
    }
  }

  // ── Goal text overlay (DOM) ──────────────────────────────────────────────
  function triggerGoalAnim(teamColor, text) {
    let el = document.getElementById('goal-3d-text');
    if (!el) {
      el = document.createElement('div');
      el.id = 'goal-3d-text';
      document.getElementById('canvas-wrapper').appendChild(el);
    }
    el.textContent = text;
    el.style.setProperty('--goal-color', teamColor);
    el.classList.remove('visible');
    // Force reflow
    void el.offsetWidth;
    el.classList.add('visible');
    setTimeout(() => el.classList.remove('visible'), 2600);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  DOM UPDATES
  // ══════════════════════════════════════════════════════════════════════════
  function updateDOM(ms) {
    document.getElementById('match-home-score').textContent = ms.homeScore;
    document.getElementById('match-away-score').textContent = ms.awayScore;
    document.getElementById('match-time-display').textContent = `${Math.floor(ms.simMinutes)}'`;
    const total = (ms.possessionA + ms.possessionB) || 1;
    document.getElementById('possession-fill').style.width =
      Math.round((ms.possessionA / total) * 100) + '%';
  }

  function showHalftimeOverlay(ms) {
    const el = document.getElementById('halftime-overlay');
    document.getElementById('halftime-score').textContent =
      `${ms.homeTeam.name} ${ms.homeScore} – ${ms.awayScore} ${ms.awayTeam.name}`;
    el.style.display = 'flex';
    setTimeout(() => { el.style.display = 'none'; }, HALFTIME_PAUSE * 16.67);
  }

  function pushTicker(text) {
    const el = document.getElementById('match-events-ticker');
    if (!el) return;
    const span = document.createElement('span');
    span.className = 'ticker-event';
    span.textContent = text;
    el.prepend(span);
    while (el.children.length > 4) el.removeChild(el.lastChild);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  GOAL REPLAY — slow-motion playback of last 90 sim-frames
  // ══════════════════════════════════════════════════════════════════════════

  function triggerReplay(frames) {
    if (!frames || frames.length === 0) return;
    _replay = { frames, frameIdx: 0, subTick: 0 };
    _showReplayLabel(true);
  }

  function isReplaying() { return _replay !== null; }

  function _showReplayLabel(show) {
    let el = document.getElementById('replay-label');
    if (!el && show) {
      el = document.createElement('div');
      el.id = 'replay-label';
      el.innerHTML = '<span class="replay-icon">⟳</span> REPLAY';
      document.getElementById('canvas-wrapper').appendChild(el);
    }
    if (el) el.style.display = show ? 'flex' : 'none';
  }

  function _stepReplay() {
    // Advance at 0.22x speed → ~4.5× slower than real-time
    const RATE = 0.22;
    _replay.subTick += RATE;
    while (_replay.subTick >= 1) {
      _replay.subTick -= 1;
      if (_replay.frameIdx < _replay.frames.length - 1) _replay.frameIdx++;
    }

    const frame = _replay.frames[_replay.frameIdx];

    // ── Move ball ────────────────────────────────────────────────────────────
    const tx = _x(frame.ball.x), tz = _z(frame.ball.y);
    _ballVis.x += (tx - _ballVis.x) * 0.28;
    _ballVis.z += (tz - _ballVis.z) * 0.28;
    // Let natural height physics run so the ball arc looks real
    _ballVis.vy -= 0.042;
    _ballVis.h  += _ballVis.vy;
    if (_ballVis.h < 0.4) { _ballVis.h = 0.4; _ballVis.vy = 0; }
    _ballGroup.position.set(_ballVis.x, _ballVis.h, _ballVis.z);
    // Slow rolling rotation
    const bdx = tx - _ballVis.x, bdz = tz - _ballVis.z;
    _ballGroup.userData.sphere.rotation.z -= bdx * 0.012;
    _ballGroup.userData.sphere.rotation.x += bdz * 0.012;

    // ── Move players ─────────────────────────────────────────────────────────
    frame.agents.forEach(snap => {
      const info = _playerMeshes[snap.key];
      if (!info) return;
      const grp = info.group;
      const prevX = grp.position.x, prevZ = grp.position.z;
      grp.position.x += (_x(snap.x) - grp.position.x) * 0.13;
      grp.position.z += (_z(snap.y) - grp.position.z) * 0.13;
      const mvx = grp.position.x - prevX, mvz = grp.position.z - prevZ;
      const spd = Math.min(Math.sqrt(mvx * mvx + mvz * mvz) * 18, 1.0);
      if (spd > 0.08) grp.rotation.y = Math.atan2(mvx, mvz);
      const phase = _animTime * (4 + spd * 7) + info.animPhase;
      _animRunIdle(grp, grp.userData, spd, phase, info.animPhase);
    });

    // ── Done? ─────────────────────────────────────────────────────────────────
    if (_replay.frameIdx >= _replay.frames.length - 1) {
      _replay = null;
      _showReplayLabel(false);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  MAIN RENDER
  // ══════════════════════════════════════════════════════════════════════════
  function render(ctx, ms) {
    if (!_renderer || !ms) return;
    _animTime += 1 / 60;

    if (_replay) {
      _stepReplay();         // replay: drive positions from snapshot buffer
    } else {
      _updateBall(ms.ball);
      _updatePlayers(ms);
    }
    _updateFlash();
    _updateShake();
    _updateConfetti();

    _renderer.render(_scene, _camera);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  RESET (called before each new match)
  // ══════════════════════════════════════════════════════════════════════════
  function resetAnims() {
    // Remove player meshes from scene
    Object.values(_playerMeshes).forEach(({ group }) => {
      if (_scene) _scene.remove(group);
    });
    _playerMeshes = {};

    // Clear confetti
    _confetti.forEach(p => {
      if (_scene) _scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      p.mesh.material.dispose();
    });
    _confetti = [];

    // Reset kit-clash detection for the new match
    _colorConflictChecked = false;
    _awayKitColor         = null;

    // Reset ball visual state — starts at centre circle (0,0 in 3D = 340,220 in 2D)
    _ballVis = { x: 0, z: 0, h: 0.4, vy: 0, prevOwner: null };

    // Reset effects
    _flashTimer = 0;
    _shakeTimer = 0;
    _animTime   = 0;
    _replay     = null;
    _showReplayLabel(false);
    if (_goalFlashLight) _goalFlashLight.intensity = 0;
    if (_camera && _baseCamPos) _camera.position.copy(_baseCamPos);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  PUBLIC API
  // ══════════════════════════════════════════════════════════════════════════
  return {
    initThreeJS,
    render,
    resetAnims,
    updateDOM,
    triggerGoalFlash,
    triggerGoalAnim,
    triggerReplay,
    isReplaying,
    showHalftimeOverlay,
    pushTicker,
    resetPitchBg() {},  // no-op — kept for API compatibility
  };

})();
