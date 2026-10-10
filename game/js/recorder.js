// Запись забега для отладки: касания, действия, события физики и состояние игрока/камеры ~30 раз в секунду.
// После смерти кнопкой «Отправить запись» файл уходит в меню «Поделиться» (на iPhone — «Сохранить в Файлы»,
// мессенджеры) — его можно прислать разработчику. Кнопка ⚑ во время бега ставит метку «вот тут не так».

const SAMPLE_DT = 1 / 30;
// поля кадра — по столбцам, чтобы файл был компактнее
const FRAME_KEYS = ['t', 'z', 'x', 'y', 'vy', 'v', 'lane', 'wall', 'grounded', 'slide', 'pending', 'autoAttach', 'longLane', 'longT', 'hover', 'grabT', 'camBase', 'camLook', 'camPitch', 'fov'];

const r2 = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);

export function createRecorder() {
  let meta = null, events = [], frames = null, flags = [], lastSample = -1, t0 = 0;

  return {
    begin(info) {
      meta = { ...info, started: new Date().toISOString() };
      events = []; flags = []; lastSample = -1; t0 = performance.now();
      frames = Object.fromEntries(FRAME_KEYS.map((k) => [k, []]));
    },
    // время от начала забега, с
    now() { return Math.round(performance.now() - t0) / 1000; },
    // событие: type + любые поля (числа округляем)
    event(type, data = {}) {
      if (!meta) return;
      const e = { t: this.now(), type };
      for (const k in data) e[k] = r2(data[k]);
      events.push(e);
    },
    flag(z) {
      if (!meta) return;
      flags.push({ t: this.now(), z: r2(z) });
      this.event('flag', { z });
    },
    // s — объект с полями FRAME_KEYS (кроме t); пишем не чаще SAMPLE_DT игрового времени
    frame(gameT, s) {
      if (!meta || gameT - lastSample < SAMPLE_DT) return;
      lastSample = gameT;
      frames.t.push(this.now());
      for (const k of FRAME_KEYS) if (k !== 't') frames[k].push(r2(s[k]));
    },
    // rows — кусок карты, по которому бежали (на случай, если генератор потом поменяется)
    build(extra) {
      return { format: 'sdwg-run', version: 1, meta: { ...meta, ...extra.meta }, flags, events, frames, rows: extra.rows };
    },
    has() { return !!meta && frames.t.length > 0; },
  };
}

// Отдаём файл: меню «Поделиться» (iOS/Android), иначе обычное скачивание.
export async function shareFile(name, text) {
  const file = new File([text], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return 'shared'; }
    catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}
