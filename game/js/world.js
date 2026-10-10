// Логика мира в «плоских» координатах: генерация из паттернов,
// проверка проходимости и честности, запросы к клеткам для физики.
// Без three.js, чтобы можно было гонять проверки в node.

import { PATTERNS, START, BREATHERS, OPENS } from './patterns.js';

export const COLS = 12;          // колонок по кругу
export const CELL = 4;           // ширина колонки (единиц)
export const ROW = 4;            // длина ряда вдоль пути (единиц)
export const LEVEL = 2;          // высота одного уровня крыши
export const W = COLS * CELL;    // длина окружности в плоском мире
export const L = W / (2 * Math.PI); // радиус кольца у игрока
// Насколько медленно мир сжимается к центру: r = L·e^(−dz/LZ).
// 1 = «честный» конформный изгиб (очень резкий), больше — длиннее улицы впереди.
export const DEPTH = 2.2;
export const LZ = L * DEPTH;

export const WALL = 255;
export const BRIDGE = 254;        // улица с низким мостом сверху: только подкатом
export const VOID = 253;          // пропасть: между крышами, канал на улице, дыра в пустоту в тоннеле
export const RUNWALL = 252;       // красная стена: по ней можно бежать
export const POOL = 251;          // бассейн в подземке: упал — конец
export const LAUNCH = 250;        // красный трамплин: подбрасывает на верхушку небоскрёба
export const LAUNCH_ROWS = 4;     // через сколько рядов приземляемся после трамплина
export const BRIDGE_BOTTOM = 1.1; // просвет под мостом
export const BRIDGE_TOP = 2 * LEVEL; // верх моста на уровне крыши «2»

// Ярусы: улица, крыши, подземка. Высота пола яруса.
export const TIERS = { street: 0, roof: 8, under: -6, sky: 40 };
export const CEIL_H = 5;          // высота потолка в тоннеле

const CHAR_CODE = { '.': 0, '1': 1, '2': 2, '3': 3, '#': WALL, b: BRIDGE, _: VOID, w: RUNWALL, '~': POOL, L: LAUNCH };

