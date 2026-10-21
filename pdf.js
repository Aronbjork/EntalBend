/* Minimal PDF writer: A4 pages with lines, rectangles, text (Helvetica, WinAnsi) and JPEG pictures.
   Coordinates are points (1/72 inch) from the top left corner of the page. No library needed. */
(function () {
  'use strict';

  /* Helvetica widths (1/1000 em) for characters 32-126. */
  var W = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
    556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667,
    778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222,
    222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];

  function textWidth(s, size, bold) {
    var w = 0;
    for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); w += c >= 32 && c <= 126 ? W[c - 32] : 556; }
    return w * size / 1000 * (bold ? 1.06 : 1);
  }

  /* Characters outside Latin-1 are replaced; WinAnsi matches Latin-1 for the ones used here (° × · å ä ö é). */
  function pdfStr(s) {
    s = String(s).replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
      .replace(/[^\x20-\xFF]/g, '?');
    return '(' + s.replace(/[\\()]/g, '\\$&') + ')';
  }

  function rgb(c) {
    if (!c) return [0, 0, 0];
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c);
    return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : [0, 0, 0];
  }
  var n3 = function (v) { return (Math.round(v * 1000) / 1000).toString(); };
  var col = function (c, op) { return rgb(c).map(n3).join(' ') + ' ' + op; };

  function Doc(landscape) {
    this.w = landscape ? 842 : 595; this.h = landscape ? 595 : 842;
    this.pages = []; this.images = [];
  }

  Doc.prototype.page = function () {
    var pg = new Page(this);
    this.pages.push(pg);
    return pg;
  };

  /* bytes: JPEG file as Uint8Array; w, h in pixels. */
  Doc.prototype.jpeg = function (bytes, w, h) {
    var img = { bytes: bytes, w: w, h: h, name: 'Im' + (this.images.length + 1) };
    this.images.push(img);
    return img;
  };

  function Page(doc) { this.doc = doc; this.ops = []; this.used = {}; }

  Page.prototype.Y = function (y) { return this.doc.h - y; };

  /* o: { w, color, dash: [on, off] } */
  Page.prototype.line = function (x1, y1, x2, y2, o) {
    o = o || {};
    this.ops.push('q ' + n3(o.w || 0.8) + ' w ' + col(o.color, 'RG') + (o.dash ? ' [' + o.dash.join(' ') + '] 0 d' : '') +
      ' ' + n3(x1) + ' ' + n3(this.Y(y1)) + ' m ' + n3(x2) + ' ' + n3(this.Y(y2)) + ' l S Q');
  };

  /* o: { fill, stroke, w } */
  Page.prototype.rect = function (x, y, w, h, o) {
    o = o || {};
    var op = o.fill && o.stroke ? 'B' : o.fill ? 'f' : 'S';
    this.ops.push('q ' + n3(o.w || 0.8) + ' w ' + (o.fill ? col(o.fill, 'rg') + ' ' : '') + (o.stroke ? col(o.stroke, 'RG') + ' ' : '') +
      n3(x) + ' ' + n3(this.Y(y + h)) + ' ' + n3(w) + ' ' + n3(h) + ' re ' + op + ' Q');
  };

  /* y is the baseline. o: { size, bold, color, align: 'left' | 'center' | 'right', maxW } */
  Page.prototype.text = function (x, y, s, o) {
    o = o || {};
    var size = o.size || 9;
    s = String(s);
    if (o.maxW && textWidth(s, size, o.bold) > o.maxW) {
      while (s.length > 1 && textWidth(s + '..', size, o.bold) > o.maxW) s = s.slice(0, -1);
      s += '..';
    }
    var tw = textWidth(s, size, o.bold);
    if (o.align === 'center') x -= tw / 2; else if (o.align === 'right') x -= tw;
    this.ops.push('BT /' + (o.bold ? 'F2' : 'F1') + ' ' + n3(size) + ' Tf ' + col(o.color, 'rg') + ' ' + n3(x) + ' ' + n3(this.Y(y)) + ' Td ' + pdfStr(s) + ' Tj ET');
    return tw;
  };

  Page.prototype.image = function (img, x, y, w, h) {
    this.used[img.name] = img;
    this.ops.push('q ' + n3(w) + ' 0 0 ' + n3(h) + ' ' + n3(x) + ' ' + n3(this.Y(y + h)) + ' cm /' + img.name + ' Do Q');
  };

  function latin1(s) {
    var b = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255;
    return b;
  }

  Doc.prototype.bytes = function () {
    var parts = [], len = 0, offs = [], self = this;
    var put = function (x) { var b = typeof x === 'string' ? latin1(x) : x; parts.push(b); len += b.length; };
    var objs = [];                                     // each: string or [head, bytes, tail]
    var add = function (o) { objs.push(o); return objs.length; };
    var font1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    var font2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    var imgIds = {};
    this.images.forEach(function (im) {
      imgIds[im.name] = add(['<< /Type /XObject /Subtype /Image /Width ' + im.w + ' /Height ' + im.h +
        ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + im.bytes.length + ' >>\nstream\n', im.bytes, '\nendstream']);
    });
    var pagesId = objs.length + 1 + this.pages.length * 2;
    var kids = [];
    this.pages.forEach(function (pg) {
      var content = pg.ops.join('\n');
      var cid = add('<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream');
      var xo = Object.keys(pg.used).map(function (k) { return '/' + k + ' ' + imgIds[k] + ' 0 R'; }).join(' ');
      kids.push(add('<< /Type /Page /Parent ' + pagesId + ' 0 R /MediaBox [0 0 ' + self.w + ' ' + self.h + '] /Contents ' + cid + ' 0 R' +
        ' /Resources << /Font << /F1 ' + font1 + ' 0 R /F2 ' + font2 + ' 0 R >>' + (xo ? ' /XObject << ' + xo + ' >>' : '') + ' >> >>'));
    });
    add('<< /Type /Pages /Kids [' + kids.map(function (k) { return k + ' 0 R'; }).join(' ') + '] /Count ' + kids.length + ' >>');
    var catalog = add('<< /Type /Catalog /Pages ' + pagesId + ' 0 R >>');
    put('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    objs.forEach(function (o, i) {
      offs.push(len);
      put((i + 1) + ' 0 obj\n');
      if (typeof o === 'string') put(o); else o.forEach(put);
      put('\nendobj\n');
    });
    var xref = len;
    put('xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n');
    offs.forEach(function (o) { put(String(o).padStart(10, '0') + ' 00000 n \n'); });
    put('trailer\n<< /Size ' + (objs.length + 1) + ' /Root ' + catalog + ' 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
    var out = new Uint8Array(len), p = 0;
    parts.forEach(function (b) { out.set(b, p); p += b.length; });
    return out;
  };

  /* JPEG data URL -> bytes */
  function dataUrlBytes(url) {
    var bin = atob(url.slice(url.indexOf(',') + 1)), b = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    return b;
  }

  window.PDF = { Doc: Doc, textWidth: textWidth, dataUrlBytes: dataUrlBytes };
})();
