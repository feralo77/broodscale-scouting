#!/usr/bin/env node
// ============================================================================
// Scouting de Broodscale (Modern) desde mtgtop8.
//
// Baja TODAS las listas del arquetipo "Broodscale Bloodchief" (a=2387) en una
// ventana de dias, parsea main + sideboard desde la exportacion en texto plano
// (mtgtop8.com/mtgo?d=<id>) y escribe data/broodscale.json con:
//   - las listas una a una (jugador, evento, puesto, fecha)
//   - agregado por carta (% de listas, copias tipicas, min/max)
//   - la 75 de consenso y la lista REAL mas parecida a ese consenso
//   - variantes (Estándar / Talismán / Fleshraker) con la 75 tipica de cada una
//
// Sin dependencias (Node 18+). Uso:
//   node scripts/scouting.mjs [--days 15] [--date YYYY-MM-DD] [--out data/broodscale.json]
// ============================================================================
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const ARCH_ID = 2387;
const ARCH_URL = `https://mtgtop8.com/archetype?a=${ARCH_ID}&meta=54&f=MO`;
const SEARCH_URL = 'https://mtgtop8.com/search';
const EXPORT = (id) => `https://mtgtop8.com/mtgo?d=${id}`;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const arg = (flag, def) => { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : def; };
const DAYS = parseInt(arg('--days', '15'), 10);
const OUT = arg('--out', 'data/broodscale.json');
const stamp = arg('--date', '');
const generado = stamp || new Date().toISOString().slice(0, 10);
const endDate = stamp ? new Date(`${stamp}T12:00:00Z`) : new Date();
const startDate = new Date(endDate.getTime() - DAYS * 864e5);

