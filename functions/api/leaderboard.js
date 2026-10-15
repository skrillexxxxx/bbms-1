// Общая таблица рекордов и аккаунты: Cloudflare Pages Function + база D1 (привязка DB в настройках проекта Pages).
//
// Аккаунт — ник + пароль. Пароль хранится только как PBKDF2-хеш с солью; после 5 неверных попыток
// вход по нику закрыт на 10 минут. Каждое устройство, где ты вошёл, получает свой случайный токен
// (localStorage sdwg-lb-token), сервер хранит только хеш токена — им подтверждаются запросы.
// Ник сравнивается не буквально, а по двум «скелетам»: как выглядит (регистр, похожие буквы латиницы
// и кириллицы a/а, o/о, p/р…, цифры-двойники 0/o, 1/l/I, пробелы и знаки, повторы букв) и как читается
// (транслит). Так «Ivan», «lvan», «IVAN_», «Iван», «Ivvan» и «Иван» — одно имя, и занять его может только первый.
//
// Прогресс (рекорды, обезьянки, «Мои города», настройки — ключи city-* и sdwg-*) тоже лежит на сервере
// и объединяется между устройствами: рекорды и обезьянки — максимум, города — все вместе, остальное — с
// последнего устройства. Рекорды в таблице берутся из этого прогресса.
//
// GET  /api/leaderboard?by=score|dist|speed|monkeys[&token=…] → { day, top: [{ name, score, dist, speed, monkeys }], me: { name, rank, … } | null }
//      (score — очки: метры × множитель потока; главная сортировка)
//      Таблица — рекорды ДНЯ: день по Москве (UTC+3), в полночь у всех нули. В списке — все игроки,
//      у кого сегодня забегов не было — нули. Дневные рекорды приходят в прогрессе: sdwg-day + sdwg-day-stats.
//      &board=city — таблица «Города дня» (один сид на всех на сутки) — гонка на время до финиша:
//      { top: [{ name, time, speed, monkeys }] } — сначала добежавшие по времени (мс, меньше — лучше), потом остальные
//      (time = 0 — не финишировал); count — сколько сегодня финишировали (для «ты 3-й из 12»).
// POST { action: 'register', token, name, password? } → { ok, name } | { error: 'taken', name } | { error: 'bad' | 'weak' }
//      (новый аккаунт — пароль обязателен; уже вошёл — смена ника и, если передан, пароля)
// POST { action: 'login', name, password }   → { ok, name, token, data } | { error: 'wrong' } | { error: 'locked', wait }
// POST { action: 'sync', token, data }       → { ok, name, data } — объединённый прогресс
// POST { action: 'logout', token }           → { ok }
// Призрак города дня — траектория лучшего забега:
// GET  /api/leaderboard?ghost=1               → { ghosts: [{ name, time, track }] } — лучшие по времени финиши дня (до GHOSTS)
// POST { action: 'ghost', token, time, track } → { ok, saved } — свой финиш (мс), хранится лучший за день
//      track — целые: [x, y, z, подкат] каждые 0.1 с, x/y/z ×100, разностями от предыдущей точки

const TOP = 50;
const MAX_DIST = 1_000_000; // м — дальше не бегают, это уже подделка
const MAX_SCORE = 1_000_000_000; // очки
const MAX_TIME = 3_600_000;      // мс: время до финиша в городе дня — не дольше часа
const MAX_SPEED = 400; // км/ч
const MAX_MONKEYS = 100_000;
const MAX_SAVE = 64 * 1024; // байт JSON прогресса
const FAILS = 5, LOCK_MS = 10 * 60 * 1000; // неверных паролей подряд → блокировка входа
const PBKDF2_ITER = 100_000; // больше Workers не разрешают
const MAX_TRACK = 4 * 9000; // чисел в треке призрака: 15 минут по 0.1 с
const GHOSTS = 5;           // сколько призраков дня отдаём (лучшие)

// латиница ← похожие буквы кириллицы и греческого, цифры и знаки-двойники
const LOOK = {
  а: 'a', в: 'b', е: 'e', ё: 'e', з: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
  ь: 'b', ъ: 'b', п: 'n', г: 'r', і: 'l', ї: 'l', є: 'e', ј: 'l', ѕ: 's',
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'l', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x',
  0: 'o', 1: 'l', 3: 'e', 4: 'a', 5: 's', 6: 'b', 7: 't', 8: 'b', 9: 'g',
  i: 'l', '|': 'l', '!': 'l', $: 's', '@': 'a',
};

