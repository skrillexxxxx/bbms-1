// Звук: фоновая мелодия audio/ambient.mp3 крутится в лупе всё время.
// Играем её через WebAudio-буфер, а не <audio loop>: так луп без щелчка и паузы на стыке.
// iOS разрешает звук только после касания, поэтому unlock() зовём из обработчиков ввода.

const MUSIC_URL = 'audio/ambient.mp3';
const MUSIC_GAIN = 0.8;
// шаги: 10 вариантов, нарезаны из записи бега (audio/steps/stepN.mp3)
const STEP_URLS = Array.from({ length: 10 }, (_, i) => `audio/steps/step${i}.mp3`);
const STEP_GAIN = 0.55;
// подкат по полу: вход → луп, пока скользим → выход (audio/slide/*.mp3), глухо — только низ
const SLIDE_URLS = { start: 'audio/slide/start.mp3', loop: 'audio/slide/loop.mp3', end: 'audio/slide/end.mp3' };
const SLIDE_GAIN = 1.8;
// разовые звуки (audio/sfx/*.mp3). space: true — как шаги, через эхо улицы и реверб подземки;
// false — напрямую, без пространства (смерть)
const SFX = {
  softFall: { url: 'audio/sfx/soft_fall.mp3', gain: 1.4, space: true },
  hardFall: { url: 'audio/sfx/hard_fall.mp3', gain: 1.5, space: true },
  springboard: { url: 'audio/sfx/springboard.mp3', gain: 1.4, space: true },
  monkey: { url: 'audio/sfx/pick_up_monkey.mp3', gain: 1.3, space: true },
  dead: { url: 'audio/sfx/dead.mp3', gain: 0.8, space: false },
  // разочарование после смерти — фоном, тихо; один из трёх, без повтора подряд
  disap1: { url: 'audio/sfx/death_disappointment_1.mp3', gain: 0.35, space: false },
  disap2: { url: 'audio/sfx/death_disappointment_2.mp3', gain: 0.35, space: false },
  disap3: { url: 'audio/sfx/death_disappointment_3.mp3', gain: 0.35, space: false },
};
// каждые N обезьянок — «награда» вдалеке: глухо и в большом реверберации (отдельная шина far)
SFX.monkeysN = { url: 'audio/sfx/monkeys_collect.mp3', gain: 0.42, space: 'far' };
const DISAP = ['disap1', 'disap2', 'disap3'];
const DISAP_DELAY = 0.45; // с; чуть после удара
const SLIDE_LP = 600; // Гц: скольжение глухое, но слышно и на динамике телефона (ниже ~300 Гц он почти не играет)
const SLIDE_TO_LOOP = 0.45; // через сколько секунд вход перетекает в луп (дальше у входа ровный «шорох»)
// смерть: музыка уходит «под воду» — срез высоких до MUFFLE_HZ и на 3 дБ тише
const OPEN_HZ = 20000, MUFFLE_HZ = 350, MUFFLE_GAIN = 0.708; // −3 дБ
const MUFFLE_IN = 2.2, MUFFLE_OUT = 1.2; // секунды

// mp3 в начале несёт тишину от кодировщика (~50 мс) — на стыке лупа она слышна как провал.
// Ищем первый и последний «звучащий» сэмпл и крутим луп между ними.
function audibleRange(buf) {
  const th = 1e-3, n = buf.length;
  let a = n, b = 0;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    let i = 0; while (i < n && Math.abs(d[i]) < th) i++;
    let j = n - 1; while (j > i && Math.abs(d[j]) < th) j--;
    a = Math.min(a, i); b = Math.max(b, j);
  }
  if (b <= a) return [0, buf.duration];
  return [a / buf.sampleRate, (b + 1) / buf.sampleRate];
}

// ветер: от большой скорости и в падении. Файл не закольцован — склеиваем конец с началом
// плавным перекрёстным фейдом (WIND_XFADE с), дальше крутим как обычный луп
const WIND_URL = 'audio/sfx/wind.mp3';
const WIND_GAIN = 0.55, WIND_XFADE = 1.5;

