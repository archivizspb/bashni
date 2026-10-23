// Генератор башен — перенос компонента «Башни» из Grasshopper (башни_код_компонента.py).
// Координаты плана: x — восток, y — север, z — вверх. Возвращает кольца сечений, этажи и показатели.
const TowerGeom = (() => {
  const N_DENSE = 360;  // точек на контур «лимона»
  const M_OUTER = 64;   // точек на внешнюю кромку сечения
  const K_CUT = 6;      // промежуточных точек на кромке разреза

  function lemon(p, scale) {
    const pts = [];
    for (let i = 0; i < N_DENSE; i++) {
      const t = 2 * Math.PI * i / N_DENSE, s = Math.sin(t);
      pts.push([0.5 * p.W * scale * Math.sign(s) * Math.pow(Math.abs(s), 2 * p.Sharp), 0.5 * p.L * scale * Math.cos(t)]);
    }
    return pts;
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

  // сечение башни (sign +1 — башня 1 на севере, −1 — башня 2) на высоте z
  function section(p, sign, z, H) {
    const f = H > 0 ? Math.min(Math.max(z / H, 0), 1) : 0;
    const sc = scaleAt(p, f, H), th = cutAngle(p, z);
    const n = [-Math.sin(th) * sign, Math.cos(th) * sign], d = [Math.cos(th) * sign, Math.sin(th) * sign];
    const c = 0.5 * p.Gap * sc + p.Inset * f;
    const poly = clip(lemon(p, sc), n, c);
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
    const Hb = Math.max(H - p.CrownH, p.FloorH);
    const step = Math.min(p.FloorH, 4);
    const body = levels(0, Hb, step).map((z) => section(p, sign, z, H)).filter(Boolean);
    let crown = [];
    if (H - Hb > 0.5) {
      crown = levels(Hb, H, 2).map((z) => section(p, sign, z, H)).filter(Boolean);
      const top = crown[crown.length - 1];
      if (top && Math.abs(p.CrownSlope) > 0.1) {
        // наклонный срез короны: выше на внешней стороне, дальше от разрыва
        const n = top.n, proj = top.outer.map((q) => q[0] * n[0] + q[1] * n[1]);
        const hi = Math.max(...proj), lo = Math.min(...proj);
        let slope = p.CrownSlope * Math.PI / 180;
        if (Math.abs(Math.tan(slope)) * (hi - lo) > 0.95 * (H - Hb)) slope = Math.sign(slope) * Math.atan(0.95 * (H - Hb) / (hi - lo));
        const ref = slope > 0 ? hi : lo, k = Math.tan(slope);
        crown.planeZ = (x, y) => H - k * (ref - (x * n[0] + y * n[1]));
      }
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
          H: t.H, floors: t.floors.length,
          low: t.floors.length ? t.floors[0].area : 0,
          high: t.floors.length ? t.floors[t.floors.length - 1].area : 0,
          total: sum(t)
        })),
        total: baseArea + sum(t1) + sum(t2)
      }
    };
  }

  const DEFAULTS = { L: 120, W: 60, Sharp: 0.75, Gap: 20, CutAng: 25, H1: 360, H2: 270, FloorH: 4.2, Twist: -50,
    Taper: 0.85, Inset: 5, CrownH: 20, CrownSlope: 15, Podium: 6, BaseScale: 1, Bulge: 0, BulgeZ: 120 };
  return { build, DEFAULTS, scaleAt };
})();
if (typeof module !== 'undefined') module.exports = TowerGeom;
