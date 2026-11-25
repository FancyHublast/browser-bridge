' browser-bridge service launcher (windowless, with startup self-check)
'
' Two decisions worth keeping:
'
' 1) Use python.exe, NOT pythonw.exe.
'    When pythonw.exe is started from Explorer / a VBS host, Windows gives it
'    no standard handles, so Python's sys.stdout and sys.stderr are None.
'    logging.StreamHandler.emit() then calls None.write() and the process dies
'    with AttributeError before the socket is bound -- with no window and no
'    message, which looks exactly like "double-clicked and nothing happened".
'    python.exe always has real handles; window style 0 keeps it hidden.
'
' 2) Verify the port after launch and complain if it did not come up.
'    A silent no-op is the worst possible failure mode. If 8765 is not
'    listening after 5 seconds, show a message pointing at service.log.
'
' Keep this file pure ASCII: VBScript reads .vbs as ANSI.

Option Explicit

Dim fso, sh, base, py, srv, rc

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

base = fso.GetParentFolderName(WScript.ScriptFullName)
py = base & "\.venv\Scripts\python.exe"
srv = base & "\mcp_server.py"

If Not fso.FileExists(py) Then
  MsgBox "python.exe not found:" & vbCrLf & py & vbCrLf & vbCrLf & _
         "Run install-local-service.bat first.", 16, "browser-bridge"
  WScript.Quit 1
End If

If Not fso.FileExists(srv) Then
  MsgBox "mcp_server.py not found:" & vbCrLf & srv, 16, "browser-bridge"
  WScript.Quit 1
End If

If Not fso.FileExists(base & "\config.json") Then
  MsgBox "config.json not found in:" & vbCrLf & base, 16, "browser-bridge"
  WScript.Quit 1
End If

sh.CurrentDirectory = base
sh.Run """" & py & """ """ & srv & """ --http", 0, False

WScript.Sleep 5000
rc = sh.Run("cmd /c netstat -ano | findstr "":8765"" >nul 2>&1", 0, True)

If rc <> 0 Then
  MsgBox "Service did not start (port 8765 not listening)." & vbCrLf & vbCrLf & _
         "Log file:" & vbCrLf & base & "\service.log" & vbCrLf & vbCrLf & _
         "Or run it manually in a console to see the error:" & vbCrLf & _
         """" & py & """ """ & srv & """ --http", 16, "browser-bridge"
  WScript.Quit 1
End If

' Started fine: stay silent, that is the expected experience.
