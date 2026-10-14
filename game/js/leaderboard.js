// Аккаунт и общая таблица рекордов (сервер — functions/api/leaderboard.js).
// Аккаунт — ник + пароль: при первом запуске игра предлагает его завести, на другом устройстве —
// «Войти». Устройство хранит свой секретный токен (sdwg-lb-token) и ник (sdwg-lb-name).
// Прогресс (рекорды, обезьянки, «Мои города», настройки — ключи city-* и sdwg-*) синхронизируется
// с сервером при запуске и после каждого забега; сервер объединяет его между устройствами.

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const API = 'api/leaderboard';
const K_TOKEN = 'sdwg-lb-token', K_NAME = 'sdwg-lb-name', K_ASKED = 'sdwg-lb-asked';
const tr = (...a) => window.I18N.t(...a); // тексты интерфейса — js/i18n.js
const NAME_RULE = () => tr('errNickFormat');

const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k, v) => { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } };
const del = (k) => { try { localStorage.removeItem(k); } catch { /* приватный режим */ } };
const sget = (k) => { try { return sessionStorage.getItem(k); } catch { return null; } };
const sset = (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* приватный режим */ } };

export const playerName = () => get(K_NAME) || '';
const loggedIn = () => !!(playerName() && get(K_TOKEN));
function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

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

// ---------- прогресс ----------
const OURS = (k) => (k.startsWith('city-') || k.startsWith('sdwg-')) && !k.startsWith('sdwg-lb-');
function collect() {
  const data = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (OURS(k)) data[k] = localStorage.getItem(k);
    }
  } catch { /* приватный режим */ }
  return data;
}
function apply(data) {
  let changed = false;
  for (const [k, v] of Object.entries(data || {})) {
    if (OURS(k) && typeof v === 'string' && get(k) !== v) { set(k, v); changed = true; }
  }
  if (changed) window.dispatchEvent(new Event('sdwg-progress')); // main.js перечитает рекорды
}
function clearLocal() {
  for (const k of Object.keys(collect())) del(k);
}

// Отправить прогресс и забрать объединённый (с других устройств). Нет сети — в следующий раз.
let syncing = null;
export function syncProgress() {
  if (!loggedIn() || params.has('auto')) return Promise.resolve();
  if (!syncing) {
    syncing = (async () => {
      try {
        const r = await api({ action: 'sync', token: get(K_TOKEN), data: collect() });
        if (r.ok) {
          apply(r.data);
          if (r.name && r.name !== playerName()) set(K_NAME, r.name); // сменили ник на другом устройстве
        } else if (r.error === 'noplayer') { del(K_NAME); del(K_TOKEN); } // вход сброшен — войти заново
      } catch { /* нет сети */ }
    })().finally(() => { syncing = null; });
  }
  return syncing;
}

// ---------- экран аккаунта: новый ник / вход / настройки ----------
const acc = $('nick'), nameIn = $('nick-input'), passIn = $('nick-pass'), err = $('nick-err'), ok = $('nick-ok');
const skip = $('nick-skip'), swap = $('nick-swap');
let mode = 'new', afterAcc = null;

const TEXT = {
  new: { h: 'nickNewH', ok: 'nickNewOk', skip: 'nickNewSkip', swap: 'nickNewSwap', pass: 'passPh', why: 'nickNewWhy' },
  login: { h: 'nickLoginH', ok: 'nickLoginOk', skip: 'back', swap: 'nickLoginSwap', pass: 'passPh', why: 'nickLoginWhy' },
  edit: { h: 'nickEditH', ok: 'nickEditOk', skip: 'nickEditSkip', swap: 'nickEditSwap', pass: 'newPassPh', why: 'nickEditWhy' },
};
function setModeText() {
  const t = TEXT[mode];
  $('nick-h').textContent = tr(t.h);
  $('nick-why').innerHTML = tr(t.why);
  ok.textContent = tr(t.ok);
  skip.textContent = tr(t.skip);
  swap.textContent = tr(t.swap);
  passIn.placeholder = tr(t.pass);
  nameIn.placeholder = tr('nickPh');
}
function setMode(m) {
  mode = m;
  setModeText();
  passIn.autocomplete = m === 'login' ? 'current-password' : 'new-password';
  nameIn.value = m === 'edit' ? playerName() : (m === 'login' ? nameIn.value : '');
  passIn.value = '';
  err.textContent = '';
}
export function openAccount(then) {
  afterAcc = then || null;
  setMode(loggedIn() ? 'edit' : 'new');
  acc.classList.add('show');
}
function closeAccount() {
  acc.classList.remove('show');
  nameIn.blur(); passIn.blur();
  const f = afterAcc; afterAcc = null;
  if (f) f();
  if (lb.classList.contains('show')) loadBoard();
}

