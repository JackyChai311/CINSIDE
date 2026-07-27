Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c """ & "d:\CINSIDE\start-electron.bat" & """", 0, False
Set WshShell = Nothing
