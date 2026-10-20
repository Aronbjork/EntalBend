/* EntalBend – UI, bend sequence, program output and RS232 (Web Serial). */
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
    hover: null, outputEdited: false
  };

  var SETTINGS_IDS = ['progNo', 'job', 'material', 'thickness', 'punch', 'die', 'defAngle',
    'baud', 'dataBits', 'parity', 'stopBits', 'flow', 'eol', 'lineDelay', 'rxMode', 'outFormat'];

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
    });
    return rows;
  }

  /* ------------------------------------------------------------------ table */

  function renderTable() {
    var rows = computeRows();
    var tb = $('seqBody');
    if (!rows.length) {
      tb.innerHTML = '<tr><td colspan="11" class="empty">No bends selected. Click the dashed bend lines in the drawing in the order you want to bend them.</td></tr>';
    } else {
      tb.innerHTML = rows.map(function (r, i) {
        return '<tr data-i="' + i + '">' +
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
          '<td class="notes">' + (r.flip ? '<span class="tag flip">FLIP</span>' : '') +
            (r.same ? '<span class="tag same">2nd bend on the flange of #' + r.same.n + ', ' + f2(r.same.dist) + ' mm from it</span>' : '') + '</td>' +
          '<td class="acts"><button class="mini" type="button" data-act="up" title="Earlier">▲</button>' +
            '<button class="mini" type="button" data-act="down" title="Later">▼</button>' +
            '<button class="mini" type="button" data-act="del" title="Remove">✕</button></td>' +
          '</tr>';
      }).join('');
    }
    refreshOutput(false);
    draw();
  }

  function updateDerived() {
    var rows = computeRows();
    var trs = $('seqBody').querySelectorAll('tr[data-i]');
    rows.forEach(function (r, i) {
      var cell = trs[i] && trs[i].querySelector('[data-x]');
      if (cell) cell.textContent = f2(r.xFinal);
    });
    refreshOutput(false);
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
      sign: DXF.defaultSide(b, state.model.outlinePts), offset: 0
    });
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

  /* ------------------------------------------------------------------ RS232 (Web Serial) */

  var serial = { port: null, reader: null, loop: null, closing: false, abort: false, xoff: false };
  var XON = 0x11, XOFF = 0x13;
  var enc = new TextEncoder();
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  function logLine(cls, text) {
    var box = $('log');
    var d = document.createElement('div');
    d.className = 'ln ' + cls;
    d.textContent = new Date().toLocaleTimeString() + '  ' + cls.toUpperCase().padEnd(3) + '  ' + text;
    box.appendChild(d);
    while (box.children.length > 600) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }

  function logRx(bytes) {
    var s;
    if ($('rxMode').value === 'hex') {
      s = Array.from(bytes).map(function (b) { return b.toString(16).padStart(2, '0'); }).join(' ');
    } else {
      s = Array.from(bytes).map(function (b) {
        if (b >= 32 && b < 127) return String.fromCharCode(b);
        if (b === 10) return '⏎';
        if (b === 13) return '␍';
        if (b === 9) return '⇥';
        if (b === XON) return '[XON]';
        if (b === XOFF) return '[XOFF]';
        return '·';
      }).join('');
    }
    logLine('rx', s);
  }

  function setSerialUi(connected) {
    $('btnConnect').disabled = connected || !('serial' in navigator);
    $('btnDisconnect').disabled = !connected;
    $('btnSend').disabled = !connected;
    $('btnManual').disabled = !connected;
    $('btnStop').disabled = true;
    $('serialState').textContent = connected ? 'Connected' : 'Not connected';
  }

  async function connect() {
    if (!('serial' in navigator)) { logLine('err', 'Web Serial is not available in this browser.'); return; }
    try {
      var port = await navigator.serial.requestPort();
      await port.open({
        baudRate: parseInt($('baud').value, 10),
        dataBits: parseInt($('dataBits').value, 10),
        stopBits: parseInt($('stopBits').value, 10),
        parity: $('parity').value,
        // Web Serial only knows RTS/CTS; XON/XOFF is handled in readLoop / sendLines.
        flowControl: $('flow').value === 'hardware' ? 'hardware' : 'none'
      });
      serial.port = port; serial.closing = false; serial.abort = false; serial.xoff = false;
      serial.loop = readLoop(port);
      setSerialUi(true);
      logLine('sys', 'Connected: ' + $('baud').value + ' baud, ' + $('dataBits').value + ' data bits, parity ' + $('parity').value +
        ', ' + $('stopBits').value + ' stop bit(s), flow ' + $('flow').value + '.');
    } catch (err) {
      if (err && err.name === 'NotFoundError') logLine('sys', 'No port selected.');
      else logLine('err', 'Could not open the port: ' + (err && err.message ? err.message : err));
      setSerialUi(false);
    }
  }

  async function readLoop(port) {
    while (port.readable && !serial.closing) {
      var reader = port.readable.getReader();
      serial.reader = reader;
      try {
        for (;;) {
          var res = await reader.read();
          if (res.done) break;
          if (res.value && res.value.length) {
            if ($('flow').value === 'xonxoff') {
              for (var i = 0; i < res.value.length; i++) {
                if (res.value[i] === XOFF) serial.xoff = true;
                else if (res.value[i] === XON) serial.xoff = false;
              }
            }
            logRx(res.value);
          }
        }
      } catch (err) {
        logLine('err', 'Read error: ' + err.message);
      } finally {
        reader.releaseLock();
        serial.reader = null;
      }
    }
  }

  async function disconnect() {
    serial.abort = true; serial.closing = true;
    try { if (serial.reader) await serial.reader.cancel(); } catch (e) { /* ignore */ }
    try { if (serial.loop) await serial.loop; } catch (e) { /* ignore */ }
    try { if (serial.port) await serial.port.close(); } catch (e) { logLine('err', 'Close error: ' + e.message); }
    serial.port = null; serial.reader = null; serial.loop = null;
    setSerialUi(false);
    logLine('sys', 'Disconnected.');
  }

  function cleanLine(s) { return s.replace(/[^\x20-\x7E\t]/g, '?'); }

  async function sendLines(lines) {
    if (!serial.port || !serial.port.writable) { logLine('err', 'Not connected.'); return; }
    var eol = { CRLF: '\r\n', LF: '\n', CR: '\r' }[$('eol').value];
    var delay = parseInt($('lineDelay').value, 10) || 0;
    var xonxoff = $('flow').value === 'xonxoff';
    var writer = serial.port.writable.getWriter();
    serial.abort = false;
    $('btnStop').disabled = false; $('btnSend').disabled = true; $('btnManual').disabled = true;
    try {
      for (var i = 0; i < lines.length; i++) {
        var line = cleanLine(lines[i]);
        var bytes = enc.encode(line + eol);
        // Send one byte at a time under XON/XOFF so a pause from the control takes effect at once.
        for (var j = 0; j < bytes.length; j++) {
          if (xonxoff && serial.xoff) {
            logLine('sys', 'Control sent XOFF. Waiting for XON...');
            while (serial.xoff && !serial.abort) await sleep(20);
            if (!serial.abort) logLine('sys', 'XON received. Sending again.');
          }
          if (serial.abort) { logLine('sys', 'Sending stopped after ' + i + ' of ' + lines.length + ' lines.'); return; }
          if (!xonxoff) { await writer.write(bytes); break; }
          await writer.write(bytes.subarray(j, j + 1));
        }
        logLine('tx', line);
        if (delay) await sleep(delay);
      }
      logLine('sys', 'Sent ' + lines.length + ' line(s).');
    } catch (err) {
      logLine('err', 'Write error: ' + err.message);
    } finally {
      writer.releaseLock();
      if (serial.port) { $('btnStop').disabled = true; $('btnSend').disabled = false; $('btnManual').disabled = false; }
    }
  }

  function sendProgram() {
    var lines = $('outText').value.replace(/\r\n|\r/g, '\n').split('\n');
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    if (!lines.length) { logLine('err', 'There is nothing to send. Select bends first.'); return; }
    if (!window.confirm('Send ' + lines.length + ' lines to the serial port?\n\nMake sure the machine is idle and the control is ready to receive.')) return;
    sendLines(lines);
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
      seq: state.seq.map(function (e) { return { id: e.id, angle: e.angle, dir: e.dir, sign: e.sign, offset: e.offset }; }),
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
      return { id: e.id, angle: +e.angle || 0, dir: e.dir === 'DOWN' ? 'DOWN' : 'UP', sign: e.sign === -1 ? -1 : 1, offset: +e.offset || 0 };
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
      else return;
      updateDerived();
    });
    $('seqBody').addEventListener('change', function (ev) {
      var t = ev.target, tr = t.closest('tr');
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

    /* serial */
    if (!('serial' in navigator)) $('serialSupport').hidden = false;
    setSerialUi(false);
    $('btnConnect').addEventListener('click', connect);
    $('btnDisconnect').addEventListener('click', disconnect);
    $('btnSend').addEventListener('click', sendProgram);
    $('btnStop').addEventListener('click', function () { serial.abort = true; });
    $('btnManual').addEventListener('click', function () {
      var t = $('manualText').value;
      if (t) sendLines([t]);
    });
    $('manualText').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !$('btnManual').disabled && $('manualText').value) sendLines([$('manualText').value]);
    });
    $('btnClearLog').addEventListener('click', function () { $('log').innerHTML = ''; });
    $('btnSaveLog').addEventListener('click', function () {
      var lines = Array.from($('log').children).map(function (d) { return d.textContent; });
      download('serial-log.txt', lines.join('\r\n'), 'text/plain');
    });
    if ('serial' in navigator) {
      navigator.serial.addEventListener('disconnect', function (ev) {
        if (ev.target === serial.port) {
          serial.closing = true; serial.port = null;
          setSerialUi(false);
          logLine('err', 'The serial device was disconnected.');
        }
      });
    }

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
    snapshot: snapshot, applyProgram: applyProgram
  };
  init();
})();