// ник, как его покажут: без управляющих и «невидимых» символов, пробелы схлопнуты
export function cleanName(raw) {
  return String(raw ?? '').normalize('NFKC')
    .replace(/[\p{C}\p{M}ᅟᅠㅤﾠ]/gu, '')
    .replace(/\s+/g, ' ').trim();
}
export function validName(name) {
  return name.length >= 2 && name.length <= 16 && /^[\p{L}\p{N} _.\-]+$/u.test(name) && /[\p{L}\p{N}]/u.test(name);
}
// транслит кириллицы: «Иван» и «Ivan», «Сергей» и «Sergei» — одно имя
const TR = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '',
  ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'i', є: 'e', ў: 'u', ґ: 'g',
};
const DIG = { 0: 'o', 1: 'l', 3: 'e', 4: 'a', 5: 's', 6: 'b', 7: 't', 8: 'b', 9: 'g', '|': 'l', '!': 'l', $: 's', '@': 'a' };
const keep = (c) => /^[\p{L}\p{N}]+$/u.test(c);

// два «скелета» ника — по ним ищем занятые и похожие:
// skel — как выглядит (похожие буквы разных алфавитов, 0/o, 1/l/I), tskel — как читается (транслит)
export function skeleton(name) {
  let s = '';
  for (const ch of cleanName(name).toLowerCase()) {
    const c = LOOK[ch] ?? ch;
    if (keep(c)) s += c;
  }
  // повторы букв («Ivvan» = «Ivan»), потом rn и m, cl и d — на глаз путаются
  return s.replace(/(.)\1+/gu, '$1').replace(/rn/g, 'm').replace(/cl/g, 'd');
}
export function translitSkeleton(name) {
  let s = '';
  for (const ch of cleanName(name).toLowerCase()) {
    const c = TR[ch] ?? DIG[ch] ?? ch;
    if (keep(c) || c === '') s += c;
  }
  s = s.replace(/x/g, 'ks').replace(/kh/g, 'h').replace(/ts/g, 'c').replace(/[ijy]/g, 'l'); // Max/Макс, Sergey/Sergei, Yuri/Juri, I/l
  return s.replace(/(.)\1+/gu, '$1');
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
async function hashToken(token) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(token))));
}
async function pbkdf2(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITER }, key, 256));
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `${hex(salt)}:${await pbkdf2(password, salt)}`;
}
async function checkPassword(password, stored) {
  if (!stored) return false;
  const [salt, h] = stored.split(':');
  const got = await pbkdf2(password, unhex(salt));
  let diff = got.length ^ h.length; // сравнение без утечки по времени
  for (let i = 0; i < Math.min(got.length, h.length); i++) diff |= got.charCodeAt(i) ^ h.charCodeAt(i);
  return diff === 0;
}
const okToken = (t) => typeof t === 'string' && t.length >= 16 && t.length <= 128;
const okPassword = (p) => typeof p === 'string' && p.length >= 4 && p.length <= 64;
const newToken = () => hex(crypto.getRandomValues(new Uint8Array(24)));

// ---------- прогресс ----------
const SKIP = (k) => k.startsWith('sdwg-lb-'); // аккаунт устройства — не прогресс
const ours = (k) => (k.startsWith('city-') || k.startsWith('sdwg-')) && !SKIP(k);
const MAXED = ['city-best', 'city-best-score', 'city-best-speed', 'sdwg-monkeys'];
function parseSeeds(v) { try { const l = JSON.parse(v); return Array.isArray(l) ? l : []; } catch { return []; } }
// собранные обезьянки города дня { day, seed, got: [ряды], total }: тот же город — объединяем, иначе — более поздний день
const CITY_MONKEYS = 'sdwg-city-monkeys';
function parseCity(v) {
  try {
    const o = JSON.parse(v);
    if (!o || typeof o !== 'object' || !Array.isArray(o.got)) return null;
    const got = [...new Set(o.got.map(Number).filter((r) => Number.isInteger(r) && r >= 0 && r < 10000))].slice(0, 64);
    return { day: typeof o.day === 'string' ? o.day.slice(0, 10) : '', seed: Number(o.seed) || 0, got, total: Math.min(64, Math.max(0, Number(o.total) || 0)) };
  } catch { return null; }
}
function mergeCity(a, b) {
  const x = parseCity(a), y = parseCity(b);
  if (!x || !y) return JSON.stringify(y || x || { day: '', seed: 0, got: [], total: 0 });
  if (x.seed !== y.seed) return JSON.stringify(y.day >= x.day ? y : x);
  return JSON.stringify({ ...y, day: y.day > x.day ? y.day : x.day, got: [...new Set([...x.got, ...y.got])].slice(0, 64), total: Math.max(x.total, y.total) });
}

