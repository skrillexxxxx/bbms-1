import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import {
  World, CELL, ROW, W, L, LZ, COLS, WALL, BRIDGE, VOID, RUNWALL, POOL, LAUNCH, LAUNCH_ROWS, LEVEL, BRIDGE_BOTTOM, BRIDGE_TOP, CEIL_H,
  canStep, canJumpOver, aliveBackward, walk, lv,
} from './world.js';
import { createMaterial, createStarMaterial, buildInstanceMesh } from './render.js';
import { createSound } from './sound.js';
import { createRecorder, shareFile } from './recorder.js';
import { loadMonkey, createMonkeyMaterial, placeMonkeys } from './monkeys.js';

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
  mantle: 1.5,         // в прыжке край до стольких единиц выше ног — забираемся с ходу
  grab: 2.4,           // край выше (до роста с руками) — зацеп: подтягиваемся, но теряем скорость
  grabTime: 0.7,       // сколько длится потеря скорости после зацепа
  jumpV: 12.2,
  gravityUp: 26,       // вверх легче…
  gravityDown: 29,     // вниз почти так же плавно, как вверх (как в Subway Surfers); резко вниз — свайпом. Пик ≈ 2.9 ед
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
  wallLift: 3.5,       // подброс при касании стены (бег по стене поднимает ~1.5 м, не выше)
  wallJumpV: 8,        // толчок от стены вверх (ниже обычного прыжка: со стены на стену, а не в небо)
  wallGravity: 3,      // в начале почти не падаешь…
  wallGravityEnd: 18,  // …к концу — сильнее, но без пике
  wallExitLift: 1.5,   // сошёл со стены — как вершина прыжка: чуть вверх…
  wallExitGlide: 0.35, // …и столько секунд мягко зависаешь; вниз — свайпом вниз
  glideGravity: 0.45,  // доля обычной гравитации, пока зависаешь
  hoverTime: 0.9,      // сколько можно зависать над пропастью за прыжок…
  hoverGravity: 0.33,  // …падая в треть силы
  fallDeath: 4,        // упал ниже пола яруса на столько — конец
};

const params = new URLSearchParams(location.search);
const useBloom = params.get('bloom') !== '0';
const useBlur = params.get('blur') !== '0';
const useFx = params.get('fx') !== '0'; // шум и хроматика
const showDebug = params.has('debug');
let autopilot = params.has('auto');
const sound = createSound(params.get('sound') !== '0' && !autopilot);
const timeScale = autopilot ? Number(params.get('ts')) || 1 : 1; // для тестов: ускорить время

// ---------- рендер ----------
const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !useBloom, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0xffffff, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 200);
const materials = {
  main: createMaterial({ linearOut: useBloom }), star: createStarMaterial({ linearOut: useBloom }),
  monkey: createMonkeyMaterial({ linearOut: useBloom }),
};
const monkeyReady = loadMonkey();

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
      uGrain: { value: useFx ? 0.045 : 0 },  // цифровой шум
      uCA: { value: useFx ? 0.006 : 0 },     // хроматическая аберрация у краёв (доля экрана в углу)
      uPx: { value: 1 },                     // размер «зерна» шума в пикселях экрана
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
      uniform float uGrain;
      uniform float uCA;
      uniform float uPx;
      float hash(float n) { return fract(sin(n) * 43758.5453); }
      // хеш Дейва Хоскинса: равномерный и без sin
      float hash13(vec3 p3) {
        p3 = fract(p3 * 0.1031);
        p3 += dot(p3, p3.zyx + 31.32);
        return fract((p3.x + p3.y) * p3.z);
      }
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
          // откуда начинается луч: в основном у краёв экрана, к центру — только на максимуме
          float r0 = mix(1.08, 0.78, uLines * uLines) + 0.15 * hash(id * 7.7 + frame * 3.3);
          float grow = smoothstep(r0, r0 + 0.2, rr);                     // тонкий у начала, толще к краю
          float w = (0.08 + 0.3 * hash(id * 3.1 + frame)) * grow;
          float line = 1.0 - smoothstep(w * 0.5, w * 0.5 + 0.06, abs(fa - 0.5));
          float k = on * line * grow * min(1.0, uLines * 1.4);
          // половина лучей тёмные, половина светлые — как в манге
          vec3 ink = hash(id * 5.3 + frame * 1.9) > 0.5 ? vec3(0.04) : vec3(1.0);
          col.rgb = mix(col.rgb, ink, k * 0.7);
        }

        // хроматическая аберрация: красный и синий расходятся от центра экрана, в центре — ноль.
        // Берём не 12 выборок на канал, а только сдвиг цветовой «бахромы» поверх готового кадра:
        // +3 выборки на пиксель
        if (uCA > 0.0) {
          vec2 c = vUv - 0.5;
          vec2 o = c * dot(c, c) * 4.0 * uCA;   // растёт квадратично к краям
          vec3 base = texture2D(tDiffuse, vUv).rgb;
          col.r += texture2D(tDiffuse, vUv + o).r - base.r;
          col.b += texture2D(tDiffuse, vUv - o).b - base.b;
        }

        // цифровой шум: каждый кадр — новый, независимый (кадр — третья координата хеша, а не сдвиг
        // картинки: сдвиг глаз видит как бегущую рябь). Хеш без sin — на мобильных GPU sin больших чисел
        // теряет точность и складывается в полосы. Кадр тут ещё в линейном цвете — шум кладём в гамме
        if (uGrain > 0.0) {
          vec2 p = floor(gl_FragCoord.xy / uPx);
          float f = mod(floor(uTime * 24.0), 97.0);
          float n = hash13(vec3(p, f)) - 0.5;
          vec3 nc = vec3(hash13(vec3(p, f + 101.0)), hash13(vec3(p, f + 211.0)), hash13(vec3(p, f + 307.0))) - 0.5;
          vec3 g = pow(clamp(col.rgb, 0.0, 1.0), vec3(1.0 / 2.2));
          g += uGrain * (n * 0.8 + nc * 0.35);
          col.rgb = pow(clamp(g, 0.0, 1.0), vec3(2.2));
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

// Размер экрана. Запущенная с главного экрана iPhone (без Safari) страница при старте получает
// innerHeight без полосы статус-бара — снизу оставалась белая полоса до первого поворота телефона.
// В режиме приложения берём физический размер экрана (screen на iOS всегда в портретной ориентации).
const standalone = navigator.standalone === true
  || matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches;
function viewSize() {
  let w = window.innerWidth, h = window.innerHeight;
  if (standalone && screen.width && screen.height) {
    const portrait = h >= w;
    const sw = portrait ? Math.min(screen.width, screen.height) : Math.max(screen.width, screen.height);
    const sh = portrait ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
    // только если innerHeight «недобрал» чуть-чуть (статус-бар), а не, скажем, при split view на iPad
    if (sh > h && sh - h < 80 && Math.abs(sw - w) < 2) h = sh;
  }
  return [w, h];
}

function resize() {
  const [w, h] = viewSize();
  document.documentElement.style.setProperty('--app-h', `${h}px`);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.fov = baseFov();
  camera.updateProjectionMatrix();
  if (composer) {
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(w, h);
    bloom.resolution.set(w / 2, h / 2);
    // зерно — целое число пикселей (иначе сетка 1-2-1-2 и муар): на iPhone 2×2 пикселя = точка экрана
    if (blurPass) blurPass.uniforms.uPx.value = Math.max(1, Math.round(renderer.getPixelRatio()));
  }
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 300));
window.visualViewport?.addEventListener('resize', resize);
resize();
// iOS иногда досчитывает размер уже после загрузки — проверяем ещё раз
for (const t of [250, 1000]) setTimeout(resize, t);