function cleanName(v) { return v.normalize('NFKC').replace(/\s+/g, ' ').trim(); }
function nameOk(name) { return name.length >= 2 && name.length <= 16 && /^[\p{L}\p{N} _.\-]+$/u.test(name); }
function serverError(r, name) {
  if (r.error === 'taken') {
    return r.name && r.name !== name ? tr('errSimilar', r.name) : tr('errTaken');
  }
  if (r.error === 'weak') return tr('errWeak');
  if (r.error === 'wrong') return r.left > 0 && r.left <= 3 ? tr('errWrongLeft', r.left) : tr('errWrong');
  if (r.error === 'locked') return tr('errLocked', Math.ceil(r.wait / 60));
  if (r.error === 'nodb') return tr('errNoDb');
  return NAME_RULE();
}

async function submit() {
  const name = cleanName(nameIn.value), pass = passIn.value;
  if (!nameOk(name)) { err.textContent = NAME_RULE(); return; }
  if ((mode !== 'edit' || pass) && (pass.length < 4 || pass.length > 64)) { err.textContent = tr('errWeak'); return; }
  if (mode === 'edit' && name === playerName() && !pass) { closeAccount(); return; }
  ok.disabled = true;
  err.textContent = '';
  try {
    if (mode === 'login') await login(name, pass);
    else {
      const tok = mode === 'edit' ? get(K_TOKEN) : newToken();
      const r = await api({ action: 'register', token: tok, name, password: pass || undefined });
      if (r.ok) {
        set(K_TOKEN, tok);
        set(K_NAME, r.name);
        closeAccount();
        syncProgress(); // прогресс этого устройства — в новый аккаунт
      } else err.textContent = serverError(r, name);
    }
  } catch {
    err.textContent = tr('errNet');
  }
  ok.disabled = false;
}

async function login(name, pass) {
  // на устройстве уже другой аккаунт — его прогресс не смешиваем с чужим
  const other = loggedIn() && playerName().toLowerCase() !== name.toLowerCase();
  if (other && !confirm(tr('confirmSwitch', playerName(), name))) return;
  const r = await api({ action: 'login', name, password: pass });
  if (!r.ok) { err.textContent = serverError(r, name); return; }
  if (other) clearLocal();
  set(K_TOKEN, r.token);
  set(K_NAME, r.name);
  apply(r.data);
  await syncProgress(); // гость: его прогресс объединится с аккаунтом
  location.reload(); // настройки, рекорды, города — всё заново из хранилища
}

async function logout() {
  if (!confirm(tr('confirmLogout'))) return;
  await syncProgress();
  try { await api({ action: 'logout', token: get(K_TOKEN) }); } catch { /* нет сети — токен просто забудем */ }
  clearLocal();
  del(K_TOKEN); del(K_NAME);
  location.reload();
}

ok.addEventListener('click', (e) => { e.stopPropagation(); submit(); });
for (const el of [nameIn, passIn]) {
  el.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key !== 'Enter') return;
    if (el === nameIn) passIn.focus(); else submit();
  });
}
skip.addEventListener('click', (e) => {
  e.stopPropagation();
  if (mode === 'login' && !loggedIn()) setMode('new'); else closeAccount();
});
swap.addEventListener('click', (e) => {
  e.stopPropagation();
  if (mode === 'edit') logout(); else setMode(mode === 'login' ? 'new' : 'login');
});

// первый запуск без аккаунта: спросить один раз за запуск, после окна установки и до старта забега
if (!loggedIn() && !params.has('auto') && params.get('nick') !== '0') {
  const tryAsk = () => {
    if ($('hud').classList.contains('show') || sget(K_ASKED)) return; // забег уже идёт
    if ($('install').classList.contains('show')) { setTimeout(tryAsk, 400); return; }
    sset(K_ASKED, '1');
    openAccount();
  };
  setTimeout(tryAsk, 700);
} else {
  setTimeout(syncProgress, 1500);
}

