import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import {
  World, CELL, ROW, W, L, LZ, COLS, WALL, BRIDGE, VOID, LEVEL, BRIDGE_BOTTOM, BRIDGE_TOP, CEIL_H,
  canStep, canJumpOver, aliveBackward, walk, lv, planterAt,
} from './world.js';
import { createMaterial, createStarMaterial, buildInstanceMesh } from './render.js';

// ---------- параметры игрока (их же учитывает проверка паттернов) ----------
const P = {
  speedStart: 11,      // ед/с
  speedMax: 22,
  speedRamp: 1800,     // за сколько единиц пути разгон до максимума
  // вбок: полосы-«рельсы» по колонкам; свайп = ровно одна полоса
  // переезд — мягкая пружина без раскачки: скорость плавно растёт и плавно гаснет,
  // второй свайп посреди переезда тоже без рывка (~90% пути за 0.23 с, на максимуме за 0.18 с)
  laneW: 17,
  laneWFast: 22,
  laneBuffer: 0.25,    // свайп чуть раньше времени ждёт, пока проём откроется
  radius: 0.45,
  step: 0.35,          // на сколько можно «перешагнуть» без прыжка
  mantle: 1.5,         // в прыжке край до стольких единиц выше ног — забираемся
  jumpV: 12.2,
  gravityUp: 26,       // вверх легче…
  gravityDown: 46,     // …вниз тяжелее: прыжок резкий, не «лунный». Пик ≈ 2.9 ед
  fastFall: 20,        // свайп вниз в воздухе — резко вниз
  bodyStand: 1.75,
  bodySlide: 0.85,
  eyeStand: 1.62,
  eyeSlide: 0.72,
  slideTime: 0.75,
  slideBoost: 4,       // подкат разгоняет…
  boostMax: 8,
  boostDecay: 2.5,     // …и разгон тает, но не в воздухе после slide-hop
  coyote: 0.1,
  jumpBuffer: 0.15,
  // бег по стене (как в VHOLUME): касание стены даёт разгон, держаться можно недолго —
  // тебя плавно уводит вниз по дуге; прыжок от стены — толчок на соседнюю полосу
  wallTime: 1.3,
  wallBoost: 3,
  wallJumpBoost: 2,
  wallLift: 4.5,       // подброс при касании стены
  wallGravity: 3,      // в начале почти не падаешь…
  wallGravityEnd: 22,  // …к концу — всё сильнее
  fallDeath: 4,        // упал ниже пола яруса на столько — конец
};

const params = new URLSearchParams(location.search);
const useBloom = params.get('bloom') !== '0';
const useBlur = params.get('blur') !== '0';
const showDebug = params.has('debug');
const autopilot = params.has('auto');
const timeScale = autopilot ? Number(params.get('ts')) || 1 : 1; // для тестов: ускорить время

// ---------- рендер ----------
const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !useBloom, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0xffffff, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 200);
const materials = { main: createMaterial({ linearOut: useBloom }), star: createStarMaterial({ linearOut: useBloom }) };