// у каждого ряда: b0/b1 — высота пола в начале и в конце ряда (рампа, если разные),
// cover — ряд в тоннеле (есть потолок)
function setRowBase(row, b0, b1) {
  row.b0 = b0; row.b1 = b1;
  row.cover = b0 <= TIERS.under + 0.01 && b1 <= TIERS.under + 0.01;
  return row;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mod = (a, n) => ((a % n) + n) % n;

// Строки паттерна → массив рядов снизу вверх (ближний ряд первым).
export function parsePattern(p) {
  const tier = p.tier || 'street';
  const to = p.to || tier;
  const bases = p.base ? p.base.slice().reverse() : null;
  if (bases && bases.length !== p.rows.length) throw new Error(`pattern ${p.name}: base must list every row`);
  const rows = p.rows.slice().reverse().map((s, i) => {
    const clean = s.replace(/\s/g, '');
    if (clean.length !== COLS) throw new Error(`pattern ${p.name}: row "${s}" must have ${COLS} cells`);
    const row = Uint8Array.from(clean, (ch) => {
      const v = CHAR_CODE[ch];
      if (v === undefined) throw new Error(`pattern ${p.name}: unknown cell "${ch}"`);
      return v;
    });
    const b = bases ? bases[i] : TIERS[tier];
    return Array.isArray(b) ? setRowBase(row, b[0], b[1]) : setRowBase(row, b, b);
  });
  if (rows[0].b0 !== TIERS[tier]) throw new Error(`pattern ${p.name}: must start at ${tier} height`);
  if (rows[rows.length - 1].b1 !== TIERS[to]) throw new Error(`pattern ${p.name}: must end at ${to} height`);
  return { ...p, tier, to, parsed: rows };
}

function transformRows(rows, shift, mirror) {
  return rows.map((r) => {
    const out = new Uint8Array(COLS);
    for (let c = 0; c < COLS; c++) {
      const src = mirror ? COLS - 1 - c : c;
      out[mod(c + shift, COLS)] = r[src];
    }
    return setRowBase(out, r.b0, r.b1);
  });
}

// ---- Проверка проходимости ----
// Модель на уровне рядов: за один ряд игрок смещается максимум на 1 колонку,
// забирается максимум на 1 уровень, спрыгивает с любой высоты,
// может перепрыгнуть один ряд (провал, канал, бассейн или улицу между домами),
// может пробежать по красной стене до 3 рядов и оттолкнуться на соседнюю полосу
// или прямо на красную стену напротив — и так по очереди.
// Под мост (b) можно только с уровня пола — подкатом.
// Высоты сравниваются абсолютные: у рядов разный пол (улица, крыши, тоннель).
const SOLIDISH = (v) => v === WALL || v === RUNWALL;
const HOLE = (v) => v === VOID || v === POOL;
export const walk = (v) => !SOLIDISH(v) && !HOLE(v);
export const lv = (v) => (v <= 3 ? v : 0);
const hAt = (row, v, atEnd) => (atEnd ? row.b1 : row.b0) + lv(v) * LEVEL;

// Можно ли зайти в клетку v ряда row (в начале или в конце ряда), если стоим на высоте from.
function enterable(from, row, v, atEnd) {
  if (!walk(v)) return false;
  const h = hAt(row, v, atEnd);
  if (v === BRIDGE) return from <= h + 0.01;
  return h <= from + LEVEL + 0.01;
}

// Можно ли перейти из клетки c ряда rPrev в соседнюю (|c2−c| ≤ 1) клетку ряда rCur.
export function canStep(rPrev, rCur, c, c2) {
  const from = rPrev[c];
  if (!walk(from)) return false;
  const f = hAt(rPrev, from, true);
  if (!enterable(f, rCur, rCur[c2], false)) return false;
  if (c === c2) return true;
  // смещение вбок — только если клетка сбоку свободна уже в текущем ряду:
  // так у игрока есть целый ряд на манёвр, а не доля секунды за углом
  return enterable(f, rPrev, rPrev[c2], true);
}

// Прыжок из ряда rS через ряд rM в ряд rL по колонке c.
export function canJumpOver(rS, rM, rL, c) {
  const s = rS[c], m = rM[c], l = rL[c];
  if (!walk(s) || !walk(l) || SOLIDISH(m)) return false;
  if (m === BRIDGE || l === BRIDGE) return false;
  const hs = hAt(rS, s, true);
  if (!HOLE(m)) {
    // через улицу — только с крыши, и середина не выше старта
    if (lv(s) === 0 || Math.max(rM.b0, rM.b1) + lv(m) * LEVEL > hs + 0.01) return false;
  }
  return hAt(rL, l, false) <= hs + LEVEL + 0.01;
}

// Все переходы из клетки (r, c): шаг, прыжок через ряд, бег по стене (и со стены на стену).
const RUN_MAX = 3;
export function transitions(rows, r, c, out) {
  const n = rows.length;
  const row = rows[r], v = row[c];
  if (!walk(v)) return out;
  if (v === LAUNCH) {
    // трамплин бросает строго вперёд, на LAUNCH_ROWS рядов
    const rl = r + LAUNCH_ROWS;
    if (rl < n && walk(rows[rl][c]) && rows[rl][c] !== BRIDGE) out.push(rl, c);
    return out;
  }
  if (r + 1 < n) {
    for (let d = -1; d <= 1; d++) {
      const c2 = mod(c + d, COLS);
      if (canStep(row, rows[r + 1], c, c2)) out.push(r + 1, c2);
    }
  }
  if (r + 2 < n && canJumpOver(row, rows[r + 1], rows[r + 2], c)) out.push(r + 2, c);
  if (v === BRIDGE) return out;
  const hs = hAt(row, v, true);
  const cell = (rr, cc) => rows[rr][mod(cc, COLS)];
  const passable = (rr, cc) => { const x = cell(rr, cc); return !SOLIDISH(x) && x !== BRIDGE; };
  const land = (rr, cc) => {
    if (rr >= n) return;
    const x = cell(rr, cc);
    if (walk(x) && x !== BRIDGE && hAt(rows[rr], x, false) <= hs + LEVEL + 0.01) out.push(rr, mod(cc, COLS));
  };
  // бег по стене: до 3 рядов; толчок — прямо к противоположной красной стене (до 3 полос),
  // и так по очереди, до 5 стен подряд
  const run = (r0, c0, d, depth) => {
    for (let j = 1; j <= RUN_MAX; j++) {
      const r1 = r0 + j;
      if (r1 >= n || cell(r1, c0 + d) !== RUNWALL || !passable(r1, c0)) break;
      land(r1 + 1, c0);
      // толчок от стены: на соседнюю полосу или к стене напротив
      if (!passable(r1, c0 - d)) continue;
      land(r1 + 1, c0 - d);
      if (depth >= 5) continue;
      for (let k = 1; k <= 3; k++) {
        const cc = c0 - d * k;
        if (!passable(r1, cc)) break;
        if (r1 + 1 < n && cell(r1 + 1, cc - d) === RUNWALL) { run(r1, cc, -d, depth + 1); break; }
      }
    }
  };
  for (const d of [-1, 1]) {
    if (cell(r, c + d) === RUNWALL) run(r, c, d, 1); // прилипаем к стене, которая уже рядом
  }
  return out;
}

// Прогоняет достижимость через новые ряды rows, продолжая историю (предыдущие ряды и их F).
// Возвращает массив F по каждому новому ряду или null, если путь обрывается.
export function reachThrough(histRows, histReach, rows) {
  const all = [...histRows, ...rows];
  const h = histRows.length;
  const F = [...histReach, ...rows.map(() => new Uint8Array(COLS))];
  const tmp = [];
  for (let r = 0; r < all.length; r++) {
    for (let c = 0; c < COLS; c++) {
      if (!F[r][c]) continue;
      tmp.length = 0;
      transitions(all, r, c, tmp);
      for (let i = 0; i < tmp.length; i += 2) if (tmp[i] >= h) F[tmp[i]][tmp[i + 1]] = 1;
    }
  }
  const out = F.slice(h);
  if (!out[out.length - 1].some(Boolean)) return null;
  return out;
}

// «Живые» клетки: достижимы и из них можно добраться до последнего ряда.
export function aliveBackward(rows, reach) {
  const n = rows.length;
  const alive = new Array(n);
  alive[n - 1] = Uint8Array.from(reach[n - 1]);
  const tmp = [];
  for (let r = n - 2; r >= 0; r--) {
    const a = new Uint8Array(COLS);
    for (let c = 0; c < COLS; c++) {
      if (!reach[r][c]) continue;
      tmp.length = 0;
      transitions(rows, r, c, tmp);
      for (let i = 0; i < tmp.length && !a[c]; i += 2) if (alive[tmp[i]][tmp[i + 1]]) a[c] = 1;
    }
    alive[r] = a;
  }
  return alive;
}

// Честность: обречённая клетка (достижима, но дальше пути нет) допустима,
// только если в том же ряду от неё можно пройти вбок (без стен и высоких крыш)
// до живой клетки — то есть это стена посреди открытой площади, видная издалека,
// а не отдельный двор или коридор, в который можно свернуть вслепую.
export function findUnfair(rows, reach, alive) {
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < COLS; c++) {
      if (!reach[r][c] || alive[r][c]) continue;
      // идём вбок по ряду только по клеткам, куда реально можно перейти с этой высоты
      const f = hAt(rows[r], rows[r][c], true);
      let ok = false;
      for (const dir of [-1, 1]) {
        for (let k = 1; k < COLS && !ok; k++) {
          const cc = mod(c + dir * k, COLS);
          if (!enterable(f, rows[r], rows[r][cc], true)) break;
          if (alive[r][cc]) ok = true;
        }
      }
      if (!ok) return { row: r, col: c };
    }
  }
  return null;
}

