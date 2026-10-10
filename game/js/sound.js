// Звук: фоновая мелодия audio/ambient.mp3 крутится в лупе всё время.
// Играем её через WebAudio-буфер, а не <audio loop>: так луп без щелчка и паузы на стыке.
// iOS разрешает звук только после касания, поэтому unlock() зовём из обработчиков ввода.

const MUSIC_URL = 'audio/ambient.mp3';
const MUSIC_GAIN = 0.8;
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
  const raw = enabled ? fetch(MUSIC_URL).then((r) => r.arrayBuffer()).catch(() => null) : null;

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

  function build() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = MUSIC_GAIN;
    lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = OPEN_HZ; lp.Q.value = 0.7;
    duck = ctx.createGain(); duck.gain.value = 1;
    master.connect(lp); lp.connect(duck); duck.connect(ctx.destination);
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
      if (!started) { started = true; startMusic().catch(() => { started = false; }); }
    },
    // true — плавно глушим (смерть), false — плавно возвращаем как было (снова играем)
    muffle(on) { muffled = on; },
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
