// Общая таблица рекордов (сервер — functions/api/leaderboard.js).
// Вход — ником: при первом запуске игра просит придумать ник; устройство получает секретный токен
// (sdwg-lb-token), им и подтверждается, что ник твой. Токен и ник лежат в sdwg-* — переезжают
// вместе с «Сохранить прогресс» / «Загрузить» (Safari → приложение, новый телефон).
// В таблицу уходят лучшие результаты устройства (city-best, city-best-speed) и сколько всего
// собрано обезьянок (sdwg-monkeys); сервер хранит максимум.

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const API = 'api/leaderboard';
const K_TOKEN = 'sdwg-lb-token', K_NAME = 'sdwg-lb-name', K_SENT = 'sdwg-lb-sent', K_ASKED = 'sdwg-lb-asked';

const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k, v) => { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } };
const sget = (k) => { try { return sessionStorage.getItem(k); } catch { return null; } };
const sset = (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* приватный режим */ } };

function token() {
  let t = get(K_TOKEN);
  if (!t) {
    const b = crypto.getRandomValues(new Uint8Array(24));
    t = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    set(K_TOKEN, t);
  }
  return t;
}
export const playerName = () => get(K_NAME) || '';

async function api(body, query = '') {
  const r = await fetch(API + query, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch { /* не JSON — сервера нет */ }
  if (!data) throw new Error('offline');
  return data;
}

// ---------- отправка рекордов ----------
// Отправляем только если с прошлого раза что-то выросло; не дошло (нет сети) — повторим
// при следующей смерти или запуске.
let sending = false;
export async function submitBest() {
  if (sending || !playerName() || params.has('auto')) return;
  const dist = Number(get('city-best')) || 0, speed = Number(get('city-best-speed')) || 0;
  const monkeys = Number(get('sdwg-monkeys')) || 0;
  const key = `${dist}|${speed}|${monkeys}`;
  if (get(K_SENT) === key || (!dist && !speed && !monkeys)) return;
  sending = true;
  try {
    const r = await api({ action: 'score', token: token(), dist, speed, monkeys });
    if (r.ok) set(K_SENT, key);
    else if (r.error === 'noplayer') set(K_NAME, ''); // запись на сервере пропала — попросим ник заново
  } catch { /* нет сети — в следующий раз */ }
  sending = false;
}

// ---------- экран «ник» ----------
const nick = $('nick'), input = $('nick-input'), err = $('nick-err'), ok = $('nick-ok');
let afterNick = null;

export function openNick(then) {
  afterNick = then || null;
  input.value = playerName();
  err.textContent = '';
  $('nick-skip').textContent = playerName() ? 'Отмена' : 'Позже';
  nick.classList.add('show');
}
function closeNick() {
  nick.classList.remove('show');
  input.blur();
  const f = afterNick; afterNick = null;
  if (f) f();
}

async function saveNick() {
  const name = input.value.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 16 || !/^[\p{L}\p{N} _.\-]+$/u.test(name)) {
    err.textContent = 'От 2 до 16 символов: буквы, цифры, пробел, _ . -';
    return;
  }
  if (name === playerName()) { closeNick(); return; }
  ok.disabled = true;
  err.textContent = '';
  try {
    const r = await api({ action: 'register', token: token(), name });
    if (r.ok) {
      set(K_NAME, r.name);
      set(K_SENT, ''); // новый игрок на сервере — отправим рекорды заново
      closeNick();
      submitBest();
      if (lb.classList.contains('show')) loadBoard();
    } else if (r.error === 'taken') {
      err.textContent = r.name && r.name !== name ? `Слишком похоже на занятый ник «${r.name}» — придумай другой`
        : 'Этот ник уже занят — придумай другой';
    } else if (r.error === 'nodb') {
      err.textContent = 'Таблица рекордов пока не подключена';
    } else {
      err.textContent = 'Такой ник не подходит — только буквы, цифры, пробел, _ . -';
    }
  } catch {
    err.textContent = 'Нет связи с сервером — попробуй позже';
  }
  ok.disabled = false;
}

ok.addEventListener('click', (e) => { e.stopPropagation(); saveNick(); });
input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') saveNick(); });
$('nick-skip').addEventListener('click', (e) => { e.stopPropagation(); closeNick(); });

