(() => {
  "use strict";

  /* ============================================================
     SETUP & ASSET LOADING
     ============================================================ */
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  // Logical game resolution: fixed classic 16:9 widescreen. Keeping this
  // constant (rather than matching it to whatever shape the viewport is)
  // means gameplay tuning (spawn positions, speeds, bounds) stays consistent
  // across devices, and the play area is always displayed as landscape.
  const LOGICAL_W = 960;
  const LOGICAL_H = 540;
  const ASPECT = LOGICAL_W / LOGICAL_H;

  const gameContainer = document.getElementById("game-container");

  function applyContainerSize() {
    // Largest 16:9 box that fits the viewport, filling it edge-to-edge on
    // screens close to widescreen and letterboxing (no visible frame, just
    // the page's own background) on very tall/narrow or very short ones.
    const vv = window.visualViewport;
    const vw = vv ? vv.width : window.innerWidth;
    const vh = vv ? vv.height : window.innerHeight;
    let w = vw;
    let h = w / ASPECT;
    if (h > vh) { h = vh; w = h * ASPECT; }
    gameContainer.style.width = `${Math.round(w)}px`;
    gameContainer.style.height = `${Math.round(h)}px`;
  }
  applyContainerSize();

  const ASSET_LIST = {
    bg: "assets/BG.png",
    fly1: "assets/Fly_1.png",
    fly2: "assets/Fly_2.png",
    shoot1: "assets/Shoot_1.png",
    shoot2: "assets/Shoot_2.png",
    shoot3: "assets/Shoot_3.png",
    shoot4: "assets/Shoot_4.png",
    shoot5: "assets/Shoot_5.png",
    dead: "assets/Dead_1.png",
    bullet1: "assets/Bullet_1.png",
    bullet2: "assets/Bullet_2.png",
    bullet3: "assets/Bullet_3.png",
    bullet4: "assets/Bullet_4.png",
    bullet5: "assets/Bullet_5.png",
  };

  const images = {};

  function loadImage(key, src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => { images[key] = img; resolve(); };
      img.onerror = reject;
      img.src = src;
    });
  }

  function loadAll() {
    return Promise.all(Object.entries(ASSET_LIST).map(([k, v]) => loadImage(k, v)));
  }

  /* ============================================================
     OFFSCREEN TINTED SPRITES (enemy plane / enemy bullet variants)
     ============================================================ */
  function makeTinted(img, { flip = false, hue = "0,60,60", alpha = 0.45 } = {}) {
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const cx = c.getContext("2d");
    cx.save();
    if (flip) {
      cx.translate(img.width, 0);
      cx.scale(-1, 1);
    }
    cx.drawImage(img, 0, 0);
    cx.restore();
    cx.globalCompositeOperation = "source-atop";
    cx.fillStyle = `rgba(${hue},${alpha})`;
    cx.fillRect(0, 0, c.width, c.height);
    cx.globalCompositeOperation = "source-over";
    return c;
  }

  let enemyFrames = [];
  let enemyBulletFrames = [];
  let playerFlyFrames = [];
  let playerShootFrames = [];

  function buildSpriteSets() {
    playerFlyFrames = [images.fly1, images.fly2];
    playerShootFrames = [images.shoot1, images.shoot2, images.shoot3, images.shoot4, images.shoot5];

    // Enemy planes: same art, flipped to face left, tinted red/orange (rival squadron)
    enemyFrames = [images.fly1, images.fly2].map(im => makeTinted(im, { flip: true, hue: "255,70,60", alpha: 0.5 }));

    // Enemy bullets: tint the glow reddish-orange to distinguish from player's yellow bolts
    enemyBulletFrames = [images.bullet1, images.bullet2, images.bullet3, images.bullet4, images.bullet5]
      .map(im => makeTinted(im, { flip: false, hue: "255,70,50", alpha: 0.55 }));
  }

  /* ============================================================
     UI ELEMENTS
     ============================================================ */
  const hud = document.getElementById("hud");
  const scoreValueEl = document.getElementById("score-value");
  const lifeIcons = [document.getElementById("life-0"), document.getElementById("life-1"), document.getElementById("life-2")];
  const startScreen = document.getElementById("start-screen");
  const gameoverScreen = document.getElementById("gameover-screen");
  const loadingScreen = document.getElementById("loading-screen");
  const startBtn = document.getElementById("start-btn");
  const restartBtn = document.getElementById("restart-btn");
  const finalScoreEl = document.getElementById("final-score");
  const bestScoreFinalEl = document.getElementById("best-score-final");
  const bestScoreStartEl = document.getElementById("best-score-start");
  const newRecordEl = document.getElementById("new-record");

  const BEST_SCORE_KEY = "skyraider_best_score";
  function getBestScore() { return parseInt(localStorage.getItem(BEST_SCORE_KEY) || "0", 10); }
  function setBestScore(v) { localStorage.setItem(BEST_SCORE_KEY, String(v)); }

  /* ============================================================
     GAME STATE
     ============================================================ */
  const STATE = { LOADING: "loading", START: "start", PLAYING: "playing", DYING: "dying", GAMEOVER: "gameover" };
  let state = STATE.LOADING;

  const player = {
    x: 160, y: LOGICAL_H / 2,
    w: 112, h: 77,
    targetX: 160, targetY: LOGICAL_H / 2,
    lives: 3,
    invulnTimer: 0,
    animTimer: 0,
    animIndex: 0,
    fireTimer: 0,
    dyingTimer: 0,
    dyingVy: 0,
    dyingRot: 0,
  };

  let score = 0;
  let elapsed = 0;
  let bgScrollX = 0;

  let playerBullets = [];
  let enemies = [];
  let enemyBullets = [];
  let particles = [];

  let enemySpawnTimer = 0;
  let enemySpawnInterval = 1150;

  const keys = {};
  const pointer = { active: false, x: player.x, y: player.y };

  /* ============================================================
     INPUT
     ============================================================ */
  window.addEventListener("keydown", (e) => {
    keys[e.key.toLowerCase()] = true;
    if ([" ", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(e.key.toLowerCase())) e.preventDefault();
  }, { passive: false });
  window.addEventListener("keyup", (e) => { keys[e.key.toLowerCase()] = false; });

  function canvasPointFromEvent(evt) {
    const rect = canvas.getBoundingClientRect();
    const cx = (evt.clientX - rect.left) / rect.width * LOGICAL_W;
    const cy = (evt.clientY - rect.top) / rect.height * LOGICAL_H;
    return { x: cx, y: cy };
  }

  function onPointerMove(evt) {
    if (state !== STATE.PLAYING) return;
    const p = canvasPointFromEvent(evt);
    pointer.active = true;
    pointer.x = p.x;
    pointer.y = p.y;
  }

  canvas.addEventListener("mousemove", onPointerMove);
  canvas.addEventListener("mousedown", onPointerMove);
  canvas.addEventListener("touchstart", (e) => { onPointerMove(e.touches[0]); }, { passive: true });
  canvas.addEventListener("touchmove", (e) => { onPointerMove(e.touches[0]); e.preventDefault(); }, { passive: false });

  /* ============================================================
     HELPERS
     ============================================================ */
  function rand(a, b) { return a + Math.random() * (b - a); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function rectsOverlap(a, b) {
    return a.x - a.w / 2 < b.x + b.w / 2 &&
      a.x + a.w / 2 > b.x - b.w / 2 &&
      a.y - a.h / 2 < b.y + b.h / 2 &&
      a.y + a.h / 2 > b.y - b.h / 2;
  }

  function difficultyFactor() {
    // Ramps up smoothly over the first ~90s, then stays hard.
    return clamp(elapsed / 90000, 0, 1);
  }

  /* ============================================================
     RESET / START / END
     ============================================================ */
  function resetGame() {
    score = 0;
    elapsed = 0;
    player.x = 160; player.y = LOGICAL_H / 2;
    player.targetX = player.x; player.targetY = player.y;
    player.lives = 3;
    player.invulnTimer = 0;
    player.fireTimer = 0;
    player.dyingTimer = 0;
    playerBullets = [];
    enemies = [];
    enemyBullets = [];
    particles = [];
    enemySpawnTimer = 0;
    enemySpawnInterval = 1150;
    pointer.active = false;
    pointer.x = player.x; pointer.y = player.y;
    updateLifeIcons();
    scoreValueEl.textContent = "0";
  }

  function startGame() {
    resetGame();
    state = STATE.PLAYING;
    startScreen.classList.add("hidden");
    gameoverScreen.classList.add("hidden");
    hud.classList.remove("hidden");
  }

  function goToGameOver() {
    state = STATE.GAMEOVER;
    hud.classList.add("hidden");
    finalScoreEl.textContent = String(Math.floor(score));
    const best = getBestScore();
    const isRecord = score > best;
    if (isRecord) setBestScore(Math.floor(score));
    bestScoreFinalEl.textContent = String(getBestScore());
    newRecordEl.classList.toggle("hidden", !isRecord);
    gameoverScreen.classList.remove("hidden");
  }

  function beginDyingSequence() {
    state = STATE.DYING;
    player.dyingTimer = 0;
    player.dyingVy = -160;
    player.dyingRot = 0;
  }

  startBtn.addEventListener("click", startGame);
  restartBtn.addEventListener("click", startGame);

  /* ============================================================
     UPDATE: PLAYER
     ============================================================ */
  function updatePlayer(dt) {
    const speed = 480; // px/s keyboard
    let dx = 0, dy = 0;
    if (keys["arrowleft"] || keys["a"]) dx -= 1;
    if (keys["arrowright"] || keys["d"]) dx += 1;
    if (keys["arrowup"] || keys["w"]) dy -= 1;
    if (keys["arrowdown"] || keys["s"]) dy += 1;

    if (dx !== 0 || dy !== 0) {
      const len = Math.hypot(dx, dy) || 1;
      player.x += (dx / len) * speed * dt;
      player.y += (dy / len) * speed * dt;
      pointer.x = player.x;
      pointer.y = player.y;
    } else if (pointer.active) {
      const lerp = 1 - Math.pow(0.001, dt);
      player.x += (pointer.x - player.x) * lerp;
      player.y += (pointer.y - player.y) * lerp;
    }

    const marginX = player.w / 2 + 6;
    const marginY = player.h / 2 + 6;
    player.x = clamp(player.x, marginX, LOGICAL_W * 0.78);
    player.y = clamp(player.y, marginY, LOGICAL_H - marginY);

    // animation: always "boosting" while playing
    player.animTimer += dt;
    if (player.animTimer > 0.07) {
      player.animTimer = 0;
      player.animIndex = (player.animIndex + 1) % playerShootFrames.length;
    }

    // autofire
    player.fireTimer -= dt * 1000;
    if (player.fireTimer <= 0) {
      player.fireTimer = 190;
      playerBullets.push({
        x: player.x + player.w * 0.42,
        y: player.y + 2,
        w: 30, h: 22,
        vx: 780, vy: 0,
        frame: Math.floor(rand(0, 5)),
      });
    }

    if (player.invulnTimer > 0) player.invulnTimer -= dt * 1000;
  }

  /* ============================================================
     UPDATE: DYING SEQUENCE
     ============================================================ */
  function updateDying(dt) {
    player.dyingTimer += dt * 1000;
    player.dyingVy += 420 * dt;
    player.y += player.dyingVy * dt;
    player.x -= 40 * dt;
    player.dyingRot += dt * 3.2;
    if (player.dyingTimer > 900) {
      goToGameOver();
    }
  }

  /* ============================================================
     UPDATE: ENEMIES
     ============================================================ */
  function spawnEnemy() {
    const diff = difficultyFactor();
    const isShooter = Math.random() < 0.35 + diff * 0.15;
    const scale = rand(0.72, 1.0) - diff * 0.08;
    const w = 108 * clamp(scale, 0.55, 1.05);
    const h = w * (308 / 448);
    enemies.push({
      x: LOGICAL_W + w,
      y: rand(h, LOGICAL_H - h),
      w, h,
      vx: -rand(150, 230) - diff * 130,
      bob: rand(0, Math.PI * 2),
      bobSpeed: rand(1.4, 2.4),
      bobAmount: rand(6, 18),
      isShooter,
      fireTimer: rand(400, 1200),
      animIndex: Math.random() < 0.5 ? 0 : 1,
      animTimer: 0,
      hp: 1,
    });
  }

  function updateEnemies(dt) {
    const diff = difficultyFactor();
    enemySpawnTimer -= dt * 1000;
    if (enemySpawnTimer <= 0) {
      spawnEnemy();
      enemySpawnInterval = clamp(1150 - diff * 700, 430, 1150);
      enemySpawnTimer = enemySpawnInterval * rand(0.75, 1.25);
    }

    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i];
      e.x += e.vx * dt;
      e.bob += e.bobSpeed * dt;
      e.y += Math.sin(e.bob) * e.bobAmount * dt;
      e.y = clamp(e.y, e.h / 2, LOGICAL_H - e.h / 2);

      e.animTimer += dt;
      if (e.animTimer > 0.22) { e.animTimer = 0; e.animIndex = 1 - e.animIndex; }

      if (e.isShooter && state === STATE.PLAYING) {
        e.fireTimer -= dt * 1000;
        if (e.fireTimer <= 0) {
          e.fireTimer = rand(1100, 1700) - diff * 300;
          enemyBullets.push({
            x: e.x - e.w * 0.42, y: e.y,
            w: 26, h: 19,
            vx: -520 - diff * 100, vy: 0,
            frame: Math.floor(rand(0, 5)),
          });
        }
      }

      if (e.x < -e.w) { enemies.splice(i, 1); continue; }

      // collide with player
      if (state === STATE.PLAYING && player.invulnTimer <= 0) {
        if (rectsOverlap({ x: player.x, y: player.y, w: player.w * 0.62, h: player.h * 0.62 }, { x: e.x, y: e.y, w: e.w * 0.7, h: e.h * 0.7 })) {
          spawnExplosion(e.x, e.y, 1.1);
          enemies.splice(i, 1);
          hitPlayer();
          continue;
        }
      }
    }
  }

  /* ============================================================
     UPDATE: BULLETS
     ============================================================ */
  function updateBullets(dt) {
    for (let i = playerBullets.length - 1; i >= 0; i--) {
      const b = playerBullets[i];
      b.x += b.vx * dt;
      if (b.x > LOGICAL_W + 40) { playerBullets.splice(i, 1); continue; }

      let hit = false;
      for (let j = enemies.length - 1; j >= 0; j--) {
        const e = enemies[j];
        if (rectsOverlap({ x: b.x, y: b.y, w: b.w * 0.5, h: b.h * 0.5 }, { x: e.x, y: e.y, w: e.w * 0.62, h: e.h * 0.62 })) {
          enemies.splice(j, 1);
          spawnExplosion(e.x, e.y, 1);
          score += 10;
          scoreValueEl.textContent = String(Math.floor(score));
          hit = true;
          break;
        }
      }
      if (hit) { playerBullets.splice(i, 1); }
    }

    for (let i = enemyBullets.length - 1; i >= 0; i--) {
      const b = enemyBullets[i];
      b.x += b.vx * dt;
      if (b.x < -40) { enemyBullets.splice(i, 1); continue; }

      if (state === STATE.PLAYING && player.invulnTimer <= 0) {
        if (rectsOverlap({ x: b.x, y: b.y, w: b.w * 0.55, h: b.h * 0.55 }, { x: player.x, y: player.y, w: player.w * 0.55, h: player.h * 0.55 })) {
          enemyBullets.splice(i, 1);
          spawnExplosion(player.x, player.y, 0.5);
          hitPlayer();
        }
      }
    }
  }

  function hitPlayer() {
    player.lives -= 1;
    player.invulnTimer = 1400;
    updateLifeIcons();
    if (player.lives <= 0) {
      beginDyingSequence();
    }
  }

  function updateLifeIcons() {
    lifeIcons.forEach((icon, i) => {
      icon.classList.toggle("lost", i >= player.lives);
    });
  }

  /* ============================================================
     PARTICLES (simple explosion puffs — no extra assets needed)
     ============================================================ */
  function spawnExplosion(x, y, scale = 1) {
    const count = Math.floor(9 * scale);
    for (let i = 0; i < count; i++) {
      const ang = rand(0, Math.PI * 2);
      const spd = rand(60, 220) * scale;
      particles.push({
        x, y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        life: rand(0.25, 0.55),
        age: 0,
        r: rand(3, 7) * scale,
        color: Math.random() < 0.5 ? "255,190,60" : "255,120,60",
      });
    }
  }

  function updateParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.age += dt;
      if (p.age >= p.life) { particles.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.92;
      p.vy *= 0.92;
    }
  }

  /* ============================================================
     MAIN UPDATE
     ============================================================ */
  function update(dt) {
    bgScrollX -= 55 * dt * (1 + difficultyFactor() * 0.4);
    if (bgScrollX <= -LOGICAL_W) bgScrollX += LOGICAL_W;

    if (state === STATE.PLAYING) {
      elapsed += dt * 1000;
      score += dt * 2; // small trickle for survival time
      scoreValueEl.textContent = String(Math.floor(score));
      updatePlayer(dt);
      updateEnemies(dt);
      updateBullets(dt);
    } else if (state === STATE.DYING) {
      updateEnemies(dt);
      updateBullets(dt);
      updateDying(dt);
    } else if (state === STATE.START) {
      // gentle idle bob handled via CSS on preview image; keep bg moving only
    }
    updateParticles(dt);
  }

  /* ============================================================
     DRAW
     ============================================================ */
  let bgTile = null;
  function buildBgTile() {
    const c = document.createElement("canvas");
    c.width = LOGICAL_W;
    c.height = LOGICAL_H;
    const cx = c.getContext("2d");
    cx.drawImage(images.bg, 0, 0, LOGICAL_W, LOGICAL_H);
    bgTile = c;
  }

  function drawBackground() {
    const w = LOGICAL_W;
    const h = LOGICAL_H;
    let x = Math.round(bgScrollX);
    const prevSmoothing = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false; // 1:1 integer blit — smoothing only introduces edge seams
    ctx.drawImage(bgTile, x - w, 0, w, h);
    ctx.drawImage(bgTile, x, 0, w, h);
    ctx.drawImage(bgTile, x + w, 0, w, h);
    ctx.imageSmoothingEnabled = prevSmoothing;
  }

  function drawBullets(list, frames) {
    for (const b of list) {
      const img = frames[b.frame % frames.length];
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(Math.PI / 2); // asset is a vertical glow; rotate to align with horizontal travel
      ctx.drawImage(img, -b.h / 2, -b.w / 2, b.h, b.w);
      ctx.restore();
    }
  }

  function drawEnemies() {
    for (const e of enemies) {
      const img = enemyFrames[e.animIndex];
      ctx.drawImage(img, e.x - e.w / 2, e.y - e.h / 2, e.w, e.h);
    }
  }

  function drawParticles() {
    for (const p of particles) {
      const t = 1 - p.age / p.life;
      ctx.globalAlpha = clamp(t, 0, 1);
      ctx.fillStyle = `rgb(${p.color})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * t, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawPlayer() {
    let img;
    let alpha = 1;
    ctx.save();

    if (state === STATE.DYING || state === STATE.GAMEOVER) {
      ctx.translate(player.x, player.y);
      ctx.rotate(Math.min(player.dyingRot, 0.9));
      img = images.dead;
      ctx.drawImage(img, -player.w / 2, -player.h / 2, player.w, player.h);
      ctx.restore();
      return;
    }

    if (state === STATE.START) {
      img = playerFlyFrames[Math.floor(performance.now() / 260) % 2];
    } else {
      img = playerShootFrames[player.animIndex];
    }

    if (player.invulnTimer > 0) {
      alpha = (Math.floor(performance.now() / 80) % 2 === 0) ? 0.35 : 1;
    }

    ctx.globalAlpha = alpha;
    ctx.drawImage(img, player.x - player.w / 2, player.y - player.h / 2, player.w, player.h);
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function render() {
    ctx.clearRect(0, 0, LOGICAL_W, LOGICAL_H);
    drawBackground();

    if (state === STATE.PLAYING || state === STATE.DYING) {
      drawEnemies();
      drawBullets(playerBullets, [images.bullet1, images.bullet2, images.bullet3, images.bullet4, images.bullet5]);
      drawBullets(enemyBullets, enemyBulletFrames);
      drawParticles();
      drawPlayer();
    } else if (state === STATE.GAMEOVER) {
      drawParticles();
    }
  }

  /* ============================================================
     MAIN LOOP
     ============================================================ */
  let lastTime = performance.now();
  function loop(now) {
    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;
    update(dt);
    render();
    requestAnimationFrame(loop);
  }

  /* ============================================================
     BOOT
     ============================================================ */
  function fitCanvasResolution() {
    // Buffer resolution must match the canvas's *actual displayed* CSS size
    // (not the fixed 960×540 logical size) at the real device pixel ratio —
    // otherwise the browser has to upscale the bitmap to fill the screen,
    // which is what caused the blur. Cap dpr modestly for performance only.
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const rect = canvas.getBoundingClientRect();
    const bufW = Math.max(1, Math.round(rect.width * dpr));
    const bufH = Math.max(1, Math.round(rect.height * dpr));
    canvas.width = bufW;
    canvas.height = bufH;
    // Changing width/height resets all canvas state, so re-apply these.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    // Map the fixed 960×540 logical coordinate system onto the real buffer.
    ctx.setTransform(bufW / LOGICAL_W, 0, 0, bufH / LOGICAL_H, 0, 0);
  }
  fitCanvasResolution();

  function handleResize() {
    applyContainerSize();
    fitCanvasResolution();
  }
  window.addEventListener("resize", handleResize);
  window.addEventListener("orientationchange", handleResize);

  loadAll().then(() => {
    buildSpriteSets();
    buildBgTile();
    loadingScreen.classList.add("hidden");
    state = STATE.START;
    bestScoreStartEl.textContent = String(getBestScore());
    lastTime = performance.now();
    requestAnimationFrame(loop);
  }).catch((err) => {
    loadingScreen.querySelector("p").textContent = "Gagal memuat aset. Muat ulang halaman.";
    console.error(err);
  });

})();
