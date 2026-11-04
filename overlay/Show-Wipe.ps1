<#
.SYNOPSIS
    Shows the mascot in a transparent, always-on-top, click-through window.
.DESCRIPTION
    One window serves every session. Each session writes a file in Sessions:
        <face> <mode> <host window> <claude pid> <last prompt ms>
    The window follows the foreground window. In Windows Terminal the window title is the title of
    the selected tab, so it is compared with the console title of each session: a tab with no
    session hides the face, and switching tabs switches the face. Among equal titles, and in other
    terminals, the session that received a prompt last wins. It exits a few seconds after no
    visible session is left.
#>
param(
    [Parameter(Mandatory = $true)][string]$Frames,
    [Parameter(Mandatory = $true)][string]$Sessions,
    [int]$Size = 170
)

$ErrorActionPreference = "Stop"
$logFile = Join-Path (Split-Path $Sessions -Parent) "wipe.log"
trap {
    Add-Content -Path $logFile -Value "$(Get-Date -Format s) fatal $($_.Exception.Message)"
    exit 1
}

$mutex = New-Object System.Threading.Mutex($false, "Local\MascotWipeOverlay")
if (-not $mutex.WaitOne(0)) { exit 0 }

Add-Type -AssemblyName System.Drawing, System.Windows.Forms

Add-Type -ReferencedAssemblies System.Drawing, System.Windows.Forms -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

