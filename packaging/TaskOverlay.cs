using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;

internal sealed partial class PachcaWindow
{
    private TaskOverlay taskOverlay;
    private readonly string overlayDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PachcaWebClient");
    private OverlayPreferences overlayPreferences;

    private sealed class OverlayPreferences
    {
        public bool AutoOpen { get; set; }
        public bool InBrowser { get; set; }
        public int[] Bounds { get; set; }

        public OverlayPreferences() { AutoOpen = true; }

        public Rectangle SavedBounds()
        {
            if (Bounds == null || Bounds.Length != 4 || Bounds[2] <= 0 || Bounds[3] <= 0 ||
                (long)Bounds[0] + Bounds[2] > int.MaxValue || (long)Bounds[1] + Bounds[3] > int.MaxValue)
                return Rectangle.Empty;
            return new Rectangle(Bounds[0], Bounds[1], Bounds[2], Bounds[3]);
        }
    }

    private OverlayPreferences OverlayOptions
    {
        get {
            if (overlayPreferences != null) return overlayPreferences;
            try {
                overlayPreferences = json.Deserialize<OverlayPreferences>(File.ReadAllText(Path.Combine(overlayDirectory, "task-overlay.json")));
            } catch (IOException) { } catch (UnauthorizedAccessException) { }
              catch (ArgumentException) { } catch (InvalidOperationException) { } catch (FormatException) { } catch (OverflowException) { }
            if (overlayPreferences == null) {
                // Earlier builds stored only an opt-out marker.
                overlayPreferences = new OverlayPreferences { AutoOpen = !File.Exists(Path.Combine(overlayDirectory, "task-overlay-hidden")) };
            }
            return overlayPreferences;
        }
    }

    private void SaveOverlayOptions(bool autoOpen, bool inBrowser, Rectangle bounds, bool allowSessionFallback = false)
    {
        var options = new OverlayPreferences { AutoOpen = autoOpen, InBrowser = inBrowser,
            Bounds = bounds.IsEmpty ? null : new[] { bounds.X, bounds.Y, bounds.Width, bounds.Height } };
        try {
            Directory.CreateDirectory(overlayDirectory);
            string path = Path.Combine(overlayDirectory, "task-overlay.json");
            string temp = path + ".tmp";
            File.WriteAllText(temp, json.Serialize(options));
            if (File.Exists(path)) File.Replace(temp, path, null);
            else File.Move(temp, path);
        } catch (IOException) { if (!allowSessionFallback) throw; }
          catch (UnauthorizedAccessException) { if (!allowSessionFallback) throw; }
        overlayPreferences = options;
    }

    private void RememberOverlayBounds(Rectangle bounds)
    {
        var options = OverlayOptions;
        if (options.SavedBounds() == bounds || bounds.Width <= 0 || bounds.Height <= 0) return;
        SaveOverlayOptions(options.AutoOpen, options.InBrowser, bounds, allowSessionFallback: true);
    }

    private void SetOverlayAutoOpen(bool enabled)
    {
        var options = OverlayOptions;
        if (options.AutoOpen == enabled) return;
        SaveOverlayOptions(enabled, options.InBrowser, options.SavedBounds(), allowSessionFallback: true);
        if (settingsWindow != null) settingsWindow.PublishState();
    }

    private void ResetOverlayOptions()
    {
        SaveOverlayOptions(true, false, Rectangle.Empty);
        if (taskOverlay != null) taskOverlay.RestoreBoundsFromSettings();
    }

    private void RestoreTaskOverlay()
    {
        if (taskOverlay == null && taskProfile != null && Visible && WindowState != FormWindowState.Minimized && OverlayOptions.AutoOpen)
            ShowTaskOverlay(false);
    }

    private void SetTaskProfile(object profile)
    {
        if (Equals(taskProfile, profile)) return;
        taskProfile = profile;
        if (taskOverlay != null) taskOverlay.ResetProfile();
        else RestoreTaskOverlay();
    }

    private void OpenTaskOverlay()
    {
        if (exiting || signingOut) return;
        SetOverlayAutoOpen(true);
        ShowTaskOverlay(true);
    }

    private void ShowTaskOverlay(bool activate)
    {
        if (exiting || signingOut) return;
        if (taskOverlay == null) {
            taskOverlay = new TaskOverlay(this);
            taskOverlay.FormClosed += (s, e) => {
                RememberOverlayBounds(taskOverlay.Bounds);
                taskOverlay = null;
            };
            // An unowned tool window stays visible when the main window goes to the tray.
            taskOverlay.Show();
        } else if (activate && taskOverlay.Visible) {
            taskOverlay.Activate();
        }
    }

    private sealed class TaskOverlay : ResourceWindow
    {
        private int generation;
        private Point gestureStart;
        private Rectangle gestureBounds;
        private bool resizing;
        private readonly List<Rectangle> wheelGaps = new List<Rectangle>();
        private readonly MouseHook wheelCallback;
        private IntPtr wheelHook;
        private const int WmMouseWheel = 0x020A, WmMouseHWheel = 0x020E, GapWheel = 0x8000 + 87;
        private delegate IntPtr MouseHook(int code, IntPtr message, IntPtr details);

