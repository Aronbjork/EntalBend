/* EntalBend – DXF parsing and bend-line geometry.
 * Plain ASCII DXF only. Units are assumed to be millimetres (use the scale field otherwise).
 * Works in the browser (global DXF) and in Node (module.exports) for testing.
 */
(function (root) {
  'use strict';

  var SIGNIFICANT_UNSUPPORTED = { INSERT: 1, SPLINE: 1, ELLIPSE: 1 };

  function get(rec, code) {
    for (var i = 0; i < rec.length; i++) if (rec[i][0] === code) return rec[i][1];
    return undefined;
  }
  function num(v, d) {
    var n = parseFloat(v);
    return isFinite(n) ? n : (d === undefined ? 0 : d);
  }

  /* ---------- parsing ---------- */

  function parse(text) {
    if (/^AutoCAD Binary DXF/.test(text)) {
      throw new Error('Binary DXF is not supported. Save the file as ASCII DXF.');
    }
    var lines = text.split(/\r\n|\r|\n/);
    var pairs = [];
    var i = 0;
    while (i + 1 < lines.length) {
      var code = parseInt(lines[i].trim(), 10);
      if (isNaN(code)) { i += 1; continue; }
      pairs.push([code, lines[i + 1].trim()]);
      i += 2;
    }

    var data = { layers: {}, ltypes: [], entities: [], unsupported: {} };
    var section = null;
    var k = 0;
    var buf = [];

    function readRecord() {
      var rec = [pairs[k]];
      k++;
      while (k < pairs.length && pairs[k][0] !== 0) { rec.push(pairs[k]); k++; }
      return rec;
    }

    while (k < pairs.length) {
      var c = pairs[k][0], v = pairs[k][1];
      if (c === 0 && v === 'SECTION') {
        k++;
        section = (pairs[k] && pairs[k][0] === 2) ? pairs[k][1].toUpperCase() : null;
        k++;
        continue;
      }
      if (c === 0 && v === 'ENDSEC') { section = null; k++; continue; }
      if (c === 0 && v === 'EOF') break;
      if (c !== 0) { k++; continue; }
      var rec = readRecord();
      var type = rec[0][1].toUpperCase();
      if (section === 'TABLES') {
        if (type === 'LAYER') {
          var lname = get(rec, 2);
          if (lname !== undefined) data.layers[lname] = { ltype: get(rec, 6) || 'CONTINUOUS' };
        } else if (type === 'LTYPE') {
          var tname = get(rec, 2);
          if (tname) data.ltypes.push(tname);
        }
      } else if (section === 'ENTITIES') {
        buf.push({ type: type, rec: rec });
      }
    }

    var id = 0;
    var curPoly = null;
    buf.forEach(function (item) {
      var type = item.type, rec = item.rec;
      if (curPoly) {
        if (type === 'VERTEX') {
          curPoly.pts.push([num(get(rec, 10)), num(get(rec, 20)), num(get(rec, 42))]);
          return;
        }
        if (type === 'SEQEND') { data.entities.push(curPoly); curPoly = null; return; }
      }
      var base = { layer: get(rec, 8) || '0', ltype: get(rec, 6) || 'BYLAYER' };
      var ent = null;
      if (type === 'LINE') {
        ent = { type: 'LINE', p1: [num(get(rec, 10)), num(get(rec, 20))], p2: [num(get(rec, 11)), num(get(rec, 21))] };
      } else if (type === 'LWPOLYLINE') {
        var pts = [], flags = 0;
        rec.forEach(function (pr) {
          var cc = pr[0], vv = pr[1];
          if (cc === 70) flags = parseInt(vv, 10) || 0;
          else if (cc === 10) pts.push([parseFloat(vv), 0, 0]);
          else if (cc === 20 && pts.length) pts[pts.length - 1][1] = parseFloat(vv);
          else if (cc === 42 && pts.length) pts[pts.length - 1][2] = parseFloat(vv);
        });
        if (pts.length >= 2) ent = { type: 'POLY', pts: pts, closed: !!(flags & 1) };
      } else if (type === 'POLYLINE') {
        curPoly = { type: 'POLY', pts: [], closed: !!((parseInt(get(rec, 70), 10) || 0) & 1), layer: base.layer, ltype: base.ltype, id: 'E' + (++id) };
        return;
      } else if (type === 'ARC') {
        ent = { type: 'ARC', c: [num(get(rec, 10)), num(get(rec, 20))], r: num(get(rec, 40)), a0: num(get(rec, 50)), a1: num(get(rec, 51)) };
      } else if (type === 'CIRCLE') {
        ent = { type: 'CIRCLE', c: [num(get(rec, 10)), num(get(rec, 20))], r: num(get(rec, 40)) };
      } else if (SIGNIFICANT_UNSUPPORTED[type]) {
        data.unsupported[type] = (data.unsupported[type] || 0) + 1;
      }
      if (ent) {
        ent.layer = base.layer; ent.ltype = base.ltype; ent.id = 'E' + (++id);
        data.entities.push(ent);
      }
    });
    if (curPoly) data.entities.push(curPoly);

    if (!data.entities.length) throw new Error('No supported geometry found (LINE, POLYLINE, ARC, CIRCLE).');
    return data;
  }

  /* ---------- tessellation ---------- */

  function arcPts(c, r, a0, sweep) {
    var n = Math.max(6, Math.ceil(Math.abs(sweep) / (Math.PI / 36)));
    var out = [];
    for (var i = 0; i <= n; i++) {
      var a = a0 + sweep * i / n;
      out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
    }
    return out;
  }

  function bulgePoints(p, q, b) {
    var dx = q[0] - p[0], dy = q[1] - p[1];
    var chord = Math.hypot(dx, dy);
    if (chord < 1e-9) return [[p[0], p[1]], [q[0], q[1]]];
    var mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
    var off = (chord / 2) * (1 - b * b) / (2 * b);
    var cx = mx + (-dy / chord) * off, cy = my + (dx / chord) * off;
    var r = Math.hypot(p[0] - cx, p[1] - cy);
    var a0 = Math.atan2(p[1] - cy, p[0] - cx);
    var sweep = 4 * Math.atan(b);
    return arcPts([cx, cy], r, a0, sweep);
  }

  function explode(ent, s) {
    var out = [];
    var P = function (p) { return [p[0] * s, p[1] * s]; };
    function mk(extra) {
      var o = { layer: ent.layer, ltype: ent.ltype };
      for (var key in extra) o[key] = extra[key];
      return o;
    }
    if (ent.type === 'LINE') {
      out.push(mk({ id: ent.id, kind: 'line', p1: P(ent.p1), p2: P(ent.p2) }));
    } else if (ent.type === 'POLY') {
      var n = ent.pts.length;
      var segs = ent.closed ? n : n - 1;
      for (var i = 0; i < segs; i++) {
        var a = ent.pts[i], b = ent.pts[(i + 1) % n];
        if (Math.abs(a[2]) < 1e-9) {
          out.push(mk({ id: ent.id + '.' + i, kind: 'line', p1: P(a), p2: P(b) }));
        } else {
          out.push(mk({ id: ent.id + '.' + i, kind: 'path', pts: bulgePoints(a, b, a[2]).map(P) }));
        }
      }
    } else if (ent.type === 'ARC') {
      var a0 = ent.a0 * Math.PI / 180, a1 = ent.a1 * Math.PI / 180;
      if (a1 <= a0) a1 += 2 * Math.PI;
      out.push(mk({ id: ent.id, kind: 'path', pts: arcPts(ent.c, ent.r, a0, a1 - a0).map(P) }));
    } else if (ent.type === 'CIRCLE') {
      out.push(mk({ id: ent.id, kind: 'path', pts: arcPts(ent.c, ent.r, 0, 2 * Math.PI).map(P) }));
    }
    return out;
  }

  function isDashed(piece, data) {
    var lt = (piece.ltype || 'BYLAYER').toUpperCase();
    if (lt === 'BYLAYER') {
      var L = data.layers[piece.layer];
      lt = L ? (L.ltype || 'CONTINUOUS').toUpperCase() : 'CONTINUOUS';
    }
    return lt !== 'CONTINUOUS' && lt !== 'BYBLOCK' && lt !== '';
  }

  /* ---------- model: outline + merged bend lines ---------- */

  function buildModel(data, opts) {
    var o = {
      useLinetype: true, bendLayers: new Set(), ignoreLayers: new Set(), forced: new Map(),
      gap: 6, minLen: 5, scale: 1
    };
    for (var key in opts) o[key] = opts[key];

    var pieces = [];
    data.entities.forEach(function (ent) {
      if (o.ignoreLayers.has(ent.layer)) return;
      explode(ent, o.scale).forEach(function (p) { pieces.push(p); });
    });

    var outline = [], cand = [];
    pieces.forEach(function (p) {
      if (p.kind === 'line') {
        var bend;
        if (o.forced.has(p.id)) bend = o.forced.get(p.id);
        else bend = (o.useLinetype && isDashed(p, data)) || o.bendLayers.has(p.layer);
        (bend ? cand : outline).push(p);
      } else {
        outline.push(p);
      }
    });

    /* merge collinear / overlapping / exploded-dash segments into single bend lines */
    var items = [];
    cand.forEach(function (p) {
      var dx = p.p2[0] - p.p1[0], dy = p.p2[1] - p.p1[1];
      var len = Math.hypot(dx, dy);
      if (len < 1e-6) return;
      items.push({ p: p, len: len, dx: dx / len, dy: dy / len });
    });
    var parent = items.map(function (_, idx) { return idx; });
    function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }
    var sinTol = Math.sin(0.3 * Math.PI / 180), perpTol = 0.2;
    for (var a = 0; a < items.length; a++) {
      for (var b = a + 1; b < items.length; b++) {
        var A = items[a], B = items[b];
        if (Math.abs(A.dx * B.dy - A.dy * B.dx) > sinTol) continue;
        var d1 = Math.abs((B.p.p1[0] - A.p.p1[0]) * A.dy - (B.p.p1[1] - A.p.p1[1]) * A.dx);
        var d2 = Math.abs((B.p.p2[0] - A.p.p1[0]) * A.dy - (B.p.p2[1] - A.p.p1[1]) * A.dx);
        if (d1 > perpTol || d2 > perpTol) continue;
        var t1 = (B.p.p1[0] - A.p.p1[0]) * A.dx + (B.p.p1[1] - A.p.p1[1]) * A.dy;
        var t2 = (B.p.p2[0] - A.p.p1[0]) * A.dx + (B.p.p2[1] - A.p.p1[1]) * A.dy;
        var lo = Math.min(t1, t2), hi = Math.max(t1, t2);
        var gap = Math.max(lo, 0) - Math.min(hi, A.len);
        if (gap <= o.gap) parent[find(b)] = find(a);
      }
    }
    var groups = new Map();
    items.forEach(function (it, idx) {
      var r = find(idx);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(it);
    });

    var bends = [];
    groups.forEach(function (members) {
      var rep = members[0];
      members.forEach(function (m) { if (m.len > rep.len) rep = m; });
      var ox = rep.p.p1[0], oy = rep.p.p1[1];
      var tmin = Infinity, tmax = -Infinity;
      var ids = [];
      members.forEach(function (m) {
        ids.push(m.p.id);
        [m.p.p1, m.p.p2].forEach(function (pt) {
          var t = (pt[0] - ox) * rep.dx + (pt[1] - oy) * rep.dy;
          if (t < tmin) tmin = t;
          if (t > tmax) tmax = t;
        });
      });
      var len = tmax - tmin;
      if (len < o.minLen) return;
      bends.push({
        p1: [ox + rep.dx * tmin, oy + rep.dy * tmin],
        p2: [ox + rep.dx * tmax, oy + rep.dy * tmax],
        len: len, members: ids
      });
    });
    bends.sort(function (u, v) {
      var ux = (u.p1[0] + u.p2[0]) / 2, vx = (v.p1[0] + v.p2[0]) / 2;
      if (Math.abs(ux - vx) > 1e-6) return ux - vx;
      return (u.p1[1] + u.p2[1]) / 2 - (v.p1[1] + v.p2[1]) / 2;
    });
    bends.forEach(function (bd, idx) { bd.id = 'B' + (idx + 1); });

    var outlinePts = [];
    outline.forEach(function (p) {
      if (p.kind === 'line') { outlinePts.push(p.p1, p.p2); }
      else p.pts.forEach(function (q) { outlinePts.push(q); });
    });

    var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    function grow(pt) {
      if (pt[0] < minx) minx = pt[0];
      if (pt[0] > maxx) maxx = pt[0];
      if (pt[1] < miny) miny = pt[1];
      if (pt[1] > maxy) maxy = pt[1];
    }
    outlinePts.forEach(grow);
    bends.forEach(function (bd) { grow(bd.p1); grow(bd.p2); });
    if (!isFinite(minx)) { minx = 0; miny = 0; maxx = 1; maxy = 1; }

    return {
      outline: outline, outlinePts: outlinePts, bends: bends,
      bbox: { minx: minx, miny: miny, maxx: maxx, maxy: maxy },
      sheet: (function () {
        var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        outlinePts.forEach(function (pt) {
          if (pt[0] < x0) x0 = pt[0]; if (pt[0] > x1) x1 = pt[0];
          if (pt[1] < y0) y0 = pt[1]; if (pt[1] > y1) y1 = pt[1];
        });
        return isFinite(x0) ? { w: x1 - x0, h: y1 - y0 } : { w: 0, h: 0 };
      })()
    };
  }

  /* ---------- bend metrics ---------- */

  /* sign +1 = left of the p1->p2 direction ("A"), -1 = right ("B") */
  function sideExtent(bend, sign, pts) {
    var dx = (bend.p2[0] - bend.p1[0]) / bend.len, dy = (bend.p2[1] - bend.p1[1]) / bend.len;
    var nx = -dy, ny = dx, max = 0;
    for (var i = 0; i < pts.length; i++) {
      var s = ((pts[i][0] - bend.p1[0]) * nx + (pts[i][1] - bend.p1[1]) * ny) * sign;
      if (s > max) max = s;
    }
    return max;
  }

  /* default gauge side = the shorter flange (the one that has material) */
  function defaultSide(bend, pts) {
    var eA = sideExtent(bend, 1, pts), eB = sideExtent(bend, -1, pts);
    if (eA <= 1e-6) return -1;
    if (eB <= 1e-6) return 1;
    return eA <= eB ? 1 : -1;
  }

  /* Is the earlier bend `bm` lying on the gauged flange of bend `bk`?
   * Returns the distance from bk to bm, or null. */
  function sameFlange(bk, signK, bm, extentK) {
    var kx = (bk.p2[0] - bk.p1[0]) / bk.len, ky = (bk.p2[1] - bk.p1[1]) / bk.len;
    var mx = (bm.p2[0] - bm.p1[0]) / bm.len, my = (bm.p2[1] - bm.p1[1]) / bm.len;
    if (Math.abs(kx * my - ky * mx) > 0.0175) return null;
    var nx = -ky * signK, ny = kx * signK;
    var cx = (bm.p1[0] + bm.p2[0]) / 2, cy = (bm.p1[1] + bm.p2[1]) / 2;
    var s = (cx - bk.p1[0]) * nx + (cy - bk.p1[1]) * ny;
    if (s > 0.5 && s < extentK - 0.01) return s;
    return null;
  }


  /* Distance from the bend line to the edge the backgauge really touches on one side: the farthest edge that is at
     least minW wide along the bend direction. Small tabs narrower than minW are ignored. minW <= 0 gives sideExtent. */
  function gaugeExtent(bend, sign, segs, pts, minW) {
    var ext = sideExtent(bend, sign, pts);
    if (!(minW > 0) || !segs || !segs.length) return ext;
    var dx = (bend.p2[0] - bend.p1[0]) / bend.len, dy = (bend.p2[1] - bend.p1[1]) / bend.len;
    var nx = -dy * sign, ny = dx * sign;
    var map = function (p) { return [(p[0] - bend.p1[0]) * dx + (p[1] - bend.p1[1]) * dy, (p[0] - bend.p1[0]) * nx + (p[1] - bend.p1[1]) * ny]; };
    var ms = segs.map(function (g) { return [map(g[0]), map(g[1])]; });
    var tmin = Infinity, tmax = -Infinity, cand = {};
    ms.forEach(function (g) {
      g.forEach(function (p) {
        tmin = Math.min(tmin, p[0]); tmax = Math.max(tmax, p[0]);
        if (p[1] > 0.5 && p[1] <= ext + 1e-6) { var key = Math.round(p[1] * 10); if (cand[key] === undefined || p[1] > cand[key]) cand[key] = p[1]; }
      });
    });
    var list = Object.keys(cand).map(function (k) { return cand[k]; }).sort(function (a, b) { return b - a; });
    var inside = function (t, s) {
      var c = 0;
      for (var i = 0; i < ms.length; i++) {
        var a = ms[i][0], e = ms[i][1];
        if ((a[1] > s) !== (e[1] > s) && a[0] + (s - a[1]) / (e[1] - a[1]) * (e[0] - a[0]) > t) c++;
      }
      return c % 2 === 1;
    };
    for (var k = 0; k < list.length; k++) {
      var s = list[k] - 0.05, run = 0, best = 0;
      for (var t = tmin; t <= tmax; t += 1) {
        if (inside(t, s)) { run++; if (run > best) best = run; } else run = 0;
      }
      if (best >= minW) return list[k];
    }
    return ext;
  }

  var api = { parse: parse, buildModel: buildModel, sideExtent: sideExtent, gaugeExtent: gaugeExtent, defaultSide: defaultSide, sameFlange: sameFlange };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DXF = api;
})(typeof window !== 'undefined' ? window : this);
