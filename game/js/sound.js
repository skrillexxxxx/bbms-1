// Звук: фоновая мелодия audio/ambient.mp3 крутится в лупе всё время.
// Играем её через WebAudio-буфер, а не <audio loop>: так луп без щелчка и паузы на стыке.
// iOS разрешает звук только после касания, поэтому unlock() зовём из обработчиков ввода.

const MUSIC_URL = 'audio/ambient.mp3';
const MUSIC_GAIN = 0.8;
// смерть: музыка уходит «под воду» — срез высоких до MUFFLE_HZ и на 3 дБ тише
const OPEN_HZ = 20000, MUFFLE_HZ = 350, MUFFLE_GAIN = 0.708; // −3 дБ
const MUFFLE_IN = 1.2, MUFFLE_OUT = 0.8; // секунды

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
    if (muffled) { lp.frequency.value = MUFFLE_HZ; duck.gain.value = MUFFLE_GAIN; }
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
    muffle(on) {
      muffled = on;
      if (!ctx) return;
      const t = ctx.currentTime, dur = on ? MUFFLE_IN : MUFFLE_OUT;
      // экспоненциально по частоте — на слух срез идёт равномерно, без провала в начале
      for (const [param, to] of [[lp.frequency, on ? MUFFLE_HZ : OPEN_HZ], [duck.gain, on ? MUFFLE_GAIN : 1]]) {
        // если прошлый переход ещё идёт — продолжаем с того места, где он сейчас
        if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(t);
        else { param.cancelScheduledValues(t); param.setValueAtTime(param.value, t); }
        param.exponentialRampToValueAtTime(to, t + dur);
      }
    },
    // deep: 0 на улице … 1 в подземке; speed — скорость бега; high: 0 … 1 на небоскрёбах.
    // Пока музыка от этого не зависит — сюда же лягут шаги и звуки действий.
    update(deep, speed, high = 0) {},
  };
}
