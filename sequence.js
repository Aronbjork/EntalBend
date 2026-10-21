/* Bend order suggestions. Builds orders bend by bend (beam search) and scores each step with the same collision
   checks as the tooling planner: the part hitting the punch or die, flanges reaching the punch holder, no punch
   fitting between flanges. Turning the part over (FLIP) and turning it round (a bend line in another direction)
   cost a little, so orders with fewer handling steps come first. Both gauge sides are tried for every bend, since
   turning the part round often moves an earlier flange out of the way. Lower score is better. */
(function () {
  'use strict';

  var BEAM = 30, FLIP = 4, TURN = 1.5;

  function parallel(a, b) {
    var ax = a.p2[0] - a.p1[0], ay = a.p2[1] - a.p1[1], bx = b.p2[0] - b.p1[0], by = b.p2[1] - b.p1[1];
    return Math.abs(ax * by - ay * bx) / (Math.hypot(ax, ay) * Math.hypot(bx, by)) < 0.02;
  }

  /* inp: { segs, bends: [{id, p1, p2, len, angle, dir, sign}], thickness, dieV, flipPunch }
     Returns up to `count` orders: [{ order: [bend indices], signs: [gauge side per bend index], score, flips, turns, boxed,
     problems: [{ step, bend, notes }] }] */
  function suggest(inp, count) {
    var n = inp.bends.length, memo = {};
    var key = 'suggest|' + inp.bends.map(function (b) { return b.id + ':' + b.p1 + ':' + b.p2; }).sort().join('|') + '#' + inp.segs.length;

    /* bend j next with gauge side sign, after the bends in prefix (only which bends are done matters for the shape;
       the gauge side of a bend that is done does not change its shape) */
    function cost(prefix, j, sign) {
      var rest = [];
      for (var i = 0; i < n; i++) if (i !== j && prefix.indexOf(i) < 0) rest.push(i);
      var order = prefix.concat([j], rest);
      var b = inp.bends[j], bends = order.map(function (i) { return inp.bends[i]; });
      bends[prefix.length] = Object.assign({}, b, { sign: sign });
      var a = Tooling.analyse({
        key: key, segs: inp.segs, bends: bends, thickness: inp.thickness,
        dieV: inp.dieV, flipPunch: inp.flipPunch, spacing: 8, progress: [0.5, 1]
      }, prefix.length);
      var c = sign === b.sign ? 0 : 0.2, notes = [];
      if (a.hitPunch) { c += 1000; notes.push('hits the punch'); }
      if (a.hitDie || isFinite(a.da) || isFinite(a.db)) { c += 1000; notes.push('hits the die'); }
      if (a.tooHigh) { c += 300; notes.push('a flange reaches the punch holder'); }
      if (a.tooLow) { c += 300; notes.push('a flange hangs below the die'); }
      var boxed = isFinite(a.pa) && isFinite(a.pb);
      if (boxed && a.pb - a.pa < b.len - 10) { c += 500; notes.push('no punch fits between the flanges'); }
      else if (boxed) c += 1;                         // needs a short (sectioned) punch
      return { c: c, notes: notes, boxed: boxed, sign: sign };
    }

    function step(prefix, j) {
      var mk = prefix.slice().sort(function (a, b) { return a - b; }).join(',') + '>' + j;
      if (!memo[mk]) {
        var p = cost(prefix, j, inp.bends[j].sign), q = cost(prefix, j, -inp.bends[j].sign);
        memo[mk] = q.c < p.c ? q : p;
      }
      return memo[mk];
    }

    var beam = [{ order: [], signs: {}, score: 0, flips: 0, turns: 0, boxed: 0, dir: 'UP', problems: [] }];
    for (var s = 0; s < n; s++) {
      var next = {};
      beam.forEach(function (st) {
        for (var j = 0; j < n; j++) {
          if (st.order.indexOf(j) >= 0) continue;
          var r = step(st.order, j), b = inp.bends[j];
          var flip = b.dir !== st.dir ? 1 : 0;
          var turn = st.order.length && !parallel(inp.bends[st.order[st.order.length - 1]], b) ? 1 : 0;
          var o = {
            order: st.order.concat([j]), signs: Object.assign({}, st.signs), score: st.score + r.c + flip * FLIP + turn * TURN, flips: st.flips + flip, turns: st.turns + turn,
            boxed: st.boxed + (r.boxed ? 1 : 0), dir: b.dir,
            problems: r.notes.length ? st.problems.concat([{ step: s + 1, bend: j, notes: r.notes }]) : st.problems
          };
          o.signs[j] = r.sign;
          /* same bends done and same last bend: only the cheaper one can lead anywhere better */
          var dk = o.order.slice().sort(function (p, q) { return p - q; }).join(',') + '>' + j + '>' + b.dir;
          if (!next[dk] || next[dk].score > o.score) next[dk] = o;
        }
      });
      beam = Object.keys(next).map(function (k) { return next[k]; }).sort(function (p, q) { return p.score - q.score; }).slice(0, BEAM);
    }
    return beam.slice(0, count || 3);
  }

  window.Sequence = { suggest: suggest };
})();