// ---------- UI ----------
const $ = (id) => document.getElementById(id);
const rec = createRecorder();
const ui = {
  rec: $('rec'), flag: $('flag'), monk: $('monk'),
  save: $('save'), seeds: $('seeds'), seedList: $('seed-list'),
  start: $('start'), over: $('over'), hud: $('hud'),
  dist: $('dist'), debug: $('debug'), overDist: $('over-dist'),
  overInfo: $('over-info'), best: $('best'),
};

let best = 0;
try { best = Number(localStorage.getItem('city-best')) || 0; } catch { /* приватный режим */ }

// ---------- состояние игры ----------
let world, meshes, built, seed;
let monkeys = [];        // { mesh, x, y, z, phase, taken } — обезьянки на построенных паттернах
let runMonkeys = 0;      // собрано за забег
let totalMonkeys = 0;    // собрано за всё время
try { totalMonkeys = Number(localStorage.getItem('sdwg-monkeys')) || 0; } catch { /* приватный режим */ }
const pl = {
  x: 0, z: 0, y: 0, vx: 0, vy: 0, grounded: true,
  lane: 6, pending: 0, pendT: 0,
  coyote: 0, jumpBuf: 0, slideT: 0, slideQueued: false, boost: 0, hopKeep: false,
  slideChain: 0, slideEndAt: -9,
  wall: 0, wallT: 0, wallCool: 0, wallLast: 0, autoAttach: 0, autoT: 0, grabT: 0, launch: null, glideT: 0, longT: 0, longG: 1, hover: 0, longLane: null,
};
const cam = { roll: 0, yaw: 0, pitch: 0, dip: 0, slide: 0, bob: 0, fov: 82, wallStep: 0, slideSide: 1, lookY: 1.2, vx: 0, lines: 0, base: 0, wall: 0, fly: 0, baseV: 0, lookV: 0 };
let gameTime = 0;
let state = 'ready';
let shake = 0;

function newSeed() { return Math.floor(Math.random() * 1e6); }

function reset(s) {
  seed = s;
  for (const m of meshes || []) { scene.remove(m); disposeGroup(m); }
  meshes = [];
  monkeys = [];
  built = 0;
  world = new World(seed);
  Object.assign(pl, {
    x: 6 * CELL + CELL / 2, z: ROW * 0.5, y: 0, vx: 0, vy: 0, grounded: true,
    coyote: 0, jumpBuf: 0, slideT: 0, slideQueued: false, boost: 0, hopKeep: false,
    slideChain: 0, slideEndAt: -9, wall: 0, wallT: 0, wallCool: 0, wallLast: 0, autoAttach: 0, autoT: 0, grabT: 0, launch: null, glideT: 0, longT: 0, hover: 0, longLane: null, fromLong: false,
  });
  Object.assign(pl, { lane: 6, pending: 0, pendT: 0 });
  Object.assign(cam, { roll: 0, yaw: 0, pitch: 0, dip: 0, slide: 0, bob: 0, lookY: 1.2, vx: 0, lines: 0, base: 0, wall: 0, fly: 0, baseV: 0, lookV: 0 });
  shake = 0;
  ensureWorld();
  const u = new URL(location.href);
  u.searchParams.set('seed', seed);
  history.replaceState(null, '', u);
}

function disposeGroup(g) { g.traverse((o) => o.geometry && o.material !== materials.monkey && o.geometry.dispose()); }

function ensureWorld() {
  const need = Math.ceil((pl.z + LZ * 6.5) / ROW) + 4;
  world.ensureRows(need);
  // меш строим, когда уже есть следующий паттерн — нужен для теней на стыке
  while (built < world.instances.length - 1) {
    const inst = world.instances[built++];
    const m = buildInstanceMesh(inst, materials, world);
    monkeys.push(...placeMonkeys(world, inst, m, materials.monkey));
    meshes.push(m);
    scene.add(m);
  }
  meshes = meshes.filter((m) => {
    if (m.userData.zEnd < pl.z - ROW * 3) {
      scene.remove(m); disposeGroup(m); return false;
    }
    return true;
  });
  monkeys = monkeys.filter((k) => k.z > pl.z - ROW * 3);
}

// ---------- физика (всё в плоском мире) ----------
const wrapX = (x) => ((x % W) + W) % W;