// первый запуск без ника: спросить один раз за запуск, после окна установки и до старта забега
if (!playerName() && !params.has('auto') && params.get('nick') !== '0') {
  const tryAsk = () => {
    if ($('hud').classList.contains('show') || sget(K_ASKED)) return; // забег уже идёт
    if ($('install').classList.contains('show')) { setTimeout(tryAsk, 400); return; }
    sset(K_ASKED, '1');
    openNick();
  };
  setTimeout(tryAsk, 700);
} else {
  setTimeout(submitBest, 1500);
}

// ---------- экран «Рекорды» ----------
const lb = $('lb'), list = $('lb-list'), meEl = $('lb-me');
let by = 'dist', back = null, reqN = 0;

function row(place, name, value, mine) {
  const r = document.createElement('div');
  r.className = 'lb-row' + (mine ? ' me' : '');
  const p = document.createElement('span'); p.className = 'lb-place'; p.textContent = place;
  const n = document.createElement('span'); n.className = 'lb-name'; n.textContent = name;
  const v = document.createElement('span'); v.className = 'lb-val'; v.textContent = value;
  if (by === 'monkeys') v.classList.add('monk');
  r.append(p, n, v);
  return r;
}
const fmt = (x) => (by === 'speed' ? `${x.speed} км/ч` : by === 'monkeys' ? `${x.monkeys}` : `${x.dist} м`);
function note(text) {
  list.textContent = '';
  const d = document.createElement('div');
  d.className = 'lb-note';
  d.textContent = text;
  list.append(d);
}

function renderMe() {
  meEl.textContent = '';
  const name = playerName();
  const b = document.createElement('button');
  b.className = 'ghost small';
  if (name) {
    const s = document.createElement('span');
    s.textContent = `Ты — ${name}`;
    b.textContent = 'Сменить ник';
    meEl.append(s, b);
  } else {
    b.textContent = 'Записать ник';
    b.classList.add('red');
    const s = document.createElement('span');
    s.textContent = 'Без ника твои рекорды не попадут в таблицу';
    meEl.append(s, b);
  }
  b.addEventListener('click', (e) => { e.stopPropagation(); openNick(); });
}

async function loadBoard() {
  renderMe();
  for (const t of document.querySelectorAll('#lb .tabs button')) t.classList.toggle('ghost', t.dataset.by !== by);
  const n = ++reqN;
  if (!list.children.length || list.querySelector('.lb-note')) note('Загрузка…');
  await submitBest();
  let data;
  try {
    const tok = get(K_TOKEN);
    data = await api(null, `?by=${by}` + (tok ? `&token=${encodeURIComponent(tok)}` : ''));
  } catch { data = null; }
  if (n !== reqN) return; // переключили вкладку, пока грузилось
  if (!data) { note('Нет связи с сервером — попробуй позже'); return; }
  if (data.error === 'nodb') { note('Таблица рекордов пока не подключена'); return; }
  if (!data.top || !data.top.length) { note('Пока пусто — стань первым!'); return; }
  list.textContent = '';
  const me = data.me && data.me.name;
  let meShown = false;
  data.top.forEach((x, i) => {
    const mine = x.name === me;
    if (mine) meShown = true;
    list.append(row(i + 1, x.name, fmt(x), mine));
  });
  if (data.me && !meShown && data.me.rank) {
    const gap = document.createElement('div'); gap.className = 'lb-gap'; gap.textContent = '···';
    list.append(gap, row(data.me.rank, data.me.name, fmt(data.me), true));
  }
  list.querySelector('.me')?.scrollIntoView({ block: 'nearest' });
}

export function openBoard(onBack) {
  back = onBack || null;
  lb.classList.add('show');
  list.scrollTop = 0;
  loadBoard();
}
function closeBoard() {
  lb.classList.remove('show');
  const f = back; back = null;
  if (f) f();
}
$('lb-close').addEventListener('click', (e) => { e.stopPropagation(); closeBoard(); });
for (const t of document.querySelectorAll('#lb .tabs button')) {
  t.addEventListener('click', (e) => { e.stopPropagation(); if (by !== t.dataset.by) { by = t.dataset.by; list.textContent = ''; loadBoard(); } });
}
for (const el of [lb, nick]) for (const ev of ['pointerdown', 'click']) el.addEventListener(ev, (e) => e.stopPropagation());
