Test programs for graphical (L-ALPHA) export. Copy the whole folder content to the USB stick / floppy and load on the NC.
All: width 50 mm, thickness 1.0, punch 835, die 3008.
 51  Z  30/15/10, +90/-90   (byte for byte identical to the program saved on the machine)
 52  U  20/40/20, +90/+90
 53  L  30/20,    +90
 54  Z  30/15/10, +90/-90   (same as 51, different number)
Open each in EDIT PROGRAM: does the drawing show as entered, and are the angle signs right?
Then run AUTO on the graphic page: does it find a sequence? Report what the NC says (and any tonnage message).
Developed length in the index is estimated; the NC should recalculate it.
FPROG.DAT: program 51 was moved in front of 99 (the machine had put it after 99).
