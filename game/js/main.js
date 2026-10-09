import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { World, CELL, ROW, W, L, LZ, COLS, WALL, LEVEL, canStep } from './world.js';
import { createMaterial, buildInstanceMesh } from './render.js';

// ---------- параметры игрока (их же учитывает проверка паттернов) ----------
const P = {
  speedStart: 11,      // ед/с
  speedMax: 22,
  speedRamp: 1800,     // за сколько единиц пути разгон до максимума
  lateral: 20,         // макс. скорость вбок, ед/с
  dragSens: 11,        // сколько единиц вбок за ширину экрана пальцем
  radius: 0.45,
  step: 0.35,          // на сколько можно «перешагнуть» без прыжка
  mantle: 1.3,         // в прыжке край до стольких единиц выше ног — забираемся
  gravity: 30,
  jumpV: 13,           // пик прыжка ≈ 2.8 ед > 1 уровень (2 ед)
  eye: 1.6,
  coyote: 0.1,
  jumpBuffer: 0.15,
};

const params = new URLSearchParams(location.search);
const useBloom = params.get('bloom') !== '0';
const showDebug = params.has('debug');
const autopilot = params.has('auto');

// ---------- рендер ----------
const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !useBloom, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0xffffff, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 200);
const material = createMaterial({ linearOut: useBloom });

let composer = null, bloom = null;
if (useBloom) {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.55, 0.88);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // в портрете поле зрения шире, чтобы видеть повороты
  camera.fov = w < h ? 82 : 70;
  camera.updateProjectionMatrix();
  if (composer) {
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(w, h);
    bloom.resolution.set(w / 2, h / 2);
  }
}
window.addEventListener('resize', resize);
resize();

// ---------- UI ----------
const $ = (id) => document.getElementById(id);
const ui = {
  start: $('start'), over: $('over'), hud: $('hud'),
  dist: $('dist'), debug: $('debug'), overDist: $('over-dist'),
  overInfo: $('over-info'), best: $('best'),
};

let best = 0;
try { best = Number(localStorage.getItem('city-best')) || 0; } catch { /* приватный режим */ }

// ---------- состояние игры ----------
let world, meshes, seed;
const pl = { x: 0, z: 0, y: 0, vy: 0, targetX: 0, grounded: true, coyote: 0, jumpBuf: 0, roll: 0 };
let state = 'ready';
let deadT = 0;
let shake = 0;

function newSeed() { return Math.floor(Math.random() * 1e6); }

function reset(s) {
  seed = s;
  for (const m of meshes || []) { scene.remove(m); m.geometry.dispose(); }
  meshes = [];
  world = new World(seed);
  for (const inst of world.instances) addMesh(inst);
  pl.x = pl.targetX = 6 * CELL + CELL / 2;
  pl.z = ROW * 0.5; pl.y = 0; pl.vy = 0; pl.grounded = true; pl.roll = 0;
  shake = 0;
  ensureWorld();
  const u = new URL(location.href);
  u.searchParams.set('seed', seed);
  history.replaceState(null, '', u);
}

function addMesh(inst) {
  const m = buildInstanceMesh(inst, material);
  meshes.push(m);
  scene.add(m);
}

function ensureWorld() {
  const need = Math.ceil((pl.z + LZ * 4) / ROW) + 12;
  for (const inst of world.ensureRows(need)) addMesh(inst);
  // убираем то, что далеко позади
  meshes = meshes.filter((m) => {
    if (m.userData.zEnd < pl.z - ROW * 3) {
      scene.remove(m); m.geometry.dispose(); return false;
    }
    return true;
  });
}

// ---------- физика (всё в плоском мире) ----------
const wrapX = (x) => ((x % W) + W) % W;

function speedNow() {
  const t = Math.min(1, pl.z / P.speedRamp);
  return P.speedStart + (P.speedMax - P.speedStart) * t;
}

function hAt(x, z) { return world.heightAt(wrapX(x), z); }

function blocked(x, z) { return hAt(x, z) > pl.y + P.step; }

