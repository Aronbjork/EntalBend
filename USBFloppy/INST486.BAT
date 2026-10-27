@ECHO OFF

GETSTEP
CLS
ECHO .
ECHO .
ECHO       здддддддддддддддддддддддддддддддддддддддддд©
ECHO       Ё  AMADA NC SOFTWARE V4 (EU) INSTALLATION  Ё
ECHO       юдддддддддддддддддддддддддддддддддддддддддды
ECHO .
ECHO .
IF errorlevel 4 GOTO erreur
IF errorlevel 3 GOTO erreur
IF errorlevel 2 GOTO phase2
IF errorlevel 1 GOTO phase1
IF errorlevel 0 GOTO phase0

:erreur
REM For other value : reboot NC
setstep 0
reboot


:phase0
vidclav
ECHO .
ECHO .
ECHO                           здддддддд©
ECHO          "PRESS ENTER KEY Ё <дддды Ё TO INSTALL AMADA SOFTWARE ON NC"
ECHO                           юдддддддды
ECHO .
ECHO .
PAUSE > NUL
ECHO .
ECHO ****** Installation on 486 Diskonchip : STEP 0 ******
SETUP @\486DONC\bfd486.cfg
SETSTEP 1
reboot

:phase1
ECHO ****** Installation on 486 Diskonchip : STEP 1 ******
\DISKONC\DFORMAT /WIN:D000 /S:\DISKONC\DOC42.EXB /Y
SETSTEP 2
reboot

:phase2
ECHO ****** Installation on 486 Diskonchip : STEP 2 ******
SYS C:
COPY A:\SYSTEME\*.* C:\
ECHO .
SETUP @\486DONC\bhd486.cfg
SETSTEP 0
ECHO .
ECHO End loading NC software... rebooting on diskonchip
reboot
