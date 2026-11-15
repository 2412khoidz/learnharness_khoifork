; Keep ChronoHarness isolated from official LearnHarness on Windows.
;
; With nsis.oneClick=true and perMachine=false, electron-builder defaults
; APP_FILENAME from package.json's sanitized name unless overridden, so any
; fallback or shared identifier must resolve to ChronoHarness instead of
; learnharness.
;
; Also disarm the one-time legacy registry/exe remnants from ChronoHarness
; 0.6.1 when appId was com.chronoharness.ChronoHarness and landed in
; Programs\learnharness — deleting ONLY ChronoHarness executables and legacy
; registry keys, NEVER RMDir /r on the shared folder.

!ifdef APP_FILENAME
  !undef APP_FILENAME
!endif
!define APP_FILENAME "ChronoHarness"

!ifdef APP_PRODUCT_FILENAME
  !undef APP_PRODUCT_FILENAME
!endif

!ifdef APP_PACKAGE_NAME
  !undef APP_PACKAGE_NAME
!endif
!define APP_PACKAGE_NAME "chronoharness"

!ifdef APP_INSTALLER_STORE_FILE
  !undef APP_INSTALLER_STORE_FILE
!endif
!define APP_INSTALLER_STORE_FILE "chronoharness-updater\installer.exe"

!macro customInstall
  !ifndef BUILD_UNINSTALLER
    ReadRegStr $0 HKCU "Software\f33a87ac-7f04-5bff-adb9-5b72bb303e1c" "InstallLocation"
    ${If} $0 != ""
    ${AndIf} $0 != $INSTDIR
      Delete "$0\Uninstall ChronoHarness.exe"
      Delete "$0\ChronoHarness.exe"
      ClearErrors
    ${EndIf}
    DeleteRegKey HKCU "Software\f33a87ac-7f04-5bff-adb9-5b72bb303e1c"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\f33a87ac-7f04-5bff-adb9-5b72bb303e1c"
  !endif
!macroend
