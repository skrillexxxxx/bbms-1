// Отрисовка: геометрия строится в плоском мире, а изгиб в круг
// делается одной формулой в вершинном шейдере:
//   r = L·e^(−dz/LZ),  φ = dx/L,  высота = y·e^(−dz/LZ)
// Формула одна и непрерывная, поэтому стыки кусков совпадают всегда.

import * as THREE from 'three';
import {
  COLS, CELL, ROW, LEVEL, W, L, LZ, WALL, BRIDGE, BRIDGE_BOTTOM, BRIDGE_TOP, hash2, aliveBackward,
} from './world.js';

const SEG = 1.0; // шаг разбиения по x/z, чтобы прямые рёбра красиво гнулись

const vert = /* glsl */ `
  attribute float aStyle;
  attribute float aTop;
  attribute vec4 aBox;
  attribute float aAO;
  attribute float aLight;
  uniform float uL;
  uniform float uLz;
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
    vec3 w = vec3(r * sin(phi), f.y * s, r * cos(phi));
    vec4 mv = viewMatrix * vec4(w, 1.0);
    gl_Position = projectionMatrix * mv;
    vPos = position;
    vN = normal;
    vStyle = aStyle;
    vTop = aTop;
    vBox = aBox;
    vDz = f.z;
    vDist = length(mv.xyz);
    // высоту восстанавливаем во фрагментном шейдере как vWY / vS:
    // оба значения линейны по всей грани-трапеции, поэтому полосы окон
    // не ломаются на диагонали между треугольниками
    vS = s;
    vWY = f.y * s;
    vAO = aAO;
    vLight = aLight;
  }
`;

