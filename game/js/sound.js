// Звук: фоновая мелодия audio/ambient.mp3 крутится в лупе всё время.
// Играем её через WebAudio-буфер, а не <audio loop>: так луп без щелчка и паузы на стыке.
// iOS разрешает звук только после касания, поэтому unlock() зовём из обработчиков ввода.

const MUSIC_URL = 'audio/ambient.mp3';
const MUSIC_GAIN = 0.8;
// шаги: 10 вариантов, нарезаны из записи бега (audio/steps/stepN.mp3)
const STEP_URLS = Array.from({ length: 10 }, (_, i) => `audio/steps/step${i}.mp3`);
const STEP_GAIN = 0.55;
// подкат и бег по стене: вход → луп, пока скользим → выход (audio/slide/*.mp3)
const SLIDE_URLS = { start: 'audio/slide/start.mp3', loop: 'audio/slide/loop.mp3', end: 'audio/slide/end.mp3' };
const SLIDE_GAIN = 0.8;
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

export function createSound(enabled) {
  let ctx = null, master = null, lp = null, duck = null, started = false, muffled = false;
  let m = 0, lastT = 0; // m: 0 — чистый звук, 1 — «под водой»
  // файл тянем сразу, а декодируем после первого касания (раньше AudioContext на iOS не создать)
  const get = (url) => fetch(url).then((r) => r.arrayBuffer()).catch(() => null);
  const raw = enabled ? get(MUSIC_URL) : null;
  const stepRaw = enabled ? STEP_URLS.map(get) : [];
  const slideRaw = enabled ? Object.fromEntries(Object.entries(SLIDE_URLS).map(([k, u]) => [k, get(u)])) : {};
  let slideBuf = {}, slideNow = null; // slideNow: { srcs, gains } — звучащий подкат
  let steps = [], sfx = null, lastStep = -1; // steps: [{ buf, a }] — a: где начинается звук (без тишины mp3)

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

  function oneShot(st, gain, when = 0) {
    const src = ctx.createBufferSource();
    src.buffer = st.buf;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g); g.connect(sfx);
    src.start(when, st.a);
    return [src, g];
  }

  function slideStart() {
    if (!ctx || ctx.state !== 'running' || slideNow || !slideBuf.start) return;
    const t = ctx.currentTime;
    const [s1, g1] = oneShot(slideBuf.start, SLIDE_GAIN);
    const srcs = [s1], gains = [g1];
    if (slideBuf.loop) {
      // луп вступает, пока вход ещё звучит, и мягко забирает громкость
      const lb = slideBuf.loop;
      const s2 = ctx.createBufferSource();
      s2.buffer = lb.buf; s2.loop = true; s2.loopStart = lb.a; s2.loopEnd = lb.b;
      const g2 = ctx.createGain();
      g2.gain.value = 0;
      g2.gain.setTargetAtTime(SLIDE_GAIN, t + SLIDE_TO_LOOP, 0.06);
      g1.gain.setTargetAtTime(0, t + SLIDE_TO_LOOP + 0.05, 0.08);
      s2.connect(g2); g2.connect(sfx);
      s2.start(t + SLIDE_TO_LOOP - 0.05, lb.a);
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
    if (!quiet && slideBuf.end && ctx.state === 'running') oneShot(slideBuf.end, SLIDE_GAIN);
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
    src.connect(g); g.connect(sfx);
    src.start(0, st.a);
  }

  function build() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = MUSIC_GAIN;
    lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = OPEN_HZ; lp.Q.value = 0.7;
    duck = ctx.createGain(); duck.gain.value = 1;
    master.connect(lp); lp.connect(duck); duck.connect(ctx.destination);
    // звуки действий — мимо фильтра музыки
    sfx = ctx.createGain(); sfx.gain.value = STEP_GAIN;
    sfx.connect(ctx.destination);
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
      if (!started) { started = true; startMusic().catch(() => { started = false; }); loadSteps(); loadSlide(); }
    },
    // true — плавно глушим (смерть), false — плавно возвращаем как было (снова играем)
    muffle(on) { muffled = on; },
    // скольжение (подкат по полу или бег по стене): true — началось, false — закончилось;
    // quiet — без звука выхода (смерть, рестарт)
    slide(on, quiet = false) { if (on) slideStart(); else slideStop(quiet); },
    // шаг; k — громкость (1 — обычный бег)
    step(k = 1) { playStep(k); },
    // приземление: два шага почти разом, громче — чем сильнее удар, тем громче
    land(k = 1) {
      playStep(Math.min(1.6, 0.9 + 0.5 * k));
      if (ctx) setTimeout(() => playStep(Math.min(1.2, 0.6 + 0.4 * k)), 45 + Math.random() * 25);
    },
    // зовётся каждый кадр. Переход ведём сами, а не расписанием AudioParam:
    // Safari на iPhone выполняет такие рампы мгновенно — звук срезался рывком.
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
      duck.gain.setTargetAtTime(1 + (MUFFLE_GAIN - 1) * e, t, 0.03);
    },
  };
}
