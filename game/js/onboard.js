// Первый запуск и «служебное»: подсказка установить игру на экран «Домой»,
// значок «поверни телефон» (CSS, см. #rotate в index.html), сохранение и загрузка прогресса файлом.

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const standalone = navigator.standalone === true
  || matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches;
const mobile = matchMedia('(pointer: coarse)').matches;
const ios = /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// ---------- установка как веб-приложение ----------
// В браузере на телефоне показываем при каждом запуске (до установки): без панелей Safari
// игра на весь экран, а свайпы не дёргают страницу. «Понятно» скрывает до следующего запуска.
let installEvt = null; // Android/Chrome: системное окно установки
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; showAndroidButton(); });

function showAndroidButton() {
  const b = $('install-native');
  if (b) b.style.display = installEvt ? '' : 'none';
}

function openInstall() {
  $('install-ios').style.display = ios ? '' : 'none';
  $('install-other').style.display = ios ? 'none' : '';
  showAndroidButton();
  $('install').classList.add('show');
}
function closeInstall() {
  $('install').classList.remove('show');
  try { sessionStorage.setItem('sdwg-install-seen', '1'); } catch { /* приватный режим */ }
}

const needInstall = params.get('install') === '1' || (mobile && !standalone);
if (needInstall) {
  $('install-open').style.display = '';
  let seen = false;
  try { seen = sessionStorage.getItem('sdwg-install-seen') === '1'; } catch { /* приватный режим */ }
  if (!seen) setTimeout(openInstall, 500);
}
$('install-open').addEventListener('click', (e) => { e.stopPropagation(); openInstall(); });
$('install-ok').addEventListener('click', (e) => { e.stopPropagation(); closeInstall(); });
$('install-native').addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!installEvt) return;
  installEvt.prompt();
  try { await installEvt.userChoice; } catch { /* отменили */ }
  installEvt = null;
  closeInstall();
});
for (const ev of ['pointerdown', 'click']) $('install').addEventListener(ev, (e) => e.stopPropagation());

// ---------- сохранение и загрузка прогресса ----------
// Всё, что игра хранит (рекорды, обезьянки, мои города, настройки), — ключи city-* и sdwg-*.
// Удалили иконку с экрана «Домой» — пропало и хранилище; а у Safari и у приложения оно вообще разное.
// Поэтому — файл: сохранить в «Файлы» и загрузить обратно.
const OURS = (k) => k.startsWith('city-') || k.startsWith('sdwg-');

function collect() {
  const data = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (OURS(k)) data[k] = localStorage.getItem(k);
  }
  return data;
}

async function exportProgress() {
  let data;
  try { data = collect(); } catch { alert('Не получилось прочитать прогресс (приватный режим?)'); return; }
  const now = new Date();
  const name = `sdwg-save-${now.toISOString().slice(0, 10)}.json`;
  const text = JSON.stringify({ app: 'sdwg', v: 1, at: now.toISOString(), data }, null, 1);
  const file = new File([text], name, { type: 'application/json' });
  // на iPhone — системное «Поделиться»: там «Сохранить в Файлы», AirDrop, мессенджеры
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'SDWG GAME — сохранение' }); return; } catch (err) {
      if (err && err.name === 'AbortError') return; // закрыли окно — ничего не делаем
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function importProgress(file) {
  let save;
  try { save = JSON.parse(await file.text()); } catch { save = null; }
  if (!save || save.app !== 'sdwg' || !save.data || typeof save.data !== 'object') {
    alert('Это не файл сохранения SDWG GAME');
    return;
  }
  const keys = Object.keys(save.data).filter(OURS);
  const best = Number(save.data['city-best']) || 0;
  const when = save.at ? new Date(save.at).toLocaleString('ru-RU') : '?';
  if (!confirm(`Загрузить сохранение от ${when} (рекорд ${best} м)?\nТекущий прогресс на этом устройстве заменится.`)) return;
  try {
    for (const k of Object.keys(collect())) localStorage.removeItem(k);
    for (const k of keys) localStorage.setItem(k, String(save.data[k]));
  } catch { alert('Не получилось записать прогресс (приватный режим?)'); return; }
  location.reload();
}

$('save-progress').addEventListener('click', (e) => { e.stopPropagation(); exportProgress(); });
$('load-progress').addEventListener('click', (e) => { e.stopPropagation(); $('load-file').click(); });
$('load-file').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (f) importProgress(f);
});

// ---------- инструкция «как играть» (кнопка в главном меню) ----------
$('help-open').addEventListener('click', (e) => { e.stopPropagation(); $('help').classList.add('show'); });
$('help-ok').addEventListener('click', (e) => { e.stopPropagation(); $('help').classList.remove('show'); });
for (const ev of ['pointerdown', 'click']) $('help').addEventListener(ev, (e) => e.stopPropagation());

// ---------- «включи звук» ----------
// На iPhone переключатель «Звонок/Бесшумно» (или кнопка действия) глушит звук страницы.
// Узнать его положение нельзя — при запуске показываем подсказку со стрелкой туда, где он:
// левый бок у верхнего края; телефон повёрнут — на нижнем или верхнем крае экрана.
function soundSide() {
  if (innerHeight >= innerWidth) return 'left';
  const a = screen.orientation && typeof screen.orientation.angle === 'number' ? screen.orientation.angle
    : (typeof window.orientation === 'number' ? (window.orientation + 360) % 360 : 90);
  return a === 270 ? 'top' : 'bottom'; // повернули по часовой — бок сверху, против — снизу
}
function placeSoundHint() { $('soundhint').dataset.side = soundSide(); }
const wantSoundHint = params.get('soundhint') === '1'
  || (ios && mobile && params.get('sound') !== '0' && !params.has('auto'));
if (wantSoundHint) {
  const el = $('soundhint');
  let hideT = 0;
  const hide = () => { el.classList.remove('show'); clearTimeout(hideT); };
  const tryShow = () => {
    if ($('install').classList.contains('show')) { setTimeout(tryShow, 400); return; } // сначала — установка
    placeSoundHint();
    el.classList.add('show');
    hideT = setTimeout(hide, 9000);
    // первый тап (старт забега, кнопка меню) — убираем
    setTimeout(() => window.addEventListener('pointerdown', hide, { once: true, capture: true }), 300);
  };
  setTimeout(tryShow, 900);
  addEventListener('resize', placeSoundHint);
  if (screen.orientation) screen.orientation.addEventListener?.('change', placeSoundHint);
}