// Самопроверка паттерна: из любой клетки входа есть путь к выходу, тупики только честные.
export function validatePattern(p) {
  const rows = p.parsed;
  const F0 = Uint8Array.from(rows[0], (v) => (walk(v) ? 1 : 0));
  if (!F0.some(Boolean)) return { ok: false, reason: 'entry row is fully blocked' };
  const rest = reachThrough([rows[0]], [F0], rows.slice(1));
  if (!rest) return { ok: false, reason: 'no path from entry to exit' };
  const reach = [F0, ...rest];
  if (!reach[reach.length - 1].some(Boolean)) return { ok: false, reason: 'pattern must not end with a gap' };
  const bad = findUnfair(rows, reach, aliveBackward(rows, reach));
  if (bad) return { ok: false, reason: `hidden dead end at row ${bad.row + 1} (from bottom), col ${bad.col}` };
  return { ok: true };
}

const PARSED = PATTERNS.map(parsePattern);
const START_P = parsePattern(START);
const BREATHER_P = Object.fromEntries(Object.entries(BREATHERS).map(([k, p]) => [k, parsePattern({ ...p, tier: k })]));
const OPEN_P = Object.fromEntries(Object.entries(OPENS).map(([k, p]) => [k, parsePattern({ ...p, tier: k })]));
export const PATTERN_REPORT = [START_P, ...PARSED].map((p) => ({ name: p.name, ...validatePattern(p) }));
const USABLE = PARSED.filter((p, i) => PATTERN_REPORT[i + 1].ok);

