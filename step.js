/* STEP (ISO 10303-21) import for sheet metal parts: reads the B-rep of the folded part, finds the sheet thickness and
   the bends (pairs of coaxial cylinders one thickness apart), unfolds it with a K-factor and returns the flat pattern
   with its bend lines, ready to be written as a DXF. Flat faces and cylinders are recognised; bends exported as
   free-form surfaces are not. No library needed. */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ parser */

  function Reader(s) { this.s = s; this.p = 0; }
  Reader.prototype.ws = function () { while (this.p < this.s.length && /\s/.test(this.s[this.p])) this.p++; };
  Reader.prototype.value = function () {
    this.ws();
    var s = this.s, c = s[this.p], m;
    if (c === '#') { m = /^#(\d+)/.exec(s.slice(this.p, this.p + 20)); this.p += m[0].length; return { r: m[1] }; }
    if (c === "'") {
      var out = '', i = this.p + 1;
      for (;;) {
        var q = s.indexOf("'", i);
        if (q < 0) { out += s.slice(i); i = s.length; break; }
        out += s.slice(i, q);
        if (s[q + 1] === "'") { out += "'"; i = q + 2; } else { i = q + 1; break; }
      }
      this.p = i; return out;
    }
    if (c === '.') { var e = s.indexOf('.', this.p + 1); var name = s.slice(this.p + 1, e); this.p = e + 1; return { e: name }; }
    if (c === '$') { this.p++; return null; }
    if (c === '*') { this.p++; return '*'; }
    if (c === '(') return this.list();
    if (/[-+0-9]/.test(c)) { m = /^[-+]?[0-9]*\.?[0-9]*(?:[Ee][-+]?[0-9]+)?/.exec(s.slice(this.p, this.p + 40)); this.p += m[0].length; return parseFloat(m[0]); }
    m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(this.p, this.p + 80));
    if (m) { this.p += m[0].length; this.ws(); return { t: m[0].toUpperCase(), a: this.s[this.p] === '(' ? this.list() : [] }; }
    throw new Error('unexpected "' + c + '"');
  };
  Reader.prototype.list = function () {
    var out = [];
    this.p++;                                         // (
    this.ws();
    if (this.s[this.p] === ')') { this.p++; return out; }
    for (;;) {
      out.push(this.value());
      this.ws();
      var c = this.s[this.p++];
      if (c === ')') return out;
      if (c !== ',') throw new Error('expected , or )');
    }
  };

  /* Returns { id: {t, a} }; complex entities are { t: 'COMPLEX', parts: { NAME: args } }. */
  function parse(text) {
    var start = text.search(/\bDATA\s*;/);
    if (start < 0) throw new Error('This is not a STEP file (no DATA section).');
    var body = text.slice(start), E = {}, n = body.length, i = body.indexOf(';') + 1;
    while (i < n) {
      var j = i, inStr = false;
      for (; j < n; j++) {
        var c = body.charCodeAt(j);
        if (c === 39) inStr = !inStr; else if (c === 59 && !inStr) break;
      }
      var st = body.slice(i, j).trim();
      i = j + 1;
      if (!st) continue;
      if (/^ENDSEC$/i.test(st)) break;
      var m = /^#(\d+)\s*=\s*/.exec(st);
      if (!m) continue;
      try {
        var R = new Reader(st.slice(m[0].length));
        R.ws();
        if (R.s[R.p] === '(') {
          /* complex entity: ( A(...) B(...) ... ) with the parts side by side, no commas */
          var parts = {};
          R.p++;
          for (R.ws(); R.p < R.s.length && R.s[R.p] !== ')'; R.ws()) {
            var v = R.value();
            if (v && v.t) parts[v.t] = v.a;
          }
          E[m[1]] = { t: 'COMPLEX', parts: parts };
        } else E[m[1]] = R.value();
      } catch (err) { /* skip entities we cannot read */ }
    }
    return E;
  }

  /* ------------------------------------------------------------------ vectors */

  var sub = function (a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; };
  var add = function (a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; };
  var mul = function (a, k) { return [a[0] * k, a[1] * k, a[2] * k]; };
  var dot = function (a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; };
  var cross = function (a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; };
  var len = function (a) { return Math.sqrt(dot(a, a)); };
  var norm = function (a) { var l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  var dist = function (a, b) { return len(sub(a, b)); };
  var isT = function (v) { return v && v.e === 'T'; };

  /* ------------------------------------------------------------------ geometry from the entities */

  function Model(E) {
    this.E = E;
    this.scale = lengthScale(E);
    this.edgeCache = {};
  }

  function lengthScale(E) {
    for (var id in E) {
      var e = E[id];
      if (e.t !== 'COMPLEX' || !e.parts.LENGTH_UNIT) continue;
      if (e.parts.SI_UNIT) {
        var pre = e.parts.SI_UNIT[0];
        if (pre && pre.e === 'MILLI') return 1;
        if (pre && pre.e === 'CENTI') return 10;
        if (pre && pre.e === 'DECI') return 100;
        if (!pre || pre === '*') return 1000;
        return 1;
      }
      if (e.parts.CONVERSION_BASED_UNIT) {
        var nm = String(e.parts.CONVERSION_BASED_UNIT[0] || '');
        if (/INCH/i.test(nm)) return 25.4;
        if (/FOOT|FEET/i.test(nm)) return 304.8;
      }
    }
    return 1;
  }

  Model.prototype.get = function (ref) { return ref && ref.r ? this.E[ref.r] : null; };
  Model.prototype.part = function (e, name) { return !e ? null : e.t === name ? e.a : e.t === 'COMPLEX' ? e.parts[name] || null : null; };
  Model.prototype.point = function (ref) { var e = this.get(ref), s = this.scale; return e.a[1].map(function (v) { return v * s; }); };
  Model.prototype.dir = function (ref) { var e = this.get(ref); return norm(e.a[1]); };
  Model.prototype.placement = function (ref) {
    var e = this.get(ref), o = this.point(e.a[1]);
    var z = e.a[2] ? this.dir(e.a[2]) : [0, 0, 1];
    var x0 = e.a[3] ? this.dir(e.a[3]) : (Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
    var x = norm(sub(x0, mul(z, dot(x0, z))));
    return { o: o, z: z, x: x, y: cross(z, x) };
  };

  Model.prototype.surface = function (ref) {
    var e = this.get(ref);
    if (!e) return { kind: 'other' };
    if (e.t === 'PLANE') { var pl = this.placement(e.a[1]); return { kind: 'plane', o: pl.o, n: pl.z, x: pl.x, y: pl.y }; }
    if (e.t === 'CYLINDRICAL_SURFACE') { var c = this.placement(e.a[1]); return { kind: 'cyl', o: c.o, axis: c.z, x: c.x, y: c.y, r: e.a[2] * this.scale }; }
    return { kind: 'other', type: e.t };
  };

  /* Points along a curve from p1 to p2 (sense: the edge runs the same way as the curve's own direction). */
  Model.prototype.curvePts = function (ref, p1, p2, sense) {
    var e = this.get(ref), self = this;
    if (!e) return [p1, p2];
    var closed = dist(p1, p2) < 1e-6;
    if (e.t === 'LINE') return [p1, p2];
    if (e.t === 'SURFACE_CURVE' || e.t === 'SEAM_CURVE' || e.t === 'TRIMMED_CURVE') return this.curvePts(e.a[1], p1, p2, sense);
    if (e.t === 'POLYLINE') {
      var pts = e.a[1].map(function (r) { return self.point(r); });
      if (dist(pts[0], p1) > dist(pts[pts.length - 1], p1)) pts.reverse();
      pts[0] = p1; pts[pts.length - 1] = p2;
      return pts;
    }
    if (e.t === 'CIRCLE' || e.t === 'ELLIPSE') {
      var pl = this.placement(e.a[1]), r1 = e.a[2] * this.scale, r2 = e.t === 'ELLIPSE' ? e.a[3] * this.scale : r1;
      var ang = function (p) { var d = sub(p, pl.o); return Math.atan2(dot(d, pl.y) / r2, dot(d, pl.x) / r1); };
      var a1 = ang(p1), a2 = ang(p2);
      if (closed) a2 = a1 + (sense ? 2 : -2) * Math.PI;
      else if (sense) { while (a2 <= a1) a2 += 2 * Math.PI; }
      else { while (a2 >= a1) a2 -= 2 * Math.PI; }
      var n = Math.max(2, Math.ceil(Math.abs(a2 - a1) / (6 * Math.PI / 180))), out = [];
      for (var i = 0; i <= n; i++) {
        var a = a1 + (a2 - a1) * i / n;
        out.push(add(pl.o, add(mul(pl.x, r1 * Math.cos(a)), mul(pl.y, r2 * Math.sin(a)))));
      }
      out[0] = p1; out[n] = p2;
      return out;
    }
    var bs = this.part(e, 'B_SPLINE_CURVE_WITH_KNOTS');
    if (bs) {
      var head = e.t === 'COMPLEX' ? e.parts.B_SPLINE_CURVE : e.a.slice(1, 6);
      var knotsArgs = e.t === 'COMPLEX' ? bs : e.a.slice(6);
      var rat = this.part(e, 'RATIONAL_B_SPLINE_CURVE');
      var sp = bspline(head[0], head[1].map(function (r) { return self.point(r); }), knotsArgs[0], knotsArgs[1], rat ? rat[0] : null);
      if (sp.length) {
        if (dist(sp[0], p1) + (closed ? 0 : dist(sp[sp.length - 1], p2)) > dist(sp[sp.length - 1], p1) + (closed ? 0 : dist(sp[0], p2))) sp.reverse();
        sp[0] = p1; sp[sp.length - 1] = p2;
        return sp;
      }
    }
    return [p1, p2];
  };

  function bspline(deg, ctrl, mults, knots, weights) {
    var U = [];
    knots.forEach(function (k, i) { for (var m = 0; m < mults[i]; m++) U.push(k); });
    var n = ctrl.length, w = weights || ctrl.map(function () { return 1; });
    if (U.length !== n + deg + 1) return [];
    var t0 = U[deg], t1 = U[n], N = Math.max(8, n * 4), out = [];
    for (var s = 0; s <= N; s++) {
      var t = t0 + (t1 - t0) * s / N, k = deg;
      while (k < n - 1 && t >= U[k + 1]) k++;
      var d = [];
      for (var j = 0; j <= deg; j++) { var P = ctrl[k - deg + j], wj = w[k - deg + j]; d.push([P[0] * wj, P[1] * wj, P[2] * wj, wj]); }
      for (var r = 1; r <= deg; r++) {
        for (var jj = deg; jj >= r; jj--) {
          var i = k - deg + jj, den = U[i + deg - r + 1] - U[i], al = den ? (t - U[i]) / den : 0;
          for (var c = 0; c < 4; c++) d[jj][c] = (1 - al) * d[jj - 1][c] + al * d[jj][c];
        }
      }
      var h = d[deg];
      out.push([h[0] / h[3], h[1] / h[3], h[2] / h[3]]);
    }
    return out;
  }

  /* Edge: { id, v1, v2, pts (v1 -> v2) } */
  Model.prototype.edge = function (ref) {
    if (this.edgeCache[ref.r]) return this.edgeCache[ref.r];
    var e = this.get(ref);
    var p1 = this.point(this.get(e.a[1]).a[1]), p2 = this.point(this.get(e.a[2]).a[1]);
    var ed = { id: ref.r, pts: this.curvePts(e.a[3], p1, p2, isT(e.a[4])), curve: (this.get(e.a[3]) || {}).t };
    this.edgeCache[ref.r] = ed;
    return ed;
  };

  /* Face: { id, surf, loops: [{ outer, edges: [edge ids], pts: [ordered points] }] } */
  Model.prototype.face = function (ref) {
    var e = this.get(ref), self = this;
    var f = { id: ref.r, surf: this.surface(e.a[2]), sense: isT(e.a[3]), loops: [] };
    e.a[1].forEach(function (bref) {
      var b = self.get(bref), loop = self.get(b.a[1]);
      if (!loop || loop.t !== 'EDGE_LOOP') return;
      var L = { outer: b.t === 'FACE_OUTER_BOUND', edges: [], pts: [] };
      loop.a[1].forEach(function (oref) {
        var oe = self.get(oref), ed = self.edge(oe.a[3]);
        var pts = isT(oe.a[4]) ? ed.pts : ed.pts.slice().reverse();
        L.edges.push(ed.id);
        pts.forEach(function (p, i) { if (i < pts.length - 1 || !L.pts.length) L.pts.push(p); });
      });
      f.loops.push(L);
    });
    return f;
  };

  /* Faces of the largest solid in the file. */
  Model.prototype.faces = function (warns) {
    var E = this.E, self = this, shells = [];
    for (var id in E) {
      var e = E[id];
      if (e.t === 'MANIFOLD_SOLID_BREP' || e.t === 'BREP_WITH_VOIDS') {
        var sh = this.get(e.a[1]);
        if (sh) shells.push(sh.a[1]);
      }
    }
    if (!shells.length) {
      var all = [];
      for (var k in E) if (E[k].t === 'ADVANCED_FACE' || E[k].t === 'FACE_SURFACE') all.push({ r: k });
      shells.push(all);
    }
    shells.sort(function (a, b) { return b.length - a.length; });
    if (shells.length > 1) warns.push('The STEP file has ' + shells.length + ' bodies; the largest is used.');
    return shells[0].map(function (r) { return self.face(r); });
  };

  /* ------------------------------------------------------------------ sheet metal recognition */

  function planeFrame(f) { var s = f.surf; return { o: s.o, n: s.n, x: s.x, y: s.y }; }

  function area2(pts) {
    var a = 0;
    for (var i = 0; i < pts.length; i++) { var q = pts[(i + 1) % pts.length]; a += pts[i][0] * q[1] - q[0] * pts[i][1]; }
    return a / 2;
  }

  function faceArea(f) {
    var fr = planeFrame(f), A = 0, outerA = 0;
    var areas = f.loops.map(function (L) {
      return Math.abs(area2(L.pts.map(function (p) { var d = sub(p, fr.o); return [dot(d, fr.x), dot(d, fr.y)]; })));
    });
    var oi = f.loops.findIndex(function (L) { return L.outer; });
    if (oi < 0) { oi = 0; areas.forEach(function (a, i) { if (a > areas[oi]) oi = i; }); }
    areas.forEach(function (a, i) { if (i === oi) outerA = a; else A += a; });
    return Math.max(0, outerA - A);
  }

  function bbox2(f, fr) {
    var b = [Infinity, Infinity, -Infinity, -Infinity];
    f.loops.forEach(function (L) {
      L.pts.forEach(function (p) {
        var d = sub(p, fr.o), x = dot(d, fr.x), y = dot(d, fr.y);
        b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y);
      });
    });
    return b;
  }

  function overlap(a, b) {
    var w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
    return w > 0 && h > 0 ? w * h : 0;
  }

  /* Opposite faces: parallel planes facing each other (normals apart), with overlapping outlines. */
  function planePairs(planes) {
    var out = [];
    planes.forEach(function (f) { f.fr = planeFrame(f); f.bb = bbox2(f, f.fr); });
    for (var i = 0; i < planes.length; i++) {
      for (var j = i + 1; j < planes.length; j++) {
        var a = planes[i], b = planes[j];
        if (dot(a.fr.n, b.fr.n) > -0.9998 && dot(a.fr.n, b.fr.n) < 0.9998) continue;
        var d = Math.abs(dot(sub(b.fr.o, a.fr.o), a.fr.n));
        if (d < 0.05 || d > 30) continue;
        var ov = overlap(a.bb, bbox2(b, a.fr));
        if (ov <= 0) continue;
        out.push({ a: a, b: b, d: d, w: Math.min(a.area, b.area, ov) });
      }
    }
    return out;
  }

  function coaxial(c1, c2) {
    var a = c1.surf, b = c2.surf;
    if (Math.abs(dot(a.axis, b.axis)) < 0.9999) return false;
    var d = sub(b.o, a.o), off = sub(d, mul(a.axis, dot(d, a.axis)));
    return len(off) < 0.01;
  }

  /* opts: { k: K-factor } -> { thickness, radius, segs: [[[x,y],[x,y]]...], bends: [{p1, p2, angle, dir, radius, idx}],
     warns, info } */
  function unfold(text, opts) {
    var k = opts && isFinite(opts.k) ? +opts.k : 0.5;
    var warns = [];
    var M = new Model(parse(text));
    var faces = M.faces(warns);
    if (!faces.length) throw new Error('No faces found in the STEP file.');
    var planes = faces.filter(function (f) { return f.surf.kind === 'plane' && f.loops.length; });
    var cyls = faces.filter(function (f) { return f.surf.kind === 'cyl' && f.loops.length; });
    planes.forEach(function (f) { f.area = faceArea(f); });

    /* thickness: the most common distance between opposite faces, weighted by area */
    var pairs = planePairs(planes), hist = {};
    pairs.forEach(function (p) { var key = Math.round(p.d * 100); hist[key] = (hist[key] || 0) + p.w; });
    var best = null;
    Object.keys(hist).forEach(function (key) { if (best === null || hist[key] > hist[best]) best = key; });
    if (best === null) throw new Error('Could not find the sheet thickness: no opposite flat faces.');
    var t = +best / 100;
    pairs.forEach(function (p) {
      if (Math.abs(p.d - t) > 0.03) return;
      p.a.skin = true; p.b.skin = true;
      if (!p.a.partner || p.w > p.a.partnerW) { p.a.partner = p.b; p.a.partnerW = p.w; }
      if (!p.b.partner || p.w > p.b.partnerW) { p.b.partner = p.a; p.b.partnerW = p.w; }
    });

    /* bends: coaxial cylinders one thickness apart */
    cyls.forEach(function (c) {
      cyls.forEach(function (d) {
        if (c === d || !coaxial(c, d)) return;
        if (Math.abs(Math.abs(c.surf.r - d.surf.r) - t) < 0.03) { c.skin = true; c.partner = d; }
      });
    });
    var otherSurf = faces.filter(function (f) { return f.surf.kind === 'other'; }).length;

    /* faces of each edge, then the two skins (top and bottom) as connected groups of skin faces */
    var edgeFaces = {};
    faces.forEach(function (f) { f.loops.forEach(function (L) { L.edges.forEach(function (id) { (edgeFaces[id] = edgeFaces[id] || []).push(f); }); }); });
    var skinFaces = faces.filter(function (f) { return f.skin; });
    var comp = new Map(), groups = [];
    skinFaces.forEach(function (f) {
      if (comp.has(f)) return;
      var g = [f], q = [f];
      comp.set(f, groups.length);
      while (q.length) {
        var c = q.pop();
        c.loops.forEach(function (L) {
          L.edges.forEach(function (id) {
            edgeFaces[id].forEach(function (o) {
              if (o === c || !o.skin || comp.has(o)) return;
              if (o.surf.kind === 'plane' && c.surf.kind === 'plane') return;   // flange to flange only through a bend
              comp.set(o, groups.length); g.push(o); q.push(o);
            });
          });
        });
      }
      groups.push(g);
    });
    /* use the skin that is on the inside of most bends (most bends Up), then the largest */
    var score = function (g) {
      var inner = 0, A = 0;
      g.forEach(function (f) { if (f.surf.kind === 'cyl') { if (f.surf.r < f.partner.surf.r) inner++; } else A += f.area; });
      return inner * 1e9 + A;
    };
    groups.sort(function (a, b) { return score(b) - score(a); });
    var skin = groups[0];
    if (!skin) throw new Error('Could not recognise the part as sheet metal.');
    var skinSet = new Set(skin);
    var flanges = skin.filter(function (f) { return f.surf.kind === 'plane'; });
    var bendFaces = skin.filter(function (f) { return f.surf.kind === 'cyl'; });
    var skinArea = flanges.reduce(function (s, f) { return s + f.area; }, 0);
    var allSkinPlanes = planes.filter(function (f) { return f.skin; }).reduce(function (s, f) { return s + f.area; }, 0);
    if (skinArea < allSkinPlanes * 0.35) warns.push('Only part of the sheet was recognised; some flanges may be missing from the flat pattern.');

    /* each bend joins two flanges of the skin */
    var bendInfo = [];
    bendFaces.forEach(function (c) {
      var nb = [];
      c.loops.forEach(function (L) {
        L.edges.forEach(function (id) {
          edgeFaces[id].forEach(function (o) {
            if (o !== c && skinSet.has(o) && o.surf.kind === 'plane') {
              var hit = nb.filter(function (x) { return x.f === o; })[0];
              if (!hit) nb.push(hit = { f: o, edges: [] });
              hit.edges.push(id);
            }
          });
        });
      });
      if (nb.length !== 2) { warns.push('A bend that does not join two flanges was left out.'); return; }
      bendInfo.push({ c: c, a: nb[0], b: nb[1] });
    });

    /* unfold: start at the largest flange, view it from the skin's outer side */
    var root = flanges.slice().sort(function (a, b) { return b.area - a.area; })[0];
    var nOut = root.surf.n;
    if (root.partner && dot(sub(root.surf.o, root.partner.surf.o), nOut) < 0) nOut = mul(nOut, -1);
    var ex = root.surf.x, ey = cross(nOut, ex);
    var maps = new Map();
    var mk = function (O, ax, ay, O2, E1, E2) {
      return {
        O: O, ax: ax, ay: ay, O2: O2, E1: E1, E2: E2,
        f: function (x) { var d = sub(x, O), u = dot(d, ax), v = dot(d, ay); return [O2[0] + E1[0] * u + E2[0] * v, O2[1] + E1[1] * u + E2[1] * v]; },
        lin: function (v3) { var u = dot(v3, ax), v = dot(v3, ay); return [E1[0] * u + E2[0] * v, E1[1] * u + E2[1] * v]; }
      };
    };
    maps.set(root, mk(root.surf.o, ex, ey, [0, 0], [1, 0], [0, 1]));
    var bends = [], cylMaps = new Map(), queue = [root];
    var used = new Set();
    while (queue.length) {
      var P = queue.shift(), TP = maps.get(P);
      bendInfo.forEach(function (bi, bidx) {
        if (used.has(bi)) return;
        var side = bi.a.f === P ? [bi.a, bi.b] : bi.b.f === P ? [bi.b, bi.a] : null;
        if (!side) return;
        used.add(bi);
        var Q = side[1].f, cs = bi.c.surf, ax = cs.axis;
        var sOf = function (x) { return dot(sub(x, cs.o), ax); };
        var radial = function (x) { var d = sub(x, cs.o); return sub(d, mul(ax, dot(d, ax))); };
        var xP = M.edgeCache[side[0].edges[0]].pts[0], xQ = M.edgeCache[side[1].edges[0]].pts[0];
        var rP = norm(radial(xP)), rQ = norm(radial(xQ));
        var th = Math.acos(Math.max(-1, Math.min(1, dot(rP, rQ))));
        if (th > Math.PI - 0.01 || th < 0.001) { warns.push('A bend of 180° (hem) or 0° was left out.'); return; }
        var Rs = cs.r, Rp = bi.c.partner.surf.r, Ri = Math.min(Rs, Rp);
        var BA = th * (Ri + k * t);
        var tn = norm(sub(rQ, mul(rP, dot(rQ, rP))));          // along the arc from P towards Q
        var wQ = mul(norm(sub(rP, mul(rQ, dot(rP, rQ)))), -1);  // in Q's plane, away from the bend
        var U = TP.lin(ax), W = TP.lin(mul(tn, -1));            // W points into P in the flat
        var B2 = TP.f(xP), sP = sOf(xP);
        var minus = function (a, b) { return [a[0] - b[0], a[1] - b[1]]; };
        if (!maps.has(Q)) {
          var O2 = [B2[0] + U[0] * (sOf(xQ) - sP) - W[0] * BA, B2[1] + U[1] * (sOf(xQ) - sP) - W[1] * BA];
          maps.set(Q, mk(xQ, ax, wQ, O2, U, [-W[0], -W[1]]));
          queue.push(Q);
        } else warns.push('A bend closes a loop of flanges; its position comes from one side only.');
        var cmap = function (x) {
          var r = norm(radial(x)), phi = Math.atan2(dot(r, tn), dot(r, rP));
          phi = Math.max(0, Math.min(th, phi));
          var s = sOf(x) - sP, d = BA * phi / th;
          return [B2[0] + U[0] * s - W[0] * d, B2[1] + U[1] * s - W[1] * d];
        };
        cylMaps.set(bi.c, cmap);
        var s0 = Infinity, s1 = -Infinity;
        bi.c.loops.forEach(function (L) { L.pts.forEach(function (p) { var s = sOf(p); s0 = Math.min(s0, s); s1 = Math.max(s1, s); }); });
        var at = function (s) { return [B2[0] + U[0] * (s - sP) - W[0] * BA / 2, B2[1] + U[1] * (s - sP) - W[1] * BA / 2]; };
        bends.push({
          p1: at(s0), p2: at(s1), angle: Math.round((180 - th * 180 / Math.PI) * 10) / 10,
          dir: Rs < Rp ? 'UP' : 'DOWN', radius: Math.round(Ri * 100) / 100, idx: bidx
        });
      });
    }
    var missing = flanges.filter(function (f) { return !maps.has(f); }).length;
    if (missing) warns.push(missing + ' flange(s) are not joined to the rest by a recognised bend and were left out' +
      (otherSurf ? ' (the part has ' + otherSurf + ' free-form face(s); a bend made of those is not recognised).' : '.'));

    /* outline: flange edges and the sides of the bend strips; edges between a flange and its bend are inside */
    var segs = [];
    var emit = function (pts) { for (var i = 1; i < pts.length; i++) segs.push([pts[i - 1], pts[i]]); };
    flanges.forEach(function (f) {
      var T = maps.get(f);
      if (!T) return;
      f.loops.forEach(function (L) {
        L.edges.forEach(function (id) {
          var inner = edgeFaces[id].some(function (o) { return o !== f && cylMaps.has(o); });
          if (!inner) emit(M.edgeCache[id].pts.map(T.f));
        });
      });
    });
    cylMaps.forEach(function (cm, c) {
      c.loops.forEach(function (L) {
        L.edges.forEach(function (id) {
          var inner = edgeFaces[id].some(function (o) { return o !== c && maps.has(o); });
          if (!inner) emit(M.edgeCache[id].pts.map(cm));
        });
      });
    });
    if (!segs.length) throw new Error('Could not unfold the part.');

    /* move the flat pattern to x, y >= 0 */
    var mnx = Infinity, mny = Infinity;
    segs.forEach(function (g) { g.forEach(function (p) { mnx = Math.min(mnx, p[0]); mny = Math.min(mny, p[1]); }); });
    var mv = function (p) { return [p[0] - mnx, p[1] - mny]; };
    segs = segs.map(function (g) { return [mv(g[0]), mv(g[1])]; }).filter(function (g) { return dist([g[0][0], g[0][1], 0], [g[1][0], g[1][1], 0]) > 1e-6; });
    bends.forEach(function (b) { b.p1 = mv(b.p1); b.p2 = mv(b.p2); });
    /* A bend cut in two by a slot or cut-out is still one stroke of the press: join bends on one line with the same
       angle and direction. */
    var merged = [];
    bends.forEach(function (b) {
      var dx = b.p2[0] - b.p1[0], dy = b.p2[1] - b.p1[1], L = Math.hypot(dx, dy);
      var off = function (p) { return Math.abs((p[0] - b.p1[0]) * dy - (p[1] - b.p1[1]) * dx) / L; };
      var same = merged.filter(function (m) {
        return Math.abs(m.angle - b.angle) < 0.5 && m.dir === b.dir && off(m.p1) < 0.05 && off(m.p2) < 0.05;
      })[0];
      if (!same) { merged.push(b); return; }
      var ux = dx / L, uy = dy / L, pts = [same.p1, same.p2, b.p1, b.p2];
      var t = pts.map(function (p) { return (p[0] - b.p1[0]) * ux + (p[1] - b.p1[1]) * uy; });
      var lo = Math.min.apply(null, t), hi = Math.max.apply(null, t);
      same.p1 = [b.p1[0] + ux * lo, b.p1[1] + uy * lo]; same.p2 = [b.p1[0] + ux * hi, b.p1[1] + uy * hi];
    });
    bends = merged;
    var radii = bends.map(function (b) { return b.radius; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
    return { thickness: Math.round(t * 1000) / 1000, radii: radii, k: k, segs: segs, bends: bends, warns: warns };
  }

  /* Flat pattern as an ASCII DXF: outline on layer CUT, bend lines dashed on layer BEND. */
  function toDxf(flat) {
    var f = function (v) { return (Math.round(v * 1e6) / 1e6).toString(); };
    var out = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC',
      '0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LTYPE', '70', '1',
      '0', 'LTYPE', '2', 'DASHED', '70', '0', '3', 'Dashed', '72', '65', '73', '2', '40', '15.0', '49', '10.0', '49', '-5.0',
      '0', 'ENDTAB', '0', 'TABLE', '2', 'LAYER', '70', '2',
      '0', 'LAYER', '2', 'CUT', '70', '0', '62', '7', '6', 'CONTINUOUS',
      '0', 'LAYER', '2', 'BEND', '70', '0', '62', '1', '6', 'DASHED', '0', 'ENDTAB', '0', 'ENDSEC',
      '0', 'SECTION', '2', 'ENTITIES'];
    var line = function (layer, p, q) { out.push('0', 'LINE', '8', layer, '10', f(p[0]), '20', f(p[1]), '11', f(q[0]), '21', f(q[1])); };
    flat.segs.forEach(function (g) { line('CUT', g[0], g[1]); });
    flat.bends.forEach(function (b) { line('BEND', b.p1, b.p2); });
    out.push('0', 'ENDSEC', '0', 'EOF');
    return out.join('\n') + '\n';
  }

  window.STEP = { parse: parse, unfold: unfold, toDxf: toDxf };
})();