// Motion blur: смазывание по лучам от точки схода (весь мир летит из центра)
// плюс горизонтальное — при резком уходе вбок. В центре кадра чётко.
let blurPass = null;
function createBlurPass() {
  blurPass = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      uCenter: { value: new THREE.Vector2(0.5, 0.5) },
      uStrength: { value: 0 },
      uLateral: { value: new THREE.Vector2(0, 0) },
      uAspect: { value: 1 },
      uLines: { value: 0 },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform vec2 uCenter;
      uniform float uStrength;
      uniform vec2 uLateral;
      uniform float uAspect;
      uniform float uLines;
      uniform float uTime;
      float hash(float n) { return fract(sin(n) * 43758.5453); }
      varying vec2 vUv;
      void main() {
        vec2 d = vUv - uCenter;
        float dist = length(d * vec2(uAspect, 1.0));
        vec2 vel = d * uStrength * smoothstep(0.04, 0.55, dist) + uLateral;
        vec4 col;
        if (dot(vel, vel) < 1e-7) col = texture2D(tDiffuse, vUv);
        else {
        // 12 выборок со сдвигом-шумом на пиксель: сильный смаз без «лесенки» из копий
        float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) / 12.0;
        vec4 acc = vec4(0.0);
        for (int i = 0; i < 12; i++) {
          float t = (float(i) / 12.0 + jitter) - 0.5;
          acc += texture2D(tDiffuse, vUv - vel * t);
        }
        col = acc / 12.0;
        }

        // аниме-полосы скорости: лучи к точке схода, перерисовка ~18 раз в секунду
        if (uLines > 0.001) {
          vec2 dd = d * vec2(uAspect, 1.0);   // угол — с учётом пропорций, чтобы лучи шли равномерно
          float rr = length(d * 2.0);         // радиус — в долях экрана: 1 = середина края
          float bins = 160.0;
          float a = (atan(dd.y, dd.x) / 6.2831853 + 0.5) * bins;
          float id = floor(a);
          float fa = fract(a);
          float frame = floor(uTime * 18.0);
          float h = hash(id * 1.37 + frame * 17.13);
          float on = step(1.0 - uLines * 0.5, h);                       // плотность растёт с серией
          float r0 = mix(0.8, 0.38, uLines) + 0.25 * hash(id * 7.7 + frame * 3.3); // откуда начинается луч
          float grow = smoothstep(r0, r0 + 0.35, rr);                    // тонкий у центра, толще к краю
          float w = (0.08 + 0.3 * hash(id * 3.1 + frame)) * grow;
          float line = 1.0 - smoothstep(w * 0.5, w * 0.5 + 0.06, abs(fa - 0.5));
          float k = on * line * grow * min(1.0, uLines * 1.4);
          // половина лучей тёмные, половина светлые — как в манге
          vec3 ink = hash(id * 5.3 + frame * 1.9) > 0.5 ? vec3(0.04) : vec3(1.0);
          col.rgb = mix(col.rgb, ink, k * 0.7);
        }
        gl_FragColor = col;
      }
    `,
  });
  return blurPass;
}

let composer = null, bloom = null;
if (useBloom) {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.45, 0.55, 0.9);
  composer.addPass(bloom);
  if (useBlur) composer.addPass(createBlurPass());
  composer.addPass(new OutputPass());
}

const baseFov = () => (window.innerWidth < window.innerHeight ? 82 : 70);

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.fov = baseFov();
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
let world, meshes, built, seed;
const pl = {
  x: 0, z: 0, y: 0, vx: 0, vy: 0, grounded: true,
  lane: 6, pending: 0, pendT: 0,
  coyote: 0, jumpBuf: 0, slideT: 0, slideQueued: false, boost: 0, hopKeep: false,
  slideChain: 0, slideEndAt: -9,
  wall: 0, wallT: 0, wallCool: 0, wallLast: 0,
};
const cam = { roll: 0, yaw: 0, pitch: 0, dip: 0, slide: 0, bob: 0, fov: 82, slideSide: 1, lookY: 1.2, vx: 0, lines: 0, base: 0, wall: 0 };
let gameTime = 0;
let state = 'ready';
let shake = 0;

function newSeed() { return Math.floor(Math.random() * 1e6); }

function reset(s) {
  seed = s;
  for (const m of meshes || []) { scene.remove(m); disposeGroup(m); }
  meshes = [];
  built = 0;
  world = new World(seed);
  Object.assign(pl, {
    x: 6 * CELL + CELL / 2, z: ROW * 0.5, y: 0, vx: 0, vy: 0, grounded: true,
    coyote: 0, jumpBuf: 0, slideT: 0, slideQueued: false, boost: 0, hopKeep: false,
    slideChain: 0, slideEndAt: -9, wall: 0, wallT: 0, wallCool: 0, wallLast: 0,
  });
  Object.assign(pl, { lane: 6, pending: 0, pendT: 0 });
  Object.assign(cam, { roll: 0, yaw: 0, pitch: 0, dip: 0, slide: 0, bob: 0, lookY: 1.2, vx: 0, lines: 0, base: 0, wall: 0 });
  shake = 0;
  ensureWorld();
  const u = new URL(location.href);
  u.searchParams.set('seed', seed);
  history.replaceState(null, '', u);
}

function disposeGroup(g) { g.traverse((o) => o.geometry && o.geometry.dispose()); }

function ensureWorld() {
  const need = Math.ceil((pl.z + LZ * 6.5) / ROW) + 4;
  world.ensureRows(need);
  // меш строим, когда уже есть следующий паттерн — нужен для теней на стыке
  while (built < world.instances.length - 1) {
    const m = buildInstanceMesh(world.instances[built++], materials, world);
    meshes.push(m);
    scene.add(m);
  }
  meshes = meshes.filter((m) => {
    if (m.userData.zEnd < pl.z - ROW * 3) {
      scene.remove(m); disposeGroup(m); return false;
    }
    return true;
  });
}

// ---------- физика (всё в плоском мире) ----------
const wrapX = (x) => ((x % W) + W) % W;

function speedNow() {
  const t = Math.min(1, pl.z / P.speedRamp);
  return P.speedStart + (P.speedMax - P.speedStart) * t + pl.boost;
}

const sliding = () => pl.slideT > 0;
const bodyH = () => (sliding() ? P.bodySlide : P.bodyStand);

// Твёрдое в клетке — список интервалов высот [lo, hi]:
// пол снизу, потолок тоннеля, мост, стена во всю высоту. Пропасть — пустой список.
const INF = Infinity;
const SOLID_WALL = [[-INF, INF]];
const SOLID_NONE = [];
function solidsAt(x, z) {
  const ri = Math.floor(z / ROW);
  const row = world.rows[ri];
  if (!row) return [[-INF, 0]];
  const v = row[Math.floor(wrapX(x) / CELL) % COLS];
  if (v === WALL) return SOLID_WALL;
  if (v === VOID) return SOLID_NONE;
  const lz = z - ri * ROW;
  const base = row.b0 + (row.b1 - row.b0) * (lz / ROW);
  const out = [[-INF, base + lv(v) * LEVEL]];
  if (v === BRIDGE && lz > 0.6 && lz < ROW - 0.6) {
    out.push(row.cover ? [base + BRIDGE_BOTTOM, INF] : [base + BRIDGE_BOTTOM, base + BRIDGE_TOP]);
  } else if (row.cover) out.push([base + CEIL_H, INF]);
  return out;
}

// первый интервал, в который упирается тело [y, y+h]
function blockOf(sol, y, h) {
  for (const s of sol) if (s[1] > y + P.step && s[0] < y + h) return s;
  return null;
}
const blocksBody = (sol, y, h) => blockOf(sol, y, h) !== null;

function supportAt(x, z, y) {
  let best = -INF;
  for (const s of solidsAt(x, z)) if (s[1] <= y + P.step && s[1] > best) best = s[1];
  return best;
}

function ceilingAt(x, z, y) {
  let best = INF;
  for (const s of solidsAt(x, z)) if (s[0] > y + P.step && s[0] < best) best = s[0];
  return best;
}

const isWallAt = (x, z) => solidsAt(x, z) === SOLID_WALL;

const laneX = (lane) => lane * CELL + CELL / 2;

// Свайп вбок: копим запрос, выполняем, как только соседняя полоса свободна.
function laneShift(d) {
  if (state !== 'run') return;
  pl.pending = Math.max(-2, Math.min(2, pl.pending + d));
  pl.pendT = P.laneBuffer;
}

function lanePhysics(dt, v, h) {
  const r = P.radius;
  const sideFree = (lane) => {
    for (const oz of [-r * 0.7, r * 0.7]) {
      if (blocksBody(solidsAt(laneX(lane), pl.z + oz), pl.y, h)) return false;
      // на земле в пропасть сбоку не шагаем — ждём, пока появится крыша
      if (pl.grounded && supportAt(laneX(lane), pl.z + oz, pl.y) === -INF) return false;
    }
    return true;
  };
  if (pl.pending !== 0) {
    const d = Math.sign(pl.pending);
    if (pl.wall === d) {
      pl.pending = 0; // свайп в стену, по которой бежим, — ничего
    } else if (sideFree(pl.lane + d)) {
      if (pl.wall) endWallRun();
      pl.lane += d; pl.pending -= d;
    } else if (!pl.wall && pl.wallCool <= 0 && canWallRun(d, v)) {
      pl.pending = 0;
      startWallRun(d);
    } else {
      pl.pendT -= dt;
      if (pl.pendT <= 0) pl.pending = 0;
    }
  }
  const speedK = Math.min(1, Math.max(0, (v - P.speedStart) / (P.speedMax - P.speedStart)));
  const w = P.laneW + (P.laneWFast - P.laneW) * speedK;
  // на стене прижимаемся к ней
  const tx = laneX(pl.lane) + pl.wall * (CELL / 2 - r - 0.12);
  pl.vx += (w * w * (tx - pl.x) - 2 * w * pl.vx) * dt;
  const nx = pl.x + pl.vx * dt;
  const dir = Math.sign(pl.vx);
  const side = nx + dir * r;
  if (dir !== 0 && (blocksBody(solidsAt(side, pl.z - r * 0.7), pl.y, h) || blocksBody(solidsAt(side, pl.z + r * 0.7), pl.y, h))) {
    // упёрлись — мягко возвращаемся на свою полосу
    if (Math.sign(laneX(pl.lane) - pl.x) === dir && !pl.wall) { pl.lane -= dir; pl.pending = 0; shake = Math.max(shake, 0.1); }
    pl.vx = 0;
  } else {
    pl.x = nx;
  }
}

// ---- бег по стене ----
// Свайп в сторону стены (в прыжке или с земли) — прилипаем к ней.
// Если проём в стене откроется совсем скоро — это обычная смена полосы, а не бег по стене.
function canWallRun(d, v) {
  if (sliding()) return false;
  const x = laneX(pl.lane + d);
  const col = Math.floor(wrapX(x) / CELL) % COLS;
  for (const dz of [0, 2, 4, 6]) {
    if (!isWallAt(x, pl.z + dz)) return false;
    if (planterAt(world, Math.floor((pl.z + dz) / ROW), col, -d)) return false; // клумба — не стена
  }
  // в тоннеле под потолком не разбежишься
  if (ceilingAt(pl.x, pl.z, pl.y) < pl.y + 4) return false;
  return true;
}

function startWallRun(d) {
  pl.wall = d;
  pl.wallT = 0;
  pl.vy = Math.max(pl.vy, P.wallLift);
  pl.grounded = false;
  pl.coyote = 0;
  pl.boost = Math.min(P.boostMax, pl.boost + P.wallBoost);
  pl.hopKeep = true;
  if (sliding()) pl.slideT = 0;
  cam.pitch -= 0.03;
}

function endWallRun() {
  pl.wallLast = pl.wall;
  pl.wall = 0;
  pl.wallCool = 0.2;
}

function physicsStep(dt) {
  const r = P.radius;
  const h = bodyH();
  const v = speedNow();

  // вперёд
  const nz = pl.z + v * dt;
  for (const ox of [-r * 0.7, r * 0.7]) {
    const s = blockOf(solidsAt(pl.x + ox, nz + r), pl.y, h);
    if (!s) continue;
    const [lo, hi] = s;
    if (!pl.grounded && hi !== INF && hi - pl.y <= P.mantle && lo <= pl.y + 0.5) {
      // в прыжке и край чуть выше ног — забираемся (паркур)
      pl.y = hi; pl.vy = 0; pl.grounded = true;
      if (pl.wall) endWallRun();
      pl.boost = Math.max(0, pl.boost - 1.5);
      cam.dip = Math.max(cam.dip, 0.25);
    } else if (hi === INF && lo !== -INF && lo > pl.y + h * 0.5
      && lo - h >= supportAt(pl.x + ox, nz + r, lo - h) - 0.01) {
      // потолок тоннеля над головой — пригибаемся, а не разбиваемся
      pl.y = lo - h - 0.01; pl.vy = Math.min(pl.vy, -1); pl.grounded = false;
      cam.dip = Math.max(cam.dip, 0.2);
    } else {
      die();
      return;
    }
  }
  pl.z = nz;

  lanePhysics(dt, v, h);

  // по вертикали
  let ground = -INF, ceil = INF;
  for (const [ox, oz] of [[-r, -r], [r, -r], [-r, r], [r, r]]) {
    ground = Math.max(ground, supportAt(pl.x + ox, pl.z + oz, pl.y));
    ceil = Math.min(ceil, ceilingAt(pl.x + ox, pl.z + oz, pl.y));
  }
  if (pl.grounded && pl.y > ground + 0.01) pl.grounded = false; // сошли с края
  if (pl.wall) {
    pl.wallT += dt;
    // стена кончилась, время вышло — отрываемся и летим дальше
    const wx = laneX(pl.lane + pl.wall);
    if (!isWallAt(wx, pl.z) || planterAt(world, Math.floor(pl.z / ROW), Math.floor(wrapX(wx) / CELL), -pl.wall)
      || pl.wallT > P.wallTime) endWallRun();
  }
  if (!pl.grounded) {
    if (pl.wall) {
      // на стене падаем медленно, но всё сильнее — уводит вниз по дуге
      const k = pl.wallT / P.wallTime;
      pl.vy -= (P.wallGravity + (P.wallGravityEnd - P.wallGravity) * k * k) * dt;
    } else {
      pl.vy -= (pl.vy > 0 ? P.gravityUp : P.gravityDown) * dt;
    }
    pl.y += pl.vy * dt;
    if (pl.y + h > ceil) { pl.y = ceil - h; pl.vy = Math.min(pl.vy, 0); }
    if (pl.y <= ground) {
      // приземление: камера «проседает» тем сильнее, чем быстрее падали
      cam.dip = Math.max(cam.dip, Math.min(0.55, -pl.vy * 0.022));
      pl.y = ground; pl.vy = 0; pl.grounded = true; pl.hopKeep = false;
      if (pl.wall) endWallRun();
      if (pl.slideQueued) { pl.slideQueued = false; startSlide(); }
    }
    // сорвались в пропасть
    if (pl.y < world.baseAt(pl.z) - P.fallDeath) { die(); return; }
  } else {
    pl.y = ground; // ступенька вверх/вниз, рампа
  }
  pl.wallCool -= dt;

  // подкат: заканчивается сам, но не под мостом
  if (pl.slideT > 0) {
    pl.slideT -= dt;
    if (pl.slideT <= 0) {
      if (blocksBody(solidsAt(pl.x, pl.z), pl.y, P.bodyStand) || blocksBody(solidsAt(pl.x, pl.z + r), pl.y, P.bodyStand)) pl.slideT = 0.05;
      else pl.slideEndAt = gameTime;
    }
  }
  // серия подкатов рвётся, если долго не подкатывались
  if (!sliding() && gameTime - pl.slideEndAt > 0.6) pl.slideChain = 0;

  // инерция разгона: тает на земле, держится в воздухе после прыжка из подката
  if (!(pl.hopKeep && !pl.grounded) && !sliding() && !pl.wall) pl.boost = Math.max(0, pl.boost - P.boostDecay * dt);

  pl.coyote = pl.grounded ? P.coyote : pl.coyote - dt;
  pl.jumpBuf -= dt;
  if (pl.jumpBuf > 0 && pl.wall) {
    // прыжок от стены: толчок вверх и на соседнюю полосу, плюс разгон — стена как трамплин
    const d = -pl.wall;
    endWallRun();
    pl.vy = P.jumpV; pl.jumpBuf = 0;
    pl.boost = Math.min(P.boostMax, pl.boost + P.wallJumpBoost);
    pl.hopKeep = true;
    pl.lane += d; pl.pending = 0;
    pl.vx += d * 6;
    pl.wallCool = 0.12;
    cam.pitch += 0.05;
  } else if (pl.jumpBuf > 0 && pl.coyote > 0) {
    const fromSlide = sliding();
    pl.vy = P.jumpV; pl.grounded = false; pl.coyote = 0; pl.jumpBuf = 0;
    if (fromSlide) {
      // slide-hop: прыжок из подката сохраняет разгон
      if (!blocksBody(solidsAt(pl.x, pl.z + r), pl.y, P.bodyStand)) { pl.slideT = 0; pl.hopKeep = true; }
      else pl.vy = 0; // под мостом прыгать некуда
    }
    if (pl.vy > 0) cam.pitch += 0.05;
  }
}

function startSlide() {
  // серия: новый подкат во время предыдущего или сразу после — копится; от 2 подряд — полосы скорости
  pl.slideChain = sliding() || gameTime - pl.slideEndAt < 0.45 ? pl.slideChain + 1 : 1;
  if (pl.slideT <= 0) cam.slideSide = pl.vx > 2 ? -1 : pl.vx < -2 ? 1 : (Math.random() < 0.5 ? -1 : 1);
  pl.slideT = P.slideTime;
  pl.boost = Math.min(P.boostMax, pl.boost + P.slideBoost);
}

function slide() {
  if (state !== 'run') return;
  if (pl.wall) endWallRun();
  if (!pl.grounded) {
    // в воздухе — резко вниз и подкат при приземлении
    pl.vy = Math.min(pl.vy, -P.fastFall);
    pl.slideQueued = true;
    return;
  }
  startSlide();
}

function jump() { if (state === 'run') pl.jumpBuf = P.jumpBuffer; }

function die() {
  if (state !== 'run') return;
  state = 'dead';
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

// ---------- автопилот (?auto) — для тестов: бежит по «живым» клеткам ----------
const AHEAD = 10;
function autopilotStep() {
  const ri = Math.floor(pl.z / ROW);
  const rows = world.rows, reach = world.reach;
  const end = Math.min(rows.length - 1, ri + AHEAD);
  if (end <= ri + 2) return;
  const alive = aliveBackward(rows.slice(ri, end + 1), reach.slice(ri, end + 1));
  const A = (r) => alive[r - ri];
  const cm = (c) => ((c % COLS) + COLS) % COLS;
  const cdist = (a, b) => Math.min(cm(a - b), cm(b - a));
  const code = (r, c) => (rows[r] ? rows[r][cm(c)] : 0);
  const absH = (r, c) => rows[r].b0 + lv(code(r, c)) * LEVEL;
  const cur = cm(pl.lane);
  // следующий ряд — провал? тогда целимся по ряду за ним
  const gap = !A(ri + 1).some(Boolean);
  const nT = gap ? A(ri + 2) : A(ri + 1);
  const n2 = A(gap ? ri + 3 : ri + 2) || nT;
  let best = cur, bscore = 1e9;
  for (let d = -1; d <= 1; d++) {
    const c = cm(cur + d);
    if (!nT[c]) continue;
    if (gap ? d !== 0 || !canJumpOver(rows[ri], rows[ri + 1], rows[ri + 2], c) : !canStep(rows[ri], rows[ri + 1], cur, c)) continue;
    let nd = 99;
    for (let c2 = 0; c2 < COLS; c2++) if (n2[c2]) nd = Math.min(nd, cdist(c, c2));
    const score = nd * 10 + Math.abs(d);
    if (score < bscore) { bscore = score; best = c; }
  }
  // как человек: один свайп, когда решение меняется
  const laneNow = cm(pl.lane + pl.pending);
  if (best !== laneNow && pl.pending === 0 && !pl.wall) laneShift(cm(best - laneNow) === 1 ? 1 : -1);
  const into = (ri + 1) * ROW - pl.z;
  const c1 = code(ri + 1, best), c2 = code(ri + 2, best);
  if (c1 === BRIDGE && into < 2.5 && !sliding() && pl.grounded) slide();
  if (into < 2.6 && into > 0.8 && pl.grounded && !sliding() && !rows[ri + 1].cover) {
    if (c1 === VOID) jump();
    else if (walk(c1) && absH(ri + 1, best) > pl.y + 0.5) jump();
    else if (walk(c1) && absH(ri + 1, best) < pl.y - 0.5 && walk(c2) && c2 !== BRIDGE && absH(ri + 2, best) >= pl.y - 0.1
      && rows[ri + 1].b0 === rows[ri].b1) jump();
  }
}

// ---------- управление ----------
let touch = null;
const SWIPE = 28; // пикселей
canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (state === 'ready') { start(); return; }
  if (state !== 'run') return;
  touch = { id: e.pointerId, x: e.clientX, x0: e.clientX, y0: e.clientY, sx: e.clientX, sy: e.clientY, st: performance.now(), t: performance.now(), swiped: false };
  canvas.setPointerCapture?.(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!touch || e.pointerId !== touch.id) return;
  // свайпы срабатывают сразу, не дожидаясь отпускания пальца; сила свайпа не важна
  const dy = e.clientY - touch.sy, dxs = e.clientX - touch.sx;
  const now = performance.now();
  if (Math.abs(dxs) > SWIPE && Math.abs(dxs) > Math.abs(dy) * 1.1 && now - touch.st < 300) {
    // один жест = одна полоса, как бы далеко ни ушёл палец; развернуть палец обратно — можно
    const dir = dxs > 0 ? 1 : -1;
    if (dir !== touch.hDir) { laneShift(dir); touch.hDir = dir; }
    touch.swiped = true;
    touch.sx = e.clientX; touch.sy = e.clientY; touch.st = now;
  } else if (Math.abs(dy) > SWIPE && Math.abs(dy) > Math.abs(dxs) * 1.1 && now - touch.st < 300) {
    if (dy < 0) jump(); else slide();
    touch.swiped = true;
    touch.sx = e.clientX; touch.sy = e.clientY; touch.st = now; // можно свайпнуть ещё раз, не отпуская
  } else if (now - touch.st > 300) {
    touch.sx = e.clientX; touch.sy = e.clientY; touch.st = now;
  }
});
const endTouch = (e) => {
  if (!touch || e.pointerId !== touch.id) return;
  const moved = Math.hypot(e.clientX - touch.x0, e.clientY - touch.y0);
  if (!touch.swiped && moved < 12 && performance.now() - touch.t < 250) jump(); // короткий тап — прыжок
  touch = null;
};
canvas.addEventListener('pointerup', endTouch);
canvas.addEventListener('pointercancel', endTouch);

window.addEventListener('keydown', (e) => {
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyA', 'KeyD', 'KeyW', 'KeyS', 'Space'].includes(e.code)) e.preventDefault();
  if (state === 'ready' && (e.code === 'Space' || e.code === 'Enter')) { start(); return; }
  if (state === 'dead' && ui.over.classList.contains('show') && e.code === 'Enter') { restart(false); return; }
  if (e.repeat) return;
  if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') jump();
  if (e.code === 'ArrowDown' || e.code === 'KeyS' || e.code === 'ShiftLeft') slide();
  if (e.code === 'ArrowLeft' || e.code === 'KeyA') laneShift(-1);
  if (e.code === 'ArrowRight' || e.code === 'KeyD') laneShift(1);
});

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
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

function updateCamera(dt, running) {
  const v = speedNow();
  cam.slide = damp(cam.slide, sliding() ? 1 : 0, 14, dt);
  cam.dip = damp(cam.dip, 0, 9, dt);
  if (running && pl.grounded && !sliding()) cam.bob += dt * v * 0.85;
  const bobY = running && pl.grounded && !sliding() ? Math.abs(Math.sin(cam.bob)) * 0.06 : 0;
  const bobX = running && pl.grounded && !sliding() ? Math.sin(cam.bob) * 0.03 : 0;

  const eye = P.eyeStand + (P.eyeSlide - P.eyeStand) * cam.slide;
  const eyeY = pl.y + eye - cam.dip + bobY;
  camera.position.set(bobX, eyeY, L);
  camera.up.set(0, 1, 0);
  // Точка схода — на уровне пола текущего яруса (улица, крыши, тоннель).
  // Взгляд мягко подтягивается к ней, чем выше игрок над полом яруса:
  // на земле смотрим почти горизонтально, на крышах — сильнее вниз, к центру.
  // Не жёсткая привязка: максимум ~70% и с задержкой.
  const B = cam.base;
  const rel = eyeY - B;
  const hk = Math.min(1, Math.max(0, (pl.y - B) / (3 * LEVEL)));
  const pull = 0.7 * hk * hk * (3 - 2 * hk);
  const lookTarget = B + rel * 0.75 * (1 - pull) + 0.4 * pull;
  cam.lookY = damp(cam.lookY, lookTarget, 3.5, dt);
  camera.lookAt(0, cam.lookY, 0);

  // наклоны: в сторону движения, в подкате — завал вбок
  // наклоны идут от сглаженной скорости вбок — камера не дёргается при смене полосы
  cam.vx = damp(cam.vx, pl.vx, 7, dt);
  // на стене — завал от стены
  cam.wall = damp(cam.wall, pl.wall, 8, dt);
  cam.roll = damp(cam.roll, -cam.vx * 0.0045 + cam.slide * 0.16 * cam.slideSide + cam.wall * 0.2, 6, dt);
  cam.yaw = damp(cam.yaw, -cam.vx * 0.0025, 5, dt);
  cam.pitch = damp(cam.pitch, pl.grounded ? 0 : Math.max(-0.06, Math.min(0.05, pl.vy * 0.004)), 8, dt);
  let roll = cam.roll;
  if (shake > 0) {
    shake = Math.max(0, shake - dt);
    const k = shake * 0.06;
    camera.position.x += (Math.random() - 0.5) * k * 4;
    camera.position.y += (Math.random() - 0.5) * k * 4;
    roll += (Math.random() - 0.5) * k;
  }
  camera.rotateY(cam.yaw);
  camera.rotateX(cam.pitch);
  camera.rotateZ(roll);

  // ощущение скорости: поле зрения шире на разгоне и в подкате
  const fov = baseFov() + (v - P.speedStart) * 0.55 + cam.slide * 5;
  cam.fov = damp(cam.fov, fov, 6, dt);
  if (Math.abs(camera.fov - cam.fov) > 0.05) { camera.fov = cam.fov; camera.updateProjectionMatrix(); }
}

// ---------- цикл ----------
const _c = new THREE.Vector3();
let last = performance.now();
let fpsAcc = 0, fpsN = 0, fps = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000) * timeScale;
  gameTime += dt;
  last = now;

  if (state === 'run') {
    // мелкие шаги — чтобы на высокой скорости не проскакивать сквозь стены
    const n = Math.ceil(dt / (1 / 120));
    for (let i = 0; i < n && state === 'run'; i++) { if (autopilot) autopilotStep(); physicsStep(dt / n); }
    ensureWorld();
    ui.dist.textContent = `${Math.floor(pl.z)} м`;
  } else if (state === 'ready') {
    // медленный «облёт» на стартовом экране
    pl.z = Math.min(pl.z + dt * 2, ROW * 4);
    ensureWorld();
  }

  // держим координаты маленькими: x по модулю окружности
  const wrapped = wrapX(pl.x);
  if (wrapped !== pl.x) {
    // сдвиг на целый круг: полосы и анимацию переезда сдвигаем вместе
    const shift = wrapped - pl.x;
    pl.lane += Math.round(shift / CELL);
    pl.x = wrapped;
  }

  for (const m of meshes) m.position.set(-pl.x, 0, m.userData.zStart - pl.z);
  // уровень пола яруса — сюда сходится весь мир; на рампах и при спрыгивании плавно
  cam.base = damp(cam.base, world.baseAt(pl.z), 4, dt);
  materials.main.uniforms.uB.value = cam.base;
  materials.star.uniforms.uB.value = cam.base;
  updateCamera(dt, state === 'run');

  if (blurPass) {
    // точка схода (центр круга) на экране
    _c.set(0, cam.base, 0).project(camera);
    blurPass.uniforms.uCenter.value.set(_c.x * 0.5 + 0.5, _c.y * 0.5 + 0.5);
    blurPass.uniforms.uAspect.value = camera.aspect;
    const run = state === 'run' ? 1 : 0;
    const sp = Math.min(1, Math.max(0, (speedNow() - 12) / 14));
    // сильнее на разгоне, в подкате и при бусте после подката
    blurPass.uniforms.uStrength.value = run * (0.04 + sp * 0.11 + cam.slide * 0.05 + pl.boost * 0.006);
    blurPass.uniforms.uLateral.value.set(run * -cam.vx * 0.0012, 0);
    const linesT = Math.max(Math.min(1, Math.max(0, (pl.slideChain - 1) / 3)), pl.wall ? 0.55 : 0);
    cam.lines = damp(cam.lines, run * linesT, linesT > 0 ? 6 : 2.5, dt);
    blurPass.uniforms.uLines.value = cam.lines;
    blurPass.uniforms.uTime.value = gameTime;
  }
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
window.__game = { materials, cam, get state() { return state; }, pl, start, jump, slide, get seed() { return seed; }, get world() { return world; } };
