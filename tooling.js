/* Tooling setup: splits the bends over stations of sectioned punch (and die) so a whole part can be bent in one
   set-up, for example a long station for the first bends of a box and a short one that fits between the flanges
   for the last bends. The die is one piece (not sectioned) shared by all stations. Lays the stations out over the
   die and writes the set-up sheet as a PDF.
   Machine coordinates as in the 3D simulator: x across the machine (0 = centre), y up, z towards the operator. */
(function () {
  'use strict';

  var BED = 2500, PROGRESS = [0, 0.5, 1], SAMPLE = 4;
  var r1 = function (v) { return Math.round(v * 10) / 10; };

  /* Section library [{len, qty}] or text "835x3, 200x2, 100, 50" -> [{len, qty}], longest first.
     In text a section without a count is one piece. */
  function parseStock(text) {
    var out = [], bad = [];
    if (Array.isArray(text)) {
      text.forEach(function (s) { if (+s.len > 0 && +s.qty > 0) out.push({ len: Math.round(+s.len), qty: Math.floor(+s.qty) }); });
      out.sort(function (a, b) { return b.len - a.len; });
      return { list: out, bad: bad };
    }
    String(text || '').split(/[,;\s]+/).forEach(function (tok) {
      if (!tok) return;
      var m = /^(\d+(?:\.\d+)?)(?:[x×*](\d+))?$/i.exec(tok);
      if (!m || !(+m[1] > 0)) { bad.push(tok); return; }
      out.push({ len: Math.round(+m[1]), qty: m[2] === undefined ? 1 : parseInt(m[2], 10) });
    });
    out.sort(function (a, b) { return b.len - a.len; });
    return { list: out, bad: bad };
  }

  function stockCounts(list) {
    var c = {};
    list.forEach(function (s) { c[s.len] = (c[s.len] || 0) + s.qty; });
    return c;
  }

  /* Pick sections from `counts` with a total length in [lo, hi].
     mode 'long': as long as possible (a few mm traded for fewer pieces), 'few': fewest pieces, then shortest,
     'short': shortest, then fewest pieces.
     Returns { len, pieces } (longest first) or null. */
  function compose(counts, lo, hi, mode) {
    var cap = Math.floor(Math.min(hi, BED)), from = Math.max(1, Math.ceil(lo));
    if (cap < from) return null;
    var items = [];
    Object.keys(counts).forEach(function (k) {
      var L = +k, n = Math.min(counts[k], Math.floor(cap / L));
      for (var i = 0; i < n; i++) items.push(L);
    });
    var INF = 1e9, dp = new Int32Array(cap + 1).fill(INF), take = [];
    dp[0] = 0;
    items.forEach(function (L, i) {
      var t = take[i] = new Uint8Array(cap + 1);
      for (var s = cap; s >= L; s--) if (dp[s - L] + 1 < dp[s]) { dp[s] = dp[s - L] + 1; t[s] = 1; }
    });
    var best = -1, bestScore = -Infinity;
    for (var s = from; s <= cap; s++) {
      if (dp[s] >= INF) continue;
      var sc = mode === 'long' ? s - 8 * dp[s] : mode === 'short' ? -s * 100 - dp[s] : -dp[s] * 10000 - s;
      if (sc > bestScore) { bestScore = sc; best = s; }
    }
    if (best < 0) return null;
    var pieces = [], rest = best;
    for (var i = items.length - 1; i >= 0 && rest > 0; i--) if (take[i][rest]) { pieces.push(items[i]); rest -= items[i]; }
    pieces.sort(function (a, b) { return b - a; });
    return { len: best, pieces: pieces };
  }

  function useStock(counts, pieces) { pieces.forEach(function (L) { counts[L]--; }); }

  function inPoly(poly, x, y) {
    var c = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      if ((poly[i][1] > y) !== (poly[j][1] > y) &&
          x < (poly[j][0] - poly[i][0]) * (y - poly[i][1]) / (poly[j][1] - poly[i][1]) + poly[i][0]) c = !c;
    }
    return c;
  }

  /* Width of a profile per height band (expanded by margin m), so most points can be ruled out without inPoly. */
  function bands(poly, m) {
    var y0 = Infinity, y1 = -Infinity, H = 5;
    poly.forEach(function (p) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); });
    var n = Math.max(1, Math.ceil((y1 - y0) / H)), lo = [], hi = [];
    for (var i = 0; i < n; i++) {
      var a = y0 + i * H - m, b = y0 + (i + 1) * H + m, l = Infinity, h = -Infinity;
      for (var j = 0; j < poly.length; j++) {
        var p = poly[j], q = poly[(j + 1) % poly.length];
        var ya = Math.max(a, Math.min(p[1], q[1])), yb = Math.min(b, Math.max(p[1], q[1]));
        if (ya > yb) continue;
        [ya, yb].forEach(function (y) {
          var x = q[1] === p[1] ? Math.min(p[0], q[0]) : p[0] + (y - p[1]) / (q[1] - p[1]) * (q[0] - p[0]);
          var x2 = q[1] === p[1] ? Math.max(p[0], q[0]) : x;
          l = Math.min(l, x); h = Math.max(h, x2);
        });
      }
      lo.push(l - m); hi.push(h + m);
    }
    return { y0: y0, H: H, lo: lo, hi: hi, maybe: function (w, y) {
      var i = Math.floor((y - y0) / H);
      if (i < 0) i = 0; else if (i >= n) i = n - 1;
      return w >= lo[i] && w <= hi[i];
    } };
  }

  function bbox(poly) {
    var b = [Infinity, Infinity, -Infinity, -Infinity];
    poly.forEach(function (p) { b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]); });
    return b;
  }

  /* How far the punch and die may reach to each side of bend k before they hit the part (earlier flanges, or
     flat material past the end of the bend line), and how far the part reaches out under the punches. */
  function analyse(inp, k) {
    var b = inp.bends[k], th = Math.max(0.5, inp.thickness || 1), V = inp.dieV || 8, half = b.len / 2;
    var dx = (b.p2[0] - b.p1[0]) / b.len, dy = (b.p2[1] - b.p1[1]) / b.len;
    var band = Math.max(3 * th, V / 2 + 1), m = th / 2 + 0.3;
    var flatIn = function (x, y) {
      var c = false;
      inp.segs.forEach(function (g) {
        var p = g[0], q = g[1];
        if ((p[1] > y) !== (q[1] > y) && x < p[0] + (y - p[1]) / (q[1] - p[1]) * (q[0] - p[0])) c = !c;
      });
      return c;
    };
    var res = { pa: -Infinity, pb: Infinity, da: -Infinity, db: Infinity, pmin: Infinity, pmax: -Infinity,
      hitPunch: false, hitDie: false, tooHigh: false, tooLow: false };
    (inp.progress || PROGRESS).forEach(function (prog) {
      var s = Sim3D.sample({ key: inp.key, segs: inp.segs, bends: inp.bends, step: k, progress: prog, thickness: th }, inp.spacing || SAMPLE);
      if (!s) return;
      var punch = Sim3D.punchProfile(s.tip, inp.flipPunch ? -1 : 1), die = Sim3D.dieProfile(V, s.dieTop);
      var pb = bbox(punch), db = bbox(die), P = s.P, Q = s.Q, hiY = s.tip + 147, loY = s.dieTop - Sim3D.DIE_H - 2;
      var pBand = bands(punch, m + 0.1), dBand = bands(die, m + 0.1);
      for (var i = 0, n = P.length / 3; i < n; i++) {
        var x = P[3 * i], y = P[3 * i + 1], w = -P[3 * i + 2];       // w = across the tools, back is +
        if (w < 60 && w > -60) {                                      // (the bend zone itself is never this high or low)
          if (y > hiY) res.tooHigh = true;
          else if (y < loY) res.tooLow = true;
        }
        var nearP = w > pb[0] - m && w < pb[2] + m && y > pb[1] - m && y < pb[3] + m;
        var nearD = w > db[0] - m && w < db[2] + m && y > db[1] - m && y < db[3] + m;
        if (!nearP && !nearD) continue;
        if (nearP) res.pmin = Math.min(res.pmin, x), res.pmax = Math.max(res.pmax, x);
        nearP = nearP && pBand.maybe(w, y);
        nearD = nearD && dBand.maybe(w, y);
        if (!nearP && !nearD) continue;
        var fx = Q[2 * i] - b.p1[0], fy = Q[2 * i + 1] - b.p1[1];
        var t = fx * dx + fy * dy;
        if (Math.abs(fy * dx - fx * dy) < band) {
          if (t > -0.5 && t < b.len + 0.5) continue;                     // the bend zone itself
          /* On the line of the bend past its end: only material that the line cuts through is in the way,
             not an edge that just lies along it. */
          if (!(flatIn(Q[2 * i] - dy * 1.5, Q[2 * i + 1] + dx * 1.5) && flatIn(Q[2 * i] + dy * 1.5, Q[2 * i + 1] - dx * 1.5))) continue;
        }
        var inside = Math.abs(x) < half - 1;
        if (nearP && (inPoly(punch, w, y + m) || inPoly(punch, w - m, y) || inPoly(punch, w + m, y))) {
          if (inside) res.hitPunch = true;
          else if (x < 0) res.pa = Math.max(res.pa, x); else res.pb = Math.min(res.pb, x);
        }
        if (nearD && (inPoly(die, w, y - th / 2 + 0.3) || inPoly(die, w - m, y) || inPoly(die, w + m, y))) {
          if (inside) res.hitDie = true;
          else if (x < 0) res.da = Math.max(res.da, x); else res.db = Math.min(res.db, x);
        }
      }
    });
    return res;
  }

  /* Tool centre (relative to the bend centre) for a tool of length L between the limits a..b that still covers
     the bend, as close to the middle of the bend as possible. */
  function centreTool(L, a, b, half, short, clear) {
    var lo = Math.max(a + clear + L / 2, half - short - L / 2), hi = Math.min(b - clear - L / 2, -half + short + L / 2);
    if (lo > hi) return isFinite(a) && isFinite(b) ? (a + b) / 2 : 0;
    return Math.max(lo, Math.min(hi, 0));
  }

  /* inp: { key, segs, bends: [{id, p1, p2, len, angle, dir, sign}], thickness, dieV, flipPunch,
            punchStock ([{len, qty}] or text), die: {len, centre}, clear, short, gap,
            moves: { A: mm, ... } stations moved by hand from where the plan puts them (+ = right) } */
  function plan(inp) {
    var warns = [], clear = Math.max(0, inp.clear || 0), short = Math.max(0, inp.short || 0), minGap = Math.max(0, inp.gap || 0);
    var ps = parseStock(inp.punchStock);
    if (ps.bad.length) warns.push('Punch sections not understood: ' + ps.bad.join(', '));
    if (!ps.list.length) warns.push('The punch section library is empty.');
    var pStock = stockCounts(ps.list);
    var dieL = Math.min(BED, (inp.die && +inp.die.len) || BED), dieC = (inp.die && +inp.die.centre) || 0;

    var B = inp.bends.map(function (b, k) {
      var a = analyse(inp, k);
      var lo = Math.max(5, b.len - 2 * short);
      var hi = isFinite(a.pa) && isFinite(a.pb) ? a.pb - a.pa - 2 * clear : Infinity;
      var w = [];
      if (a.hitPunch) w.push('the part hits the punch (an earlier flange is in the way): try another bend order or a gooseneck punch');
      if (a.hitDie || isFinite(a.da) || isFinite(a.db)) w.push('the part hits the die (a flange bent down reaches it; the die is one piece)');
      if (a.tooHigh) w.push('a flange reaches the punch holder (higher than about 147 mm above the punch tip)');
      if (a.tooLow) w.push('a flange hangs lower than the die');
      if (hi < lo) w.push('no punch fits: the gap between the flanges is ' + r1(a.pb - a.pa) + ' mm, the bend is ' + r1(b.len) + ' mm');
      return { k: k, len: b.len, lo: lo, hi: hi, A: a, warns: w, boxed: isFinite(hi), station: -1 };
    });

    /* Stations: bends that must fit between flanges first, tightest first, then the open bends (longest first).
       Each station takes every bend whose range contains its length. openMode picks the punch for open bends:
       'few' = fewest pieces (a full length punch if there is one), 'short' = shortest that does the job. */
    function build(openMode) {
      var stock = stockCounts(ps.list), stations = [], extra = [];
      B.forEach(function (bd) { bd.station = -1; bd.extra = []; });
      var order = B.slice().sort(function (p, q) {
        if (isFinite(p.hi) !== isFinite(q.hi)) return isFinite(p.hi) ? -1 : 1;
        return isFinite(p.hi) ? p.hi - q.hi : q.lo - p.lo;
      });
      order.forEach(function (bd) {
        if (bd.station >= 0) return;
        var fit = stations.filter(function (st) { return st.len >= bd.lo - 1e-6 && st.len <= bd.hi + 1e-6; })[0];
        if (!fit) {
          var hi = Math.max(bd.lo, Math.min(bd.hi, BED));
          var c = compose(stock, bd.lo, hi, isFinite(bd.hi) ? 'long' : openMode);
          if (c) useStock(stock, c.pieces);
          else {
            bd.extra.push('the punch sections left cannot make ' + Math.ceil(bd.lo) + (isFinite(bd.hi) ? '-' + Math.floor(bd.hi) : '') + ' mm');
            c = { len: Math.ceil(bd.lo), pieces: [], missing: true };
          }
          fit = { len: c.len, punch: c.pieces, missing: !!c.missing, bends: [] };
          stations.push(fit);
          B.forEach(function (o) { if (o.station < 0 && o.lo <= c.len + 1e-6 && o.hi >= c.len - 1e-6) { o.station = stations.length - 1; fit.bends.push(o.k); } });
        } else {
          bd.station = stations.indexOf(fit); fit.bends.push(bd.k);
        }
      });

      /* In order of first use, left to right. */
      stations.sort(function (p, q) { return Math.min.apply(null, p.bends) - Math.min.apply(null, q.bends); });
      stations.forEach(function (st, i) {
        st.name = String.fromCharCode(65 + i);
        st.bends.sort(function (p, q) { return p - q; });
        st.bends.forEach(function (k) { B[k].station = i; });
        st.bends.forEach(function (k) {
          var bd = B[k];
          bd.tc = centreTool(st.len, bd.A.pa, bd.A.pb, bd.len / 2, short, clear);
        });
        st.width = st.len;
        st.overL = 0; st.overR = 0;
        st.bends.forEach(function (k) {
          var bd = B[k];
          if (isFinite(bd.A.pmin)) st.overL = Math.max(st.overL, -st.width / 2 - (bd.A.pmin - bd.tc));
          if (isFinite(bd.A.pmax)) st.overR = Math.max(st.overR, bd.A.pmax - bd.tc - st.width / 2);
        });
        if (st.missing) extra.push('Station ' + st.name + ': not enough punch sections. Add sections to the library or change the bend order.');
      });

      /* Gaps: wide enough that the part on one station stays clear of the punch of the next (the punches come down
         together; the die runs under all stations). */
      var total = 0;
      stations.forEach(function (st, i) {
        if (i) { st.gapBefore = Math.ceil(Math.max(minGap, stations[i - 1].overR + 10, st.overL + 10) / 5) * 5; total += st.gapBefore; }
        else st.gapBefore = 0;
        total += st.width;
      });
      var u = dieC - total / 2;
      stations.forEach(function (st) {
        u += st.gapBefore;
        st.u0 = Math.round(u); st.u1 = Math.round(u + st.width); st.centre = (st.u0 + st.u1) / 2;
        u += st.width;
      });
      return { stations: stations, total: total, warns: extra, tc: B.map(function (bd) { return bd.tc; }),
        station: B.map(function (bd) { return bd.station; }), extra: B.map(function (bd) { return bd.extra; }) };
    }

    /* A full length punch is handiest, but when the stations do not fit on the die, use shorter punches for the
       open bends. */
    var res = build('few');
    if (res.total > dieL) {
      var alt = build('short');
      if (alt.total < res.total) res = alt;
    }
    B.forEach(function (bd, k) { bd.tc = res.tc[k]; bd.station = res.station[k]; bd.warns = bd.warns.concat(res.extra[k]); });
    var stations = res.stations, total = res.total;
    res.warns.forEach(function (w) { warns.push(w); });

    /* Stations moved by hand, then checks on where they ended up. */
    var moves = inp.moves || {}, d0 = dieC - dieL / 2, d1 = dieC + dieL / 2;
    stations.forEach(function (st) {
      st.move = Math.round(+moves[st.name] || 0);
      st.u0 += st.move; st.u1 += st.move; st.centre += st.move;
    });
    if (total > dieL) warns.push('The stations need ' + Math.ceil(total) + ' mm, but the die is only ' + dieL + ' mm long. Split the job or use a longer die.');
    stations.forEach(function (st, i) {
      if (st.u0 < d0 - 0.5) warns.push('Station ' + st.name + ' sticks out ' + Math.round(d0 - st.u0) + ' mm past the left end of the die.');
      if (st.u1 > d1 + 0.5) warns.push('Station ' + st.name + ' sticks out ' + Math.round(st.u1 - d1) + ' mm past the right end of the die.');
      if (st.u0 - st.overL < -BED / 2 || st.u1 + st.overR > BED / 2) warns.push('Station ' + st.name + ': the part reaches past the end of the bed.');
      if (!i) return;
      var pr = stations[i - 1], gap = st.u0 - pr.u1, need = Math.max(pr.overR, st.overL);
      if (gap < 0) warns.push('Stations ' + pr.name + ' and ' + st.name + ' overlap by ' + Math.round(-gap) + ' mm.');
      else if (gap < need + 5) warns.push('Stations ' + pr.name + ' and ' + st.name + ' are ' + Math.round(gap) + ' mm apart; the part needs about ' + Math.ceil(need + 5) + ' mm so it stays clear of the other punch.');
    });

    var tools = { punch: [], die: [[dieC - dieL / 2, dieC + dieL / 2]] };
    stations.forEach(function (st) {
      var x = st.u0;
      st.punch.forEach(function (L) { tools.punch.push([x, x + L]); x += L; });
      if (!st.punch.length) tools.punch.push([st.u0, st.u1]);
    });

    var bends = B.map(function (bd) {
      var st = stations[bd.station];
      return {
        station: bd.station, stationName: st.name, toolLen: st.len, boxed: bd.boxed,
        gap: bd.boxed ? r1(bd.A.pb - bd.A.pa) : null, shift: r1(st.centre - bd.tc), warns: bd.warns
      };
    });
    B.forEach(function (bd, k) { bd.warns.forEach(function (w) { warns.push('Bend ' + (k + 1) + ': ' + w + '.'); }); });
    return { stations: stations, bends: bends, tools: tools, warns: warns, total: Math.ceil(total), die: { len: dieL, centre: dieC } };
  }

  /* ------------------------------------------------------------------ PDF set-up sheet */

  var INK = '#1a1a1a', MUTED = '#6b6b6b', BRAND = '#2e9488', GRID = '#d8d8d8', CRIT = '#c43a3a',
    PUNCH = ['#b9c2cc', '#8f9aa6'], DIE = ['#6b7480', '#545c66'];
  var sgnMm = function (v) { return (v > 0 ? '+' : v < 0 ? '-' : '') + Math.abs(Math.round(v)); };

  function header(pg, info, title, pageNo) {
    pg.rect(0, 0, 842, 6, { fill: BRAND });
    pg.text(36, 38, title, { size: 17, bold: true });
    pg.text(806, 30, 'EntalBend · Amada HFE 80-25', { size: 8.5, color: MUTED, align: 'right' });
    pg.text(806, 42, info.date + (pageNo ? '  ·  page ' + pageNo : ''), { size: 8.5, color: MUTED, align: 'right' });
    var f = [['Program', info.program], ['Job', info.job], ['Material', info.material], ['Thickness', info.thickness + ' mm'],
      ['Punch', info.punch], ['Die', (info.die ? info.die + ', ' : '') + 'small V slot at the back'], ['Drawing', info.source]];
    var x = 36;
    f.forEach(function (p) {
      var v = String(p[1] || '-');
      x += pg.text(x, 58, p[0] + ' ', { size: 8.5, color: MUTED });
      x += pg.text(x, 58, v, { size: 8.5, bold: true, maxW: 170 }) + 14;
    });
    pg.line(36, 66, 806, 66, { color: GRID });
  }

  /* cols: [{ t: title, w: width, align }], rows: [[cells]]. Returns the y below the table. */
  function table(pg, x, y, cols, rows, o) {
    o = o || {};
    var h = o.rowH || 15, cx = x;
    pg.rect(x, y, cols.reduce(function (s, c) { return s + c.w; }, 0), h, { fill: '#f1f3f4' });
    cols.forEach(function (c) {
      pg.text(c.align === 'right' ? cx + c.w - 5 : cx + 5, y + h - 4.5, c.t, { size: 7.8, bold: true, color: '#444444', align: c.align === 'right' ? 'right' : 'left', maxW: c.w - 8 });
      cx += c.w;
    });
    y += h;
    rows.forEach(function (r) {
      cx = x;
      cols.forEach(function (c, i) {
        var cell = r[i], col = INK, bold = false;
        if (cell && typeof cell === 'object') { col = cell.color || INK; bold = !!cell.bold; cell = cell.t; }
        pg.text(c.align === 'right' ? cx + c.w - 5 : cx + 5, y + h - 4.5, cell === undefined || cell === null ? '' : String(cell),
          { size: 8.3, color: col, bold: bold, align: c.align === 'right' ? 'right' : 'left', maxW: c.w - 8 });
        cx += c.w;
      });
      pg.line(x, y + h, cx, y + h, { color: GRID, w: 0.5 });
      y += h;
    });
    return y;
  }

  function pieceRow(pg, pieces, len, x0, y, h, k, colors, label) {
    var x = x0;
    if (!pieces.length) { pg.rect(x0, y, len * k, h, { stroke: CRIT, w: 0.8 }); return; }
    pieces.forEach(function (L, i) {
      pg.rect(x, y, L * k, h, { fill: colors[i % 2], stroke: '#ffffff', w: 0.6 });
      if (label) {
        var s = String(L);
        if (PDF.textWidth(s, 7, true) + 3 < L * k) pg.text(x + L * k / 2, y + h / 2 + 2.5, s, { size: 7, bold: true, color: colors === PUNCH ? INK : '#ffffff', align: 'center' });
      }
      x += L * k;
    });
  }

  /* Whole bed at scale, then each station at its own scale. */
  function bedDrawing(pg, plan, y) {
    var x0 = 36, W = 770, k = W / BED, X = function (u) { return x0 + (u + BED / 2) * k; };
    pg.text(36, y, 'Bed layout (' + BED + ' mm, seen from the operator side)', { size: 10.5, bold: true });
    y += 14;
    pg.rect(x0, y, W, 44, { fill: '#f7f8f8', stroke: GRID, w: 0.6 });
    for (var u = -BED / 2; u <= BED / 2; u += 250) {
      pg.line(X(u), y + 44, X(u), y + 48, { color: MUTED, w: 0.5 });
      pg.text(X(u), y + 57, sgnMm(u), { size: 6.8, color: MUTED, align: 'center' });
    }
    pg.line(X(0), y - 2, X(0), y + 46, { color: CRIT, w: 0.6, dash: [3, 2] });
    pg.text(X(0) + 3, y + 8, 'centre', { size: 6.5, color: CRIT });
    var dl = plan.die.len, dc = plan.die.centre;
    pg.rect(X(dc - dl / 2), y + 24, dl * k, 13, { fill: DIE[0] });
    pg.text(X(dc), y + 33, 'die ' + dl + ' mm (one piece)', { size: 7, bold: true, color: '#ffffff', align: 'center' });
    plan.stations.forEach(function (st) {
      pieceRow(pg, st.punch, st.len, X(st.u0), y + 8, 13, k, PUNCH, false);
      pg.text(X(st.centre), y + 6, st.name, { size: 8.5, bold: true, color: BRAND, align: 'center' });
    });
    pg.text(x0 - 2, y + 18, 'P', { size: 6.5, color: MUTED, align: 'right' });
    pg.text(x0 - 2, y + 34, 'D', { size: 6.5, color: MUTED, align: 'right' });
    y += 72;

    /* station details, up to 4 per row */
    var n = plan.stations.length, per = Math.min(4, Math.max(1, n)), cw = (W - (per - 1) * 12) / per;
    plan.stations.forEach(function (st, i) {
      var cx = x0 + (i % per) * (cw + 12), cy = y + Math.floor(i / per) * 92;
      pg.rect(cx, cy, cw, 84, { stroke: GRID, w: 0.6 });
      pg.text(cx + 8, cy + 14, 'Station ' + st.name, { size: 9.5, bold: true, color: BRAND });
      pg.text(cx + cw - 8, cy + 14, 'bends ' + st.bends.map(function (k) { return k + 1; }).join(', '), { size: 8, color: MUTED, align: 'right', maxW: cw - 80 });
      var kk = (cw - 20) / Math.max(st.width, 1), sx = cx + 10 + (cw - 20 - st.width * kk) / 2;
      pieceRow(pg, st.punch, st.len, sx, cy + 26, 22, kk, PUNCH, true);
      pg.text(cx + 8, cy + 66, 'Punch ' + (st.punch.length ? st.punch.join(' + ') + ' = ' + st.len : 'MISSING ' + st.len) + ' mm', { size: 7.8, maxW: cw - 16, color: st.missing ? CRIT : INK });
      pg.text(cx + 8, cy + 78, 'From ' + sgnMm(st.u0) + ' to ' + sgnMm(st.u1) + ' mm (machine centre = 0)', { size: 7.8, maxW: cw - 16, color: MUTED });
    });
    return y + Math.ceil(n / per) * 92;
  }

  /* info: { program, job, material, thickness, punch, die, source, date, rows: [{ n, angle, dir, flip, len, x, z1, z2, r1, r2 }] }
     pics: [{ caption, bytes, w, h }] */
  function pdf(plan, info, pics) {
    var doc = new PDF.Doc(true), page = 1;
    var pg = doc.page();
    header(pg, info, 'Tooling setup', page);
    var y = bedDrawing(pg, plan, 88) + 6;
    y = table(pg, 36, y, [
      { t: 'Station', w: 52 }, { t: 'Punch sections, left to right (mm)', w: 290 }, { t: 'Punch', w: 60, align: 'right' },
      { t: 'Left end', w: 70, align: 'right' }, { t: 'Right end', w: 70, align: 'right' },
      { t: 'From bed left end', w: 110, align: 'right' }, { t: 'Bends', w: 118 }
    ], plan.stations.map(function (st) {
      return [{ t: st.name, bold: true, color: BRAND }, st.punch.length ? st.punch.join(' + ') : { t: 'missing', color: CRIT }, st.len,
        sgnMm(st.u0), sgnMm(st.u1),
        (st.u0 + BED / 2) + ' - ' + (st.u1 + BED / 2), st.bends.map(function (k) { return k + 1; }).join(', ')];
    }));
    y += 12;
    var notes = ['Positions are punch ends in mm from the machine centre (- = left). Die: one piece, ' + plan.die.len + ' mm, from ' +
        sgnMm(plan.die.centre - plan.die.len / 2) + ' to ' + sgnMm(plan.die.centre + plan.die.len / 2) + ' mm.',
      'All bends use the small V slot at the back of the die. All punch sections must be the same type and height.',
      'Z1/Z2 in the program are for the part placed at its station as in the bend list.'];
    plan.warns.forEach(function (w) { notes.push('!' + w); });
    notes.forEach(function (s) {
      if (y > 570) { pg = doc.page(); header(pg, info, 'Tooling setup', ++page); y = 88; }
      var warn = s[0] === '!';
      pg.text(36, y, (warn ? 'Warning: ' : '') + (warn ? s.slice(1) : s), { size: 8.3, color: warn ? CRIT : MUTED, bold: warn, maxW: 770 });
      y += 12;
    });

    /* bend list */
    pg = doc.page(); header(pg, info, 'Bend list', ++page);
    var cols = [{ t: '#', w: 26, align: 'right' }, { t: 'Station', w: 46 }, { t: 'Angle', w: 46, align: 'right' }, { t: 'Dir', w: 54 },
      { t: 'Bend length', w: 62, align: 'right' }, { t: 'Punch', w: 46, align: 'right' }, { t: 'Gap between flanges', w: 94, align: 'right' },
      { t: 'Part centre from machine centre', w: 136, align: 'right' }, { t: 'X', w: 50, align: 'right' }, { t: 'Z1', w: 40, align: 'right' },
      { t: 'Z2', w: 40, align: 'right' }, { t: 'R1 / R2', w: 54, align: 'right' }, { t: 'Notes', w: 116 }];
    var rows = info.rows.map(function (r, i) {
      var b = plan.bends[i];
      var note = (r.flip ? 'FLIP. ' : '') + (b.boxed ? 'Between flanges. ' : '') + (b.warns.length ? 'See warning.' : '');
      return [r.n, { t: b.stationName, bold: true, color: BRAND }, r.angle + '°', r.dir === 'DOWN' ? 'Down' : 'Up', r1(r.len), b.toolLen,
        b.gap === null ? '-' : b.gap, sgnMm(b.shift) + ' mm', r.x.toFixed(2), r.z1, r.z2, r.r1 + ' / ' + r.r2,
        { t: note, color: b.warns.length ? CRIT : INK }];
    });
    for (var i = 0; i < rows.length; i += 30) {
      if (i) { pg = doc.page(); header(pg, info, 'Bend list', ++page); }
      y = table(pg, 36, 82, cols, rows.slice(i, i + 30));
    }
    y += 12;
    pg.text(36, y, 'Gap between flanges: free length for the punch between flanges that are already bent (box bends). Part centre: where the middle of the bend line sits along the machine.', { size: 7.8, color: MUTED, maxW: 770 });

    /* pictures, 2 x 2 per page */
    for (var p = 0; p < pics.length; p++) {
      if (p % 4 === 0) { pg = doc.page(); header(pg, info, '3D view per bend', ++page); }
      var c = p % 4, cw = 378, ih = Math.round(cw * pics[p].h / pics[p].w);
      var px = 36 + (c % 2) * (cw + 14), py = 80 + Math.floor(c / 2) * (ih + 30);
      pg.image(doc.jpeg(pics[p].bytes, pics[p].w, pics[p].h), px, py, cw, ih);
      pg.rect(px, py, cw, ih, { stroke: GRID, w: 0.6 });
      pg.text(px, py + ih + 13, pics[p].caption, { size: 8.5, bold: true, maxW: cw });
    }
    return doc.bytes();
  }

  window.Tooling = { parseStock: parseStock, compose: compose, analyse: analyse, plan: plan, pdf: pdf };
})();