export function createSound(enabled) {
  let ctx = null, master = null, lp = null, duck = null, started = false, muffled = false;
  let m = 0, lastT = 0; // m: 0 — чистый звук, 1 — «под водой»
  // файл тянем сразу, а декодируем после первого касания (раньше AudioContext на iOS не создать)
  const get = (url) => fetch(url).then((r) => r.arrayBuffer()).catch(() => null);
  const raw = enabled ? get(MUSIC_URL) : null;
  const stepRaw = enabled ? STEP_URLS.map(get) : [];
  const slideRaw = enabled ? Object.fromEntries(Object.entries(SLIDE_URLS).map(([k, u]) => [k, get(u)])) : {};
  const sfxRaw = enabled ? Object.fromEntries(Object.entries(SFX).map(([k, s]) => [k, get(s.url)])) : {};
  const sfxBuf = {};
  const windRaw = enabled ? get(WIND_URL) : null;
  let windG = null, windLP = null, windSrc = null, windK = 0;
  let slideBuf = {}, slideNow = null, slideBus = null; // slideNow: { srcs, gains } — звучащий подкат
  let steps = [], sfx = null, sfxDry = null, farBus = null, lastStep = -1, stepBus = null;
  // steps: [{ buf, a }] — a: где начинается звук (без тишины mp3)
  let revWet = null; // сколько шагов уходит в реверб (в подземке — эхо тоннеля)
  let rainG = null; // шум дождя
  let musicOut = null, gameOut = null, vol = { music: 1, game: 1 }; // громкости из меню «Звук»
  let nearLP = null, nearL = null, nearR = null, nearC = null, echoL = null, echoR = null, narrowAmt = 0; // короткое эхо от стен: слева, справа, отовсюду (узко)

  function decode(data) {
    // старый Safari знает только колбэчный вариант decodeAudioData
    return new Promise((res, rej) => ctx.decodeAudioData(data, res, rej));
  }

  async function startMusic() {
    const data = await raw;
    if (!data) return;
    const buf = await decode(data.slice(0));
    const [a, b] = audibleRange(buf);
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true; src.loopStart = a; src.loopEnd = b;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(1, ctx.currentTime + 1.5); // мягкий вход
    src.connect(g); g.connect(master);
    src.start(0, a);
  }

  async function loadSteps() {
    const out = [];
    for (const pr of stepRaw) {
      const data = await pr;
      if (!data) continue;
      try { const buf = await decode(data); out.push({ buf, a: audibleRange(buf)[0] }); } catch { /* пропускаем */ }
    }
    steps = out;
  }

  async function loadSlide() {
    for (const [k, pr] of Object.entries(slideRaw)) {
      const data = await pr;
      if (!data) continue;
      try { const buf = await decode(data); const [a, b] = audibleRange(buf); slideBuf[k] = { buf, a, b }; } catch { /* пропускаем */ }
    }
  }

  // луп ветра: первые WIND_XFADE с перекрываются хвостом (равная мощность: sin/cos), шва не слышно
  function loopBuffer(buf) {
    const [a, b] = audibleRange(buf);
    const sr = buf.sampleRate, s0 = Math.floor(a * sr), len = Math.floor(b * sr) - s0;
    const x = Math.min(Math.floor(WIND_XFADE * sr), Math.floor(len / 3)), n = len - x;
    const out = ctx.createBuffer(buf.numberOfChannels, n, sr);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const src = buf.getChannelData(ch), dst = out.getChannelData(ch);
      for (let i = 0; i < n; i++) {
        if (i < x) {
          const t = (i / x) * Math.PI / 2;
          dst[i] = src[s0 + i] * Math.sin(t) + src[s0 + n + i] * Math.cos(t);
        } else dst[i] = src[s0 + i];
      }
    }
    return out;
  }

  async function startWind() {
    const data = await windRaw;
    if (!data) return;
    const buf = loopBuffer(await decode(data));
    windSrc = ctx.createBufferSource();
    windSrc.buffer = buf; windSrc.loop = true;
    windLP = ctx.createBiquadFilter(); windLP.type = 'lowpass'; windLP.frequency.value = 900; windLP.Q.value = 0.5;
    windG = ctx.createGain(); windG.gain.value = 0;
    windSrc.connect(windLP); windLP.connect(windG); windG.connect(gameOut);
    windSrc.start();
  }

  async function loadSfx() {
    for (const [k, pr] of Object.entries(sfxRaw)) {
      const data = await pr;
      if (!data) continue;
      try { const buf = await decode(data); sfxBuf[k] = { buf, a: audibleRange(buf)[0] }; } catch { /* пропускаем */ }
    }
  }
  function playSfx(name, k = 1, delay = 0) {
    const st = sfxBuf[name];
    if (!ctx || ctx.state !== 'running' || !st) return;
    const s = SFX[name];
    // через sfx (там громкость шагов) — значит, делим на неё, чтобы gain был «как есть»
    const bus = s.space === 'far' ? farBus : s.space ? sfx : sfxDry;
    oneShot(st, s.gain * k * (s.space === true ? 1 : 1 / STEP_GAIN), ctx.currentTime + delay, bus, 0.97 + Math.random() * 0.06);
  }

  let lastDisap = -1;
  function playDisap() {
    if (!ctx || ctx.state !== 'running') return;
    let i = Math.floor(Math.random() * (DISAP.length - 1));
    if (i >= lastDisap && lastDisap >= 0) i++; // любой, кроме прошлого
    if (lastDisap < 0) i = Math.floor(Math.random() * DISAP.length);
    lastDisap = i;
    const name = DISAP[i], st = sfxBuf[name];
    if (st) oneShot(st, SFX[name].gain / STEP_GAIN, ctx.currentTime + DISAP_DELAY, sfxDry);
  }

  // щелчок кнопки фонарика — синтез, без файла: резкий «тик» (шум выше ~3 кГц), короткий корпусный стук
  // (~1.3 кГц) и через ~28 мс тише — отскок пружины. Идёт через шину шагов: эхо улицы и реверб подземки
  let clickBuf = null;
  function makeClick() {
    const sr = ctx.sampleRate, n = Math.floor(sr * 0.07), buf = ctx.createBuffer(1, n, sr), d = buf.getChannelData(0);
    let hp = 0, prev = 0;
    const hit = (t0, amp, tick, body) => {
      const i0 = Math.floor(t0 * sr);
      for (let i = i0; i < n; i++) {
        const t = (i - i0) / sr;
        const w = Math.random() * 2 - 1;
        hp = 0.6 * (hp + w - prev); prev = w; // простой срез низов — сухой «тик»
        d[i] += amp * (tick * hp * Math.exp(-t / 0.0012) + body * Math.sin(2 * Math.PI * 1300 * t) * Math.exp(-t / 0.006));
      }
    };
    hit(0, 1, 0.9, 0.55);
    hit(0.028, 0.45, 0.8, 0.35);
    return { buf, a: 0 };
  }
  function playClick() {
    if (!ctx || ctx.state !== 'running') return;
    if (!clickBuf) clickBuf = makeClick();
    oneShot(clickBuf, 0.9, 0, sfx, 0.94 + Math.random() * 0.12);
  }

  function oneShot(st, gain, when = 0, bus = sfx, rate = 1) {
    const src = ctx.createBufferSource();
    src.buffer = st.buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g); g.connect(bus);
    src.start(when, st.a);
    return [src, g];
  }

  function slideStart() {
    if (!ctx || ctx.state !== 'running' || slideNow || !slideBuf.start) return;
    const t = ctx.currentTime;
    // каждый подкат чуть другой: своя высота, громкость и место в лупе
    const rate = 0.86 + Math.random() * 0.22;
    const [s1, g1] = oneShot(slideBuf.start, SLIDE_GAIN * (0.85 + Math.random() * 0.15), 0, slideBus, rate);
    const srcs = [s1], gains = [g1];
    if (slideBuf.loop) {
      // луп вступает, пока вход ещё звучит, и мягко забирает громкость
      const lb = slideBuf.loop;
      const s2 = ctx.createBufferSource();
      s2.buffer = lb.buf; s2.loop = true; s2.loopStart = lb.a; s2.loopEnd = lb.b;
      s2.playbackRate.value = rate;
      // медленно «плывёт» высота — повтор лупа не так слышен
      const lfo = ctx.createOscillator(), depth = ctx.createGain();
      lfo.frequency.value = 0.35 + Math.random() * 0.4;
      depth.gain.value = rate * 0.045;
      lfo.connect(depth); depth.connect(s2.playbackRate);
      lfo.start(t); srcs.push(lfo);
      const g2 = ctx.createGain();
      g2.gain.value = 0;
      g2.gain.setTargetAtTime(SLIDE_GAIN, t + SLIDE_TO_LOOP, 0.06);
      g1.gain.setTargetAtTime(0, t + SLIDE_TO_LOOP + 0.05, 0.08);
      s2.connect(g2); g2.connect(slideBus);
      s2.start(t + SLIDE_TO_LOOP - 0.05, lb.a + Math.random() * (lb.b - lb.a) * 0.8);
      srcs.push(s2); gains.push(g2);
    }
    slideNow = { srcs, gains };
  }

  function slideStop(quiet) {
    if (!ctx || !slideNow) return;
    const t = ctx.currentTime;
    for (const g of slideNow.gains) { g.gain.cancelScheduledValues(t); g.gain.setTargetAtTime(0, t, 0.025); }
    for (const s of slideNow.srcs) { try { s.stop(t + 0.2); } catch { /* уже остановлен */ } }
    slideNow = null;
    if (!quiet && slideBuf.end && ctx.state === 'running') oneShot(slideBuf.end, SLIDE_GAIN, 0, slideBus, 0.9 + Math.random() * 0.2);
  }

  // один шаг: случайный вариант (не тот же, что прошлый), чуть разная высота и громкость
  function playStep(gain) {
    if (!ctx || !steps.length || ctx.state !== 'running') return;
    let i = Math.floor(Math.random() * steps.length);
    if (i === lastStep && steps.length > 1) i = (i + 1) % steps.length;
    lastStep = i;
    const st = steps[i];
    const src = ctx.createBufferSource();
    src.buffer = st.buf;
    src.playbackRate.value = 0.94 + Math.random() * 0.12;
    const g = ctx.createGain();
    g.gain.value = gain * (0.8 + Math.random() * 0.2);
    src.connect(g); g.connect(stepBus || sfx);
    src.start(0, st.a);
  }

  // импульсная характеристика «зала»: стерео-шум с экспоненциальным спадом, верха гаснут быстрее низов
  // bright: «кафель» — верха в хвосте держатся долго (подземка); иначе хвост быстро темнеет
  function impulse(sec, decay, bright = false) {
    const sr = ctx.sampleRate, n = Math.floor(sr * sec);
    const buf = ctx.createBuffer(2, n, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const k = bright ? 0.03 + 0.25 * t : 0.25 + 0.6 * t; // со временем фильтр закрывается сильнее
        lp += (Math.random() * 2 - 1 - lp) * (1 - k);
        d[i] = lp * Math.pow(1 - t, decay) * (i < sr * 0.012 ? i / (sr * 0.012) : 1);
      }
    }
    return buf;
  }

  function build() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = window.__sdwgAudio || new AC(); // экран запуска уже включил звук в момент тапа
    // две общие ручки громкости: музыка и всё остальное (шаги, подкат, эхо, дождь, разовые звуки)
    musicOut = ctx.createGain(); musicOut.gain.value = vol.music; musicOut.connect(ctx.destination);
    gameOut = ctx.createGain(); gameOut.gain.value = vol.game; gameOut.connect(ctx.destination);
    master = ctx.createGain();
    master.gain.value = MUSIC_GAIN;
    lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = OPEN_HZ; lp.Q.value = 0.7;
    duck = ctx.createGain(); duck.gain.value = 1;
    master.connect(lp); lp.connect(duck); duck.connect(musicOut);
    // звуки действий — мимо фильтра музыки
    sfx = ctx.createGain(); sfx.gain.value = STEP_GAIN;
    sfx.connect(gameOut);
    sfxDry = ctx.createGain(); sfxDry.gain.value = STEP_GAIN; sfxDry.connect(gameOut);
    // «вдалеке»: срез верхов, прямого звука мало, почти всё — длинный хвост реверба
    {
      farBus = ctx.createGain(); farBus.gain.value = STEP_GAIN;
      const flp = ctx.createBiquadFilter(); flp.type = 'lowpass'; flp.frequency.value = 2200; flp.Q.value = 0.5;
      const fdry = ctx.createGain(); fdry.gain.value = 0.45;
      const fconv = ctx.createConvolver(); fconv.buffer = impulse(1.6, 3.0);
      const fwet = ctx.createGain(); fwet.gain.value = 0.6;
      // «колокола» вниз там, где режет уши: ~2.5 кГц и ~4.5 кГц
      const bell = (f, db, q) => { const b = ctx.createBiquadFilter(); b.type = 'peaking'; b.frequency.value = f; b.gain.value = db; b.Q.value = q; return b; };
      const b1 = bell(2500, -10, 1.0), b2 = bell(4500, -9, 1.2);
      farBus.connect(b1); b1.connect(b2); b2.connect(flp); flp.connect(fdry); fdry.connect(gameOut);
      flp.connect(fconv); fconv.connect(fwet); fwet.connect(gameOut);
    }
    // шаги чуть глуше: мягкий срез верхов — без «песочного» шороха
    // сами шаги везде одинаковые и полные (они прямо под нами — пространство их не глушит);
    // «песок» убираем мягкой полкой −5 дБ выше 4 кГц, а не срезом — уши не закладывает
    stepBus = ctx.createBiquadFilter(); stepBus.type = 'highshelf'; stepBus.frequency.value = 4000; stepBus.gain.value = -5;
    stepBus.connect(sfx);
    // реверб для подземки: один свёрточный ревербератор на все звуки действий.
    // Импульс — затухающий шум ~2 с, сразу мягкий по верхам (бетон и плитка)
    const conv = ctx.createConvolver();
    conv.buffer = impulse(2.2, 2.6, true); // подземка: кафель — яркий долгий хвост
    revWet = ctx.createGain(); revWet.gain.value = 0;
    sfx.connect(conv); conv.connect(revWet); revWet.connect(gameOut);
    // эхо улицы от стен рядом (~0.9 с): отражение слышно с той стороны, где стена
    const near = ctx.createConvolver();
    near.buffer = impulse(0.9, 3.0);
    sfx.connect(near);
    // отражения улицы: на открытом месте глухие и тёмные, в узком переулке — ярче
    nearLP = ctx.createBiquadFilter(); nearLP.type = 'lowpass'; nearLP.frequency.value = 1800; nearLP.Q.value = 0.5;
    near.connect(nearLP);
    const pan = (p) => {
      if (!ctx.createStereoPanner) return gameOut;
      const sp = ctx.createStereoPanner(); sp.pan.value = p; sp.connect(gameOut); return sp;
    };
    nearL = ctx.createGain(); nearL.gain.value = 0; nearLP.connect(nearL); nearL.connect(pan(-0.85));
    nearR = ctx.createGain(); nearR.gain.value = 0; nearLP.connect(nearR); nearR.connect(pan(0.85));
    nearC = ctx.createGain(); nearC.gain.value = 0; nearLP.connect(nearC); nearC.connect(gameOut);
    // отдельные отражения «чух-чух-чух»: пинг-понг между левой и правой стеной.
    // Каждое отражение тише и глуше предыдущего
    const mkDelay = (sec) => { const d = ctx.createDelay(1); d.delayTime.value = sec; return d; };
    echoL = ctx.createGain(); echoL.gain.value = 0;
    echoR = ctx.createGain(); echoR.gain.value = 0;
    const dL = mkDelay(0.085), dR = mkDelay(0.11);
    const tone = () => { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 2600; return f; };
    const fL = tone(), fR = tone();
    const fbLR = ctx.createGain(), fbRL = ctx.createGain(); fbLR.gain.value = 0.18; fbRL.gain.value = 0.18; // одно-два заметных повтора, не больше
    sfx.connect(echoL); echoL.connect(dL); dL.connect(fL);
    sfx.connect(echoR); echoR.connect(dR); dR.connect(fR);
    fL.connect(pan(-0.9)); fR.connect(pan(0.9));
    fL.connect(fbLR); fbLR.connect(dR); // отразилось слева — летит к правой стене
    fR.connect(fbRL); fbRL.connect(dL);
    // скольжение — через срез высоких. Один фильтр, а не два подряд: с крутым срезом
    // на динамике телефона не оставалось почти ничего
    slideBus = ctx.createGain();
    const slf = ctx.createBiquadFilter(); slf.type = 'lowpass'; slf.frequency.value = SLIDE_LP; slf.Q.value = 0.7;
    slideBus.connect(slf); slf.connect(sfx);
    // дождь: мягкий шум, срезаны низы (не гул) и самые верхи (не шипение), редкие капли-щелчки
    {
      const n = ctx.sampleRate * 3, buf = ctx.createBuffer(2, n, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        let a = 0;
        for (let i = 0; i < n; i++) {
          a = a * 0.6 + (Math.random() * 2 - 1) * 0.4;
          d[i] = a + (Math.random() < 0.0004 ? (Math.random() * 2 - 1) * 1.5 : 0);
        }
      }
      const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 400;
      const lp2 = ctx.createBiquadFilter(); lp2.type = 'lowpass'; lp2.frequency.value = 5500;
      rainG = ctx.createGain(); rainG.gain.value = 0;
      src.connect(hp); hp.connect(lp2); lp2.connect(rainG); rainG.connect(gameOut);
      src.start();
    }
    // свернули Safari — музыка замолкает, вернулись — продолжает
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) ctx.suspend(); else ctx.resume();
    });
  }

  return {
    unlock() {
      if (!enabled) return;
      if (!ctx) build();
      if (!ctx) return;
      if (ctx.state === 'suspended') ctx.resume();
      if (!started) { started = true; startMusic().catch(() => { started = false; }); startWind().catch(() => {}); loadSteps(); loadSlide(); loadSfx(); }
    },
    // true — плавно глушим (смерть), false — плавно возвращаем как было (снова играем)
    muffle(on) { muffled = on; },
    // сразу «под водой», без перехода — с экрана запуска музыка выходит из глухого
    muffleNow() { muffled = true; m = 1; },
    // громкость музыки и игровых звуков, 0…1
    volume(music, game) {
      vol = { music, game };
      if (musicOut) { musicOut.gain.value = music; gameOut.gain.value = game; }
    },
    // скольжение (подкат по полу): true — началось, false — закончилось;
    // quiet — без звука выхода (смерть, рестарт)
    slide(on, quiet = false) { if (on) slideStart(); else slideStop(quiet); },
    // разовый звук из SFX: softFall, hardFall, springboard, monkey, dead
    sfx(name, k = 1, delay = 0) { playSfx(name, k, delay); },
    // смерть: удар + чуть позже тихое «разочарование»
    death() { playSfx('dead'); playDisap(); },
    // щелчок фонарика (включение)
    click() { playClick(); },
    // шаг; k — громкость (1 — обычный бег)
    step(k = 1) { playStep(k); },
    // приземление: два шага почти разом, громче — чем сильнее удар, тем громче
    land(k = 1) {
      playStep(Math.min(1.6, 0.9 + 0.5 * k));
      if (ctx) setTimeout(() => playStep(Math.min(1.2, 0.6 + 0.4 * k)), 45 + Math.random() * 25);
    },
    // зовётся каждый кадр. Переход ведём сами, а не расписанием AudioParam:
    // Safari на iPhone выполняет такие рампы мгновенно — звук срезался рывком.
    // стены рядом (0…1): left/right — с какой стороны, narrow — узкое место (стены с обеих сторон)
    space(left, right, narrow) {
      narrowAmt = Math.min(1, narrow * 1.5);
      if (!ctx || !nearL) return;
      const t = ctx.currentTime;
      // −3 дБ (×0.71) к прошлому: эхо и отражения улицы — фоном
      // хвост эха улицы ещё −3 дБ; отдельные отражения (echoL/R) — как были
      nearL.gain.setTargetAtTime(0.6 * left, t, 0.12);
      nearR.gain.setTargetAtTime(0.6 * right, t, 0.12);
      nearC.gain.setTargetAtTime(0.65 * narrow, t, 0.2);
      echoL.gain.setTargetAtTime(0.127 * Math.min(1, left + narrow), t, 0.12);
      echoR.gain.setTargetAtTime(0.127 * Math.min(1, right + narrow), t, 0.12);
    },
    // ветер 0…1: плавно нарастает (~0.5 с) и плавно уходит (~0.7 с); сильнее — ярче и чуть выше
    // fall 0…1 — падаем: ветер включается почти сразу (~0.12 с) и до 1.8× громче
    wind(k, fall = 0) {
      if (!ctx || !windG) return;
      const t = ctx.currentTime;
      windG.gain.setTargetAtTime(WIND_GAIN * Math.pow(k, 1.3) * (1 + 0.8 * fall), t, k > windK ? (fall > 0.05 ? 0.12 : 0.5) : 0.7);
      windLP.frequency.setTargetAtTime(900 + 5200 * k, t, fall > 0.05 ? 0.12 : 0.5);
      windSrc.playbackRate.setTargetAtTime(0.9 + 0.25 * k, t, 0.6);
      windK = k;
    },
    // дождь 0…1 (в подземке почти не слышно)
    rain(k) {
      if (!ctx || !rainG) return;
      rainG.gain.setTargetAtTime(0.16 * k * (muffled ? 0.4 : 1), ctx.currentTime, 0.3);
    },
    // deep: 0 на улице … 1 в подземке; speed — скорость бега; high: 0 … 1 на небоскрёбах.
    update(deep, speed, high = 0) {
      if (!ctx) return;
      const now = performance.now() / 1000;
      const dt = Math.min(0.1, now - (lastT || now)); lastT = now;
      m = muffled ? Math.min(1, m + dt / MUFFLE_IN) : Math.max(0, m - dt / MUFFLE_OUT);
      const e = m * m * (3 - 2 * m); // smoothstep: мягкий старт и мягкий конец
      // по частоте — в логарифме, и со сдвигом к низам: трек и так глухой, всё выше ~3 кГц
      // почти не слышно, поэтому быстро проходим верх и долго плывём в слышимой полосе
      const f = MUFFLE_HZ * Math.pow(OPEN_HZ / MUFFLE_HZ, Math.pow(1 - e, 2.2));
      const t = ctx.currentTime;
      lp.frequency.setTargetAtTime(f, t, 0.03);
      // эхо: в подземке громкое, на улице его нет
      if (revWet) revWet.gain.setTargetAtTime(1.2 * deep, t, 0.4);
      // яркость отражений улицы: открыто — ~1.6 кГц (звук «разлетается»), узко — ~6 кГц (плотный камень)
      if (nearLP) nearLP.frequency.setTargetAtTime(1600 + 4400 * narrowAmt, t, 0.15);
      duck.gain.setTargetAtTime(1 + (MUFFLE_GAIN - 1) * e, t, 0.03);
    },
  };
}
