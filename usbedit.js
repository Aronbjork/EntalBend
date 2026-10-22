/* Load programs that are on the USB stick, edit their steps and write them back.
   The step records are edited in place (see pli.js), so values EntalBend does not know stay as they are. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

  var COLS = [
    ['length', 'Length', 1], ['angle', 'Angle', 0.1], ['y1', 'Y1', 0.01], ['y2', 'Y2', 0.01], ['x1', 'X1', 0.01], ['x2', 'X2', 0.01],
    ['r1', 'R1', 0.1], ['r2', 'R2', 0.1], ['z1', 'Z1', 1], ['z2', 'Z2', 1], ['cycle', 'Cycle', 1], ['ton', 'kN', 1],
    ['hold', 'Hold s', 0.1], ['bspeed', 'B.sp', 1], ['odc', 'ODC', 1], ['retDist', 'Ret.d', 1], ['aux', 'Aux', 0]
  ];

  var U = { fprog: null, files: {}, dir: null, src: null, steps: [], end: null, entry: null };

  function status(msg, err) { var s = $('usbEdStatus'); s.textContent = msg; s.className = 'muted small' + (err ? ' bad' : ''); }

  function bytesOf(file) { return file.arrayBuffer().then(function (b) { return new Uint8Array(b); }); }

  function setFprog(bytes) {
    U.fprog = bytes;
    renderList();
  }

  /* Read FPROG.DAT and all N.PLI from a folder handle and show the list. */
  async function loadDir(dir) {
    var fh = await dir.getFileHandle('FPROG.DAT');
    U.dir = dir; U.files = {};
    for (var n = 1; n <= 99; n++) {
      try { U.files[n] = await bytesOf(await (await dir.getFileHandle(n + '.PLI')).getFile()); } catch (e) { /* program file not there */ }
    }
    setFprog(await bytesOf(await fh.getFile()));
  }

  async function openDir() {
    if (!window.showDirectoryPicker) { status('This browser cannot read a folder. Use "Open files" instead (Chrome/Edge can open the folder).', true); return; }
    try {
      await loadDir(await window.showDirectoryPicker({ mode: 'readwrite' }));
      $('usbEditor').hidden = true;
      status('Folder opened. Pick a program to edit.');
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      status(err && err.name === 'NotFoundError' ? 'FPROG.DAT was not found in that folder.' : 'Could not open the folder: ' + (err.message || err), true);
    }
  }

  /* Called after EntalBend itself wrote a program, so the list is up to date without reopening the folder.
     info: { dir (folder handle or null), program, fprog, pli } */
  async function afterWrite(info) {
    try {
      if (info.dir) { await loadDir(info.dir); status('Program ' + info.program + ' written. The list was refreshed.'); }
      else if (U.fprog) { U.files[info.program] = info.pli; setFprog(info.fprog); status('Program ' + info.program + ' added to the list (files were downloaded).'); }
    } catch (err) { status('Could not refresh the list: ' + (err.message || err), true); }
  }

  async function openFiles(list) {
    var files = Array.prototype.slice.call(list || []);
    if (!files.length) return;
    U.dir = null; U.files = {};
    var fp = null;
    for (var i = 0; i < files.length; i++) {
      var f = files[i], m = /^(\d+)\.PLI$/i.exec(f.name);
      if (/^FPROG\.DAT$/i.test(f.name)) fp = await bytesOf(f);
      else if (m) U.files[parseInt(m[1], 10)] = await bytesOf(f);
    }
    if (!fp) { status('FPROG.DAT is missing. Select it together with the .PLI files.', true); return; }
    setFprog(fp);
    $('usbEditor').hidden = true;
    status('Files loaded. Saving will download the new files (they cannot be written back to the stick from here).');
  }

  function renderList() {
    var rows = PLI.listPrograms(U.fprog);
    var hidden = rows.filter(function (r) { return r.hidden; });
    $('usbRepairBox').innerHTML = hidden.length ? '<div class="warn">Program ' + hidden.map(function (r) { return r.program; }).join(', ') +
      ' is in FPROG.DAT after the entry for program 99, so the control does not see it (it just exits when you load it). ' +
      '<button class="mini" type="button" id="usbRepair">Repair index</button></div>' : '';
    $('usbProgList').innerHTML = rows.length ? '<table class="plain"><thead><tr><th>No.</th><th>Reference</th><th>Steps</th><th></th></tr></thead><tbody>' +
      rows.map(function (r) {
        var has = !!U.files[r.program];
        return '<tr><td class="num">' + r.program + '</td><td>' + esc(r.ref) + '</td><td class="num">' + (r.count - 1) + '</td><td>' +
          (has && r.program <= 98 ? '<button class="mini" type="button" data-edit="' + r.program + '">Edit</button> <button class="mini" type="button" data-delprog="' + r.program + '">Delete</button>' + (r.hidden ? ' <span class="bad small">not visible to the control</span>' : '') : '<span class="muted small">' + (has ? 'system' : 'no file') + '</span>') + '</td></tr>';
      }).join('') + '</tbody></table>' : '<p class="muted small">No programs found in FPROG.DAT.</p>';
  }

  function edit(n) {
    var parsed = PLI.parsePli(U.files[n]), entry = PLI.readEntry(U.fprog, n);
    if (!parsed || !entry) { status('Program ' + n + ' could not be read.', true); return; }
    U.src = n; U.steps = parsed.steps; U.end = parsed.end; U.entry = entry;
    $('usbEdNo').value = n; $('usbEdRef').value = entry.ref; $('usbEdTh').value = entry.thickness;
    $('usbEdInfo').textContent = 'Punch ' + (entry.punch || '-') + ' · Die ' + (entry.die || '-') + ' (kept as stored)';
    $('usbEditor').hidden = false;
    renderSteps();
    status('Editing program ' + n + '. Change values and save.');
  }

  function renderSteps() {
    var head = '<tr><th>#</th>' + COLS.map(function (c) { return '<th>' + c[1] + '</th>'; }).join('') + '<th></th></tr>';
    var body = U.steps.map(function (s, i) {
      var bad = s.z1 + s.z2 < 120;
      return '<tr data-i="' + i + '"><td class="num">' + (i + 1) + '</td>' + COLS.map(function (c) {
        var cls = bad && (c[0] === 'z1' || c[0] === 'z2') ? ' class="hl"' : '';
        return '<td><input data-k="' + c[0] + '"' + cls + (c[0] === 'aux' ? ' maxlength="6" style="width:70px"' : ' type="number" step="' + c[2] + '" class="axis"') +
          ' value="' + esc(s[c[0]]) + '"></td>';
      }).join('') + '<td class="acts"><button class="mini" type="button" data-act="dup" title="Copy this step below">+</button>' +
        '<button class="mini" type="button" data-act="del" title="Remove">✕</button></td></tr>';
    }).join('');
    $('usbEdTable').innerHTML = '<thead>' + head + '</thead><tbody>' + body + '</tbody>';
  }

  function collect() {
    var n = parseInt($('usbEdNo').value, 10);
    if (!(n >= 1 && n <= 98)) throw new Error('Program no. must be a number from 1 to 98.');
    if (!U.steps.length) throw new Error('A program needs at least one step.');
    return {
      n: n, pli: PLI.serializePli(U.steps, U.end),
      put: PLI.putEntry(U.fprog, U.entry, n, { ref: $('usbEdRef').value.trim(), thickness: parseFloat($('usbEdTh').value) || U.entry.thickness, steps: U.steps.length })
    };
  }

  async function write(dir, name, bytes) {
    var w = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await w.write(bytes); await w.close();
  }

  function dl(name, bytes) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  async function save() {
    try {
      var c = collect();
      if (c.n !== U.src && (c.put.existing || U.files[c.n]) && !window.confirm('Program ' + c.n + ' already exists on the stick. Replace it?')) return;
      if (U.dir) {
        await write(U.dir, 'FPROG.BAK', U.fprog);
        await write(U.dir, c.n + '.PLI', c.pli);
        await write(U.dir, 'FPROG.DAT', c.put.bytes);
        status('Saved ' + c.n + '.PLI and FPROG.DAT to the folder (old index kept as FPROG.BAK).');
      } else {
        dl(c.n + '.PLI', c.pli);
        setTimeout(function () { dl('FPROG.DAT', c.put.bytes); }, 300);
        status('Downloaded ' + c.n + '.PLI and FPROG.DAT. Copy both onto the stick.');
      }
      U.files[c.n] = c.pli; setFprog(c.put.bytes);
      U.entry = PLI.readEntry(U.fprog, c.n); U.src = c.n;
    } catch (err) { status('Could not save: ' + (err.message || err), true); }
  }


  async function removeProgram(n) {
    try {
      var entry = PLI.readEntry(U.fprog, n);
      if (!entry) { status('Program ' + n + ' was not found in FPROG.DAT.', true); return; }
      if (!window.confirm('Delete program ' + n + (entry.ref ? ' (' + entry.ref + ')' : '') + ' from the stick? The index entry is left blank.')) return;
      var fixed = PLI.removeEntry(U.fprog, n);
      if (!fixed) { status('Program ' + n + ' cannot be deleted.', true); return; }
      if (U.dir) {
        await write(U.dir, 'FPROG.BAK', U.fprog);
        await write(U.dir, 'FPROG.DAT', fixed);
        var gone = true;
        try { await U.dir.removeEntry(n + '.PLI'); } catch (e) { gone = e && e.name === 'NotFoundError'; }
        status('Program ' + n + ' deleted' + (gone ? '' : ' from the index, but ' + n + '.PLI could not be removed - delete it by hand') + ' (old index kept as FPROG.BAK).', !gone);
      } else {
        dl('FPROG.DAT', fixed);
        status('Program ' + n + ' removed from the index. Copy the new FPROG.DAT onto the stick and delete ' + n + '.PLI there.');
      }
      delete U.files[n]; if (U.src === n) { U.src = null; $('usbEditor').hidden = true; }
      setFprog(fixed);
    } catch (err) { status('Could not delete: ' + (err.message || err), true); }
  }

  async function repair() {
    try {
      var fixed = PLI.repairIndex(U.fprog);
      if (!fixed) { status('Nothing to repair.'); return; }
      if (U.dir) {
        await write(U.dir, 'FPROG.BAK', U.fprog);
        await write(U.dir, 'FPROG.DAT', fixed);
        status('Index repaired (old index kept as FPROG.BAK).');
      } else { dl('FPROG.DAT', fixed); status('Repaired FPROG.DAT downloaded. Copy it onto the stick.'); }
      setFprog(fixed);
    } catch (err) { status('Could not repair: ' + (err.message || err), true); }
  }

  function init() {
    if (!$('usbEditor')) return;
    $('usbOpenDir').addEventListener('click', openDir);
    $('usbOpenFiles').addEventListener('change', function (ev) { openFiles(ev.target.files); ev.target.value = ''; });
    $('usbProgList').addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-edit]');
      if (b) edit(parseInt(b.dataset.edit, 10));
      var d = ev.target.closest('button[data-delprog]');
      if (d) removeProgram(parseInt(d.dataset.delprog, 10));
    });
    $('usbEdTable').addEventListener('input', function (ev) {
      var t = ev.target, tr = t.closest('tr[data-i]');
      if (!tr || !t.dataset.k) return;
      var s = U.steps[+tr.dataset.i], k = t.dataset.k;
      if (k === 'aux') { if (/^[01]{1,6}$/.test(t.value)) s.aux = t.value; }
      else if (isFinite(parseFloat(t.value))) {
        var v = parseFloat(t.value), twin = { x1: 'x2', x2: 'x1', y1: 'y2', y2: 'y1' }[k];
        /* X1/X2 and Y1/Y2 move together while they were equal */
        if (twin && s[twin] === s[k]) {
          s[twin] = v;
          var cell = tr.querySelector('input[data-k="' + twin + '"]');
          if (cell) cell.value = v;
        }
        s[k] = v;
      }
    });
    $('usbEdTable').addEventListener('change', function (ev) {
      if (ev.target.dataset.k === 'z1' || ev.target.dataset.k === 'z2') renderSteps();
    });
    $('usbEdTable').addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-act]');
      if (!b) return;
      var i = +b.closest('tr').dataset.i;
      if (b.dataset.act === 'del') { if (U.steps.length > 1) U.steps.splice(i, 1); }
      else { var c = Object.assign({}, U.steps[i]); c.raw = new Uint8Array(U.steps[i].raw); U.steps.splice(i + 1, 0, c); }
      renderSteps();
    });
    $('usbEdSave').addEventListener('click', save);
    $('usbRepairBox').addEventListener('click', function (ev) { if (ev.target.id === 'usbRepair') repair(); });
  }

  init();
  window.UsbEdit = { afterWrite: afterWrite };
})();
