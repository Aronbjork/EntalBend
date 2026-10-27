@ECHO OFF

GETSTEP
CLS
ECHO .
ECHO .
ECHO       旼컴컴컴컴컴컴컴컴컴컴컴컴컴컴컴컴컴컴컴컴커
ECHO       �  AMADA NC SOFTWARE V4 (EU) INSTALLATION  �
ECHO       읕컴컴컴컴컴컴컴컴컴컴컴컴컴컴컴컴컴컴컴컴켸
ECHO .
ECHO .
if errorlevel 12  GOTO PHASE12
if errorlevel 11  GOTO PHASE11
if errorlevel 10  GOTO PHASE10
if errorlevel 9   GOTO erreur
if errorlevel 8   GOTO erreur
if errorlevel 7   GOTO erreur
if errorlevel 6   GOTO erreur
if errorlevel 5   GOTO erreur
if errorlevel 4   GOTO erreur
if errorlevel 3   GOTO PHASE3
if errorlevel 2   GOTO PHASE2
if errorlevel 1   GOTO PHASE1
if errorlevel 0   GOTO PHASE0

:erreur
REM For other value : reboot NC
setstep 0
reboot


:phase0
@ECHO Installation CPU 386 with Tiny-Flash   : 1
@ECHO Installation CPU 386 with DiskOnChip   : 2
ECHO .
READ_NUM    Enter your choice :
if errorlevel 2 GOTO PHASE10
if errorlevel 1 GOTO PHASE1
CLS
GOTO phase0



:PHASE1
ECHO ****** Installation on Tiny-Flash 386 : STEP 1 ******
SETUP @386Tiny\bootfd.cfg
SETSTEP 2
reboot

:PHASE2
ECHO ****** Installation on Tiny-Flash 386 : STEP 2 ******
CD TINYF
TFORMAT c: /FIXED /S:tinybios.bin
CD \
SETSTEP 3
reboot

:PHASE3
ECHO ****** Installation on Tiny-Flash 386 : STEP 3 ******
SYS c:
COPY A:\SYSTEME\*.* c:
setup @\386Tiny\boothd.cfg
SETSTEP 0
makecrc
ECHO .
ECHO End loading NC software... rebooting on TinyFlash
reboot

REM /*################################################# */

:PHASE10
ECHO ****** Installation on DiskOnChip 386 : STEP 1 ******
SETUP @386DonC\bootfd.cfg
SETSTEP 11
reboot

:phase11
ECHO ****** Installation on DiskOnChip 386 : STEP 2 ******
\DISKONC\DFORMAT /WIN:D000 /S:\DISKONC\DOC42.EXB /Y
SETSTEP 12
reboot

:phase12
ECHO ****** Installation on DiskOnChip 386 : STEP 3 ******
SYS C:
COPY A:\systeme\*.* C:\
SETUP @\386DOnC\boothd.cfg
SETSTEP 0
makecrc
ECHO .
ECHO End loading NC software... rebooting on diskonchip
reboot
