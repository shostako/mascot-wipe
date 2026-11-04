# Prints "<window handle> <claude pid>" for the terminal window that hosts the calling Claude Code process.
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class HostWindow {
    [DllImport("kernel32.dll")] public static extern bool FreeConsole();
    [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    public static string ClassOf(IntPtr h) {
        var s = new System.Text.StringBuilder(256);
        GetClassName(h, s, 256);
        return s.ToString();
    }
}
"@
function Get-ParentId([int]$Id) { (Get-CimInstance Win32_Process -Filter "ProcessId=$Id").ParentProcessId }

$claude = Get-ParentId $PID
$window = [IntPtr]::Zero
if ([HostWindow]::FreeConsole() -and [HostWindow]::AttachConsole([uint32]$claude)) {
    $console = [HostWindow]::GetConsoleWindow()
    if ($console -ne [IntPtr]::Zero) {
        # GA_ROOTOWNER: a ConPTY's hidden window is owned by the terminal that opened it.
        $root = [HostWindow]::GetAncestor($console, 3)
        if ($root -ne [IntPtr]::Zero -and [HostWindow]::ClassOf($root) -ne "PseudoConsoleWindow" -and [HostWindow]::IsWindowVisible($root)) { $window = $root }
    }
}
# Terminals that do not set the owner: use the nearest ancestor process with a main window.
$id = $claude
for ($i = 0; $window -eq [IntPtr]::Zero -and $i -lt 12 -and $id; $i++) {
    $process = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($process -and $process.MainWindowHandle -ne [IntPtr]::Zero) { $window = $process.MainWindowHandle }
    try { $id = Get-ParentId $id } catch { $id = 0 }
}
[Console]::Out.WriteLine("$($window.ToInt64()) $claude")