function physicsStep(dt) {
  const r = P.radius;
  const v = speedNow();

  // вперёд: упёрся в стену или в слишком высокую крышу — авария
  const nz = pl.z + v * dt;
  const front = Math.max(hAt(pl.x - r * 0.7, nz + r), hAt(pl.x + r * 0.7, nz + r));
  if (front > pl.y + P.step) {
    // в прыжке и край чуть выше ног — забираемся (паркур), иначе авария
    if (!pl.grounded && front !== Infinity && front <= pl.y + P.mantle) {
      pl.y = front; pl.vy = Math.max(pl.vy, 0); pl.grounded = true;
    } else {
      die();
      return;
    }
  }
  pl.z = nz;

  // вбок: в стену просто упираемся
  let dx = pl.targetX - pl.x;
  const maxD = P.lateral * dt;
  dx = Math.max(-maxD, Math.min(maxD, dx));
  if (dx !== 0) {
    const side = pl.x + dx + Math.sign(dx) * r;
    if (blocked(side, pl.z - r * 0.7) || blocked(side, pl.z + r * 0.7)) {
      pl.targetX = pl.x; // не «прилипаем» к стене
    } else {
      pl.x += dx;
    }
  }
  pl.roll += (-(dx / dt) * 0.0025 - pl.roll) * Math.min(1, dt * 8);

  // по вертикали
  let ground = 0;
  for (const [ox, oz] of [[-r, -r], [r, -r], [-r, r], [r, r]]) {
    const h = hAt(pl.x + ox, pl.z + oz);
    if (h <= pl.y + P.step) ground = Math.max(ground, h);
  }
  if (pl.grounded && pl.y > ground + 0.01) pl.grounded = false; // сошли с края
  if (!pl.grounded) {
    pl.vy -= P.gravity * dt;
    pl.y += pl.vy * dt;
    if (pl.y <= ground) { pl.y = ground; pl.vy = 0; pl.grounded = true; }
  } else {
    pl.y = ground; // ступенька вверх/вниз
  }

  pl.coyote = pl.grounded ? P.coyote : pl.coyote - dt;
  pl.jumpBuf -= dt;
  if (pl.jumpBuf > 0 && pl.coyote > 0) {
    pl.vy = P.jumpV; pl.grounded = false; pl.coyote = 0; pl.jumpBuf = 0;
  }
}


// ---------- автопилот (?auto) — для тестов: бежит по достижимым клеткам ----------
const AHEAD = 10;
function autopilotStep() {
  const ri = Math.floor(pl.z / ROW);
  const rows = world.rows, reach = world.reach;
  const end = Math.min(rows.length - 1, ri + AHEAD);
  const cm = (c) => ((c % COLS) + COLS) % COLS;
  // «живые» клетки: достижимы и ведут дальше (без тупиков)
  let alive = Uint8Array.from(reach[end]);
  const aliveRows = { [end]: alive };
  for (let r = end - 1; r > ri; r--) {
    const a = new Uint8Array(COLS);
    for (let c = 0; c < COLS; c++) {
      if (!reach[r][c]) continue;
      for (let d = -1; d <= 1; d++) {
        const c2 = cm(c + d);
        if (aliveRows[r + 1][c2] && canStep(rows[r], rows[r + 1], c, c2)) a[c] = 1;
      }
    }
    aliveRows[r] = a;
  }
  const cur = Math.floor(pl.x / CELL);
  const cdist = (a, b) => Math.min(cm(a - b), cm(b - a));
  const lvl = (r, c) => (rows[r] ? rows[r][cm(c)] : 0);
  const okFrom = (h, v) => v !== WALL && v <= h + 1;
  const here = Math.round(pl.y / LEVEL);
  // следующий ряд: соседняя «живая» колонка, ближе всего к живым клеткам через ряд
  const n1 = aliveRows[ri + 1] || alive, n2 = aliveRows[ri + 2] || n1;
  let best = cur, bscore = 1e9;
  for (let d = -1; d <= 1; d++) {
    const c = cm(cur + d);
    if (!n1[c] || !okFrom(here, lvl(ri + 1, c))) continue;
    if (rows[ri] && rows[ri + 1] && !canStep(rows[ri], rows[ri + 1], cm(cur), c) && d !== 0) continue;
    let nd = 99;
    for (let c2 = 0; c2 < COLS; c2++) if (n2[c2]) nd = Math.min(nd, cdist(c, c2));
    const score = nd * 10 + Math.abs(d);
    if (score < bscore) { bscore = score; best = c; }
  }
  // сдвигаемся сразу, если клетка сбоку в текущем ряду свободна, иначе — на входе в следующий ряд
  let goal = best;
  if (best !== cur && !okFrom(here, lvl(ri, best))) {
    goal = (ri + 1) * ROW - pl.z < 0.6 ? best : cur;
  }
  let tx = goal * CELL + CELL / 2;
  if (tx - pl.x > W / 2) tx -= W; else if (pl.x - tx > W / 2) tx += W;
  pl.targetX = tx;
  // прыжок: впереди выше или провал между крышами
  const into = (ri + 1) * ROW - pl.z;
  const h1 = lvl(ri + 1, best), h2 = lvl(ri + 2, best);
  if (into < 2.6 && into > 0.8 && pl.grounded) {
    if (h1 !== WALL && h1 > here) jump();
    else if (here > 0 && h1 < here && h2 !== WALL && h2 >= here) jump();
  }
}

function die() {
  if (state !== 'run') return;
  state = 'dead';
  deadT = 0;
  shake = 0.6;
  const meters = Math.floor(pl.z);
  if (meters > best) {
    best = meters;
    try { localStorage.setItem('city-best', String(best)); } catch { /* ignore */ }
  }
  const info = world.infoAt(pl.z + 1);
  ui.overDist.textContent = `${meters} м`;
  ui.overInfo.textContent = `seed ${seed} · ${info.name} (#${info.inst}) · ряд ${info.local + 1}/${info.total}`;
  ui.best.textContent = `рекорд ${best} м`;
  setTimeout(() => { if (state === 'dead') ui.over.classList.add('show'); }, 450);
}

function start() {
  ui.start.classList.remove('show');
  ui.over.classList.remove('show');
  ui.hud.classList.add('show');
  state = 'run';
}