// Umbrales: nucleo >=90% de listas, habitual 50-89%, flex por debajo.
const CORE = 90, HABIT = 50, SIDE_KEEP = 40;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ddmmyyyy = (d) => `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
const strip = (s) => s.replace(/<[^>]*>/g, '').replace(/&#039;/g, "'").replace(/&amp;/g, '&').trim();

// mtgtop8 sirve latin1: decodificar a mano para no romper acentos.
async function get(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { 'User-Agent': UA, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`HTTP ${r.status} en ${url}`);
  return new TextDecoder('latin1').decode(await r.arrayBuffer());
}

function parseList(txt) {
  const main = [], side = [];
  let bucket = main;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^sideboard$/i.test(line)) { bucket = side; continue; }
    const m = line.match(/^(\d+)\s+(.+?)\s*$/);
    if (m) bucket.push({ q: parseInt(m[1], 10), n: m[2] });
  }
  return { main, side };
}

// Puesto "1", "2", "3-4", "5-8", "9-16"... -> numero para ordenar (el mejor posible).
const rankNum = (r) => { const m = String(r).match(/\d+/); return m ? parseInt(m[0], 10) : 999; };

// --- 1) buscador paginado: filas con metadatos -----------------------------
async function searchRows() {
  const body = (p) => `archetype_sel%5BMO%5D=${ARCH_ID}&format=MO`
    + `&date_start=${encodeURIComponent(ddmmyyyy(startDate))}`
    + `&date_end=${encodeURIComponent(ddmmyyyy(endDate))}&current_page=${p}`;
  const rows = new Map();
  for (let p = 1; p <= 40; p++) {
    let html;
    try {
      html = await get(SEARCH_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body(p) });
    } catch { break; }
    let fresh = 0;
    for (const tr of html.split(/<tr class=hover_tr>/).slice(1)) {
      const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
      const id = (tr.match(/[?&]d=(\d+)/) || [])[1];
      if (!id || rows.has(id) || tds.length < 8) continue;
      const [dd, mm, yy] = strip(tds[7]).split('/');
      rows.set(id, {
        id,
        jugador: strip(tds[2]),
        evento: strip(tds[4]),
        estrellas: (tds[5].match(/star/g) || []).length,
        puesto: strip(tds[6]),
        fecha: `20${yy}-${mm}-${dd}`,
      });
      fresh++;
    }
    if (!fresh) break;
    await sleep(150);
  }
  return [...rows.values()];
}

console.error(`Buscando Broodscale en mtgtop8 (${DAYS} dias hasta ${ddmmyyyy(endDate)})...`);
const rows = await searchRows();
if (!rows.length) throw new Error('No se encontraron listas (¿cambio el HTML de mtgtop8?)');
console.error(`  ${rows.length} listas`);

// --- 2) bajar y parsear cada lista -----------------------------------------
const decks = [];
for (const r of rows) {
  try {
    const { main, side } = parseList(await get(EXPORT(r.id)));
    const mc = main.reduce((s, c) => s + c.q, 0);
    if (mc < 60) { console.error(`  d=${r.id}: main=${mc}, descartada`); continue; }
    decks.push({ ...r, main, side });
    await sleep(100);
  } catch (e) { console.error(`  d=${r.id}: ${e.message}`); }
}
const N = decks.length;
if (!N) throw new Error('No se pudo parsear ninguna lista');

// --- 3) agregado por carta --------------------------------------------------
function aggregate(zone) {
  const map = new Map();
  for (const d of decks) for (const { q, n } of d[zone]) {
    if (!map.has(n)) map.set(n, []);
    map.get(n).push(q);
  }
  return [...map.entries()].map(([n, cs]) => {
    const counts = {};
    for (const q of cs) counts[q] = (counts[q] || 0) + 1;
    const typical = +Object.entries(counts).sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
    return {
      n, listas: cs.length, pct: Math.round((cs.length / N) * 100), tipico: typical,
      media: +(cs.reduce((a, b) => a + b, 0) / N).toFixed(2), // media sobre TODAS las listas (0 si no la lleva)
      min: Math.min(...cs), max: Math.max(...cs), copias: counts,
    };
  }).sort((a, b) => b.pct - a.pct || b.media - a.media || a.n.localeCompare(b.n));
}
const mainAgg = aggregate('main');
const sideAgg = aggregate('side');

// --- 4) 75 de consenso: rellenar 60/15 por media de copias ------------------
// Se reparten las copias una a una a la carta cuya media supere mas a lo ya
// asignado. Asi sale una lista legal de 60/15 que respeta las proporciones.
function fill(agg, total) {
  const q = new Map();
  for (let i = 0; i < total; i++) {
    let best = null, bestGap = -Infinity;
    for (const r of agg) {
      const cur = q.get(r.n) || 0;
      if (cur >= r.max) continue;
      const gap = r.media - cur;
      if (gap > bestGap) { bestGap = gap; best = r.n; }
    }
    if (!best) break;
    q.set(best, (q.get(best) || 0) + 1);
  }
  return [...q.entries()].map(([n, c]) => ({ n, q: c }));
}
const consensoMain = fill(mainAgg, 60);
const consensoSide = fill(sideAgg, 15);

// --- 5) la lista real mas parecida al consenso ------------------------------
const vec = (list) => new Map(list.map((c) => [c.n, c.q]));
function overlap(a, b) { // copias compartidas (0..60 main, 0..15 side)
  let s = 0; for (const [n, q] of a) s += Math.min(q, b.get(n) || 0); return s;
}
const cMain = vec(consensoMain), cSide = vec(consensoSide);
for (const d of decks) {
  d.simMain = overlap(vec(d.main), cMain);
  d.simSide = overlap(vec(d.side), cSide);
}
const modal = [...decks].sort((a, b) => (b.simMain + b.simSide) - (a.simMain + a.simSide) || rankNum(a.puesto) - rankNum(b.puesto))[0];

// --- 6) variantes por cartas firma -----------------------------------------
// Reglas fijas (no clustering) para que los nombres no bailen de una tirada a
// otra. Salieron de agrupar las 164 listas del 20-sep al 5-oct-2026: tres
// familias que se separan por Glaring Fleshraker y Talisman of Resilience.
const qty = (d, n) => (d.main.find((c) => c.n === n) || {}).q || 0;
const VARIANTES = [
  { id: 'fleshraker', nombre: 'Fleshraker', regla: '3 o más Glaring Fleshraker en el main', test: (d) => qty(d, 'Glaring Fleshraker') >= 3 },
  { id: 'talisman', nombre: 'Talismán', regla: 'Talisman of Resilience y sin Glaring Fleshraker', test: (d) => qty(d, 'Talisman of Resilience') >= 1 && qty(d, 'Glaring Fleshraker') === 0 },
  { id: 'estandar', nombre: 'Estándar', regla: 'el resto: 0-2 Glaring Fleshraker', test: () => true },
];
for (const d of decks) d.variante = VARIANTES.find((v) => v.test(d)).id;
const aggOf = (ds, zone) => {
  const map = new Map();
  for (const d of ds) for (const { q, n } of d[zone]) map.set(n, [...(map.get(n) || []), q]);
  return [...map.entries()].map(([n, cs]) => ({ n, pct: Math.round((cs.length / ds.length) * 100), media: cs.reduce((a, b) => a + b, 0) / ds.length, max: Math.max(...cs) }))
    .sort((a, b) => b.media - a.media);
};
const variantes = VARIANTES.map((v) => {
  const ds = decks.filter((d) => d.variante === v.id);
  if (!ds.length) return { id: v.id, nombre: v.nombre, regla: v.regla, listas: 0 };
  const cm = fill(aggOf(ds, 'main'), 60), cs = fill(aggOf(ds, 'side'), 15);
  const vm = vec(cm), vs = vec(cs);
  const rep = [...ds].sort((a, b) => (overlap(vec(b.main), vm) + overlap(vec(b.side), vs)) - (overlap(vec(a.main), vm) + overlap(vec(a.side), vs)) || rankNum(a.puesto) - rankNum(b.puesto))[0];
  return {
    id: v.id, nombre: v.nombre, regla: v.regla,
    listas: ds.length, pct: Math.round((ds.length / N) * 100),
    top8: ds.filter((d) => rankNum(d.puesto) <= 8).length,
    victorias: ds.filter((d) => rankNum(d.puesto) === 1).length,
    consenso: { main: cm, side: cs }, representativa: rep.id,
  };
}).sort((a, b) => b.listas - a.listas);

// --- 7) tipo de cada carta (Scryfall) para agrupar la lista ---------------
async function tipos(names) {
  const out = {};
  for (let i = 0; i < names.length; i += 75) {
    try {
      const r = await fetch('https://api.scryfall.com/cards/collection', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'broodscale-scouting/1.0', Accept: 'application/json' },
        body: JSON.stringify({ identifiers: names.slice(i, i + 75).map((name) => ({ name })) }),
      });
      const j = await r.json();
      for (const c of j.data || []) {
        const t = c.type_line || '';
        const tipo = /Land/.test(t) ? 'Tierra' : /Creature/.test(t) ? 'Criatura' : /Artifact/.test(t) ? 'Artefacto' : 'Hechizo';
        out[c.name] = tipo;
        if (c.name.includes(' // ')) out[c.name.split(' // ')[0]] = tipo;
      }
    } catch (e) { console.error(`  scryfall: ${e.message}`); }
    await sleep(120);
  }
  return out;
}
const tipo = await tipos([...new Set([...mainAgg, ...sideAgg].map((r) => r.n))]);

// --- 8) escribir ------------------------------------------------------------
const out = {
  generado, fuente: ARCH_URL, ventanaDias: DAYS,
  desde: startDate.toISOString().slice(0, 10), hasta: endDate.toISOString().slice(0, 10),
  listas: N,
  eventos: new Set(decks.map((d) => d.evento)).size,
  umbrales: { CORE, HABIT, SIDE_KEEP },
  consenso: { main: consensoMain, side: consensoSide },
  modal: modal.id,
  tipo, main: mainAgg, side: sideAgg, variantes,
  decks: decks.map(({ simMain, simSide, ...d }) => ({ ...d, simMain, simSide })),
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 1));
console.error(`OK -> ${OUT} (${N} listas, ${out.eventos} eventos)`);