const frag = /* glsl */ `
  precision highp float;
  uniform float uL;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform vec3 uFogColor;
  uniform float uLinearOut;
  uniform float uCell;
  uniform float uRow;
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

    if (vStyle < 0.5) {
      // земля в «каньоне» между башнями — в тени; сетка по клеткам — чтобы чувствовалась скорость
      col = 0.6;
      float g = max(lineAA(vPos.x, uCell, 0.03), lineAA(vPos.z, uRow, 0.03));
      col = mix(col, 0.5, g * 0.8);
      col *= vAO; // контактные тени у основания стен
      // свет с неба падает туда, куда нужно бежать: светлое пятно = путь
      col = col * (1.0 + vLight * 0.6) + vLight * 0.12;
    } else {
      // освещение по плоской нормали — стабильно, не зависит от поворота мира
      if (n.y > 0.5) col = 0.98;
      else if (n.y < -0.5) col = 0.55;   // низ моста
      else if (n.z < -0.5) col = vStyle > 3.5 && vStyle < 4.5 ? 0.74 : 0.90; // у низких зданий фасад темнее крыши — ступенька читается
      else if (n.x > 0.5) col = 0.76;
      else if (n.x < -0.5) col = 0.68;
      else col = 0.66;

      bool wallFace = abs(n.y) < 0.5;
      if (wallFace) {
        float y = vWY / vS;
        // вдоль грани: координата и расстояние до углов коробки
        float u = abs(n.x) > 0.5 ? vPos.z : vPos.x;
        float uMin = abs(n.x) > 0.5 ? vBox.y : vBox.x;
        float uMax = abs(n.x) > 0.5 ? vBox.w : vBox.z;
        float edge = min(u - uMin, uMax - u);
        float floorH = 3.3; // реальный этаж ~3.3 м (рост глаз 1.6)
        float fy = fract(y / floorH);
        bool inBody = y > 3.0 && y < vTop - 2.0 && edge > 0.8;

        if (vStyle > 1.5 && vStyle < 2.5 && inBody) {
          // ленточные окна — чёрные полосы, как на скринах
          if (fy > 0.3 && fy < 0.78) col = 0.06;
        } else if (vStyle > 2.5 && vStyle < 3.5 && inBody) {
          // сетка окон
          float fu = fract((u - uMin) / 2.6);
          if (fy > 0.28 && fy < 0.8 && fu > 0.18 && fu < 0.82) col = 0.07;
        }
        // тонкие межэтажные линии
        col = mix(col, col * 0.86, lineAA(y, floorH, 0.02));
        // свет только сверху: низ улицы в тени, к верху башен светлее
        col *= mix(0.6, 1.0, smoothstep(0.0, 45.0, y));
        // контактная тень у земли (кроме мостов — они висят в воздухе)
        if (vStyle < 4.5) col *= mix(0.8, 1.0, smoothstep(0.0, 2.5, y));
        // свет из прохода ложится на стены проёма, сильнее внизу
        col *= 1.0 + vLight * 0.55 * (1.0 - smoothstep(0.0, 18.0, y));
      }
    }

    // светлые рёбра: края крыш, углы, верх барьеров — чтобы читалась форма и край для прыжка
    if (vStyle > 0.5) {
      float y = vWY / vS;
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
      bool low = vStyle > 3.5 && vStyle < 5.5;  // низкие здания и мосты — ярче
      col = mix(col, low ? 1.08 : 1.0, rim * (low ? 0.95 : 0.6));
    }

    // туман: по глубине пути и по реальной дальности (гасит «изнанку» за центром)
    float f1 = smoothstep(uFogNear, uFogFar, vDz);
    float f2 = smoothstep(uL * 1.15, uL * 2.0, vDist);
    float fog = max(f1, f2);
    vec3 c = mix(vec3(col), uFogColor, fog);
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
      uFogNear: { value: LZ * 2.2 },
      uFogFar: { value: LZ * 6.0 },
      uFogColor: { value: new THREE.Color(1, 1, 1) },
      uLinearOut: { value: linearOut ? 1 : 0 },
      uCell: { value: CELL },
      uRow: { value: ROW },
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
  uniform float uFogNear;
  uniform float uFogFar;
  varying vec2 vUv;
  varying float vFade;
  void main() {
    vec4 f = modelMatrix * vec4(position, 1.0);
    float s = exp(-f.z / uLz);
    float r = uL * s;
    float phi = f.x / uL;
    vec3 w = vec3(r * sin(phi), f.y * s, r * cos(phi));
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
    float core = exp(-r * r * 60.0) * 1.4;
    float rays = exp(-abs(p.x) * 45.0) * exp(-abs(p.y) * 3.2) + exp(-abs(p.y) * 45.0) * exp(-abs(p.x) * 3.2);
    float halo = exp(-r * 7.0) * 0.3;
    float i = (core + rays * 0.8 + halo) * vFade;
    vec3 c = vec3(1.0, 0.95, 0.86) * i;
    if (uLinearOut > 0.5) c *= 1.6; // в HDR-цепочке блум подхватывает ярче единицы
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
    const ev = new Uint8Array(COLS);
    for (let c = 0; c < COLS; c++) {
      if (!alive[r][c]) continue;
      const turn = !alive[r - 1][c] && cnt[r] <= 5;
      const mouth = cnt[r] <= cnt[r - 1] - 2;
      if (turn || mouth) ev[c] = 1;
    }
    for (let c = 0; c < COLS; c++) {
      if (!ev[c]) continue;
      bump(r, c, 1); bump(r + 1, c, 0.7); bump(r - 1, c, 0.55); bump(r - 2, c, 0.35);
    }
    // одна звезда на непрерывный кусок событий в ряду
    for (let c = 0; c < COLS; c++) {
      if (!ev[c] || ev[(c + COLS - 1) % COLS]) continue;
      let w = 1;
      while (w < COLS && ev[(c + w) % COLS]) w++;
      const cc = c + (w - 1) / 2;
      const code = rows[r][Math.floor(cc) % COLS];
      const lvl = code === BRIDGE || code === WALL ? 0 : code;
      events.push({ row: a + r, col: cc, lvl });
    }
  }
  return { a, light, events };
}

// ---- сборка геометрии ----
class Builder {
  constructor() {
    this.pos = []; this.nor = []; this.sty = []; this.top = []; this.box = []; this.ao = []; this.lit = []; this.idx = [];
    this.aoFn = null; this.lightFn = null;
  }

  // прямоугольная грань, разбитая на сетку: origin + a*i + b*j
  quad(o, a, b, na, nb, normal, style, top, box) {
    const base = this.pos.length / 3;
    for (let j = 0; j <= nb; j++) {
      for (let i = 0; i <= na; i++) {
        const u = i / na, v = j / nb;
        this.pos.push(o[0] + a[0] * u + b[0] * v, o[1] + a[1] * u + b[1] * v, o[2] + a[2] * u + b[2] * v);
        this.nor.push(normal[0], normal[1], normal[2]);
        this.sty.push(style); this.top.push(top); this.box.push(box[0], box[1], box[2], box[3]);
        const px = this.pos[this.pos.length - 3], pz = this.pos[this.pos.length - 1];
        this.ao.push(style === 0 && this.aoFn ? this.aoFn(px, pz) : 1);
        this.lit.push(this.lightFn ? this.lightFn(px, pz) : 0);
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

  // коробка от y0 до y1 (у мостов y0 > 0 и есть видимый низ)
  boxGeo(x0, x1, z0, z1, y1, style, y0 = 0) {
    const nx = Math.max(1, Math.ceil((x1 - x0) / SEG));
    const nz = Math.max(1, Math.ceil((z1 - z0) / SEG));
    const box = [x0, z0, x1, z1];
    const h = y1 - y0;
    // крыша
    this.quad([x0, y1, z0], [0, 0, z1 - z0], [x1 - x0, 0, 0], nz, nx, [0, 1, 0], style, y1, box);
    if (y0 > 0) this.quad([x0, y0, z0], [x1 - x0, 0, 0], [0, 0, z1 - z0], nx, nz, [0, -1, 0], style, y1, box);
    // ближняя грань (к игроку, −z)
    this.quad([x0, y0, z0], [x1 - x0, 0, 0], [0, h, 0], nx, 1, [0, 0, -1], style, y1, box);
    // дальняя грань (+z)
    this.quad([x1, y0, z1], [x0 - x1, 0, 0], [0, h, 0], nx, 1, [0, 0, 1], style, y1, box);
    // левая (−x)
    this.quad([x0, y0, z1], [0, 0, z0 - z1], [0, h, 0], nz, 1, [-1, 0, 0], style, y1, box);
    // правая (+x)
    this.quad([x1, y0, z0], [0, 0, z1 - z0], [0, h, 0], nz, 1, [1, 0, 0], style, y1, box);
  }

  ground(x0, x1, z0, z1) {
    const nx = Math.ceil((x1 - x0) / SEG);
    const nz = Math.ceil((z1 - z0) / SEG);
    this.quad([x0, 0, z0], [0, 0, z1 - z0], [x1 - x0, 0, 0], nz, nx, [0, 1, 0], 0, 0, [x0, z0, x1, z1]);
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
    g.setIndex(this.idx);
    return g;
  }
}

// Меш для одного вставленного паттерна. Координаты z — локальные (от начала паттерна).
export function buildInstanceMesh(inst, materials, world) {
  const material = materials.main;
  const b = new Builder();
  const rows = inst.rows;
  const nRows = rows.length;
  const used = rows.map(() => new Uint8Array(COLS));

  // затенение земли: чем ближе к стене/зданию, тем темнее (смотрим и соседние паттерны)
  const z0 = inst.rowStart * ROW;
  b.aoFn = (x, zl) => {
    const z = zl + z0;
    const ci = Math.floor(x / CELL), ri = Math.floor(z / ROW);
    let d = 9;
    for (let dr = -1; dr <= 1; dr++) {
      const row = world.rows[ri + dr];
      if (!row) continue;
      for (let dc = -1; dc <= 1; dc++) {
        const v = row[((ci + dc) % COLS + COLS) % COLS];
        if (v === 0 || v === BRIDGE) continue;
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
  b.ground(0, W, 0, nRows * ROW);
  b.aoFn = null;

  // жадное объединение одинаковых клеток в прямоугольники
  for (let r = 0; r < nRows; r++) {
    for (let c = 0; c < COLS; c++) {
      const v = rows[r][c];
      if (v === 0 || used[r][c]) continue;
      let w = 1;
      while (c + w < COLS && rows[r][c + w] === v && !used[r][c + w]) w++;
      const rnd = hash2(inst.seed, r * 31 + c);
      const maxH = v === WALL ? 1 + Math.floor(rnd * 4) : 99;
      let h = 1;
      outer: while (r + h < nRows && h < maxH) {
        for (let k = 0; k < w; k++) {
          if (rows[r + h][c + k] !== v || used[r + h][c + k]) break outer;
        }
        h++;
      }
      for (let rr = r; rr < r + h; rr++) for (let k = 0; k < w; k++) used[rr][c + k] = 1;

      const x0 = c * CELL, x1 = (c + w) * CELL;
      const zA = r * ROW, zB = (r + h) * ROW;
      if (v === WALL) {
        const height = 24 + rnd * 56;
        const style = 1 + Math.floor(hash2(inst.seed + 7, r * 17 + c) * 3); // 1..3
        // небольшой отступ, чтобы между башнями были щели-тени
        b.boxGeo(x0 + 0.15, x1 - 0.15, zA + 0.15, zB - 0.15, height, style);
      } else if (v === BRIDGE) {
        b.boxGeo(x0 - 0.2, x1 + 0.2, zA + 0.6, zB - 0.6, BRIDGE_TOP, 5, BRIDGE_BOTTOM);
      } else {
        b.boxGeo(x0, x1, zA, zB, v * LEVEL, 4);
      }
    }
  }

  const group = new THREE.Group();
  const mesh = new THREE.Mesh(b.geometry(), material);
  mesh.frustumCulled = false; // реальная форма после изгиба не совпадает с плоскими границами
  group.add(mesh);

  // звёзды только в своих рядах, не чаще чем раз в 3 ряда
  const pos = [], corner = [], size = [], idx = [];
  let lastRow = -99;
  for (const e of events) {
    if (e.row < inst.rowStart || e.row >= inst.rowStart + nRows || e.row - lastRow < 3) continue;
    lastRow = e.row;
    const x = (e.col + 0.5) * CELL, y = e.lvl * LEVEL + 3.2, z = (e.row - inst.rowStart + 0.5) * ROW;
    const base = pos.length / 3;
    for (const [cx, cy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      pos.push(x, y, z); corner.push(cx, cy); size.push(4.5);
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
