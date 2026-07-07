<#
.SYNOPSIS
    Paper Trail UIA Companion v1.0 - Native Messaging Host
    Semantic desktop capture for the Paper Trail Chrome extension.

.DESCRIPTION
    Launched by Chrome via Native Messaging (registered as com.papertrail.uia).
    Installs a low-level mouse hook; on each left-click it reads the UI Automation
    element under the cursor (the desktop's "DOM"), captures the foreground window
    with a red ring at the click point, and streams a JSON message to the extension:

        { type:"click", label, kind, app, window, shot(base64 jpeg) }

    Exits automatically when the extension disconnects (stdin closes).
    Compatibility: Windows PowerShell 5.1+ (.NET Framework UIAutomationClient).
#>

$ErrorActionPreference = "Stop"

$Source = @"
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Windows.Automation;

public static class PaperTrailHost
{
    // ── Win32 interop ─────────────────────────────────────────────────────
    private delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll")]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetModuleHandle(string lpModuleName);
    [DllImport("user32.dll")]
    private static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int x; public int y; }
    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    private struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData; public uint flags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    private struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; }

    private const int WH_MOUSE_LL = 14;
    private const int WM_LBUTTONUP = 0x0202;

    private static IntPtr _hookId = IntPtr.Zero;
    private static HookProc _proc = HookCallback;   // rooted: prevents GC of the delegate
    private static Stream _stdout;
    private static readonly object _writeLock = new object();
    private static long _lastClickTicks = 0;

    // ── Hook ──────────────────────────────────────────────────────────────
    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0 && wParam == (IntPtr)WM_LBUTTONUP)
        {
            // Debounce double-fire; keep the callback itself instantaneous.
            long now = DateTime.UtcNow.Ticks;
            if (now - Interlocked.Read(ref _lastClickTicks) > TimeSpan.TicksPerMillisecond * 180)
            {
                Interlocked.Exchange(ref _lastClickTicks, now);
                MSLLHOOKSTRUCT info = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
                int x = info.pt.x, y = info.pt.y;
                ThreadPool.QueueUserWorkItem(delegate { ProcessClick(x, y); });
            }
        }
        return CallNextHookEx(_hookId, nCode, wParam, lParam);
    }

    // ── Click processing: UIA element + annotated screenshot ─────────────
    private static void ProcessClick(int x, int y)
    {
        try
        {
            string label = "", kind = "control", app = "", winTitle = "", autoId = "", className = "";

            try
            {
                AutomationElement el = AutomationElement.FromPoint(new System.Windows.Point(x, y));
                if (el != null)
                {
                    label = el.Current.Name ?? "";
                    autoId = el.Current.AutomationId ?? "";
                    className = el.Current.ClassName ?? "";
                    ControlType ct = el.Current.ControlType;
                    if (ct != null) kind = ct.ProgrammaticName.Replace("ControlType.", "").ToLowerInvariant();

                    // Unlabeled element: walk up a few ancestors for a name.
                    if (string.IsNullOrEmpty(label))
                    {
                        TreeWalker walker = TreeWalker.ControlViewWalker;
                        AutomationElement p = el;
                        for (int i = 0; i < 3 && string.IsNullOrEmpty(label); i++)
                        {
                            p = walker.GetParent(p);
                            if (p == null) break;
                            label = p.Current.Name ?? "";
                        }
                    }
                }
            }
            catch { /* elevated windows / UIA denial: fall through with what we have */ }

            IntPtr fg = GetForegroundWindow();
            StringBuilder sb = new StringBuilder(256);
            GetWindowText(fg, sb, 256);
            winTitle = sb.ToString();
            uint pid;
            GetWindowThreadProcessId(fg, out pid);
            try { app = Process.GetProcessById((int)pid).ProcessName; } catch { }

            if (label.Length > 80) label = label.Substring(0, 79) + "\u2026";
            string shot = CaptureWindow(fg, x, y);

            Send("{\"type\":\"click\"" +
                 ",\"label\":\"" + J(label) + "\"" +
                 ",\"kind\":\"" + J(kind) + "\"" +
                 ",\"app\":\"" + J(app) + "\"" +
                 ",\"window\":\"" + J(winTitle) + "\"" +
                 ",\"autoId\":\"" + J(autoId) + "\"" +
                 ",\"className\":\"" + J(className) + "\"" +
                 (shot != null ? ",\"shot\":\"" + shot + "\"" : "") + "}");
        }
        catch { /* never let a click kill the host */ }
    }

    private static string CaptureWindow(IntPtr hwnd, int clickX, int clickY)
    {
        try
        {
            RECT r;
            if (hwnd == IntPtr.Zero || !GetWindowRect(hwnd, out r)) return null;
            int w = Math.Max(1, r.Right - r.Left), h = Math.Max(1, r.Bottom - r.Top);
            if (w < 40 || h < 40) return null;

            using (Bitmap bmp = new Bitmap(w, h))
            {
                using (Graphics g = Graphics.FromImage(bmp))
                    g.CopyFromScreen(r.Left, r.Top, 0, 0, new Size(w, h));

                // Downscale to <=1100px wide
                double scale = Math.Min(1.0, 1100.0 / w);
                int ow = (int)(w * scale), oh = (int)(h * scale);
                using (Bitmap outBmp = new Bitmap(ow, oh))
                {
                    using (Graphics og = Graphics.FromImage(outBmp))
                    {
                        og.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        og.DrawImage(bmp, 0, 0, ow, oh);

                        // Red ring at the click point (window-relative)
                        float px = (float)((clickX - r.Left) * scale);
                        float py = (float)((clickY - r.Top) * scale);
                        if (px >= 0 && py >= 0 && px <= ow && py <= oh)
                        {
                            float rad = Math.Max(12f, ow * 0.018f);
                            using (Pen pen = new Pen(Color.FromArgb(255, 255, 71, 87), Math.Max(3f, ow * 0.004f)))
                                og.DrawEllipse(pen, px - rad, py - rad, rad * 2, rad * 2);
                            using (Pen pen2 = new Pen(Color.FromArgb(90, 255, 71, 87), Math.Max(2f, ow * 0.003f)))
                                og.DrawEllipse(pen2, px - rad * 1.8f, py - rad * 1.8f, rad * 3.6f, rad * 3.6f);
                        }
                    }

                    using (MemoryStream ms = new MemoryStream())
                    {
                        ImageCodecInfo jpeg = GetEncoder(ImageFormat.Jpeg);
                        EncoderParameters ep = new EncoderParameters(1);
                        ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 65L);
                        outBmp.Save(ms, jpeg, ep);
                        byte[] bytes = ms.ToArray();
                        // Native messaging caps host->Chrome messages at 1 MB.
                        if (bytes.Length > 700000) return null;
                        return Convert.ToBase64String(bytes);
                    }
                }
            }
        }
        catch { return null; }
    }

    private static ImageCodecInfo GetEncoder(ImageFormat format)
    {
        foreach (ImageCodecInfo c in ImageCodecInfo.GetImageDecoders())
            if (c.FormatID == format.Guid) return c;
        return null;
    }

    // ── Native messaging protocol (4-byte LE length + UTF-8 JSON) ─────────
    private static string J(string s)
    {
        if (s == null) return "";
        StringBuilder b = new StringBuilder(s.Length + 8);
        foreach (char c in s)
        {
            if (c == '"') b.Append("\\\"");
            else if (c == '\\') b.Append("\\\\");
            else if (c < ' ') b.Append("\\u").Append(((int)c).ToString("x4"));
            else b.Append(c);
        }
        return b.ToString();
    }

    private static void Send(string json)
    {
        byte[] body = Encoding.UTF8.GetBytes(json);
        byte[] len = BitConverter.GetBytes(body.Length);
        lock (_writeLock)
        {
            _stdout.Write(len, 0, 4);
            _stdout.Write(body, 0, body.Length);
            _stdout.Flush();
        }
    }

    // ── Entry point ───────────────────────────────────────────────────────
    public static void Run()
    {
        _stdout = Console.OpenStandardOutput();

        // stdin monitor: Chrome closes the pipe when the extension disconnects.
        Thread stdinThread = new Thread(delegate ()
        {
            try
            {
                Stream stdin = Console.OpenStandardInput();
                byte[] hdr = new byte[4];
                while (true)
                {
                    int read = stdin.Read(hdr, 0, 4);
                    if (read <= 0) break;
                    int n = BitConverter.ToInt32(hdr, 0);
                    if (n <= 0 || n > 1048576) break;
                    byte[] buf = new byte[n];
                    int off = 0;
                    while (off < n)
                    {
                        int r = stdin.Read(buf, off, n - off);
                        if (r <= 0) { off = -1; break; }
                        off += r;
                    }
                    if (off < 0) break;
                    // Incoming messages (pings) are ignored in v1.
                }
            }
            catch { }
            Environment.Exit(0);
        });
        stdinThread.IsBackground = true;
        stdinThread.Start();

        Send("{\"type\":\"hello\",\"host\":\"paper-trail-uia\",\"version\":\"1.0\"}");

        _hookId = SetWindowsHookEx(WH_MOUSE_LL, _proc, GetModuleHandle(null), 0);
        if (_hookId == IntPtr.Zero)
        {
            Send("{\"type\":\"error\",\"message\":\"Failed to install mouse hook\"}");
            return;
        }

        // Message pump — required for the low-level hook to receive events.
        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
        UnhookWindowsHookEx(_hookId);
    }
}
"@

Add-Type -TypeDefinition $Source -ReferencedAssemblies @(
    "UIAutomationClient", "UIAutomationTypes", "WindowsBase",
    "System.Drawing", "System.Windows.Forms"
) -Language CSharp

[PaperTrailHost]::Run()
