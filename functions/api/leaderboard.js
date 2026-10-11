// Общая таблица рекордов: Cloudflare Pages Function + база D1 (привязка DB в настройках проекта Pages).
//
// Игрок «входит» ником: устройство создаёт случайный секретный токен (localStorage sdwg-lb-token),
// сервер хранит только его хеш. Ник занят — значит, им владеет другой токен, и чужие результаты
// под этим ником не записать. Ник сравнивается не буквально, а по двум «скелетам»: как выглядит
// (регистр, похожие буквы латиницы и кириллицы a/а, o/о, p/р…, цифры-двойники 0/o, 1/l/I, пробелы
// и знаки, повторы букв) и как читается (транслит). Так «Ivan», «lvan», «IVAN_», «Iван», «Ivvan»
// и «Иван» — одно имя, и занять его может только первый.
//
// GET  /api/leaderboard?by=dist|speed|monkeys[&token=…] → { top: [{ name, dist, speed, monkeys }], me: { name, rank, … } | null }
// POST /api/leaderboard { action: 'register', token, name }   → { ok, name } | { error: 'taken', name } | { error: 'bad' }
// POST /api/leaderboard { action: 'score', token, dist, speed, monkeys } → { ok, dist, speed, monkeys }

const TOP = 50;
const MAX_DIST = 1_000_000; // м — дальше не бегают, это уже подделка
const MAX_SPEED = 400; // км/ч
const MAX_MONKEYS = 100_000;

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

async function hashToken(token) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(token)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const okToken = (t) => typeof t === 'string' && t.length >= 16 && t.length <= 128;

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
        tok TEXT PRIMARY KEY, name TEXT NOT NULL, skel TEXT NOT NULL UNIQUE, tskel TEXT NOT NULL UNIQUE,
        dist INTEGER NOT NULL DEFAULT 0, speed INTEGER NOT NULL DEFAULT 0, monkeys INTEGER NOT NULL DEFAULT 0,
        created INTEGER NOT NULL, updated INTEGER NOT NULL)`),
      DB.prepare('CREATE INDEX IF NOT EXISTS players_dist ON players (dist DESC)'),
      DB.prepare('CREATE INDEX IF NOT EXISTS players_speed ON players (speed DESC)'),
      DB.prepare('CREATE INDEX IF NOT EXISTS players_monkeys ON players (monkeys DESC)'),
    ]);
    ready = true;
  }
  return DB;
}

export async function onRequestGet({ request, env }) {
  const DB = await db(env);
  if (!DB) return json({ error: 'nodb' }, 503);
  const url = new URL(request.url);
  const by = url.searchParams.get('by');
  const col = by === 'speed' || by === 'monkeys' ? by : 'dist';
  const other = col === 'dist' ? 'speed' : 'dist';
  const { results } = await DB.prepare(
    `SELECT name, dist, speed, monkeys FROM players WHERE ${col} > 0 ORDER BY ${col} DESC, ${other} DESC, updated ASC LIMIT ?`,
  ).bind(TOP).all();
  let me = null;
  const token = url.searchParams.get('token');
  if (okToken(token)) {
    const row = await DB.prepare('SELECT name, dist, speed, monkeys FROM players WHERE tok = ?').bind(await hashToken(token)).first();
    if (row) {
      const above = await DB.prepare(`SELECT COUNT(*) AS n FROM players WHERE ${col} > ?`).bind(row[col]).first();
      me = { ...row, rank: row[col] > 0 ? above.n + 1 : null };
    }
  }
  return json({ top: results, me });
}

export async function onRequestPost({ request, env }) {
  const DB = await db(env);
  if (!DB) return json({ error: 'nodb' }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad' }, 400); }
  if (!body || !okToken(body.token)) return json({ error: 'bad' }, 400);
  const tok = await hashToken(body.token);
  const now = Date.now();

  if (body.action === 'register') {
    const name = cleanName(body.name);
    if (!validName(name)) return json({ error: 'bad' }, 400);
    const skel = skeleton(name), tskel = translitSkeleton(name);
    if (skel.length < 2 || tskel.length < 2) return json({ error: 'bad' }, 400);
    const clashQ = DB.prepare('SELECT tok, name FROM players WHERE (skel = ?1 OR tskel = ?2) AND tok != ?3 LIMIT 1').bind(skel, tskel, tok);
    const clash = await clashQ.first();
    if (clash) return json({ error: 'taken', name: clash.name }, 409);
    try {
      await DB.prepare(`INSERT INTO players (tok, name, skel, tskel, created, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
        ON CONFLICT (tok) DO UPDATE SET name = ?2, skel = ?3, tskel = ?4, updated = ?5`).bind(tok, name, skel, tskel, now).run();
    } catch {
      // кто-то занял похожий ник одновременно с нами — UNIQUE не пустил
      const c = await clashQ.first();
      return json({ error: 'taken', name: c ? c.name : name }, 409);
    }
    return json({ ok: true, name });
  }

  if (body.action === 'score') {
    const dist = Math.round(Number(body.dist));
    const speed = Math.round(Number(body.speed));
    const monkeys = Math.round(Number(body.monkeys) || 0);
    if (!(dist >= 0 && dist <= MAX_DIST && speed >= 0 && speed <= MAX_SPEED && monkeys >= 0 && monkeys <= MAX_MONKEYS)) {
      return json({ error: 'bad' }, 400);
    }
    const row = await DB.prepare(`UPDATE players SET dist = MAX(dist, ?2), speed = MAX(speed, ?3), monkeys = MAX(monkeys, ?4),
      updated = ?5 WHERE tok = ?1 RETURNING dist, speed, monkeys`).bind(tok, dist, speed, monkeys, now).first();
    if (!row) return json({ error: 'noplayer' }, 404);
    return json({ ok: true, ...row });
  }

  return json({ error: 'bad' }, 400);
}
