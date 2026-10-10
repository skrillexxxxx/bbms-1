// Отрисовка: геометрия строится в плоском мире, а изгиб в круг
// делается одной формулой в вершинном шейдере:
//   r = L·e^(−dz/LZ),  φ = dx/L,  высота = y·e^(−dz/LZ)
// Формула одна и непрерывная, поэтому стыки кусков совпадают всегда.

import * as THREE from 'three';
import {
  COLS, CELL, ROW, LEVEL, L, LZ, WALL, BRIDGE, VOID, BRIDGE_BOTTOM, BRIDGE_TOP, CEIL_H,
  hash2, aliveBackward, mulberry32, walk, lv, planterAt, RUNWALL, POOL, LAUNCH, LAUNCH_ROWS,
} from './world.js';

const SEG = 1.0; // шаг разбиения по x/z, чтобы прямые рёбра красиво гнулись

const vert = /* glsl */ `
  attribute float aStyle;
  attribute float aTop;
  attribute vec4 aBox;
  attribute float aAO;
  attribute float aLight;
  attribute float aTint;
  varying float vTint;
  uniform float uL;
  uniform float uLz;
  uniform float uB;
  varying vec3 vPos;
  varying vec3 vN;
  varying float vStyle;
  varying float vTop;
  varying vec4 vBox;
  varying float vDz;
  varying float vDist;
  varying float vS;
  varying float vWY;
  varying float vAO;
  varying float vLight;
  void main() {
    vec4 f = modelMatrix * vec4(position, 1.0);   // плоские координаты относительно игрока
    float s = exp(-f.z / uLz);
    float r = uL * s;
    float phi = f.x / uL;
    // всё сходится к точке на высоте пола текущего яруса (uB)
    vec3 w = vec3(r * sin(phi), uB + (f.y - uB) * s, r * cos(phi));
    vec4 mv = viewMatrix * vec4(w, 1.0);
    gl_Position = projectionMatrix * mv;
    vPos = position;
    vN = normal;
    vStyle = aStyle;
    vTop = aTop;
    vBox = aBox;
    vDz = f.z;
    // дальность по горизонтали (без высоты): с крыш улица внизу не должна тонуть в тумане
    vDist = length(vec2(w.x, w.z - uL));
    // высоту восстанавливаем во фрагментном шейдере как vWY / vS:
    // оба значения линейны по всей грани-трапеции, поэтому полосы окон
    // не ломаются на диагонали между треугольниками
    vS = s;
    vWY = f.y * s;
    vAO = aAO;
    vLight = aLight;
    vTint = aTint;
  }
`;