// ---------- экран «Рекорды»: таблица, сортировка — по заголовку колонки ----------
const lb = $('lb'), body = $('lb-body'), meEl = $('lb-me'), noteEl = $('lb-note');
let by = 'score', back = null, reqN = 0;

function cell(text, cls) {
  const td = document.createElement('td');
  td.textContent = text;
  if (cls) td.className = cls;
  return td;
}
function row(place, x, mine) {
  const tr = document.createElement('tr');
  if (mine) tr.className = 'me';
  tr.append(cell(place ?? '—', 'place'), cell(x.name, 'name'), cell(x.score || 0, 'num'), cell(x.dist, 'num'), cell(x.speed, 'num'), cell(x.monkeys || 0, 'num'));
  tr.children[{ score: 2, dist: 3, speed: 4, monkeys: 5 }[by]].classList.add('on');
  return tr;
}
function note(text) {
  body.textContent = '';
  noteEl.textContent = text;
  noteEl.style.display = text ? '' : 'none';
}

function renderMe() {
  meEl.textContent = '';
  const b = document.createElement('button');
  b.className = 'ghost small';
  const s = document.createElement('span');
  if (loggedIn()) {
    s.textContent = tr('youAre', playerName());
    b.textContent = tr('account');
  } else {
    s.textContent = tr('noAccount');
    b.textContent = tr('loginOrNick');
    b.classList.add('red');
  }
  meEl.append(s, b);
  b.addEventListener('click', (e) => { e.stopPropagation(); openAccount(); });
}

async function loadBoard() {
  renderMe();
  for (const th of document.querySelectorAll('#lb th[data-by]')) th.classList.toggle('on', th.dataset.by === by);
  const n = ++reqN;
  if (!body.children.length) note(tr('loading'));
  await syncProgress();
  let data;
  try {
    const tok = loggedIn() ? get(K_TOKEN) : '';
    data = await api(null, `?by=${by}` + (tok ? `&token=${encodeURIComponent(tok)}` : ''));
  } catch { data = null; }
  if (n !== reqN) return; // сменили сортировку, пока грузилось
  renderMe();
  if (!data) { note(tr('errNet')); return; }
  if (data.error === 'nodb') { note(tr('lbOff')); return; }
  if (!data.top || !data.top.length) { note(tr('lbEmpty')); return; }
  note('');
  const me = data.me && data.me.name;
  let meShown = false;
  data.top.forEach((x, i) => {
    const mine = x.name === me;
    if (mine) meShown = true;
    body.append(row(i + 1, x, mine));
  });
  if (data.me && !meShown) {
    const gap = document.createElement('tr');
    gap.className = 'gap';
    gap.append(cell('···'), cell(''), cell(''), cell(''), cell(''), cell(''));
    body.append(gap, row(data.me.rank, data.me, true));
  }
  // своя строка — посередине списка (не под шапкой)
  const meRow = body.querySelector('.me'), sc = $('lb-scroll');
  sc.scrollTop = meRow ? meRow.offsetTop - (sc.clientHeight - meRow.offsetHeight) / 2 : 0;
}

export function openBoard(onBack) {
  back = onBack || null;
  lb.classList.add('show');
  $('lb-scroll').scrollTop = 0;
  loadBoard();
}
function closeBoard() {
  lb.classList.remove('show');
  const f = back; back = null;
  if (f) f();
}
$('lb-close').addEventListener('click', (e) => { e.stopPropagation(); closeBoard(); });
for (const th of document.querySelectorAll('#lb th[data-by]')) {
  th.addEventListener('click', (e) => { e.stopPropagation(); if (by !== th.dataset.by) { by = th.dataset.by; loadBoard(); } });
}
for (const el of [lb, acc]) for (const ev of ['pointerdown', 'click']) el.addEventListener(ev, (e) => e.stopPropagation());

// сменили язык — перерисовать открытые окна
window.addEventListener('sdwg-lang', () => {
  setModeText();
  if (lb.classList.contains('show')) loadBoard();
});
