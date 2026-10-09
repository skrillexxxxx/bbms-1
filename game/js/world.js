// Логика мира в «плоских» координатах: генерация из паттернов,
// проверка проходимости и запросы высот для физики.
// Без three.js, чтобы можно было гонять проверки в node.

import { PATTERNS, BREATHER } from './patterns.js';

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

const CHAR_LEVEL = { '.': 0, '1': 1, '2': 2, '3': 3, '#': WALL };

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
      const v = CHAR_LEVEL[ch];
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
// и может перепрыгнуть один ряд-провал, если приземляется не выше +1 уровня.
const walk = (v) => v !== WALL;

// Можно ли перейти из клетки c ряда rPrev в соседнюю (|c2−c| ≤ 1) клетку ряда rCur.
export function canStep(rPrev, rCur, c, c2) {
  const h = rCur[c2];
  const from = rPrev[c];
  if (!walk(h) || !walk(from) || h > from + 1) return false;
  if (c === c2) return true;
  // без срезания углов: должна быть проходима одна из соседних клеток
  const side = rPrev[c2];
  const fwd = rCur[c];
  return (walk(side) && side <= from + 1) || (walk(fwd) && fwd <= from + 1);
}

function stepReach(Fprev, rPrev, rCur, Fprev2, rPrev2) {
  const F = new Uint8Array(COLS);
  for (let c2 = 0; c2 < COLS; c2++) {
    const h = rCur[c2];
    if (!walk(h)) continue;
    for (let d = -1; d <= 1 && !F[c2]; d++) {
      const c = mod(c2 + d, COLS);
      if (Fprev[c] && canStep(rPrev, rCur, c, c2)) F[c2] = 1;
    }
    // прыжок через ряд
    if (!F[c2] && Fprev2 && Fprev2[c2]) {
      const start = rPrev2[c2];
      const mid = rPrev[c2];
      if (walk(mid) && mid <= start && h <= start + 1) F[c2] = 1;
    }
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

// Самопроверка паттерна: из любой проходимой клетки входа есть путь к выходу.
export function validatePattern(p) {
  const rows = p.parsed;
  const first = rows[0];
  const F0 = Uint8Array.from(first, (v) => (walk(v) ? 1 : 0));
  if (!F0.some(Boolean)) return { ok: false, reason: 'entry row is fully blocked' };
  const res = reachThrough(F0, first, null, null, rows.slice(1));
  if (!res) return { ok: false, reason: 'no path from entry to exit' };
  return { ok: true };
}

const PARSED = PATTERNS.map(parsePattern);
const BREATHER_P = parsePattern(BREATHER);
export const PATTERN_REPORT = PARSED.map((p) => ({ name: p.name, ...validatePattern(p) }));
const USABLE = PARSED.filter((p, i) => PATTERN_REPORT[i].ok);

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
    // старт: открытая площадь, без поворота
    const start = PARSED.find((p) => p.name === 'plaza') || BREATHER_P;
    const rows = start.parsed;
    const F0 = Uint8Array.from(rows[0], (v) => (walk(v) ? 1 : 0));
    const reach = [F0, ...(reachThrough(F0, rows[0], null, null, rows.slice(1)) || [])];
    this._push(start, rows, reach, 0, false);
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

  // сложность растёт с расстоянием
  _pickPattern(distance) {
    const level = Math.min(3, 1 + distance / 600);
    const pool = USABLE.map((p) => {
      const w = p.weight * (p.diff <= level ? 1 : Math.max(0, 1 - (p.diff - level)));
      return { p, w };
    }).filter((e) => e.w > 0);
    let t = this.rng() * pool.reduce((s, e) => s + e.w, 0);
    for (const e of pool) { t -= e.w; if (t <= 0) return e.p; }
    return pool[pool.length - 1].p;
  }

  appendNext() {
    const n = this.rows.length;
    const Fl = this.reach[n - 1], rl = this.rows[n - 1];
    const Fp = this.reach[n - 2] || null, rp = this.rows[n - 2] || null;
    const distance = n * ROW;
    const last = this.instances[this.instances.length - 1];

    for (let attempt = 0; attempt < 6; attempt++) {
      let p = this._pickPattern(distance);
      if (p.name === last.name && attempt < 3) continue; // без повторов подряд
      // все повороты/зеркала в случайном порядке
      const combos = [];
      for (let s = 0; s < COLS; s++) { combos.push([s, false]); combos.push([s, true]); }
      for (let i = combos.length - 1; i > 0; i--) {
        const j = Math.floor(this.rng() * (i + 1));
        [combos[i], combos[j]] = [combos[j], combos[i]];
      }
      for (const [shift, mirror] of combos) {
        const rows = transformRows(p.parsed, shift, mirror);
        const reach = reachThrough(Fl, rl, Fp, rp, rows);
        if (reach) return this._push(p, rows, reach, shift, mirror);
      }
    }
    const reach = reachThrough(Fl, rl, Fp, rp, BREATHER_P.parsed);
    return this._push(BREATHER_P, BREATHER_P.parsed, reach, 0, false);
  }

  ensureRows(count) {
    const added = [];
    while (this.rows.length < count) added.push(this.appendNext());
    return added;
  }

  // Высота поверхности в точке (x, z) плоского мира; Infinity — стена.
  heightAt(x, z) {
    const ri = Math.floor(z / ROW);
    if (ri < 0 || ri >= this.rows.length) return 0;
    const c = mod(Math.floor(x / CELL), COLS);
    const v = this.rows[ri][c];
    return v === WALL ? Infinity : v * LEVEL;
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
