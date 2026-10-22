/* Bend simulator: top view of the press brake with the part, bend line and the Z1/Z2 backgauge fingers,
   plus a small side view of the bend. Machine coordinates: u = across the machine (0 = centre, left is
   negative), v = distance behind the bend line (towards the backgauge). Z1 moves the left finger to the
   left of centre, Z2 moves the right finger to the right of centre. */
(function () {
  'use strict';

  var MACHINE_W = 2500, FINGER_W = 100, FINGER_D = 30, MIN_Z_SUM = 120;

  /* d: { segs: [[[x,y],[x,y]]...] drawing outline, bend: {p1,p2,len}, sign, shift, x, z1, z2, r1, r2,
          angle, dir, edgeGauge, edgeOther } */
  function analyze(d) {
    var b = d.bend;
    var dx = (b.p2[0] - b.p1[0]) / b.len, dy = (b.p2[1] - b.p1[1]) / b.len;
    var nx = -dy, ny = dx;
    var mx = (b.p1[0] + b.p2[0]) / 2, my = (b.p1[1] + b.p2[1]) / 2;
    var s = d.sign, sh = d.shift || 0;
    var map = function (p) {
      var rx = p[0] - mx, ry = p[1] - my;
      return [(d.dir === 'DOWN' ? -1 : 1) * s * (rx * dx + ry * dy) + sh, s * (rx * nx + ry * ny)];
    };
    var segs = d.segs.map(function (g) { return [map(g[0]), map(g[1])]; });
    var inside = function (u, v) {
      var c = 0;
      for (var i = 0; i < segs.length; i++) {
        var a = segs[i][0], e = segs[i][1];
        if ((a[1] > v) !== (e[1] > v)) {
          var t = (v - a[1]) / (e[1] - a[1]);
          if (a[0] + t * (e[0] - a[0]) > u) c++;
        }
      }
      return c % 2 === 1;
    };
    var fingers = [{ name: 'Z1', u: -d.z1 }, { name: 'Z2', u: d.z2 }].map(function (f) {
      var hit = 0, n = 21;
      for (var i = 0; i < n; i++) {
        if (inside(f.u - FINGER_W / 2 + FINGER_W * i / (n - 1), d.x - 0.5)) hit++;
      }
      f.cover = hit / n;
      return f;
    });
    var umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
    segs.forEach(function (g) {
      g.forEach(function (p) {
        umin = Math.min(umin, p[0]); umax = Math.max(umax, p[0]);
        vmin = Math.min(vmin, p[1]); vmax = Math.max(vmax, p[1]);
      });
    });
    var warns = [];
    fingers.forEach(function (f) {
      if (f.cover === 0) warns.push(f.name + ' is not touching the part.');
      else if (f.cover < 0.4) warns.push(f.name + ' only touches the part with ' + Math.round(f.cover * 100) + '% of its width.');
      if (Math.abs(f.u) + FINGER_W / 2 > MACHINE_W / 2) warns.push(f.name + ' is outside the machine width.');
    });
    if (d.z1 + d.z2 < MIN_Z_SUM) warns.push('Z1 + Z2 must be at least ' + MIN_Z_SUM + ' mm: the fingers are too close.');
    return { segs: segs, fingers: fingers, umin: umin, umax: umax, vmin: vmin, vmax: vmax, warns: warns, inside: inside };
  }

  function colors() {
    var cs = getComputedStyle(document.documentElement);
    var g = function (n) { return cs.getPropertyValue(n).trim(); };
    return {
      bg: g('--canvas'), ink: g('--outline'), up: g('--up'), down: g('--down'), brand: g('--brand'),
      good: g('--good'), crit: g('--crit'), muted: g('--muted'), grid: g('--axis'), warn: g('--warn')
    };
  }

  function prep(cv, h) {
    var dpr = window.devicePixelRatio || 1, w = cv.clientWidth || 600;
    cv.style.height = h + 'px';
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }

  function text(ctx, s, x, y, col, size, align) {
    ctx.fillStyle = col; ctx.font = (size || 12) + 'px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = align || 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(s, x, y);
  }

  /* Top view. opts: { zoom } */
  function drawTop(cv, d, A, opts) {
    var C = colors();
    var uLo = -MACHINE_W / 2, uHi = MACHINE_W / 2;
    if (opts && opts.range) { uLo = opts.range[0]; uHi = opts.range[1]; }
    else if (opts && opts.zoom) {
      uLo = Math.min(A.umin, -d.z1 - FINGER_W / 2, -60) - 60;
      uHi = Math.max(A.umax, d.z2 + FINGER_W / 2, 60) + 60;
      var wide = uHi - uLo;
      if (wide < 300) { var c = (uLo + uHi) / 2; uLo = c - 150; uHi = c + 150; }
    }
    var vLo = Math.min(-60, A.vmin) - 30, vTop = d.clipV !== undefined ? d.clipV : Infinity, vHi = Math.max(d.x + FINGER_D, Math.min(A.vmax, vTop)) + 40;
    var W = cv.clientWidth || 600, pad = 14;
    var k = (W - 2 * pad) / (uHi - uLo);
    var H = Math.max(160, Math.min(560, (vHi - vLo) * k + 2 * pad + 18));
    k = Math.min(k, (H - 2 * pad - 18) / (vHi - vLo));
    var P = prep(cv, H), ctx = P.ctx;
    var ox = P.w / 2 - k * (uLo + uHi) / 2, oy = H - pad - 18 + k * vLo;
    var X = function (u) { return ox + u * k; }, Y = function (v) { return oy - v * k; };
    cv._sim = { ox: ox, k: k, uLo: uLo, uHi: uHi, fr: [], st: [] };

    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, P.w, H);
    /* machine bed */
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1; ctx.setLineDash([]);
    ctx.strokeRect(X(-MACHINE_W / 2), Y(vHi), MACHINE_W * k, (vHi - vLo) * k);
    /* die / bend line across the whole machine */
    ctx.strokeStyle = C.grid; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(X(Math.max(uLo, -MACHINE_W / 2)), Y(0)); ctx.lineTo(X(Math.min(uHi, MACHINE_W / 2)), Y(0)); ctx.stroke();
    /* tool sections of the stations (punch over the die), when a station plan is in use */
    if (d.tools) {
      d.tools.punch.forEach(function (t, i) {
        ctx.fillStyle = C.muted; ctx.globalAlpha = i % 2 ? 0.45 : 0.3;
        ctx.fillRect(X(t[0]), Y(6), (t[1] - t[0]) * k - 1, 12 * k);
      });
      ctx.globalAlpha = 1;
      /* station letters; the strip around each station can be dragged to move it */
      (d.tools.stations || []).forEach(function (st) {
        var x0 = X(st.u0), x1 = X(st.u1);
        text(ctx, st.name, (x0 + x1) / 2, Y(6) - 6, C.brand, 12, 'center');
        cv._sim.st.push({ name: 'stn:' + st.name, x0: x0, x1: x1, y0: Y(6) - 20, y1: Y(-6) + 8 });
      });
    }
    /* centre line */
    ctx.setLineDash([6, 5]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(X(0), Y(vHi)); ctx.lineTo(X(0), Y(vLo)); ctx.stroke(); ctx.setLineDash([]);

    /* part: gauged flange (behind the bend line) tinted, other side lighter */
    ctx.save();
    ctx.beginPath(); ctx.rect(0, isFinite(vTop) ? Y(vTop) : 0, P.w, H); ctx.clip();   // beyond an earlier bend the flange stands up
    ctx.lineWidth = 1.5; ctx.strokeStyle = C.ink;
    ctx.beginPath();
    A.segs.forEach(function (g) { ctx.moveTo(X(g[0][0]), Y(g[0][1])); ctx.lineTo(X(g[1][0]), Y(g[1][1])); });
    ctx.stroke();
    ctx.restore();
    /* tint the gauged flange by filling the region behind the bend line via scanning */
    ctx.globalAlpha = 0.18; ctx.fillStyle = C.brand;
    var step = Math.max(2, Math.round(3 / k));
    for (var v = step / 2; v < Math.min(A.vmax, vTop); v += step) {
      var xs = [];
      A.segs.forEach(function (g) {
        var a = g[0], e = g[1];
        if ((a[1] > v) !== (e[1] > v)) xs.push(a[0] + (v - a[1]) / (e[1] - a[1]) * (e[0] - a[0]));
      });
      xs.sort(function (p, q) { return p - q; });
      for (var i = 0; i + 1 < xs.length; i += 2) ctx.fillRect(X(xs[i]), Y(v + step / 2), (xs[i + 1] - xs[i]) * k, step * k);
    }
    ctx.globalAlpha = 1;
    /* the folded flange of the earlier bend: a thin wall across the part at that bend line */
    if (isFinite(vTop)) {
      var lo = Infinity, hi = -Infinity;
      for (var uu = Math.floor(A.umin); uu <= Math.ceil(A.umax); uu++) {
        if (A.inside(uu, vTop - 0.5)) { lo = Math.min(lo, uu); hi = Math.max(hi, uu); }
      }
      if (hi > lo) {
        ctx.strokeStyle = C.ink; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(X(lo), Y(vTop)); ctx.lineTo(X(hi), Y(vTop)); ctx.stroke();
      }
    }

    /* bend line */
    var half = d.bend.len / 2, sh = d.shift || 0;
    ctx.strokeStyle = d.dir === 'DOWN' ? C.down : C.up; ctx.lineWidth = 3.5;
    ctx.beginPath(); ctx.moveTo(X(sh - half), Y(0)); ctx.lineTo(X(sh + half), Y(0)); ctx.stroke();

    /* fingers */
    A.fingers.forEach(function (f) {
      var ok = f.cover >= 0.4;
      ctx.fillStyle = ok ? C.good : C.crit; ctx.globalAlpha = 0.85;
      ctx.fillRect(X(f.u - FINGER_W / 2), Y(d.x + FINGER_D), FINGER_W * k, FINGER_D * k);
      ctx.globalAlpha = 1;
      cv._sim.fr.push({ name: f.name, x0: X(f.u - FINGER_W / 2), x1: X(f.u + FINGER_W / 2), y0: Y(d.x + FINGER_D) - 14, y1: Y(d.x) });
      ctx.strokeStyle = ok ? C.good : C.crit; ctx.lineWidth = 1.5;
      ctx.strokeRect(X(f.u - FINGER_W / 2), Y(d.x + FINGER_D), FINGER_W * k, FINGER_D * k);
      text(ctx, f.name, X(f.u), Y(d.x + FINGER_D) - 9, C.ink, 12, 'center');
    });

    /* labels */
    text(ctx, 'LEFT', X(uLo) + 4, H - 9, C.muted, 11, 'left');
    text(ctx, 'RIGHT', X(uHi) - 4, H - 9, C.muted, 11, 'right');
    text(ctx, 'FRONT (operator)', X(0), H - 9, C.muted, 11, 'center');
    if (opts && opts.zoom) text(ctx, 'zoomed to part', X(uLo) + 6, 10, C.muted, 11, 'left');
    else text(ctx, MACHINE_W + ' mm machine', X(0), 10, C.muted, 11, 'center');
  }

  /* Which finger ('Z1', 'Z2') or station ('stn:A') is under the pointer (CSS pixels on the top view canvas), or null.
     Fingers win where they overlap a station. */
  function hit(cv, px, py) {
    var s = cv._sim, res = null;
    if (!s) return null;
    s.st.forEach(function (f) { if (px >= f.x0 && px <= f.x1 && py >= f.y0 && py <= f.y1) res = f.name; });
    s.fr.forEach(function (f) { if (px >= f.x0 && px <= f.x1 && py >= f.y0 && py <= f.y1) res = f.name; });
    return res;
  }

  /* Finger centre (mm across the machine) for a pointer x position. */
  function uAt(cv, px) { return (px - cv._sim.ox) / cv._sim.k; }

  /* Side view of the finished bend. Gauged flange points right (towards the backgauge). */
  function drawSide(cv, d) {
    var C = colors();
    var P = prep(cv, 220), ctx = P.ctx, W = P.w, H = P.h;
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
    var la = Math.max(1, d.edgeGauge), lb = Math.max(1, d.edgeOther);
    var ang = (d.angle || 90) * Math.PI / 180;
    var dirSign = d.dir === 'DOWN' ? -1 : 1;
    /* other flange: starts at the bend point, makes angle `ang` with the gauged flange */
    var ex = Math.cos(ang), ey = Math.sin(ang) * dirSign;
    var xs = [0, la, lb * ex, d.x], ys = [0, 0, lb * ey];
    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    var k = Math.min((W - 60) / Math.max(1, maxX - minX), (H - 100) / Math.max(1, maxY - minY, 30));
    var ox = 30 - minX * k;
    var yb = dirSign > 0 ? H - 40 : 40;
    var X = function (x) { return ox + x * k; }, Y = function (y) { return yb - y * k; };
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(X(minX) - 10, Y(0)); ctx.lineTo(X(maxX) + 10, Y(0)); ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = d.dir === 'DOWN' ? C.down : C.up; ctx.lineWidth = 4; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(X(lb * ex), Y(lb * ey)); ctx.lineTo(X(0), Y(0)); ctx.lineTo(X(la), Y(0)); ctx.stroke();
    ctx.lineCap = 'butt';
    /* backgauge stop at X */
    ctx.strokeStyle = C.good; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(X(d.x), Y(0) - 14); ctx.lineTo(X(d.x), Y(0) + 14); ctx.stroke();
    text(ctx, 'X ' + (Math.round(d.x * 100) / 100), X(d.x), Y(0) + (dirSign > 0 ? 24 : -22), C.good, 12, 'center');
    text(ctx, (Math.round((d.angle || 0) * 10) / 10) + '°', X(0) + 6, Y(0) + (dirSign > 0 ? -14 : 14), C.ink, 12, 'left');
    text(ctx, 'side view · front on the left, backgauge on the right', 8, 10, C.muted, 11, 'left');
  }

  window.Sim = { analyze: analyze, hit: hit, uAt: uAt, drawTop: drawTop, drawSide: drawSide, MACHINE_W: MACHINE_W, FINGER_W: FINGER_W, MIN_Z_SUM: MIN_Z_SUM };
})();