// ---------- рекорды дня ----------
// день — по Москве (UTC+3, без перехода на летнее время), как и в игре
export const dayKey = (now = Date.now()) => new Date(now + 3 * 3600e3).toISOString().slice(0, 10);
const DAY = 'sdwg-day', DAY_STATS = 'sdwg-day-stats';
// поле в sdwg-day-stats → колонка таблицы; c… — город дня
// cTime — лучшее время до финиша в городе дня (мс, 0 — не финишировал): из двух берётся меньшее, не максимум
const STAT_COLS = { score: 'score', dist: 'dist', speed: 'speed', monkeys: 'monkeys', cScore: 'c_score', cDist: 'c_dist', cSpeed: 'c_speed', cMonkeys: 'c_monkeys', cTime: 'c_time' };
const minTime = (a, b) => (a > 0 && b > 0 ? Math.min(a, b) : a || b);
const STAT_KEYS = Object.keys(STAT_COLS);
const BOARD_FIELDS = ['score', 'dist', 'speed', 'monkeys']; // что отдаём клиенту в каждой строке
function dayOf(save, today) {
  const day = typeof save?.[DAY] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(save[DAY]) && save[DAY] <= today ? save[DAY] : '';
  let st = {};
  try { st = JSON.parse(save?.[DAY_STATS] || '{}') || {}; } catch { /* битые данные — нули */ }
  return { day, st: Object.fromEntries(STAT_KEYS.map((k) => [k, Math.max(0, Number(st[k]) || 0)])) };
}
// дневные рекорды двух устройств: более поздний день побеждает, один и тот же день — максимум по каждому
function mergeDay(base, inc, today) {
  const b = dayOf(base, today), i = dayOf(inc, today);
  if (i.day > b.day) return i;
  if (i.day < b.day) return b;
  return { day: b.day, st: Object.fromEntries(STAT_KEYS.map((k) => [k, k === 'cTime' ? minTime(b.st[k], i.st[k]) : Math.max(b.st[k], i.st[k])])) };
}

// объединить сохранённое на сервере (base) с пришедшим с устройства (inc)
export function mergeSave(base, inc, today = dayKey()) {
  const out = {};
  for (const [k, v] of Object.entries(base || {})) if (ours(k) && typeof v === 'string') out[k] = v;
  for (const [k, v] of Object.entries(inc || {})) {
    if (!ours(k) || typeof v !== 'string' || k === DAY || k === DAY_STATS) continue;
    if (MAXED.includes(k)) out[k] = String(Math.max(Number(out[k]) || 0, Number(v) || 0));
    else if (k === CITY_MONKEYS) out[k] = mergeCity(out[k], v);
    else if (k === 'sdwg-seeds') {
      const all = new Map();
      for (const e of [...parseSeeds(out[k]), ...parseSeeds(v)]) {
        if (!e || typeof e !== 'object' || !Number.isFinite(Number(e.seed))) continue;
        const was = all.get(e.seed);
        if (!was) { all.set(e.seed, e); continue; }
        const late = (Number(e.at) || 0) >= (Number(was.at) || 0) ? e : was;
        all.set(e.seed, { ...late, best: Math.max(Number(e.best) || 0, Number(was.best) || 0) });
      }
      out[k] = JSON.stringify([...all.values()].sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0)));
    } else out[k] = v;
  }
  const d = mergeDay(base, inc, today);
  if (d.day) { out[DAY] = d.day; out[DAY_STATS] = JSON.stringify(d.st); } else { delete out[DAY]; delete out[DAY_STATS]; }
  return out;
}
const clamp = (v, max) => Math.min(max, Math.max(0, Math.round(Number(v) || 0)));
// колонки таблицы — рекорды сегодняшнего дня (вчерашние — нули)
const MAXES = { score: MAX_SCORE, dist: MAX_DIST, speed: MAX_SPEED, monkeys: MAX_MONKEYS, time: MAX_TIME };
function scores(save, today) {
  const d = dayOf(save, today);
  const st = d.day === today ? d.st : {};
  const out = {};
  for (const [k, c] of Object.entries(STAT_COLS)) out[c] = clamp(st[k], MAXES[c.replace('c_', '')]);
  return out;
}
function parseSave(text) { try { return JSON.parse(text || '{}') || {}; } catch { return {}; } }

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

