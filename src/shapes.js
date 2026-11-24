// Auto-shape: turn a hand-drawn stroke into a clean line / polyline / triangle / rectangle / ellipse.
import { distToSeg } from './render.js';

function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const a = pts[0], b = pts[pts.length - 1];
  let dmax = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distToSeg(pts[i][0], pts[i][1], a, b);
    if (d > dmax) { dmax = d; idx = i; }
  }
  if (dmax <= eps) return [a, b];
  return rdp(pts.slice(0, idx + 1), eps).slice(0, -1).concat(rdp(pts.slice(idx), eps));
}

const turn = (a, b, c) => {
  const a1 = Math.atan2(b[1] - a[1], b[0] - a[0]), a2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
  let d = Math.abs(a2 - a1);
  return d > Math.PI ? 2 * Math.PI - d : d;
};

/** Remove near-collinear and near-duplicate vertices from a closed polygon. */
function cleanPolygon(v, minDist) {
  v = v.slice();
  let changed = true;
  while (changed && v.length > 3) {
    changed = false;
    for (let i = 0; i < v.length; i++) {
      const a = v[(i - 1 + v.length) % v.length], b = v[i], c = v[(i + 1) % v.length];
      if (turn(a, b, c) < 0.5 || Math.hypot(b[0] - a[0], b[1] - a[1]) < minDist) { v.splice(i, 1); changed = true; break; }
    }
  }
  return v;
}

function snapAngle(s, e) {
  const dx = e[0] - s[0], dy = e[1] - s[1];
  const ang = Math.atan2(dy, dx), len = Math.hypot(dx, dy);
  const step = Math.PI / 4, snapped = Math.round(ang / step) * step;
  return Math.abs(snapped - ang) < 0.1 ? [s, [s[0] + Math.cos(snapped) * len, s[1] + Math.sin(snapped) * len]] : [s, e];
}

/** @returns shape props {kind, pts?|cx,cy,rx,ry} or null if nothing recognised */
export function recognize(points) {
  const P = points.map((p) => [p[0], p[1]]);
  if (P.length < 4) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of P) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const w = x1 - x0, h = y1 - y0, diag = Math.hypot(w, h);
  if (diag < 16) return null;
  const s = P[0], e = P[P.length - 1];
  const len = Math.hypot(e[0] - s[0], e[1] - s[1]);

  // Straight line
  if (len > diag * 0.8) {
    let dev = 0;
    for (const p of P) dev = Math.max(dev, distToSeg(p[0], p[1], s, e));
    if (dev < Math.max(5, len * 0.07)) return { kind: 'line', pts: snapAngle(s, e) };
  }

  const closed = len < diag * 0.3;
  if (!closed) {
    const simp = rdp(P, diag * 0.07);
    return simp.length >= 3 && simp.length <= 4 ? { kind: 'polyline', pts: simp } : null;
  }

  // Ellipse: points sit close to the bbox-inscribed ellipse
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = w / 2, ry = h / 2;
  let err = 0;
  for (const p of P) err += Math.abs(Math.hypot((p[0] - cx) / (rx || 1), (p[1] - cy) / (ry || 1)) - 1);
  err /= P.length;
  if (err < 0.1) {
    // near-circle → perfect circle
    if (Math.abs(rx - ry) / Math.max(rx, ry) < 0.12) { const r = (rx + ry) / 2; return { kind: 'ellipse', cx, cy, rx: r, ry: r }; }
    return { kind: 'ellipse', cx, cy, rx, ry };
  }

  let poly = rdp(P, diag * 0.07);
  if (poly.length > 1) poly.pop(); // drop the closing point (≈ start)
  poly = cleanPolygon(poly, diag * 0.08);
  if (poly.length === 3) return { kind: 'polygon', pts: poly };
  if (poly.length === 4) {
    const aligned = poly.every((p, i) => {
      const q = poly[(i + 1) % 4];
      const a = Math.abs(Math.atan2(q[1] - p[1], q[0] - p[0])) % (Math.PI / 2);
      return a < 0.26 || a > Math.PI / 2 - 0.26;
    });
    return { kind: 'polygon', pts: aligned ? [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] : poly };
  }
  if (err < 0.16) return { kind: 'ellipse', cx, cy, rx, ry };
  if (poly.length <= 8) return { kind: 'polygon', pts: poly };
  return null;
}
