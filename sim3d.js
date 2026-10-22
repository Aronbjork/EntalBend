/* 3D bend simulator (three.js). Folds the flat pattern bend by bend and places it on the press brake:
   the current bend line sits over the die, the gauged flange points to the backgauge.
   Machine axes on screen: x = across the machine (Z1 left of centre, Z2 right), y = up, z = towards the
   operator. Z1/Z2 move the fingers sideways, R1/R2 their support height above the die top. */
(function () {
  'use strict';

  var S = null;           // renderer state
  var meshKey = null, tris = null, topo = null, topoKey = null;
  var DIE_H = 48, DIE_W = 60, TABLE_W = 2500;

  function V3(x, y, z) { return new THREE.Vector3(x, y, z); }

  /* ---------------------------------------------------------------- flat pattern to triangles */

  function buildLoops(segs) {
    var key = function (p) { return Math.round(p[0] * 50) + ',' + Math.round(p[1] * 50); };
    var map = {};
    segs.forEach(function (g, i) {
      [0, 1].forEach(function (e) { var k = key(g[e]); (map[k] = map[k] || []).push([i, e]); });
    });
    var used = new Array(segs.length), loops = [];
    for (var i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      var pts = [segs[i][0], segs[i][1]], endKey = key(segs[i][1]), startKey = key(segs[i][0]), guard = 0;
      while (endKey !== startKey && guard++ < 100000) {
        var next = null, c = map[endKey] || [];
        for (var j = 0; j < c.length; j++) if (!used[c[j][0]]) { next = c[j]; break; }
        if (!next) break;
        used[next[0]] = true;
        var other = segs[next[0]][1 - next[1]];
        pts.push(other); endKey = key(other);
      }
      if (endKey === startKey && pts.length >= 4) { pts.pop(); loops.push(pts); }
    }
    return loops;
  }

  function area(p) {
    var a = 0;
    for (var i = 0; i < p.length; i++) { var q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; }
    return a / 2;
  }

  function pointIn(poly, x, y) {
    var c = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      if ((poly[i][1] > y) !== (poly[j][1] > y) &&
          x < (poly[j][0] - poly[i][0]) * (y - poly[i][1]) / (poly[j][1] - poly[i][1]) + poly[i][0]) c = !c;
    }
    return c;
  }

  /* Split a convex polygon by the line through p0 with direction d; returns [polygons]. */
  function splitPoly(poly, p0, d) {
    var f = poly.map(function (p) { return d[0] * (p[1] - p0[1]) - d[1] * (p[0] - p0[0]); });
    var eps = 1e-6, pos = false, neg = false;
    f.forEach(function (v) { if (v > eps) pos = true; if (v < -eps) neg = true; });
    if (!(pos && neg)) return [poly];
    var A = [], B = [];
    for (var i = 0; i < poly.length; i++) {
      var j = (i + 1) % poly.length, p = poly[i], q = poly[j], fi = f[i], fj = f[j];
      if (fi >= -eps) A.push(p);
      if (fi <= eps) B.push(p);
      if ((fi > eps && fj < -eps) || (fi < -eps && fj > eps)) {
        var t = fi / (fi - fj), m = [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])];
        A.push(m); B.push(m);
      }
    }
    return [A, B].filter(function (x) { return x.length >= 3; });
  }

  function buildTris(segs, bends) {
    var loops = buildLoops(segs);
    if (!loops.length) return [];
    loops.sort(function (a, b) { return Math.abs(area(b)) - Math.abs(area(a)); });
    var outer = loops[0], holes = [];
    for (var i = 1; i < loops.length; i++) if (pointIn(outer, loops[i][0][0], loops[i][0][1])) holes.push(loops[i]);
    var toV = function (p) { return new THREE.Vector2(p[0], p[1]); };
    var all = outer.concat.apply(outer, holes);
    var faces = THREE.ShapeUtils.triangulateShape(outer.map(toV), holes.map(function (h) { return h.map(toV); }));
    var list = faces.map(function (f) { return [all[f[0]], all[f[1]], all[f[2]]]; });
    bends.forEach(function (b) {
      var d = [b.p2[0] - b.p1[0], b.p2[1] - b.p1[1]], next = [];
      list.forEach(function (poly) {
        splitPoly(poly, b.p1, d).forEach(function (piece) {
          for (var k = 1; k + 1 < piece.length; k++) next.push([piece[0], piece[k], piece[k + 1]]);
        });
      });
      list = next;
    });
    return list.map(function (t) { return { v: t, c: [(t[0][0] + t[1][0] + t[2][0]) / 3, (t[0][1] + t[1][1] + t[2][1]) / 3] }; });
  }

  /* Which triangles move with each bend. Triangles that share an edge are one rigid panel, unless the edge lies on a
     bend line: that edge is a bend joining two panels. A bend then moves the panels reached from its far side without
     crossing that bend, so a flange that merely lies on the far side of the bend line but is joined to the part by
     another bend (or not past this bend's reach) stays where it is. Returns { panel, moving: [Set|null per bend],
     joins: [panel list per bend] }. A null set means no joining edges were found (the old half-plane rule is used). */
  function buildTopo(list, bends) {
    var key = function (p) { return Math.round(p[0] * 1000) + ',' + Math.round(p[1] * 1000); };
    var edges = {}, n = list.length;
    list.forEach(function (t, i) {
      var v = t.v;
      if (Math.abs((v[1][0] - v[0][0]) * (v[2][1] - v[0][1]) - (v[2][0] - v[0][0]) * (v[1][1] - v[0][1])) < 1e-9) return;   // flat sliver from the cuts
      for (var e = 0; e < 3; e++) {
        var p = t.v[e], q = t.v[(e + 1) % 3], a = key(p), b = key(q), k = a < b ? a + '|' + b : b + '|' + a;
        (edges[k] = edges[k] || []).push({ i: i, p: p, q: q });
      }
    });
    var uf = []; for (var i = 0; i < n; i++) uf.push(i);
    var find = function (x) { while (uf[x] !== x) { uf[x] = uf[uf[x]]; x = uf[x]; } return x; };
    var joins = [];
    var bendOf = function (p, q) {
      var mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2, best = -1, bd = Infinity;
      bends.forEach(function (b, j) {
        var dx = b.p2[0] - b.p1[0], dy = b.p2[1] - b.p1[1], L = Math.hypot(dx, dy) || 1;
        var dist = function (x, y) { return Math.abs((x - b.p1[0]) * dy - (y - b.p1[1]) * dx) / L; };
        if (dist(p[0], p[1]) > 0.05 || dist(q[0], q[1]) > 0.05) return;     // the edge is not along this bend line
        var t = ((mx - b.p1[0]) * dx + (my - b.p1[1]) * dy) / L;
        var off = t < 0 ? -t : t > L ? t - L : 0;
        if (off < bd) { bd = off; best = j; }
      });
      return bd <= 0.3 ? best : -1;                 // material further along the line than the bend reaches is not this bend
    };
    var cross = [];
    var pair = function (i1, i2, p, q) {
      var j = bendOf(p, q);
      if (j < 0) uf[find(i1)] = find(i2);
      else cross.push([j, i1, i2]);
    };
    var lone = [];
    for (var k in edges) {
      var es = edges[k];
      if (es.length === 1) { lone.push(es[0]); continue; }
      /* more than two triangles on one edge (thin slivers from the cuts): sort them by side of the edge */
      var sideL = [], sideR = [], ex = es[0].q[0] - es[0].p[0], ey = es[0].q[1] - es[0].p[1];
      es.forEach(function (e) {
        var c = list[e.i].c;
        ((ex * (c[1] - es[0].p[1]) - ey * (c[0] - es[0].p[0])) >= 0 ? sideL : sideR).push(e);
      });
      [sideL, sideR].forEach(function (g) { for (var x = 1; x < g.length; x++) uf[find(g[x].i)] = find(g[0].i); });
      if (sideL.length && sideR.length) pair(sideL[0].i, sideR[0].i, es[0].p, es[0].q);
    }
    /* Edges that meet along part of their length (a corner of one triangle sits on the side of another): the outline
       edges stay alone, the rest are matched over the stretch they share. */
    lone.forEach(function (a) {
      var dx = a.q[0] - a.p[0], dy = a.q[1] - a.p[1], L = Math.hypot(dx, dy);
      if (L < 1e-6) return;
      lone.forEach(function (b) {
        if (b === a || b.i === a.i || b.i < a.i) return;
        var d1 = Math.abs((b.p[0] - a.p[0]) * dy - (b.p[1] - a.p[1]) * dx) / L, d2 = Math.abs((b.q[0] - a.p[0]) * dy - (b.q[1] - a.p[1]) * dx) / L;
        if (d1 > 1e-3 || d2 > 1e-3) return;
        var t1 = ((b.p[0] - a.p[0]) * dx + (b.p[1] - a.p[1]) * dy) / L, t2 = ((b.q[0] - a.p[0]) * dx + (b.q[1] - a.p[1]) * dy) / L;
        var lo = Math.max(0, Math.min(t1, t2)), hi = Math.min(L, Math.max(t1, t2));
        if (hi - lo < 1e-2) return;
        pair(a.i, b.i, [a.p[0] + dx / L * lo, a.p[1] + dy / L * lo], [a.p[0] + dx / L * hi, a.p[1] + dy / L * hi]);
      });
    });
    /* Slivers (a fraction of a mm2, left where a cut passes through a corner) belong to no flange of their own: they
       go with the biggest panel they touch, so they cannot join two sides of a bend. */
    var area = {};
    list.forEach(function (t, i) {
      var v = t.v, r = find(i);
      area[r] = (area[r] || 0) + Math.abs((v[1][0] - v[0][0]) * (v[2][1] - v[0][1]) - (v[2][0] - v[0][0]) * (v[1][1] - v[0][1])) / 2;
    });
    for (var pass = 0; pass < 3; pass++) {
      var changed = false;
      cross.forEach(function (c) {
        var a = find(c[1]), b = find(c[2]);
        if (a === b) return;
        if (area[a] < 1 && area[b] >= 1) { uf[a] = b; area[b] += area[a]; changed = true; }
        else if (area[b] < 1 && area[a] >= 1) { uf[b] = a; area[a] += area[b]; changed = true; }
      });
      if (!changed) break;
    }
    var panel = list.map(function (t, i) { return find(i); });
    bends.forEach(function () { joins.push([]); });
    var adj = {};
    cross.forEach(function (c) {
      var a = panel[c[1]], b = panel[c[2]];
      if (a === b) return;
      joins[c[0]].push(a, b);
      (adj[a] = adj[a] || []).push([b, c[0]]); (adj[b] = adj[b] || []).push([a, c[0]]);
    });
    var moving = bends.map(function (b, j) {
      if (!joins[j].length) return null;
      var dx = b.p2[0] - b.p1[0], dy = b.p2[1] - b.p1[1], L = Math.hypot(dx, dy) || 1;
      var fn = [-dy * b.sign / L, dx * b.sign / L], mid = [(b.p1[0] + b.p2[0]) / 2, (b.p1[1] + b.p2[1]) / 2];
      var far = {}, near = {}, seen = {}, queue = [];
      var side = function (i) { return (list[i].c[0] - mid[0]) * fn[0] + (list[i].c[1] - mid[1]) * fn[1]; };
      /* which of two joined panels is on the far side: the vote of all their edges on this bend, weighted by how far
         apart the two triangles' centres are (thin slivers on the line say nothing) */
      var votes = {};
      cross.forEach(function (c) {
        var a = panel[c[1]], b = panel[c[2]];
        if (c[0] !== j || a === b) return;
        var k = a < b ? a + '|' + b : b + '|' + a, w = side(c[2]) - side(c[1]);     // > 0: c[1] is on the far side
        votes[k] = (votes[k] || 0) + (a < b ? w : -w);
      });
      Object.keys(votes).forEach(function (k) {
        var ab = k.split('|');
        far[votes[k] >= 0 ? ab[0] : ab[1]] = true; near[votes[k] >= 0 ? ab[1] : ab[0]] = true;
      });
      Object.keys(far).forEach(function (p) { seen[p] = true; queue.push(+p); });
      while (queue.length) {
        var p = queue.pop();
        (adj[p] || []).forEach(function (e) {
          if (e[1] === j || seen[e[0]]) return;
          seen[e[0]] = true; queue.push(e[0]);
        });
      }
      /* the near side must not be reachable from the far side (a tab around the end of the bend): old rule then */
      return Object.keys(near).some(function (p) { return seen[p]; }) ? null : seen;
    });
    return { panel: panel, moving: moving, joins: joins };
  }

  /* ---------------------------------------------------------------- folding */

  function fold(bends, step, progress) {
    var B = bends.map(function (b) {
      var dx = (b.p2[0] - b.p1[0]) / b.len, dy = (b.p2[1] - b.p1[1]) / b.len;
      var fn = [-dy * b.sign, dx * b.sign];
      return {
        b: b, a: V3(b.p1[0], b.p1[1], 0), e: V3(b.p2[0], b.p2[1], 0), n: V3(0, 0, 1), g: V3(fn[0], fn[1], 0),
        mid: [(b.p1[0] + b.p2[0]) / 2, (b.p1[1] + b.p2[1]) / 2], fn: fn
      };
    });
    var T = tris.map(function (t) { return { p: t.v.map(function (q) { return V3(q[0], q[1], 0); }), c: t.c }; });
    var frame = null, theta = 0;
    for (var k = 0; k <= step && k < B.length; k++) {
      var K = B[k];
      if (k === step) {
        var dirSign = K.b.dir === 'DOWN' ? -1 : 1;
        var z = K.n.clone().multiplyScalar(dirSign).normalize();
        var v = K.g.clone().sub(z.clone().multiplyScalar(K.g.dot(z))).normalize();
        frame = { M: K.a.clone().add(K.e).multiplyScalar(0.5), z: z, v: v, u: v.clone().cross(z) };
      }
      var th = (180 - K.b.angle) * Math.PI / 180 * (k < step ? 1 : progress);
      if (k === step) theta = th;
      if (!th) continue;
      var axis = K.e.clone().sub(K.a).normalize();
      var s = Math.sign(axis.clone().cross(K.g.clone().negate()).dot(K.n)) || 1;
      var phi = s * th * (K.b.dir === 'DOWN' ? -1 : 1);
      var q = new THREE.Quaternion().setFromAxisAngle(axis, phi), o = K.a.clone();
      var moves = function (c) { return (c[0] - K.mid[0]) * K.fn[0] + (c[1] - K.mid[1]) * K.fn[1] < 0; };
      var set = topo && topo.moving[k];
      T.forEach(function (t, i) {
        if (!(set ? set[topo.panel[i]] : moves(t.c))) return;
        t.p.forEach(function (p) { p.sub(o).applyQuaternion(q).add(o); });
      });
      B.forEach(function (J, j) {
        if (j === k) return;
        if (set && topo.joins[j].length) { if (!topo.joins[j].some(function (p) { return set[p]; })) return; }
        else if (!moves(J.mid)) return;
        J.a.sub(o).applyQuaternion(q).add(o); J.e.sub(o).applyQuaternion(q).add(o);
        J.n.applyQuaternion(q); J.g.applyQuaternion(q);
      });
    }
    return { T: T, B: B, frame: frame, theta: theta };
  }

  /* ---------------------------------------------------------------- scene */

  function label(text, color) {
    var c = document.createElement('canvas'); c.width = 256; c.height = 64;
    var x = c.getContext('2d'); x.font = '600 34px sans-serif'; x.fillStyle = color; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(text, 128, 32);
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthTest: false }));
    sp.scale.set(160, 40, 1);
    return sp;
  }

  /* Ring emblem followed by "AMADA" lettering, drawn on a canvas (red background, white letters). */
  function logoTexture() {
    var c = document.createElement('canvas'); c.width = 1024; c.height = 256;
    var x = c.getContext('2d');
    x.clearRect(0, 0, 1024, 256);
    x.font = '900 170px "Arial Black", Arial, sans-serif'; x.textBaseline = 'middle'; x.textAlign = 'left';
    var ring = 140, gap = 26, room = 1024 - 24 - ring - gap, w = x.measureText('AMADA').width;
    if (w > room) { x.font = '900 ' + Math.floor(170 * room / w) + 'px "Arial Black", Arial, sans-serif'; w = room; }   // keep all letters on the beam
    var left = (1024 - ring - gap - w) / 2;            // emblem and lettering centred together
    x.fillStyle = '#ffffff';
    x.beginPath(); x.arc(left + ring / 2, 128, 70, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#c8102e';
    x.beginPath(); x.arc(left + ring / 2, 128, 45, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#ffffff';
    x.fillText('AMADA', left + ring + gap, 134);
    var t = new THREE.CanvasTexture(c); t.anisotropy = 4;
    return t;
  }

  function init(container) {
    if (S) return S;
    if (!window.THREE || !THREE.OrbitControls) { container.textContent = '3D library not loaded.'; return null; }
    var renderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }); }
    catch (e) { container.textContent = 'WebGL is not available in this browser.'; return null; }
    var w = container.clientWidth || 800, h = container.clientHeight || 480;
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(w, h);
    container.appendChild(renderer.domElement);
    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(38, w / h, 5, 30000);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x556070, 0.9));
    var dl = new THREE.DirectionalLight(0xffffff, 0.8); dl.position.set(-400, 900, 700); scene.add(dl);
    var controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    S = { container: container, renderer: renderer, scene: scene, camera: camera, controls: controls, dyn: null, viewed: false };
    controls.addEventListener('change', render);
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(container);
    window.addEventListener('resize', resize);
    return S;
  }

  function render() { if (S) S.renderer.render(S.scene, S.camera); }

  function resize() {
    if (!S) return;
    var w = S.container.clientWidth, h = S.container.clientHeight;
    if (!w || !h) return;
    S.renderer.setSize(w, h);
    S.camera.aspect = w / h; S.camera.updateProjectionMatrix();
    render();
  }

  function resetView(span) {
    if (!S) return;
    span = Math.max(span || 600, 400);
    S.controls.target.set(0, 60, 0);
    S.camera.position.set(-span * 0.7, span * 1.05, span * 0.85);
    S.camera.lookAt(S.controls.target);
    S.controls.update();
    render();
  }

  function mat(color, opts) {
    var o = { color: color, flatShading: true, side: THREE.DoubleSide };
    for (var k in opts) o[k] = opts[k];
    return new THREE.MeshStandardMaterial(o);
  }

  function prism(profile, len, cx) {
    var sh = new THREE.Shape();
    profile.forEach(function (p, i) { if (i) sh.lineTo(p[0], p[1]); else sh.moveTo(p[0], p[1]); });
    var g = new THREE.ExtrudeGeometry(sh, { depth: len, bevelEnabled: false });
    g.rotateY(Math.PI / 2);                    // profile x (= v, back is +) -> -z on screen, extrusion -> +x
    g.translate(cx - len / 2, 0, 0);
    return g;
  }

  function box(w, h, d, x, y, z, m) {
    var mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.position.set(x, y, z);
    return mesh;
  }

  /* Die as photographed (60 mm wide, 48 mm high) with two V slots: V8 nearest the back (centre 15.75 mm from the
     back edge), which is the one used for bending, and V12 22 mm from the front edge.
     Points are (x across the profile, back is +, height). */
  var DIE_BACK = 15.75, DIE_FRONT = DIE_BACK - 60, BIG_V_AT = DIE_FRONT + 22, DIE_V = 8, BIG_V = 12;
  function dieProfile(V, dieTop) {
    var vNotch = function (c, w) {
      var h = w / 2, ch = 0.3 * h, vd = h / Math.tan(44 * Math.PI / 180);
      return [[c + h + ch, dieTop], [c + h, dieTop - ch], [c, dieTop - ch - vd], [c - h, dieTop - ch], [c - h - ch, dieTop]];
    };
    var yb = dieTop - DIE_H;
    return [[DIE_FRONT, yb], [DIE_BACK, yb], [DIE_BACK, dieTop]].concat(vNotch(0, V), vNotch(BIG_V_AT, BIG_V), [[DIE_FRONT, dieTop]]);
  }

  /* AFH acute angle punch 814 (drawing "814 30.pdf"): 30 deg tip, R0.6, 120 mm to the clamp shoulder, 150 mm in
     all. Points are (x across the profile as drawn, height above the tip); the tip sits at the bend line.
     Drawing left = front of the machine unless flipped (sgn -1). */
  var P814 = [[0, 0], [1.05, 0.7], [1.05, 15.2], [3.3, 15.2], [3.3, 91.2], [7.7, 95], [7.7, 119.3], [6.9, 120],
    [-7.7, 120], [-7.7, 149.3], [-6.9, 150], [-20.7, 150], [-21.5, 149.3], [-21.5, 137], [-18.2, 136.6], [-18.2, 128.2],
    [-21.5, 127.8], [-21.5, 111.8], [-2.9, 91.2], [-2.9, 9.5], [-0.8, 0.75]];
  /* Part of a profile (list of [x, height]) below or above a height (Sutherland-Hodgman). */
  function clipProfile(poly, h, below) {
    var inside = function (p) { return below ? p[1] <= h : p[1] >= h; }, out = [];
    for (var i = 0; i < poly.length; i++) {
      var p = poly[i], q = poly[(i + 1) % poly.length], pi = inside(p), qi = inside(q);
      if (pi) out.push(p);
      if (pi !== qi) out.push([p[0] + (h - p[1]) / (q[1] - p[1]) * (q[0] - p[0]), h]);
    }
    return out;
  }

  function punchProfile(tip, sgn) { return P814.map(function (p) { return [sgn * p[0], tip + p[1]]; }); }

  /* Fold the part for one step and place it on the machine. mapP maps a folded point to screen axes. */
  function pose(d) {
    if (meshKey !== d.key) { tris = buildTris(d.segs, d.bends); meshKey = d.key; topoKey = null; }
    var tk = d.bends.map(function (b) { return b.sign; }).join();     // which side moves depends on the side of each bend
    if (topoKey !== tk) { topo = buildTopo(tris, d.bends); topoKey = tk; }
    var th = Math.max(0.5, d.thickness || 1);
    var F = fold(d.bends, d.step, d.progress);
    var fr = F.frame, psi = F.theta / 2, cp = Math.cos(psi), sp = Math.sin(psi), sh = d.shift || 0;
    var mapP = function (p) {
      var q = p.clone().sub(fr.M);
      var x = q.dot(fr.u) + sh, y = q.dot(fr.z), z = -q.dot(fr.v);
      return V3(x, y * cp - z * sp, y * sp + z * cp);
    };
    /* the punch starts O.D.C mm above the sheet and comes down to it as the bend progresses (25 when not given) */
    var lift = (1 - Math.min(1, d.progress)) * (isFinite(d.odc) ? Math.max(0, d.odc) : 25);
    return { F: F, mapP: mapP, th: th, dieTop: -th / 2, tip: th / 2 + lift };
  }

  /* Points spread over the part (about every `spacing` mm) for one step, for collision checks.
     Returns P (x, y, z on the machine, x = 0 at the bend centre unless shifted) and Q (flat-pattern x, y). */
  /* Where the sample points sit on the flat pattern: a square grid (spacing s) plus points along the outline, each
     stored as its triangle and the weights of the triangle's corners. Made once per part and spacing. */
  var spotCache = { key: null, s: 0, spots: null };
  function spots(s) {
    if (spotCache.key === meshKey && spotCache.s === s) return spotCache.spots;
    var out = { tri: [], w: [], Q: [] }, edgeUse = {};
    var ek = function (p, q) {
      var a = Math.round(p[0] * 100) + ',' + Math.round(p[1] * 100), b = Math.round(q[0] * 100) + ',' + Math.round(q[1] * 100);
      return a < b ? a + '|' + b : b + '|' + a;
    };
    tris.forEach(function (t) { for (var e = 0; e < 3; e++) { var k = ek(t.v[e], t.v[(e + 1) % 3]); edgeUse[k] = (edgeUse[k] || 0) + 1; } });
    var add = function (i, wa, wb, wc) {
      var v = tris[i].v;
      out.tri.push(i); out.w.push(wa, wb, wc);
      out.Q.push(v[0][0] * wa + v[1][0] * wb + v[2][0] * wc, v[0][1] * wa + v[1][1] * wb + v[2][1] * wc);
    };
    tris.forEach(function (t, i) {
      var a = t.v[0], b = t.v[1], c = t.v[2];
      var det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
      if (Math.abs(det) < 1e-9) return;
      var x0 = Math.min(a[0], b[0], c[0]), x1 = Math.max(a[0], b[0], c[0]), y0 = Math.min(a[1], b[1], c[1]), y1 = Math.max(a[1], b[1], c[1]);
      for (var gx = Math.ceil(x0 / s) * s; gx <= x1; gx += s) {
        for (var gy = Math.ceil(y0 / s) * s; gy <= y1; gy += s) {
          var l1 = ((b[1] - c[1]) * (gx - c[0]) + (c[0] - b[0]) * (gy - c[1])) / det;
          var l2 = ((c[1] - a[1]) * (gx - c[0]) + (a[0] - c[0]) * (gy - c[1])) / det, l3 = 1 - l1 - l2;
          if (l1 >= -1e-9 && l2 >= -1e-9 && l3 >= -1e-9) add(i, l1, l2, l3);
        }
      }
      for (var e = 0; e < 3; e++) {                  // outline (edges used by one triangle only)
        var p = t.v[e], q = t.v[(e + 1) % 3];
        if (edgeUse[ek(p, q)] !== 1) continue;
        var n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / s));
        for (var k = 0; k < n; k++) {
          var w = [0, 0, 0];
          w[e] = 1 - k / n; w[(e + 1) % 3] = k / n;
          add(i, w[0], w[1], w[2]);
        }
      }
    });
    spotCache = { key: meshKey, s: s, spots: out };
    return out;
  }

  function sample(d, spacing) {
    if (!window.THREE) return null;
    var po = pose(d);
    if (!po.F.frame) return null;
    var sp = spots(spacing || 4), n = sp.tri.length, P = new Float64Array(n * 3), mapped = {};
    for (var j = 0; j < n; j++) {
      var i = sp.tri[j], v = mapped[i];
      if (!v) { var t = po.F.T[i].p; v = mapped[i] = [po.mapP(t[0]), po.mapP(t[1]), po.mapP(t[2])]; }
      var wa = sp.w[3 * j], wb = sp.w[3 * j + 1], wc = sp.w[3 * j + 2];
      P[3 * j] = v[0].x * wa + v[1].x * wb + v[2].x * wc;
      P[3 * j + 1] = v[0].y * wa + v[1].y * wb + v[2].y * wc;
      P[3 * j + 2] = v[0].z * wa + v[1].z * wb + v[2].z * wc;
    }
    return { P: P, Q: sp.Q, tip: po.tip, dieTop: po.dieTop, th: po.th };
  }

  /* d: { key, segs, bends:[{id,p1,p2,len,angle,dir,sign}], step, progress, shift, x, z1, z2, r1, r2,
          thickness, dieV, fingerOk:[bool,bool], tools: {punch:[[u0,u1]...], die:[[u0,u1]...]} (optional), bg } */
  function update(d, container) {
    if (!init(container)) return;
    var po = pose(d), F = po.F, mapP = po.mapP, dieTop = po.dieTop;
    if (S.dyn) {
      S.scene.remove(S.dyn);
      S.dyn.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
    }
    var G = new THREE.Group(); S.dyn = G; S.scene.add(G);

    /* part */
    var pos = new Float32Array(F.T.length * 9), i = 0;
    F.T.forEach(function (t) { t.p.forEach(function (p) { var m = mapP(p); pos[i++] = m.x; pos[i++] = m.y; pos[i++] = m.z; }); });
    var pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    pg.computeVertexNormals();
    var cs = getComputedStyle(document.documentElement), css = function (n, f) { return (cs.getPropertyValue(n).trim()) || f; };
    G.add(new THREE.Mesh(pg, mat(0x3aa697, { roughness: 0.55, metalness: 0.15 })));
    var lp = [];
    F.B.forEach(function (J, j) {
      var a = mapP(J.a), e = mapP(J.e);
      var lg = new THREE.BufferGeometry().setFromPoints([a, e]);
      G.add(new THREE.Line(lg, new THREE.LineBasicMaterial({ color: j === d.step ? 0xffffff : 0x1a4a44 })));
    });

    /* die, punch, beams */
    var Ld = Math.min(TABLE_W, Math.max(300, (d.bends[d.step] ? d.bends[d.step].len : 300) + 160));
    if (d.punchLen) Ld = Math.min(TABLE_W, Math.max(Ld, d.punchLen));      // die assumed as long as the punch
    var tl = d.tools;
    if (tl) Ld = TABLE_W;                          // stations: show the whole bed
    var dieMat = mat(0x6b7480, { roughness: 0.4, metalness: 0.6 });
    var dieProf = dieProfile(d.dieV || DIE_V, dieTop);
    (tl ? tl.die : [[-Ld / 2, Ld / 2]]).forEach(function (t) {
      var gap = tl ? 0.6 : 0;                      // a thin gap shows where one section ends
      G.add(new THREE.Mesh(prism(dieProf, t[1] - t[0] - gap, (t[0] + t[1]) / 2), dieMat));
    });
    var Wb = Math.min(TABLE_W, Ld + 300);
    G.add(box(Wb, 40, 150, 0, dieTop - DIE_H - 20, 0, mat(0x9aa3ad, { transparent: true, opacity: 0.25 })));
    var tip = po.tip;
    var sgn = d.flipPunch ? -1 : 1;
    var punchLen = Math.min(TABLE_W, d.punchLen || Ld);
    var punchMat = mat(0xb9c2cc, { roughness: 0.35, metalness: 0.7, transparent: true, opacity: 0.7 });
    var punchProf = punchProfile(tip, sgn);
    var hornMat = mat(0xd9a441, { roughness: 0.35, metalness: 0.5, transparent: true, opacity: 0.85 });
    var hornTipMat = mat(0xe8742a, { roughness: 0.35, metalness: 0.5, transparent: true, opacity: 0.9 });
    (tl ? tl.punch : [[-punchLen / 2, punchLen / 2]]).forEach(function (t) {
      var gap = tl ? 0.6 : 0;
      if (!t[2]) { G.add(new THREE.Mesh(prism(punchProf, t[1] - t[0] - gap, (t[0] + t[1]) / 2), punchMat)); return; }
      /* horn piece: the tip runs the whole length, the body above hornH stops `ext` mm short at the horn end */
      var ext = Math.min(tl.hornExt || 0, t[1] - t[0]), hh = tip + (isFinite(tl.hornH) ? tl.hornH : 20);
      var body = t[2] === 'L' ? [t[0] + ext, t[1]] : [t[0], t[1] - ext];
      var low = clipProfile(punchProf, hh, true), high = clipProfile(punchProf, hh, false);
      if (low.length > 2) G.add(new THREE.Mesh(prism(low, t[1] - t[0] - gap, (t[0] + t[1]) / 2), hornTipMat));
      if (high.length > 2 && body[1] - body[0] > 0.7) G.add(new THREE.Mesh(prism(high, body[1] - body[0] - gap, (body[0] + body[1]) / 2), hornMat));
    });
    var beamY = tip + 150 + 45, beam = new THREE.Group();
    if (!d.hideBeam) G.add(beam);
    beam.add(box(Wb, 90, 120, 0, beamY, 0, mat(0xc8102e, { roughness: 0.45, metalness: 0.25 })));
    var lg = logoTexture();
    var logo = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(380, Wb * 0.7), Math.min(380, Wb * 0.7) / 4), new THREE.MeshBasicMaterial({ map: lg, transparent: true }));
    logo.position.set(0, beamY, 60.5);
    beam.add(logo);
    beam.add(box(Wb, 70, 110, 0, tip + 120 + 35, 0, mat(0x9aa3ad, { transparent: true, opacity: 0.25 })));

    /* Backgauge fingers (Data Update: thickness 5, length 258, width 100): a flat arm whose front face touches the
       edge of the sheet at X. R = height of the arm's lower edge above the die top (the sheet never rests on it). */
    var X = d.x;
    [[-d.z1, d.r1, 0], [d.z2, d.r2, 1]].forEach(function (f) {
      var bottom = dieTop + f[1], ok = d.fingerOk ? d.fingerOk[f[2]] : true;
      var hit = bottom < dieTop && X < DIE_BACK;        // arm would be inside the die
      var m = mat(ok && !hit ? 0x2faa4a : 0xd04545, { roughness: 0.5, metalness: 0.2 });
      G.add(box(100, 5, 258, f[0], bottom + 2.5, -(X + 129), m));
      G.add(box(100, 45, 50, f[0], bottom + 22.5, -(X + 258 - 25), m));
    });

    /* orientation labels */
    var lc = css('--muted', '#888');
    var l1 = label('LEFT', lc); l1.position.set(-Wb / 2 + 90, dieTop - 70, 60); G.add(l1);
    var l2 = label('RIGHT', lc); l2.position.set(Wb / 2 - 90, dieTop - 70, 60); G.add(l2);
    var l3 = label('FRONT', lc); l3.position.set(0, dieTop - 70, 200); G.add(l3);
    var grid = new THREE.GridHelper(Wb, Math.max(4, Math.round(Wb / 50)), 0x888888, 0xcccccc); grid.position.y = dieTop - DIE_H - 41; grid.material.transparent = true; grid.material.opacity = 0.25; G.add(grid);

    var bg = d.bg || css('--canvas', '#fafafa');
    S.renderer.setClearColor(new THREE.Color(bg), 1);
    if (!S.viewed || d.resetView) {
      var span = Math.max(d.span || 600, Ld);
      resetView(Math.min(span * 1.6, 2200)); S.viewed = true;
    }
    render();
  }

  /* Render one picture for a report: d as for update, view = { target: [x, y, z], from: [x, y, z] }.
     The live view (size and camera) is put back afterwards. Returns a JPEG data URL. */
  function snapshot(d, container, w, h, view) {
    if (!init(container)) return null;
    var r = S.renderer, size = r.getSize(new THREE.Vector2()), pr = r.getPixelRatio();
    var pos = S.camera.position.clone(), tgt = S.controls.target.clone(), viewed = S.viewed;
    S.viewed = true;
    r.setPixelRatio(1); r.setSize(w, h, false);
    S.camera.aspect = w / h; S.camera.updateProjectionMatrix();
    update(d, container);
    S.controls.target.set(view.target[0], view.target[1], view.target[2]);
    S.camera.position.set(view.from[0], view.from[1], view.from[2]);
    S.camera.lookAt(S.controls.target);
    render();
    var url = r.domElement.toDataURL('image/jpeg', 0.88);
    r.setPixelRatio(pr); r.setSize(size.x, size.y, false);
    S.camera.aspect = size.x / Math.max(1, size.y); S.camera.updateProjectionMatrix();
    S.controls.target.copy(tgt); S.camera.position.copy(pos); S.camera.lookAt(tgt);
    S.viewed = viewed;
    return url;
  }

  /* For checks: the rigid panels and which of them each bend moves. */
  function topology(segs, bends) { var l = buildTris(segs, bends); return { tris: l, topo: buildTopo(l, bends) }; }

  window.Sim3D = { topology: topology, sample: sample, snapshot: snapshot, punchProfile: punchProfile, dieProfile: dieProfile, DIE_BACK: DIE_BACK, DIE_H: DIE_H, DIE_V: DIE_V,
    camera: function (x, y, z, tx, ty, tz) { if (S) { S.camera.position.set(x, y, z); if (tx !== undefined) S.controls.target.set(tx, ty, tz); S.controls.update(); render(); } }, update: update, resetView: resetView, resize: resize, isReady: function () { return !!S; }, canvas: function () { return S && S.renderer.domElement; } };
})();