// ---- Генератор ----
export class World {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.rng = mulberry32(this.seed);
    this.rows = [];      // Uint8Array(COLS) на каждый ряд
    this.reach = [];     // достижимость на каждый ряд
    this.rowInfo = [];   // { inst, name, local, total }
    this.instances = []; // вставленные паттерны
    this.instCount = 0;
    this.fallbacks = 0;
    this.tier = 'street';
    this.tierAge = 0;    // сколько паттернов подряд на этом ярусе
    // старт: прямой проспект, игрок в колонке 6
    const rows = START_P.parsed;
    const F0 = new Uint8Array(COLS); F0[6] = 1;
    const reach = [F0, ...reachThrough([rows[0]], [F0], rows.slice(1))];
    this._push(START_P, rows, reach, 0, false);
  }

  _push(p, rows, reach, shift, mirror) {
    const inst = {
      id: this.instCount++,
      name: p.name,
      shift, mirror,
      vision: !!p.vision,
      rowStart: this.rows.length,
      rows,
      seed: Math.floor(this.rng() * 1e9),
    };
    rows.forEach((r, i) => {
      this.rows.push(r);
      this.reach.push(reach[i]);
      this.rowInfo.push({ inst: inst.id, name: p.name, local: i, total: rows.length });
    });
    this.instances.push(inst);
    const to = p.to || 'street';
    this.tierAge = to === this.tier ? this.tierAge + 1 : 0;
    this.tier = to;
    return inst;
  }

  // сложность растёт с расстоянием; первые ~150 м — только простое
  // переходы между ярусами: с улицы — время от времени, с крыш и из тоннеля — через 2–4 паттерна
  _pickPattern(distance) {
    const level = distance < 150 ? 1 : Math.min(3, 1 + distance / 600);
    const age = this.tierAge;
    const pool = USABLE.filter((p) => p.tier === this.tier).map((p) => {
      let w = p.weight * (p.diff <= level ? 1 : Math.max(0, 1 - (p.diff - level)));
      if (p.to !== p.tier) {
        if (this.tier === 'street') w *= distance < 120 ? 0 : Math.min(1, Math.max(0, (age - 1) / 3));
        else if (this.tier === 'under') w *= age < 4 ? 0 : age < 6 ? 1 : 20; // подземка — подольше
        else if (this.tier === 'roof' && p.to === 'sky') w *= age < 1 ? 0 : 1;  // с крыш — иногда ещё выше
        else w *= age < 2 ? 0 : age < 4 ? 1 : 20;
      }
      return { p, w };
    }).filter((e) => e.w > 0);
    if (!pool.length) return null;
    let t = this.rng() * pool.reduce((s, e) => s + e.w, 0);
    for (const e of pool) { t -= e.w; if (t <= 0) return e.p; }
    return pool[pool.length - 1].p;
  }

  // На сколько колонок надо сместиться на стыке: от достижимых клеток последнего ряда
  // до ближайшей проходимой клетки первого ряда нового паттерна.
  _joinShift(rows) {
    const F = this.reach[this.reach.length - 1];
    let best = COLS;
    for (let p = 0; p < COLS; p++) {
      if (!F[p]) continue;
      for (let q = 0; q < COLS; q++) {
        if (!walk(rows[0][q])) continue;
        const d = Math.min(mod(p - q, COLS), mod(q - p, COLS));
        if (d < best) best = d;
      }
    }
    return best;
  }

  // Пробует пристыковать ряды; проверяет честность на стыке (предыдущий паттерн + новый).
  _tryRows(rows) {
    const reach = reachThrough(this.rows.slice(-8), this.reach.slice(-8), rows);
    if (!reach) return null;
    const last = this.instances[this.instances.length - 1];
    const winRows = [...this.rows.slice(last.rowStart), ...rows];
    const winReach = [...this.reach.slice(last.rowStart), ...reach];
    const alive = aliveBackward(winRows, winReach);
    if (findUnfair(winRows, winReach, alive)) return null;
    // сколько тупиковых ответвлений создаёт стык: меньше — путь читается как одна линия
    let doomed = 0;
    for (let r = 0; r < winRows.length; r++) for (let c = 0; c < COLS; c++) if (winReach[r][c] && !alive[r][c]) doomed++;
    return { reach, doomed };
  }

  appendNext() {
    const distance = this.rows.length * ROW;
    const last = this.instances[this.instances.length - 1];

    for (let attempt = 0; attempt < 16; attempt++) {
      const p = this._pickPattern(distance);
      if (!p) break;
      if (p.name === last.name && attempt < 4) continue; // без повторов подряд
      const combos = [];
      for (let s = 0; s < COLS; s++) { combos.push([s, false]); combos.push([s, true]); }
      for (let i = combos.length - 1; i > 0; i--) {
        const j = Math.floor(this.rng() * (i + 1));
        [combos[i], combos[j]] = [combos[j], combos[i]];
      }
      // из всех подходящих поворотов берём тот, где меньше тупиков (с долей случайности)
      let best = null;
      for (const [shift, mirror] of combos) {
        const rows = transformRows(p.parsed, shift, mirror);
        const res = this._tryRows(rows);
        if (!res) continue;
        // стык без лишних виляний: вход нового паттерна — напротив выхода предыдущего
        // (особенно в тоннеле: за стенами и потолком не видно, сколько ещё сворачивать)
        const shiftCost = this.tier === 'under' ? 6 : 3;
        const score = res.doomed + this.rng() * 2 + shiftCost * this._joinShift(rows);
        if (!best || score < best.score) best = { score, rows, res, shift, mirror };
      }
      if (best) return this._push(p, best.rows, best.res.reach, best.shift, best.mirror);
    }
    // запасной вариант: короткий коридор любого поворота, в крайнем случае — открытый ряд
    this.fallbacks++;
    const bp = BREATHER_P[this.tier];
    for (let shift = 0; shift < COLS; shift++) {
      const rows = transformRows(bp.parsed, shift, false);
      const res = this._tryRows(rows);
      if (res) return this._push(bp, rows, res.reach, shift, false);
    }
    const op = OPEN_P[this.tier];
    const reach = reachThrough(this.rows.slice(-8), this.reach.slice(-8), op.parsed);
    return this._push(op, op.parsed, reach, 0, false);
  }

  ensureRows(count) {
    const added = [];
    while (this.rows.length < count) added.push(this.appendNext());
    return added;
  }

  // Код клетки в точке (x, z) плоского мира.
  cellAt(x, z) {
    const ri = Math.floor(z / ROW);
    if (ri < 0 || ri >= this.rows.length) return 0;
    return this.rows[ri][mod(Math.floor(x / CELL), COLS)];
  }

  rowAt(z) {
    const ri = Math.floor(z / ROW);
    return this.rows[Math.max(0, Math.min(this.rows.length - 1, ri))];
  }

  // высота пола яруса в точке z (на рампах — плавно)
  baseAt(z) {
    const ri = Math.floor(z / ROW);
    const row = this.rows[Math.max(0, Math.min(this.rows.length - 1, ri))];
    const t = Math.max(0, Math.min(1, z / ROW - ri));
    return row.b0 + (row.b1 - row.b0) * t;
  }

  infoAt(z) {
    const ri = Math.max(0, Math.min(this.rows.length - 1, Math.floor(z / ROW)));
    return this.rowInfo[ri];
  }
}

// Клумба с деревьями у подножия башни вдоль улицы (сторона side = −1/+1 — куда смотрит).
// Нужна и отрисовке, и физике: по стене с клумбой не побежишь.
export function planterAt(world, ri, c, side) {
  const row = world.rows[ri];
  if (!row || row.cover || row.b0 !== 0 || row.b1 !== 0) return false;
  c = mod(c, COLS);
  if (row[c] !== WALL) return false;
  const v = row[mod(c + side, COLS)];
  if (!walk(v) || v === BRIDGE || lv(v) !== 0) return false;
  return hash2(world.seed + 13, ri * 24 + c * 2 + (side > 0 ? 1 : 0)) < 0.4;
}

// Высоты высоток — детерминированно от сида экземпляра и клетки.
export function hash2(a, b) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be59b, 0xc2b2ae35);
  h ^= h >>> 13; h = Math.imul(h, 0x27d4eb2d); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
