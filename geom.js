// Генератор башен — перенос компонента «Башни» из Grasshopper (башни_код_компонента.py).
// Координаты плана: x — восток, y — север, z — вверх. Возвращает кольца сечений, этажи и показатели.
const TowerGeom = (() => {
  const N_DENSE = 360;  // точек на контур «лимона»
  const M_OUTER = 64;   // точек на внешнюю кромку сечения
  const K_CUT = 6;      // промежуточных точек на кромке разреза

  function rawLemon(p) {
    const pts = [];
    for (let i = 0; i < N_DENSE; i++) {
      const t = 2 * Math.PI * i / N_DENSE, s = Math.sin(t);
      pts.push([0.5 * p.W * Math.sign(s) * Math.pow(Math.abs(s), 2 * p.Sharp), 0.5 * p.L * Math.cos(t)]);
    }
    return pts;
  }

  // Скругление носиков радиусом TipR: «открытие» выпуклого контура кругом —
  // сжать контур на R (пересечение сдвинутых полуплоскостей), затем раздуть на R дугами.
  // Где кривизна контура меньше 1/R, он не меняется; острые носики получают ровно радиус R.
  function roundContour(pts, R) {
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      area += a[0] * b[1] - b[0] * a[1];
    }
    const sgn = area > 0 ? 1 : -1;  // против часовой — внешняя нормаль (ey, −ex)
    const outward = (a, b) => {
      const ex = b[0] - a[0], ey = b[1] - a[1], l = Math.hypot(ex, ey) || 1;
      return [sgn * ey / l, -sgn * ex / l];
    };
    let er = pts.slice();
    for (let i = 0; i < pts.length && er.length >= 3; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length], n = outward(a, b);
      er = clip(er, [-n[0], -n[1]], -(n[0] * a[0] + n[1] * a[1]) + R).map((q) => q[0]);
    }
    if (er.length < 3) return pts;
    const out = [];
    for (let i = 0; i < er.length; i++) {
      const prev = er[(i - 1 + er.length) % er.length], v = er[i], next = er[(i + 1) % er.length];
      const n0 = outward(prev, v), n1 = outward(v, next);
      let a0 = Math.atan2(n0[1], n0[0]), a1 = Math.atan2(n1[1], n1[0]);
      let da = a1 - a0;
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      const steps = Math.max(1, Math.ceil(Math.abs(da) / (Math.PI / 60)));
      for (let k = 0; k <= steps; k++) {
        const ang = a0 + da * k / steps;
        out.push([v[0] + R * Math.cos(ang), v[1] + R * Math.sin(ang)]);
      }
    }
    // равномерно по длине, с той же стартовой точкой (вершина севера) и тем же обходом
    let start = 0;
    out.forEach((q, i) => { if (q[1] > out[start][1]) start = i; });
    const ring = out.slice(start).concat(out.slice(0, start + 1));
    return resample(ring, N_DENSE + 1).slice(0, N_DENSE);
  }

  const lemonCache = new Map();
  function lemon(p, scale) {
    const key = [p.L, p.W, p.Sharp, p.TipR].join('|');
    if (!lemonCache.has(key)) {
      if (lemonCache.size > 50) lemonCache.clear();
      const raw = rawLemon(p);
      lemonCache.set(key, p.TipR > 0.01 ? roundContour(raw, Math.min(p.TipR, 0.45 * Math.min(p.L, p.W))) : raw);
    }
    return lemonCache.get(key).map((q) => [q[0] * scale, q[1] * scale]);
  }

  // часть многоугольника, где n·p >= c; точки пересечения помечены
  function clip(poly, n, c) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const da = a[0] * n[0] + a[1] * n[1] - c, db = b[0] * n[0] + b[1] * n[1] - c;
      if (da >= 0) out.push([a, false]);
      if ((da >= 0) !== (db >= 0)) {
        const t = da / (da - db);
        out.push([[a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])], true]);
      }
    }
    return out;
  }

  function shoelace(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a) / 2;
  }

  function resample(chain, m) {
    const seg = [0];
    for (let i = 1; i < chain.length; i++) seg.push(seg[i - 1] + Math.hypot(chain[i][0] - chain[i - 1][0], chain[i][1] - chain[i - 1][1]));
    const total = seg[seg.length - 1], res = [];
    let j = 0;
    for (let i = 0; i < m; i++) {
      const s = total * i / (m - 1);
      while (j < seg.length - 2 && seg[j + 1] < s) j++;
      const span = seg[j + 1] - seg[j], t = span ? (s - seg[j]) / span : 0;
      const a = chain[j], b = chain[j + 1];
      res.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    }
    return res;
  }

  // масштаб сечения по высоте: прямая от ширины внизу (BaseScale) к ширине наверху (Taper)
  // плюс плавное расширение Bulge — ноль внизу и наверху, максимум на высоте BulgeZ (м)
  function scaleAt(p, f, H) {
    const m = H > 0 ? Math.min(Math.max(p.BulgeZ / H, 0.05), 0.95) : 0.5;
    const g = f < m ? 0.5 * f / m : 0.5 + 0.5 * (f - m) / (1 - m);
    return p.BaseScale + (p.Taper - p.BaseScale) * f + p.Bulge * Math.sin(Math.PI * g);
  }

  const cutAngle = (p, z) => (p.CutAng + p.Twist * (p.H1 > 0 ? z / p.H1 : 0)) * Math.PI / 180;

  const areaAt = (pts, n, c) => shoelace(clip(pts, n, c).map((q) => q[0]));

  // сечение башни (sign +1 — башня 1 на севере, −1 — башня 2) на высоте z.
  // Shrink 0 — «лимон» масштабируется от центра, наклоняются и фасад, и разрез.
  // Shrink 1 — сужение уходит в разрыв: внешний фасад вертикален (контур не меньше, чем внизу),
  // а кромка разреза отодвигается, пока площадь этажа не станет той же, что при масштабе от центра
  function section(p, sign, z, H) {
    const f = H > 0 ? Math.min(Math.max(z / H, 0), 1) : 0;
    const sc = scaleAt(p, f, H), th = cutAngle(p, z);
    const n = [-Math.sin(th) * sign, Math.cos(th) * sign], d = [Math.cos(th) * sign, Math.sin(th) * sign];
    let c = 0.5 * p.Gap * sc + p.Inset * f, so = sc;
    if (p.Shrink && sc < p.BaseScale) {
      so = p.BaseScale;
      const pts = lemon(p, so), target = areaAt(lemon(p, sc), n, c);
      let lo = c, hi = Math.max(...pts.map((q) => q[0] * n[0] + q[1] * n[1]));
      for (let it = 0; it < 28; it++) {
        const mid = 0.5 * (lo + hi);
        if (areaAt(pts, n, mid) > target) lo = mid; else hi = mid;
      }
      c = 0.5 * (lo + hi);
    }
    const poly = clip(lemon(p, so), n, c);
    if (poly.length < 3) return null;
    const area = shoelace(poly.map((q) => q[0]));
    let cut = -1;
    for (let i = 0; i < poly.length; i++) if (poly[i][1] && poly[(i + 1) % poly.length][1]) { cut = i; break; }
    if (cut < 0) return null;
    let chain = [];
    for (let i = 0; i < poly.length; i++) chain.push(poly[(cut + 1 + i) % poly.length][0]);
    const dot = (q) => q[0] * d[0] + q[1] * d[1];
    if (dot(chain[0]) < dot(chain[chain.length - 1])) chain.reverse();
    const outer = resample(chain, M_OUTER);
    const a = outer[outer.length - 1], b = outer[0], inner = [];
    for (let k = 0; k <= K_CUT + 1; k++) {
      const t = k / (K_CUT + 1);
      inner.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    }
    return { outer, inner, area, z, n };
  }

  function levels(z0, z1, step) {
    const zs = [];
    for (let z = z0; z < z1 - 1e-6; z += step) zs.push(z);
    zs.push(z1);
    return zs;
  }

  function tower(p, sign, H) {
    // наклонный срез короны: выше к внешнему носику, уклон — вдоль оси башни (север-юг), а не по
    // закрученному разрезу, чтобы на обоих боковых фасадах угол был одинаковый при любой закрутке.
    // Наклон не урезается: если перепад среза не помещается в высоту короны, корона становится выше
    let crownH = p.CrownH, planeZ = null;
    const topSec = p.CrownH > 0.5 ? section(p, sign, H, H) : null;
    if (topSec && Math.abs(p.CrownSlope) > 0.1) {
      const n = [0, sign], proj = topSec.outer.map((q) => q[0] * n[0] + q[1] * n[1]);
      const hi = Math.max(...proj), lo = Math.min(...proj);
      const k = Math.tan(p.CrownSlope * Math.PI / 180), ref = k > 0 ? hi : lo;
      crownH = Math.max(crownH, Math.abs(k) * (hi - lo) * 1.08 + 2);
      planeZ = (x, y) => H - k * (ref - (x * n[0] + y * n[1]));
    }
    const Hb = Math.max(H - crownH, p.FloorH);
    const step = Math.min(p.FloorH, 4);
    const body = levels(0, Hb, step).map((z) => section(p, sign, z, H)).filter(Boolean);
    let crown = [];
    if (H - Hb > 0.5) {
      crown = levels(Hb, H, 2).map((z) => section(p, sign, z, H)).filter(Boolean);
      if (planeZ) crown.planeZ = planeZ;
    }
    const floors = [];
    for (let i = 0; p.Podium + i * p.FloorH < Hb - 1e-6; i++) {
      const s = section(p, sign, p.Podium + i * p.FloorH, H);
      if (s) floors.push(s);
    }
    return { H, Hb, body, crown, floors };
  }

  function build(p) {
    const t1 = tower(p, 1, p.H1), t2 = tower(p, -1, p.H2);
    const base = lemon(p, 1);
    const baseArea = p.Podium > 0 ? shoelace(base) : 0;
    const sum = (t) => t.floors.reduce((a, s) => a + s.area, 0);
    return {
      towers: [t1, t2], base, baseArea,
      stats: {
        baseArea,
        t: [t1, t2].map((t) => ({
          H: t.H, crownH: t.H - t.Hb, floors: t.floors.length,
          low: t.floors.length ? t.floors[0].area : 0,
          high: t.floors.length ? t.floors[t.floors.length - 1].area : 0,
          total: sum(t)
        })),
        total: baseArea + sum(t1) + sum(t2)
      }
    };
  }

  const DEFAULTS = { L: 120, W: 60, Sharp: 0.75, Gap: 20, CutAng: 25, H1: 360, H2: 270, FloorH: 4.2, Twist: -50,
    Taper: 0.85, Inset: 5, CrownH: 20, CrownSlope: 15, Podium: 6, BaseScale: 1, Bulge: 0, BulgeZ: 120, TipR: 0, Shrink: 1 };
  // полный набор параметров; у вариантов, сохранённых до появления Shrink, сужение — от центра
  const withDefaults = (params) => {
    const r = Object.assign({}, DEFAULTS, params);
    if (params && Object.keys(params).length && !('Shrink' in params)) r.Shrink = 0;
    return r;
  };
  return { build, DEFAULTS, scaleAt, withDefaults };
})();
if (typeof module !== 'undefined') module.exports = TowerGeom;