let ready = false;
async function db(env) {
  const DB = env.DB;
  if (!DB) return null;
  if (!ready) {
    await DB.batch([
      DB.prepare(`CREATE TABLE IF NOT EXISTS players (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, skel TEXT NOT NULL UNIQUE, tskel TEXT NOT NULL UNIQUE, pass TEXT,
        day TEXT NOT NULL DEFAULT '', score INTEGER NOT NULL DEFAULT 0,
        c_score INTEGER NOT NULL DEFAULT 0, c_dist INTEGER NOT NULL DEFAULT 0, c_speed INTEGER NOT NULL DEFAULT 0, c_monkeys INTEGER NOT NULL DEFAULT 0, dist INTEGER NOT NULL DEFAULT 0, speed INTEGER NOT NULL DEFAULT 0, monkeys INTEGER NOT NULL DEFAULT 0,
        save TEXT, fails INTEGER NOT NULL DEFAULT 0, lock_until INTEGER NOT NULL DEFAULT 0,
        created INTEGER NOT NULL, updated INTEGER NOT NULL)`),
      DB.prepare(`CREATE TABLE IF NOT EXISTS tokens (
        tok TEXT PRIMARY KEY, player INTEGER NOT NULL, created INTEGER NOT NULL)`),
      DB.prepare('CREATE INDEX IF NOT EXISTS players_dist ON players (dist DESC)'),
      DB.prepare('CREATE INDEX IF NOT EXISTS players_speed ON players (speed DESC)'),
      DB.prepare('CREATE INDEX IF NOT EXISTS players_monkeys ON players (monkeys DESC)'),
      DB.prepare('CREATE INDEX IF NOT EXISTS tokens_player ON tokens (player)'),
      DB.prepare(`CREATE TABLE IF NOT EXISTS ghosts (
        player INTEGER NOT NULL, day TEXT NOT NULL, score INTEGER NOT NULL, track TEXT NOT NULL, updated INTEGER NOT NULL,
        time INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (player, day))`),
    ]);
    // база, созданная раньше: добавить колонки (уже есть — SQLite ответит ошибкой, это нормально)
    try { await DB.prepare('ALTER TABLE players ADD COLUMN score INTEGER NOT NULL DEFAULT 0').run(); } catch { /* колонка уже есть */ }
    try { await DB.prepare("ALTER TABLE players ADD COLUMN day TEXT NOT NULL DEFAULT ''").run(); } catch { /* колонка уже есть */ }
    for (const c of ['c_score', 'c_dist', 'c_speed', 'c_monkeys', 'c_time']) {
      try { await DB.prepare(`ALTER TABLE players ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 0`).run(); } catch { /* колонка уже есть */ }
    }
    try { await DB.prepare('ALTER TABLE ghosts ADD COLUMN time INTEGER NOT NULL DEFAULT 0').run(); } catch { /* колонка уже есть */ }
    ready = true;
  }
  return DB;
}
async function playerByToken(DB, token) {
  if (!okToken(token)) return null;
  return DB.prepare('SELECT p.* FROM tokens t JOIN players p ON p.id = t.player WHERE t.tok = ?').bind(await hashToken(token)).first();
}

