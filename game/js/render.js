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
  attribute float aDark;
  varying float vDark;
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
  varying float vDx;
  varying vec3 vView;
  varying float vDist;
  varying float vS;
  varying float vWY;
  varying float vAO;
  varying float vLight;
  uniform mat4 uLampMat;
  uniform float uPs1;     // 0 — выкл; иначе «разрешение» сетки, к которой липнут вершины (по высоте)
  uniform float uAspectV;
  varying vec4 vLampPos;
  uniform mat4 uSunMat;
  varying vec4 vSunPos;
  void main() {
    vec4 f = modelMatrix * vec4(position, 1.0);   // плоские координаты относительно игрока
    float s = exp(-f.z / uLz);
    float r = uL * s;
    float phi = f.x / uL;
    // всё сходится к точке на высоте пола текущего яруса (uB)
    vec3 w = vec3(r * sin(phi), uB + (f.y - uB) * s, r * cos(phi));
    vec4 mv = viewMatrix * vec4(w, 1.0);
    gl_Position = projectionMatrix * mv;
    // PS1: вершины прилипают к грубой сетке экрана — при движении меш «дрожит» и плывёт
    if (uPs1 > 0.0) {
      vec2 grid = vec2(uPs1 * uAspectV, uPs1);
      gl_Position.xy = floor(gl_Position.xy / gl_Position.w * grid + 0.5) / grid * gl_Position.w;
    }
    // тень фонаря: точку проверки сдвигаем по нормали (на ~полтора текселя карты на этой дальности) —
    // иначе поверхность затеняет сама себя: полосы-дуги на полу и крапинки на стенах и окнах
    vec3 nW = vec3(normal.x * cos(phi) + normal.z * sin(phi), normal.y, -normal.x * sin(phi) + normal.z * cos(phi));
    float ldist = length(mv.xyz);
    vLampPos = uLampMat * vec4(w + nW * (0.03 + 0.004 * ldist), 1.0);
    // солнце светит в плоском мире, до изгиба; точка проверки сдвинута по нормали на ~текселя — без самозатенения
    vSunPos = uSunMat * vec4(f.xyz + normal * 0.15, 1.0);
    vPos = position;
    vN = normal;
    vStyle = aStyle;
    vTop = aTop;
    vBox = aBox;
    vDz = f.z;
    vDx = f.x;
    vView = mv.xyz;
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
    vDark = aDark;
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
  uniform float uRunZ;
  uniform float uDarkZ;   // где начинается тёмный переход (относительно игрока)
  uniform float uHigh;
  uniform float uNight;   // 0 — день, 1 — ночь
  uniform vec3 uStreetL[12]; // уличные фонари рядом: x, z относительно игрока, y — высота плафона
  varying float vDark;    // 1 — тёмный переход: свет не работает; 2 — разруха (постапокалипсис)
  uniform float uLamp;    // фонарь бегуна: ночью на улице 1, в подземке гаснет
  uniform vec3 uLampP;    // смещение луча (тряска на бегу) xy и радиус пятна z
  uniform sampler2D uCookie; // маска фонаря — снимок пятна реального фонаря
  uniform sampler2D uShadow;  // глубина с точки зрения фонаря
  uniform float uShadowOn;
  varying vec4 vLampPos;
  uniform sampler2D uSunShadow; // глубина с точки зрения солнца
  uniform float uSun;           // 0 — без солнечных теней (выкл, ночь, подземка)
  uniform vec3 uSunDir;         // направление на солнце
  varying vec4 vSunPos;
  uniform float uCookieOn;
  varying float vTint;
  varying vec3 vPos;
  varying vec3 vN;
  varying float vStyle;
  varying float vTop;
  varying vec4 vBox;
  varying float vDz;
  varying float vDx;
  varying vec3 vView;
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

  float h21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  // свет в окне: у каждого своя лампа — тёплая, нейтральная, холодная; изредка фиолетовый фитосвет
  // полоса a…b по x со сглаженными краями (ширина края — пиксель); вдали, где полосы мельче
  // пикселя, — просто средняя доля: иначе сетка окон рябит и мерцает при движении
  // x — дробная часть (fract), xs — та же величина без fract: производная берётся от неё, без скачка на шве
  float bandAA(float x, float xs, float a, float b) {
    float w = fwidth(xs) * 0.75 + 1e-4;
    float k = smoothstep(a - w, a + w, x) * (1.0 - smoothstep(b - w, b + w, x));
    return mix(k, b - a, smoothstep(0.12, 0.35, w));
  }
  vec3 winColor(float k) {
    if (k > 0.993) return vec3(0.72, 0.22, 1.15);   // редкость: кто-то растит рассаду под УФ-лампой
    // как в жизни: больше всего тёплых белых (2700–3000 K), есть нейтральные и почти белые,
    // изредка — старая лампа накаливания, пожелтее
    if (k < 0.12) return vec3(1.0, 0.8, 0.56);
    if (k < 0.6) return vec3(1.0, 0.87, 0.69);
    if (k < 0.88) return vec3(1.0, 0.93, 0.83);
    return vec3(1.0, 0.97, 0.92);
  }
  const vec3 WARM = vec3(1.0, 0.85, 0.66); // ночной свет: тёплый, но не жёлтый

  // палитра шариков: насыщенные, как в детском бассейне
  vec3 PALETTE(float h) {
    if (h < 0.2) return vec3(0.95, 0.2, 0.2);
    if (h < 0.4) return vec3(0.2, 0.55, 0.95);
    if (h < 0.6) return vec3(0.98, 0.82, 0.15);
    if (h < 0.8) return vec3(0.25, 0.8, 0.35);
    return vec3(0.9, 0.35, 0.8);
  }

  void main() {
    vec3 n = normalize(vN);
    float col;
    vec3 ballCol = vec3(-1.0); float ballShade = 1.0; // цветные шарики (бассейн, гелиевые)
    vec3 emit = vec3(0.0);  // ночной свет: окна, фонари, лампы — не темнеет ночью
    float rimK = 0.0;
    int st = int(vStyle + 0.5);
    float y = vWY / vS;
    // уличные фонари «Г»: конус тёплого света вниз — пятно на полу и на том, что под ним
    float streetL = 0.0;
    if (uNight > 0.0) {
      for (int i = 0; i < 12; i++) {
        vec3 L = uStreetL[i];
        if (L.y < -50.0) continue;
        vec2 d = vec2(vDx - L.x, vDz - L.z);
        float hh = L.y - y;
        if (hh < 0.0) continue;
        // чем ниже, тем шире пятно; к краю конуса мягко гаснет
        float rr = 0.6 + hh * 0.5;
        streetL += exp(-dot(d, d) / (rr * rr)) * (n.y > 0.5 ? 1.0 : 0.55);
        // стены рядом: пятно света по расстоянию до плафона в пространстве, ярче там, куда грань смотрит на фонарь
        if (abs(n.y) < 0.5) {
          vec3 dl = vec3(L.x - vDx, L.y - y, L.z - vDz);
          float d2 = dot(dl, dl);
          streetL += exp(-d2 / 20.0) * max(dot(n, dl * inversesqrt(d2 + 1e-4)), 0.0) * 1.6;
        }
      }
      streetL = min(streetL, 1.4);
    }

    if (st == 0) {
      // пол: земля в «каньоне» между башнями — в тени; сетка по клеткам — чтобы чувствовалась скорость
      // дно каньона между башнями — темнее фасадов наверху
      col = 0.5;
      float g = max(lineAA(vPos.x, uCell, 0.03), lineAA(vPos.z, uRow, 0.03));
      col = mix(col, 0.41, g * 0.8);
      col *= vAO; // контактная тень у основания стен — мягкая, как в жизни
      // в стороне от пути (тупики, дворы, углы) пол уходит в тень
      // в стороне от пути — чуть темнее, но ровно и мягко: без пятен (было: пятна от вершинной подсветки пути).
      // В тоннеле пол освещён лампами сверху весь, одинаково
      float under = 1.0 - smoothstep(-5.0, -0.3, y);
      float pathL = smoothstep(0.0, 0.35, vLight);
      col *= mix(mix(mix(0.86, 0.95, uSun), 1.0, pathL), 1.0, under);
      if (uNight > 0.0) {
        // улица ночью: широкие мягкие тёплые пятна (фонари, витрины) — гуще на пути, но и вокруг есть
        float onPath = smoothstep(0.03, 0.2, vLight);
        float pool = 0.0;
        vec2 cellP = vec2(floor(vPos.x / uCell), floor(vPos.z / (uRow * 2.0)));
        for (int i = -1; i <= 1; i++) {
          for (int j = -1; j <= 1; j++) {
            vec2 cid = cellP + vec2(float(i), float(j));
            float h = h21(cid * 1.37 + 4.1);
            if (h < 0.45) continue;
            vec2 c = (cid + 0.5 + (vec2(h21(cid + 9.3), h21(cid + 2.7)) - 0.5) * 0.7) * vec2(uCell, uRow * 2.0);
            vec2 d = vPos.xz - c;
            pool += exp(-dot(d, d) / 20.0) * (0.55 + 0.45 * h);
          }
        }
        emit += WARM * min(pool, 1.0) * (0.12 + 0.18 * onPath) * uNight;
      }
    } else if (st == 6) {
      // листва: отдельные треугольники, у каждого свой оттенок
      // листва серая, не белая (белая уходила за порог блума и «светилась»); у земли — в тени, как дома
      col = (0.6 + 0.14 * vTop) * (0.9 + 0.1 * abs(n.y));
      col *= mix(0.45, 1.0, smoothstep(0.0, 30.0, y - uB));
    } else if (st == 7) {
      col = (0.5 + 0.06 * n.x) * mix(0.45, 1.0, smoothstep(0.0, 30.0, y - uB)); // ствол и ветки
    } else if (st == 14) {
      // вода: светлая рябь, бегущая по поверхности
      float w1 = sin(vPos.x * 2.3 + uTime * 1.6 + sin(vPos.z * 1.7 + uTime));
      float w2 = sin(vPos.z * 2.9 - uTime * 1.3 + sin(vPos.x * 1.3 - uTime * 0.7));
      col = 0.5 + 0.35 * smoothstep(0.75, 1.0, w1 * w2 * 0.5 + 0.5);
    } else if (st == 19) {
      // бассейн с шариками: плотно уложенные разноцветные шарики, у каждого свой цвет и блик
      vec2 q = vPos.xz * 3.2;
      vec2 id = floor(q + vec2(0.0, mod(floor(q.x), 2.0) * 0.5));
      vec2 fq = fract(q + vec2(0.0, mod(floor(q.x), 2.0) * 0.5)) - 0.5;
      float d = length(fq);
      col = 1.0;
      ballCol = PALETTE(h21(id + 3.7));
      ballShade = (1.0 - smoothstep(0.38, 0.5, d)) * (0.75 + 0.35 * (0.5 - fq.y - fq.x * 0.3)) + 0.15;
    } else if (st == 20) {
      // гелиевый шарик: гладкий глянцевый, цвет — по номеру
      col = 1.0;
      ballCol = PALETTE(fract(vTop * 0.618));
      ballShade = 0.55 + 0.45 * max(dot(n, normalize(vec3(-0.3, 0.6, -0.7))), 0.0) + 0.35 * pow(max(dot(n, normalize(vec3(-0.4, 0.5, -0.75))), 0.0), 18.0);
    } else if (st == 29) {
      // кора поваленного дерева: серо-коричневая, светлее живых стволов — читается как бревно, а не балка
      col = 0.42 * (0.78 + 0.22 * abs(n.y)) * (0.9 + 0.1 * sin(vPos.y * 9.0 + vPos.x * 3.0 + vPos.z * 3.0));
    } else if (st == 28) {
      col = 0.05; // выбоина в краю провала — тёмная
    } else if (st == 27) {
      // бетонные обломки: серые, пятнами, сколы светлее
      col = 0.52 * (0.82 + 0.18 * abs(n.y));
    } else if (st == 26) {
      // мусорный контейнер: белый пластик, у земли грязнее, рёбра на боках
      col = 0.84 * mix(0.7, 1.0, smoothstep(0.1, 0.6, y - uB));
      if (abs(n.y) < 0.5) col *= 0.93 + 0.07 * step(0.5, fract((abs(n.x) > 0.5 ? vPos.z : vPos.x) / 0.45));
    } else if (st == 24) {
      col = 0.42; // столб фонаря — серый крашеный металл
    } else if (st == 25) {
      // плафон: снизу — стекло, ночью горит
      col = 0.55;
      if (n.y < -0.5) { col = mix(0.4, 0.8, uNight); emit += vec3(1.0, 0.88, 0.68) * 2.2 * uNight; }
      else emit += vec3(1.0, 0.88, 0.68) * 0.9 * uNight; // стекло светится и по бокам — видно издалека
    } else if (st == 22) {
      col = 0.62 + 0.15 * abs(n.y); // хромированная проволока тележки
    } else if (st == 23) {
      // неисправная лампа: то гаснет, то вспыхивает
      float f1 = step(0.55, fract(sin(floor(uTime * 23.0) * 12.9898) * 43758.5453));
      float f2 = step(0.8, fract(sin(floor(uTime * 7.0) * 78.233) * 43758.5453));
      col = 0.15 + 1.4 * max(f1 * 0.6, f2);
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
      col *= 1.0 + vLight * 0.35;
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
      emit += vec3(1.25) * lamp * uNight;
    } else {
      // освещение по плоской нормали — стабильно, не зависит от поворота мира
      // крыши: у высоток светлые (их почти не видно), у низких зданий и мостов —
      // светло-серые, ниже порога блума, иначе выгорают в чистый белый
      if (n.y > 0.5) {
        col = st >= 4 ? 0.8 : 0.95;
        // верх низких предметов у земли — в тени, как стены внизу; крыши высоток светлые
        col *= mix(mix(0.74, 0.88, uSun), 1.0, pow(smoothstep(-2.0, 50.0, y - uB), 0.6));
        // клумба (низкий бортик ~0.75 м): сверху тёмная земля с неровной фактурой
        if (st == 4 && vTop < 1.2) {
          float nn = h21(floor(vPos.xz * 6.0)) * 0.6 + h21(floor(vPos.xz * 1.7)) * 0.4;
          col = 0.16 + 0.1 * nn;
        }
      }
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

        // ночью окна загораются: каждое — своё, по хешу дома, этажа и номера окна
        // номер дома — из округлённых границ коробки: интерполяция varying даёт в каждом пикселе
        // крошечную ошибку, и хеш у окон «на пороге» горел/гас попиксельно — окна шли рябью
        vec4 bq = floor(vBox * 2.0 + 0.5);
        vec2 bid = mod(vec2(bq.x * 1.7 + bq.w * 0.37, bq.y * 0.91 + bq.z * 1.3), 289.0);
        // окна яркие, но горит меньше половины; у земли чуть тусклее — не спорят с путём
        float winK = mix(0.6, 1.0, smoothstep(6.0, 30.0, y));
        if (st == 2 && inBody) {
          // ленточные окна — чёрные полосы, как на скринах
          float wm = bandAA(fy, y / floorH, 0.3, 0.78);
          if (wm > 0.0) {
            col = mix(col, 0.06, wm);
            float h = h21(vec2(floor((u - uMin) / 3.4), floor(y / floorH)) + bid);
            if (h > 0.84) emit += winColor(h21(vec2(floor((u - uMin) / 3.4) + 5.1, floor(y / floorH)) + bid)) * winK * (1.25 + 1.6 * (h - 0.84)) * uNight * wm;
          }
        } else if (st == 3 && inBody) {
          // сетка окон
          float fu = fract((u - uMin) / 2.6);
          float wm = bandAA(fy, y / floorH, 0.28, 0.8) * bandAA(fu, (u - uMin) / 2.6, 0.18, 0.82);
          if (wm > 0.0) {
            col = mix(col, 0.07, wm);
            float h = h21(vec2(floor((u - uMin) / 2.6), floor(y / floorH)) + bid);
            // большинство тёплые, некоторые — холодный свет экранов
            vec3 wc = winColor(h21(vec2(floor((u - uMin) / 2.6) + 5.1, floor(y / floorH)) + bid));
            if (h > 0.84) emit += wc * winK * (1.25 + 1.6 * (h - 0.84)) * uNight * wm;
          }
        }
        if (vDark > 1.5 && st >= 1 && st <= 3) {
          // разруха: в окнах света нет (разрушение — формой домов, а не мелкой грязью на стенах);
          // изредка в окне — огонь
          emit = vec3(0.0);
          float fire = h21(vec2(floor((u - uMin) / 2.6), floor(y / floorH)) + bid + 17.0);
          if (inBody && fire > 0.988 && fy > 0.28 && fy < 0.8) {
            col = 0.1;
            emit = vec3(1.0, 0.42, 0.1) * (1.0 + 0.45 * sin(uTime * 13.0 + fire * 60.0) + 0.3 * sin(uTime * 23.0)) * (0.35 + 0.9 * uNight);
          }
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
        // свет только сверху (небо): низ улицы в глубокой тени, к верху башен светлее.
        // Отсчёт от уровня, где бежим, — на крышах тоже работает
        float hy = y - uB;
        // три яруса, как в бетонных каньонах: у земли темно (~30%), середина умеренная, верх светлый
        // с тенями солнца градиент слабее — иначе в сумме слишком темно
        // с солнцем общее затемнение почти уходит — контраст делают свет и тень от солнца
        // без солнечных теней — мягче (раньше стены у земли уходили почти в чёрное)
        col *= mix(mix(0.7, 0.88, uSun), 1.0, pow(smoothstep(-2.0, 60.0, hy), 0.6));
        // контактная тень у земли (кроме мостов — они висят в воздухе)
        if (st < 5) col *= mix(0.92, 1.0, smoothstep(0.0, 1.4, y));
        // свет из прохода ложится на стены проёма (до ~35 м вверх), остальные фасады чуть серее —
        // проём, куда бежать, читается светлым коридором. Ниже порога блума — без пересвета
        // (подсветка проёма по «свету пути» убрана: она считалась по вершинам и давала пятна и
        //  разную яркость у стен в одной плоскости)
        // ночью низ домов подсвечен тёплым светом с улицы
        emit += WARM * 0.1 * (1.0 - smoothstep(0.0, 12.0, hy)) * (0.5 + 0.5 * smoothstep(0.02, 0.3, vLight)) * uNight;
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
      float width = max(0.03, fw * 0.8);        // тонкая линия: вблизи 3 см, вдали ~1 пиксель
      float rim = 1.0 - smoothstep(width, width + fw * 1.0, e);
      bool low = st >= 4;                       // низкие здания, предметы, мосты — кромка заметнее
      // не свечение, а потёртость: угол чуть светлее, будто краска стёрлась
      col = mix(col, min(col * 1.18 + 0.03, 0.85), rim * (low ? 0.55 : 0.4));
      rimK = rim * (low ? 0.3 : 0.15);
    }

    // солнце: резкие тени от домов друг на друга. Грань, повёрнутая от солнца, — тоже в тени
    if (uSun > 0.0 && st != 8 && st != 9 && st != 16) {
      float facing = dot(n, uSunDir);
      float sl = 0.0;
      vec3 sp3 = vSunPos.xyz / vSunPos.w * 0.5 + 0.5;
      if (sp3.x > 0.0 && sp3.x < 1.0 && sp3.y > 0.0 && sp3.y < 1.0 && sp3.z < 1.0) {
        float o = 1.0 / 2048.0, bias = 0.0003 + 0.0006 * (1.0 - abs(facing));
        sl += step(sp3.z - bias, texture2D(uSunShadow, sp3.xy + vec2(-o, -o)).r);
        sl += step(sp3.z - bias, texture2D(uSunShadow, sp3.xy + vec2(o, -o)).r);
        sl += step(sp3.z - bias, texture2D(uSunShadow, sp3.xy + vec2(-o, o)).r);
        sl += step(sp3.z - bias, texture2D(uSunShadow, sp3.xy + vec2(o, o)).r);
        sl *= 0.25;
      } else sl = 1.0;
      sl *= smoothstep(-0.05, 0.15, facing);
      // контраст солнца: освещённое заметно ярче (но ниже порога блума), тень — глубже
      col *= mix(1.0, mix(0.62, min(1.4, 0.93 / max(col, 0.01)), sl), uSun);
    }

    // под землёй темнее — чем глубже, тем сильнее; светильники не трогаем
    // пол тоннеля — светлый (лампы прямо над ним), темнее только стены и потолок
    if (!(st == 8 && n.y < -0.5)) col *= 1.0 - (st == 0 ? 0.12 : 0.38) * (1.0 - smoothstep(-5.0, -0.3, y));

    // туман: по глубине пути и по реальной дальности (гасит «изнанку» за центром)
    float f1 = smoothstep(uFogNear, uFogFar, vDz);
    float f2 = smoothstep(uL * 1.15, uL * 2.0, vDist);
    float fog = max(f1, f2);
    // цвет: в белом мире — редкие акценты, как в Mirror's Edge
    vec3 c3 = vec3(col);
    if (ballCol.x >= 0.0) c3 = ballCol * ballShade;
    vec3 red = vec3(1.0, 0.2, 0.15);
    // Runner Vision: издалека предметы белые, краснеют по мере приближения
    // ночью красное видно издалека — неоновые подсказки пути
    float near = 1.0 - smoothstep(mix(16.0, 40.0, uNight), mix(34.0, 75.0, uNight), vDz);
    if (vTint > 0.5 && vTint < 1.5) c3 = mix(c3, col * red * 0.95, near);      // красные трубы
    else if (vTint > 3.5 && vTint < 4.5) {
      // Runner Vision: красный только верх и кромка — «хватайся здесь»
      // кромка — сплошная красная; верх — шевроны-стрелки вперёд (как ограждения трассы),
      // а не сплошная заливка: большие ступени не горят ровным красным пятном
      float k;
      if (n.y > 0.5) {
        float ax = abs(fract(vPos.x / uCell) - 0.5) * uCell;
        // остриё стрелки — вперёд, по ходу бега; широкие шевроны: ~1.6 м полоса, ~1.6 м просвет
        float chs = (vPos.z + ax * 0.9) / 3.2;
        float ch = fract(chs);
        float fw = fwidth(chs) + 1e-3;
        k = smoothstep(0.0, fw, ch) * (1.0 - smoothstep(0.5 - fw, 0.5, ch));
        float ex = min(min(vPos.x - vBox.x, vBox.z - vPos.x), min(vPos.z - vBox.y, vBox.w - vPos.z));
        k = max(k, 1.0 - smoothstep(0.12, 0.16, ex));     // красная окантовка по краю верха
      } else k = 1.0 - smoothstep(0.2, 0.26, vTop - y);
      c3 = mix(c3, col * red * 1.1, k * near);
    } else if (vTint > 4.5 && vTint < 5.5) {
      // красная стена: белая панель с красными полосами на высоте бега
      // полосы под 45°, «вверх и вперёд» — по направлению бега
      // широкие полосы: ~2 м полоса, ~2 м просвет (край сглажен)
      float sp = (y - vPos.z) / 4.0;
      float fwS = fwidth(sp) + 1e-3;
      float fs = fract(sp);
      float k = smoothstep(0.0, fwS, fs) * (1.0 - smoothstep(0.5 - fwS, 0.5, fs));
      c3 = mix(c3 * 1.05, vec3(col * 0.9) * red, k * near);
    }
    else if (vTint > 1.5 && vTint < 2.5) c3 = col * vec3(0.8, 0.97, 1.04);     // бирюзовая плитка
    else if (vTint > 2.5 && vTint < 3.5) c3 = col * vec3(0.62, 0.9, 1.0);      // вода
    else if (vTint > 5.5 && vTint < 6.5) c3 = col < 0.9 ? col * red * 1.2 : vec3(col); // трамплин
    else if (vTint > 6.5 && vTint < 7.5) c3 = col * vec3(0.78, 0.48, 0.34);   // ржавая арматура
    // красные подсказки «переливаются»: по ним бегут вперёд волны — показывают, куда бежать
    float redWave = 0.0;
    if (vTint > 0.5 && vTint < 1.5 || vTint > 3.5 && vTint < 6.5) {
      float red0 = clamp((c3.r - max(c3.g, c3.b)) * 2.2, 0.0, 1.0);
      // плавная волна: синус без резких фронтов, длинная и неторопливая
      float ph = (vDz + uRunZ) / 20.0 - uTime * 1.1;
      float wave = 0.5 - 0.5 * cos(6.2831853 * ph);
      wave = wave * wave * (3.0 - 2.0 * wave);
      redWave = wave;
      // ночью — контрастно: бледный красный ↔ насыщенный пересвеченный (с блумом);
      // днём — спокойно: красный лишь мягко «дышит», без вспышек
      float amp = mix(0.3, 1.0, uNight);
      vec3 lowR = mix(c3, mix(vec3(col * 0.95), c3, 0.38), amp);
      // гребень — насыщенный, но не ярче белого: без блума, красное не перебивает остальное
      vec3 highR = mix(c3 * 1.08, vec3(0.95, 0.16, 0.12) * max(col, 0.7), amp);
      // на красных стенах волна — маска прозрачности полос: на гребне полосы яркие,
      // в провале полностью исчезают (видна белая стена)
      if (vTint > 4.5 && vTint < 5.5) lowR = vec3(col * 1.05);
      c3 = mix(c3, mix(lowR, highR, vTint > 4.5 && vTint < 5.5 ? smoothstep(0.1, 0.9, wave) : wave), red0);
    }
    vec3 alb = c3; // цвет поверхности до ночи и темноты — от него считается свет фонаря
    // ночь: всё темнеет и синеет; кромки чуть светятся (видно, куда прыгать), красное горит
    if (uNight > 0.0) {
      bool redLit = vTint > 0.5 && vTint < 1.5 || vTint > 3.5 && vTint < 6.5;
      // вдали от пути — глубокая темнота, у пути чуть светлее: ночь неравномерная, путь контрастный
      float nearPath = smoothstep(0.02, 0.35, vLight);
      // ночной свет тёплый — от тысяч жёлтых окон
      vec3 dark = c3 * vec3(0.155, 0.16, 0.185) * mix(0.7, 1.0, nearPath);
      // красные акценты ночью горят как неон: ярче порога блума — с ореолом, видно издалека.
      // Светится только сама красная краска; белая стена между полосами темнеет, как все стены ночью
      float redness = clamp((c3.r - max(c3.g, c3.b)) * 2.2, 0.0, 1.0);
      if (redLit) dark = mix(dark, c3 * vec3(0.75, 0.6, 0.6), near * redness);
      if (redLit) dark += vec3(1.0, 0.1, 0.07) * redness * (0.12 + 0.38 * redWave);
      dark += vec3(0.3, 0.33, 0.4) * rimK;
      // низ стен домов ночью освещён почти как земля (фонари, витрины), выше — уходит в темноту:
      // стены и пол внизу кадра сливаются в одно целое
      if (st >= 1 && st <= 3 && abs(n.y) < 0.5) {
        float hy = y - uB;
        float low = smoothstep(-8.0, 0.0, hy) * (1.0 - smoothstep(0.0, 14.0, hy));
        dark += c3 * vec3(0.2, 0.2, 0.22) * low * mix(0.6, 1.0, nearPath);
      }
      dark += c3 * WARM * streetL * 1.15; // пятно от уличного фонаря
      // сам фонарь ночью виден силуэтом: столб и колпак подсвечены своим светом и витринами
      if (st == 24) dark += c3 * WARM * (0.3 + 0.5 * smoothstep(3.0, 7.0, y - uB));
      // препятствия у земли (то, через что прыгаем и под чем катимся) ночью не проваливаются в черноту:
      // тёплый свет с улицы, ярче на гранях к нам и сверху — видно издалека, ещё до фонаря
      bool obstacle = (st == 4 || st == 5 || (st >= 11 && st <= 13) || st == 26 || st == 27 || st == 29) && vTop - uB < 4.0;
      if (obstacle) {
        float of = n.y > 0.5 ? 0.9 : (n.y < -0.5 ? 0.25 : 0.45 + 0.55 * max(-n.z, 0.0));
        dark += (c3 * 0.42 + 0.07) * WARM * of; // + ровная добавка — тёмные части (стекло, решётки) тоже видно
        // будка ночью светится изнутри: её тёмное стекло — тёплое окошко
        if (st == 13 && col < 0.15 && n.y < 0.5 && n.y > -0.5) dark += WARM * 0.55;
      }

      c3 = mix(c3, dark + emit, uNight);
    }
    // тёмный переход: свет не работает — почти темнота, только красное чуть видно и неисправная лампа
    if (vDark > 0.5 && vDark < 1.5 && st != 23) {
      float redness = clamp((alb.r - max(alb.g, alb.b)) * 2.2, 0.0, 1.0);
      vec3 darkC = alb * vec3(0.045, 0.045, 0.055) + vec3(0.35, 0.05, 0.04) * redness * near;
      // вход освещён: дневной свет с улицы заходит на первые метры, у самого входа — лампа над ним.
      // С улицы видно, куда ведёт вход (и стену за поворотом); дальше — темнота
      float into = vDz - uDarkZ;
      float day = 1.0 - smoothstep(6.0, 18.0, into);
      float spot = exp(-(into - 4.0) * (into - 4.0) / 16.0) * 0.35;
      c3 = mix(darkC, alb * (1.0 + spot), day);
    }
    // фонарь бегуна, как в хоррорах: круглое пятно по центру взгляда (чуть ниже), мягкий ореол
    // и светлое кольцо по краю. Считаем по направлению от камеры, вблизи ярко, вдаль слабеет
    if (uLamp > 0.0) {
      // пятно шире по горизонтали — как у настоящего фонаря, и не теряется на широком экране
      vec2 sp = vView.xy / max(-vView.z, 0.05) - uLampP.xy;
      if (uCookieOn < 0.5) sp.x *= 0.78; // нарисованное пятно — овал; маска — ровный круг
      float R = uLampP.z;
      float r = length(sp);
      float spot = 1.0 - smoothstep(R * 0.7, R * 1.2, r);
      float ring = exp(-pow((r - R * 0.95) / (R * 0.1), 2.0)) * 0.3;
      float halo = (1.0 - smoothstep(R * 1.1, R * 2.6, r)) * 0.3;
      if (uCookieOn > 0.5) {
        // маска: вся картинка — пятно с ореолом, её край — R·2.4 от центра
        vec2 cuv = sp / (R * 2.4) * 0.5 + 0.5;
        float ck = texture2D(uCookie, clamp(cuv, 0.0, 1.0)).r;
        ck *= step(abs(cuv.x - 0.5), 0.5) * step(abs(cuv.y - 0.5), 0.5);
        spot = ck * ck * 1.15; ring = 0.0; halo = ck * 0.45;
      }
      float dist = length(vView);
      float att = 1.0 / (1.0 + dist * dist / 220.0);
      float face = n.y > 0.5 ? 0.75 : (n.y < -0.5 ? 0.3 : 0.45 + 0.55 * max(-n.z, 0.0) + 0.3 * abs(n.x));
      float fl = 0.94 + 0.06 * step(0.97, fract(sin(floor(uTime * 9.0) * 12.9898) * 43758.5453));
      vec3 lampL = alb * vec3(1.0, 0.97, 0.9) * (spot + ring + halo) * att * face * fl * uLamp
                 + vec3(0.05) * spot * att * uLamp;
      if (uShadowOn > 0.5) {
        // тень: 4 выборки вокруг — мягкий край
        vec3 lp = vLampPos.xyz / vLampPos.w * 0.5 + 0.5;
        if (vLampPos.w > 0.0 && lp.x > 0.0 && lp.x < 1.0 && lp.y > 0.0 && lp.y < 1.0 && lp.z < 1.0) {
          // мягкая тень: 12 выборок по спирали — край размыт
          float lit = 0.0, bias = 0.0004;
          float rot = 0.0; // один узор на все пиксели: без шума, который в движении мерцал крапинками
          for (int i = 0; i < 12; i++) {
            float a = rot + float(i) * 2.3999632;            // золотой угол
            float rad = (0.5 + float(i)) / 12.0;
            vec2 off = vec2(cos(a), sin(a)) * sqrt(rad) * (5.0 / 1024.0);
            lit += step(lp.z - bias, texture2D(uShadow, lp.xy + off).r);
          }
          // тень не в черноту — рассеянный свет фонаря от стен всё равно доходит
          lampL *= mix(0.3, 1.0, lit / 12.0);
        }
      }
      // свет фонаря не выше порога блума — то, куда бежим, не выжигается в белое.
      // Ограничиваем по яркости, а не по каждому каналу: иначе тёплый свет упирался в потолок
      // по зелёному и синему раньше, чем по красному, — и пятно шло розово-зелёными разводами
      // фонарь только добавляет свет и никогда не притемняет то, что уже светится само (окна, неон).
      // Добавку мягко ограничиваем запасом до потолка яркости — без резкого плато на краю пятна
      const vec3 LUMW = vec3(0.2126, 0.7152, 0.0722);
      float base = dot(c3, LUMW), add = dot(lampL, LUMW);
      float room = max(0.8 - base, 0.0);
      float addOut = room > 1e-4 ? room * (1.0 - exp(-add / room)) : 0.0;
      c3 += lampL * (addOut / max(add, 1e-4));
    }
    // высота: всё, что далеко внизу под ярусом, тонет в дымке (днём белой, ночью — цвета тумана)
    float below = uB - y;
    c3 = mix(c3, mix(vec3(1.0), uFogColor * 1.4, uNight), smoothstep(2.0, 30.0, below) * (0.35 + 0.25 * uHigh));
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
      uRunZ: { value: 0 },
      uDarkZ: { value: 1e5 },
      uPs1: { value: 0 },
      uAspectV: { value: 1 },
      uHigh: { value: 0 },
      uNight: { value: 0 },
      uStreetL: { value: Array.from({ length: 12 }, () => new THREE.Vector3(0, -99, 0)) },
      uLamp: { value: 0 },
      uLampP: { value: new THREE.Vector3(0, -0.1, 0.32) },
      uCookie: { value: null },
      uCookieOn: { value: 0 },
      uShadow: { value: null },
      uShadowOn: { value: 0 },
      uLampMat: { value: new THREE.Matrix4() },
      uSunMat: { value: new THREE.Matrix4() },
      uSunShadow: { value: null },
      uSun: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0.75, 1.45, 0.5).normalize() }, // спереди-сбоку: тени отбрасывает то, что впереди и всегда есть
    },
  });
}

