// Звук без файлов: всё синтезируется WebAudio.
// В подземке — низкий гул вентиляции и жужжание ламп (liminal), на бегу — ветер по скорости.
// iOS разрешает звук только после касания, поэтому unlock() зовём из обработчиков ввода.

export function createSound(enabled) {
  let ctx = null, drone = null, hum = null, wind = null, windF = null;

  function build() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    const master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);

    // гул: две чуть расстроенные пилы через низкочастотный фильтр — «бьются» и плывут
    drone = ctx.createGain(); drone.gain.value = 0;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 220; lp.Q.value = 0.7;
    for (const f of [55, 55.35, 82.6]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
      o.connect(lp); o.start();
    }
    lp.connect(drone); drone.connect(master);

    // лампы дневного света: 100/200 Гц, очень тихо
    hum = ctx.createGain(); hum.gain.value = 0;
    for (const [f, g] of [[100, 1], [200, 0.45], [300, 0.15]]) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      const og = ctx.createGain(); og.gain.value = g;
      o.connect(og); og.connect(hum); o.start();
    }
    hum.connect(master);

    // ветер: шум через полосовой фильтр, громче и выше на скорости
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource(); noise.buffer = buf; noise.loop = true;
    windF = ctx.createBiquadFilter(); windF.type = 'bandpass'; windF.frequency.value = 500; windF.Q.value = 0.6;
    wind = ctx.createGain(); wind.gain.value = 0;
    noise.connect(windF); windF.connect(wind); wind.connect(master); noise.start();
  }

  return {
    unlock() {
      if (!enabled) return;
      if (!ctx) build();
      if (ctx && ctx.state === 'suspended') ctx.resume();
    },
    // deep: 0 на улице … 1 в подземке; speed — скорость бега (0 — стоим)
    // high: 0 … 1 на верхушках небоскрёбов — ветер сильнее
    update(deep, speed, high = 0) {
      if (!ctx) return;
      const t = ctx.currentTime;
      drone.gain.setTargetAtTime(0.05 * deep, t, 0.6);
      hum.gain.setTargetAtTime(0.012 * deep, t, 0.6);
      const sk = Math.min(1, speed / 25);
      const gust = high * (0.04 + 0.03 * Math.sin(t * 0.7) * Math.sin(t * 1.9));
      wind.gain.setTargetAtTime((speed > 0 ? (0.015 + 0.05 * sk * sk) * (1 - 0.6 * deep) : 0) + gust, t, 0.3);
      windF.frequency.setTargetAtTime(350 + 900 * sk - 150 * high, t, 0.3);
    },
  };
}
