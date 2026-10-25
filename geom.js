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
  // Shrink — где центр сужения, 0…1. 0 — «лимон» масштабируется от центра, наклоняются и фасад, и разрез.
  // 1 — сужение уходит в разрыв: внешний фасад вертикален (контур как внизу). Между ними внешний
  // контур сужается на долю (1 − Shrink), а остальное добирает разрез: кромка отодвигается,
  // пока площадь этажа не станет той же, что при масштабе от центра
  function section(p, sign, z, H) {
    const f = H > 0 ? Math.min(Math.max(z / H, 0), 1) : 0;
    const sc = scaleAt(p, f, H), th = cutAngle(p, z);
    const n = [-Math.sin(th) * sign, Math.cos(th) * sign], d = [Math.cos(th) * sign, Math.sin(th) * sign];
    let c = 0.5 * p.Gap * sc + p.Inset * f, so = sc;
    if (p.Shrink > 0 && sc < p.BaseScale) {
      so = sc + Math.min(p.Shrink, 1) * (p.BaseScale - sc);
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

  // ---------- рёбра: пила в самом контуре низа башни (не накладные элементы)
  // таблица «угол обхода от севера по часовой -> длина дуги» по контуру лимона
  const arcCache = new Map();
  function lemonArc(p) {
    const key = [p.L, p.W, p.Sharp, p.TipR].join('|');
    if (!arcCache.has(key)) {
      if (arcCache.size > 50) arcCache.clear();
      const pts = lemon(p, 1), S = [0];
      for (let i = 1; i < pts.length; i++) S.push(S[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      const P = S[S.length - 1] + Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]);
      let rows = pts.map((q, i) => [polarU(q), S[i]]).sort((a, b) => a[0] - b[0]);
      const first = rows[0], last = rows[rows.length - 1];
      rows = [[last[0] - 360, last[1] - P]].concat(rows, [[first[0] + 360, first[1] + P]]);
      arcCache.set(key, { U: rows.map((r) => r[0]), S: rows.map((r) => r[1]), P });
    }
    return arcCache.get(key);
  }
  const polarU = (q) => (((90 - Math.atan2(q[1], q[0]) * 180 / Math.PI) % 360) + 360) % 360;

  // длина дуги по контуру от носика башни до точки (со знаком), по полярному углу точки
  function arcFromNose(p, q, sign) {
    const { U, S, P } = lemonArc(p), u = polarU(q);
    let lo = 0, hi = U.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (U[m] <= u) lo = m; else hi = m; }
    const t = U[hi] > U[lo] ? (u - U[lo]) / (U[hi] - U[lo]) : 0;
    let s = S[lo] + t * (S[hi] - S[lo]);
    if (sign < 0) s -= 0.5 * P;   // носик башни 2 — южный, на половине обхода
    return ((s + 0.5 * P) % P + P) % P - 0.5 * P;
  }

  const smooth01 = (u) => { u = Math.min(Math.max(u, 0), 1); return u * u * (3 - 2 * u); };
  // высота рёбер у разрыва: RibH — для самой высокой башни, у другой — пропорционально её высоте
  const ribH = (p, H) => p.RibH * H / Math.max(p.H1, p.H2);

  // внешняя кромка сечения по возрастанию дуги от носика: { outer, sn } или null
  function arcSection(p, sign, z, H) {
    const s = section(p, sign, z, H);
    if (!s) return null;
    let outer = s.outer, sn = outer.map((q) => arcFromNose(p, q, sign));
    if (sn[0] > sn[sn.length - 1]) { outer = outer.slice().reverse(); sn = sn.slice().reverse(); }
    return { outer, sn, area: s.area };
  }

  // Сечение с пилой на отметке z: [дуга в осях рисунка, точка] от угла разреза до угла, плюс кромка разреза.
  // Рёбра только с одной стороны от носика (дуга < 0: у башни 1 — запад, у башни 2 — восток) и идут по
  // закруту — рисунок пилы едет по фасаду вместе с углом разреза. Зуб несимметричный (вершина на доле
  // RibAsym шага), гаснет, сужаясь целиком (ширина и глубина вместе), к носику, у угла разреза и к верху;
  // верх у каждого ребра свой — у разрыва ribH, к носику ниже, граница по параболе.
  function ribbedRow(p, sign, z, H, uCut) {
    const a = arcSection(p, sign, z, H);
    if (!a) return null;
    const { outer, sn } = a, s0 = sn[0], s1 = sn[sn.length - 1];
    const at = (t) => {
      let j = 0;
      while (j < sn.length - 2 && sn[j + 1] < t) j++;
      const k = sn[j + 1] > sn[j] ? Math.min(Math.max((t - sn[j]) / (sn[j + 1] - sn[j]), 0), 1) : 0;
      const A = outer[j], B = outer[j + 1];
      return [A[0] + k * (B[0] - A[0]), A[1] + k * (B[1] - A[1])];
    };
    const off = s0 - uCut, step = p.RibStep, asym = p.RibAsym;
    const width = (j) => {
      const uc = (j + 0.5) * step;
      const t = uCut < 0 ? Math.min(Math.max((uc - uCut) / -uCut, 0), 1) : 0;   // 0 у разреза, 1 у носика
      const top = ribH(p, H) * (0.25 + 0.75 * (1 - t) * (1 - t));
      const fz = 1 - smooth01(z / top);
      const fn = uc < 0 ? (p.RibNose > 0 ? smooth01(-uc / p.RibNose) : 1) : 0;
      const fc = smooth01(Math.min(uc + off - s0, s1 - uc - off) / step);
      return fz * fn * fc;
    };
    const nodes = [];
    for (let j = Math.floor((s0 - off) / step) - 1; j <= Math.ceil((s1 - off) / step); j++) {
      const w = width(j), a0 = 1 - w, pts = [[0, 0]];
      if (a0 > 0.53) pts.push([0.5, 0]);
      if (w > 0.02) {
        if (a0 > 0.03) pts.push([a0, 0]);
        pts.push([a0 + w * 0.5 * asym, 0.5], [a0 + w * asym, 1]);
      }
      pts.forEach(([ph, tri]) => nodes.push([(j + ph) * step, p.RibD * w * tri]));
    }
    const row = [[s0 - off, at(s0)]];
    nodes.filter((n) => s0 + 0.3 < n[0] + off && n[0] + off < s1 - 0.3).sort((x, y) => x[0] - y[0]).forEach(([u, d]) => {
      const g = u + off;
      let q = at(g);
      if (d > 1e-4) {
        const pa = at(g - 0.5), pb = at(g + 0.5), tx = pb[0] - pa[0], ty = pb[1] - pa[1], ln = Math.hypot(tx, ty) || 1;
        let nx = ty / ln, ny = -tx / ln;
        if (nx * q[0] + ny * q[1] < 0) { nx = -nx; ny = -ny; }
        q = [q[0] + nx * d, q[1] + ny * d];
      }
      row.push([u, q]);
    });
    row.push([s1 - off, at(s1)]);
    const A = row[row.length - 1][1], B = row[0][1], cut = [];
    for (let k = 1; k <= K_CUT; k++) cut.push([A[0] + (B[0] - A[0]) * k / (K_CUT + 1), A[1] + (B[1] - A[1]) * k / (K_CUT + 1)]);
    return { row, cut, z };
  }

  // угол разреза со стороны рёбер у земли (в осях рисунка он неподвижен)
  function ribCutU(p, sign, H) {
    const a = arcSection(p, sign, 0, H);
    return a ? a.sn[0] : 0;
  }

  // сетка низа башни с рёбрами: фасад сшит между отметками по дуге рисунка, кромка разреза —
  // четырёхугольниками, низ закрыт веером. Вершины [x, y, z], треугольники [a, b, c] наружу
  function ribbedMesh(rows) {
    const verts = [], tris = [], ids = [];
    const vid = (q, z) => { verts.push([q[0], q[1], z]); return verts.length - 1; };
    rows.forEach((r) => ids.push({ row: r.row.map(([u, q]) => [u, vid(q, r.z)]), cut: r.cut.map((q) => vid(q, r.z)) }));
    for (let k = 0; k < ids.length - 1; k++) {
      const A = ids[k].row, B = ids[k + 1].row;
      let i = 0, j = 0;
      while (i < A.length - 1 || j < B.length - 1) {
        if (j >= B.length - 1 || (i < A.length - 1 && A[i + 1][0] <= B[j + 1][0])) { tris.push([A[i][1], A[i + 1][1], B[j][1]]); i++; }
        else { tris.push([A[i][1], B[j + 1][1], B[j][1]]); j++; }
      }
      const ra = [A[A.length - 1][1]].concat(ids[k].cut, [A[0][1]]), rb = [B[B.length - 1][1]].concat(ids[k + 1].cut, [B[0][1]]);
      for (let m = 0; m < ra.length - 1; m++) tris.push([ra[m], ra[m + 1], rb[m + 1]], [ra[m], rb[m + 1], rb[m]]);
    }
    const ring = ids[0].row.map((t) => t[1]).concat(ids[0].cut);
    let cx = 0, cy = 0;
    ring.forEach((v) => { cx += verts[v][0]; cy += verts[v][1]; });
    const c = vid([cx / ring.length, cy / ring.length], rows[0].z);
    for (let m = 0; m < ring.length; m++) tris.push([c, ring[(m + 1) % ring.length], ring[m]]);
    // ориентация: нормаль первого фасадного треугольника — наружу от оси башни
    const [a, b, d] = tris[0].map((v) => verts[v]);
    const nx = (b[1] - a[1]) * (d[2] - a[2]) - (b[2] - a[2]) * (d[1] - a[1]);
    const ny = (b[2] - a[2]) * (d[0] - a[0]) - (b[0] - a[0]) * (d[2] - a[2]);
    if (nx * a[0] + ny * a[1] < 0) tris.forEach((t) => { const x = t[1]; t[1] = t[2]; t[2] = x; });
    return { verts, tris };
  }

  // этаж внутри зоны рёбер — в формате section: outer по пиле, inner — кромка разреза с концами
  function ribbedFloor(r) {
    const outer = r.row.map((t) => t[1]);
    const inner = [outer[outer.length - 1]].concat(r.cut, [outer[0]]);
    return { outer, inner, area: shoelace(outer.concat(r.cut)), z: r.z };
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
    // низ с рёбрами — сеткой до высоты рёбер у разрыва, выше — гладкие сечения, как без рёбер
    let ribs = null, zFrom = 0, uCut = 0;
    if (p.RibD > 0 && p.RibStep > 0.5) {
      zFrom = Math.min(ribH(p, H), Hb);
      uCut = ribCutU(p, sign, H);
      const nz = Math.max(2, Math.ceil(zFrom / 2));
      const rows = [];
      for (let i = 0; i <= nz; i++) { const r = ribbedRow(p, sign, zFrom * i / nz, H, uCut); if (r) rows.push(r); }
      if (rows.length > 1) ribs = ribbedMesh(rows); else zFrom = 0;
    }
    const body = Hb - zFrom > 0.5 ? levels(zFrom, Hb, step).map((z) => section(p, sign, z, H)).filter(Boolean) : [];
    let crown = [];
    if (H - Hb > 0.5) {
      crown = levels(Hb, H, 2).map((z) => section(p, sign, z, H)).filter(Boolean);
      if (planeZ) crown.planeZ = planeZ;
    }
    // при общем этаже-эллипсе в разрыве у башен свои этажи с земли
    const floors = [], z0 = p.PodSet > 0 ? 0 : p.Podium;
    for (let i = 0; z0 + i * p.FloorH < Hb - 1e-6; i++) {
      const zf = z0 + i * p.FloorH;
      let s;
      if (ribs && zf < zFrom) { const r = ribbedRow(p, sign, zf, H, uCut); s = r && ribbedFloor(r); }
      else s = section(p, sign, zf, H);
      if (s) floors.push(s);
    }
    return { H, Hb, body, crown, floors, ribs, zFrom };
  }

  // общий этаж в разрыве: эллипс в пропорциях плана, доля PodK, высота Podium; кровля с зеленью
  // и световой фонарь атриума (эллипс вдоль разрыва). Площадь — только часть в разрыве (не внутри башен)
  function podium(p) {
    const k = p.PodK, ring = [];
    for (let i = 0; i < 128; i++) { const t = 2 * Math.PI * i / 128; ring.push([0.5 * p.W * k * Math.cos(t), 0.5 * p.L * k * Math.sin(t)]); }
    const nFl = Math.max(1, Math.round(p.Podium / p.FloorH));
    let area = 0;
    for (let f = 0; f < nFl; f++) {
      const th = cutAngle(p, f * p.FloorH), n = [-Math.sin(th), Math.cos(th)], c = 0.5 * p.Gap;
      const strip = clip(clip(ring, n, -c).map((q) => q[0]), [-n[0], -n[1]], -c).map((q) => q[0]);
      area += strip.length > 2 ? shoelace(strip) : 0;
    }
    let lantern = null;
    if (p.Sky > 0.05) {
      const th = cutAngle(p, p.Podium), d = [Math.cos(th), Math.sin(th)], n = [-Math.sin(th), Math.cos(th)];
      const a = p.Sky * 0.32 * p.L * k, b = p.Sky * 0.32 * p.Gap;
      const ell = (s) => {
        const pts = [];
        for (let i = 0; i < 64; i++) {
          const t = 2 * Math.PI * i / 64, x = a * s * Math.cos(t), y = b * s * Math.sin(t);
          pts.push([x * d[0] + y * n[0], x * d[1] + y * n[1]]);
        }
        return pts;
      };
      lantern = [[0, 1], [1.5, 0.97], [3, 0.86], [4, 0.64], [4.5, 0.32]].map(([dz, s]) => ({ pts: ell(s), z: p.Podium + dz }));
    }
    return { ring, h: p.Podium, floors: nFl, area, lantern };
  }

  function build(p) {
    const t1 = tower(p, 1, p.H1), t2 = tower(p, -1, p.H2);
    const base = lemon(p, 1);
    const pod = p.Podium > 0 && p.PodSet > 0 ? podium(p) : null;
    const baseArea = pod ? pod.area : p.Podium > 0 ? shoelace(base) : 0;
    const sum = (t) => t.floors.reduce((a, s) => a + s.area, 0);
    return {
      towers: [t1, t2], base, baseArea, pod,
      stats: {
        baseArea, podFloors: pod ? pod.floors : 0,
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
    Taper: 0.85, Inset: 5, CrownH: 20, CrownSlope: 15, Podium: 6, BaseScale: 1, Bulge: 0, BulgeZ: 120, TipR: 0, Shrink: 1,
    // рёбра (RibD 0 — нет) и общий этаж (PodSet 0 — весь «лимон», 1 — эллипс в разрыве)
    RibD: 0, RibStep: 9, RibH: 260, RibNose: 40, RibAsym: 0.8, PodSet: 0, PodK: 0.775, Sky: 1 };
  // полный набор параметров; у вариантов, сохранённых до появления Shrink, сужение — от центра
  const withDefaults = (params) => {
    const r = Object.assign({}, DEFAULTS, params);
    if (params && Object.keys(params).length && !('Shrink' in params)) r.Shrink = 0;
    return r;
  };
  return { build, DEFAULTS, scaleAt, withDefaults };
})();
if (typeof module !== 'undefined') module.exports = TowerGeom;
