# Broodscale Scouting

Página web sencilla (GitHub Pages) con el scouting de **Broodscale** en Modern: las 75 más comunes de los últimos 15 días, sus variantes y cómo orientarlas.

- **Datos**: mtgtop8, arquetipo "Broodscale Bloodchief" (a=2387), todas las listas de la ventana.
- **Recolector**: `node scripts/scouting.mjs [--days 15]` → escribe `data/broodscale.json`. Sin dependencias (Node 18+), tarda ~1 minuto.
- **Página**: `index.html` lee ese JSON. Las cifras se recalculan solas; el texto de la pestaña "Cómo orientarla" es un análisis fechado (5-oct-2026).

Variantes (reglas fijas en el script): **Fleshraker** (3+ Glaring Fleshraker), **Talismán** (Talisman of Resilience y sin Fleshraker), **Estándar** (el resto).