export async function onRequestGet({ request, env }) {
  const DB = await db(env);
  if (!DB) return json({ error: 'nodb' }, 503);
  const url = new URL(request.url);
  if (url.searchParams.has('ghost')) {
    // только финиши (time > 0): недобежавшие треки — не призраки
    const { results } = await DB.prepare(`SELECT p.name, g.time, g.track FROM ghosts g JOIN players p ON p.id = g.player
      WHERE g.day = ? AND g.time > 0 ORDER BY g.time ASC, g.updated ASC LIMIT ?`).bind(dayKey(), GHOSTS).all();
    const ghosts = [];
    for (const g of results) {
      try { ghosts.push({ name: g.name, time: g.time, track: JSON.parse(g.track) }); } catch { /* битый трек — пропускаем */ }
    }
    return json({ ghost: ghosts[0] || null, ghosts });
  }
  const by = url.searchParams.get('by');
  const city = url.searchParams.get('board') === 'city';
  if (city) {
    // гонка на время: сначала финишировавшие сегодня по времени, потом остальные (не финишировали — time 0)
    const today = dayKey();
    const t = '(CASE WHEN day = ?1 THEN c_time ELSE 0 END)';
    const { results } = await DB.prepare(
      `SELECT name, ${t} AS time, (CASE WHEN day = ?1 THEN c_speed ELSE 0 END) AS speed, (CASE WHEN day = ?1 THEN c_monkeys ELSE 0 END) AS monkeys
       FROM players ORDER BY (${t} > 0) DESC, ${t} ASC, id ASC LIMIT ?2`,
    ).bind(today, TOP).all();
    const cnt = await DB.prepare(`SELECT COUNT(*) AS n FROM players WHERE ${t} > 0`).bind(today).first();
    let me = null;
    const row = await playerByToken(DB, url.searchParams.get('token'));
    if (row) {
      const mine = row.day === today ? { time: row.c_time, speed: row.c_speed, monkeys: row.c_monkeys } : { time: 0, speed: 0, monkeys: 0 };
      const faster = await DB.prepare(`SELECT COUNT(*) AS n FROM players WHERE ${t} > 0 AND ${t} < ?2`).bind(today, mine.time).first();
      me = { name: row.name, ...mine, rank: mine.time > 0 ? faster.n + 1 : null };
    }
    return json({ day: today, board: 'city', count: cnt.n, top: results, me });
  }
  const field = ['dist', 'speed', 'monkeys'].includes(by) ? by : 'score';
  const otherField = field === 'score' ? 'dist' : field === 'dist' ? 'speed' : 'score';
  const colOf = (f) => (city ? `c_${f}` : f);
  const today = dayKey();
  // значение за сегодня: у кого последний забег был не сегодня — ноль
  const v = (f) => `(CASE WHEN day = ?1 THEN ${colOf(f)} ELSE 0 END)`;
  const { results } = await DB.prepare(
    `SELECT name, ${BOARD_FIELDS.map((f) => `${v(f)} AS ${f}`).join(', ')} FROM players
     ORDER BY ${v(field)} DESC, ${v(otherField)} DESC, id ASC LIMIT ?2`,
  ).bind(today, TOP).all();
  const cnt = await DB.prepare(`SELECT COUNT(*) AS n FROM players WHERE ${v(field)} > 0`).bind(today).first();
  let me = null;
  const row = await playerByToken(DB, url.searchParams.get('token'));
  if (row) {
    const mine = Object.fromEntries(BOARD_FIELDS.map((f) => [f, row.day === today ? row[colOf(f)] : 0]));
    const above = await DB.prepare(`SELECT COUNT(*) AS n FROM players WHERE ${v(field)} > ?2`).bind(today, mine[field]).first();
    me = { name: row.name, ...mine, rank: mine[field] > 0 ? above.n + 1 : null };
  }
  return json({ day: today, board: city ? 'city' : 'all', count: cnt.n, top: results, me });
}