        [DllImport("user32.dll")] private static extern IntPtr SetWindowsHookEx(int kind, MouseHook callback, IntPtr module, uint thread);
        [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr details);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string name);
        [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr window, int message, IntPtr wparam, IntPtr lparam);
        [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(Point point);
        [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
        [DllImport("user32.dll")] private static extern bool PhysicalToLogicalPointForPerMonitorDPI(IntPtr window, ref Point point);

        protected override bool ShowWithoutActivation { get { return true; } }

        public TaskOverlay(PachcaWindow app)
            : base(app, "Мои задачи · OpenProject", "TaskOverlay.html", transparent: true)
        {
            wheelCallback = RouteGapWheel;
            FormBorderStyle = FormBorderStyle.None;
            Region = new Region(Rectangle.Empty);
            ShowInTaskbar = false;
            MaximizeBox = MinimizeBox = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            MinimumSize = new Size(210, 106);
            RestoreBoundsFromSettings();
        }

        public void RestoreBoundsFromSettings()
        {
            Rectangle saved = app.OverlayOptions.SavedBounds();
            var area = (saved.IsEmpty ? Screen.FromControl(app) : Screen.FromRectangle(saved)).WorkingArea;
            int width = Math.Min(saved.IsEmpty ? 785 : Math.Max(MinimumSize.Width, saved.Width), area.Width);
            int height = Math.Min(saved.IsEmpty ? 126 : Math.Max(MinimumSize.Height, saved.Height), area.Height);
            int left = saved.IsEmpty ? area.Left + (area.Width - width) / 2 : saved.Left;
            int top = saved.IsEmpty ? area.Top + 6 : saved.Top;
            Bounds = FitToArea(new Rectangle(left, top, width, height), area);
        }

        protected override CreateParams CreateParams
        {
            get {
                var parameters = base.CreateParams;
                parameters.ExStyle |= 0x00200000; // WS_EX_NOREDIRECTIONBITMAP: compose WebView over the desktop.
                return parameters;
            }
        }

        private static Rectangle FitToArea(Rectangle bounds, Rectangle area)
        {
            int width = Math.Min(bounds.Width, area.Width), height = Math.Min(bounds.Height, area.Height);
            return new Rectangle(Math.Max(area.Left, Math.Min(bounds.Left, area.Right - width)),
                Math.Max(area.Top, Math.Min(bounds.Top, area.Bottom - height)), width, height);
        }

        // The native region also defines mouse hit testing, including across processes.
        private void ShapeWindow(Dictionary<string, object> data)
        {
            double width = Convert.ToDouble(Get(data, "width")), height = Convert.ToDouble(Get(data, "height"));
            if (width <= 0 || height <= 0) return;
            double scaleX = ClientSize.Width / width, scaleY = ClientSize.Height / height;
            var shape = new Region(Rectangle.Empty);
            wheelGaps.Clear();
            foreach (IList box in (IList)Get(data, "boxes")) {
                var rect = Rectangle.FromLTRB((int)Math.Round(Convert.ToDouble(box[0]) * scaleX),
                    (int)Math.Round(Convert.ToDouble(box[1]) * scaleY), (int)Math.Round(Convert.ToDouble(box[2]) * scaleX),
                    (int)Math.Round(Convert.ToDouble(box[3]) * scaleY));
                if (rect.Width <= 0 || rect.Height <= 0) continue;
                if (Equals(box[4], "gap")) wheelGaps.Add(rect);
                else if (Equals(box[4], "round")) {
                    using (var circle = new GraphicsPath()) { circle.AddEllipse(rect); shape.Union(circle); }
                } else shape.Union(rect);
            }
            // Windows normally sends the wheel through a hole in the window, along with clicks.
            // Listen only while there are scrollable gaps. Leave their native click hit test untouched.
            if (wheelGaps.Count == 0) StopGapWheel();
            else if (wheelHook == IntPtr.Zero) {
                wheelHook = SetWindowsHookEx(14, wheelCallback, GetModuleHandle(null), 0);
                if (wheelHook == IntPtr.Zero) foreach (var gap in wheelGaps) shape.Union(gap);
            }
            Region = shape;
        }

        private IntPtr RouteGapWheel(int code, IntPtr message, IntPtr details)
        {
            int kind = (int)message;
            if (code >= 0 && (kind == WmMouseWheel || kind == WmMouseHWheel) && !Capture && (ModifierKeys & Keys.Control) == 0) {
                var point = new Point(Marshal.ReadInt32(details), Marshal.ReadInt32(details, 4));
                PhysicalToLogicalPointForPerMonitorDPI(Handle, ref point);
                Point local = PointToClient(point);
                foreach (var gap in wheelGaps) {
                    if (!gap.Contains(local)) continue;
                    // A covered or cloaked overlay must leave the wheel with the visible application.
                    var neighbor = PointToScreen(new Point(gap.Left - 1, local.Y));
                    if (GetAncestor(WindowFromPoint(neighbor), 2) != Handle) break;
                    int delta = Marshal.ReadInt32(details, 8) >> 16;
                    if (PostMessage(Handle, GapWheel, (IntPtr)(kind == WmMouseWheel ? -delta : delta), IntPtr.Zero))
                        return (IntPtr)1;
                    break;
                }
            }
            return CallNextHookEx(wheelHook, code, message, details);
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == GapWheel) {
                Post(new { type = "gap-wheel", ticks = (int)m.WParam / 120.0, lines = SystemInformation.MouseWheelScrollLines });
                return;
            }
            base.WndProc(ref m);
        }

        private void StopGapWheel()
        {
            if (wheelHook == IntPtr.Zero) return;
            UnhookWindowsHookEx(wheelHook);
            wheelHook = IntPtr.Zero;
        }

        protected override void OnHandleDestroyed(EventArgs e)
        {
            StopGapWheel();
            base.OnHandleDestroyed(e);
        }

        private void StartGesture(bool resize, Dictionary<string, object> data)
        {
            if ((Control.MouseButtons & MouseButtons.Left) == 0) return;
            resizing = resize;
            gestureStart = Cursor.Position;
            gestureBounds = Bounds;
            double viewport = Convert.ToDouble(Get(data, "viewport"));
            if (!resize && viewport > 0) {
                double scale = ClientSize.Width / viewport;
                gestureStart.Offset(-(int)Math.Round(Convert.ToDouble(Get(data, "dx")) * scale),
                    -(int)Math.Round(Convert.ToDouble(Get(data, "dy")) * scale));
            }
            Capture = true;
            ApplyGesture();
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            if (!Capture || (e.Button & MouseButtons.Left) == 0) return;
            ApplyGesture();
        }

        private void ApplyGesture()
        {
            Point cursor = Cursor.Position;
            var delta = new Size(cursor.X - gestureStart.X, cursor.Y - gestureStart.Y);
            if (resizing) {
                var area = Screen.FromRectangle(gestureBounds).WorkingArea;
                Size = new Size(Math.Min(area.Right - Left, Math.Max(MinimumSize.Width, gestureBounds.Width + delta.Width)),
                    Math.Min(area.Bottom - Top, Math.Max(MinimumSize.Height, gestureBounds.Height + delta.Height)));
            } else {
                Bounds = FitToArea(new Rectangle(gestureBounds.Location + delta, gestureBounds.Size), Screen.FromPoint(cursor).WorkingArea);
            }
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            if (e.Button == MouseButtons.Left) Capture = false;
        }

        protected override void OnMouseCaptureChanged(EventArgs e)
        {
            base.OnMouseCaptureChanged(e);
            if (Capture || gestureBounds.IsEmpty) return;
            if (Bounds != gestureBounds) app.RememberOverlayBounds(Bounds);
            gestureBounds = Rectangle.Empty;
        }

        public void ResetProfile()
        {
            generation++;
            PublishContext();
        }

        private void PublishContext()
        {
            Post(new { type = "context", generation, available = app.taskProfile != null });
        }

        protected override async Task Receive(string json)
        {
            var data = app.json.Deserialize<Dictionary<string, object>>(json);
            string action = Get(data, "action") as string;
            if (action == "ready") { PublishContext(); return; }
            if (action == "shape") { ShapeWindow(data); return; }
            if (action == "close") {
                app.SetOverlayAutoOpen(false);
                BeginInvoke((Action)Close);
                return;
            }
            if (action == "move" || action == "resize") { StartGesture(action == "resize", data); return; }
            int requested = Convert.ToInt32(Get(data, "generation"));
            if (requested != generation || app.taskProfile == null || app.signingOut || app.exiting) return;
            if (action == "open-task") {
                long id;
                if (!long.TryParse(Convert.ToString(Get(data, "id")), out id) || id <= 0) return;
                BeginInvoke((Action)(() => {
                    if (IsDisposed || !Visible || requested != generation || app.exiting || app.signingOut) return;
                    if (app.OverlayOptions.InBrowser) {
                        Uri taskUrl;
                        if (Uri.TryCreate(Get(data, "url") as string, UriKind.Absolute, out taskUrl) &&
                            taskUrl.Scheme == Uri.UriSchemeHttps && taskUrl.UserInfo.Length == 0 &&
                            taskUrl.AbsolutePath == "/work_packages/" + id.ToString(CultureInfo.InvariantCulture)) app.OpenInBrowser(taskUrl);
                        return;
                    }
                    Hide();
                    try {
                        app.ShowWindow();
                        app.OpenTaskBoard(id, Get(data, "account_id"));
                    } finally {
                        if (!IsDisposed && !app.exiting) { Show(); ResetProfile(); }
                    }
                }));
                return;
            }
            if (action != "list") return;
            try {
                var result = await app.Request("desktop-task-board", new { profile_id = app.taskProfile,
                    offset = Get(data, "offset"), account_id = Get(data, "account_id"), closed = false });
                if (requested == generation) Post(new { type = "page", generation, result });
            } catch (Exception ex) {
                if (requested == generation) Post(new { type = "page", generation, error = ex.Message });
            }
        }
    }
}