// Искры из неисправной лампы: точки летят вниз по дуге, циклично; движение целиком в шейдере
const SPARKS = 46;
// Луч уличного фонаря: прозрачный конус от плафона к земле. Ярче у плафона, к земле тает,
// края мягкие (чем «вскользь» смотрим на поверхность конуса, тем прозрачнее). Только ночью.
export function createConeMaterial({ linearOut }) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: {
      uL: { value: L }, uLz: { value: LZ }, uB: { value: 0 },
      uFogNear: { value: LZ * 2.2 }, uFogFar: { value: LZ * 6.0 },
      uNight: { value: 0 },
      uLinearOut: { value: linearOut ? 1 : 0 },
    },
    vertexShader: /* glsl */ `
      attribute float aV;
      uniform float uL; uniform float uLz; uniform float uB; uniform float uFogNear; uniform float uFogFar;
      varying float vV; varying float vEdge; varying float vFog;
      void main() {
        vec4 f = modelMatrix * vec4(position, 1.0);
        float s = exp(-f.z / uLz);
        float r = uL * s;
        float phi = f.x / uL;
        vec3 w = vec3(r * sin(phi), uB + (f.y - uB) * s, r * cos(phi));
        vec4 mv = viewMatrix * vec4(w, 1.0);
        gl_Position = projectionMatrix * mv;
        // нормаль конуса поворачиваем вместе с изгибом мира (вокруг вертикали на phi)
        vec3 nf = normal;
        vec3 nw = vec3(nf.x * cos(phi) + nf.z * sin(phi), nf.y, -nf.x * sin(phi) + nf.z * cos(phi));
        vec3 nv = normalize(mat3(viewMatrix) * nw);
        vEdge = abs(dot(nv, normalize(-mv.xyz)));
        vV = aV;
        vFog = smoothstep(uFogNear, uFogFar, f.z);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uNight; uniform float uLinearOut;
      varying float vV; varying float vEdge; varying float vFog;
      void main() {
        float a = pow(1.0 - vV, 1.3) * pow(vEdge, 1.2) * 0.4 * uNight * (1.0 - vFog);
        vec3 c = vec3(1.0, 0.9, 0.74) * a;
        // слабый аддитивный свет: pow(…, 2.2) почти обнулил бы его — берём линейно
        if (uLinearOut > 0.5) c *= 0.55;
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
}

// геометрия лучей: конус на каждый фонарь [x, z, y плафона]
function coneGeometry(lamps) {
  const pos = [], nor = [], v = [], idx = [];
  const SEG = 14;
  for (const [x, z, y] of lamps) {
    const R = 4.6, h = y, base = pos.length / 3; // широкий конус, как у настоящего уличного фонаря
    const slope = R / h;
    for (let i = 0; i <= SEG; i++) {
      const a = (i / SEG) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      const nl = Math.hypot(1, slope);
      const n = [ca / nl, slope / nl, sa / nl];
      pos.push(x + ca * 0.25, y, z + sa * 0.25); nor.push(...n); v.push(0);
      pos.push(x + ca * R, 0.02, z + sa * R); nor.push(...n); v.push(1);
    }
    for (let i = 0; i < SEG; i++) {
      const a = base + i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aV', new THREE.Float32BufferAttribute(v, 1));
  g.setIndex(idx);
  return g;
}

export function createSparkMaterial({ linearOut }) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec3 aSeed;
      uniform float uL; uniform float uLz; uniform float uB; uniform float uTime; uniform float uPx;
      varying float vA;
      void main() {
        // своя фаза у каждой искры; вспышки идут пачками
        float per = 1.1 + aSeed.z * 0.6;
        float t = fract(uTime / per + aSeed.x);
        float burst = step(0.45, fract(sin(floor(uTime / per + aSeed.x) * 12.9898 + aSeed.y * 7.0) * 43758.5453));
        vec3 p = position + vec3((aSeed.y - 0.5) * 2.2 * t, -t * 1.2 - 4.9 * t * t, (aSeed.z - 0.5) * 2.2 * t);
        vec4 f = modelMatrix * vec4(p, 1.0);
        float s = exp(-f.z / uLz);
        float r = uL * s;
        float phi = f.x / uL;
        vec3 w = vec3(r * sin(phi), uB + (f.y - uB) * s, r * cos(phi));
        vec4 mv = viewMatrix * vec4(w, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = max(1.5, 7.0 * uPx / max(-mv.z, 0.5)) * (1.0 - t * 0.6);
        vA = (1.0 - t) * burst;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uLinearOut;
      varying float vA;
      void main() {
        vec2 q = gl_PointCoord - 0.5;
        float a = (1.0 - smoothstep(0.2, 0.5, length(q))) * vA;
        vec3 c = vec3(1.0, 0.72, 0.3) * a * 1.4;
        if (uLinearOut > 0.5) c = pow(c, vec3(2.2)) * 1.5;
        gl_FragColor = vec4(c, 1.0);
      }
    `,
    uniforms: { uL: { value: L }, uLz: { value: LZ }, uB: { value: 0 }, uTime: { value: 0 }, uPx: { value: 1 }, uLinearOut: { value: linearOut ? 1 : 0 } },
  });
}
function sparkPoints(p, mat) {
  if (!mat) return null;
  const pos = [], seed = [];
  for (let i = 0; i < SPARKS; i++) { pos.push(p[0], p[1], p[2]); seed.push(Math.random(), Math.random(), Math.random()); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 3));
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 2;
  return pts;
}

