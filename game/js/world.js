// Логика мира в «плоских» координатах: генерация из паттернов,
// проверка проходимости и честности, запросы к клеткам для физики.
// Без three.js, чтобы можно было гонять проверки в node.

import { PATTERNS, START, BREATHER } from './patterns.js';

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
export const BRIDGE_BOTTOM = 1.1; // просвет под мостом
export const BRIDGE_TOP = 2 * LEVEL; // верх моста на уровне крыши «2»

const CHAR_CODE = { '.': 0, '1': 1, '2': 2, '3': 3, '#': WALL, b: BRIDGE };

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
  const rows = p.rows.slice().reverse().map((s) => {
    const clean = s.replace(/\s/g, '');
    if (clean.length !== COLS) throw new Error(`pattern ${p.name}: row "${s}" must have ${COLS} cells`);
    return Uint8Array.from(clean, (ch) => {
      const v = CHAR_CODE[ch];
      if (v === undefined) throw new Error(`pattern ${p.name}: unknown cell "${ch}"`);
      return v;
    });
  });
  return { ...p, parsed: rows };
}

function transformRows(rows, shift, mirror) {
  return rows.map((r) => {
    const out = new Uint8Array(COLS);
    for (let c = 0; c < COLS; c++) {
      const src = mirror ? COLS - 1 - c : c;
      out[mod(c + shift, COLS)] = r[src];
    }
    return out;
  });
}

// ---- Проверка проходимости ----
// Модель на уровне рядов: за один ряд игрок смещается максимум на 1 колонку,
// забирается максимум на 1 уровень, спрыгивает с любой высоты,
// может перепрыгнуть один ряд-провал (приземление не выше +1 уровня).
// Под мост (b) можно только с уровня улицы — подкатом.
const walk = (v) => v !== WALL;
const lv = (v) => (v === BRIDGE ? 0 : v);

// Можно ли зайти в клетку v, если стоим на высоте from (уровни).
function enterable(from, v) {
  if (!walk(v)) return false;
  if (v === BRIDGE) return from === 0;
  return v <= from + 1;
}

// Можно ли перейти из клетки c ряда rPrev в соседнюю (|c2−c| ≤ 1) клетку ряда rCur.
export function canStep(rPrev, rCur, c, c2) {
  const from = rPrev[c];
  if (!walk(from)) return false;
  const f = lv(from);
  if (!enterable(f, rCur[c2])) return false;
  if (c === c2) return true;
  // смещение вбок — только если клетка сбоку свободна уже в текущем ряду:
  // так у игрока есть целый ряд на манёвр, а не доля секунды за углом
  return enterable(f, rPrev[c2]);
}

// Прыжок из ряда r через ряд r+1 в ряд r+2 по одной колонке.
function canJumpOver(start, mid, land) {
  if (!walk(start) || !walk(mid) || !walk(land)) return false;
  if (mid === BRIDGE || land === BRIDGE) return false;
  const s = lv(start);
  return s > 0 && mid <= s && land <= s + 1;
}

function stepReach(Fprev, rPrev, rCur, Fprev2, rPrev2) {
  const F = new Uint8Array(COLS);
  for (let c2 = 0; c2 < COLS; c2++) {
    if (!walk(rCur[c2])) continue;
    for (let d = -1; d <= 1 && !F[c2]; d++) {
      const c = mod(c2 + d, COLS);
      if (Fprev[c] && canStep(rPrev, rCur, c, c2)) F[c2] = 1;
    }
    if (!F[c2] && Fprev2 && Fprev2[c2] && canJumpOver(rPrev2[c2], rPrev[c2], rCur[c2])) F[c2] = 1;
  }
  return F;
}

// Прогоняет достижимость через ряды. Возвращает массив F по каждому ряду
// (или null, если где-то путь обрывается полностью).
export function reachThrough(F0, rowLast, F0prev, rowPrev, rows) {
  const out = [];
  let Fp2 = F0prev, rp2 = rowPrev, Fp = F0, rp = rowLast;
  for (const r of rows) {
    const F = stepReach(Fp, rp, r, Fp2, rp2);
    if (!F.some(Boolean)) return null;
    out.push(F);
    Fp2 = Fp; rp2 = rp; Fp = F; rp = r;
  }
  return out;
}