function speedNow() {
  const t = Math.min(1, pl.z / P.speedRamp);
  const v = P.speedStart + (P.speedMax - P.speedStart) * t + pl.boost;
  // после зацепа за край скорость проседает и плавно возвращается
  const g = pl.grabT / P.grabTime;
  return v * (1 - 0.6 * g * g);
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
  if (v === WALL || v === RUNWALL) return SOLID_WALL;
  if (v === VOID || v === POOL) return SOLID_NONE;
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

const isRunwallAt = (x, z) => world.cellAt(wrapX(x), z) === RUNWALL;

const laneX = (lane) => lane * CELL + CELL / 2;

// Свайп вбок: копим запрос, выполняем, как только соседняя полоса свободна.
function laneShift(d) {
  if (state !== 'run') return;
  rec.event('in', { a: d < 0 ? 'left' : 'right', z: pl.z });
  // в очереди — не больше одной смены полосы: лишний свайп не «выстрелит» в стену на выходе из поворота
  pl.pending = Math.max(-1, Math.min(1, pl.pending + d));
  // свайп к красной стене, которая ещё впереди, ждёт дольше
  pl.pendT = runwallSoon(d, speedNow()) ? 0.55 : P.laneBuffer;
}

// Длинный прыжок: впереди по своей полосе пропасть хотя бы на 2 ряда, а дальше — красная стена
// рядом с полосой (вплотную или через одну). d — в какую сторону стена (0 — с обеих сторон).
function longJumpTarget(v) {
  // обычный прыжок приземлит в пропасть?
  const reach = Math.min(JUMP_REACH, v * JUMP_AIR);
  // пропасть — это клетка без пола (уступ выше — не пропасть, на него просто запрыгиваем)
  const hole = (dz) => { const c = world.cellAt(wrapX(pl.x), pl.z + dz); return c === VOID || c === POOL; };
  if (!hole(reach) || !hole(reach * 0.6)) return null;
  // красные стены впереди в пределах 3 полос; к стене подлетаем с той стороны,
  // где после неё есть пол (а не с наружной стороны над пропастью)
  const floorAt = (lane, z) => walk(world.cellAt(wrapX(laneX(lane)), z));
  let best = null;
  const side = [null, null, null]; // лучшая стена слева (d = −1) и справа (d = +1)
  for (let k = -3; k <= 3; k++) {
    const wl = pl.lane + k;
    const x = laneX(wl);
    let dz0 = -1;
    for (let dz = 2; dz <= Math.max(26, v * 2); dz += 1) if (isRunwallAt(x, pl.z + dz)) { dz0 = dz; break; }
    if (dz0 < 0) continue;
    let dz1 = dz0;
    while (dz1 < dz0 + 24 && isRunwallAt(x, pl.z + dz1 + 1)) dz1++;
    for (const d of [-1, 1]) {
      const lane = wl - d; // полоса вплотную к стене, стена — со стороны d
      if (!floorAt(lane, pl.z + dz1 + 3) && !floorAt(lane, pl.z + dz1 + 6)) continue;
      const cost = Math.abs(lane - pl.lane) * 10 + dz0;
      if (!best || cost < best.cost) best = { cost, lane, d, dz: dz0 };
      if (!side[d + 1] || cost < side[d + 1].cost) side[d + 1] = { cost, lane, d, dz: dz0 };
    }
  }
  // красные стены с обеих сторон (коридор над пропастью) — сторону выбирает игрок свайпом,
  // а не «ближайшая стена»: иначе из левой полосы всегда тянуло на левую стену.
  // Прыжок всё равно длинный — долетаем до стен и висим, пока не свайпнут.
  if (side[0] && side[2]) return { cost: best.cost, lane: pl.lane, d: 0, dz: Math.min(side[0].dz, side[2].dz) };
  return best;
}

// Красная стена сбоку — сейчас или в ближайшие ~0.5 с бега?
function runwallSoon(d, v) {
  const x = laneX(pl.lane + d); // d может быть и 2·направление — стена через полосу
  const reach = Math.max(4, v * 0.5);
  for (let dz = 0; dz <= reach; dz += 1) if (isRunwallAt(x, pl.z + dz)) return true;
  return false;
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
    // свайп туда же, куда уже ведёт длинный прыжок, — просто подтверждение; в другую сторону — отмена подсказки
    const lead = pl.longLane != null ? Math.sign(pl.longLane - pl.lane) : 0;
    if (lead === -d) { pl.autoAttach = 0; pl.longLane = null; }
    else if (lead === 0 && pl.autoAttach === -d) pl.autoAttach = 0;
    if (lead === d) {
      pl.pending = 0;
    } else if (pl.wall === d) {
      pl.pending = 0; // свайп в стену, по которой бежим, — ничего
    } else if (pl.wall === -d) {
      wallKick(); // свайп от стены — толчок, прямо к стене напротив
    } else if (!pl.wall && runwallSoon(d, v)) {
      // сбоку вот-вот начнётся красная стена — это свайп «на стену», а не в пропасть:
      // ждём её и прилипаем, как только она рядом
      if (pl.wallCool <= 0 && canWallRun(d)) { pl.pending = 0; startWallRun(d); }
      else { pl.pendT -= dt; if (pl.pendT <= 0) pl.pending = 0; }
    } else if (sideFree(pl.lane + d)) {
      if (pl.wall) endWallRun();
      // красная стена через полосу — одним свайпом прямо к ней, прилипнем сами
      if (!pl.wall && runwallSoon(2 * d, v)) { pl.autoAttach = d; pl.autoT = 0.7; }
      pl.lane += d; pl.pending -= d;
    } else if (!pl.wall && pl.wallCool <= 0 && canWallRun(d)) {
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
// Бегать можно только по красным стенам (как Runner Vision в Mirror's Edge).
function canWallRun(d) {
  if (sliding()) return false;
  const x = laneX(pl.lane + d);
  for (const dz of [0, 2]) if (!isRunwallAt(x, pl.z + dz)) return false;
  // в тоннеле под потолком не разбежишься
  if (ceilingAt(pl.x, pl.z, pl.y) < pl.y + 4) return false;
  return true;
}

function startWallRun(d) {
  rec.event('wall', { d, z: pl.z, y: pl.y, lane: pl.lane });
  pl.wall = d;
  pl.fromLong = false;
  pl.jumpBuf = 0; // прыжок, нажатый до прилипания, — не толчок от стены сразу же
  pl.wallT = 0;
  // подброс — только на первой стене; на второй (после толчка) не набираем высоту, а держим её
  pl.vy = pl.wallLast ? Math.max(0.5, Math.min(pl.vy, 2)) : P.wallLift;
  pl.grounded = false;
  pl.coyote = 0;
  pl.boost = Math.min(P.boostMax, pl.boost + P.wallBoost);
  pl.hopKeep = true;
  if (sliding()) pl.slideT = 0;
  cam.pitch -= 0.03;
}

// Толчок от стены: вверх и вбок. Если напротив (до 3 полос) есть красная стена —
// летим прямо к ней и прилипаем сами: со стены на стену — одним свайпом.
function wallKick() {
  const d = -pl.wall;
  rec.event('kick', { d, z: pl.z, y: pl.y });
  endWallRun();
  pl.vy = P.wallJumpV * jumpScale(speedNow());
  pl.jumpBuf = 0; pl.pending = 0;
  pl.boost = Math.min(P.boostMax, pl.boost + P.wallJumpBoost);
  pl.hopKeep = true;
  const open = (lane) => { const v = world.cellAt(wrapX(laneX(lane)), pl.z); return v !== WALL && v !== RUNWALL; };
  let target = open(pl.lane + d) ? pl.lane + d : pl.lane, attach = 0;
  for (let k = 1; k <= 3; k++) {
    const lane = pl.lane + d * k;
    if (!open(lane)) break;
    const wx = laneX(lane + d);
    if (isRunwallAt(wx, pl.z + 2) || isRunwallAt(wx, pl.z + 5)) { target = lane; attach = d; break; }
  }
  pl.lane = target;
  pl.autoAttach = attach;
  pl.autoT = 0.7;
  pl.vx += d * 6;
  pl.wallCool = 0.1;
  cam.pitch += 0.05;
}

function endWallRun() {
  rec.event('wallEnd', { d: pl.wall, z: pl.z, y: pl.y });
  pl.wallLast = pl.wall;
  pl.wall = 0;
  pl.wallCool = 0.2;
}

// На скорости прыжок становится резче: та же высота, но дальность не больше ~12 м (3 ряда) —
// иначе на разгоне перелетаешь место, где надо приземлиться и прыгнуть снова.
const JUMP_AIR = 0.91;   // время в воздухе обычного прыжка, с
const JUMP_REACH = 12;
const jumpScale = (v) => Math.max(1, (v * JUMP_AIR) / JUMP_REACH);

// ---- трамплин: полёт по заранее рассчитанной дуге — приземление гарантировано ----
function startLaunch() {
  const ri = Math.floor(pl.z / ROW);
  const land = world.rows[ri + LAUNCH_ROWS];
  if (!land) return;
  if (pl.wall) endWallRun();
  pl.slideT = 0; pl.pending = 0; pl.autoAttach = 0;
  const y1 = land.b0;
  rec.event('launch', { z: pl.z, y: pl.y });
  pl.launch = { z0: pl.z, z1: (ri + LAUNCH_ROWS) * ROW + 1.5, y0: pl.y, y1, yc: Math.max(pl.y, y1) + 12 };
  pl.grounded = false;
  pl.boost = Math.min(P.boostMax, pl.boost + 3);
  pl.hopKeep = true;
  shake = Math.max(shake, 0.12);
}

function launchStep(dt, v) {
  const L0 = pl.launch;
  pl.z += v * dt;
  const t = Math.min(1, (pl.z - L0.z0) / (L0.z1 - L0.z0));
  const y = (1 - t) * (1 - t) * L0.y0 + 2 * t * (1 - t) * L0.yc + t * t * L0.y1;
  pl.vy = (y - pl.y) / dt;
  pl.y = y;
  pl.vx += (P.laneW * P.laneW * (laneX(pl.lane) - pl.x) - 2 * P.laneW * pl.vx) * dt;
  pl.x += pl.vx * dt;
  if (t >= 1) {
    cam.dip = Math.max(cam.dip, 0.55);
    pl.y = L0.y1; pl.vy = 0; pl.grounded = true; pl.hopKeep = false;
    pl.launch = null;
  }
}

function physicsStep(dt) {
  const r = P.radius;
  const h = bodyH();
  const v = speedNow();
  if (pl.launch) { launchStep(dt, v); return; }

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
    } else if (!pl.grounded && hi !== INF && hi - pl.y <= P.grab && lo <= pl.y + 0.5 && !sliding()) {
      // прыгнул, но не долетел — край на уровне рук: зацеп и подтягивание,
      // не смерть, а потеря скорости. С земли без прыжка — врезаешься, как раньше
      pl.y = hi; pl.vy = 0; pl.grounded = true;
      if (pl.wall) endWallRun();
      pl.boost = 0; pl.hopKeep = false;
      pl.grabT = P.grabTime;
      rec.event('grab', { z: pl.z, y: pl.y });
      cam.dip = Math.max(cam.dip, 0.55);
      cam.pitch -= 0.08;
      shake = Math.max(shake, 0.15);
    } else if (hi === INF && lo !== -INF && lo > pl.y + h * 0.5
      && lo - h >= supportAt(pl.x + ox, nz + r, lo - h) - 0.01) {
      // потолок тоннеля над головой — пригибаемся, а не разбиваемся
      pl.y = lo - h - 0.01; pl.vy = Math.min(pl.vy, -1); pl.grounded = false;
      cam.dip = Math.max(cam.dip, 0.2);
    } else {
      die('crash');
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
    if (!isRunwallAt(laneX(pl.lane + pl.wall), pl.z) || pl.wallT > P.wallTime) {
      // стена кончилась сама — не роняем к земле, а отпускаем, как на вершине прыжка
      endWallRun();
      pl.vy = Math.max(pl.vy, P.wallExitLift);
      pl.glideT = P.wallExitGlide;
    }
  }
  if (!pl.grounded) {
    if (pl.wall) {
      // на стене падаем медленно, но всё сильнее — уводит вниз по дуге
      const k = pl.wallT / P.wallTime;
      pl.vy -= (P.wallGravity + (P.wallGravityEnd - P.wallGravity) * k * k) * dt;
    } else {
      const js = pl.longT > 0 ? 1 : jumpScale(v); // длинный прыжок рассчитан сам — без поправки на скорость
      let glide = pl.longT > 0 ? pl.longG : pl.glideT > 0 ? P.glideGravity : 1;
      // над пропастью после вершины — зависаем: есть время понять, куда свернуть. Вниз — свайпом вниз
      if (pl.vy <= 0 && ground === -INF && pl.hover > 0) { glide = Math.min(glide, P.hoverGravity); pl.hover -= dt; }
      // на скорости вверх — резче (короче прыжок), а вниз тяжелеет мягче
      const g = pl.vy > 0 ? P.gravityUp * js * js : P.gravityDown * js;
      pl.vy -= g * glide * dt;
    }
    pl.y += pl.vy * dt;
    if (pl.y + h > ceil) { pl.y = ceil - h; pl.vy = Math.min(pl.vy, 0); }
    if (pl.y <= ground) {
      // приземление: камера «проседает» тем сильнее, чем быстрее падали
      cam.dip = Math.max(cam.dip, Math.min(0.55, -pl.vy * 0.022));
      pl.y = ground; pl.vy = 0; pl.grounded = true; pl.hopKeep = false;
      if (pl.wall) endWallRun();
      pl.wallLast = 0;
      // приземлились после длинного прыжка, не долетев до стены, — подсказка больше не нужна
      if (pl.fromLong) { pl.fromLong = false; pl.autoAttach = 0; pl.longLane = null; }
      if (pl.slideQueued) { pl.slideQueued = false; startSlide(); }
    }
    // сорвались в пропасть / упали в бассейн
    const base = world.baseAt(pl.z);
    // с небоскрёба — дольше видно, как падаешь
    const depth = world.cellAt(wrapX(pl.x), pl.z) === POOL ? 0.4 : base > 20 ? 12 : P.fallDeath;
    if (pl.y < base - depth) { die('fall'); return; }
  } else {
    pl.y = ground; // ступенька вверх/вниз, рампа
  }
  pl.wallCool -= dt;
  if (pl.grounded && world.cellAt(wrapX(pl.x), pl.z) === LAUNCH) startLaunch();
  pl.grabT = Math.max(0, pl.grabT - dt);
  pl.glideT = pl.grounded || pl.wall ? 0 : Math.max(0, pl.glideT - dt);
  pl.longT = pl.grounded || pl.wall ? 0 : Math.max(0, pl.longT - dt);
  if (pl.grounded || pl.wall) pl.hover = P.hoverTime;

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
  // длинный прыжок: смещаемся к нужной полосе по одной, когда следующая впереди свободна
  if (pl.longLane !== null && pl.longLane !== undefined) {
    if (pl.grounded || pl.wall || pl.lane === pl.longLane) pl.longLane = null;
    else {
      const nl = pl.lane + Math.sign(pl.longLane - pl.lane);
      let clear = true;
      for (let dz = -1; dz <= 6 && clear; dz += 1) {
        const c = world.cellAt(wrapX(laneX(nl)), pl.z + dz);
        if (c === WALL || c === RUNWALL) clear = false;
      }
      if (clear && Math.abs(pl.x - laneX(pl.lane)) < 1.5) pl.lane = nl;
    }
  }
  // в полёте красная стена прямо по курсу — не разбиваемся о торец, а уходим на соседнюю
  // открытую полосу и бежим по ней (своё направление свайпа — в приоритете)
  if (!pl.grounded && !pl.wall && !pl.launch) {
    const za = pl.z + r + v * 0.3;
    if (isRunwallAt(laneX(pl.lane), za)) {
      const open = (lane) => { const c = world.cellAt(wrapX(laneX(lane)), za); return c !== WALL && c !== RUNWALL; };
      const pref = pl.autoAttach ? -pl.autoAttach : Math.sign(pl.vx) || -1;
      for (const side of [pref, -pref]) {
        if (!open(pl.lane + side)) continue;
        pl.lane += side;
        pl.autoAttach = -side; pl.autoT = 0.8;
        break;
      }
    }
  }
  // прилипаем к стене напротив, долетев до неё
  if (pl.autoAttach && !pl.wall && Math.abs(pl.x - laneX(pl.lane)) < 1.2 && canWallRun(pl.autoAttach)) {
    const d = pl.autoAttach;
    pl.autoAttach = 0;
    startWallRun(d);
  }
  pl.autoT -= dt;
  if (pl.autoT <= 0) pl.autoAttach = 0;
  if (pl.jumpBuf > 0 && pl.wall) {
    // прыжок на стене — тот же толчок, что и свайп от стены
    wallKick();
  } else if (pl.jumpBuf > 0 && pl.coyote > 0) {
    const fromSlide = sliding();
    pl.vy = P.jumpV * jumpScale(v); pl.grounded = false; pl.coyote = 0; pl.jumpBuf = 0;
    // впереди длинная пропасть, а за ней красная стена — прыжок дольше и тянет к стене
    const lj = longJumpTarget(v);
    if (lj) {
      // долетаем ровно до начала стены: та же высота, но гравитация слабее — дольше парим
      const t = Math.min(2.2, Math.max(JUMP_AIR, (lj.dz + 2) / v));
      pl.longG = (JUMP_AIR / t) * (JUMP_AIR / t);
      pl.longT = t;
      pl.vy = P.jumpV * Math.sqrt(pl.longG); // та же высота прыжка, просто медленнее
      pl.longLane = lj.lane; // летим к полосе вплотную к стене — по одной полосе, огибая башни
      pl.autoAttach = lj.d; pl.autoT = t + 0.5;
      pl.fromLong = true;
      rec.event('longJump', { z: pl.z, lane: lj.lane, d: lj.d, dz: lj.dz, air: t });
    }
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
  rec.event('in', { a: 'down', z: pl.z });
  if (pl.wall) endWallRun();
  pl.glideT = 0; pl.hover = 0; pl.longT = 0;
  if (!pl.grounded) {
    // в воздухе — резко вниз и подкат при приземлении
    pl.vy = Math.min(pl.vy, -P.fastFall);
    pl.slideQueued = true;
    return;
  }
  startSlide();
}

function jump() { if (state === 'run') { rec.event('in', { a: 'jump', z: pl.z }); pl.jumpBuf = P.jumpBuffer; } }

// ---------- сохранённые сиды ----------
const SEEDS_KEY = 'sdwg-seeds';
function loadSeeds() {
  try { return JSON.parse(localStorage.getItem(SEEDS_KEY)) || []; } catch { return []; }
}
function storeSeeds(list) {
  try { localStorage.setItem(SEEDS_KEY, JSON.stringify(list)); } catch { /* приватный режим */ }
}
const savedSeed = (sd) => loadSeeds().find((e) => e.seed === sd);
let lastRun = 0;

function updateSaveButton() {
  const saved = savedSeed(seed);
  ui.save.textContent = saved ? 'Сохранён ✓' : 'Сохранить сид';
  ui.save.disabled = !!saved;
}

function saveCurrentSeed() {
  const list = loadSeeds();
  if (!list.some((e) => e.seed === seed)) {
    list.unshift({ seed, name: `Город ${seed}`, best: lastRun, at: Date.now() });
    storeSeeds(list);
  }
  updateSaveButton();
}

function renderSeeds() {
  const list = loadSeeds();
  ui.seedList.textContent = '';
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'seed-empty';
    empty.textContent = 'Пока пусто. Сохранить город можно после забега.';
    ui.seedList.append(empty);
    return;
  }
  for (const e of list) {
    const row = document.createElement('div');
    row.className = 'seed-row';
    const info = document.createElement('div');
    info.className = 'seed-info';
    const name = document.createElement('div');
    name.className = 'seed-name';
    name.textContent = e.name;
    const meta = document.createElement('div');
    meta.className = 'seed-meta';
    meta.textContent = `seed ${e.seed} · рекорд ${e.best || 0} м`;
    info.append(name, meta);
    const play = document.createElement('button');
    play.textContent = 'Играть';
    play.addEventListener('click', () => { sound.unlock(); ui.seeds.classList.remove('show'); reset(e.seed); start(); });
    const rename = document.createElement('button');
    rename.className = 'ghost small';
    rename.textContent = '✎';
    rename.title = 'Переименовать';
    rename.addEventListener('click', () => {
      const n = prompt('Название города', e.name);
      if (n === null || !n.trim()) return;
      const l = loadSeeds();
      const it = l.find((x) => x.seed === e.seed);
      if (it) { it.name = n.trim().slice(0, 40); storeSeeds(l); }
      renderSeeds();
    });
    const del = document.createElement('button');
    del.className = 'ghost small';
    del.textContent = '✕';
    del.title = 'Удалить';
    del.addEventListener('click', () => {
      if (!confirm(`Удалить «${e.name}»?`)) return;
      storeSeeds(loadSeeds().filter((x) => x.seed !== e.seed));
      renderSeeds();
    });
    row.append(info, play, rename, del);
    ui.seedList.append(row);
  }
}

function die(cause = '?') {
  if (state !== 'run') return;
  rec.event('die', { cause, z: pl.z, x: pl.x, y: pl.y, lane: pl.lane });
  if (slideSnd) { slideSnd = false; sound.slide(false, true); }
  state = 'dead';
  shake = 0.6;
  sound.muffle(true);
  const meters = Math.floor(pl.z);
  lastRun = meters;
  // рекорд по сохранённому городу
  const list = loadSeeds();
  const it = list.find((e) => e.seed === seed);
  if (it && meters > (it.best || 0)) { it.best = meters; storeSeeds(list); }
  updateSaveButton();
  if (meters > best) {
    best = meters;
    try { localStorage.setItem('city-best', String(best)); } catch { /* ignore */ }
  }
  const info = world.infoAt(pl.z + 1);
  ui.overDist.textContent = `${meters} м`;
  ui.overInfo.textContent = `seed ${seed} · ${info.name} (#${info.inst}) · ряд ${info.local + 1}/${info.total}`;
  ui.best.textContent = `рекорд ${best} м` + (runMonkeys || totalMonkeys ? ` · обезьянки ${runMonkeys} (всего ${totalMonkeys})` : '');
  setTimeout(() => { if (state === 'dead' && !ui.seeds.classList.contains('show')) ui.over.classList.add('show'); }, 450);
}

function start() {
  ui.start.classList.remove('show');
  ui.over.classList.remove('show');
  ui.hud.classList.add('show');
  state = 'run';
  sound.muffle(false);
  runMonkeys = 0;
  updateMonkeyHud();
  rec.begin({
    seed, url: location.href, ua: navigator.userAgent,
    screen: `${innerWidth}x${innerHeight}@${devicePixelRatio}`, autopilot,
  });
}

// ---------- автопилот (?auto) — для тестов: бежит по «живым» клеткам ----------
const AHEAD = 10;
function autopilotStep() {
  if (pl.launch) return;
  const ri = Math.floor(pl.z / ROW);
  const rows = world.rows, reach = world.reach;
  let end = Math.min(rows.length - 1, ri + AHEAD);
  // окно не должно кончаться посреди пропасти — иначе всё впереди «мёртвое»
  while (end < rows.length - 1 && !reach[end].some(Boolean)) end++;
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
  const into = (ri + 1) * ROW - pl.z;
  // бег по стене: на стене — держимся, пока впереди пропасть; стена кончается — прыгаем к следующей
  const passable = (r, c) => { const v = code(r, c); return v !== WALL && v !== RUNWALL; };
  if (pl.wall) {
    const d = pl.wall;
    const zA = pl.z + speedNow() * 0.22;
    const rA = Math.floor(zA / ROW);
    const ends = world.cellAt(wrapX(laneX(pl.lane + d)), zA) !== RUNWALL;
    if (ends || pl.wallT > 1.1) {
      // впереди пол — просто спрыгиваем; иначе — толчок на соседнюю полосу
      if (!walk(code(rA, cur)) && !walk(code(rA + 1, cur))) jump();
    }
    return;
  }
  if (pl.autoAttach && !pl.grounded) return; // летим к стене напротив
  // пропасть длиннее прыжка — к красной стене
  for (const g of [ri + 1, ri + 2]) {
    if (!pl.grounded || walk(code(g, cur)) || !passable(g, cur) || walk(code(g + 1, cur))) continue;
    for (const d of [-1, 1]) {
      if (code(g, cur + d) === RUNWALL) {
        if (g === ri + 1 && code(ri, cur + d) === RUNWALL && into < 3.2) laneShift(d);
        return;
      }
    }
    // стена через полосу — перестраиваемся к ней заранее
    for (const d of [-1, 1]) {
      if (code(g, cur + 2 * d) === RUNWALL && walk(code(ri, cur + d)) && pl.pending === 0 && pl.lane === Math.round((pl.x - CELL / 2) / CELL)) { laneShift(d); return; }
    }
  }
  // как человек: один свайп, когда решение меняется
  const laneNow = cm(pl.lane + pl.pending);
  if (best !== laneNow && pl.pending === 0 && !pl.wall) laneShift(cm(best - laneNow) === 1 ? 1 : -1);
  const c1 = code(ri + 1, best), c2 = code(ri + 2, best);
  if (c1 === BRIDGE && into < 2.5 && !sliding() && pl.grounded) slide();
  if (into < 2.6 && into > 0.8 && pl.grounded && !(sliding() && c1 === BRIDGE)) {
    if ((c1 === VOID || c1 === POOL) && walk(c2)) jump();
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
  sound.unlock();
  if (state === 'ready') { start(); return; }
  if (state !== 'run') return;
  rec.event('touch', { x: e.clientX, y: e.clientY });
  touch = { id: e.pointerId, x: e.clientX, x0: e.clientX, y0: e.clientY, sx: e.clientX, sy: e.clientY, st: performance.now(), t: performance.now(), swiped: false };
  canvas.setPointerCapture?.(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!touch || e.pointerId !== touch.id) return;
  // свайпы срабатывают сразу, не дожидаясь отпускания пальца; сила свайпа не важна
  const dy = e.clientY - touch.sy, dxs = e.clientX - touch.sx;
  const now = performance.now();
  if (Math.abs(dxs) > SWIPE && Math.abs(dxs) > Math.abs(dy) * 1.1 && now - touch.st < 300) {
    // один жест = одно действие вбок, как бы далеко ни ушёл палец и куда бы ни дрогнул обратно:
    // иначе на стене дрожание пальца кидает со стены на стену. Обратно — новым свайпом
    const dir = dxs > 0 ? 1 : -1;
    if (!touch.hDir) { laneShift(dir); touch.hDir = dir; }
    touch.swiped = true;
    touch.sx = e.clientX; touch.sy = e.clientY; touch.st = now;
  } else if (Math.abs(dy) > SWIPE && Math.abs(dy) > Math.abs(dxs) * 1.1 && now - touch.st < 300) {
    // один жест = одно действие вверх и одно вниз: длинный свайп раньше давал 3–4 прыжка подряд,
    // а на стене каждый лишний прыжок — толчок на стену напротив и обратно
    const dir = dy < 0 ? -1 : 1;
    if (touch.vDir !== dir) { if (dir < 0) jump(); else slide(); touch.vDir = dir; }
    touch.swiped = true;
    touch.sx = e.clientX; touch.sy = e.clientY; touch.st = now; // не отпуская, можно свайпнуть в другую сторону
  } else if (now - touch.st > 300) {
    touch.sx = e.clientX; touch.sy = e.clientY; touch.st = now;
  }
});
const endTouch = (e) => {
  if (!touch || e.pointerId !== touch.id) return;
  const moved = Math.hypot(e.clientX - touch.x0, e.clientY - touch.y0);
  rec.event('release', { dx: e.clientX - touch.x0, dy: e.clientY - touch.y0, ms: performance.now() - touch.t, swiped: touch.swiped });
  if (!touch.swiped && moved < 12 && performance.now() - touch.t < 250) jump(); // короткий тап — прыжок
  touch = null;
};
canvas.addEventListener('pointerup', endTouch);
canvas.addEventListener('pointercancel', endTouch);

window.addEventListener('keydown', (e) => {
  sound.unlock();
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
document.addEventListener('touchmove', (e) => { if (!e.target.closest?.('#seed-list')) e.preventDefault(); }, { passive: false });

// ---------- обезьянки ----------
function updateMonkeyHud() {
  ui.monk.textContent = String(runMonkeys);
  ui.monk.classList.toggle('show', runMonkeys > 0);
}
// z0 — где игрок был в начале кадра: за кадр на скорости пролетаем больше метра, проверяем весь отрезок
function collectMonkeys(z0) {
  const px = wrapX(pl.x), py = pl.y + (sliding() ? 0.5 : 1.0);
  for (const k of monkeys) {
    if (k.taken || k.z < z0 - 1.2 || k.z > pl.z + 1.2) continue;
    let dx = Math.abs(k.x - px); dx = Math.min(dx, W - dx);
    if (dx > 1.6 || Math.abs(k.y - py) > 1.7) continue;
    k.taken = gameTime;
    runMonkeys++; totalMonkeys++;
    try { localStorage.setItem('sdwg-monkeys', String(totalMonkeys)); } catch { /* приватный режим */ }
    updateMonkeyHud();
    ui.monk.classList.remove('pop'); void ui.monk.offsetWidth; ui.monk.classList.add('pop');
    sound.step(0.6);
    rec.event('monkey', { z: k.z, x: k.x, n: runMonkeys });
  }
}
function animateMonkeys() {
  for (const k of monkeys) {
    if (k.taken) {
      // подбор: вспышка и быстро растворяется вверх
      const t = (gameTime - k.taken) / 0.25;
      if (t >= 1) { k.mesh.visible = false; continue; }
      k.mesh.scale.setScalar(1 + t * 0.8);
      k.mesh.position.y = k.y + t * 1.2;
      k.mesh.rotation.y += 0.4;
      continue;
    }
    k.mesh.rotation.y = gameTime * 2.2 + k.phase;
    k.mesh.position.y = k.y + Math.sin(gameTime * 3 + k.phase) * 0.12;
  }
}

// ---------- запись забега (для отладки) ----------
let wasGrounded = true;
let wasGroundedSnd = true, airVy = 0; // для звука приземления: скорость падения перед касанием
let slideSnd = false, slideOffT = 0;  // звучит ли скольжение и сколько мы уже не скользим
function recordFrame() {
  if (pl.grounded !== wasGrounded) { rec.event(pl.grounded ? 'land' : 'air', { z: pl.z, y: pl.y, vy: pl.vy }); wasGrounded = pl.grounded; }
  rec.frame(gameTime, {
    z: pl.z, x: pl.x, y: pl.y, vy: pl.vy, v: speedNow(), lane: pl.lane, wall: pl.wall, grounded: pl.grounded ? 1 : 0,
    slide: sliding() ? 1 : 0, pending: pl.pending, autoAttach: pl.autoAttach, longLane: pl.longLane ?? '', longT: pl.longT,
    hover: pl.hover, grabT: pl.grabT, camBase: cam.base, camLook: cam.lookY, camPitch: cam.pitch, fov: camera.fov,
  });
}
const CELL_CH = { [WALL]: '#', [BRIDGE]: 'b', [VOID]: '_', [RUNWALL]: 'w', [POOL]: '~', [LAUNCH]: 'L' };
function runFile() {
  const last = Math.min(world.rows.length - 1, Math.floor(pl.z / ROW) + 12);
  const rows = [];
  for (let r = 0; r <= last; r++) {
    const row = world.rows[r], info = world.rowInfo[r];
    rows.push(`${r} ${Array.from(row, (v) => CELL_CH[v] ?? String(v)).join('')} ${row.b0}..${row.b1}${row.cover ? ' cover' : ''} ${info.name}#${info.inst} ${info.local + 1}/${info.total}`);
  }
  return rec.build({ meta: { meters: Math.floor(pl.z), info: ui.overInfo.textContent, P }, rows });
}
async function sendRecording() {
  if (!rec.has()) return;
  const name = `sdwg-run-${seed}-${Math.floor(pl.z)}m.json`;
  const res = await shareFile(name, JSON.stringify(runFile()));
  if (res !== 'cancelled') { ui.rec.textContent = 'Запись готова ✓'; setTimeout(() => { ui.rec.textContent = 'Отправить запись'; }, 2500); }
}
ui.rec.addEventListener('click', sendRecording);
ui.flag.addEventListener('pointerdown', (e) => {
  e.stopPropagation(); e.preventDefault();
  if (state !== 'run') return;
  rec.flag(pl.z);
  ui.flag.classList.add('hit'); setTimeout(() => ui.flag.classList.remove('hit'), 300);
});

function restart(sameSeed) {
  reset(sameSeed ? seed : newSeed());
  start();
}
$('again').addEventListener('click', () => { sound.unlock(); restart(false); });
$('save').addEventListener('click', saveCurrentSeed);
for (const id of ['open-seeds', 'open-seeds-over']) {
  $(id).addEventListener('click', (e) => { e.stopPropagation(); renderSeeds(); ui.over.classList.remove('show'); ui.seeds.classList.add('show'); });
}
$('close-seeds').addEventListener('click', () => {
  ui.seeds.classList.remove('show');
  if (state === 'dead') ui.over.classList.add('show'); // вернулись к экрану после смерти
});
$('same').addEventListener('click', () => { sound.unlock(); restart(true); });

// ---------- камера ----------
function tierFloor() {
  if (pl.launch) {
    const L0 = pl.launch;
    const t = Math.min(1, Math.max(0, (pl.z - L0.z0) / (L0.z1 - L0.z0)));
    return L0.y0 + (L0.y1 - L0.y0) * t * t * (3 - 2 * t);
  }
  return world.baseAt(pl.z + speedNow() * 0.25);
}

// Высота земли впереди по своей полосе (через ~0.6 с бега): пол яруса плюс высота предмета.
// Перед трамплином — сразу крыша небоскрёба. Над пропастью — пол яруса.
function groundAhead() {
  if (pl.launch) return pl.launch.y1;
  const v = speedNow();
  const x = wrapX(laneX(pl.lane));
  let best = -INF;
  for (const t of [0.35, 0.6, 0.85]) {
    const z = pl.z + v * t;
    const c = world.cellAt(x, z);
    if (c === LAUNCH) {
      const land = world.rows[Math.floor(z / ROW) + LAUNCH_ROWS];
      if (land) return land.b0;
    }
    // предметы учитываем вполовину: на подъёме взгляд тянется вверх, а на одиночных барьерах не качается
    if (walk(c)) best = Math.max(best, world.baseAt(z) + lv(c) * LEVEL * 0.6);
  }
  // впереди стена или пропасть — держим пол яруса
  return best === -INF ? world.baseAt(pl.z + v * 0.6) : best;
}

const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

function updateCamera(dt, running) {
  const v = speedNow();
  cam.slide = damp(cam.slide, sliding() ? 1 : 0, 14, dt);
  cam.dip = damp(cam.dip, 0, 9, dt);
  if (running && pl.grounded && !sliding()) {
    // шаг — в нижней точке покачивания (|sin| = 0), раз в пол-оборота
    const before = Math.floor(cam.bob / Math.PI);
    cam.bob += dt * v * 0.85;
    if (Math.floor(cam.bob / Math.PI) !== before) sound.step();
  } else if (running && pl.wall) {
    // по стене бежим — шаги поверх шороха скольжения, чуть тише и чаще
    const before = Math.floor(cam.wallStep / Math.PI);
    cam.wallStep += dt * v * 1.0;
    if (Math.floor(cam.wallStep / Math.PI) !== before) sound.step(0.75);
  }
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
  // впереди выше (уступы, трамплин на небоскрёб) — взгляд заранее чуть приподнят
  const up = pl.launch ? 0 : Math.min(2.5, Math.max(0, (groundAhead() - pl.y) * 0.3));
  // большой прыжок вниз (с крыши, с небоскрёба): весь полёт смотрим в одну точку — туда, где
  // приземлимся (уровень глаз над местом приземления). Без «вверх-вниз-вверх».
  const landing = tierFloor();
  const bigDrop = !pl.grounded && !pl.launch && !pl.wall && pl.y - landing > 3;
  const lookTarget = bigDrop ? landing + 1.2 : B + rel * 0.75 * (1 - pull) + 0.4 * pull + up;
  const w1 = pl.grounded ? 5.5 : 8;
  cam.lookV += (w1 * w1 * (lookTarget - cam.lookY) - 2 * w1 * cam.lookV) * dt;
  cam.lookY += cam.lookV * dt;
  camera.lookAt(0, cam.lookY, 0);

  // наклоны: в сторону движения, в подкате — завал вбок
  // наклоны идут от сглаженной скорости вбок — камера не дёргается при смене полосы
  cam.vx = damp(cam.vx, pl.vx, 7, dt);
  // на стене — завал от стены
  cam.wall = damp(cam.wall, pl.wall, 8, dt);
  cam.roll = damp(cam.roll, -cam.vx * 0.0045 + cam.slide * 0.16 * cam.slideSide + cam.wall * 0.2, 6, dt);
  cam.yaw = damp(cam.yaw, -cam.vx * 0.0025, 5, dt);
  cam.pitch = damp(cam.pitch, pl.grounded || bigDrop ? 0 : Math.max(-0.06, Math.min(0.05, pl.vy * 0.004)), 8, dt);
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
  cam.fly = damp(cam.fly, pl.launch ? 1 : 0, 4, dt);
  const fov = baseFov() + (v - P.speedStart) * 0.55 + cam.slide * 5 + cam.fly * 12;
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

  const zBefore = pl.z;
  if (state === 'run') {
    // мелкие шаги — чтобы на высокой скорости не проскакивать сквозь стены
    const n = Math.ceil(dt / (1 / 120));
    for (let i = 0; i < n && state === 'run'; i++) { if (autopilot) autopilotStep(); physicsStep(dt / n); }
    ensureWorld();
    ui.dist.textContent = `${Math.floor(pl.z)} м`;
    recordFrame();
    collectMonkeys(zBefore);
    if (pl.grounded && !wasGroundedSnd) sound.land(Math.min(1, Math.max(0, (-airVy - 4) / 16)));
    if (!pl.grounded) airVy = pl.vy;
    wasGroundedSnd = pl.grounded;
    // звук скольжения: подкат по полу или бег по стене. Короткий разрыв (подкат сразу за подкатом,
    // толчок со стены на стену) не обрывает звук — выход звучит, только если не скользим ~0.12 с
    if (sliding() || pl.wall) { slideOffT = 0; if (!slideSnd) { slideSnd = true; sound.slide(true); } }
    else if (slideSnd && (slideOffT += dt) > 0.12) { slideSnd = false; sound.slide(false); }
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
    const dl = Math.round(shift / CELL);
    pl.lane += dl;
    // цель длинного прыжка — тоже номер полосы: без сдвига после шва её «догоняли» по кругу через весь мир
    if (pl.longLane != null) pl.longLane += dl;
    pl.x = wrapped;
  }

  for (const m of meshes) m.position.set(-pl.x, 0, m.userData.zStart - pl.z);
  // уровень пола яруса — сюда сходится весь мир; на рампах и при спрыгивании плавно
  // в полёте (трамплин, прыжок с крыши, подъём) целимся туда, куда приземлимся, а не откуда летим
  // Точка схода (куда сходится весь мир) — пол яруса чуть впереди, без предметов.
  // На трамплине едет вместе с дугой; в полёте догоняет быстрее, чтобы оказаться на месте
  // приземления раньше нас. Плавная пружина без рывков.
  const baseTarget = tierFloor();
  const w0 = pl.grounded ? 4.5 : 7;
  if (pl.launch) { cam.base = baseTarget; cam.baseV = 0; } // дуга и так плавная — точно по ней
  else {
    cam.baseV += (w0 * w0 * (baseTarget - cam.base) - 2 * w0 * cam.baseV) * dt;
    cam.base += cam.baseV * dt;
  }
  materials.main.uniforms.uB.value = cam.base;
  materials.main.uniforms.uTime.value = gameTime;
  // в подземке дымка ближе — пустые коридоры тонут в молочном свете
  const deep = Math.min(1, Math.max(0, -cam.base / 5));
  materials.main.uniforms.uFogNear.value = LZ * (2.2 - 1.0 * deep);
  materials.main.uniforms.uFogFar.value = LZ * (6.0 - 2.6 * deep);
  materials.main.uniforms.uFogColor.value.setRGB(1 - 0.05 * deep, 1 - 0.01 * deep, 1 - 0.02 * deep);
  const high = Math.min(1, Math.max(0, (cam.base - 10) / 25));
  materials.main.uniforms.uHigh.value = high;
  sound.update(deep, state === 'run' ? speedNow() : 0, high);
  materials.star.uniforms.uB.value = cam.base;
  {
    const mu = materials.monkey.uniforms, mm = materials.main.uniforms;
    mu.uB.value = cam.base; mu.uFogNear.value = mm.uFogNear.value; mu.uFogFar.value = mm.uFogFar.value;
    mu.uFogColor.value.copy(mm.uFogColor.value);
    animateMonkeys();
  }
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
    // полосы копятся медленно: на всю силу — только на длинной серии подкатов
    const linesT = Math.max(Math.min(1, Math.max(0, (pl.slideChain - 1) / 6)), pl.wall ? 0.3 : 0, pl.launch ? 0.45 : 0);
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
window.__game = { materials, cam, laneShift, setAuto: (v) => { autopilot = v; }, get state() { return state; }, pl, start, die, jump, runFile, get monkeys() { return monkeys; }, slide, get seed() { return seed; }, get world() { return world; } };
