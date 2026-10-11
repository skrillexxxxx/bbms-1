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
import { createMaterial, createStarMaterial, createDepthMaterial, createSunDepthMaterial, createSparkMaterial, createConeMaterial, buildInstanceMesh } from './render.js';
import { createSound } from './sound.js';
import { createRecorder, shareFile } from './recorder.js';
import { loadMonkey, createMonkeyMaterial, createGlowMaterial, placeMonkeys, monkeyGeometry } from './monkeys.js';

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
  pumpGain: 0.9,       // быстрый свайп вниз в подкате на земле: +скорость, копится без предела
  pumpWindow: 0.4,     // …если с прошлого свайпа прошло меньше этого (с); чем быстрее, тем больше
  pumpDecay: 0.8,      // перестал качать — накачка тает (доля в секунду, но не медленнее 2 м/с²)
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
  glow: createGlowMaterial({ linearOut: useBloom }),
  spark: createSparkMaterial({ linearOut: useBloom }),
  cone: createConeMaterial({ linearOut: useBloom }),
};
const monkeyReady = loadMonkey();
// маска фонаря (снимок пятна реального фонаря); пока не загрузилась — пятно рисуется формулой
new THREE.TextureLoader().load('lamp-cookie.jpg', (tex) => {
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  materials.main.uniforms.uCookie.value = tex;
  materials.main.uniforms.uCookieOn.value = 1;
});
// шейдер обезьянки собираем сразу после загрузки, а не когда первая попадёт в кадр:
// на iPhone сборка шейдера — заметное подвисание посреди забега
monkeyReady.then(() => {
  const g = monkeyGeometry();
  if (!g) return;
  const m = new THREE.Mesh(g, materials.monkey);
  m.frustumCulled = false;
  scene.add(m);
  try { renderer.compile(scene, camera); } catch { /* не страшно */ }
  scene.remove(m);
});

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
      uVig: { value: 0 },                    // ночная виньетка: края экрана в темноту
      uRain: { value: 0 },                   // дождь: косые струи поверх кадра
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
      uniform float uVig;
      uniform float uRain;
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

        // дождь: три слоя косых струй — ближние крупнее, быстрее и ярче
        if (uRain > 0.001) {
          vec2 p = vec2((vUv.x - 0.5) * uAspect, vUv.y);
          float rain = 0.0;
          for (int L = 0; L < 3; L++) {
            float fl = float(L);
            vec2 q = p;
            q.x += q.y * (0.1 + 0.04 * fl);              // наклон: ветер и наш бег вперёд
            float cols = 26.0 + fl * 30.0;
            float id = floor(q.x * cols);
            float h = hash(id * 1.71 + fl * 19.3);
            float yy = fract(q.y * (1.2 + fl * 0.5) + uTime * (2.6 - fl * 0.6) + h * 7.31);
            float len = 0.22 - fl * 0.05;
            float streak = 1.0 - smoothstep(0.0, len, yy);
            float xw = abs(fract(q.x * cols) - 0.5);
            float line = 1.0 - smoothstep(0.04, 0.1 + 0.05 * (2.0 - fl), xw);
            rain += step(0.62, h) * line * streak * (0.55 - fl * 0.15);
          }
          col.rgb = mix(col.rgb, vec3(0.86, 0.9, 0.97), clamp(rain, 0.0, 1.0) * 0.32 * uRain);
          col.rgb *= 1.0 - 0.08 * uRain; // в дождь чуть сумрачнее
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

        // ночью края кадра темнеют — взгляд тянется в центр, туда, куда бежим
        if (uVig > 0.0) {
          vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0) / max(uAspect, 1.0);
          col.rgb *= 1.0 - uVig * smoothstep(0.18, 0.62, length(q));
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
  coyote: 0, jumpBuf: 0, slideT: 0, slideQueued: false, boost: 0, pump: 0, pumpT: -9, hopKeep: false,
  slideChain: 0, slideEndAt: -9,
  wall: 0, wallT: 0, wallCool: 0, wallLast: 0, autoAttach: 0, autoT: 0, grabT: 0, launch: null, glideT: 0, longT: 0, longG: 1, hover: 0, longLane: null,
};
const cam = { roll: 0, yaw: 0, pitch: 0, dip: 0, slide: 0, bob: 0, fov: 82, wallStep: 0, slideSide: 1, lookY: 1.2, vx: 0, lines: 0, base: 0, wall: 0, fly: 0, baseV: 0, lookV: 0 };
let gameTime = 0;
let runStartT = 0; // gameTime в начале забега — от него считаем день и ночь
const _sky = new THREE.Color();
// День → сумерки → ночь → рассвет → день… Забег всегда начинается днём.
const DAY = 35, DUSK = 15, NIGHT = 80; // секунды
const forceNight = params.has('night') ? Number(params.get('night') || 1) : null; // для проверки: ?night=1
function nightAmount() {
  if (forceNight !== null) return forceNight;
  if (state === 'ready') return 0;
  const cyc = DAY + DUSK + NIGHT + DUSK;
  const t = (gameTime - runStartT) % cyc;
  const ss = (x) => x * x * (3 - 2 * x);
  if (t < DAY) return 0;
  if (t < DAY + DUSK) return ss((t - DAY) / DUSK);
  if (t < DAY + DUSK + NIGHT) return 1;
  return 1 - ss((t - DAY - DUSK - NIGHT) / DUSK);
}
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
  // для проверки: ?under=dark,balls,balloons,sparks,carts — эти особенности во всех переходах
  // ?ruin=1 — разруха везде, ?ruin=0 — нигде
  if (params.get('ruin') !== null) world.ruinOverride = params.get('ruin') === '1';
  if (params.get('under')) world.featOverride = Object.fromEntries(params.get('under').split(',').map((k) => [k, true]));
  Object.assign(pl, {
    x: 6 * CELL + CELL / 2, z: ROW * 0.5, y: 0, vx: 0, vy: 0, grounded: true,
    coyote: 0, jumpBuf: 0, slideT: 0, slideQueued: false, boost: 0, pump: 0, pumpT: -9, hopKeep: false,
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

function disposeGroup(g) { g.traverse((o) => o.geometry && o.material !== materials.monkey && o.material !== materials.glow && o.geometry.dispose()); }
let darkAmt = 0; // 0…1 — бежим по тёмному переходу (свет не работает)

function ensureWorld() {
  const need = Math.ceil((pl.z + LZ * 6.5) / ROW) + 4;
  world.ensureRows(need);
  // меш строим, когда уже есть следующий паттерн — нужен для теней на стыке
  while (built < world.instances.length - 1) {
    const inst = world.instances[built++];
    const m = buildInstanceMesh(inst, materials, world);
    monkeys.push(...placeMonkeys(world, inst, m, materials.monkey, materials.glow));
    meshes.push(m);
    scene.add(m);
  }
  meshes = meshes.filter((m) => {
    if (m.userData.zEnd < pl.z - ROW * 6) {
      scene.remove(m); disposeGroup(m); return false;
    }
    return true;
  });
  monkeys = monkeys.filter((k) => k.z > pl.z - ROW * 3);
}

// ---------- физика (всё в плоском мире) ----------
const wrapX = (x) => ((x % W) + W) % W;

function speedNow() {
  // от пройденного пути скорость не растёт — только разгон от подкатов, стен и толчков
  const v = P.speedStart + pl.boost + pl.pump;
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
  const lz = z - ri * ROW;
  const base = row.b0 + (row.b1 - row.b0) * (lz / ROW);
  // над провалом в тоннеле потолок тоже есть (он и нарисован): иначе бег по стене и толчок
  // выносили выше потолка, и на следующем ряду игрок влетал в него сбоку
  if (v === VOID || v === POOL) return row.cover ? [[base + CEIL_H, INF]] : SOLID_NONE;
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

// Впереди по нашей полосе пропасть, а рядом с ней (вплотную слева или справа) красная стена
function flankedPit(v) {
  const reach = Math.max(14, v * 1.2);
  for (let dz = 0; dz <= reach; dz += 1) {
    const c = world.cellAt(wrapX(pl.x), pl.z + dz);
    if (c !== VOID && c !== POOL) continue;
    if (isRunwallAt(laneX(pl.lane - 1), pl.z + dz) || isRunwallAt(laneX(pl.lane + 1), pl.z + dz)) return true;
  }
  return false;
}

// Есть ли стена на полосах между нашей и lane (включая lane) от нас до dz вперёд
function crossesWall(lane, dz) {
  const s = Math.sign(lane - pl.lane);
  for (let m = pl.lane + s; s !== 0; m += s) {
    for (let z = 0; z <= dz + 1; z += 1) {
      const c = world.cellAt(wrapX(laneX(m)), pl.z + z);
      if (c === WALL || c === RUNWALL) return true;
    }
    if (m === lane) break;
  }
  return false;
}

// Длинный прыжок: впереди по своей полосе пропасть хотя бы на 2 ряда, а дальше — красная стена
// рядом с полосой (вплотную или через одну). d — в какую сторону стена (0 — с обеих сторон).
function longJumpTarget(v) {
  // обычный прыжок приземлит в пропасть?
  const reach = Math.min(JUMP_REACH, v * JUMP_AIR);
  // пропасть — это клетка без пола (уступ выше — не пропасть, на него просто запрыгиваем)
  const hole = (dz) => { const c = world.cellAt(wrapX(pl.x), pl.z + dz); return c === VOID || c === POOL; };
  if (!hole(reach) || !hole(reach * 0.6)) return null;
  // яма, вдоль которой красные стены, — её проходят по стенам, а не перелетают
  if (flankedPit(v)) return null;
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
      // сквозь стены не ведём: к внутренней стороне стены, у которой стоим снаружи, не перетаскиваем —
      // игрок видит перед собой эту стену и свайпом сам выбирает, на какую лезть
      if (crossesWall(lane, dz1)) continue;
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
    let lead = pl.longLane != null ? Math.sign(pl.longLane - pl.lane) : 0;
    // но если в ту сторону вплотную стена — игрок хочет на неё, а не ждать подсказку
    if (lead === d && !sideFree(pl.lane + d)) lead = -d;
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
  if (ceilingAt(pl.x, pl.z, pl.y) < pl.y + P.bodyStand + 0.4) return false;
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
    if (!pl.grounded && hi !== INF && hi - pl.y <= P.mantle && lo <= pl.y + 0.5 && pl.vy > 3 && !pl.wall) {
      // ещё летим вверх — перескакиваем край, не гася прыжок: оставшаяся скорость (как если бы
      // мы честно поднялись на эту высоту) несёт дальше — лесенку 0→1→2 берём одним прыжком
      const js = jumpScale(v), g = P.gravityUp * js * js;
      pl.vy = Math.sqrt(Math.max(0, pl.vy * pl.vy - 2 * g * (hi - pl.y)));
      pl.y = hi;
      cam.dip = Math.max(cam.dip, 0.12);
    } else if (!pl.grounded && hi !== INF && hi - pl.y <= P.mantle && lo <= pl.y + 0.5) {
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
      lampHit(0.6);
      cam.dip = Math.max(cam.dip, 0.55);
      cam.pitch -= 0.08;
      shake = Math.max(shake, 0.15);
    } else if (hi === INF && lo !== -INF && lo > pl.y + 0.6
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
      // жёсткое приземление — фонарь от удара на миг моргает (контакт болтается)
      // (обычный прыжок на ровном месте не в счёт: на скорости он тоже падает быстрее)
      const hard = -pl.vy / Math.sqrt(jumpScale(v));
      if (hard > 15) lampHit(hard > 22 ? 1 : 0.6);
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
  // накачка держится, пока скользим (и в прыжке из подката); дальше плавно тает до обычной скорости
  if (pl.pump > 0 && !sliding() && !(pl.hopKeep && !pl.grounded)) pl.pump = Math.max(0, pl.pump - Math.max(2, pl.pump * P.pumpDecay) * dt);

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
    // и не зависаем над ней — иначе стены можно просто перепорхнуть
    if (flankedPit(v)) pl.hover = 0;
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
  // подкат прямо из подката на земле — «накачка»: каждый свайп вниз добавляет скорость, без предела
  // считается только быстрая серия: чем чаще свайпы, тем больше прибавка; редкие — ничего
  const gap = gameTime - pl.pumpT;
  pl.pumpT = gameTime;
  if (sliding() && pl.grounded && gap < P.pumpWindow) pl.pump += P.pumpGain * (1 - gap / P.pumpWindow);
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

// ---------- пауза ----------
function pauseGame() {
  if (state !== 'run') return;
  state = 'paused';
  touch = null;
  rec.event('pause', { z: pl.z });
  if (slideSnd) { slideSnd = false; sound.slide(false, true); }
  sound.muffle(true);
  $('pause-menu').classList.add('show');
}
function resumeGame() {
  if (state !== 'paused') return;
  state = 'run';
  sound.muffle(false);
  $('pause-menu').classList.remove('show');
}
$('pause').addEventListener('click', (e) => { e.stopPropagation(); pauseGame(); });
$('resume').addEventListener('click', (e) => { e.stopPropagation(); sound.unlock(); resumeGame(); });
$('restart-same').addEventListener('click', (e) => { e.stopPropagation(); sound.unlock(); restart(true); });
$('restart-new').addEventListener('click', (e) => { e.stopPropagation(); sound.unlock(); restart(false); });
// свернули приложение посреди забега — встаём на паузу
document.addEventListener('visibilitychange', () => { if (document.hidden) pauseGame(); });

function start() {
  $('pause-menu').classList.remove('show');
  ui.start.classList.remove('show');
  ui.over.classList.remove('show');
  ui.hud.classList.add('show');
  state = 'run';
  runStartT = gameTime;
  if (slideSnd) { slideSnd = false; sound.slide(false, true); }
  resetWeather();
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
  if (e.code === 'Escape' || e.code === 'KeyP') { if (state === 'run') pauseGame(); else resumeGame(); return; }
  if (state === 'paused') return;
  if (e.repeat) return;
  if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') jump();
  if (e.code === 'ArrowDown' || e.code === 'KeyS' || e.code === 'ShiftLeft') slide();
  if (e.code === 'ArrowLeft' || e.code === 'KeyA') laneShift(-1);
  if (e.code === 'ArrowRight' || e.code === 'KeyD') laneShift(1);
});

// iOS: не даём странице зумиться и скроллиться
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('touchmove', (e) => { if (!e.target.closest?.('#seed-list')) e.preventDefault(); }, { passive: false });

// ---------- погода ----------
// Виды погоды по очереди и случайно: «ясно», «туман», «дождь».
// Каждая держится 45–90 с, смена плавная (~8 с). Забег начинается с ясной погоды.
// ?weather=fog / ?weather=rain — сразу эта погода (для проверки).
const WEATHERS = ['clear', 'fog', 'rain'];
const forceWeather = params.get('weather');
// w — сила дымки (туман — 1, в дождь — серая морось 0.45), r — сила дождя
const weather = { kind: 'clear', w: 0, r: 0, until: 0 };
const weatherFog = (k) => (k === 'fog' ? 1 : k === 'rain' ? 0.45 : 0);
function resetWeather() {
  weather.kind = forceWeather && WEATHERS.includes(forceWeather) ? forceWeather : 'clear';
  weather.w = weatherFog(weather.kind);
  weather.r = weather.kind === 'rain' ? 1 : 0;
  weather.until = gameTime + 45 + Math.random() * 45;
}
// возвращает силу тумана 0…1
function updateWeather(dt) {
  if (!forceWeather && state === 'run' && gameTime > weather.until) {
    const others = WEATHERS.filter((k) => k !== weather.kind);
    weather.kind = Math.random() < 0.6 ? others[Math.floor(Math.random() * others.length)] : weather.kind;
    weather.until = gameTime + 45 + Math.random() * 45;
    rec.event('weather', { kind: weather.kind, z: pl.z });
  }
  const target = weatherFog(weather.kind);
  weather.w += Math.sign(target - weather.w) * Math.min(Math.abs(target - weather.w), dt / 8);
  const rt = weather.kind === 'rain' ? 1 : 0;
  weather.r += Math.sign(rt - weather.r) * Math.min(Math.abs(rt - weather.r), dt / 6);
  return weather.w * weather.w * (3 - 2 * weather.w);
}
resetWeather();

// ---------- уличные фонари: 12 ближайших впереди — в шейдер, светят пятном вниз ----------
const streetBuf = [];
function updateStreetLamps(night) {
  const u = materials.main.uniforms.uStreetL.value;
  streetBuf.length = 0;
  if (night > 0) {
    for (const m of meshes) {
      const ls = m.userData.lamps;
      if (!ls) continue;
      for (const l of ls) {
        const rz = m.userData.zStart - pl.z + l[1];
        if (rz < -15 || rz > 140) continue;
        let rx = l[0] - pl.x;
        rx = ((rx + W / 2) % W + W) % W - W / 2;
        streetBuf.push([rx, rz, l[2]]);
      }
    }
    streetBuf.sort((a, b) => Math.abs(a[1]) - Math.abs(b[1]));
  }
  for (let i = 0; i < u.length; i++) {
    const l = streetBuf[i];
    if (l) u[i].set(l[0], l[2], l[1]); else u[i].set(0, -99, 0);
  }
}

// ---------- фонарь: луч трясётся на бегу ----------
// Фонарь «в руке»: качается в такт шагам (cam.bob), вздрагивает при приземлении и толчках (cam.dip),
// в полёте плывёт, на стене уходит в сторону стены. Пятно крупнее на широком экране.
const lamp = { x: 0, y: -0.1, vx: 0, vy: 0, jit: 0, on: false, t: 0, hitT: -9, hitK: 0 };
function lampHit(k) { lamp.hitT = gameTime; lamp.hitK = k; }
// фонарь щёлкает резко, а не плавно: включился — короткое моргание и сразу полная яркость;
// выключился (в подземке, на рассвете) — сразу темно
function lampSwitch(want) {
  if (want !== lamp.on) { lamp.on = want; lamp.t = gameTime; }
  if (!lamp.on) return 0;
  const t = gameTime - lamp.t;
  // строб от удара: гаснет — вспыхивает — подмигивает, ~0.15 с
  const h = gameTime - lamp.hitT;
  if (h >= 0 && h < 0.16) {
    const k = lamp.hitK;
    if (h < 0.035) return 1 - 0.95 * k;
    if (h < 0.07) return 1;
    if (h < 0.1) return 1 - 0.7 * k;
    if (h < 0.13) return 1;
    return 1 - 0.35 * k;
  }
  if (t < 0.05) return 1;
  if (t < 0.11) return 0.15;
  if (t < 0.16) return 1;
  if (t < 0.2) return 0.4;
  return 1;
}
function updateLamp(dt) {
  const run = state === 'run';
  const ground = run && pl.grounded && !sliding();
  // тряска сильная: фонарь в руке бегущего человека
  let tx = ground ? Math.sin(cam.bob) * 0.1 : 0;
  let ty = -0.1 + (ground ? -Math.abs(Math.sin(cam.bob)) * 0.12 : 0) - cam.dip * 0.24;
  if (pl.wall) tx += pl.wall * 0.16;
  if (sliding()) ty -= 0.08;
  if (!pl.grounded && !pl.wall) ty += Math.max(-0.08, Math.min(0.08, pl.vy * 0.006)); // в полёте луч «плывёт»
  // мелкая дрожь руки, сильнее на скорости
  lamp.jit += dt;
  const sp = run ? Math.min(1, speedNow() / 25) : 0;
  tx += (Math.sin(lamp.jit * 13.1) + Math.sin(lamp.jit * 7.3)) * 0.013 * (0.4 + sp);
  ty += (Math.sin(lamp.jit * 11.7) + Math.sin(lamp.jit * 5.9)) * 0.013 * (0.4 + sp);
  // пружина — луч догоняет руку с небольшим запозданием и перелётом
  // мелкими шагами: жёсткая пружина на длинном кадре иначе разлетается
  const w = 22, n = Math.ceil(dt / (1 / 240));
  for (let i = 0; i < n; i++) {
    const h = dt / n;
    lamp.vx += (w * w * (tx - lamp.x) - 2 * 0.55 * w * lamp.vx) * h; lamp.x += lamp.vx * h;
    lamp.vy += (w * w * (ty - lamp.y) - 2 * 0.55 * w * lamp.vy) * h; lamp.y += lamp.vy * h;
  }
  if (!Number.isFinite(lamp.x + lamp.y)) Object.assign(lamp, { x: 0, y: -0.1, vx: 0, vy: 0 });
  const wide = camera.aspect > 1;
  materials.main.uniforms.uLampP.value.set(lamp.x, lamp.y, wide ? 0.5 : 0.38);
}

// ---------- тени от фонаря (экспериментально, кнопкой) ----------
// Город ещё раз рисуется в карту глубины с точки зрения фонаря (в руке: правее и ниже глаз),
// основной шейдер сравнивает глубину — что закрыто, в тень. Стоит ещё одного прохода по сцене.
// по умолчанию включены (новый ключ — чтобы старое «выкл» из эксперимента не мешало)
let shadowsOn = true;
try { shadowsOn = localStorage.getItem('sdwg-shadows2') !== '0'; } catch { /* приватный режим */ }
const SHADOW_RES = 1024;
const shadowRT = new THREE.WebGLRenderTarget(SHADOW_RES, SHADOW_RES, { depthBuffer: true });
shadowRT.depthTexture = new THREE.DepthTexture(SHADOW_RES, SHADOW_RES);
shadowRT.depthTexture.type = THREE.UnsignedIntType;
const lampCam = new THREE.PerspectiveCamera(105, 1, 0.3, 70);
const depthMat = createDepthMaterial();
const _lp = new THREE.Vector3(), _la = new THREE.Vector3();
function renderLampShadow() {
  const u = materials.main.uniforms;
  const on = shadowsOn && u.uLamp.value > 0.01;
  u.uShadowOn.value = on ? 1 : 0;
  if (!on) return;
  camera.updateMatrixWorld();
  camera.localToWorld(_lp.set(0.35, -0.3, 0));
  camera.localToWorld(_la.set(lamp.x * 10, lamp.y * 10, -10));
  lampCam.position.copy(_lp);
  lampCam.up.copy(camera.up);
  lampCam.lookAt(_la);
  lampCam.updateMatrixWorld();
  lampCam.updateProjectionMatrix();
  u.uLampMat.value.multiplyMatrices(lampCam.projectionMatrix, lampCam.matrixWorldInverse);
  depthMat.uniforms.uB.value = u.uB.value;
  const prevOverride = scene.overrideMaterial;
  scene.overrideMaterial = depthMat;
  materials.cone.visible = false; // лучи фонарей — свет, а не предметы: тени не отбрасывают
  renderer.setRenderTarget(shadowRT);
  renderer.clear();
  renderer.render(scene, lampCam);
  renderer.setRenderTarget(null);
  materials.cone.visible = true;
  scene.overrideMaterial = prevOverride;
  u.uShadow.value = shadowRT.depthTexture;
}
function updateShadowButtons() {
  for (const id of ['shadows', 'shadows-over', 'shadows-pause']) $(id).textContent = `Тени фонаря: ${shadowsOn ? 'вкл' : 'выкл'}`;
}
for (const id of ['shadows', 'shadows-over', 'shadows-pause']) {
  $(id).addEventListener('click', (e) => {
    e.stopPropagation();
    shadowsOn = !shadowsOn;
    try { localStorage.setItem('sdwg-shadows2', shadowsOn ? '1' : '0'); } catch { /* приватный режим */ }
    updateShadowButtons();
  });
}
updateShadowButtons();

// ---------- тени от солнца (экспериментально, кнопкой) ----------
// Солнце сзади-сбоку и высоко: резкие тени домов ложатся вперёд по улице и на соседние фасады.
// Карта глубины строится в плоском мире (до изгиба) ортогональной камерой вокруг игрока.
// Мир — круг: рисуем ещё две копии, сдвинутые на круг, чтобы тень переходила через «шов».
let sunOn = true;
try { sunOn = localStorage.getItem('sdwg-sun2') !== '0'; } catch { /* приватный режим */ }
const SUN_RES = 2048;
const sunRT = new THREE.WebGLRenderTarget(SUN_RES, SUN_RES, { depthBuffer: true });
sunRT.depthTexture = new THREE.DepthTexture(SUN_RES, SUN_RES);
sunRT.depthTexture.type = THREE.UnsignedIntType;
const sunCam = new THREE.OrthographicCamera(-75, 75, 135, -135, 1, 900);
const sunDepth = createSunDepthMaterial();
const _sc = new THREE.Vector3();
const _sq = new THREE.Quaternion();
function renderSunShadow(deep) {
  const u = materials.main.uniforms;
  const k = sunOn ? (1 - nightAmount()) * Math.max(0, 1 - deep * 1.5) * (1 - 0.8 * weather.w) : 0;
  u.uSun.value = k;
  if (k <= 0.01) return;
  const d = u.uSunDir.value;
  // центр карты — чуть впереди игрока: туда, что видно.
  // Привязан к сетке текселей в координатах МИРА: иначе карта съезжает вместе с игроком на доли
  // текселя каждый кадр, и края теней на фасадах «кипят» (мерцали окна)
  sunCam.position.set(0, 0, 0); sunCam.up.set(0, 0, 1); sunCam.lookAt(-d.x, -d.y, -d.z);
  _sq.copy(sunCam.quaternion).invert();
  _sc.set(pl.x, Math.round(cam.base + 10), pl.z + 95).applyQuaternion(_sq); // в осях солнца
  const tx = 150 / SUN_RES, ty = 270 / SUN_RES;
  _sc.x = Math.round(_sc.x / tx) * tx; _sc.y = Math.round(_sc.y / ty) * ty;
  _sc.applyQuaternion(sunCam.quaternion);
  _sc.x -= pl.x; _sc.z -= pl.z; // обратно в координаты сцены (мир сдвинут на игрока)
  sunCam.position.copy(_sc).addScaledVector(d, 300);
  sunCam.lookAt(_sc);
  sunCam.updateMatrixWorld();
  sunCam.updateProjectionMatrix();
  u.uSunMat.value.multiplyMatrices(sunCam.projectionMatrix, sunCam.matrixWorldInverse);
  const prevOverride = scene.overrideMaterial, prevAuto = renderer.autoClear;
  scene.overrideMaterial = sunDepth;
  renderer.setRenderTarget(sunRT);
  renderer.clear();
  renderer.autoClear = false;
  materials.cone.visible = false;
  for (const sh of [0, -W, W]) { sunDepth.uniforms.uShift.value = sh; renderer.render(scene, sunCam); }
  materials.cone.visible = true;
  renderer.autoClear = prevAuto;
  renderer.setRenderTarget(null);
  scene.overrideMaterial = prevOverride;
  u.uSunShadow.value = sunRT.depthTexture;
}
function updateSunButtons() {
  for (const id of ['sun', 'sun-over', 'sun-pause']) $(id).textContent = `Тени солнца: ${sunOn ? 'вкл' : 'выкл'}`;
}
for (const id of ['sun', 'sun-over', 'sun-pause']) {
  $(id).addEventListener('click', (e) => {
    e.stopPropagation();
    sunOn = !sunOn;
    try { localStorage.setItem('sdwg-sun2', sunOn ? '1' : '0'); } catch { /* приватный режим */ }
    updateSunButtons();
  });
}
updateSunButtons();

// ---------- PS1 (экспериментально, кнопкой): вершины липнут к грубой сетке экрана ----------
let ps1On = false;
try { ps1On = localStorage.getItem('sdwg-ps1') === '1'; } catch { /* приватный режим */ }
function updatePs1Buttons() {
  for (const id of ['ps1', 'ps1-over', 'ps1-pause']) $(id).textContent = `PS1: ${ps1On ? 'вкл' : 'выкл'}`;
}
for (const id of ['ps1', 'ps1-over', 'ps1-pause']) {
  $(id).addEventListener('click', (e) => {
    e.stopPropagation();
    ps1On = !ps1On;
    try { localStorage.setItem('sdwg-ps1', ps1On ? '1' : '0'); } catch { /* приватный режим */ }
    updatePs1Buttons();
  });
}
updatePs1Buttons();

// ---------- акустика улицы: стены рядом ----------
// Короткое эхо со стороны стены (бежим вдоль башни или по красной стене) и отовсюду в узком месте.
// В подземке своё длинное эхо, там это не нужно.
const spaceS = { l: 0, r: 0 };
function wallNear(side) {
  // стена вплотную (соседняя полоса) — 1, через полосу — 0.35; смотрим чуть вперёд и назад
  let best = 0;
  for (const dz of [-2, 2, 6]) {
    for (const [k, w] of [[1, 1], [2, 0.35]]) {
      const c = world.cellAt(wrapX(laneX(pl.lane + side * k)), pl.z + dz);
      if (c === WALL || c === RUNWALL) { best = Math.max(best, w); break; }
      if (c !== VOID && c !== POOL && lv(c) >= 2) { best = Math.max(best, w * 0.6); break; } // высокий предмет
    }
  }
  return best;
}
function updateSpace(dt, deep) {
  const on = state === 'run' ? 1 - deep : 0;
  spaceS.l = damp(spaceS.l, wallNear(-1) * on, 6, dt);
  spaceS.r = damp(spaceS.r, wallNear(1) * on, 6, dt);
  const narrow = Math.min(spaceS.l, spaceS.r);
  sound.space(spaceS.l - narrow * 0.6, spaceS.r - narrow * 0.6, narrow);
}

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
    // по стене бежим — шаги, чуть тише и чаще
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
  // мелкими шагами: на длинном кадре (подвисание) жёсткая пружина иначе разлетается
  for (let i = 0, n = Math.ceil(dt / (1 / 120)); i < n; i++) {
    const h = dt / n;
    cam.lookV += (w1 * w1 * (lookTarget - cam.lookY) - 2 * w1 * cam.lookV) * h;
    cam.lookY += cam.lookV * h;
  }
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
const fpsEl = document.getElementById('fps');
let hudFpsN = 0, hudFpsT = 0;
let fpsAcc = 0, fpsN = 0, fps = 0;

function frame(now) {
  requestAnimationFrame(frame);
  // на паузе время стоит: мир, анимации и погода замирают, кадр просто перерисовывается
  const dt = state === 'paused' ? 0 : Math.min(0.05, (now - last) / 1000) * timeScale;
  // FPS в углу: среднее за полсекунды
  hudFpsN++; hudFpsT += now - last;
  if (hudFpsT >= 500) { fpsEl.textContent = `${Math.round(hudFpsN * 1000 / hudFpsT)} fps`; hudFpsN = 0; hudFpsT = 0; }
  // подвисание — в запись забега: сколько длился кадр и где мы были
  if (state === 'run' && last && now - last > 120) rec.event('hitch', { ms: now - last, z: pl.z, built, meshes: meshes.length });
  gameTime += dt;
  last = now;

  const zBefore = pl.z;
  if (state === 'run') {
    // мелкие шаги — чтобы на высокой скорости не проскакивать сквозь стены
    // (на большой накачке — ещё мельче: не больше ~0.3 м за шаг)
    const n = Math.ceil(dt * Math.max(120, speedNow() / 0.3));
    for (let i = 0; i < n && state === 'run'; i++) { if (autopilot) autopilotStep(); physicsStep(dt / n); }
    ensureWorld();
    ui.dist.textContent = `${Math.floor(pl.z)} м`;
    recordFrame();
    collectMonkeys(zBefore);
    if (pl.grounded && !wasGroundedSnd) sound.land(Math.min(1, Math.max(0, (-airVy - 4) / 16)));
    if (!pl.grounded) airVy = pl.vy;
    wasGroundedSnd = pl.grounded;
    // звук скольжения — только подкат по полу (на стене — шаги). Подкат сразу за подкатом
    // не обрывает звук: выход звучит, только если не скользим ~0.12 с
    // только пока бежим: смерть в подкате глушит звук, и в том же кадре его нельзя запускать заново
    if (state === 'run' && sliding()) { slideOffT = 0; if (!slideSnd) { slideSnd = true; sound.slide(true); } }
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
    for (let i = 0, n = Math.ceil(dt / (1 / 120)); i < n; i++) {
      const h = dt / n;
      cam.baseV += (w0 * w0 * (baseTarget - cam.base) - 2 * w0 * cam.baseV) * h;
      cam.base += cam.baseV * h;
    }
  }
  materials.main.uniforms.uB.value = cam.base;
  materials.main.uniforms.uTime.value = gameTime;
  materials.main.uniforms.uRunZ.value = pl.z % 840;
  {
    // вход в тёмный переход: последний, до которого уже видно (впереди до 150 м) — или тот, в котором мы сейчас
    let zs = -1e5;
    for (const z of world.darkStarts || []) if (z < pl.z + 150 && z > zs) zs = z;
    materials.main.uniforms.uDarkZ.value = zs - pl.z;
  }
  // PS1: ~100 «строк» по высоте — заметно, но не каша
  materials.main.uniforms.uPs1.value = ps1On ? 100 : 0;
  materials.main.uniforms.uAspectV.value = camera.aspect; // для бегущей по красному волны (кратно её длине)
  // в подземке дымка ближе — пустые коридоры тонут в молочном свете
  const deep = Math.min(1, Math.max(0, -cam.base / 5));
  // погода: туман на улице — видимость втрое ближе (в подземке своя дымка, туман туда не заходит)
  const fogW = updateWeather(dt) * (1 - deep);
  materials.main.uniforms.uFogNear.value = LZ * (2.2 - 1.0 * deep) * (1 - 0.68 * fogW);
  materials.main.uniforms.uFogFar.value = LZ * (6.0 - 2.6 * deep) * (1 - 0.62 * fogW);
  // день и ночь: в подземке ночь почти не чувствуется — там свои лампы
  const night = nightAmount() * (1 - 0.6 * deep);
  const nf = [0.12, 0.13, 0.155]; // ночной туман и небо: прохладная дымка, чуть подсвеченная городом, светлее башен
  const df = [1 - 0.05 * deep, 1 - 0.01 * deep, 1 - 0.02 * deep];
  // в тумане днём — белёсо-серая дымка, ночью — плотная серо-синяя, подсвеченная городом
  const fd = [0.84, 0.855, 0.87], fn = [0.2, 0.21, 0.235];
  for (let i = 0; i < 3; i++) { df[i] += (fd[i] - df[i]) * fogW; nf[i] += (fn[i] - nf[i]) * fogW; }
  // тёмный переход: дымка почти чёрная (свет не работает)
  const feat = state === 'ready' ? null : world.featAt(pl.z + 4);
  darkAmt = damp(darkAmt, feat && feat.dark && deep > 0.3 ? 1 : 0, 3, dt);
  for (let i = 0; i < 3; i++) { df[i] += (0.03 - df[i]) * darkAmt; nf[i] += (0.02 - nf[i]) * darkAmt; }
  materials.main.uniforms.uFogColor.value.setRGB(
    df[0] + (nf[0] - df[0]) * night, df[1] + (nf[1] - df[1]) * night, df[2] + (nf[2] - df[2]) * night);
  materials.star.uniforms.uFogNear.value = materials.main.uniforms.uFogNear.value;
  materials.star.uniforms.uFogFar.value = materials.main.uniforms.uFogFar.value;
  materials.main.uniforms.uNight.value = night;
  updateStreetLamps(night);
  // ночью блум слабее и с порогом повыше: светятся только окна и красное, без пересвета
  if (bloom) { bloom.strength = 0.27 - 0.06 * night; bloom.threshold = 0.9 + 0.05 * night; }
  // фонарь: ночью на улице; в подземке плавно гаснет (deep меняется плавно вместе с камерой)
  // фонарь: ночью на улице, а в тёмном переходе — и днём
  // тёмный переход впереди — фонарик щёлкает заранее, ещё на спуске: видно, куда забегаешь
  const darkAhead = state === 'run' && !!world.featAt(pl.z + 22)?.dark;
  materials.main.uniforms.uLamp.value = lampSwitch((nightAmount() > 0.55 && deep < 0.35) || (darkAmt > 0.5 && deep > 0.3) || darkAhead);
  updateLamp(dt);
  materials.monkey.uniforms.uNight.value = night;
  materials.monkey.uniforms.uFlashT.value = gameTime;
  {
    const gu = materials.glow.uniforms, mu = materials.monkey.uniforms;
    gu.uB.value = mu.uB.value; gu.uFogNear.value = mu.uFogNear.value; gu.uFogFar.value = mu.uFogFar.value;
    gu.uPulse.value = 0.85 + 0.15 * Math.sin(gameTime * 4); // в такт пульсу самой обезьянки
  }
  _sky.copy(materials.main.uniforms.uFogColor.value);
  renderer.setClearColor(useBloom ? _sky.clone().convertSRGBToLinear() : _sky, 1);
  document.body.classList.toggle('night', night > 0.45);
  const high = Math.min(1, Math.max(0, (cam.base - 10) / 25));
  materials.main.uniforms.uHigh.value = high;
  sound.update(deep, state === 'run' ? speedNow() : 0, high);
  sound.rain(weather.r * (1 - 0.85 * deep));
  updateSpace(dt, deep);
  materials.star.uniforms.uB.value = cam.base;
  materials.spark.uniforms.uB.value = cam.base;
  {
    const cu = materials.cone.uniforms, mm = materials.main.uniforms;
    cu.uB.value = cam.base; cu.uFogNear.value = mm.uFogNear.value; cu.uFogFar.value = mm.uFogFar.value;
    cu.uNight.value = mm.uNight.value;
  }
  materials.spark.uniforms.uTime.value = gameTime;
  materials.spark.uniforms.uPx.value = renderer.getPixelRatio() * innerHeight / 800;
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
    blurPass.uniforms.uVig.value = 0.6 * materials.main.uniforms.uNight.value;
    blurPass.uniforms.uRain.value = weather.r * (1 - deep);
  }
  renderLampShadow();
  renderSunShadow(Math.min(1, Math.max(0, -cam.base / 5)));
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
window.__game = { materials, cam, laneShift, setAuto: (v) => { autopilot = v; }, get state() { return state; }, pl, start, die, jump, runFile, get monkeys() { return monkeys; }, slide, get seed() { return seed; }, get world() { return world; }, get meshes() { return meshes; } };
