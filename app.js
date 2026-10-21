/* EntalBend – UI, bend sequence, program output and USB export. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var f2 = function (v) { return (Math.round(v * 100) / 100).toFixed(2); };
  var r2 = function (v) { return Math.round(v * 100) / 100; };
  var esc = function (s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  };

  var state = {
    fileName: '', dxfText: '', data: null, model: null, layerStats: {}, currentName: '',
    useLinetype: true, bendLayers: new Set(), ignoreLayers: new Set(), forced: new Map(),
    gap: 6, minLen: 5, scale: 1,
    seq: [],                       // [{id, angle, dir:'UP'|'DOWN', sign:+1|-1, offset}]
    view: { ox: 0, oy: 0, k: 1 }, viewTouched: false,   // refit on resize until the user zooms or pans
    hover: null, outputEdited: false, simStep: 0, simDrag: null, simProgress: 0, simTab: '3d'
  };

  var SETTINGS_IDS = ['progNo', 'job', 'material', 'thickness', 'punch', 'die', 'defAngle',
    'outFormat'];

  /* ------------------------------------------------------------------ status */

  function setStatus(msg, isErr) {
    var s = $('status');
    s.textContent = msg;
    s.className = 'statusbar' + (isErr ? ' err' : '');
  }

  /* ------------------------------------------------------------------ file loading */

  function loadFile(file) {
    if (!file) return;
    if (/\.dwg$/i.test(file.name)) { setStatus('DWG is not supported. Export the drawing as ASCII DXF.', true); return; }
    var reader = new FileReader();
    reader.onload = function () {
      var text = String(reader.result);
      if (/\.(json|entalbend)$/i.test(file.name)) importProgram(text, file.name);
      else { state.currentName = ''; $('progName').value = ''; loadText(text, file.name); renderLibrary(); }
    };
    reader.onerror = function () { setStatus('Could not read the file.', true); };
    reader.readAsText(file);
  }

  /* `saved` is a saved program's detection block; it restores the layer and line choices. */
  function loadText(text, name, saved) {
    var data;
    try { data = DXF.parse(text); }
    catch (err) { setStatus('Could not read DXF: ' + err.message, true); return false; }
    state.data = data;
    state.dxfText = text;
    state.fileName = name;
    state.forced = new Map(saved ? saved.forced : []);
    state.bendLayers = new Set(saved ? saved.bendLayers : []);
    state.ignoreLayers = new Set(saved ? saved.ignoreLayers : []);
    state.layerStats = {};
    data.entities.forEach(function (e) {
      var st = state.layerStats[e.layer] || (state.layerStats[e.layer] = { count: 0, ltype: '' });
      st.count++;
    });
    Object.keys(state.layerStats).forEach(function (n) {
      var L = data.layers[n];
      state.layerStats[n].ltype = L ? L.ltype : 'CONTINUOUS';
    });
    $('fileName').textContent = name;
    $('hint').hidden = true;
    rebuild(true);
    var n = state.model.bends.length;
    setStatus(n ? n + ' bend line' + (n === 1 ? '' : 's') + ' found. Click a bend line to add it to the sequence.'
                : 'No bend lines found. Mark a layer as Bend, or Shift+click a line to treat it as a bend.', !n);
    return true;
  }

  function rebuild(fit) {
    if (!state.data) return;
    var hadSeq = state.seq.length;
    state.seq = [];
    state.model = DXF.buildModel(state.data, {
      useLinetype: state.useLinetype, bendLayers: state.bendLayers, ignoreLayers: state.ignoreLayers,
      forced: state.forced, gap: state.gap, minLen: state.minLen, scale: state.scale
    });
    renderLayers();
    if (fit) fitView();
    renderTable();
    updateInfo();
    if (hadSeq) setStatus('Detection changed. The bend selection was cleared.');
  }

  function updateInfo() {
    var m = state.model;
    if (!m) { $('detectInfo').textContent = ''; return; }
    var t = m.bends.length + ' bend line(s) · sheet ' + f2(m.sheet.w) + ' × ' + f2(m.sheet.h) + ' mm';
    var un = state.data.unsupported, keys = Object.keys(un);
    if (keys.length) t += ' · not imported: ' + keys.map(function (k) { return un[k] + ' ' + k; }).join(', ');
    $('detectInfo').textContent = t;
  }

  function renderLayers() {
    var body = $('layerBody');
    var names = Object.keys(state.layerStats).sort();
    if (!names.length) { body.innerHTML = '<tr><td colspan="4" class="empty">Load a DXF to list its layers.</td></tr>'; return; }
    body.innerHTML = names.map(function (n) {
      var st = state.layerStats[n];
      return '<tr><td>' + esc(n) + ' <span class="muted">(' + st.count + ')</span></td><td>' + esc(st.ltype) + '</td>' +
        '<td><input type="checkbox" data-layer="' + esc(n) + '" data-kind="bend"' + (state.bendLayers.has(n) ? ' checked' : '') + '></td>' +
        '<td><input type="checkbox" data-layer="' + esc(n) + '" data-kind="ignore"' + (state.ignoreLayers.has(n) ? ' checked' : '') + '></td></tr>';
    }).join('');
  }

  /* ------------------------------------------------------------------ rows / metrics */

  function computeRows() {
    var m = state.model;
    if (!m) return [];
    var rows = [], prevDir = 'UP';
    state.seq.forEach(function (e, i) {
      var b = m.bends.filter(function (x) { return x.id === e.id; })[0];
      if (!b) return;
      var xEdge = DXF.sideExtent(b, e.sign, m.outlinePts);
      var flip = e.dir !== prevDir;
      prevDir = e.dir;
      rows.push({ n: i + 1, e: e, b: b, xEdge: xEdge, xFinal: xEdge + e.offset, flip: flip, same: null });
    });
    rows.forEach(function (r, k) {
      var best = null;
      for (var j = 0; j < k; j++) {
        var s = DXF.sameFlange(r.b, r.e.sign, rows[j].b, r.xEdge);
        if (s !== null && (best === null || s < best.dist)) best = { n: rows[j].n, dist: s };
      }
      r.same = best;
      /* A bend on a flange that already has an earlier bend is gauged against that bend: X is the distance
         between the two bend lines, not the distance to the flat edge. */
      if (best) r.xFinal = best.dist + r.e.offset;
    });
    return rows;
  }

  /* ------------------------------------------------------------------ table */

  function renderTable() {
    var rows = computeRows();
    applyAuto(rows);
    var tb = $('seqBody');
    if (!rows.length) {
      tb.innerHTML = '<tr><td colspan="15" class="empty">No bends selected. Click the dashed bend lines in the drawing in the order you want to bend them.</td></tr>';
    } else {
      tb.innerHTML = rows.map(function (r, i) {
        return '<tr data-i="' + i + '"' + (i === state.simStep ? ' class="sel"' : '') + '>' +
          '<td class="num">' + r.n + '</td>' +
          '<td>' + esc(r.b.id) + '</td>' +
          '<td><input type="number" data-f="angle" step="0.1" min="0" max="180" value="' + r.e.angle + '"></td>' +
          '<td><select data-f="dir"><option value="UP"' + (r.e.dir === 'UP' ? ' selected' : '') + '>Up ▲</option>' +
            '<option value="DOWN"' + (r.e.dir === 'DOWN' ? ' selected' : '') + '>Down ▼</option></select></td>' +
          '<td class="num">' + f2(r.b.len) + '</td>' +
          '<td><button class="mini" type="button" data-act="side" title="Measure to the other side of the bend line">' + (r.e.sign === 1 ? 'A' : 'B') + ' ⇄</button></td>' +
          '<td class="num">' + f2(r.xEdge) + '</td>' +
          '<td><input type="number" data-f="offset" step="0.1" value="' + r.e.offset + '"' + (r.same ? ' class="hl"' : '') + '></td>' +
          '<td class="num strong" data-x>' + f2(r.xFinal) + '</td>' +
          ['z1', 'z2', 'r1', 'r2'].map(function (k) {
            return '<td><input type="number" class="axis" data-f="' + k + '" step="any" placeholder="' + usbDefault(k) + '" value="' +
              (r.e[k] === null || r.e[k] === undefined ? '' : r.e[k]) + '"></td>';
          }).join('') +
          '<td class="notes">' + (r.flip ? '<span class="tag flip">FLIP</span>' : '') +
            (r.same ? '<span class="tag same">2nd bend on the flange of #' + r.same.n + ': X = distance to it (' + f2(r.same.dist) + ' mm), not to the edge</span>' : '') + '</td>' +
          '<td class="acts"><button class="mini" type="button" data-act="up" title="Earlier">▲</button>' +
            '<button class="mini" type="button" data-act="down" title="Later">▼</button>' +
            '<button class="mini" type="button" data-act="del" title="Remove">✕</button></td>' +
          '</tr>';
      }).join('');
    }
    refreshOutput(false);
    draw();
    renderSettings();
    drawSim();
  }

  function updateDerived() {
    var rows = computeRows();
    applyAuto(rows);
    var trs = $('seqBody').querySelectorAll('tr[data-i]');
    rows.forEach(function (r, i) {
      var cell = trs[i] && trs[i].querySelector('[data-x]');
      if (cell) cell.textContent = f2(r.xFinal);
    });
    refreshOutput(false);
    drawSim();
  }

  /* ------------------------------------------------------------------ output */

  function programData() {
    var rows = computeRows();
    return {
      source: state.fileName,
      program: $('progNo').value.trim(),
      job: $('job').value.trim(),
      material: $('material').value.trim(),
      thickness: parseFloat($('thickness').value) || 0,
      punch: $('punch').value.trim(),
      die: $('die').value.trim(),
      bends: rows.map(function (r) {
        return {
          seq: r.n, bend: r.b.id, angle: r.e.angle, direction: r.e.dir, flip: r.flip,
          length: r2(r.b.len), toEdge: r2(r.xEdge), offset: r2(r.e.offset), x: r2(r.xFinal),
          secondBendOnFlangeOf: r.same ? r.same.n : null
        };
      })
    };
  }

  function formatProgram(kind) {
    var d = programData();
    if (kind === 'json') return JSON.stringify(d, null, 2);
    if (kind === 'csv') {
      var out = ['seq;angle;direction;flip;length;to_edge;offset;x'];
      d.bends.forEach(function (b) {
        out.push([b.seq, b.angle, b.direction, b.flip ? 'FLIP' : '', f2(b.length), f2(b.toEdge), f2(b.offset), f2(b.x)].join(';'));
      });
      return out.join('\r\n');
    }
    var L = [];
    L.push('ENTALBEND PROGRAM');
    L.push('SOURCE     ' + d.source);
    L.push('PROGRAM    ' + d.program);
    L.push('JOB        ' + d.job);
    L.push('MATERIAL   ' + d.material);
    L.push('THICKNESS  ' + f2(d.thickness));
    L.push('PUNCH      ' + d.punch);
    L.push('DIE        ' + d.die);
    L.push('BENDS      ' + d.bends.length);
    L.push('');
    L.push('SEQ  ANGLE  DIR   TURN  LENGTH   X        OFFSET');
    d.bends.forEach(function (b) {
      L.push(String(b.seq).padEnd(5) + String(b.angle).padEnd(7) + b.direction.padEnd(6) + (b.flip ? 'FLIP' : '-').padEnd(6) +
        f2(b.length).padEnd(9) + f2(b.x).padEnd(9) + f2(b.offset));
    });
    return L.join('\r\n');
  }

  function refreshOutput(force) {
    if (state.outputEdited && !force) return;
    $('outText').value = formatProgram($('outFormat').value);
    state.outputEdited = false;
    $('outEditedNote').hidden = true;
  }

  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function baseName() {
    return (state.fileName || 'program').replace(/\.[^.]+$/, '');
  }

  /* ------------------------------------------------------------------ canvas */

  function sizeCanvas() {
    var cv = $('cv'), wrap = $('dropZone');
    var dpr = window.devicePixelRatio || 1;
    var w = wrap.clientWidth, h = wrap.clientHeight;
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
    if (state.model && !state.viewTouched) fitView();
    else draw();
  }

  function cssW() { return $('cv').width / (window.devicePixelRatio || 1); }
  function cssH() { return $('cv').height / (window.devicePixelRatio || 1); }

  function fitView() {
    var m = state.model;
    if (!m) return;
    var w = cssW(), h = cssH(), bb = m.bbox;
    var bw = Math.max(bb.maxx - bb.minx, 1e-6), bh = Math.max(bb.maxy - bb.miny, 1e-6);
    var k = Math.min(w / bw, h / bh) * 0.86;
    if (!isFinite(k) || k <= 0) k = 1;
    var cx = (bb.minx + bb.maxx) / 2, cy = (bb.miny + bb.maxy) / 2;
    state.view = { k: k, ox: w / 2 - cx * k, oy: h / 2 + cy * k };
    state.viewTouched = false;
    draw();
  }

  function colors() {
    var cs = getComputedStyle(document.documentElement);
    var g = function (n) { return cs.getPropertyValue(n).trim(); };
    return { outline: g('--outline'), cand: g('--cand'), up: g('--up'), down: g('--down') };
  }

  function draw() {
    var cv = $('cv');
    var ctx = cv.getContext('2d');
    if (!ctx) return;
    var dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW(), cssH());
    var m = state.model;
    if (!m) return;
    var v = state.view, col = colors();
    var X = function (x) { return v.ox + x * v.k; };
    var Y = function (y) { return v.oy - y * v.k; };

    ctx.lineJoin = 'round';
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = col.outline;
    ctx.setLineDash([]);
    ctx.beginPath();
    m.outline.forEach(function (p) {
      if (p.kind === 'line') { ctx.moveTo(X(p.p1[0]), Y(p.p1[1])); ctx.lineTo(X(p.p2[0]), Y(p.p2[1])); }
      else p.pts.forEach(function (q, i) { if (i) ctx.lineTo(X(q[0]), Y(q[1])); else ctx.moveTo(X(q[0]), Y(q[1])); });
    });
    ctx.stroke();

    m.bends.forEach(function (b) {
      var idx = -1;
      state.seq.forEach(function (e, i) { if (e.id === b.id) idx = i; });
      var x1 = X(b.p1[0]), y1 = Y(b.p1[1]), x2 = X(b.p2[0]), y2 = Y(b.p2[1]);
      var hov = state.hover === b.id;
      if (idx < 0) {
        ctx.strokeStyle = col.cand;
        ctx.lineWidth = hov ? 4 : 2.2;
        ctx.setLineDash([9, 5]);
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        ctx.setLineDash([]);
        return;
      }
      var e = state.seq[idx];
      var c = e.dir === 'UP' ? col.up : col.down;
      ctx.strokeStyle = c;
      ctx.lineWidth = hov ? 5 : 3.5;
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();

      var mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      var dx = (b.p2[0] - b.p1[0]) / b.len, dy = (b.p2[1] - b.p1[1]) / b.len;
      var nx = -dy * e.sign, ny = dx * e.sign;      // world normal toward gauge side
      var sx = nx, sy = -ny;                          // screen vector
      var ax = mx + sx * 40, ay = my + sy * 40;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(mx + sx * 12, my + sy * 12); ctx.lineTo(ax, ay); ctx.stroke();
      var ang = Math.atan2(ay - my, ax - mx);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - 9 * Math.cos(ang - 0.5), ay - 9 * Math.sin(ang - 0.5));
      ctx.lineTo(ax - 9 * Math.cos(ang + 0.5), ay - 9 * Math.sin(ang + 0.5));
      ctx.closePath(); ctx.fillStyle = c; ctx.fill();

      ctx.beginPath(); ctx.arc(mx, my, 11, 0, Math.PI * 2); ctx.fillStyle = c; ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 12px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(idx + 1), mx, my + 0.5);
    });
  }

  function distSeg(px, py, x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
    var t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  function hitBend(px, py) {
    var m = state.model, v = state.view, best = null, bd = 10;
    if (!m) return null;
    m.bends.forEach(function (b) {
      var d = distSeg(px, py, v.ox + b.p1[0] * v.k, v.oy - b.p1[1] * v.k, v.ox + b.p2[0] * v.k, v.oy - b.p2[1] * v.k);
      if (d < bd) { bd = d; best = b; }
    });
    return best;
  }

  function hitOutlineLine(px, py) {
    var m = state.model, v = state.view, best = null, bd = 10;
    if (!m) return null;
    m.outline.forEach(function (p) {
      if (p.kind !== 'line') return;
      var d = distSeg(px, py, v.ox + p.p1[0] * v.k, v.oy - p.p1[1] * v.k, v.ox + p.p2[0] * v.k, v.oy - p.p2[1] * v.k);
      if (d < bd) { bd = d; best = p; }
    });
    return best;
  }

  function toggleBend(b) {
    var i = -1;
    state.seq.forEach(function (e, n) { if (e.id === b.id) i = n; });
    if (i >= 0) state.seq.splice(i, 1);
    else state.seq.push({
      id: b.id, angle: parseFloat($('defAngle').value) || 90, dir: 'UP',
      sign: DXF.defaultSide(b, state.model.outlinePts), offset: 0, z1: null, z2: null, r1: null, r2: null, zAuto: true, set: {}
    });
    setSimStep(state.seq.length - 1);
    renderTable();
  }

  function describeBend(b) {
    var pts = state.model.outlinePts;
    return b.id + ': length ' + f2(b.len) + ' mm, edge distance A ' + f2(DXF.sideExtent(b, 1, pts)) +
      ' / B ' + f2(DXF.sideExtent(b, -1, pts)) + ' mm';
  }

  function bindCanvas() {
    var cv = $('cv'), drag = null;

    cv.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0) return;
      drag = { x: ev.offsetX, y: ev.offsetY, ox: state.view.ox, oy: state.view.oy, moved: false, shift: ev.shiftKey };
      cv.setPointerCapture(ev.pointerId);
    });
    cv.addEventListener('pointermove', function (ev) {
      if (drag) {
        var dx = ev.offsetX - drag.x, dy = ev.offsetY - drag.y;
        if (drag.moved || Math.hypot(dx, dy) > 4) {
          drag.moved = true;
          state.viewTouched = true;
          state.view.ox = drag.ox + dx; state.view.oy = drag.oy + dy;
          draw();
        }
        return;
      }
      var b = hitBend(ev.offsetX, ev.offsetY);
      var id = b ? b.id : null;
      if (id !== state.hover) {
        state.hover = id;
        cv.style.cursor = b ? 'pointer' : 'default';
        if (b) setStatus(describeBend(b));
        draw();
      }
    });
    cv.addEventListener('pointerup', function (ev) {
      if (!drag) return;
      var d = drag; drag = null;
      try { cv.releasePointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      if (d.moved || !state.model) return;
      if (d.shift) { markLine(ev.offsetX, ev.offsetY); return; }
      var b = hitBend(ev.offsetX, ev.offsetY);
      if (b) toggleBend(b);
    });
    cv.addEventListener('contextmenu', function (ev) {
      ev.preventDefault();
      var b = hitBend(ev.offsetX, ev.offsetY);
      if (!b) return;
      var e = state.seq.filter(function (x) { return x.id === b.id; })[0];
      if (!e) { setStatus('Select the bend first, then right-click to flip its direction.'); return; }
      e.dir = e.dir === 'UP' ? 'DOWN' : 'UP';
      renderTable();
    });
    cv.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      var v = state.view, f = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
      var wx = (ev.offsetX - v.ox) / v.k, wy = (v.oy - ev.offsetY) / v.k;
      state.viewTouched = true;
      v.k *= f;
      v.ox = ev.offsetX - wx * v.k;
      v.oy = ev.offsetY + wy * v.k;
      draw();
    }, { passive: false });
    cv.addEventListener('pointerleave', function () {
      if (state.hover) { state.hover = null; draw(); }
    });
  }

  function markLine(px, py) {
    var b = hitBend(px, py);
    if (b) {
      b.members.forEach(function (id) { state.forced.set(id, false); });
      rebuild(false);
      setStatus('Unmarked ' + b.id + ' as a bend line.');
      return;
    }
    var p = hitOutlineLine(px, py);
    if (p) {
      state.forced.set(p.id, true);
      rebuild(false);
      setStatus('Marked a line as a bend line.');
    }
  }

  /* ------------------------------------------------------------------ bend simulator */

  /* ------------------------------------------------------------------ per-bend settings (lower half of the control screen) */

  var SETTING_DEFS = [
    { k: 'cycle', label: 'Cycle', def: 1, step: 1 },
    { k: 'ton', label: 'Tonnage (kN)', def: 70, step: 1 },
    { k: 'hold', label: 'End hold (s)', def: 0.2, step: 0.1 },
    { k: 'bspeed', label: 'B.speed (mm/s)', def: 10, step: 1 },
    { k: 'odc', label: 'O.D.C (mm)', def: 15, step: 1 },
    { k: 'retDist', label: 'Ret. dist (mm)', def: 0, step: 1, note: 'unverified' },
    { k: 'aux', label: 'Aux funct.', def: '000000', text: true }
  ];

  function cleanSet(o) {
    var out = {};
    SETTING_DEFS.forEach(function (d) {
      var v = o && o[d.k];
      if (v === null || v === undefined || v === '') return;
      if (d.text) { if (/^[01]{1,6}$/.test(String(v))) out[d.k] = String(v); }
      else if (isFinite(+v)) out[d.k] = +v;
    });
    return out;
  }

  function renderSettings() {
    var box = $('stepSettings');
    var e = state.seq[state.simStep];
    if (!e) { box.innerHTML = ''; return; }
    if (!e.set) e.set = {};
    box.innerHTML = '<h3>Settings for bend ' + (state.simStep + 1) + ' (as on the control)</h3><div class="grid">' +
      SETTING_DEFS.map(function (d) {
        var v = e.set[d.k];
        return '<label>' + d.label + (d.note ? ' <span class="muted">(' + d.note + ')</span>' : '') +
          '<input data-set="' + d.k + '" ' + (d.text ? 'maxlength="6"' : 'type="number" step="' + d.step + '"') +
          ' placeholder="' + d.def + '" value="' + (v === undefined || v === null ? '' : v) + '"></label>';
      }).join('') + '</div><div class="tools"><button class="mini" type="button" id="setAll">Apply to all bends</button>' +
      '<button class="mini" type="button" id="setReset">Back to defaults</button>' +
      '<span class="muted small">Empty = default (shown greyed). Stored per bend. STEP, COINING, B.G HOLD, WAIT.RET, R.SPEED and dX AUTO are not written yet.</span></div>';
  }

  function simRow() {
    var rows = computeRows();
    if (!rows.length) return null;
    if (state.simStep >= rows.length) state.simStep = rows.length - 1;
    if (state.simStep < 0) state.simStep = 0;
    return { rows: rows, r: rows[state.simStep] };
  }

  function outlineSegs() {
    var segs = [];
    state.model.outline.forEach(function (p) {
      if (p.kind === 'line') segs.push([p.p1, p.p2]);
      else for (var i = 1; i < p.pts.length; i++) segs.push([p.pts[i - 1], p.pts[i]]);
    });
    return segs;
  }

  function axisValues(e) {
    var ax = {};
    AXES.forEach(function (k) { var v = axisVal(e[k]); ax[k] = v === null ? usbDefault(k) : v; });
    return ax;
  }

  function simData(r, ax, segs) {
    var e = r.e;
    return {
      segs: segs, bend: r.b, sign: e.sign, shift: parseFloat($('simShift').value) || 0, x: r.xFinal,
      z1: ax.z1, z2: ax.z2, r1: ax.r1, r2: ax.r2, angle: e.angle, dir: e.dir,
      edgeGauge: r.xEdge, edgeOther: DXF.sideExtent(r.b, -e.sign, state.model.outlinePts),
      clipV: r.same ? r.same.dist : undefined
    };
  }

  /* Z1 + Z2 must be at least MIN_Z_SUM (60/60 is the closest). Changing one pushes the other. */
  function enforceZ(e, changed) {
    var ax = axisValues(e), min = Sim.MIN_Z_SUM;
    if (ax.z1 + ax.z2 >= min) return false;
    if (changed === 'z1') e.z2 = min - ax.z1; else e.z1 = min - ax.z2;
    return true;
  }

  /* Put both fingers on the gauged edge of the part (inside the longest stretch of edge at the stop position). */
  function autoFingers(r, segs) {
    var A = Sim.analyze(simData(r, { z1: 60, z2: 60, r1: 0, r2: 0 }, segs));
    var v = r.xFinal - 0.5, best = null, run = null;
    for (var u = Math.floor(A.umin); u <= Math.ceil(A.umax); u++) {
      if (A.inside(u, v)) { if (!run) run = [u, u]; else run[1] = u; }
      else if (run) { if (!best || run[1] - run[0] > best[1] - best[0]) best = run; run = null; }
    }
    if (run && (!best || run[1] - run[0] > best[1] - best[0])) best = run;
    if (!best) return false;
    var half = Sim.FINGER_W / 2, m = 10, zl = best[0] + half + m, zr = best[1] - half - m;
    if (zr - zl < Sim.MIN_Z_SUM) { var c = (best[0] + best[1]) / 2; zl = c - Sim.MIN_Z_SUM / 2; zr = c + Sim.MIN_Z_SUM / 2; }
    r.e.z1 = Math.round(-zl); r.e.z2 = Math.round(zr);
    return true;
  }

  /* Re-place the fingers of every bend that is still on automatic Z. */
  function applyAuto(rows) {
    if (!state.model || !rows.some(function (r) { return r.e.zAuto; })) return;
    var segs = outlineSegs();
    rows.forEach(function (r) { if (r.e.zAuto) autoFingers(r, segs); });
  }

  var simAnim = null;
  function stopSimAnim() { if (simAnim) { cancelAnimationFrame(simAnim); simAnim = null; } $('simPlay').textContent = 'Bend \u25B6'; }

  function setSimStep(n) {
    state.simStep = Math.max(0, n);
    state.simProgress = 0; $('simProg').value = 0;
    stopSimAnim();
  }

  function playSim() {
    if (simAnim) { stopSimAnim(); return; }
    if (state.simProgress >= 1) state.simProgress = 0;
    var t0 = performance.now(), p0 = state.simProgress;
    $('simPlay').textContent = 'Stop \u25A0';
    var tick = function (t) {
      state.simProgress = Math.min(1, p0 + (t - t0) / 2500);
      $('simProg').value = Math.round(state.simProgress * 100);
      drawSim();
      if (state.simProgress < 1) simAnim = requestAnimationFrame(tick);
      else { simAnim = null; $('simPlay').textContent = 'Bend \u25B6'; }
    };
    simAnim = requestAnimationFrame(tick);
  }

  function dieV() {
    var m = /(\d{2})\s*$/.exec($('die').value.trim());
    var v = m ? parseInt(m[1], 10) : 8;
    return v >= 3 && v <= 80 ? v : 8;
  }

  function drawSim() {
    var info = $('simInfo'), lab = $('simStepLabel');
    var cur = state.model ? simRow() : null;
    var top = $('simTop'), side = $('simSide'), is3d = state.simTab === '3d';
    if (!cur) {
      lab.textContent = 'No bend';
      [top, side].forEach(function (c) { c.style.height = '0px'; c.height = 0; });
      info.textContent = 'Select a bend in the sequence to see the backgauge fingers.';
      return;
    }
    var r = cur.r, e = r.e, m = state.model;
    lab.textContent = 'Bend ' + r.n + ' of ' + cur.rows.length;
    var ax = axisValues(e), segs = outlineSegs();
    var d = simData(r, ax, segs);
    var A = Sim.analyze(d);
    if (is3d) {
      var mn = [Infinity, Infinity], mx = [-Infinity, -Infinity];
      m.outlinePts.forEach(function (p) { mn[0] = Math.min(mn[0], p[0]); mn[1] = Math.min(mn[1], p[1]); mx[0] = Math.max(mx[0], p[0]); mx[1] = Math.max(mx[1], p[1]); });
      var rowsB = cur.rows.map(function (q) { return { id: q.b.id, p1: q.b.p1, p2: q.b.p2, len: q.b.len, angle: q.e.angle, dir: q.e.dir, sign: q.e.sign }; });
      Sim3D.update({
        key: rowsB.map(function (q) { return q.id + ':' + q.p1 + ':' + q.p2; }).join('|') + '#' + segs.length + '#' + mn + mx,
        segs: segs, bends: rowsB, step: state.simStep, progress: state.simProgress, shift: d.shift, x: r.xFinal,
        z1: ax.z1, z2: ax.z2, r1: ax.r1, r2: ax.r2, thickness: parseFloat($('thickness').value) || 1, dieV: dieV(),
        flipPunch: $('simFlip').checked, punchLen: /^(835|415|800)$/.test($('punch').value.trim()) ? parseInt($('punch').value, 10) : 0,
        fingerOk: A.fingers.map(function (f) { return f.cover >= 0.4; }), span: Math.max(mx[0] - mn[0], mx[1] - mn[1])
      }, $('sim3dWrap'));
    } else {
      Sim.drawTop(top, d, A, { zoom: $('simZoom').checked, range: state.simDrag ? state.simDrag.range : null });
      Sim.drawSide(side, d);
    }
    var line = function (f) {
      return f.name + ' ' + (f.name === 'Z1' ? ax.z1 + ' mm left' : ax.z2 + ' mm right') + ' of centre, touches ' + Math.round(f.cover * 100) + '% of the finger';
    };
    info.innerHTML = '<div>Backgauge X ' + f2(r.xFinal) + ' mm \u00b7 R1 ' + ax.r1 + ' \u00b7 R2 ' + ax.r2 + ' \u00b7 angle ' + e.angle + '\u00b0 \u00b7 ' +
      (e.dir === 'UP' ? 'Up' : 'Down') + (r.flip ? ' (FLIP)' : '') + (e.zAuto ? ' \u00b7 fingers automatic' : '') + '</div>' +
      '<div>' + A.fingers.map(line).join('<br>') + '</div>' +
      A.warns.concat(['r1', 'r2'].filter(function (k) { return ax[k] < 0 && r.xFinal < 30; }).map(function (k) { return k.toUpperCase() + ' is below the die top: the finger would hit the die.'; })).map(function (w) { return '<div class="bad">' + esc(w) + '</div>'; }).join('');
  }

  /* ------------------------------------------------------------------ USB export (Operateur 2000) */

  var AXES = ['z1', 'z2', 'r1', 'r2'];
  function axisVal(v) { return v === null || v === undefined || !isFinite(+v) ? null : +v; }
  function usbDefault(k) {
    var v = parseFloat($(k[0] === 'z' ? 'usbZ' : 'usbR').value);
    return isFinite(v) ? v : (k[0] === 'z' ? 60 : 0.1);
  }

  function usbSteps() {
    var add = parseFloat($('usbAdd').value) || 0;
    return computeRows().map(function (r) {
      var s = { length: r.b.len, angle: r2(r.e.angle + add), x: r2(r.xFinal) };
      AXES.forEach(function (k) { var v = axisVal(r.e[k]); s[k] = v === null ? usbDefault(k) : v; });
      s.set = cleanSet(r.e.set);
      return s;
    });
  }

  function usbPrepare(fprog) {
    var n = parseInt($('progNo').value, 10);
    if (!(n >= 1 && n <= 98)) throw new Error('Program no. must be a number from 1 to 98.');
    var steps = usbSteps();
    if (!steps.length) throw new Error('Select at least one bend first.');
    steps.forEach(function (s, i) {
      if (s.z1 + s.z2 < Sim.MIN_Z_SUM) throw new Error('Bend ' + (i + 1) + ': Z1 + Z2 must be at least ' + Sim.MIN_Z_SUM + ' mm.');
      if (!(s.x >= 0 && s.x <= 800)) throw new Error('Backgauge X ' + s.x + ' is outside 0-800 mm.');
    });
    var idx = PLI.updateIndex(fprog, {
      program: n, ref: $('job').value.trim(), thickness: parseFloat($('thickness').value) || 0, steps: steps.length,
      punch: $('punch').value.trim(), die: $('die').value.trim()
    });
    var pli = PLI.buildPli(steps, { y: parseFloat($('usbY').value) || 0, z: usbDefault('z1'), r: usbDefault('r1') });
    return { n: n, pli: pli, fprog: idx.bytes, existing: idx.existing, bends: steps.length };
  }

  function usbDone(p, where) {
    setStatus(p.n + '.PLI (' + p.bends + ' bends) and FPROG.DAT ' + where + (p.existing ? ' Program ' + p.n + ' was replaced.' : '') +
      ' Check the program on the machine before bending a real part.');
  }

  async function usbWrite(dir, name, bytes) {
    var w = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await w.write(bytes);
    await w.close();
  }

  async function usbWriteDir() {
    if (!window.showDirectoryPicker) { setStatus('This browser cannot write to a folder. Use Download files, or Chrome/Edge.', true); return; }
    try {
      var dir = await window.showDirectoryPicker({ mode: 'readwrite' });
      var orig = new Uint8Array(await (await (await dir.getFileHandle('FPROG.DAT')).getFile()).arrayBuffer());
      var p = usbPrepare(orig);
      await usbWrite(dir, 'FPROG.BAK', orig);
      await usbWrite(dir, p.n + '.PLI', p.pli);
      await usbWrite(dir, 'FPROG.DAT', p.fprog);
      usbDone(p, 'written to the folder (old index kept as FPROG.BAK).');
      if (window.UsbEdit) window.UsbEdit.afterWrite({ dir: dir, program: p.n, fprog: p.fprog, pli: p.pli });
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (err && err.name === 'NotFoundError') { setStatus('FPROG.DAT was not found in that folder. Pick the folder of the stick (or a copy of it).', true); return; }
      setStatus('USB export failed: ' + (err && err.message ? err.message : err), true);
    }
  }

  function usbDownload(file) {
    if (!file) return;
    file.arrayBuffer().then(function (buf) {
      var p = usbPrepare(new Uint8Array(buf));
      download(p.n + '.PLI', new Blob([p.pli]), 'application/octet-stream');
      setTimeout(function () { download('FPROG.DAT', new Blob([p.fprog]), 'application/octet-stream'); }, 300);
      usbDone(p, 'downloaded. Copy both onto the stick.');
      if (window.UsbEdit) window.UsbEdit.afterWrite({ dir: null, program: p.n, fprog: p.fprog, pli: p.pli });
    }).catch(function (err) { setStatus('USB export failed: ' + err.message, true); });
  }

  /* ------------------------------------------------------------------ saved programs */

  /* Programs are kept in IndexedDB in this browser. "Save as file" / "Open file" move them
   * between PCs or keep a backup, since clearing browser data also clears the library. */
  var PROGRAM_FIELDS = ['progNo', 'job', 'material', 'thickness', 'punch', 'die', 'defAngle'];
  var dbPromise = null;

  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise(function (resolve, reject) {
        if (!window.indexedDB) { reject(new Error('This browser cannot store programs.')); return; }
        var req = indexedDB.open('entalbend', 1);
        req.onupgradeneeded = function () { req.result.createObjectStore('programs', { keyPath: 'name' }); };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error || new Error('Could not open the program store.')); };
      });
      dbPromise.catch(function () { dbPromise = null; });
    }
    return dbPromise;
  }

  function dbCall(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('programs', mode);
        var req = fn(tx.objectStore('programs'));
        tx.oncomplete = function () { resolve(req ? req.result : undefined); };
        tx.onerror = tx.onabort = function () { reject(tx.error || new Error('Storage error.')); };
      });
    });
  }

  function programName() {
    return $('progName').value.trim() || $('job').value.trim() || $('progNo').value.trim() || baseName();
  }

  function snapshot(name) {
    var fields = {};
    PROGRAM_FIELDS.forEach(function (id) { fields[id] = $(id).value; });
    return {
      format: 'entalbend-program', version: 1, name: name, savedAt: new Date().toISOString(),
      fileName: state.fileName, dxf: state.dxfText,
      detection: {
        useLinetype: state.useLinetype, gap: state.gap, minLen: state.minLen, scale: state.scale,
        bendLayers: Array.from(state.bendLayers), ignoreLayers: Array.from(state.ignoreLayers),
        forced: Array.from(state.forced.entries())
      },
      fields: fields,
      seq: state.seq.map(function (e) { return { id: e.id, angle: e.angle, dir: e.dir, sign: e.sign, offset: e.offset, z1: axisVal(e.z1), z2: axisVal(e.z2), r1: axisVal(e.r1), r2: axisVal(e.r2), set: cleanSet(e.set) }; }),
      output: state.outputEdited ? { format: $('outFormat').value, text: $('outText').value } : null
    };
  }

  function applyProgram(p) {
    if (!p || p.format !== 'entalbend-program' || typeof p.dxf !== 'string') throw new Error('This is not an EntalBend program file.');
    var d = p.detection || {};
    $('useLinetype').checked = d.useLinetype !== false;
    if (d.gap !== undefined) $('gap').value = d.gap;
    if (d.minLen !== undefined) $('minLen').value = d.minLen;
    if (d.scale !== undefined) $('scale').value = d.scale;
    readDetection();
    PROGRAM_FIELDS.forEach(function (id) { if (p.fields && p.fields[id] !== undefined) $(id).value = p.fields[id]; });
    saveSettings();
    state.seq = [];
    var ok = loadText(p.dxf, p.fileName || 'program.dxf',
      { forced: d.forced || [], bendLayers: d.bendLayers || [], ignoreLayers: d.ignoreLayers || [] });
    if (!ok) return;

    var ids = new Set(state.model.bends.map(function (b) { return b.id; }));
    var saved = Array.isArray(p.seq) ? p.seq : [];
    state.seq = saved.filter(function (e) { return ids.has(e.id); }).map(function (e) {
      return { id: e.id, angle: +e.angle || 0, dir: e.dir === 'DOWN' ? 'DOWN' : 'UP', sign: e.sign === -1 ? -1 : 1, offset: +e.offset || 0, z1: axisVal(e.z1), z2: axisVal(e.z2), r1: axisVal(e.r1), r2: axisVal(e.r2), zAuto: false, set: cleanSet(e.set) };
    });
    state.currentName = p.name || '';
    $('progName').value = state.currentName;
    state.outputEdited = false;
    renderTable();
    if (p.output && typeof p.output.text === 'string') {
      $('outFormat').value = p.output.format || 'text';
      $('outText').value = p.output.text;
      state.outputEdited = true;
      $('outEditedNote').hidden = false;
    }
    renderLibrary();
    var lost = saved.length - state.seq.length;
    setStatus('Opened "' + (p.name || p.fileName) + '" with ' + state.seq.length + ' bend' + (state.seq.length === 1 ? '' : 's') + '.' +
      (lost ? ' ' + lost + ' bend(s) did not match the drawing and were left out.' : ''), lost > 0);
  }

  function confirmReplace() {
    return !state.seq.length || window.confirm('Replace the program that is open now? Changes that are not saved will be lost.');
  }

  function saveProgram() {
    if (!state.data) { setStatus('Open a DXF before saving a program.', true); return; }
    var name = programName();
    dbCall('readonly', function (s) { return s.get(name); }).then(function (existing) {
      if (existing && name !== state.currentName &&
          !window.confirm('A program named "' + name + '" already exists. Replace it?')) return;
      return dbCall('readwrite', function (s) { return s.put(snapshot(name)); }).then(function () {
        state.currentName = name;
        $('progName').value = name;
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
        setStatus('Saved "' + name + '".');
        renderLibrary();
      });
    }).catch(function (err) { setStatus('Could not save: ' + err.message, true); });
  }

  function openSaved(name) {
    if (!confirmReplace()) return;
    dbCall('readonly', function (s) { return s.get(name); }).then(function (p) {
      if (!p) throw new Error('it is no longer in the library.');
      applyProgram(p);
    }).catch(function (err) { setStatus('Could not open "' + name + '": ' + err.message, true); });
  }

  function deleteSaved(name) {
    if (!window.confirm('Delete the saved program "' + name + '"? This cannot be undone.')) return;
    dbCall('readwrite', function (s) { return s.delete(name); }).then(function () {
      if (state.currentName === name) state.currentName = '';
      setStatus('Deleted "' + name + '".');
      renderLibrary();
    }).catch(function (err) { setStatus('Could not delete: ' + err.message, true); });
  }

  function renderLibrary() {
    var body = $('libBody');
    dbCall('readonly', function (s) { return s.getAll(); }).then(function (list) {
      if (!list.length) { body.innerHTML = '<tr><td colspan="3" class="empty">No saved programs yet.</td></tr>'; return; }
      list.sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }); });
      body.innerHTML = list.map(function (p) {
        var when = p.savedAt ? new Date(p.savedAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '';
        return '<tr data-name="' + esc(p.name) + '"' + (p.name === state.currentName ? ' class="current"' : '') + '>' +
          '<td>' + esc(p.name) + '<br><span class="muted small">' + esc(p.fileName || '') + (when ? ' · ' + esc(when) : '') + '</span></td>' +
          '<td class="num">' + (p.seq ? p.seq.length : 0) + '</td>' +
          '<td class="acts"><button class="mini" type="button" data-act="open">Open</button>' +
            '<button class="mini" type="button" data-act="del" title="Delete">✕</button></td></tr>';
      }).join('');
    }).catch(function (err) {
      body.innerHTML = '<tr><td colspan="3" class="empty">' + esc(err.message) + '</td></tr>';
    });
  }

  function exportProgram() {
    if (!state.data) { setStatus('Open a DXF before saving a program.', true); return; }
    var name = programName();
    download(name.replace(/[\\/:*?"<>|]+/g, '_') + '.entalbend.json', JSON.stringify(snapshot(name)), 'application/json');
    setStatus('Saved "' + name + '" as a file.');
  }

  function importProgram(text, fileName) {
    var p;
    try { p = JSON.parse(text); }
    catch (e) { setStatus('Could not read ' + fileName + ': it is not an EntalBend program file.', true); return; }
    if (!confirmReplace()) return;
    try { applyProgram(p); }
    catch (err) { setStatus(err.message, true); return; }
    // Not in this browser's library until it is saved here.
    state.currentName = '';
    renderLibrary();
  }

  /* ------------------------------------------------------------------ settings */

  function saveSettings() {
    try {
      var o = {};
      SETTINGS_IDS.forEach(function (id) { o[id] = $(id).value; });
      o.useLinetype = $('useLinetype').checked;
      o.gap = $('gap').value; o.minLen = $('minLen').value; o.scale = $('scale').value;
      localStorage.setItem('entalbend.settings', JSON.stringify(o));
    } catch (e) { /* storage not available */ }
  }

  function loadSettings() {
    try {
      var raw = localStorage.getItem('entalbend.settings');
      if (!raw) return;
      var o = JSON.parse(raw);
      SETTINGS_IDS.forEach(function (id) { if (o[id] !== undefined && $(id)) $(id).value = o[id]; });
      if (o.useLinetype !== undefined) $('useLinetype').checked = !!o.useLinetype;
      ['gap', 'minLen', 'scale'].forEach(function (id) { if (o[id] !== undefined) $(id).value = o[id]; });
    } catch (e) { /* ignore */ }
  }

  function readDetection() {
    state.useLinetype = $('useLinetype').checked;
    state.gap = Math.max(0, parseFloat($('gap').value) || 0);
    state.minLen = Math.max(0, parseFloat($('minLen').value) || 0);
    state.scale = parseFloat($('scale').value) > 0 ? parseFloat($('scale').value) : 1;
  }

  /* ------------------------------------------------------------------ init */

  function init() {
    loadSettings();
    readDetection();
    bindCanvas();

    $('fileInput').addEventListener('change', function (ev) { loadFile(ev.target.files[0]); ev.target.value = ''; });
    var dz = $('dropZone');
    dz.addEventListener('dragover', function (ev) { ev.preventDefault(); dz.classList.add('drag'); });
    dz.addEventListener('dragleave', function () { dz.classList.remove('drag'); });
    dz.addEventListener('drop', function (ev) {
      ev.preventDefault(); dz.classList.remove('drag');
      if (ev.dataTransfer && ev.dataTransfer.files.length) loadFile(ev.dataTransfer.files[0]);
    });
    $('fitBtn').addEventListener('click', fitView);

    $('btnSaveProg').addEventListener('click', saveProgram);
    $('btnExportProg').addEventListener('click', exportProgram);
    $('progFileInput').addEventListener('change', function (ev) { loadFile(ev.target.files[0]); ev.target.value = ''; });
    $('progName').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') saveProgram(); });
    $('libBody').addEventListener('click', function (ev) {
      var btn = ev.target.closest('button[data-act]');
      if (!btn) return;
      var name = btn.closest('tr').dataset.name;
      if (btn.dataset.act === 'open') openSaved(name);
      else if (btn.dataset.act === 'del') deleteSaved(name);
    });

    ['useLinetype', 'gap', 'minLen', 'scale'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        var oldScale = state.scale;
        readDetection();
        saveSettings();
        rebuild(state.scale !== oldScale);
      });
    });
    $('layerBody').addEventListener('change', function (ev) {
      var t = ev.target;
      if (!t.dataset || !t.dataset.layer) return;
      var set = t.dataset.kind === 'bend' ? state.bendLayers : state.ignoreLayers;
      if (t.checked) set.add(t.dataset.layer); else set.delete(t.dataset.layer);
      rebuild(false);
    });

    $('seqBody').addEventListener('input', function (ev) {
      var t = ev.target, tr = t.closest('tr');
      if (!tr || !t.dataset.f) return;
      var e = state.seq[+tr.dataset.i];
      if (!e) return;
      if (t.dataset.f === 'angle') e.angle = parseFloat(t.value) || 0;
      else if (t.dataset.f === 'offset') e.offset = parseFloat(t.value) || 0;
      else if (AXES.indexOf(t.dataset.f) >= 0) {
        e[t.dataset.f] = t.value === '' || !isFinite(parseFloat(t.value)) ? null : parseFloat(t.value);
        if (t.dataset.f[0] === 'z') e.zAuto = false;
      }
      else return;
      updateDerived();
    });
    $('seqBody').addEventListener('change', function (ev) {
      var t = ev.target, tr = t.closest('tr');
      if (tr && (t.dataset.f === 'z1' || t.dataset.f === 'z2')) {
        var ez = state.seq[+tr.dataset.i];
        if (ez && enforceZ(ez, t.dataset.f)) { setStatus('Z1 + Z2 must be at least ' + Sim.MIN_Z_SUM + ' mm, so the other finger was moved.'); renderTable(); return; }
      }
      if (!tr || t.dataset.f !== 'dir') return;
      var e = state.seq[+tr.dataset.i];
      if (e) { e.dir = t.value; renderTable(); }
    });
    $('seqBody').addEventListener('click', function (ev) {
      var btn = ev.target.closest('button[data-act]');
      if (!btn) return;
      var i = +btn.closest('tr').dataset.i, s = state.seq;
      if (btn.dataset.act === 'del') s.splice(i, 1);
      else if (btn.dataset.act === 'side') s[i].sign = -s[i].sign;
      else if (btn.dataset.act === 'up' && i > 0) { var a = s[i]; s[i] = s[i - 1]; s[i - 1] = a; }
      else if (btn.dataset.act === 'down' && i < s.length - 1) { var b = s[i]; s[i] = s[i + 1]; s[i + 1] = b; }
      renderTable();
    });
    $('seqBody').addEventListener('click', function (ev) {
      var tr = ev.target.closest('tr[data-i]');
      if (!tr || ev.target.closest('button')) return;
      if (state.simStep !== +tr.dataset.i) { setSimStep(+tr.dataset.i); renderSettings(); }
      Array.prototype.forEach.call($('seqBody').querySelectorAll('tr[data-i]'), function (x) { x.classList.toggle('sel', x === tr); });
      drawSim();
    });
    var simTop = $('simTop');
    simTop.addEventListener('pointerdown', function (ev) {
      var name = Sim.hit(simTop, ev.offsetX, ev.offsetY), cur = simRow();
      if (!name || !cur) return;
      state.simDrag = { name: name, range: [simTop._sim.uLo, simTop._sim.uHi], row: state.simStep };
      simTop.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    });
    simTop.addEventListener('pointermove', function (ev) {
      var dr = state.simDrag;
      if (!dr) { simTop.style.cursor = Sim.hit(simTop, ev.offsetX, ev.offsetY) ? 'ew-resize' : 'default'; return; }
      var e = state.seq[dr.row];
      if (!e) return;
      var u = Sim.uAt(simTop, ev.offsetX), lim = Sim.MACHINE_W / 2 - Sim.FINGER_W / 2;
      var z = Math.round(dr.name === 'Z1' ? -u : u);
      z = Math.max(-lim, Math.min(lim, ev.shiftKey ? Math.round((dr.name === 'Z1' ? -u : u) * 10) / 10 : z));
      e[dr.name === 'Z1' ? 'z1' : 'z2'] = z; e.zAuto = false;
      enforceZ(e, dr.name === 'Z1' ? 'z1' : 'z2');
      ['z1', 'z2'].forEach(function (k) {
        var cell = $('seqBody').querySelector('tr[data-i="' + dr.row + '"] input[data-f="' + k + '"]');
        if (cell && axisVal(e[k]) !== null) cell.value = e[k];
      });
      drawSim();
    });
    var endDrag = function () { if (state.simDrag) { state.simDrag = null; renderTable(); } };
    simTop.addEventListener('pointerup', endDrag);
    simTop.addEventListener('pointercancel', endDrag);
    $('simPrev').addEventListener('click', function () { setSimStep(state.simStep - 1); renderTable(); });
    $('simNext').addEventListener('click', function () { setSimStep(Math.min(state.simStep + 1, Math.max(0, state.seq.length - 1))); renderTable(); });
    $('stepSettings').addEventListener('input', function (ev) {
      var k = ev.target.dataset.set, e = state.seq[state.simStep];
      if (!k || !e) return;
      if (!e.set) e.set = {};
      var v = ev.target.value;
      if (v === '' || (k !== 'aux' && !isFinite(parseFloat(v)))) delete e.set[k]; else e.set[k] = k === 'aux' ? v : parseFloat(v);
    });
    $('stepSettings').addEventListener('click', function (ev) {
      var e = state.seq[state.simStep];
      if (!e) return;
      if (ev.target.id === 'setAll') {
        state.seq.forEach(function (o) { o.set = JSON.parse(JSON.stringify(cleanSet(e.set))); });
        setStatus('Settings copied to all ' + state.seq.length + ' bends.');
      } else if (ev.target.id === 'setReset') { e.set = {}; renderSettings(); }
    });
    $('simPlay').addEventListener('click', playSim);
    $('simProg').addEventListener('input', function () { stopSimAnim(); state.simProgress = (+$('simProg').value) / 100; drawSim(); });
    $('simAuto').addEventListener('click', function () {
      var cur = simRow();
      if (!cur) return;
      cur.r.e.zAuto = true; renderTable();
    });
    $('simReset').addEventListener('click', function () { if (state.simTab === '3d' && Sim3D.isReady()) Sim3D.resetView(600); });
    Array.prototype.forEach.call(document.querySelectorAll('.simTabs [data-tab]'), function (btn) {
      btn.addEventListener('click', function () {
        state.simTab = btn.dataset.tab;
        Array.prototype.forEach.call(document.querySelectorAll('.simTabs [data-tab]'), function (x) { x.classList.toggle('on', x === btn); });
        $('sim3dWrap').hidden = state.simTab !== '3d';
        $('simTopWrap').hidden = state.simTab === '3d';
        $('simZoomWrap').hidden = state.simTab === '3d';
        drawSim();
      });
    });
    ['simZoom', 'simFlip', 'simShift', 'usbZ', 'usbR', 'thickness', 'die', 'punch'].forEach(function (id) { $(id).addEventListener('input', function () { renderTable(); }); });
    $('clearSeq').addEventListener('click', function () { state.seq = []; renderTable(); });

    SETTINGS_IDS.forEach(function (id) {
      $(id).addEventListener('change', saveSettings);
    });
    ['progNo', 'job', 'material', 'thickness', 'punch', 'die'].forEach(function (id) {
      $(id).addEventListener('input', function () { refreshOutput(false); });
    });
    $('outFormat').addEventListener('change', function () { refreshOutput(true); });
    $('regen').addEventListener('click', function () { refreshOutput(true); });
    $('outText').addEventListener('input', function () { state.outputEdited = true; $('outEditedNote').hidden = false; });
    $('dlBtn').addEventListener('click', function () {
      var k = $('outFormat').value;
      var ext = { text: 'txt', csv: 'csv', json: 'json' }[k];
      download(baseName() + '.' + ext, $('outText').value, k === 'json' ? 'application/json' : 'text/plain');
    });
    $('copyBtn').addEventListener('click', function () {
      var t = $('outText');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t.value).then(function () { setStatus('Program copied to the clipboard.'); },
          function () { t.select(); document.execCommand('copy'); setStatus('Program copied to the clipboard.'); });
      } else { t.select(); document.execCommand('copy'); setStatus('Program copied to the clipboard.'); }
    });

    $('btnUsbDir').addEventListener('click', usbWriteDir);
    $('usbFprog').addEventListener('change', function (ev) { usbDownload(ev.target.files[0]); ev.target.value = ''; });

    $('themeBtn').addEventListener('click', function () {
      var r = document.documentElement;
      var dark = r.dataset.theme === 'dark' || (!r.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
      r.dataset.theme = dark ? 'light' : 'dark';
      try { localStorage.setItem('entalcalc-theme', r.dataset.theme); } catch (e) { /* storage not available */ }
      draw();
    });
    if (window.matchMedia) {
      var mq = matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', draw);
    }

    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(sizeCanvas).observe($('dropZone'));
    window.addEventListener('resize', sizeCanvas);
    sizeCanvas();
    renderTable();
    renderLibrary();
  }

  window.EntalBend = {
    loadText: loadText, state: state, computeRows: computeRows, formatProgram: formatProgram, toggleBend: toggleBend,
    snapshot: snapshot, applyProgram: applyProgram, usbPrepare: usbPrepare
  };
  init();
})();
