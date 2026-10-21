EntalBend - DXF to bending program
==================================

Install
-------
Copy this whole folder to:  C:\Programmering\EntalBend
Open index.html in Chrome or Edge (double-click, or right-click > Open with).
No internet or installation is needed. Writing straight to the USB folder only works in Chrome or Edge.
If the USB folder button does not work when opened from a file, start a local server instead:
  cd C:\Programmering\EntalBend
  python -m http.server 8000
and open http://localhost:8000

Files
-----
index.html   the page
style.css    layout and colours
dxf.js       DXF reading and bend geometry
app.js       drawing view, bend table, output and USB export
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
6. Offset: added to the backgauge distance to give "Backgauge X". Normally X is the flat distance from the bend
   line to the farthest edge on the gauge side. When a bend lies on a flange that already has an earlier bend
   (parallel, between the bend and the gauged edge), X is the distance to that earlier bend line instead,
   because that bend is folded and the gauge touches it. Example: bends at 15 mm and 45 mm from the edge give
   X = 15 for the first and X = 30 for the second. The row is marked "2nd bend on the flange of #n" and its Offset field is highlighted (use it for bend allowance).
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

USB export (Operateur 2000)
---------------------------
Format decoded from programs saved on the machine (folder Floppy3). One program = N.PLI (144-byte step
records plus an end record) and an entry in FPROG.DAT (124 bytes per program).
1. Back up the stick. Copy the stick's FPROG.DAT to the PC or pick the stick's folder.
2. Fill in Program no. (1-98), Job reference, Thickness, Punch and Die, select the bends.
3. "Write to USB folder" (Chrome/Edge) writes N.PLI and FPROG.DAT and keeps the old index as FPROG.BAK.
   "Download files" asks for the stick's FPROG.DAT and downloads N.PLI and a new FPROG.DAT to copy over.
Only N.PLI and FPROG.DAT are touched. Other programs and the tool tables are left alone. An existing
program with the same number is replaced.
Per bend you can set Z1, Z2 (fingers) and R1, R2 (backgauge height) in the table. Empty fields use the
defaults from the USB export panel (Z 60, R 0.1).
Decoded and checked against program 11: angle, Y1/Y2, X1/X2, R1/R2, Z1/Z2, bend length, thickness, die, punch.
Not decoded: three unknown values in the FPROG.DAT entry and the first value of the end record. They are copied
from a working program. Y penetration is not calculated: empty = 0. Tested on the machine: Y shows 0 when the
program is opened; retype the angle on each step and press Enter and the control calculates Y. Or type the value the control shows. Up/Down direction is not stored (flip the part by hand). Always check a new program on the
control before bending a part.

Bend simulator
--------------
Below the bend table: top view of the 2500 mm machine with the part, the bend line and the Z1/Z2 fingers
(100 mm wide, Z = finger centre, Z1 left of centre, Z2 right of centre), and a side view of the bend.
Click a row in the bend table (or use the arrows) to simulate that step. A finger turns red and a warning
appears when it touches less than half of the part edge, is outside the machine, or overlaps the other finger.
The flat pattern is shown as drawn (earlier bends not folded), centred on the machine; use Part shift if the
part is placed off-centre. Drag the Z1/Z2 fingers sideways to set Z for that bend (whole mm, hold Shift for 0.1). File: sim.js.

3D simulator
------------
The Bend simulator panel has a 3D view (default) and a Top view. The 3D view folds the flat pattern bend by bend,
places the current bend over the die, and shows an approximate punch (88 deg tip) and die (V width = last two digits
of the die reference, e.g. 3008 = V8), plus the Z1/Z2 fingers. R1/R2 raise each finger above the die top (R = lower edge of the finger arm; the sheet never rests on it).
Use Bend (animation) or the Progress slider to bend the part, and the arrows or a table row to step through bends.
Fingers are placed on the gauged edge when a bend is added. Typing Z1/Z2 stops that; Auto fingers restores it.
Limits: bend lines are assumed to run across the whole part, and tool shapes are approximations.
Libraries (three.js r128, OrbitControls) are in the vendor folder, so no internet is needed. Files: sim3d.js, sim.js.

Per-bend settings and Z limit
-----------------------------
Under the bend table: Cycle, Tonnage, End hold, B.speed, O.D.C, Ret. dist (unverified) and Aux funct. per bend; empty = the
default shown greyed. "Apply to all bends" copies them. STEP, COINING, B.G HOLD, WAIT.RET, R.SPEED and dX AUTO are not
written yet (their place in the file is not known). Z1 + Z2 must be at least 120 mm (60/60 is the closest on the machine):
changing one finger pushes the other, and export refuses a program that breaks it.

Programs on the USB stick (edit existing programs)
--------------------------------------------------
"Programs on the USB stick": Open USB folder (Chrome/Edge) or Open files (FPROG.DAT + the .PLI files). Pick a program,
edit the step values (angle, X, Y, R, Z, settings), add or remove steps, and Save to stick. A different program no.
saves a copy. Only changed values are rewritten (an unchanged program is written back byte for byte).
The stick has no drawing, so these programs are edited as numbers; there is no simulator for them.

Punch in the 3D simulator
-------------------------
The punch is drawn from the manufacturer drawing "814 30.pdf" (AFH acute angle punch 814: 30 deg tip, R0.6, 120 mm to the
clamp shoulder, 150 mm in all, 6 mm blade, clamp head with notch). When the Punch field is 835, 415 or 800 the
punch (and the die) is drawn that long in mm. Drawing left is assumed to be the front of the machine; tick "Flip punch"
if it is the other way round. Other punch references use the same shape. The die is still a simple V block.

Die and ram in the 3D simulator
-------------------------------
The die is drawn from a photo of the real die (60 mm wide, 48 mm high; V groove 38 mm from the back edge and 22 mm from
the front edge, shoulder radii, relief groove). V width = last two digits of the die reference. The upper beam is red with
an AMADA lettering on its front. Approximate, not a manufacturer drawing.

Small tabs on the gauged edge
-----------------------------
"Ignore tabs narrower than (mm)" in the Program panel (default 60, 0 = off): the backgauge distance is measured to the
farthest edge that is at least that wide, so a small tab on the edge does not move X and the auto fingers sit on the
main edge. The tab still shows in the drawing. Set 0 to measure to the very farthest point as before.
