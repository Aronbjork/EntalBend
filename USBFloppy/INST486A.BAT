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
CLS
REM For other value : reboot the NC
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
ECHO ****** Installation on Compact-Flash ATON : STEP 0 ******
\486cflsh\CMOS /R \486cflsh\bfd450.cfg
SETSTEP 1
reboot

:phase1
ECHO ****** Installation on Compact-Flash ATON : STEP 1 ******
FORMAT C: < oui
SETSTEP 2
reboot

:phase2
ECHO ****** Installation on Compact-Flash ATON : STEP 2 ******
SYS C:
COPY A:\SYSTEME\*.* C:\
ECHO .
\486cflsh\CMOS /R \486cflsh\bhd450.cfg
SETSTEP 0

ECHO .
ECHO End loading NC software... rebooting on Compact-Flash
reboot
