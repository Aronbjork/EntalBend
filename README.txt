EntalBend - DXF to bending program
==================================

Install
-------
Copy this whole folder to:  C:\Programmering\EntalBend
Open index.html in Chrome or Edge (double-click, or right-click > Open with).
No internet or installation is needed. Web Serial (RS232) only works in Chrome or Edge.
If the serial buttons do not work when opened from a file, start a local server instead:
  cd C:\Programmering\EntalBend
  python -m http.server 8000
and open http://localhost:8000

Files
-----
index.html   the page
style.css    layout and colours
dxf.js       DXF reading and bend geometry
app.js       drawing view, bend table, output and RS232
sample.dxf   test part: 3 dashed bend lines (two close together on the left flange)

How to use
----------
1. Open an ASCII DXF (Open DXF, or drop the file on the drawing). DWG and binary DXF are not supported.
   Units are taken as millimetres. Change "Drawing scale" if the drawing is in other units.
2. Dashed lines are detected as bend lines. Dashes that were exploded into many short lines are joined
   into one bend (setting: Join gaps up to). If your bends are on their own layer but not dashed,
   tick Bend for that layer. Tick Ignore for layers with dimensions or text.
   Shift+click on any line marks or unmarks it as a bend.
3. Click the bend lines in the order you want to bend them. The number is the bend order.
   Use the arrows in the table to change the order.
4. Per bend: angle, direction (Up or Down; right-click a selected bend to flip), and gauge side.
   Down bends mean the part is turned over, shown as FLIP.
5. Gauge side: the arrow on the drawing points to the side the backgauge measures to.
   "To edge" is the flat distance from the bend line to the farthest edge on that side.
   Use the swap button if the wrong side is chosen.
6. Offset: added to the edge distance to give "Backgauge X". When a bend lies on a flange that already
   has an earlier bend (parallel, between the bend and the gauged edge), the row is marked
   "2nd bend on the flange of #n" and the offset field is highlighted.
7. Fill in program number (max 6 digits), job reference (max 13 characters), material, thickness,
   punch and die. These limits come from the Operator 2000 programming manual.

Saved programs
--------------
The Saved programs panel keeps a library of bending programs in this browser.
- Save stores the DXF, the bend detection settings, the program fields and the whole bend
  sequence (order, angle, direction, gauge side, offset) under the Name. An empty Name uses
  the job reference, then the program number, then the DXF file name.
- Open loads a saved program again. The X button deletes it.
- Save as file writes the program as a .entalbend.json file. Open file (or dropping the file on
  the drawing) reads it back. Use this for backups and to move programs to another PC.
- The library lives in the browser (IndexedDB). Clearing browsing data in Chrome/Edge, or using
  another browser or PC, gives an empty library, so keep files of the programs that matter.

Important
---------
- The distances come from the flat pattern. They are not the "external flange" values that the
  Operateur 2000 expects when dX AUTO = 1 (see the manual, MANUAL 2 mode, X value). Use the
  offset field, or check the first parts on the machine, until you know the correction you need.
- The manuals do not describe an RS232 program format. The program text is sent as written in
  the Program output box. Use the receive log to capture what the control sends and adapt the text.
- Default serial settings: 9600 baud, 7 data bits, even parity, 1 stop bit, XON/XOFF.
  This is a common setup for older controls but is not confirmed for the Operateur 2000.
  Web Serial has no XON/XOFF of its own, so EntalBend handles it: when the control sends
  XOFF (hex 13) sending pauses until it sends XON (hex 11). Both show in the log as [XOFF]/[XON].
  Settings you changed earlier are remembered in the browser and override these defaults.
