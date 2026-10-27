ToolsModified - punch 814 and die holder 4 added to the libraries exported from the NC (Floppytools3).

Changed files: FPOINC.DAT (punch 814 added as 3rd record), FCALE.DAT (holder 4 added as 3rd record),
FMATRI.DAT (die 3108 added as 3rd record).
Everything else is byte for byte what the NC exported. Punches 210 and 835 and holder 3 are untouched.
make_tools.py rebuilds the three files from Floppytools3 (run it in a copy of that folder).

Punch 814  AFH acute angle punch, 30 deg, tip radius 0.6, height 120, max 450 kN/m.
  Outline from the vendor drawing (814 30.pdf), simplified to 17 segments (the manual allows 19).
  Small 1 mm chamfers are left out. The ear profile (120 kN/m) is not modelled.
Holder 4   block 60 x 85 mm: the bounding box of holder 3 (60 wide, 85 high), same starting point.

Die 3108   die 3008 with an 85 mm block under it (walls 48 -> 133 mm, height 38 -> 123, same 60 mm width, V8, 450 kN/m).
  This is the holder folded into the die. Use it with DH 0 (holder 3 and 4 both give "Calculating error bottom ENV").

Import on the NC (see the manual, RESTORE): copy FPOINC.DAT, FCALE.DAT and FMATRI.DAT to the stick, then
  RESTORE punches (partial, pick 814), RESTORE die holders (partial, pick 4) and RESTORE dies (partial, pick 3108).
  "ERASE DATA FD CONFIRM" has to be answered 1 for the restore to run. The files contain all existing
  punches/holders/dies as well, so nothing is lost even if it replaces the whole library.
Then look at punch 814 and holder 4 in VISUALISATION, set PUNCH 814, DIE 3108 and DH 0 in program 52, press the graphic key.