public class WipeForm : Form {
    const int WS_EX_LAYERED = 0x80000, WS_EX_TRANSPARENT = 0x20, WS_EX_TOPMOST = 0x8,
              WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x8000000;
    [StructLayout(LayoutKind.Sequential)] struct PT { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct SZ { public int cx, cy; }
    [StructLayout(LayoutKind.Sequential, Pack = 1)] struct BF { public byte op, flags, alpha, fmt; }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] static extern bool UpdateLayeredWindow(IntPtr h, IntPtr dst, ref PT pos, ref SZ size, IntPtr src, ref PT srcPos, int key, ref BF blend, int flags);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("kernel32.dll")] static extern bool FreeConsole();
    [DllImport("kernel32.dll")] static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern uint GetConsoleTitle(StringBuilder s, uint n);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

    const int IdleExitTicks = 50;
    // A title can change between the two reads. Hide only when it stays unmatched this many ticks.
    const int MissTicks = 5;
    const string WindowsTerminalClass = "CASCADIA_HOSTING_WINDOW_CLASS";
    const long MaxLogBytes = 1024 * 1024;
    readonly Dictionary<string, Bitmap> frames;
    readonly string sessions, logFile;
    readonly int size;
    readonly Timer timer = new Timer();
    string face = "neutral", shown = null, logged = "", shownOwner = null, shownFace = null;
    int lastX = int.MinValue, lastY = int.MinValue, idleTicks = 0, missTicks = 0;

    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
        get {
            CreateParams p = base.CreateParams;
            p.ExStyle |= WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
            return p;
        }
    }

    public WipeForm(Dictionary<string, Bitmap> frames, string sessions, string logFile, int size) {
        this.frames = frames; this.sessions = sessions; this.logFile = logFile; this.size = size;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        timer.Interval = 100;
        timer.Tick += delegate { Tick(); };
        timer.Start();
    }

    void Log(string text) {
        try {
            FileInfo info = new FileInfo(logFile);
            if (info.Exists && info.Length > MaxLogBytes) {
                File.Delete(logFile + ".1");
                File.Move(logFile, logFile + ".1");
            }
            File.AppendAllText(logFile, DateTime.Now.ToString("s") + " " + text + Environment.NewLine);
        } catch (IOException) {
        } catch (UnauthorizedAccessException) {
        }
    }

    static bool Alive(int pid) {
        try { using (Process p = Process.GetProcessById(pid)) { return !p.HasExited; } }
        catch (ArgumentException) { return false; }
        catch (InvalidOperationException) { return false; }
        catch (System.ComponentModel.Win32Exception) { return true; }
    }

    static string WindowText(IntPtr h) {
        StringBuilder s = new StringBuilder(1024);
        GetWindowText(h, s, s.Capacity);
        return s.ToString();
    }

    static bool IsWindowsTerminal(IntPtr h) {
        StringBuilder s = new StringBuilder(256);
        GetClassName(h, s, s.Capacity);
        return s.ToString() == WindowsTerminalClass;
    }

    // The title of the console that holds the process, or null when it cannot be read.
    static string ConsoleTitle(int pid) {
        FreeConsole();
        if (!AttachConsole((uint)pid)) return null;
        StringBuilder s = new StringBuilder(1024);
        GetConsoleTitle(s, (uint)s.Capacity);
        FreeConsole();
        return s.ToString();
    }

    // Claude Code animates a mark at the start of the title while it works.
    static string Plain(string title) {
        int i = 0;
        while (i < title.Length && !char.IsLetterOrDigit(title[i])) i++;
        return title.Substring(i);
    }

    // Returns the face for the foreground window, or null. Removes the files of crashed sessions.
    string Pick(IntPtr fg, out int visible, out string owner) {
        visible = 0;
        owner = null;
        string best = null, bestTitled = null, ownerTitled = null;
        long newest = long.MinValue, newestTitled = long.MinValue;
        bool terminal = IsWindowsTerminal(fg);
        string want = terminal ? Plain(WindowText(fg)) : "";
        // A terminal set not to use the tab title has nothing to compare, so the last prompt decides.
        bool compare = terminal && want.Length > 0 && want != "Windows Terminal";
        foreach (string path in Directory.GetFiles(sessions)) {
            string[] w;
            try { w = File.ReadAllText(path).Trim().Split(' '); }
            catch (IOException) { visible++; continue; }
            catch (UnauthorizedAccessException) { visible++; continue; }
            long host, prompt; int pid;
            if (w.Length < 5 || !long.TryParse(w[2], out host) || !int.TryParse(w[3], out pid) || !long.TryParse(w[4], out prompt)) { visible++; continue; }
            if (pid != 0 && !Alive(pid)) {
                try { File.Delete(path); } catch (IOException) { } catch (UnauthorizedAccessException) { }
                continue;
            }
            if (w[1] == "off") continue;
            visible++;
            if (host != fg.ToInt64()) continue;
            if (prompt > newest) { newest = prompt; best = w[0]; owner = Path.GetFileName(path); }
            if (compare && prompt > newestTitled) {
                string title = ConsoleTitle(pid);
                if (title != null && Plain(title) == want) { newestTitled = prompt; bestTitled = w[0]; ownerTitled = Path.GetFileName(path); }
            }
        }
        if (!compare || best == null) { missTicks = 0; return best; }
        if (bestTitled != null) { missTicks = 0; owner = ownerTitled; return bestTitled; }
        // Keep the face through a short change of title, then hide: this tab has no session.
        missTicks++;
        if (missTicks >= MissTicks) { owner = null; return null; }
        owner = shownOwner;
        return shownFace;
    }

    void Tick() {
        try {
            IntPtr fg = GetForegroundWindow();
            int visible;
            string owner;
            string pick = Pick(fg, out visible, out owner);
            idleTicks = visible == 0 ? idleTicks + 1 : 0;
            if (idleTicks >= IdleExitTicks) { Log("exit"); Application.Exit(); return; }
            shownOwner = owner; shownFace = pick;
            string state = pick == null ? "hidden" : "shown session=" + owner;
            if (state != logged) { logged = state; Log(state + " fg=" + fg.ToInt64()); }
            RECT r;
            if (pick != null && !IsIconic(fg) && GetWindowRect(fg, out r)) {
                if (frames.ContainsKey(pick)) face = pick;
                int x = r.Right - size - 14, y = r.Top + 10;
                if (!Visible) { Show(); shown = null; }
                if (shown != face || x != lastX || y != lastY) {
                    Draw(frames[face], x, y);
                    shown = face; lastX = x; lastY = y;
                }
            } else if (Visible) {
                Hide();
            }
        } catch (Exception ex) {
            Log("error " + ex.Message);
        }
    }

    void Draw(Bitmap bmp, int x, int y) {
        IntPtr screen = GetDC(IntPtr.Zero), mem = CreateCompatibleDC(screen);
        IntPtr hbmp = bmp.GetHbitmap(Color.FromArgb(0)), old = SelectObject(mem, hbmp);
        PT pos = new PT { x = x, y = y }, src = new PT();
        SZ sz = new SZ { cx = bmp.Width, cy = bmp.Height };
        BF blend = new BF { op = 0, flags = 0, alpha = 255, fmt = 1 };
        UpdateLayeredWindow(Handle, screen, ref pos, ref sz, mem, ref src, 0, ref blend, 2);
        SelectObject(mem, old); DeleteObject(hbmp); DeleteDC(mem); ReleaseDC(IntPtr.Zero, screen);
    }
}
"@

[WipeForm]::SetProcessDPIAware() | Out-Null

$loaded = New-Object 'System.Collections.Generic.Dictionary[string,System.Drawing.Bitmap]'
foreach ($file in Get-ChildItem $Frames -Filter *.png) {
    $source = [System.Drawing.Image]::FromFile($file.FullName)
    $bitmap = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.DrawImage($source, 0, 0, $Size, $Size)
    $graphics.Dispose(); $source.Dispose()
    $loaded[$file.BaseName] = $bitmap
}
if (-not $loaded.ContainsKey("neutral")) { throw "neutral.png is missing in $Frames" }
Add-Content -Path $logFile -Value "$(Get-Date -Format s) start frames=$($loaded.Count) size=$Size"

$form = New-Object WipeForm($loaded, $Sessions, $logFile, $Size)
[System.Windows.Forms.Application]::Run()
$mutex.ReleaseMutex()