const frag = /* glsl */ `
  precision highp float;
  uniform float uL;
  uniform float uB;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform vec3 uFogColor;
  uniform float uLinearOut;
  uniform float uCell;
  uniform float uRow;
  uniform float uTime;
  uniform float uHigh;
  varying float vTint;
  varying vec3 vPos;
  varying vec3 vN;
  varying float vStyle;
  varying float vTop;
  varying vec4 vBox;
  varying float vDz;
  varying float vDist;
  varying float vS;
  varying float vWY;
  varying float vAO;
  varying float vLight;

  float lineAA(float coord, float period, float width) {
    float d = abs(fract(coord / period + 0.5) - 0.5) * period;
    float fw = fwidth(coord) + 1e-4;
    return 1.0 - smoothstep(width, width + fw * 1.5, d);
  }

  void main() {
    vec3 n = normalize(vN);
    float col;
    int st = int(vStyle + 0.5);
    float y = vWY / vS;

    if (st == 0) {
      // пол: земля в «каньоне» между башнями — в тени; сетка по клеткам — чтобы чувствовалась скорость
      col = 0.6;
      float g = max(lineAA(vPos.x, uCell, 0.03), lineAA(vPos.z, uRow, 0.03));
      col = mix(col, 0.5, g * 0.8);
      col *= vAO; // контактные тени у основания стен
      // свет с неба падает туда, куда нужно бежать: светлое пятно = путь
      col = col * (1.0 + vLight * 0.6) + vLight * 0.12;
    } else if (st == 6) {
      // листва: отдельные треугольники, у каждого свой оттенок
      col = (0.8 + 0.17 * vTop) * (0.92 + 0.08 * abs(n.y));
    } else if (st == 7) {
      col = 0.58 + 0.06 * n.x; // ствол и ветки
    } else if (st == 14) {
      // вода: светлая рябь, бегущая по поверхности
      float w1 = sin(vPos.x * 2.3 + uTime * 1.6 + sin(vPos.z * 1.7 + uTime));
      float w2 = sin(vPos.z * 2.9 - uTime * 1.3 + sin(vPos.x * 1.3 - uTime * 0.7));
      col = 0.5 + 0.35 * smoothstep(0.75, 1.0, w1 * w2 * 0.5 + 0.5);
    } else if (st == 17) {
      // трамплин: белые шевроны «вперёд» на красном
      float ax = abs(fract(vPos.x / uCell) - 0.5) * uCell;
      float ch = fract((vPos.z - ax * 0.9) / 1.3);
      col = n.y > 0.5 ? (ch < 0.45 ? 0.95 : 0.55) : 0.5;
    } else if (st == 16) {
      // стены дыры в пустоту: плитка, а вглубь — растворяются в белом
      col = 0.6;
      col = mix(col, col * 0.82, max(lineAA(y, 1.2, 0.015), lineAA(abs(n.x) > 0.5 ? vPos.z : vPos.x, 1.2, 0.015)));
      col = mix(col, 1.0, smoothstep(0.5, 18.0, vTop - y));
    } else if (st == 9) {
      // стены тоннеля и траншеи: плитка, свет из прохода
      col = abs(n.y) > 0.5 ? 0.5 : 0.64;
      col = mix(col, col * 0.82, max(lineAA(y, 1.2, 0.015), lineAA(abs(n.x) > 0.5 ? vPos.z : vPos.x, 2.0, 0.015)));
      col *= 1.0 + vLight * 0.7;
    } else if (st == 8 && n.y < -0.5) {
      // потолок тоннеля: тёмный, с полосами светильников над каждой полосой — блум их разжигает
      col = 0.34;
      float lx = abs(fract(vPos.x / uCell) - 0.5) * uCell;
      float seg = step(fract(vPos.z / 2.0), 0.72);
      // liminal: одни лампы мигают, другие перегорели
      float lid = floor(vPos.z / 2.0) * 7.13 + floor(vPos.x / uCell) * 3.71 + vTop * 1.37;
      float lh = fract(sin(lid) * 43758.5453);
      if (lh < 0.08) seg = 0.0;
      else if (lh > 0.9) seg *= step(0.35, fract(sin(floor(uTime * 14.0) * 12.9898 + lid) * 43758.5453));
      float lamp = (1.0 - smoothstep(0.1, 0.1 + fwidth(vPos.x) * 1.5 + 0.02, lx)) * seg;
      col = mix(col, 1.35, lamp);
      col *= 1.0 + vLight * 0.4;
    } else {
      // освещение по плоской нормали — стабильно, не зависит от поворота мира
      // крыши: у высоток светлые (их почти не видно), у низких зданий и мостов —
      // светло-серые, ниже порога блума, иначе выгорают в чистый белый
      if (n.y > 0.5) col = st >= 4 ? 0.8 : 0.95;
      else if (n.y < -0.5) col = 0.55;   // низ моста
      else if (n.z < -0.5) col = st == 4 ? 0.74 : 0.90; // у низких зданий фасад темнее крыши — ступенька читается
      else if (n.x > 0.5) col = 0.76;
      else if (n.x < -0.5) col = 0.68;
      else col = 0.66;

      bool wallFace = abs(n.y) < 0.5;
      if (st >= 11 && st <= 13) col = n.y > 0.5 ? 0.78 : col * 0.92;
      if (wallFace) {
        // вдоль грани: координата и расстояние до углов коробки
        float u = abs(n.x) > 0.5 ? vPos.z : vPos.x;
        float uMin = abs(n.x) > 0.5 ? vBox.y : vBox.x;
        float uMax = abs(n.x) > 0.5 ? vBox.w : vBox.z;
        float edge = min(u - uMin, uMax - u);
        float floorH = 3.3; // реальный этаж ~3.3 м (рост глаз 1.6)
        float fy = fract(y / floorH);
        bool inBody = y > 3.0 && y < vTop - 2.0 && edge > 0.8;

        if (st == 2 && inBody) {
          // ленточные окна — чёрные полосы, как на скринах
          if (fy > 0.3 && fy < 0.78) col = 0.06;
        } else if (st == 3 && inBody) {
          // сетка окон
          float fu = fract((u - uMin) / 2.6);
          if (fy > 0.28 && fy < 0.8 && fu > 0.18 && fu < 0.82) col = 0.07;
        }
        float dt = vTop - y; // расстояние от верха предмета
        if (st == 11) {
          // гофра контейнера
          col *= 0.86 + 0.14 * smoothstep(0.35, 0.65, abs(fract(u / 0.32) - 0.5) * 2.0);
          col = mix(col, col * 0.7, lineAA(y, 2.0, 0.03));
        } else if (st == 12) {
          // электрошкафы: дверцы и решётки вентиляции
          col = mix(col, col * 0.75, lineAA(u, 1.0, 0.02));
          if (dt > 0.2 && dt < 0.6 && edge > 0.15 && fract(y / 0.09) < 0.45) col *= 0.55;
        } else if (st == 13) {
          // будка: тёмное стекло
          if (dt > 0.5 && dt < 1.3 && edge > 0.25) col = 0.1;
        }
        // тонкие межэтажные линии
        if (st <= 3) col = mix(col, col * 0.86, lineAA(y, floorH, 0.02));
        // свет только сверху: низ улицы в тени, к верху башен светлее
        col *= mix(0.6, 1.0, smoothstep(0.0, 45.0, y));
        // контактная тень у земли (кроме мостов — они висят в воздухе)
        if (st < 5) col *= mix(0.8, 1.0, smoothstep(0.0, 2.5, y));
        // свет из прохода ложится на стены проёма, сильнее внизу
        col *= 1.0 + vLight * 0.55 * (1.0 - smoothstep(0.0, 18.0, y));
      }
    }

    // светлые рёбра: края крыш, углы, верх барьеров — чтобы читалась форма и край для прыжка
    if ((st > 0 && st < 6) || (st >= 11 && st <= 13)) {
      float ex = min(vPos.x - vBox.x, vBox.z - vPos.x);
      float ez = min(vPos.z - vBox.y, vBox.w - vPos.z);
      float et = vTop - y;
      float e;
      if (n.y > 0.5) e = min(ex, ez);          // крыша: все четыре края
      else if (n.y < -0.5) e = min(ex, ez);
      else if (abs(n.x) > 0.5) e = min(ez, et); // боковая грань: вертикальные углы и верхний край
      else e = min(ex, et);                     // передняя/задняя грань
      float fw = max(fwidth(e), 1e-4);
      float width = max(0.07, fw * 1.6);        // не тоньше ~1.5 пикселя вдали
      float rim = 1.0 - smoothstep(width, width + fw * 1.2, e);
      bool low = st >= 4;                       // низкие здания, предметы, мосты — кромка заметнее
      col = mix(col, low ? 0.93 : 0.97, rim * (low ? 0.9 : 0.6)); // ниже порога блума
    }

    // под землёй темнее — чем глубже, тем сильнее; светильники не трогаем
    if (!(st == 8 && n.y < -0.5)) col *= 1.0 - 0.38 * (1.0 - smoothstep(-5.0, -0.3, y));

    // туман: по глубине пути и по реальной дальности (гасит «изнанку» за центром)
    float f1 = smoothstep(uFogNear, uFogFar, vDz);
    float f2 = smoothstep(uL * 1.15, uL * 2.0, vDist);
    float fog = max(f1, f2);
    // цвет: в белом мире — редкие акценты, как в Mirror's Edge
    vec3 c3 = vec3(col);
    vec3 red = vec3(1.0, 0.2, 0.15);
    // Runner Vision: издалека предметы белые, краснеют по мере приближения
    float near = 1.0 - smoothstep(16.0, 34.0, vDz);
    if (vTint > 0.5 && vTint < 1.5) c3 = mix(c3, col * red * 0.95, near);      // красные трубы
    else if (vTint > 3.5 && vTint < 4.5) {
      // Runner Vision: красный только верх и кромка — «хватайся здесь»
      float k = n.y > 0.5 ? 1.0 : 1.0 - smoothstep(0.2, 0.26, vTop - y);
      c3 = mix(c3, col * red * 1.1, k * near);
    } else if (vTint > 4.5 && vTint < 5.5) {
      // красная стена: белая панель с красными полосами на высоте бега
      // полосы под 45°, «вверх и вперёд» — по направлению бега
      float k = step(fract((y - vPos.z) / 1.4), 0.36);
      c3 = mix(c3 * 1.05, vec3(col * 0.9) * red, k * near);
    }
    else if (vTint > 1.5 && vTint < 2.5) c3 = col * vec3(0.8, 0.97, 1.04);     // бирюзовая плитка
    else if (vTint > 2.5 && vTint < 3.5) c3 = col * vec3(0.62, 0.9, 1.0);      // вода
    else if (vTint > 5.5 && vTint < 6.5) c3 = col < 0.9 ? col * red * 1.2 : vec3(col); // трамплин
    // высота: всё, что далеко внизу под ярусом, тонет в белой дымке
    float below = uB - y;
    c3 = mix(c3, vec3(1.0), smoothstep(4.0, 38.0, below) * (0.25 + 0.3 * uHigh));
    vec3 c = mix(c3, uFogColor, fog);
    if (uLinearOut > 0.5) c = pow(c, vec3(2.2));
    gl_FragColor = vec4(c, 1.0);
  }
`;

