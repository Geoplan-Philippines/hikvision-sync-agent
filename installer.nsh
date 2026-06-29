!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Meedo Hikvision Sync Agent"
  RMDir /r "$LOCALAPPDATA\Meedo\HikvisionSyncAgent"
!macroend