// Глубина для теней фонаря: тот же изгиб мира, цвет не нужен — только буфер глубины.
export function createDepthMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    colorWrite: false,
    vertexShader: /* glsl */ `
      uniform float uL;
      uniform float uLz;
      uniform float uB;
      void main() {
        vec4 f = modelMatrix * vec4(position, 1.0);
        float s = exp(-f.z / uLz);
        float r = uL * s;
        float phi = f.x / uL;
        vec3 w = vec3(r * sin(phi), uB + (f.y - uB) * s, r * cos(phi));
        gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `void main() { gl_FragColor = vec4(1.0); }`,
    uniforms: { uL: { value: L }, uLz: { value: LZ }, uB: { value: 0 } },
  });
}

// Глубина для солнечных теней: в плоском мире, без изгиба. uShift — копия сдвинутая на круг мира,
// чтобы дом у «шва» отбрасывал тень и на другую сторону.
export function createSunDepthMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    colorWrite: false,
    vertexShader: /* glsl */ `
      uniform float uShift;
      void main() {
        vec4 f = modelMatrix * vec4(position, 1.0);
        f.x += uShift;
        gl_Position = projectionMatrix * viewMatrix * f;
      }
    `,
    fragmentShader: /* glsl */ `void main() { gl_FragColor = vec4(1.0); }`,
    uniforms: { uShift: { value: 0 } },
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
    this.dark = 0; this.dk = []; // 1 — тёмный переход: свет не работает
  }

  _vert(p, normal, style, top, box) {
    this.pos.push(p[0], p[1], p[2]);
    this.nor.push(normal[0], normal[1], normal[2]);
    this.sty.push(style); this.top.push(top); this.box.push(box[0], box[1], box[2], box[3]);
    this.ao.push(style === 0 && this.aoFn ? this.aoFn(p[0], p[2]) : 1);
    this.lit.push(this.lightFn && style !== 6 && style !== 7 ? this.lightFn(p[0], p[2]) : 0);
    this.tnt.push(this.tint);
    this.dk.push(this.dark);
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

  // гелиевый шарик под потолком: гранёный шар чуть вытянутый, хвостик и ниточка вниз.
  // Цвет — по номеру (top), шейдер берёт его из палитры
  balloon(x, y, z, r, color, rng) {
    const sx = 10, sy = 6, pt = (i, j) => {
      const a = (i / sx) * Math.PI * 2, t = (j / sy) * Math.PI;
      const rr = Math.sin(t) * r * (j > sy / 2 ? 1 - 0.25 * (j / sy - 0.5) : 1);
      return [x + Math.cos(a) * rr, y + Math.cos(t) * r * 1.15, z + Math.sin(a) * rr];
    };
    for (let j = 0; j < sy; j++) {
      for (let i = 0; i < sx; i++) {
        const a = pt(i, j), b = pt(i + 1, j), c = pt(i, j + 1), d = pt(i + 1, j + 1);
        if (j > 0) this.tri(a, c, b, 20, color);
        if (j < sy - 1) this.tri(b, c, d, 20, color);
      }
    }
    const tail = y - r * 1.15;
    this.prism([x, tail, z], [x, tail - 0.08, z], 0.04, 0.07, 4, 20);
    // ниточка свисает и чуть уходит в сторону
    const len = 0.9 + rng() * 0.8, dx = (rng() - 0.5) * 0.3, dz = (rng() - 0.5) * 0.3;
    this.prism([x, tail - 0.08, z], [x + dx, tail - 0.08 - len, z + dz], 0.008, 0.008, 3, 7);
  }

  // брошенная тележка из супермаркета: корзина-решётка на рамке, ручка, четыре колёсика.
  // Поставлена боком у стены, может стоять криво (rot)
  // прямоугольная балка/плита от a до b: ширина w, толщина h, с торцами (обломки, перекрытия)
  slab(a, bb, w, h, style) {
    const d = norm(sub(bb, a));
    const t = norm(cross(d, Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
    const u = cross(t, d);
    const P = (p, sx, sy) => [0, 1, 2].map((k) => p[k] + t[k] * sx * w / 2 + u[k] * sy * h / 2);
    const neg = (v) => v.map((x) => -x);
    this.quad4(P(a, -1, 1), P(a, 1, 1), P(bb, -1, 1), P(bb, 1, 1), 1, 1, u, style, 0, [0, 0, 0, 0]);
    this.quad4(P(a, -1, -1), P(a, 1, -1), P(bb, -1, -1), P(bb, 1, -1), 1, 1, neg(u), style, 0, [0, 0, 0, 0]);
    this.quad4(P(a, 1, -1), P(a, 1, 1), P(bb, 1, -1), P(bb, 1, 1), 1, 1, t, style, 0, [0, 0, 0, 0]);
    this.quad4(P(a, -1, -1), P(a, -1, 1), P(bb, -1, -1), P(bb, -1, 1), 1, 1, neg(t), style, 0, [0, 0, 0, 0]);
    this.quad4(P(a, -1, -1), P(a, 1, -1), P(a, -1, 1), P(a, 1, 1), 1, 1, neg(d), style, 0, [0, 0, 0, 0]);
    this.quad4(P(bb, -1, -1), P(bb, 1, -1), P(bb, -1, 1), P(bb, 1, 1), 1, 1, d, style, 0, [0, 0, 0, 0]);
  }

  // свая / стальная балка: толстая, ржавая, торчит из бетона и чуть гнётся на конце
  pile(p, dir, len, rr) {
    const l = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const u = [dir[0] / l, dir[1] / l, dir[2] / l];
    const m = [p[0] + u[0] * len * 0.7, p[1] + u[1] * len * 0.7, p[2] + u[2] * len * 0.7];
    const e = [m[0] + u[0] * len * 0.3 + (rr() - 0.5) * 0.4, m[1] + u[1] * len * 0.3 - len * 0.12, m[2] + u[2] * len * 0.3 + (rr() - 0.5) * 0.4];
    const tint = this.tint;
    this.tint = 7;
    this.slab([p[0] - u[0] * 0.4, p[1] - u[1] * 0.4, p[2] - u[2] * 0.4], m, 0.28, 0.28, 22);
    this.slab(m, e, 0.26, 0.26, 22);
    this.tint = tint;
  }

  // гнутый прут арматуры: от p в сторону dir, конец загнут вниз
  rebar(p, dir, len, rr) {
    const m = [p[0] + dir[0] * len * 0.6, p[1] + dir[1] * len * 0.6, p[2] + dir[2] * len * 0.6];
    const e = [m[0] + dir[0] * len * 0.4 + (rr() - 0.5) * 0.3, m[1] - len * (0.15 + rr() * 0.35), m[2] + dir[2] * len * 0.4 + (rr() - 0.5) * 0.3];
    const tint = this.tint;
    this.tint = 7;
    this.prism(p, m, 0.025, 0.025, 4, 22);
    this.prism(m, e, 0.025, 0.02, 4, 22);
    this.tint = tint;
  }

  // большой мусорный контейнер спиной к стене (side: −1 — стена слева, +1 — справа):
  // одна крышка закрыта, вторая откинута к стене
  dumpster(xw, y, z0, side, open) {
    const xa = xw - side * 0.06, xb = xw - side * 1.16;
    const x0 = Math.min(xa, xb), x1 = Math.max(xa, xb), z1 = z0 + 1.9, zm = z0 + 0.95;
    this.boxGeo(x0, x1, z0, z1, y + 1.22, 26, y + 0.14);
    this.boxGeo(x0 - 0.04, x1 + 0.04, z0 - 0.04, z1 + 0.04, y + 1.3, 26, y + 1.2); // кромка
    this.boxGeo(x0 - 0.05, x1 + 0.05, z0 - 0.05, open ? zm : z1 + 0.05, y + 1.37, 26, y + 1.3);
    if (open) {
      const xl = xw - side * 0.06, xr = xw - side * 0.14;
      this.boxGeo(Math.min(xl, xr), Math.max(xl, xr), zm, z1 + 0.05, y + 2.45, 26, y + 1.3);
    }
    for (const xx of [x0 + 0.15, x1 - 0.15]) for (const zz of [z0 + 0.2, z1 - 0.2]) {
      this.prism([xx, y + 0.07, zz - 0.06], [xx, y + 0.07, zz + 0.06], 0.07, 0.07, 6, 24);
    }
  }

  cart(x, y, z, rot, rng) {
    const R = (dx, dz) => [x + dx * Math.cos(rot) - dz * Math.sin(rot), z + dx * Math.sin(rot) + dz * Math.cos(rot)];
    const P = (dx, dy, dz) => { const [px, pz] = R(dx, dz); return [px, y + dy, pz]; };
    const w = 0.28, l = 0.45, h0 = 0.45, h1 = 0.95;
    const bar = (a, b, r = 0.018) => this.prism(a, b, r, r, 4, 22);
    // корзина: рёбра каркаса
    for (const [ax, az] of [[-w, -l], [w, -l], [w, l], [-w, l]]) bar(P(ax, h0, az), P(ax * 1.05, h1, az * 1.08));
    const ring = (h, k) => [[-w * k, -l * k], [w * k, -l * k], [w * k, l * k], [-w * k, l * k]].map(([a, c]) => P(a, h, c));
    for (const [h, k] of [[h0, 1], [(h0 + h1) / 2, 1.03], [h1, 1.06]]) {
      const q = ring(h, k);
      for (let i = 0; i < 4; i++) bar(q[i], q[(i + 1) % 4]);
    }
    // прутья решётки по бокам
    for (let i = 1; i < 6; i++) {
      const t = i / 6;
      bar(P(-w + 2 * w * t, h0, -l), P((-w + 2 * w * t) * 1.05, h1, -l * 1.08), 0.008);
      bar(P(-w + 2 * w * t, h0, l), P((-w + 2 * w * t) * 1.05, h1, l * 1.08), 0.008);
      bar(P(-w, h0, -l + 2 * l * t), P(-w * 1.05, h1, (-l + 2 * l * t) * 1.08), 0.008);
      bar(P(w, h0, -l + 2 * l * t), P(w * 1.05, h1, (-l + 2 * l * t) * 1.08), 0.008);
    }
    // ручка
    bar(P(-w * 1.06, h1, l * 1.08), P(-w * 1.06, h1 + 0.12, l * 1.25));
    bar(P(w * 1.06, h1, l * 1.08), P(w * 1.06, h1 + 0.12, l * 1.25));
    bar(P(-w * 1.06, h1 + 0.12, l * 1.25), P(w * 1.06, h1 + 0.12, l * 1.25), 0.025);
    // нижняя рама и колёсики
    for (const [ax, az] of [[-w, -l], [w, -l], [w, l], [-w, l]]) {
      bar(P(ax * 0.9, 0.1, az * 0.9), P(ax, h0, az));
      this.prism(P(ax * 0.9, 0.0, az * 0.9 - 0.04), P(ax * 0.9, 0.0, az * 0.9 + 0.04), 0.06, 0.06, 6, 12);
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
    g.setAttribute('aDark', new THREE.Float32BufferAttribute(this.dk, 1));
    g.setIndex(this.idx);
    return g;
  }
}

// Жадно собирает одинаковые (по ключу) клетки в прямоугольники.
// Разрушенная башня: обломана на разной высоте, сверху — неровные куски стен и торчащая арматура,
// сбоку — кривая балка перекрытия. Всё выше пути: на бег не влияет.
function ruinTower(b, x0, x1, z0, z1, H, style, minTop, seed) {
  const rr = mulberry32(seed);
  const w = x1 - x0, d = z1 - z0;
  const kind = rr();
  // три вида разрухи, всё — крупно, силуэтом:
  if (kind < 0.3 && w > 3 && d > 3) {
    // 1) каркас: стены осыпались, остались колонны и перекрытия. Низ (у пути) — сплошной,
    //    чтобы не казалось, что сквозь дом можно пробежать
    const podium = minTop + 6;
    b.boxGeo(x0, x1, z0, z1, podium, style);
    const top = Math.max(podium + 12, H * (0.5 + rr() * 0.4));
    const nx = Math.max(2, Math.round(w / 4)), nz = Math.max(2, Math.round(d / 4));
    for (let i = 0; i <= nx; i++) for (let k = 0; k <= nz; k++) {
      if (i > 0 && i < nx && k > 0 && k < nz) continue; // колонны — по периметру
      const cx = x0 + 0.35 + (w - 0.7) * (i / nx), cz = z0 + 0.35 + (d - 0.7) * (k / nz);
      const h = top - rr() * rr() * (top - podium) * 0.8; // колонны обломаны на разной высоте
      b.boxGeo(cx - 0.35, cx + 0.35, cz - 0.35, cz + 0.35, h, 27, podium - 0.2, { bottom: false });
      if (h < top - 2) b.pile([cx, h, cz], [(rr() - 0.5) * 0.6, 1, (rr() - 0.5) * 0.6], 1.5 + rr() * 2, rr);
    }
    // перекрытия через этаж; часть обвалилась — край рваный, свисает плитой
    for (let y = podium + 6.6; y < top - 1; y += 6.6) {
      if (rr() < 0.25) continue;
      const cutX = rr() < 0.5, frac = 0.45 + rr() * 0.5;
      const ax1 = cutX ? x0 + w * frac : x1, az1 = cutX ? z1 : z0 + d * frac;
      b.boxGeo(x0, ax1, z0, az1, y + 0.45, 27, y);
      if (rr() < 0.6) {
        const e = cutX ? [ax1, y + 0.2, z0 + d / 2] : [x0 + w / 2, y + 0.2, az1];
        const dir = cutX ? [1, 0, 0] : [0, 0, 1];
        b.slab(e, [e[0] + dir[0] * 2.5, y - 2.5, e[2] + dir[2] * 2.5], cutX ? d * 0.6 : w * 0.6, 0.4, 27);
      }
    }
    return;
  }
  if (kind < 0.7 && H > minTop + 22) {
    // 2) пробоина: в доме вырван кусок на несколько этажей, насквозь видно небо;
    //    верх держится на толстых колоннах, из краёв торчат сваи, плиты свисают в дыру
    const h1 = minTop + 7 + rr() * Math.min(10, (H - minTop) * 0.25);
    const h2 = h1 + 7 + rr() * 6;
    b.boxGeo(x0, x1, z0, z1, h1, style);
    b.boxGeo(x0, x1, z0, z1, Math.max(h2 + 6, H * (0.75 + rr() * 0.25)), style, h2);
    for (const [cx, cz] of [[x0 + 0.5, z0 + 0.5], [x1 - 0.5, z0 + 0.5], [x0 + 0.5, z1 - 0.5], [x1 - 0.5, z1 - 0.5], [x0 + w / 2, z0 + 0.5], [x0 + w / 2, z1 - 0.5]]) {
      if (rr() < 0.25) {
        // колонна переломлена: обрубок снизу и сверху, между ними — пусто
        b.boxGeo(cx - 0.45, cx + 0.45, cz - 0.45, cz + 0.45, h1 + 1 + rr() * 2, 27, h1 - 0.2, { bottom: false });
        b.boxGeo(cx - 0.45, cx + 0.45, cz - 0.45, cz + 0.45, h2 + 0.2, 27, h2 - 1 - rr() * 2);
      } else b.boxGeo(cx - 0.45, cx + 0.45, cz - 0.45, cz + 0.45, h2 + 0.2, 27, h1 - 0.2, { bottom: false, top: false });
    }
    // с верхнего края дыры — свисающая плита и сваи
    for (let k = 0; k < 2; k++) {
      const side = rr() < 0.5 ? -1 : 1, onX = rr() < 0.5;
      const e = onX ? [side < 0 ? x0 : x1, h2, z0 + d * (0.25 + rr() * 0.5)] : [x0 + w * (0.25 + rr() * 0.5), h2, side < 0 ? z0 : z1];
      const out = onX ? [side, 0, 0] : [0, 0, side];
      if (k === 0) b.slab([e[0] - out[0] * 1.5, h2 - 0.2, e[2] - out[2] * 1.5], [e[0] + out[0] * 1.2, h2 - 3 - rr() * 2, e[2] + out[2] * 1.2], 3 + rr() * 2, 0.45, 27);
      b.pile([e[0], h1 + 0.3, e[2]], [out[0], 0.25, out[2]], 2 + rr() * 2, rr);
      b.pile([e[0], h2 - 0.3, e[2]], [out[0], -0.35, out[2]], 2 + rr() * 2.5, rr);
    }
    return;
  }
  // 3) обломанный верх: неровные куски стен, сваи, завалившаяся верхушка, свисающая плита
  const cut = Math.max(minTop + 12, H * (0.4 + rr() * 0.35));
  b.boxGeo(x0, x1, z0, z1, cut, style);
  const n = 2 + Math.floor(rr() * 2);
  for (let i = 0; i < n; i++) {
    const cw = w * (0.3 + rr() * 0.4), cd = d * (0.3 + rr() * 0.4);
    const ax = rr() < 0.5 ? x0 : x1 - cw, az = rr() < 0.5 ? z0 : z1 - cd;
    const top = cut + Math.max(4, (H - cut) * (0.2 + rr() * 0.7));
    // низ куска утоплен в основной объём — без совпадающих граней (мерцали бы)
    b.boxGeo(ax + 0.02, ax + cw - 0.02, az + 0.02, az + cd - 0.02, top, style, cut - 0.3, { bottom: false });
    b.pile([ax + cw * (0.3 + rr() * 0.4), top, az + cd * (0.3 + rr() * 0.4)], [(rr() - 0.5) * 0.5, 1, (rr() - 0.5) * 0.5], 2 + rr() * 2.5, rr);
  }
  if (rr() < 0.5) {
    const cx = x0 + w * 0.5, cz = z0 + d * 0.5;
    const L = 10 + rr() * 14, ang = 0.2 + rr() * 0.3, dir = rr() * Math.PI * 2;
    b.slab([cx, cut - 2, cz], [cx + Math.cos(dir) * Math.sin(ang) * L, cut - 2 + Math.cos(ang) * L, cz + Math.sin(dir) * Math.sin(ang) * L],
      w * 0.75, d * 0.75, 27);
  }
  if (rr() < 0.7) {
    const left = rr() < 0.5, sx = left ? x0 : x1, dir = left ? -1 : 1;
    const zc = z0 + d * (0.2 + rr() * 0.6), yb = cut - 0.3;
    b.slab([sx - dir * 1.5, yb, zc], [sx + dir * (1.5 + rr() * 2), yb - 1.5 - rr() * 3, zc + (rr() - 0.5) * 1.5], 2.5 + rr() * 2, 0.45, 27);
  }
}

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
  const feat = inst.feat || {};
  b.dark = feat.dark ? 1 : inst.ruin ? 2 : 0;

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
    const t = Math.min(1, d / 1.1);
    return 0.86 + 0.14 * t * t * (3 - 2 * t);
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
    const H = Math.max(24 + rnd * 56, top + 12 + rnd * 35);
    if (inst.ruin) ruinTower(b, x0 + 0.15, x1 - 0.15, zA + 0.15, zB - 0.15, H, style, top, (inst.seed ^ (r * 131 + c * 7919)) >>> 0);
    else b.boxGeo(x0 + 0.15, x1 - 0.15, zA + 0.15, zB - 0.15, H, style);
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
    if (lvl === 1 && base === 0 && inst.ruin && !inst.vision) {
      // разруха: поваленные стволы поперёк улицы — перепрыгнуть (верх — как у препятствия, 2 м)
      const tr = mulberry32(inst.seed ^ (r * 131 + c * 7));
      for (let zz = zA + 1.0; zz < zB - 0.5; zz += 2.0) {
        const tilt = (tr() - 0.5) * 0.5;
        b.prism([x0 - 0.2, 1.0, zz - tilt], [x1 + 0.2, 0.95, zz + tilt], 1.0, 0.9, 8, 29);
        // обломанные сучья торчат вверх
        const px = x0 + (x1 - x0) * (0.2 + tr() * 0.6);
        b.prism([px, 1.7, zz], [px + (tr() - 0.5) * 1.5, 2.9 + tr() * 0.6, zz + (tr() - 0.5)], 0.14, 0.06, 5, 29);
      }
    } else if (lvl === 1 && base > 0) cabinets(b, x0, x1, zA, zB, base, base + 2, true);
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
      } else if (inst.ruin) {
        // разруха: вместо моста — упавшее дерево, застрявшее между домами: под стволом — подкатом
        const zm = zA + ROW / 2, tr = mulberry32(inst.seed ^ (r * 977 + c));
        const left = tr() < 0.5;
        const xa = left ? x0 - 0.6 : x1 + 0.6, xb = left ? x1 + 0.6 : x0 - 0.6;
        b.prism([xa, base + 2.5, zm - 0.5], [xb, base + 2.0, zm + 0.5], 0.78, 0.55, 8, 29);
        // вывороченный корень с землёй — у одного дома, крона — у другого
        b.prism([xa - (left ? 0.3 : -0.3), base + 2.5, zm - 0.5], [xa + (left ? 0.3 : -0.3), base + 2.5, zm - 0.5], 1.7, 1.5, 9, 27);
        for (let k = 0; k < 4; k++) {
          const t = 0.55 + tr() * 0.4, px = xa + (xb - xa) * t;
          b.prism([px, base + 2.4, zm], [px + (tr() - 0.5) * 2, base + 3.4 + tr() * 0.5, zm + (tr() - 0.5) * 2.5], 0.18, 0.08, 5, 29);
        }
        b.leaves([xb - (left ? 1.2 : -1.2), base + 3.2, zm], 1.9, 34, 0.9, tr);
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
        // на обычных крышах — только улица далеко внизу: низкие крыши рядом выглядели бы как площадка для прыжка
        hgt = sky && !afterLaunch(r) ? [0, 0, 8, 14, 20, 24][Math.floor(hsh * 6)] : 0;
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
        // в некоторых переходах бассейн — с разноцветными шариками вместо воды
        const balls = v === POOL && feat.balls;
        b.tint = balls ? 0 : 3;
        b.quad([x0, balls ? water + 0.15 : water, zA], [0, 0, ROW], [CELL, 0, 0], 4, 4, [0, 1, 0], balls ? 19 : 14, 0, [x0, zA, x1, zB]);
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

  // 7е. уличные фонари «Г» вдоль улицы: столб у стены дома, консоль над дорожкой, плафон светит вниз
  const streetLamps = [];
  for (let r = 0; r < nRows; r++) {
    const row = rows[r], ri = inst.rowStart + r;
    if (row.cover || row.b0 !== 0 || row.b1 !== 0 || ri % 4 !== 0 || hash2(ri, 77) < 0.4) continue;
    const side = hash2(ri, 78) < 0.5 ? -1 : 1; // сторона — случайная, но своя у каждого ряда
    const at = (c) => row[((c % COLS) + COLS) % COLS];
    let cc = -1;
    for (let k = 0; k < COLS; k++) {
      const c = side < 0 ? k : COLS - 1 - k;
      const v = row[c];
      if (walk(v) && lv(v) === 0 && v !== BRIDGE && v !== LAUNCH && at(c + side) === WALL) { cc = c; break; }
    }
    if (cc < 0) continue;
    const z = r * ROW + 2;
    const xp = side < 0 ? cc * CELL + 0.3 : (cc + 1) * CELL - 0.3; // столб — вплотную к стене
    if (inst.ruin) {
      // в разрухе фонарь покосился и не горит; плафона нет — только погнутая консоль
      const tz = (hash2(ri, 79) - 0.5) * 2.2, tx = -side * (0.6 + hash2(ri, 80) * 1.2), top = 6.6;
      b.prism([xp, 0, z], [xp + tx, top, z + tz], 0.11, 0.08, 6, 24);
      b.prism([xp + tx, top - 0.05, z + tz], [xp + tx - side * 1.3, top - 0.9, z + tz + 0.4], 0.06, 0.06, 4, 24);
      continue;
    }
    const xh = xp - side * 1.7, top = 7.2;
    b.prism([xp, 0, z], [xp, top, z], 0.15, 0.1, 6, 24);
    b.boxGeo(xp - 0.22, xp + 0.22, z - 0.22, z + 0.22, 0.5, 24); // основание столба
    b.prism([xp, top - 0.05, z], [xh, top, z], 0.07, 0.07, 4, 24);
    // плафон: крупный, «кобра» — сверху колпак, снизу светящееся стекло
    b.boxGeo(Math.min(xh + side * 0.15, xh - side * 0.75), Math.max(xh + side * 0.15, xh - side * 0.75), z - 0.3, z + 0.3, top + 0.12, 24, top - 0.02);
    b.boxGeo(Math.min(xh + side * 0.1, xh - side * 0.7), Math.max(xh + side * 0.1, xh - side * 0.7), z - 0.24, z + 0.24, top - 0.02, 25, top - 0.16);
    streetLamps.push([xh - side * 0.25, z, top - 0.2]);
  }

  // 7ж. мусорные контейнеры: в закутках улицы, куда путь не ведёт, — спиной к стене дома
  let lastBin = -9;
  for (let r = 0; r < nRows; r++) {
    const row = rows[r], ri = inst.rowStart + r;
    if (row.cover || row.b0 !== 0 || row.b1 !== 0 || r - lastBin < 2) continue;
    const lr = light[ri - la];
    if (!lr) continue;
    for (let c = 0; c < COLS; c++) {
      const v = row[c];
      if (!walk(v) || lv(v) !== 0 || v === BRIDGE || v === LAUNCH || lr[c] > 0) continue;
      const wl = row[((c - 1) % COLS + COLS) % COLS] === WALL, wr = row[(c + 1) % COLS] === WALL;
      if (!(wl || wr) || hash2(ri * 13 + c, 91) > 0.45) continue;
      const side = wl ? -1 : 1;
      b.dumpster(side < 0 ? c * CELL : (c + 1) * CELL, 0, r * ROW + 0.5 + hash2(ri, c + 3) * 1.4, side, hash2(ri, c + 9) < 0.5);
      lastBin = r;
      break;
    }
  }

  // 7з. разруха: рваные края у провалов (куски плиты, арматура, трубы), обрушенные мосты над улицей,
  //     обломки в закутках. Всё — ниже уровня пола у краёв или высоко над головой: бегу не мешает
  const ruinSparks = [];
  if (inst.ruin) {
    const rr = mulberry32(inst.seed ^ 0x7f4a7c15);
    // край провала — не по линейке, а будто земля раскололась: ломаная линия, где-то кусок пола
    // выступает над провалом (с толщиной плиты снизу), где-то край выкрошился внутрь тёмной выбоиной
    const crackEdge = (p0, along, out, len, fy, box) => {
      const pts = [[0, 0]];
      for (let s = 0.4 + rr() * 0.4; s < len - 0.3; s += 0.45 + rr() * 0.55) pts.push([s, -0.45 + rr() * 1.2]);
      pts.push([len, 0]);
      const P = (s, o, y) => [p0[0] + along[0] * s + out[0] * o, y, p0[2] + along[2] * s + out[2] * o];
      const piece = (sa, oa, sb, ob) => {
        if (Math.abs(oa) + Math.abs(ob) < 0.02) return;
        if (oa + ob > 0) {
          const y = fy + 0.004;
          b.quad4(P(sa, 0, y), P(sb, 0, y), P(sa, oa, y), P(sb, ob, y), 1, 1, [0, 1, 0], 0, fy, box);
          b.quad4(P(sa, oa, y), P(sb, ob, y), P(sa, oa, fy - 0.55), P(sb, ob, fy - 0.55), 1, 1, out, 27, fy, [0, 0, 0, 0]);
        } else {
          const y = fy + 0.012;
          b.quad4(P(sa, 0, y), P(sb, 0, y), P(sa, oa, y), P(sb, ob, y), 1, 1, [0, 1, 0], 28, fy, [0, 0, 0, 0]);
        }
      };
      for (let i = 0; i + 1 < pts.length; i++) {
        const [s0, o0] = pts[i], [s1, o1] = pts[i + 1];
        if (o0 * o1 >= 0) piece(s0, o0, s1, o1);
        else { const sc = s0 + (s1 - s0) * (o0 / (o0 - o1)); piece(s0, o0, sc, 0); piece(sc, 0, s1, o1); }
      }
    };
    const at = (r, c) => { const rw = rows[r] || world.rows[R0 + r]; return rw ? rw[((c % COLS) + COLS) % COLS] : undefined; };
    const hole = (v) => v === VOID || v === POOL;
    for (let r = 0; r < nRows; r++) {
      const row = rows[r];
      const base = Math.min(row.b0, row.b1);
      if (row.b0 !== row.b1) continue;
      for (let c = 0; c < COLS; c++) {
        const v = row[c];
        if (!walk(v) || v === BRIDGE || v === LAUNCH) continue;
        const fy = base + lv(v) * LEVEL;
        const x0 = c * CELL, zA = r * ROW;
        // четыре стороны клетки: [соседняя клетка, точка на краю, направление в пропасть, вдоль края]
        const edges = [
          [at(r, c - 1), [x0, fy, zA], [-1, 0, 0], [0, 0, 1]],
          [at(r, c + 1), [x0 + CELL, fy, zA], [1, 0, 0], [0, 0, 1]],
          [at(r - 1, c), [x0, fy, zA], [0, 0, -1], [1, 0, 0]],
          [at(r + 1, c), [x0, fy, zA + ROW], [0, 0, 1], [1, 0, 0]],
        ];
        for (const [nv, p0, out, along] of edges) {
          if (!hole(nv)) continue;
          const len = along[0] ? CELL : ROW;
          crackEdge(p0, along, out, len, fy, [x0, zA, x0 + CELL, zA + ROW]);
          // крупно: иногда край обломился целиком — большая плита свесилась в провал, из излома торчат сваи
          if (rr() < 0.3) {
            const wl = len * 0.75, s = len / 2;
            const a = [p0[0] + along[0] * s - out[0] * 0.3, fy - 0.45, p0[2] + along[2] * s - out[2] * 0.3];
            const ow = 2.2 + rr() * 1.4;
            const tip = [a[0] + out[0] * ow * 0.55, a[1] - ow, a[2] + out[2] * ow * 0.55];
            b.slab(a, tip, wl, 0.5, 27);
            for (const k of [-0.25, 0.25]) b.pile([tip[0] + along[0] * wl * k, tip[1] + 0.2, tip[2] + along[2] * wl * k], [out[0] * 0.5, -1, out[2] * 0.5], 1.2 + rr(), rr);
          }
          // разорванная труба из-под плиты
          if (rr() < 0.12) {
            const s = 0.5 + rr() * (len - 1);
            const a = [p0[0] + along[0] * s - out[0] * 0.4, fy - 0.9, p0[2] + along[2] * s - out[2] * 0.4];
            b.prism(a, [a[0] + out[0] * (0.8 + rr() * 1.2), a[1] - 0.3 - rr() * 0.8, a[2] + out[2] * (0.8 + rr() * 1.2)], 0.13, 0.13, 8, 22);
          }
        }
      }
    }
    // обрушенные пешеходные мосты высоко над улицей: от стен — обрубки, середина рухнула
    for (let r = 1; r < nRows - 1; r++) {
      const row = rows[r];
      if (row.cover || row.b0 !== 0 || row.b1 !== 0 || rr() > 0.13) continue;
      let cL = -1, cR = -1;
      for (let c = 0; c < COLS; c++) if (walk(row[c])) { if (cL < 0) cL = c; cR = c; }
      if (cL < 0 || row[(cL + COLS - 1) % COLS] !== WALL || row[(cR + 1) % COLS] !== WALL) continue;
      const xL = cL * CELL, xR = (cR + 1) * CELL, span = xR - xL;
      const yb = 13 + rr() * 9, zc = r * ROW + ROW / 2;
      for (const [xw, dir] of [[xL, 1], [xR, -1]]) {
        const l = span * (0.18 + rr() * 0.22);
        b.boxGeo(Math.min(xw, xw + dir * l), Math.max(xw, xw + dir * l), zc - 1.3, zc + 1.3, yb, 27, yb - 0.6);
        // обломанный край: висящий кусок пролёта и арматура
        const xe = xw + dir * l;
        b.slab([xe - dir * 0.2, yb - 0.3, zc + (rr() - 0.5)], [xe + dir * (0.6 + rr()), yb - 1.5 - rr() * 2.5, zc + (rr() - 0.5) * 1.5], 1.4 + rr(), 0.35, 27);
        for (const k of [-0.7, 0.7]) b.pile([xe, yb - 0.3, zc + k], [dir, -0.3, 0], 1.5 + rr() * 1.5, rr);
        for (const zr of [zc - 1.2, zc + 1.2]) b.boxGeo(Math.min(xw, xe), Math.max(xw, xe), zr - 0.05, zr + 0.05, yb + 1.05, 4, yb + 0.95);
      }
    }
    // обломки в закутках: плиты и колонны вкривь у стен, где путь не проходит
    for (let r = 0; r < nRows; r++) {
      const row = rows[r], ri = R0 + r;
      if (row.cover || row.b0 !== 0 || row.b1 !== 0) continue;
      const lr = light[ri - la];
      if (!lr) continue;
      for (let c = 0; c < COLS; c++) {
        const v = row[c];
        if (!walk(v) || lv(v) !== 0 || v === BRIDGE || v === LAUNCH || lr[c] > 0 || rr() > 0.35) continue;
        // крупный обломок: кусок стены или перекрытия, упавший углом в землю и прислонённый к дому
        const x = c * CELL + CELL / 2, z = r * ROW + ROW / 2;
        const side = row[((c - 1) % COLS + COLS) % COLS] === WALL ? -1 : row[(c + 1) % COLS] === WALL ? 1 : (rr() < 0.5 ? -1 : 1);
        b.slab([x - side * 1.2, -0.4, z], [x + side * 1.5, 2.5 + rr() * 2.5, z + (rr() - 0.5) * 1.5], 2.6 + rr() * 0.8, 0.45, 27);
        b.pile([x + side * 1.4, 2.6 + rr() * 1.5, z], [side * 0.3, 0.8, (rr() - 0.5) * 0.5], 1.4 + rr(), rr);
      }
    }
    // оборванные провода свисают со стены дома и искрят на конце (выше головы)
    for (let r = 1; r < nRows - 1 && ruinSparks.length < 2; r++) {
      const row = rows[r];
      if (row.cover || row.b0 !== 0 || row.b1 !== 0 || rr() > 0.18) continue;
      for (let c = 0; c < COLS; c++) {
        const v = row[c];
        if (!walk(v) || lv(v) !== 0) continue;
        const side = row[((c - 1) % COLS + COLS) % COLS] === WALL ? -1 : row[(c + 1) % COLS] === WALL ? 1 : 0;
        if (!side) continue;
        const xw = side < 0 ? c * CELL + 0.2 : (c + 1) * CELL - 0.2, z = r * ROW + 1 + rr() * 2;
        const a = [xw, 8.5, z], m = [xw - side * 0.6, 6.2, z + 0.5], e = [xw - side * 0.9, 4.6, z + 0.7];
        b.prism(a, m, 0.04, 0.04, 4, 24);
        b.prism(m, e, 0.04, 0.035, 4, 24);
        b.prism([xw, 8.3, z - 0.6], [xw - side * 0.4, 7.0, z - 0.4], 0.035, 0.03, 4, 24); // второй, короткий
        ruinSparks.push(e);
        break;
      }
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
      // узкий проход над пропастью (пропасть с обеих сторон) — красные перила: «сюда»
      const narrow = row[((c - 1) % COLS + COLS) % COLS] === VOID && row[(c + 1) % COLS] === VOID;
      b.tint = narrow ? 1 : 0;
      for (const side of [-1, 1]) {
        if (row[((c + side) % COLS + COLS) % COLS] !== VOID) continue;
        const x = side < 0 ? c * CELL + 0.1 : (c + 1) * CELL - 0.1;
        for (let z = zA + 0.2; z < zB; z += 1.33) b.boxGeo(x - 0.035, x + 0.035, z - 0.035, z + 0.035, base + 1.1, 4, base);
        b.boxGeo(x - 0.05, x + 0.05, zA, zB, base + 1.14, 4, base + 1.04);
        b.boxGeo(x - 0.025, x + 0.025, zA, zB, base + 0.58, 4, base + 0.52);
      }
      b.tint = 0;
    }
  }

  // 7д. особенности подземного перехода: шарики под потолком, тележки у стен, искрящая лампа
  const sparkAt = [];
  if (inst.feat) {
    const frng = mulberry32(inst.seed ^ 0x2c1b3c6d);
    const open = (row, c) => walk(row[((c % COLS) + COLS) % COLS]);
    for (let r = 0; r < nRows; r++) {
      const row = rows[r];
      if (!row.cover) continue;
      const base = Math.min(row.b0, row.b1);
      const zA = r * ROW;
      for (let c = 0; c < COLS; c++) {
        const v = row[c];
        if (v === WALL || v === RUNWALL) continue;
        const x0 = c * CELL;
        if (feat.balloons && frng() < 0.22) {
          // упёрлись в потолок, кучкой по 1–3
          const k = 1 + Math.floor(frng() * 3);
          for (let i = 0; i < k; i++) {
            const rr = 0.3 + frng() * 0.08;
            b.balloon(x0 + 0.8 + frng() * 2.4, base + CEIL_H - rr * 1.2 - 0.02, zA + 0.5 + frng() * 3, rr, Math.floor(frng() * 5) + 1, frng);
          }
        }
        if (feat.carts && walk(v) && v !== BRIDGE && frng() < 0.14) {
          // только вплотную к стене — не мешает бегу по полосе
          const wl = !open(row, c - 1), wr = !open(row, c + 1);
          if (wl || wr) {
            const x = wl ? x0 + 0.55 : x0 + CELL - 0.55;
            b.cart(x, base, zA + 0.8 + frng() * 2.4, (frng() - 0.5) * 0.9 + (frng() < 0.5 ? 0 : Math.PI), frng);
          }
        }
      }
      // неисправная лампа с искрами — одна на паттерн
      if (feat.sparks && !sparkAt.length && r >= 1 && frng() < 0.35) {
        const cols = [];
        for (let c = 0; c < COLS; c++) if (walk(row[c])) cols.push(c);
        if (cols.length) {
          const c = cols[Math.floor(frng() * cols.length)];
          const x = c * CELL + CELL / 2, z = zA + ROW / 2, y = base + CEIL_H;
          b.boxGeo(x - 0.1, x + 0.1, z - 0.7, z + 0.7, y, 23, y - 0.08, { bottom: true });
          sparkAt.push([x, y - 0.1, z]);
        }
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
  for (const p of [...sparkAt, ...ruinSparks]) {
    const sp = sparkPoints(p, materials.spark);
    if (sp) group.add(sp);
  }
  group.userData.zStart = inst.rowStart * ROW;
  group.userData.lamps = streetLamps;
  if (streetLamps.length && materials.cone) {
    const cones = new THREE.Mesh(coneGeometry(streetLamps), materials.cone);
    cones.frustumCulled = false;
    cones.renderOrder = 3;
    group.add(cones);
  }
  group.userData.zEnd = (inst.rowStart + nRows) * ROW;
  return group;
}
