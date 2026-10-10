// Красные обезьянки — собираем, как монетки. Модель — Suzanne из Blender (models/monkey.bin:
// сжатые до int16 вершины и индексы, ~9 КБ). Рисуются через тот же изгиб мира, что и всё остальное.
// Ставятся редко и поодиночке — ценный артефакт: на «живой» клетке пути (куда точно можно добежать),
// не чаще чем раз в ~300 м, в среднем раз в ~600 м.

import * as THREE from 'three';
import { COLS, CELL, ROW, LEVEL, L, LZ, WALL, BRIDGE, LAUNCH, aliveBackward, walk, lv, mulberry32 } from './world.js';

const SIZE = 1.1;          // ширина модели, м
const HOVER = 1.15;        // высота центра над полом
const TRAIL = 1;           // одна обезьянка, без цепочек
const GAP_ROWS = 75;       // минимум рядов между обезьянками (~300 м)
const CHANCE = 0.45;       // шанс поставить обезьянку в подходящем паттерне

let geometry = null;
export const monkeyGeometry = () => geometry;
export async function loadMonkey() {
  try {
    const buf = await (await fetch('models/monkey.bin')).arrayBuffer();
    const [nv, ni] = new Uint32Array(buf, 0, 2);
    const q = new Int16Array(buf, 8, nv * 3);
    const idx = new Uint16Array(buf, 8 + nv * 6, ni);
    const pos = new Float32Array(nv * 3);
    // нос модели смотрит по +z — разворачиваем к игроку (он бежит по +z)
    for (let i = 0; i < nv; i++) {
      pos[i * 3] = -q[i * 3] / 32767 * 0.6 * SIZE;
      pos[i * 3 + 1] = q[i * 3 + 1] / 32767 * 0.6 * SIZE;
      pos[i * 3 + 2] = -q[i * 3 + 2] / 32767 * 0.6 * SIZE;
    }
    let g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    // гранёные нормали — в духе низкополигонального города
    g = g.toNonIndexed();
    g.computeVertexNormals();
    geometry = g;
  } catch { geometry = null; }
}

const vert = /* glsl */ `
  uniform float uL;
  uniform float uLz;
  uniform float uB;
  uniform float uFogNear;
  uniform float uFogFar;
  varying vec3 vN;
  varying float vFog;
  void main() {
    vec4 f = modelMatrix * vec4(position, 1.0);
    float s = exp(-f.z / uLz);
    float r = uL * s;
    float phi = f.x / uL;
    vec3 w = vec3(r * sin(phi), uB + (f.y - uB) * s, r * cos(phi));
    gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
    vN = normalize(mat3(modelMatrix) * normal);
    vFog = smoothstep(uFogNear, uFogFar, length(vec2(w.x, w.z - uL)));
  }
`;
const frag = /* glsl */ `
  precision highp float;
  uniform float uLinearOut;
  uniform vec3 uFogColor;
  uniform float uFlash;
  uniform float uNight;
  varying vec3 vN;
  varying float vFog;
  void main() {
    vec3 n = normalize(vN);
    float d = max(dot(n, normalize(vec3(-0.4, 0.8, -0.45))), 0.0);
    float rim = pow(1.0 - abs(n.z), 2.0) * 0.25;
    vec3 red = vec3(0.9, 0.12, 0.13);
    vec3 c = red * (0.55 + 0.55 * d) + rim;
    c = mix(c, c * vec3(0.75, 0.55, 0.55), uNight); // ночью чуть темнее, но красный светится
    c = mix(c, vec3(1.0), uFlash);
    c = mix(c, uFogColor, vFog);
    if (uLinearOut > 0.5) c = pow(c, vec3(2.2));
    gl_FragColor = vec4(c, 1.0);
  }
`;

export function createMonkeyMaterial({ linearOut }) {
  return new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    uniforms: {
      uL: { value: L }, uLz: { value: LZ }, uB: { value: 0 },
      uFogNear: { value: LZ * 2.2 }, uFogFar: { value: LZ * 6.0 },
      uFogColor: { value: new THREE.Color(1, 1, 1) },
      uLinearOut: { value: linearOut ? 1 : 0 },
      uFlash: { value: 0 },
      uNight: { value: 0 },
    },
  });
}

// Обезьянки для паттерна inst: добавляет меши в group (в локальных координатах паттерна),
// возвращает список { mesh, x, y, z } в мировых координатах для сбора.
export function placeMonkeys(world, inst, group, material) {
  if (!geometry) return [];
  const r0 = inst.rowStart, n = inst.rows ? inst.rows.length : 0;
  const end = Math.min(world.rows.length, r0 + n);
  if (end - r0 < TRAIL + 2) return [];
  if (r0 - (world.lastMonkeyRow ?? -GAP_ROWS) < GAP_ROWS) return [];
  const rng = mulberry32((world.seed ?? 1) * 7919 + r0 * 104729);
  if (rng() > CHANCE) return [];
  const rows = world.rows.slice(r0, world.rows.length);
  const alive = aliveBackward(rows, world.reach.slice(r0, world.rows.length));
  // кандидаты: TRAIL рядов подряд в одной колонке — живые, с полом на одной высоте, без мостов и трамплинов
  const ok = (r, c) => {
    const row = rows[r], v = row[c];
    return alive[r][c] && walk(v) && v !== BRIDGE && v !== LAUNCH && row.b0 === row.b1;
  };
  const cands = [];
  for (let r = 1; r + TRAIL <= end - r0 - 1; r++) {
    for (let c = 0; c < COLS; c++) {
      let good = true;
      for (let k = 0; k < TRAIL && good; k++) {
        good = ok(r + k, c) && rows[r + k][c] === rows[r][c] && rows[r + k].b0 === rows[r].b0;
      }
      if (good) cands.push([r, c]);
    }
  }
  if (!cands.length) return [];
  const [r, c] = cands[Math.floor(rng() * cands.length)];
  world.lastMonkeyRow = r0 + r;
  const out = [];
  for (let k = 0; k < TRAIL; k++) {
    const row = rows[r + k];
    const x = (c + 0.5) * CELL, y = row.b0 + lv(row[c]) * LEVEL + HOVER, zl = (r + k + 0.5) * ROW;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.position.set(x, y, zl);
    mesh.rotation.y = k * 0.6;
    group.add(mesh);
    out.push({ mesh, x, y, z: (r0 + r + k + 0.5) * ROW, phase: k * 0.6 });
  }
  return out;
}
