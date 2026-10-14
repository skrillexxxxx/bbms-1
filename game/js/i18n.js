// Языки интерфейса: английский (по умолчанию) и русский. Обычный скрипт, не модуль: нужен ещё экрану
// запуска (окно установки), до загрузки игры. Тексты в разметке — с атрибутами:
// data-t — текст, data-th — HTML, data-tp — placeholder, data-ta — aria-label, data-tt — title.
// В коде — I18N.t('ключ', …аргументы). Смена языка — сразу, без перезагрузки: событие sdwg-lang.
(function () {
  var EN = {
    // меню
    tapToRun: 'Tap to run', installApp: 'Install app', records: 'Records', myCities: 'My seeds', howTo: 'How to play',
    saveProgress: 'Save progress', loadProgress: 'Load', graphics: 'Graphics', sound: 'Sound', langBtn: 'Русский',
    back: 'Back', newCity: 'New city', sameSeed: 'Same seed', saveSeed: 'Save seed', seedSaved: 'Saved ✓',
    mainMenu: 'Main menu', sendRun: 'Send run log', runReady: 'Log ready ✓', paused: 'Paused', resume: 'Resume',
    restart: 'Restart', gotIt: 'Got it', reset: 'Reset', pause: 'Pause',
    flag: 'Mark: something is wrong here', rotate: 'Turn your phone sideways', soundHint: 'Turn on sound',
    // графика и звук
    on: 'on', off: 'off',
    shadowsBtn: function (on) { return 'Flashlight shadows: ' + (on ? 'on' : 'off'); },
    sunBtn: function (on) { return 'Sun shadows: ' + (on ? 'on' : 'off'); },
    ps1Btn: function (on) { return 'PS1: ' + (on ? 'on' : 'off'); },
    aeBtn: function (on) { return 'Auto exposure: ' + (on ? 'on' : 'off'); },
    gSun: 'Sun', gColor: 'Color', gAE: 'Auto exposure', gFx: 'Effects',
    gAz: 'Direction', gEl: 'Elevation', gLit: 'Sun brightness', gShade: 'Shadow depth',
    gExp: 'Exposure', gCon: 'Contrast', gTemp: 'Temperature', gSunCol: 'Sun color', gShadeCol: 'Shadow color',
    gAeStr: 'Strength', gAeTgt: 'Target brightness', gAeSpd: 'Adaptation speed',
    gBlur: 'Motion blur', gGrain: 'Grain', gCa: 'Chrom. aberration',
    warmer: 'warmer', cooler: 'cooler',
    sMusic: 'Music', sGame: 'Game sounds',
    // инструкция
    helpH: 'How to play',
    help1: '<b>Swipe left / right</b> — change lane',
    help2: '<b>Swipe up or tap</b> — jump',
    help3: '<b>Swipe down</b> — slide (under bridges and pipes)',
    help4: '<b>Swipe into a red wall</b> — wall run, <b>swipe away from it</b> — jump to the opposite wall',
    help5: 'Don’t crash into buildings',
    replayTut: 'Replay tutorial',
    // рекорды и аккаунт
    recordsDay: 'Today’s records', resetIn: function (h, m) { return 'reset to zero in ' + h + ' h ' + m + ' min'; },
    player: 'Player', points: 'Points', meters: 'Meters', kmh: 'km/h', monkeys: 'Monkeys',
    nickPh: 'Nickname', passPh: 'Password', newPassPh: 'New password',
    nickNewH: 'What’s your name?', nickNewOk: 'Done', nickNewSkip: 'Later', nickNewSwap: 'Already have an account? Log in',
    nickNewWhy: 'Nickname and password are your account: your records go to the shared table, your progress is saved, and you can log in from any device.',
    nickLoginH: 'Log in', nickLoginOk: 'Log in', nickLoginSwap: 'New player? Pick a nickname',
    nickLoginWhy: 'Enter your nickname and password — your progress will load from the server.',
    nickEditH: 'Account', nickEditOk: 'Save', nickEditSkip: 'Cancel', nickEditSwap: 'Log out',
    nickEditWhy: 'Change your nickname or password here (leave the password empty to keep it).',
    errNickFormat: 'Nickname: 2 to 16 characters — letters, digits, space, _ . -',
    errSimilar: function (n) { return 'Too similar to the taken nickname “' + n + '” — pick another'; },
    errTaken: 'This nickname is taken — pick another',
    errWeak: 'Password: 4 to 64 characters',
    errWrongLeft: function (n) { return 'Wrong nickname or password (attempts left: ' + n + ')'; },
    errWrong: 'Wrong nickname or password',
    errLocked: function (m) { return 'Too many attempts — try again in ' + m + ' min'; },
    errNoDb: 'The records server isn’t connected yet',
    errNet: 'No connection to the server — try later',
    confirmSwitch: function (a, b) { return 'This device is logged in as “' + a + '”. Its progress will be replaced with “' + b + '”’s. Continue?'; },
    confirmLogout: 'Log out? Your progress is saved on the server and will be erased from this device.',
    youAre: function (n) { return 'You are ' + n; }, account: 'Account',
    noAccount: 'Without an account your records won’t make it into the table', loginOrNick: 'Log in or pick a nickname',
    loading: 'Loading…', lbOff: 'The records table isn’t connected yet', lbEmpty: 'Nothing here yet — be the first!',
    // установка
    installH: 'Add the game to your Home Screen',
    installWhy: 'It will open full screen, without browser bars,<br>and swipes won’t drag the page.',
    iosStep1: 'Tap “Share” in Safari<small>in newer iOS: the ••• button → “Share”</small>',
    iosStep2: 'Choose “Add to Home Screen”<small>if you don’t see it, scroll the list down</small>',
    iosStep3: 'Tap “Add” and launch from the SDWG icon',
    andStep1: 'Open the browser menu', andStep2: '“Install app” or “Add to Home screen”', andStep3: 'Launch from the SDWG icon',
    installNote: 'Browser and app progress are stored separately — move it with<br>“Save progress” and “Load” in the main menu.',
    install: 'Install', playInBrowser: 'Play in browser',
    // мои города
    cityName: function (s) { return 'Seed ' + s; }, citiesEmpty: 'Nothing yet. You can save a seed after a run.',
    cityMeta: function (s, b) { return 'seed ' + s + ' · best ' + b + ' m'; },
    play: 'Play', rename: 'Rename', cityNamePrompt: 'Seed name', del: 'Delete',
    delConfirm: function (n) { return 'Delete “' + n + '”?'; },
    // забег
    m: 'm', row: 'row',
    bestLine: function (sc, m) { return 'today’s best: points ' + sc + ' · meters ' + m; },
    runLine: function (m, x, t) { return 'points · ' + m + ' m · max <b>×' + x + '</b> · longest flow ' + t + ' s'; },
    tipStumble: 'Dropping from a height? Swipe down before you land — you hit the ground in a slide and the height turns into speed. Land on your feet and you stumble.',
    tipPump: 'Fast swipes down while sliding speed you up — with no limit. The faster you slide, the faster the multiplier grows.',
    tipFlow: 'The multiplier grows while you slide or run on walls. More than 3 seconds on your feet and it drops back to ×1.',
    monkLine: function (a, b) { return ' · monkeys ' + a + ' (today ' + b + ')'; },
    speedLine: function (a, b) { return 'max speed ' + a + ' km/h · today’s best ' + b + ' km/h'; },
    newRec: ' — new!',
    // файл прогресса
    saveTitle: 'SDWG GAME — save', errRead: 'Couldn’t read the progress (private mode?)',
    errNotSave: 'This is not an SDWG GAME save file', errWrite: 'Couldn’t write the progress (private mode?)',
    confirmLoad: function (when, best) { return 'Load the save from ' + when + ' (best ' + best + ' m)?\nThe current progress on this device will be replaced.'; },
    // обучение
    tJump: 'Jump', tJumpT: 'swipe up', tJumpK: '↑ or Space',
    tSlide: 'Slide', tSlideT: 'swipe down', tSlideK: '↓',
    tPump: 'Speed up', tPumpT: 'swipe down fast — two fingers in turn', tPumpK: 'press ↓ rapidly',
    tWallJump: 'Jump', tWall: 'Wall run', tWallT: 'swipe %s — into the red wall', tWallK: '%k — into the red wall',
    tKick: 'To the opposite wall', tKickT: 'swipe %s — away from the wall', tKickK: '%k — away from the wall',
    tUnder: 'Run along the wall', tUnderT: 'swipe %s — over the gap', tUnderK: '%k — over the gap',
    tLand: 'Land in a slide', tLandT: 'swipe down — before the ground', tLandK: '↓ — before the ground',
    tDone: 'Done! You’re on your own now', left: 'left', right: 'right',
    tCardH: 'That’s a speed boost',
    tCardTouch: 'Fast swipes down while sliding speed you up. The faster you swipe, the faster you go — no limit. Stop and the speed slowly fades.<br>Fastest of all — two fingers in turn.',
    tCardKey: 'Rapid ↓ presses while sliding speed you up. The faster you press, the faster you go — no limit. Stop and the speed slowly fades.',
  };
  var RU = {
    tapToRun: 'Тапни, чтобы бежать', installApp: 'Установить приложение', records: 'Рекорды', myCities: 'Мои сиды', howTo: 'Инструкция',
    saveProgress: 'Сохранить прогресс', loadProgress: 'Загрузить', graphics: 'Графика', sound: 'Звук', langBtn: 'English',
    back: 'Назад', newCity: 'Новый город', sameSeed: 'Этот же сид', saveSeed: 'Сохранить сид', seedSaved: 'Сохранён ✓',
    mainMenu: 'Главное меню', sendRun: 'Отправить запись', runReady: 'Запись готова ✓', paused: 'Пауза', resume: 'Продолжить',
    restart: 'Заново', gotIt: 'Понятно', reset: 'Сбросить', pause: 'Пауза',
    flag: 'Метка: тут что-то не так', rotate: 'Поверни телефон горизонтально', soundHint: 'Включи звук',
    on: 'вкл', off: 'выкл',
    shadowsBtn: function (on) { return 'Тени фонаря: ' + (on ? 'вкл' : 'выкл'); },
    sunBtn: function (on) { return 'Тени солнца: ' + (on ? 'вкл' : 'выкл'); },
    ps1Btn: function (on) { return 'PS1: ' + (on ? 'вкл' : 'выкл'); },
    aeBtn: function (on) { return 'Автоэкспозиция: ' + (on ? 'вкл' : 'выкл'); },
    gSun: 'Солнце', gColor: 'Цвет', gAE: 'Автоэкспозиция', gFx: 'Эффекты',
    gAz: 'Направление', gEl: 'Высота', gLit: 'Яркость солнца', gShade: 'Затенение (сила тени)',
    gExp: 'Экспозиция', gCon: 'Контраст', gTemp: 'Температура', gSunCol: 'Цвет солнца', gShadeCol: 'Цвет тени',
    gAeStr: 'Сила', gAeTgt: 'Целевая яркость', gAeSpd: 'Скорость привыкания',
    gBlur: 'Motion blur', gGrain: 'Шум', gCa: 'Хром. аберрация',
    warmer: 'теплее', cooler: 'холоднее',
    sMusic: 'Музыка', sGame: 'Игровые звуки',
    helpH: 'Как играть',
    help1: '<b>Свайп влево-вправо</b> — сменить полосу',
    help2: '<b>Свайп вверх или тап</b> — прыжок',
    help3: '<b>Свайп вниз</b> — подкат (под мостами и трубами)',
    help4: '<b>Свайп в красную стену</b> — бег по стене, <b>свайп от неё</b> — прыжок на стену напротив',
    help5: 'Не врезайся в здания',
    replayTut: 'Пройти обучение',
    recordsDay: 'Рекорды дня', resetIn: function (h, m) { return 'обнулятся через ' + h + ' ч ' + m + ' мин'; },
    player: 'Игрок', points: 'Очки', meters: 'Метры', kmh: 'км/ч', monkeys: 'Обезьянки',
    nickPh: 'Ник', passPh: 'Пароль', newPassPh: 'Новый пароль',
    nickNewH: 'Как тебя зовут?', nickNewOk: 'Готово', nickNewSkip: 'Позже', nickNewSwap: 'Уже есть аккаунт? Войти',
    nickNewWhy: 'Ник и пароль — твой аккаунт: рекорды попадут в общую таблицу,<br>прогресс сохранится, а войти можно с любого устройства.',
    nickLoginH: 'Вход', nickLoginOk: 'Войти', nickLoginSwap: 'Новый игрок? Завести ник',
    nickLoginWhy: 'Введи свой ник и пароль — прогресс подтянется с сервера.',
    nickEditH: 'Аккаунт', nickEditOk: 'Сохранить', nickEditSkip: 'Отмена', nickEditSwap: 'Выйти из аккаунта',
    nickEditWhy: 'Здесь можно сменить ник или пароль (пустой пароль — оставить старый).',
    errNickFormat: 'Ник: от 2 до 16 символов — буквы, цифры, пробел, _ . -',
    errSimilar: function (n) { return 'Слишком похоже на занятый ник «' + n + '» — придумай другой'; },
    errTaken: 'Этот ник уже занят — придумай другой',
    errWeak: 'Пароль — от 4 до 64 символов',
    errWrongLeft: function (n) { return 'Неверный ник или пароль (осталось попыток: ' + n + ')'; },
    errWrong: 'Неверный ник или пароль',
    errLocked: function (m) { return 'Слишком много попыток — попробуй через ' + m + ' мин'; },
    errNoDb: 'Сервер рекордов пока не подключён',
    errNet: 'Нет связи с сервером — попробуй позже',
    confirmSwitch: function (a, b) { return 'Сейчас здесь аккаунт «' + a + '». Прогресс этого устройства заменится прогрессом «' + b + '». Продолжить?'; },
    confirmLogout: 'Выйти из аккаунта? Прогресс сохранён на сервере, а с этого устройства сотрётся.',
    youAre: function (n) { return 'Ты — ' + n; }, account: 'Аккаунт',
    noAccount: 'Без аккаунта твои рекорды не попадут в таблицу', loginOrNick: 'Войти или завести ник',
    loading: 'Загрузка…', lbOff: 'Таблица рекордов пока не подключена', lbEmpty: 'Пока пусто — стань первым!',
    installH: 'Установи игру на экран «Домой»',
    installWhy: 'Так она откроется на весь экран, без панелей браузера,<br>и свайпы не будут дёргать страницу.',
    iosStep1: 'Нажми «Поделиться» в Safari<small>в новых iOS: кнопка ••• → «Поделиться»</small>',
    iosStep2: 'Выбери «На экран „Домой“»<small>если не видно — пролистай список вниз</small>',
    iosStep3: 'Нажми «Добавить» и запускай с иконки SDWG',
    andStep1: 'Открой меню браузера', andStep2: '«Установить приложение» или «Добавить на главный экран»', andStep3: 'Запускай с иконки SDWG',
    installNote: 'Прогресс браузера и приложения хранится отдельно — перенеси его кнопками<br>«Сохранить прогресс» и «Загрузить» в главном меню.',
    install: 'Установить', playInBrowser: 'Играть в браузере',
    cityName: function (s) { return 'Сид ' + s; }, citiesEmpty: 'Пока пусто. Сохранить сид можно после забега.',
    cityMeta: function (s, b) { return 'seed ' + s + ' · рекорд ' + b + ' м'; },
    play: 'Играть', rename: 'Переименовать', cityNamePrompt: 'Название сида', del: 'Удалить',
    delConfirm: function (n) { return 'Удалить «' + n + '»?'; },
    m: 'м', row: 'ряд',
    bestLine: function (sc, m) { return 'рекорд дня: очки ' + sc + ' · метры ' + m; },
    runLine: function (m, x, t) { return 'очки · ' + m + ' м · макс. <b>×' + x + '</b> · самый долгий поток ' + t + ' с'; },
    tipStumble: 'С высоты — свайп вниз перед землёй: приземлишься в подкат, и высота превратится в скорость. На ноги — споткнёшься.',
    tipPump: 'Быстрые свайпы вниз в подкате разгоняют — без предела. Чем быстрее скользишь, тем быстрее растёт множитель.',
    tipFlow: 'Множитель растёт, пока ты в подкате или на стене. Больше 3 секунд на ногах — он сбрасывается до ×1.',
    monkLine: function (a, b) { return ' · обезьянки ' + a + ' (сегодня ' + b + ')'; },
    speedLine: function (a, b) { return 'макс. скорость ' + a + ' км/ч · рекорд дня ' + b + ' км/ч'; },
    newRec: ' — новый!',
    saveTitle: 'SDWG GAME — сохранение', errRead: 'Не получилось прочитать прогресс (приватный режим?)',
    errNotSave: 'Это не файл сохранения SDWG GAME', errWrite: 'Не получилось записать прогресс (приватный режим?)',
    confirmLoad: function (when, best) { return 'Загрузить сохранение от ' + when + ' (рекорд ' + best + ' м)?\nТекущий прогресс на этом устройстве заменится.'; },
    tJump: 'Прыжок', tJumpT: 'свайп вверх', tJumpK: '↑ или пробел',
    tSlide: 'Подкат', tSlideT: 'свайп вниз', tSlideK: '↓',
    tPump: 'Разгон', tPumpT: 'быстро свайпай вниз — двумя пальцами по очереди', tPumpK: 'часто жми ↓',
    tWallJump: 'Прыгай', tWall: 'Бег по стене', tWallT: 'свайп %s — к красной стене', tWallK: '%k — к красной стене',
    tKick: 'На стену напротив', tKickT: 'свайп %s — от стены', tKickK: '%k — от стены',
    tUnder: 'Беги по стене', tUnderT: 'свайп %s — над провалом', tUnderK: '%k — над провалом',
    tLand: 'Приземлись в подкат', tLandT: 'свайп вниз — перед землёй', tLandK: '↓ — перед землёй',
    tDone: 'Готово! Дальше — сам', left: 'влево', right: 'вправо',
    tCardH: 'Это разгон',
    tCardTouch: 'Быстрые свайпы вниз в подкате разгоняют. Чем чаще — тем быстрее, предела нет. Перестанешь — скорость понемногу спадёт.<br>Быстрее всего — двумя пальцами по очереди.',
    tCardKey: 'Частые нажатия ↓ в подкате разгоняют. Чем чаще — тем быстрее, предела нет. Перестанешь — скорость понемногу спадёт.',
  };
  var lang = 'en';
  try { if (localStorage.getItem('sdwg-lang') === 'ru') lang = 'ru'; } catch (e) { /* приватный режим */ }

  function t(key) {
    var v = (lang === 'ru' ? RU : EN)[key];
    if (v === undefined) v = EN[key];
    if (v === undefined) return key;
    return typeof v === 'function' ? v.apply(null, Array.prototype.slice.call(arguments, 1)) : v;
  }
  function each(attr, fn) { var els = document.querySelectorAll('[' + attr + ']'); for (var i = 0; i < els.length; i++) fn(els[i], els[i].getAttribute(attr)); }
  function apply() {
    document.documentElement.lang = lang;
    each('data-t', function (el, k) { el.textContent = t(k); });
    each('data-th', function (el, k) { el.innerHTML = t(k); });
    each('data-tp', function (el, k) { el.placeholder = t(k); });
    each('data-ta', function (el, k) { el.setAttribute('aria-label', t(k)); });
    each('data-tt', function (el, k) { el.title = t(k); });
  }
  function set(l) {
    lang = l === 'ru' ? 'ru' : 'en';
    try { localStorage.setItem('sdwg-lang', lang); } catch (e) { /* приватный режим */ }
    apply();
    window.dispatchEvent(new Event('sdwg-lang'));
  }
  window.I18N = { t: t, apply: apply, set: set, get lang() { return lang; }, locale: function () { return lang === 'ru' ? 'ru-RU' : 'en-GB'; } };
  apply();
})();