export function createMaterial({ linearOut }) {
  return new THREE.ShaderMaterial({
    // изгиб зеркалит ориентацию треугольников, проще рисовать обе стороны
    side: THREE.DoubleSide,
    vertexShader: vert,
    fragmentShader: frag,
    uniforms: {
      uL: { value: L },
      uLz: { value: LZ },
      uB: { value: 0 },
      uFogNear: { value: LZ * 2.2 },
      uFogFar: { value: LZ * 6.0 },
      uFogColor: { value: new THREE.Color(1, 1, 1) },
      uLinearOut: { value: linearOut ? 1 : 0 },
      uCell: { value: CELL },
      uRow: { value: ROW },
      uTime: { value: 0 },
      uHigh: { value: 0 },
    },
  });
}

// Звезда-блик в проёме, куда нужно свернуть. Четыре луча, как на иконке.
// Рисуется через тот же изгиб; блум превращает её в сияние.
const starVert = /* glsl */ `
  attribute vec2 aCorner;
  attribute float aSize;
  uniform float uL;
  uniform float uLz;
  uniform float uB;
  uniform float uFogNear;
  uniform float uFogFar;
  varying vec2 vUv;
  varying float vFade;
  void main() {
    vec4 f = modelMatrix * vec4(position, 1.0);
    float s = exp(-f.z / uLz);
    float r = uL * s;
    float phi = f.x / uL;
    vec3 w = vec3(r * sin(phi), uB + (f.y - uB) * s, r * cos(phi));
    vec4 mv = viewMatrix * vec4(w, 1.0);
    mv.xy += aCorner * aSize * s;
    gl_Position = projectionMatrix * mv;
    vUv = aCorner;
    // гаснет в тумане и вблизи — чтобы не слепила, когда пробегаем мимо
    vFade = (1.0 - smoothstep(uFogNear, uFogFar, f.z)) * smoothstep(2.0, 9.0, f.z);
  }
`;

const starFrag = /* glsl */ `
  precision highp float;
  uniform float uLinearOut;
  varying vec2 vUv;
  varying float vFade;
  void main() {
    vec2 p = vUv;
    float r = length(p);
    float core = exp(-r * r * 70.0);
    float rays = exp(-abs(p.x) * 60.0) * exp(-abs(p.y) * 3.5) + exp(-abs(p.y) * 60.0) * exp(-abs(p.x) * 3.5);
    float halo = exp(-r * 8.0) * 0.12;
    float i = (core + rays * 0.45 + halo) * vFade;
    vec3 c = vec3(1.0, 0.95, 0.86) * i * 0.75;
    gl_FragColor = vec4(c, 1.0);
  }
`;

export function createStarMaterial({ linearOut }) {
  return new THREE.ShaderMaterial({
    vertexShader: starVert,
    fragmentShader: starFrag,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uL: { value: L },
      uLz: { value: LZ },
      uB: { value: 0 },
      uFogNear: { value: LZ * 2.2 },
      uFogFar: { value: LZ * 6.0 },
      uLinearOut: { value: linearOut ? 1 : 0 },
    },
  });
}

// ---- свет на пути ----
// Путь = «живые» клетки. Места решений: путь сместился вбок в узком месте
// или площадь сужается во вход в коридор. Там — яркое пятно и звезда.
function computeLight(world, inst) {
  const a = Math.max(0, inst.rowStart - 3);
  const rows = world.rows.slice(a);
  const reach = world.reach.slice(a);
  const alive = aliveBackward(rows, reach);
  const light = rows.map(() => new Float32Array(COLS));
  const events = [];
  const cnt = alive.map((r) => r.reduce((n, v) => n + v, 0));
  const bump = (r, c, v) => {
    if (r < 0 || r >= rows.length || rows[r][c] === WALL) return;
    light[r][c] = Math.max(light[r][c], v);
  };
  for (let r = 0; r < rows.length; r++) for (let c = 0; c < COLS; c++) if (alive[r][c]) bump(r, c, 0.1);
  for (let r = 1; r < rows.length; r++) {
    const ev = new Uint8Array(COLS);   // настоящий поворот в узком месте — тут и звезда
    for (let c = 0; c < COLS; c++) {
      if (!alive[r][c]) continue;
      const turn = !alive[r - 1][c] && cnt[r] <= 3;
      const mouth = cnt[r] <= cnt[r - 1] - 2;
      if (turn) ev[c] = 1;
      if (turn || mouth) {
        const k = turn ? 1 : 0.6;
        bump(r, c, k); bump(r + 1, c, 0.7 * k); bump(r - 1, c, 0.55 * k); bump(r - 2, c, 0.35 * k);
      }
    }
    // одна звезда на непрерывный кусок событий в ряду
    for (let c = 0; c < COLS; c++) {
      if (!ev[c] || ev[(c + COLS - 1) % COLS]) continue;
      let w = 1;
      while (w < COLS && ev[(c + w) % COLS]) w++;
      const cc = c + (w - 1) / 2;
      const code = rows[r][Math.floor(cc) % COLS];
      const lvl = lv(code);
      events.push({ row: a + r, col: cc, lvl });
    }
  }
  return { a, light, events };
}


// ---- сборка геометрии ----
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

class Builder {
  constructor() {
    this.pos = []; this.nor = []; this.sty = []; this.top = []; this.box = []; this.ao = []; this.lit = []; this.idx = [];
    this.aoFn = null; this.lightFn = null;
    this.tint = 0; this.tnt = [];
  }

  _vert(p, normal, style, top, box) {
    this.pos.push(p[0], p[1], p[2]);
    this.nor.push(normal[0], normal[1], normal[2]);
    this.sty.push(style); this.top.push(top); this.box.push(box[0], box[1], box[2], box[3]);
    this.ao.push(style === 0 && this.aoFn ? this.aoFn(p[0], p[2]) : 1);
    this.lit.push(this.lightFn && style !== 6 && style !== 7 ? this.lightFn(p[0], p[2]) : 0);
    this.tnt.push(this.tint);
  }

  // четырёхугольник по углам (билинейно), разбитый на сетку na × nb
  quad4(p00, p10, p01, p11, na, nb, normal, style, top, box) {
    const base = this.pos.length / 3;
    for (let j = 0; j <= nb; j++) {
      const v = j / nb;
      for (let i = 0; i <= na; i++) {
        const u = i / na;
        const p = [0, 1, 2].map((k) => (p00[k] * (1 - u) + p10[k] * u) * (1 - v) + (p01[k] * (1 - u) + p11[k] * u) * v);
        this._vert(p, normal, style, top, box);
      }
    }
    const row = na + 1;
    for (let j = 0; j < nb; j++) {
      for (let i = 0; i < na; i++) {
        const p = base + j * row + i;
        this.idx.push(p, p + 1, p + row, p + 1, p + row + 1, p + row);
      }
    }
  }