// «Живые» клетки: достижимы и из них можно добраться до последнего ряда.
export function aliveBackward(rows, reach) {
  const n = rows.length;
  const alive = new Array(n);
  alive[n - 1] = Uint8Array.from(reach[n - 1]);
  for (let r = n - 2; r >= 0; r--) {
    const a = new Uint8Array(COLS);
    for (let c = 0; c < COLS; c++) {
      if (!reach[r][c]) continue;
      for (let d = -1; d <= 1 && !a[c]; d++) {
        const c2 = mod(c + d, COLS);
        if (alive[r + 1][c2] && canStep(rows[r], rows[r + 1], c, c2)) a[c] = 1;
      }
      if (!a[c] && r + 2 < n && alive[r + 2][c] && canJumpOver(rows[r][c], rows[r + 1][c], rows[r + 2][c])) a[c] = 1;
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
      const f = lv(rows[r][c]);
      let ok = false;
      for (const dir of [-1, 1]) {
        for (let k = 1; k < COLS && !ok; k++) {
          const cc = mod(c + dir * k, COLS);
          if (!enterable(f, rows[r][cc])) break;
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
  const rest = reachThrough(F0, rows[0], null, null, rows.slice(1));
  if (!rest) return { ok: false, reason: 'no path from entry to exit' };
  const reach = [F0, ...rest];
  const bad = findUnfair(rows, reach, aliveBackward(rows, reach));
  if (bad) return { ok: false, reason: `hidden dead end at row ${bad.row + 1} (from bottom), col ${bad.col}` };
  return { ok: true };
}

const PARSED = PATTERNS.map(parsePattern);
const START_P = parsePattern(START);
const BREATHER_P = parsePattern(BREATHER);
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
    // старт: прямой проспект, игрок в колонке 6
    const rows = START_P.parsed;
    const F0 = new Uint8Array(COLS); F0[6] = 1;
    const reach = [F0, ...reachThrough(F0, rows[0], null, null, rows.slice(1))];
    this._push(START_P, rows, reach, 0, false);
  }

  _push(p, rows, reach, shift, mirror) {
    const inst = {
      id: this.instCount++,
      name: p.name,
      shift, mirror,
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
    return inst;
  }

  // сложность растёт с расстоянием; первые ~150 м — только простое
  _pickPattern(distance) {
    const level = distance < 150 ? 1 : Math.min(3, 1 + distance / 600);
    const pool = USABLE.map((p) => {
      const w = p.weight * (p.diff <= level ? 1 : Math.max(0, 1 - (p.diff - level)));
      return { p, w };
    }).filter((e) => e.w > 0);
    let t = this.rng() * pool.reduce((s, e) => s + e.w, 0);
    for (const e of pool) { t -= e.w; if (t <= 0) return e.p; }
    return pool[pool.length - 1].p;
  }

  // Пробует пристыковать ряды; проверяет честность на стыке (предыдущий паттерн + новый).
  _tryRows(rows) {
    const n = this.rows.length;
    const Fl = this.reach[n - 1], rl = this.rows[n - 1];
    const Fp = this.reach[n - 2] || null, rp = this.rows[n - 2] || null;
    const reach = reachThrough(Fl, rl, Fp, rp, rows);
    if (!reach) return null;
    const last = this.instances[this.instances.length - 1];
    const winRows = [...this.rows.slice(last.rowStart), ...rows];
    const winReach = [...this.reach.slice(last.rowStart), ...reach];
    if (findUnfair(winRows, winReach, aliveBackward(winRows, winReach))) return null;
    return reach;
  }

  appendNext() {
    const distance = this.rows.length * ROW;
    const last = this.instances[this.instances.length - 1];

    for (let attempt = 0; attempt < 8; attempt++) {
      const p = this._pickPattern(distance);
      if (p.name === last.name && attempt < 4) continue; // без повторов подряд
      const combos = [];
      for (let s = 0; s < COLS; s++) { combos.push([s, false]); combos.push([s, true]); }
      for (let i = combos.length - 1; i > 0; i--) {
        const j = Math.floor(this.rng() * (i + 1));
        [combos[i], combos[j]] = [combos[j], combos[i]];
      }
      for (const [shift, mirror] of combos) {
        const rows = transformRows(p.parsed, shift, mirror);
        const reach = this._tryRows(rows);
        if (reach) return this._push(p, rows, reach, shift, mirror);
      }
    }
    // запасной вариант: открытая площадь подходит всегда
    this.fallbacks++;
    const n = this.rows.length;
    const reach = reachThrough(this.reach[n - 1], this.rows[n - 1], this.reach[n - 2] || null, this.rows[n - 2] || null, BREATHER_P.parsed);
    return this._push(BREATHER_P, BREATHER_P.parsed, reach, 0, false);
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

  infoAt(z) {
    const ri = Math.max(0, Math.min(this.rows.length - 1, Math.floor(z / ROW)));
    return this.rowInfo[ri];
  }
}

// Высоты высоток — детерминированно от сида экземпляра и клетки.
export function hash2(a, b) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be59b, 0xc2b2ae35);
  h ^= h >>> 13; h = Math.imul(h, 0x27d4eb2d); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
