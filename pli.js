/* Operateur 2000 USB program files: N.PLI (bend steps) and the FPROG.DAT index.
   Format reverse engineered from programs saved on the machine (Floppy3 folder).
   Step record (144 bytes, little endian): +0x0A int16 bend length, +0x10 angle, +0x14/+0x18 Y1/Y2,
   +0x1C/+0x20 X1/X2, +0x24/+0x28 R1/R2, +0x2C/+0x30 Z1/Z2 (all float32). The last record of a program
   is an end record. FPROG.DAT holds one 124-byte entry per program (entry 1 starts at byte 117). */
(function () {
  'use strict';

  var STEP_HEX = '000000000000000000007800000000000000b542168972c0168972c00ad71f410ad71f41cdcccc3dcdcccc3d000070420000704230303030303000004600000000000f000a0000000000010000000000000000000000cdcc4c3e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002005d84200000000';
  var END_HEX = '000000000000000000007800000040400000b4c200000000000000000040ee430040ee43cdcccc3dcdcccc3d00007042000070423030303030300000460000000000ffff0a0000000000010000000000000000000000cdcc4c3e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002005d84200000000';
  var ENTRY_HEX = '00000000303030313120202020202020202020202020202020200000803f535445454c0028000100030038333520202033303038202033202020202030202020202003007e0a0c00a25389411e000f270100000096420000000000000000000000000000000000000000000000000000000000000000000000000200';

  var REC = 144, ENT = 124, ENT_FIRST = 117;

  function fromHex(h) {
    var a = new Uint8Array(h.length / 2);
    for (var i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16);
    return a;
  }
  function view(a) { return new DataView(a.buffer, a.byteOffset, a.byteLength); }
  function putAscii(a, off, len, s) {
    s = String(s || '').toUpperCase();
    for (var i = 0; i < len; i++) { var c = s.charCodeAt(i); a[off + i] = i < s.length && c >= 32 && c < 127 ? c : 32; }
  }
  function getAscii(a, off, len) {
    var s = '';
    for (var i = 0; i < len; i++) s += a[off + i] >= 32 && a[off + i] < 127 ? String.fromCharCode(a[off + i]) : ' ';
    return s;
  }

  /* steps: [{ length, angle, x, z1, z2, r1, r2, set: { ton, odc, bspeed, cycle, hold, retDist, aux } }]; opts: { y, z, r (defaults) }. Returns the bytes of N.PLI (steps + end record). */
  function buildPli(steps, o) {
    o = o || {};
    var y = o.y !== undefined ? o.y : -3.79, z = o.z !== undefined ? o.z : 60, r = o.r !== undefined ? o.r : 0.1;
    var out = new Uint8Array((steps.length + 1) * REC);
    var len0 = Math.round(steps.length ? steps[0].length : 120);
    steps.forEach(function (s, i) {
      var a = fromHex(STEP_HEX), v = view(a);
      v.setInt16(0x0A, Math.round(s.length), true);
      v.setFloat32(0x10, s.angle, true);
      v.setFloat32(0x14, y, true); v.setFloat32(0x18, y, true);
      v.setFloat32(0x1C, s.x, true); v.setFloat32(0x20, s.x, true);
      var pick = function (v, d) { return v !== undefined ? v : d; };
      var st = s.set || {};
      if (st.ton !== undefined) v.setInt16(0x3C, Math.round(st.ton), true);
      if (st.odc !== undefined) v.setInt16(0x42, Math.round(st.odc), true);
      if (st.bspeed !== undefined) v.setInt16(0x44, Math.round(st.bspeed), true);
      if (st.cycle !== undefined) v.setInt16(0x4A, Math.round(st.cycle), true);
      if (st.hold !== undefined) v.setFloat32(0x56, st.hold, true);
      if (st.retDist !== undefined) v.setFloat32(0x4C, st.retDist, true);
      if (st.aux !== undefined) putAscii(a, 0x34, 6, String(st.aux).padEnd(6, '0'));
      v.setFloat32(0x24, pick(s.r1, r), true); v.setFloat32(0x28, pick(s.r2, r), true);
      v.setFloat32(0x2C, pick(s.z1, z), true); v.setFloat32(0x30, pick(s.z2, z), true);
      out.set(a, i * REC);
    });
    var e = fromHex(END_HEX);
    view(e).setInt16(0x0A, len0, true);
    view(e).setFloat32(0x2C, z, true); view(e).setFloat32(0x30, z, true);
    out.set(e, steps.length * REC);
    return out;
  }

  function numberField(n) { return ('000' + n).padEnd(9, ' '); }

  /* Find the entry for program n, or the first free one. Entry 99 and entries with a name are kept. */
  function entryProgram(fprog, s) {
    var d = getAscii(fprog, s + 4, 9).replace(/\s/g, '');
    return /^\d+$/.test(d) ? parseInt(d, 10) : -1;
  }

  /* The control reads as many entries as the count stored in the last two bytes of FPROG.DAT, and the entry for
     program 99 is always the last of them. A new program goes into a free entry before 99; if there is none, it
     takes the place of 99, 99 moves one entry down and the count goes up by one (see claimSlot). */
  function findSlot(fprog, n) {
    var free = -1, k99 = -1, last = 0;
    for (var k = 1; ENT_FIRST + (k - 1) * ENT + ENT <= fprog.length; k++) {
      var s = ENT_FIRST + (k - 1) * ENT, pn = entryProgram(fprog, s), cnt = view(fprog).getInt16(s + 40, true);
      last = k;
      if (pn === 99 && k99 < 0) { k99 = k; continue; }
      if (k99 >= 0) continue;                           // entries after the 99 entry are not read by the control
      if (pn === n && cnt > 0) return { k: k, s: s, existing: true };
      if (free < 0 && pn === 0 && cnt === 0 && fprog[s + 30] === 0x53) free = k;
    }
    if (free > 0) return { k: free, s: ENT_FIRST + (free - 1) * ENT, existing: false };
    if (k99 > 0 && k99 < last) return { k: k99, s: ENT_FIRST + (k99 - 1) * ENT, existing: false, insert: true };
    return null;
  }

  /* Make the slot from findSlot ready for writing in the (copied) file `out`. For an insert, the 99 entry moves one
     entry down and the entry count in the last two bytes goes up by one. */
  function claimSlot(out, slot) {
    if (!slot.insert) return;
    var next = slot.s + ENT, v = view(out);
    if (next + ENT > out.length) throw new Error('FPROG.DAT has no room for another program.');
    out.set(out.subarray(slot.s, slot.s + ENT), next);
    v.setInt16(out.length - 2, v.getInt16(out.length - 2, true) + 1, true);
  }

  /* p: { program, ref, thickness, steps (count of bends), punch, die, dh, sp, date }. Returns a copy of fprog. */
  function updateIndex(fprog, p) {
    var slot = findSlot(fprog, p.program);
    if (!slot) throw new Error('FPROG.DAT has no free program entry.');
    var out = new Uint8Array(fprog);
    claimSlot(out, slot);
    var e = fromHex(ENTRY_HEX), v = view(e);
    var d = p.date || new Date();
    putAscii(e, 4, 9, numberField(p.program));
    putAscii(e, 13, 13, p.ref);
    v.setFloat32(26, p.thickness, true);
    v.setInt16(40, p.steps + 1, true);
    putAscii(e, 42, 6, p.punch);
    putAscii(e, 48, 6, p.die);
    putAscii(e, 54, 6, p.dh !== undefined ? p.dh : '3');
    putAscii(e, 60, 6, p.sp !== undefined ? p.sp : '0');
    v.setInt16(66, p.steps + 1, true);
    e[68] = d.getFullYear() - 1900; e[69] = d.getMonth() + 1; e[70] = d.getDate();
    out.set(e, slot.s);
    return { bytes: out, slot: slot.k, existing: slot.existing };
  }

  /* Summary of an FPROG.DAT: [{ k, program, ref, steps }] for entries in use. */
  function listIndex(fprog) {
    var res = [];
    for (var k = 1; ENT_FIRST + (k - 1) * ENT + ENT <= fprog.length; k++) {
      var s = ENT_FIRST + (k - 1) * ENT;
      var num = getAscii(fprog, s + 4, 9).trim();
      var cnt = view(fprog).getInt16(s + 40, true);
      if (num.replace(/0/g, '') !== '' || cnt) res.push({ k: k, program: num, ref: getAscii(fprog, s + 13, 13).trim(), steps: cnt });
    }
    return res;
  }


  /* ---- reading and editing existing programs ---- */

  var STEP_FIELDS = [
    ['length', 0x0A, 'i16'], ['angle', 0x10, 'f'], ['y1', 0x14, 'f'], ['y2', 0x18, 'f'], ['x1', 0x1C, 'f'], ['x2', 0x20, 'f'],
    ['r1', 0x24, 'f'], ['r2', 0x28, 'f'], ['z1', 0x2C, 'f'], ['z2', 0x30, 'f'], ['ton', 0x3C, 'i16'], ['odc', 0x42, 'i16'],
    ['bspeed', 0x44, 'i16'], ['cycle', 0x4A, 'i16'], ['retDist', 0x4C, 'f'], ['hold', 0x56, 'f']
  ];

  function parseStep(rec) {
    var v = view(rec), s = {};
    STEP_FIELDS.forEach(function (f) {
      s[f[0]] = f[2] === 'f' ? Math.round(v.getFloat32(f[1], true) * 1000) / 1000 : v.getInt16(f[1], true);
    });
    s.aux = getAscii(rec, 0x34, 6).replace(/ /g, '0');
    return s;
  }

  /* Only fields that differ from what the record already shows are rewritten, so untouched values stay byte for byte. */
  function applyStep(rec, s) {
    var v = view(rec), orig = parseStep(rec);
    STEP_FIELDS.forEach(function (f) {
      var x = s[f[0]];
      if (x === undefined || x === null || !isFinite(x) || x === orig[f[0]]) return;
      if (f[2] === 'f') v.setFloat32(f[1], x, true); else v.setInt16(f[1], Math.round(x), true);
    });
    if (s.aux !== undefined && s.aux !== orig.aux) putAscii(rec, 0x34, 6, String(s.aux).padEnd(6, '0'));
  }

  /* Returns { steps: [{ raw, ...fields }], end: Uint8Array } or null. The last record is the end record. */
  function parsePli(bytes) {
    var n = Math.floor(bytes.length / REC);
    if (n < 1) return null;
    var steps = [];
    for (var i = 0; i < n - 1; i++) {
      var raw = new Uint8Array(bytes.subarray(i * REC, (i + 1) * REC));
      var s = parseStep(raw); s.raw = raw; steps.push(s);
    }
    return { steps: steps, end: new Uint8Array(bytes.subarray((n - 1) * REC, n * REC)) };
  }

  function serializePli(steps, end) {
    var out = new Uint8Array((steps.length + 1) * REC);
    steps.forEach(function (s, i) {
      var rec = new Uint8Array(s.raw || fromHex(STEP_HEX));
      applyStep(rec, s);
      out.set(rec, i * REC);
    });
    out.set(end || fromHex(END_HEX), steps.length * REC);
    return out;
  }

  function readEntry(fprog, n) {
    var slot = findSlot(fprog, n);
    if (!slot || !slot.existing) return null;
    var s = slot.s, v = view(fprog);
    return {
      k: slot.k, s: s, raw: new Uint8Array(fprog.subarray(s, s + ENT)),
      ref: getAscii(fprog, s + 13, 13).trim(), thickness: Math.round(v.getFloat32(s + 26, true) * 100) / 100,
      punch: getAscii(fprog, s + 42, 6).trim(), die: getAscii(fprog, s + 48, 6).trim(), count: v.getInt16(s + 40, true)
    };
  }

  /* Write the entry of `target`, starting from the bytes of the entry `src` (an entry from readEntry).
     c: { ref, thickness, steps (bends, without the end record), date }. */
  function putEntry(fprog, src, target, c) {
    var slot = findSlot(fprog, target);
    if (!slot) throw new Error('FPROG.DAT has no free program entry.');
    var out = new Uint8Array(fprog), e = new Uint8Array(src.raw), v = view(e), d = c.date || new Date();
    claimSlot(out, slot);
    if (!slot.existing || src.s !== slot.s) putAscii(e, 4, 9, numberField(target));
    else e.set(fprog.subarray(slot.s + 4, slot.s + 13), 4);
    if (c.ref !== undefined) putAscii(e, 13, 13, c.ref);
    if (c.thickness !== undefined) v.setFloat32(26, c.thickness, true);
    if (c.steps !== undefined) { v.setInt16(40, c.steps + 1, true); v.setInt16(66, c.steps + 1, true); }
    e[68] = d.getFullYear() - 1900; e[69] = d.getMonth() + 1; e[70] = d.getDate();
    out.set(e, slot.s);
    return { bytes: out, existing: slot.existing, slot: slot.k };
  }

  /* Entries the control reads (up to and including 99), and entries after 99 that it never sees. */
  function listPrograms(fprog) {
    var res = [], after = false;
    for (var k = 1; ENT_FIRST + (k - 1) * ENT + ENT <= fprog.length; k++) {
      var s = ENT_FIRST + (k - 1) * ENT, n = entryProgram(fprog, s), cnt = view(fprog).getInt16(s + 40, true);
      if (n > 0 && cnt > 0) res.push({ program: n, ref: getAscii(fprog, s + 13, 13).trim(), count: cnt, k: k, hidden: after });
      if (n === 99) after = true;
    }
    return res.sort(function (a, b) { return a.program - b.program; });
  }

  /* Move entries that sit after the 99 entry (invisible to the control) in front of it and fix the count.
     Returns the new bytes, or null when nothing needs repair. */
  function repairIndex(fprog) {
    var all = [], k99 = -1;
    for (var k = 1; ENT_FIRST + (k - 1) * ENT + ENT <= fprog.length; k++) {
      var s = ENT_FIRST + (k - 1) * ENT, n = entryProgram(fprog, s), cnt = view(fprog).getInt16(s + 40, true);
      if (n === 99 && k99 < 0) k99 = k;
      all.push({ k: k, s: s, n: n, cnt: cnt });
    }
    if (k99 < 0) return null;
    var orphans = all.filter(function (x) { return x.k > k99 && x.n > 0 && x.cnt > 0; });
    if (!orphans.length) return null;
    var out = new Uint8Array(fprog), at = k99, sentinel = new Uint8Array(fprog.subarray(all[k99 - 1].s, all[k99 - 1].s + ENT));
    orphans.forEach(function (o) {
      out.set(fprog.subarray(o.s, o.s + ENT), ENT_FIRST + (at - 1) * ENT);
      at++;
    });
    out.set(sentinel, ENT_FIRST + (at - 1) * ENT);
    var blank = fromHex(ENTRY_HEX);
    for (var j = at + 1; j <= all.length; j++) {
      var o2 = all[j - 1];
      if (orphans.some(function (x) { return x.k === j; })) { out.set(new Uint8Array(blankEntryFrom(fprog, all)), o2.s); }
    }
    var v = view(out);
    v.setInt16(out.length - 2, at + 1, true);       // entries 0..at, the last being 99
    return out;
  }

  /* A copy of an empty entry (the ones after the used entries), for clearing a moved entry. */
  function blankEntryFrom(fprog, all) {
    for (var i = all.length - 1; i >= 0; i--) {
      if (all[i].n === 0 && all[i].cnt === 0 && fprog[all[i].s + 30] === 0x53) return fprog.subarray(all[i].s, all[i].s + ENT);
    }
    return new Uint8Array(ENT);
  }

  window.PLI = { repairIndex: repairIndex, parsePli: parsePli, serializePli: serializePli, readEntry: readEntry, putEntry: putEntry, listPrograms: listPrograms, buildPli: buildPli, updateIndex: updateIndex, findSlot: findSlot, listIndex: listIndex, numberField: numberField };
})();