  // прямоугольная грань: origin + a*u + b*v
  quad(o, a, b, na, nb, normal, style, top, box) {
    const add = (x, y) => [x[0] + y[0], x[1] + y[1], x[2] + y[2]];
    this.quad4(o, add(o, a), add(o, b), add(add(o, a), b), na, nb, normal, style, top, box);
  }

  tri(p0, p1, p2, style, top) {
    const n = norm(cross(sub(p1, p0), sub(p2, p0)));
    const base = this.pos.length / 3;
    const box = [0, 0, 0, 0];
    this._vert(p0, n, style, top, box); this._vert(p1, n, style, top, box); this._vert(p2, n, style, top, box);
    this.idx.push(base, base + 1, base + 2);
  }

  // коробка от y0 до y1; верх/низ — по желанию (у мостов и потолков есть видимый низ)
  boxGeo(x0, x1, z0, z1, y1, style, y0 = 0, opts = {}) {
    const nx = Math.max(1, Math.ceil((x1 - x0) / SEG));
    const nz = Math.max(1, Math.ceil((z1 - z0) / SEG));
    const box = [x0, z0, x1, z1];
    const h = y1 - y0;
    if (opts.top ?? true) this.quad([x0, y1, z0], [0, 0, z1 - z0], [x1 - x0, 0, 0], nz, nx, [0, 1, 0], style, y1, box);
    if (opts.bottom ?? y0 > 0) this.quad([x0, y0, z0], [x1 - x0, 0, 0], [0, 0, z1 - z0], nx, nz, [0, -1, 0], style, y1, box);
    // ближняя грань (к игроку, −z)
    this.quad([x0, y0, z0], [x1 - x0, 0, 0], [0, h, 0], nx, 1, [0, 0, -1], style, y1, box);
    // дальняя грань (+z)
    this.quad([x1, y0, z1], [x0 - x1, 0, 0], [0, h, 0], nx, 1, [0, 0, 1], style, y1, box);
    // левая (−x)
    this.quad([x0, y0, z1], [0, 0, z0 - z1], [0, h, 0], nz, 1, [-1, 0, 0], style, y1, box);
    // правая (+x)
    this.quad([x1, y0, z0], [0, 0, z1 - z0], [0, h, 0], nz, 1, [1, 0, 0], style, y1, box);
  }

  // пол (возможно, наклонный — рампа): высота ya у ближнего края, yb у дальнего
  surface(x0, x1, z0, z1, ya, yb) {
    const nx = Math.ceil((x1 - x0) / SEG);
    const nz = Math.ceil((z1 - z0) / SEG);
    this.quad4([x0, ya, z0], [x0, yb, z1], [x1, ya, z0], [x1, yb, z1], nz, nx, [0, 1, 0], 0, 0, [x0, z0, x1, z1]);
  }

  // тело здания под (наклонной) крышей: от земли до ya…yb, без верха
  wedge(x0, x1, z0, z1, ya, yb, style) {
    const nx = Math.max(1, Math.ceil((x1 - x0) / SEG));
    const nz = Math.max(1, Math.ceil((z1 - z0) / SEG));
    const box = [x0, z0, x1, z1];
    const top = Math.max(ya, yb);
    const ny = Math.max(1, Math.ceil(top / 4));
    this.quad4([x0, 0, z1], [x0, 0, z0], [x0, yb, z1], [x0, ya, z0], nz, ny, [-1, 0, 0], style, top, box);
    this.quad4([x1, 0, z0], [x1, 0, z1], [x1, ya, z0], [x1, yb, z1], nz, ny, [1, 0, 0], style, top, box);
    this.quad([x0, 0, z0], [x1 - x0, 0, 0], [0, ya, 0], nx, ny, [0, 0, -1], style, top, box);
    this.quad([x1, 0, z1], [x0 - x1, 0, 0], [0, yb, 0], nx, ny, [0, 0, 1], style, top, box);
  }

