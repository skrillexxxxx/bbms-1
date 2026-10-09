// Проверка паттернов и генератора: node game/tools/check-patterns.mjs
import { PATTERN_REPORT, World } from '../js/world.js';

let bad = 0;
for (const r of PATTERN_REPORT) {
  console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.name}${r.ok ? '' : ' — ' + r.reason}`);
  if (!r.ok) bad++;
}

const counts = {};
for (let seed = 1; seed <= 200; seed++) {
  const w = new World(seed);
  w.ensureRows(400);
  for (const inst of w.instances) counts[inst.name] = (counts[inst.name] || 0) + 1;
}
console.log('\nusage over 200 worlds x 400 rows:', counts);
if (bad) process.exit(1);