// ---------- управление ----------
function jump() { if (state === 'run') pl.jumpBuf = P.jumpBuffer; }

let touch = null;
canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (state === 'ready') { start(); return; }
  if (state !== 'run') return;
  touch = { id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t: performance.now(), jumped: false };
  canvas.setPointerCapture?.(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!touch || e.pointerId !== touch.id) return;
  const dxPx = e.clientX - touch.x;
  touch.x = e.clientX;
  pl.targetX += dxPx * (P.dragSens / window.innerWidth);
  // свайп вверх — прыжок
  if (!touch.jumped && touch.y0 - e.clientY > 40 && Math.abs(e.clientY - touch.y0) > Math.abs(e.clientX - touch.x0)) {
    touch.jumped = true; jump();
  }
});
const endTouch = (e) => {
  if (!touch || e.pointerId !== touch.id) return;
  const moved = Math.hypot(e.clientX - touch.x0, e.clientY - touch.y0);
  if (!touch.jumped && moved < 12 && performance.now() - touch.t < 300) jump(); // тап — прыжок
  touch = null;
};
canvas.addEventListener('pointerup', endTouch);
canvas.addEventListener('pointercancel', endTouch);

const keys = new Set();
window.addEventListener('keydown', (e) => {
  if (['ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD', 'Space', 'ArrowUp', 'KeyW'].includes(e.code)) e.preventDefault();
  if (state === 'ready' && (e.code === 'Space' || e.code === 'Enter')) { start(); return; }
  if (state === 'dead' && ui.over.classList.contains('show') && e.code === 'Enter') { restart(false); return; }
  if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') jump();
  keys.add(e.code);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));

// iOS: не даём странице зумиться и скроллиться
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

function restart(sameSeed) {
  reset(sameSeed ? seed : newSeed());
  start();
}
$('again').addEventListener('click', () => restart(false));
$('same').addEventListener('click', () => restart(true));

// ---------- камера ----------
function updateCamera(dt) {
  const eyeY = pl.y + P.eye;
  camera.position.set(0, eyeY, L);
  camera.up.set(0, 1, 0);
  // смотрим на центр
  camera.lookAt(0, eyeY * 0.75, 0);
  let roll = pl.roll;
  if (shake > 0) {
    shake = Math.max(0, shake - dt);
    const k = shake * 0.06;
    camera.position.x += (Math.random() - 0.5) * k * 4;
    camera.position.y += (Math.random() - 0.5) * k * 4;
    roll += (Math.random() - 0.5) * k;
  }
  camera.rotateZ(roll);
  // ощущение скорости — расширяем поле зрения на разгоне
  const base = window.innerWidth < window.innerHeight ? 82 : 70;
  const fov = base + (speedNow() - P.speedStart) * 0.6;
  if (Math.abs(camera.fov - fov) > 0.05) { camera.fov = fov; camera.updateProjectionMatrix(); }
}

// ---------- цикл ----------
let last = performance.now();
let fpsAcc = 0, fpsN = 0, fps = 0;

function frame(now) {
  requestAnimationFrame(frame);
  let dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (state === 'run') {
    const k = (keys.has('ArrowLeft') || keys.has('KeyA') ? -1 : 0) + (keys.has('ArrowRight') || keys.has('KeyD') ? 1 : 0);
    if (k) pl.targetX = pl.x + k * P.lateral * 0.12;
    // мелкие шаги — чтобы на высокой скорости не проскакивать сквозь стены
    const n = Math.ceil(dt / (1 / 120));
    for (let i = 0; i < n && state === 'run'; i++) { if (autopilot) autopilotStep(); physicsStep(dt / n); }
    ensureWorld();
    ui.dist.textContent = `${Math.floor(pl.z)} м`;
  } else if (state === 'ready') {
    // медленный «облёт» на стартовом экране
    pl.z += dt * 2;
    ensureWorld();
  } else if (state === 'dead') {
    deadT += dt;
  }

  // держим координаты маленькими: x по модулю окружности
  const wrapped = wrapX(pl.x);
  pl.targetX += wrapped - pl.x;
  pl.x = wrapped;

  for (const m of meshes) m.position.set(-pl.x, 0, m.userData.zStart - pl.z);
  updateCamera(dt);

  if (composer) composer.render(); else renderer.render(scene, camera);

  if (showDebug) {
    fpsAcc += dt; fpsN++;
    if (fpsAcc > 0.5) { fps = Math.round(fpsN / fpsAcc); fpsAcc = 0; fpsN = 0; }
  }
  const info = world.infoAt(pl.z);
  ui.debug.textContent = `seed ${seed} · ${info.name} #${info.inst} · ряд ${info.local + 1}/${info.total}` + (showDebug ? ` · ${fps} fps` : '');
}

const initialSeed = Number(params.get('seed'));
reset(Number.isFinite(initialSeed) && params.has('seed') ? initialSeed : newSeed());
ui.start.classList.add('show');
requestAnimationFrame(frame);

// для автотестов
window.__game = { get state() { return state; }, pl, start, jump, get seed() { return seed; } };