  // гранёный стержень (ствол, ветка) от a до b
  prism(a, b, r0, r1, sides, style) {
    const d = norm(sub(b, a));
    const t = norm(cross(d, Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
    const u = cross(d, t);
    const ring = (c, r, k) => {
      const ang = (k / sides) * Math.PI * 2;
      const ca = Math.cos(ang) * r, sa = Math.sin(ang) * r;
      return [c[0] + t[0] * ca + u[0] * sa, c[1] + t[1] * ca + u[1] * sa, c[2] + t[2] * ca + u[2] * sa];
    };
    for (let k = 0; k < sides; k++) {
      const ang = ((k + 0.5) / sides) * Math.PI * 2;
      const n = [t[0] * Math.cos(ang) + u[0] * Math.sin(ang), t[1] * Math.cos(ang) + u[1] * Math.sin(ang), t[2] * Math.cos(ang) + u[2] * Math.sin(ang)];
      this.quad4(ring(a, r0, k), ring(a, r0, k + 1), ring(b, r1, k), ring(b, r1, k + 1), 1, 1, n, style, 0, [0, 0, 0, 0]);
    }
  }

  // пучок листвы: отдельные плоские треугольники, повёрнутые как попало
  leaves(c, radius, count, size, rng) {
    for (let i = 0; i < count; i++) {
      // точка внутри сплюснутого шара
      let px, py, pz;
      do { px = rng() * 2 - 1; py = rng() * 2 - 1; pz = rng() * 2 - 1; } while (px * px + py * py + pz * pz > 1);
      const p = [c[0] + px * radius, c[1] + py * radius * 0.75, c[2] + pz * radius];
      const n = norm([rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1]);
      const t = norm(cross(n, Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
      const u = cross(n, t);
      const e = size * (0.75 + rng() * 0.5);
      const a0 = rng() * Math.PI * 2;
      const v = [0, 1, 2].map((k) => {
        const ang = a0 + (k * Math.PI * 2) / 3;
        const ca = Math.cos(ang) * e, sa = Math.sin(ang) * e;
        return [p[0] + t[0] * ca + u[0] * sa, p[1] + t[1] * ca + u[1] * sa, p[2] + t[2] * ca + u[2] * sa];
      });
      this.tri(v[0], v[1], v[2], 6, rng());
    }
  }

  tree(x, y, z, rng, scale = 1) {
    const th = (1.9 + rng() * 0.9) * scale;
    const lean = [(rng() - 0.5) * 0.3, 0, (rng() - 0.5) * 0.3];
    const top = [x + lean[0], y + th, z + lean[2]];
    this.prism([x, y, z], top, 0.13 * scale, 0.08 * scale, 5, 7);
    const ends = [[top[0], top[1] + 0.5 * scale, top[2]]];
    const nb = 3 + Math.floor(rng() * 2);
    for (let i = 0; i < nb; i++) {
      const t = 0.5 + rng() * 0.4;
      const from = [x + lean[0] * t, y + th * t, z + lean[2] * t];
      const ang = (i / nb) * Math.PI * 2 + rng() * 0.8;
      const len = (0.9 + rng() * 0.6) * scale;
      const up = 0.55 + rng() * 0.35;
      const end = [from[0] + Math.cos(ang) * len, from[1] + up * len, from[2] + Math.sin(ang) * len];
      this.prism(from, end, 0.065 * scale, 0.03 * scale, 4, 7);
      ends.push(end);
    }
    // крона: пучки на концах веток, сквозь треугольники видны ветки
    for (const e of ends) this.leaves(e, 0.6 * scale, 13, 0.3 * scale, rng);
  }

  bush(x, y, z, rng, scale = 1) {
    const n = 1 + Math.floor(rng() * 2);
    for (let i = 0; i < n; i++) {
      this.leaves([x + (rng() - 0.5) * 0.7, y + 0.4 * scale, z + (rng() - 0.5) * 0.9], 0.45 * scale, 12, 0.22 * scale, rng);
    }
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('aStyle', new THREE.Float32BufferAttribute(this.sty, 1));
    g.setAttribute('aTop', new THREE.Float32BufferAttribute(this.top, 1));
    g.setAttribute('aBox', new THREE.Float32BufferAttribute(this.box, 4));
    g.setAttribute('aAO', new THREE.Float32BufferAttribute(this.ao, 1));
    g.setAttribute('aLight', new THREE.Float32BufferAttribute(this.lit, 1));
    g.setAttribute('aTint', new THREE.Float32BufferAttribute(this.tnt, 1));
    g.setIndex(this.idx);
    return g;
  }
}

// Жадно собирает одинаковые (по ключу) клетки в прямоугольники.
function greedy(nRows, key, emit, maxH = () => 99) {
  const used = Array.from({ length: nRows }, () => new Uint8Array(COLS));
  for (let r = 0; r < nRows; r++) {
    for (let c = 0; c < COLS; c++) {
      const k = key(r, c);
      if (k === null || used[r][c]) continue;
      let w = 1;
      while (c + w < COLS && !used[r][c + w] && key(r, c + w) === k) w++;
      let h = 1;
      const mh = maxH(r, c);
      outer: while (r + h < nRows && h < mh) {
        for (let i = 0; i < w; i++) if (used[r + h][c + i] || key(r + h, c + i) !== k) break outer;
        h++;
      }
      for (let rr = r; rr < r + h; rr++) for (let i = 0; i < w; i++) used[rr][c + i] = 1;
      emit(r, c, w, h, k);
    }
  }
}

// ---- городские предметы (заполняют свою клетку: столкновение — по клетке целиком) ----
function cabinets(b, x0, x1, zA, zB, y0, y1, ac) {
  // ряд электрошкафов (или кондиционеров на крыше) с узкими щелями
  const along = x1 - x0 >= zB - zA;
  const len = along ? x1 - x0 : zB - zA;
  const n = Math.max(1, Math.round(len / (ac ? 2 : 1.3)));
  const step = len / n;
  for (let i = 0; i < n; i++) {
    const a = i * step + 0.06, e = (i + 1) * step - 0.06;
    if (along) b.boxGeo(x0 + a, x0 + e, zA + 0.15, zB - 0.15, y1 - 0.08, 12, y0, { bottom: false });
    else b.boxGeo(x0 + 0.15, x1 - 0.15, zA + a, zA + e, y1 - 0.08, 12, y0, { bottom: false });
  }
  // общая крышка-козырёк по верху — чтобы край для прыжка читался целиком
  b.boxGeo(x0 + 0.05, x1 - 0.05, zA + 0.05, zB - 0.05, y1, 4, y1 - 0.08);
}

function kiosk(b, x0, x1, zA, zB, y0) {
  b.boxGeo(x0 + 0.35, x1 - 0.35, zA + 0.35, zB - 0.35, y0 + 1.75, 13, y0, { bottom: false, top: false });
  b.boxGeo(x0, x1, zA, zB, y0 + 2, 4, y0 + 1.75); // крыша с навесом
}

function container(b, x0, x1, zA, zB, y0, layers) {
  // морские контейнеры: гофра, стык между ярусами, яруса чуть сдвинуты
  for (let i = 0; i < layers; i++) {
    const o = i % 2 ? 0.12 : 0;
    const ya = y0 + i * 2, yb = y0 + (i + 1) * 2;
    b.boxGeo(x0 + 0.08 + o, x1 - 0.2 + o, zA + 0.1, zB - 0.1, yb - (i === layers - 1 ? 0 : 0.04), 11, ya, { bottom: false });
  }
}

function crates(b, x0, x1, zA, zB, y0, height, rng) {
  // штабель ящиков — ряды по ~1 м
  const nx = Math.max(1, Math.round((x1 - x0) / 1.33)), nz = Math.max(1, Math.round((zB - zA) / 1.33));
  const sx = (x1 - x0) / nx, sz = (zB - zA) / nz;
  const layers = Math.round(height / 1);
  const tint = b.tint;
  for (let l = 0; l < layers; l++) {
    b.tint = l === layers - 1 ? tint : 0; // красная кромка — только у верхнего яруса
    for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
      const g = l === layers - 1 ? 0.03 : 0.05 + rng() * 0.06;
      b.boxGeo(x0 + i * sx + g, x0 + (i + 1) * sx - g, zA + j * sz + g, zA + (j + 1) * sz - g, y0 + (l + 1) * (height / layers), 4, y0 + l * (height / layers), { bottom: false });
    }
  }
  b.tint = tint;
}

// Меш для одного вставленного паттерна. Координаты z — локальные (от начала паттерна).
export function buildInstanceMesh(inst, materials, world) {
  const b = new Builder();
  const rows = inst.rows;
  const nRows = rows.length;
  const z0 = inst.rowStart * ROW;
  const rng = mulberry32(inst.seed ^ 0x5bd1e995);
  const flatStreet = (row) => row.b0 === 0 && row.b1 === 0;

  // затенение пола: чем ближе к стене/препятствию, тем темнее (смотрим и соседние паттерны)
  b.aoFn = (x, zl) => {
    const z = zl + z0;
    const ci = Math.floor(x / CELL), ri = Math.floor(z / ROW);
    let d = 9;
    for (let dr = -1; dr <= 1; dr++) {
      const row = world.rows[ri + dr];
      if (!row) continue;
      for (let dc = -1; dc <= 1; dc++) {
        const v = row[((ci + dc) % COLS + COLS) % COLS];
        if (v === VOID || v === POOL || v === BRIDGE || v === 0) continue;
        const cx0 = (ci + dc) * CELL, cz0 = (ri + dr) * ROW;
        const dx = Math.max(cx0 - x, 0, x - (cx0 + CELL));
        const dz = Math.max(cz0 - z, 0, z - (cz0 + ROW));
        d = Math.min(d, Math.hypot(dx, dz));
      }
    }
    const t = Math.min(1, d / 1.6);
    return 0.68 + 0.32 * t * t * (3 - 2 * t);
  };
  const { a: la, light, events } = computeLight(world, inst);
  b.lightFn = (x, zl) => {
    const z = zl + z0;
    const ci = Math.floor(x / CELL), ri = Math.floor(z / ROW);
    let best = 0;
    for (let dr = -1; dr <= 1; dr++) {
      const lr = light[ri + dr - la];
      if (!lr) continue;
      for (let dc = -1; dc <= 1; dc++) {
        const v = lr[((ci + dc) % COLS + COLS) % COLS];
        if (v <= best) continue;
        const cx0 = (ci + dc) * CELL, cz0 = (ri + dr) * ROW;
        const dx = Math.max(cx0 - x, 0, x - (cx0 + CELL));
        const dz = Math.max(cz0 - z, 0, z - (cz0 + ROW));
        const f = Math.max(0, 1 - Math.hypot(dx, dz) / 2.2);
        best = Math.max(best, v * f * f);
      }
    }
    return best;
  };

  // 1. полы: путь (на своей высоте, рампы наклонные) и земля улицы под башнями и пропастями
  for (let r = 0; r < nRows; r++) {
    const row = rows[r];
    const zA = r * ROW, zB = zA + ROW;
    const key = (c) => {
      const v = row[c];
      if (walk(v) && lv(v) === 0) return 'p';
      const lo = Math.min(row.b0, row.b1);
      if ((v === WALL || v === RUNWALL) && lo >= 0) return 'g';
      if (v === VOID && lo > 0) return 'g'; // под пропастью между крышами — улица
      return null;
    };
    for (let c = 0; c < COLS;) {
      const k = key(c);
      if (!k) { c++; continue; }
      let w = 1;
      while (c + w < COLS && key(c + w) === k) w++;
      if (k === 'p') b.surface(c * CELL, (c + w) * CELL, zA, zB, row.b0, row.b1);
      else b.surface(c * CELL, (c + w) * CELL, zA, zB, 0, 0);
      c += w;
    }
  }
  b.aoFn = null;

  // 2. башни над стенами и над тоннелями; у некоторых вдоль улицы — клумба:
  //    башня отступает, у края — бетонная кадка с деревьями и кустами
  const R0 = inst.rowStart;
  const solid = (v) => v === WALL || v === RUNWALL;
  const towerKey = (r, c) => {
    const v = rows[r][c];
    if (rows[r].cover && !solid(v)) return 1;
    if (v === RUNWALL) return 9;
    if (v !== WALL) return null;
    return 1 + (planterAt(world, R0 + r, c, -1) ? 2 : 0) + (planterAt(world, R0 + r, c, 1) ? 4 : 0);
  };
  const plants = []; // где посадить деревья: [x, y, z, вид]
  greedy(nRows, towerKey, (r, c, w, h, k) => {
    const rnd = hash2(inst.seed, r * 31 + c);
    const style = 1 + Math.floor(hash2(inst.seed + 7, r * 17 + c) * 3); // 1..3
    let x0 = c * CELL, x1 = (c + w) * CELL;
    const zA = r * ROW, zB = (r + h) * ROW;
    for (const side of [-1, 1]) {
      if (!(k & (side < 0 ? 2 : 4))) continue;
      const px0 = side < 0 ? x0 : x1 - 1.1, px1 = px0 + 1.1;
      b.boxGeo(px0, px1, zA + 0.25, zB - 0.25, 0.75, 4);
      for (let zz = zA + 1.2; zz < zB - 0.8; zz += 2.2 + rng() * 2) {
        plants.push([(px0 + px1) / 2, 0.75, zz, rng() < 0.55 ? 'tree' : 'bush']);
      }
      if (side < 0) x0 += 1.3; else x1 -= 1.3;
    }
    // башня всегда заметно выше пола своих рядов (на верхушках небоскрёбов — тоже)
    let top = 0;
    for (let rr = r; rr < r + h; rr++) top = Math.max(top, rows[rr].b0, rows[rr].b1);
    b.boxGeo(x0 + 0.15, x1 - 0.15, zA + 0.15, zB - 0.15, Math.max(24 + rnd * 56, top + 12 + rnd * 35), style);
    if (k === 9) {
      // красная стена: панели на гранях, вдоль которых бегут
      b.tint = 5;
      for (let rr = r; rr < r + h; rr++) {
        const base = Math.min(rows[rr].b0, rows[rr].b1);
        const za = rr * ROW + (rr === r ? 0.15 : 0), zb = (rr + 1) * ROW - (rr === r + h - 1 ? 0.15 : 0);
        if (!solid(rows[rr][((c - 1) % COLS + COLS) % COLS])) b.boxGeo(x0 + 0.05, x0 + 0.17, za, zb, base + 9.5, 4, base + 0.3);
        if (!solid(rows[rr][(c + w) % COLS])) b.boxGeo(x1 - 0.17, x1 - 0.05, za, zb, base + 9.5, 4, base + 0.3);
      }
      b.tint = 0;
    }
  }, (r, c) => (rows[r][c] === WALL ? 1 + Math.floor(hash2(inst.seed, r * 31 + c) * 4) : 99));

  // 3. ниже улицы: фундаменты = стены траншей и тоннелей, потолки тоннелей
  for (let r = 0; r < nRows; r++) {
    const row = rows[r];
    const lo = Math.min(row.b0, row.b1);
    if (lo >= 0) continue;
    const zA = r * ROW, zB = zA + ROW;
    for (let c = 0; c < COLS;) {
      const v = row[c];
      const isWall = solid(v);
      const isCeil = row.cover && !isWall;
      if (!isWall && !isCeil) { c++; continue; }
      let w = 1;
      while (c + w < COLS && solid(row[c + w]) === isWall && (row.cover && !solid(row[c + w])) === isCeil) w++;
      if (isWall) b.boxGeo(c * CELL, (c + w) * CELL, zA, zB, 0, 9, lo - 0.3, { top: false, bottom: false });
      else b.boxGeo(c * CELL, (c + w) * CELL, zA, zB, 0, 8, lo + CEIL_H, { top: false, bottom: true });
      c += w;
    }
  }

  // 4. здания под путём на крышах и под рампами наверх
  greedy(nRows, (r, c) => {
    const row = rows[r], v = row[c];
    if (!walk(v) || Math.max(row.b0, row.b1) <= 0) return null;
    return row.b0 === row.b1 ? `f${row.b0}` : `r${r}`;
  }, (r, c, w, h) => {
    const row = rows[r], last = rows[r + h - 1];
    const flat = row.b0 === row.b1;
    const style = flat ? 2 + Math.floor(hash2(inst.seed + 3, r * 13 + c) * 2) : 4;
    b.wedge(c * CELL, (c + w) * CELL, r * ROW, (r + h) * ROW, row.b0, last.b1, style);
  });

  // 5. препятствия на пути — не кубы, а городские предметы: будки, электрошкафы,
  //    ящики, контейнеры, пристройки; на крышах — кондиционеры.
  //    В паттернах с vision — красные (Runner Vision): «по этому — наверх».
  greedy(nRows, (r, c) => {
    const row = rows[r], v = row[c];
    if (!walk(v) || lv(v) === 0 || row.b0 !== row.b1) return null;
    return v * 1000 + row.b0;
  }, (r, c, w, h) => {
    const base = rows[r].b0;
    const lvl = lv(rows[r][c]);
    const x0 = c * CELL, x1 = (c + w) * CELL, zA = r * ROW, zB = (r + h) * ROW;
    const pick = hash2(inst.seed + 41, r * 13 + c);
    b.tint = inst.vision ? 4 : 0;
    if (lvl === 1 && base > 0) cabinets(b, x0, x1, zA, zB, base, base + 2, true);
    else if (lvl === 1) {
      if (pick < 0.3) kiosk(b, x0, x1, zA, zB, base);
      else if (pick < 0.55) cabinets(b, x0, x1, zA, zB, base, base + 2, false);
      else if (pick < 0.8) crates(b, x0, x1, zA, zB, base, 2, rng);
      else container(b, x0, x1, zA, zB, base, 1);
    } else if (lvl === 2) {
      if (pick < 0.65) container(b, x0, x1, zA, zB, base, 2);
      else crates(b, x0, x1, zA, zB, base, 4, rng);
    } else {
      // пристройка: этажи с окнами и бетонный козырёк
      const style = 2 + Math.floor(pick * 2);
      b.boxGeo(x0 + 0.1, x1 - 0.1, zA + 0.1, zB - 0.1, base + lvl * LEVEL - 0.3, style, base, { bottom: false });
      b.boxGeo(x0, x1, zA, zB, base + lvl * LEVEL, 4, base + lvl * LEVEL - 0.3);
    }
    b.tint = 0;
  });

  // 6. мосты на улице, трубы в тоннеле — только подкатом
  for (let r = 0; r < nRows; r++) {
    const row = rows[r];
    for (let c = 0; c < COLS;) {
      if (row[c] !== BRIDGE) { c++; continue; }
      let w = 1;
      while (c + w < COLS && row[c + w] === BRIDGE) w++;
      const x0 = c * CELL, x1 = (c + w) * CELL, zA = r * ROW;
      const base = row.b0;
      if (row.cover) {
        // трубы под потолком — красные, как в Mirror's Edge; подвесы к потолку
        b.tint = 1;
        const zm = zA + ROW / 2;
        for (const [dz, y, rad] of [[-0.75, 1.42, 0.3], [0.05, 1.42, 0.3], [0.8, 1.38, 0.26], [-0.35, 2.0, 0.22], [0.45, 2.02, 0.24]]) {
          b.prism([x0, base + y, zm + dz], [x1, base + y, zm + dz], rad, rad, 8, 5);
        }
        b.tint = 0;
        for (let x = x0 + 1; x < x1; x += 2) b.boxGeo(x - 0.04, x + 0.04, zm - 0.9, zm + 0.9, base + CEIL_H, 5, base + 2.2);
      } else {
        // пешеходный мост: пролёт, балка снизу и перила
        b.boxGeo(x0 - 0.2, x1 + 0.2, zA + 0.6, zA + ROW - 0.6, base + BRIDGE_TOP, 5, base + BRIDGE_TOP - 0.7);
        b.boxGeo(x0 - 0.2, x1 + 0.2, zA + 0.9, zA + ROW - 0.9, base + BRIDGE_TOP - 0.7, 5, base + BRIDGE_BOTTOM);
        for (const zr of [zA + 0.68, zA + ROW - 0.68]) {
          for (let x = x0; x <= x1 + 0.01; x += 1.2) b.boxGeo(x - 0.03, x + 0.03, zr - 0.03, zr + 0.03, base + BRIDGE_TOP + 1.0, 4, base + BRIDGE_TOP);
          b.boxGeo(x0 - 0.2, x1 + 0.2, zr - 0.05, zr + 0.05, base + BRIDGE_TOP + 1.06, 4, base + BRIDGE_TOP + 0.96);
        }
      }
      c += w;
    }
  }

  // 7. пропасти между крышами: у края пути — улица и низкие дома (видно, что там обрыв),
  //    дальше от пути — дома средней высоты, чтобы вокруг был город, а не пустое небо
  // «у пути» — рядом есть пол (в пределах нескольких рядов: длинные пропасти)
  // или красная стена: между ними бегут по стенам, там должно быть пусто
  const nearPath = (r, c) => {
    for (let dr = -4; dr <= 4; dr++) {
      const row = world.rows[inst.rowStart + r + dr];
      if (!row) continue;
      for (let dc = -1; dc <= 1; dc++) if (walk(row[((c + dc) % COLS + COLS) % COLS])) return true;
    }
    const row = rows[r];
    for (let dc = -3; dc <= 3; dc++) if (row[((c + dc) % COLS + COLS) % COLS] === RUNWALL) return true;
    return false;
  };
  // после трамплина — по дуге летим над этими рядами, там должно быть пусто
  const afterLaunch = (r) => {
    for (let k = 1; k < LAUNCH_ROWS; k++) {
      const row = world.rows[R0 + r - k];
      if (row && row.includes(LAUNCH)) return true;
    }
    return false;
  };
  for (let r = 0; r < nRows; r++) {
    const base = Math.min(rows[r].b0, rows[r].b1);
    for (let c = 0; c < COLS; c++) {
      if (rows[r][c] !== VOID || base <= 0) continue;
      const hsh = hash2(inst.seed + 21, r * 19 + c);
      const x0 = c * CELL, zA = r * ROW;
      const sky = base > 20;
      let hgt;
      if (nearPath(r, c) || afterLaunch(r)) {
        // заметно ниже пути — видно обрыв; с небоскрёбов — далеко внизу
        hgt = sky && !afterLaunch(r) ? [0, 0, 8, 14, 20, 24][Math.floor(hsh * 6)] : [0, 0, 0, 2, 2, 4][Math.floor(hsh * 6)];
      } else {
        // дальше от пути — соседние дома; на небоскрёбах — в основном ниже, изредка выше
        hgt = sky
          ? (hsh < 0.2 ? base + 14 + hsh * 150 : base * (0.35 + hsh * 0.6))
          : 15 + Math.floor(hsh * 6) * 3;
        const style = 2 + Math.floor(hash2(inst.seed + 29, r * 11 + c) * 2);
        b.boxGeo(x0 + 0.4, x0 + CELL - 0.4, zA + 0.4, zA + ROW - 0.4, hgt, style);
        continue;
      }
      if (hgt > 4) {
        const style = 2 + Math.floor(hash2(inst.seed + 31, r * 7 + c) * 2);
        b.boxGeo(x0 + 0.4, x0 + CELL - 0.4, zA + 0.4, zA + ROW - 0.4, hgt, style);
        continue;
      }
      if (hgt > 0) b.boxGeo(x0 + 0.25, x0 + CELL - 0.25, zA + 0.25, zA + ROW - 0.25, hgt, 4);
      const g = hgt === 0 ? hash2(inst.seed + 23, r * 5 + c) : 1; // деревья — только внизу, на улице
      if (g < 0.45) plants.push([x0 + 1 + rng() * 2, hgt, zA + 1 + rng() * 2, 'tree']);
      if (g < 0.25) plants.push([x0 + 1 + rng() * 2, hgt, zA + 1 + rng() * 2, 'bush']);
    }
  }

  // 7б. канал на улице, дыра в пустоту в тоннеле, бассейн: стенки ямы и вода
  for (let r = 0; r < nRows; r++) {
    const row = rows[r];
    const base = Math.min(row.b0, row.b1);
    for (let c = 0; c < COLS; c++) {
      const v = row[c];
      if (!(v === POOL || (v === VOID && base <= 0))) continue;
      const abyss = v === VOID && row.cover;
      const depth = v === POOL ? 1.4 : abyss ? 30 : 4.6;
      const water = v === POOL ? base - 0.45 : abyss ? null : base - 4;
      const x0 = c * CELL, x1 = x0 + CELL, zA = r * ROW, zB = zA + ROW;
      const yb = base - depth;
      const style = abyss ? 16 : 9;
      b.tint = v === POOL ? 2 : 0;
      const same = (rr, cc) => { const rw = rows[rr] || world.rows[R0 + rr]; return rw && rw[((cc % COLS) + COLS) % COLS] === v; };
      // нормаль смотрит внутрь ямы; стенки чуть внутри клетки — иначе совпадают
      // с гранями фундаментов соседних стен и мерцают (z-fighting)
      const e = 0.04;
      if (!same(r, c - 1)) b.quad([x0 + e, yb, zA], [0, 0, ROW], [0, depth, 0], 4, Math.ceil(depth / 3), [1, 0, 0], style, base, [x0, zA, x1, zB]);
      if (!same(r, c + 1)) b.quad([x1 - e, yb, zB], [0, 0, -ROW], [0, depth, 0], 4, Math.ceil(depth / 3), [-1, 0, 0], style, base, [x0, zA, x1, zB]);
      if (!same(r - 1, c)) b.quad([x1, yb, zA + e], [-CELL, 0, 0], [0, depth, 0], 4, Math.ceil(depth / 3), [0, 0, 1], style, base, [x0, zA, x1, zB]);
      if (!same(r + 1, c)) b.quad([x0, yb, zB - e], [CELL, 0, 0], [0, depth, 0], 4, Math.ceil(depth / 3), [0, 0, -1], style, base, [x0, zA, x1, zB]);
      if (water !== null) {
        b.tint = 3;
        b.quad([x0, water, zA], [0, 0, ROW], [CELL, 0, 0], 4, 4, [0, 1, 0], 14, 0, [x0, zA, x1, zB]);
      }
      b.tint = 0;
    }
  }

  // 7в. трамплин: красная плита с белыми шевронами, чуть приподнята
  for (let r = 0; r < nRows; r++) {
    const row = rows[r];
    for (let c = 0; c < COLS;) {
      if (row[c] !== LAUNCH) { c++; continue; }
      let w = 1;
      while (c + w < COLS && row[c + w] === LAUNCH) w++;
      b.tint = 6;
      b.boxGeo(c * CELL + 0.1, (c + w) * CELL - 0.1, r * ROW + 0.3, (r + 1) * ROW - 0.1, row.b1 + 0.12, 17, row.b1, { bottom: false });
      b.tint = 0;
      c += w;
    }
  }

  // 7г. ограждения по бокам крыш, вдоль пропастей: стойки и два поручня
  for (let r = 0; r < nRows; r++) {
    const row = rows[r];
    if (row.b0 !== row.b1 || row.b0 <= 0) continue;
    const base = row.b0, zA = r * ROW, zB = zA + ROW;
    for (let c = 0; c < COLS; c++) {
      const v = row[c];
      if (!walk(v) || lv(v) !== 0 || v === LAUNCH) continue;
      for (const side of [-1, 1]) {
        if (row[((c + side) % COLS + COLS) % COLS] !== VOID) continue;
        const x = side < 0 ? c * CELL + 0.1 : (c + 1) * CELL - 0.1;
        for (let z = zA + 0.2; z < zB; z += 1.33) b.boxGeo(x - 0.035, x + 0.035, z - 0.035, z + 0.035, base + 1.1, 4, base);
        b.boxGeo(x - 0.05, x + 0.05, zA, zB, base + 1.14, 4, base + 1.04);
        b.boxGeo(x - 0.025, x + 0.025, zA, zB, base + 0.58, 4, base + 0.52);
      }
    }
  }

  // 8. деревья и кусты
  for (const [x, y, z, kind] of plants) {
    if (kind === 'tree') b.tree(x, y, z, rng, 0.9 + rng() * 0.5);
    else b.bush(x, y, z, rng, 0.9 + rng() * 0.3);
  }

  const group = new THREE.Group();
  const mesh = new THREE.Mesh(b.geometry(), materials.main);
  mesh.frustumCulled = false; // реальная форма после изгиба не совпадает с плоскими границами
  group.add(mesh);

  // звёзды только в своих рядах и редко: не чаще чем раз в 8 рядов на весь мир
  const pos = [], corner = [], size = [], idx = [];
  for (const e of events) {
    if (e.row < inst.rowStart || e.row >= inst.rowStart + nRows) continue;
    if (e.row - (world.lastStarRow ?? -99) < 8) continue;
    world.lastStarRow = e.row;
    const x = (e.col + 0.5) * CELL, y = world.rows[e.row].b1 + e.lvl * LEVEL + 3.2, z = (e.row - inst.rowStart + 0.5) * ROW;
    const base = pos.length / 3;
    for (const [cx, cy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      pos.push(x, y, z); corner.push(cx, cy); size.push(2.8);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  if (pos.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aCorner', new THREE.Float32BufferAttribute(corner, 2));
    g.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 1));
    g.setIndex(idx);
    const stars = new THREE.Mesh(g, materials.star);
    stars.frustumCulled = false;
    stars.renderOrder = 1;
    group.add(stars);
  }
  group.userData.zStart = inst.rowStart * ROW;
  group.userData.zEnd = (inst.rowStart + nRows) * ROW;
  return group;
}