export async function onRequestPost({ request, env }) {
  const DB = await db(env);
  if (!DB) return json({ error: 'nodb' }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad' }, 400); }
  if (!body || typeof body !== 'object') return json({ error: 'bad' }, 400);
  const now = Date.now();

  if (body.action === 'register') {
    if (!okToken(body.token)) return json({ error: 'bad' }, 400);
    const name = cleanName(body.name);
    if (!validName(name)) return json({ error: 'bad' }, 400);
    const skel = skeleton(name), tskel = translitSkeleton(name);
    if (skel.length < 2 || tskel.length < 2) return json({ error: 'bad' }, 400);
    const me = await playerByToken(DB, body.token);
    const pw = body.password;
    if (pw != null && pw !== '' && !okPassword(pw)) return json({ error: 'weak' }, 400);
    if (!me && !okPassword(pw)) return json({ error: 'weak' }, 400);
    const clashQ = DB.prepare('SELECT name FROM players WHERE (skel = ?1 OR tskel = ?2) AND id != ?3 LIMIT 1').bind(skel, tskel, me ? me.id : -1);
    const clash = await clashQ.first();
    if (clash) return json({ error: 'taken', name: clash.name }, 409);
    const pass = okPassword(pw) ? await hashPassword(pw) : null;
    try {
      if (me) {
        await DB.prepare('UPDATE players SET name = ?2, skel = ?3, tskel = ?4, pass = COALESCE(?5, pass), updated = ?6 WHERE id = ?1')
          .bind(me.id, name, skel, tskel, pass, now).run();
      } else {
        const row = await DB.prepare(`INSERT INTO players (name, skel, tskel, pass, created, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
          RETURNING id`).bind(name, skel, tskel, pass, now).first();
        await DB.prepare('INSERT OR REPLACE INTO tokens (tok, player, created) VALUES (?, ?, ?)').bind(await hashToken(body.token), row.id, now).run();
      }
    } catch {
      // кто-то занял похожий ник одновременно с нами — UNIQUE не пустил
      const c = await clashQ.first();
      return json({ error: 'taken', name: c ? c.name : name }, 409);
    }
    return json({ ok: true, name });
  }

  if (body.action === 'login') {
    const name = cleanName(body.name);
    if (!name || typeof body.password !== 'string') return json({ error: 'wrong' }, 401);
    const p = await DB.prepare('SELECT * FROM players WHERE skel = ?1 OR tskel = ?2 LIMIT 1').bind(skeleton(name), translitSkeleton(name)).first();
    if (!p) return json({ error: 'wrong' }, 401);
    if (p.lock_until > now) return json({ error: 'locked', wait: Math.ceil((p.lock_until - now) / 1000) }, 429);
    if (!(await checkPassword(body.password, p.pass))) {
      const fails = p.fails + 1;
      await DB.prepare('UPDATE players SET fails = ?2, lock_until = ?3 WHERE id = ?1')
        .bind(p.id, fails >= FAILS ? 0 : fails, fails >= FAILS ? now + LOCK_MS : 0).run();
      if (fails >= FAILS) return json({ error: 'locked', wait: LOCK_MS / 1000 }, 429);
      return json({ error: 'wrong', left: FAILS - fails }, 401);
    }
    const token = newToken();
    await DB.batch([
      DB.prepare('UPDATE players SET fails = 0, lock_until = 0 WHERE id = ?').bind(p.id),
      DB.prepare('INSERT INTO tokens (tok, player, created) VALUES (?, ?, ?)').bind(await hashToken(token), p.id, now),
    ]);
    return json({ ok: true, name: p.name, token, data: parseSave(p.save) });
  }

  if (body.action === 'sync') {
    const me = await playerByToken(DB, body.token);
    if (!me) return json({ error: 'noplayer' }, 404);
    if (!body.data || typeof body.data !== 'object') return json({ error: 'bad' }, 400);
    const today = dayKey(now);
    const merged = mergeSave(parseSave(me.save), body.data, today);
    const text = JSON.stringify(merged);
    if (text.length > MAX_SAVE) return json({ error: 'big' }, 413);
    const sc = scores(merged, today);
    await DB.prepare(`UPDATE players SET save = ?2, day = ?3, score = ?4, dist = ?5, speed = ?6, monkeys = ?7,
      c_score = ?8, c_dist = ?9, c_speed = ?10, c_monkeys = ?11, c_time = ?13, updated = ?12 WHERE id = ?1`)
      .bind(me.id, text, today, sc.score, sc.dist, sc.speed, sc.monkeys, sc.c_score, sc.c_dist, sc.c_speed, sc.c_monkeys, now, sc.c_time).run();
    return json({ ok: true, name: me.name, data: merged });
  }

  if (body.action === 'ghost') {
    const me = await playerByToken(DB, body.token);
    if (!me) return json({ error: 'noplayer' }, 404);
    const t = body.track;
    if (!Array.isArray(t) || t.length < 8 || t.length > MAX_TRACK || t.length % 4 || !t.every(Number.isInteger)) return json({ error: 'bad' }, 400);
    const time = clamp(body.time, MAX_TIME);
    if (!time) return json({ error: 'bad' }, 400);
    const today = dayKey(now);
    // хранится лучший (самый быстрый) финиш за день; вчерашние призраки больше не нужны
    const r = await DB.prepare(`INSERT INTO ghosts (player, day, score, time, track, updated) VALUES (?1, ?2, 0, ?3, ?4, ?5)
      ON CONFLICT (player, day) DO UPDATE SET time = excluded.time, track = excluded.track, updated = excluded.updated
      WHERE ghosts.time = 0 OR excluded.time < ghosts.time`).bind(me.id, today, time, JSON.stringify(t), now).run();
    await DB.prepare('DELETE FROM ghosts WHERE day < ?').bind(today).run();
    return json({ ok: true, saved: (r.meta?.changes ?? r.changes ?? 0) > 0 });
  }

  if (body.action === 'logout') {
    if (okToken(body.token)) await DB.prepare('DELETE FROM tokens WHERE tok = ?').bind(await hashToken(body.token)).run();
    return json({ ok: true });
  }

  return json({ error: 'bad' }, 400);
}
