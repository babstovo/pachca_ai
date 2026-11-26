using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal sealed partial class PachcaWindow
{
    private readonly WebView2 pachcaWeb = new WebView2 {
        Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(30, 31, 35),
        AccessibleName = "Веб-Пачка"
    };
    private readonly ShellButton panelButton = new ShellButton();
    private SplitContainer panes;
    private readonly string panelWidthFile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "PachcaWebClient", "codex-panel-width.txt");
    private int? preferredPanelWidth;
    private bool draggingPanel;

    private int ReadPanelWidth()
    {
        int width;
        try {
            if (Int32.TryParse(File.ReadAllText(panelWidthFile), out width) && width > 0) return width;
        } catch (IOException) { } catch (UnauthorizedAccessException) { }
        return 368;
    }

    private void RememberPanelWidth(object sender, SplitterEventArgs e)
    {
        if (!draggingPanel) return;
        draggingPanel = false;
        if (panes.Panel2Collapsed || WindowState == FormWindowState.Minimized) return;
        int width = panes.Panel2.Width;
        if (width <= 0 || width == preferredPanelWidth) return;
        preferredPanelWidth = width;
        try {
            Directory.CreateDirectory(Path.GetDirectoryName(panelWidthFile));
            string temp = panelWidthFile + ".tmp";
            File.WriteAllText(temp, width.ToString(System.Globalization.CultureInfo.InvariantCulture));
            if (File.Exists(panelWidthFile)) File.Replace(temp, panelWidthFile, null);
            else File.Move(temp, panelWidthFile);
        } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    private void SetCodexPanel(bool open)
    {
        if (open && panes.Panel2Collapsed) {
            draggingPanel = false;
            if (!preferredPanelWidth.HasValue) preferredPanelWidth = ReadPanelWidth();
            panes.Panel2Collapsed = false;
            RestorePanelWidth();
            RenderCodex();
        } else if (!open) panes.Panel2Collapsed = true;
        UpdateAgentHeader();
    }

    private void UpdateAgentHeader()
    {
        bool open = !panes.Panel2Collapsed;
        string label = "Агент не подключён";
        if (mcpEnabled && (cliLinked || (signedIn && connected))) {
            switch (agentClient) {
                case "codex": label = "Codex"; break;
                case "copilot": label = "GitHub Copilot"; break;
                default: label = "MCP-клиент"; break;
            }
        } else if (String.IsNullOrEmpty(codexState) || (mcpEnabled && checkingSavedAgent) || changingAgent || awaitingHostStatus) {
            label = "Подключение агента...";
        }
        panelButton.BackColor = open ? Color.FromArgb(49, 56, 83) : Soft;
        panelButton.Text = label == "Агент не подключён" ? "Отключён" : label == "Подключение агента..." ? "Подключение…" : "";
        NameShellButton(panelButton,label.TrimEnd('.') + (open ? " · Скрыть панель агента" : " · Открыть панель агента"));
    }

    private void RestorePanelWidth()
    {
        if (draggingPanel || !preferredPanelWidth.HasValue || panes.Panel2Collapsed || WindowState == FormWindowState.Minimized) return;
        int available = panes.ClientSize.Width - panes.SplitterWidth;
        if (available < panes.Panel1MinSize + panes.Panel2MinSize) return;
        int distance = Math.Max(panes.Panel1MinSize, available - Math.Max(panes.Panel2MinSize, preferredPanelWidth.Value));
        if (distance != panes.SplitterDistance) panes.SplitterDistance = distance;
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int length);

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        int dark = 1;
        DwmSetWindowAttribute(Handle, 20, ref dark, sizeof(int));
    }

    private static ContextMenuStrip ShellMenu()
    {
        return new ContextMenuStrip { BackColor = Soft, ForeColor = Ink, ShowImageMargin = false,
            Renderer = new ToolStripProfessionalRenderer(new MenuColors()) };
    }

    private sealed class MenuColors : ProfessionalColorTable
    {
        public override Color ToolStripDropDownBackground { get { return Soft; } }
        public override Color MenuItemSelected { get { return Divider; } }
        public override Color MenuItemBorder { get { return Divider; } }
        public override Color MenuBorder { get { return Divider; } }
        public override Color CheckBackground { get { return Indigo; } }
        public override Color ImageMarginGradientBegin { get { return Soft; } }
        public override Color ImageMarginGradientMiddle { get { return Soft; } }
        public override Color ImageMarginGradientEnd { get { return Soft; } }
    }

    private sealed class AgentMenuRenderer : ToolStripProfessionalRenderer
    {
        public static readonly Color Background = Color.FromArgb(38, 41, 52);
        private readonly Font icons;
        public AgentMenuRenderer(Font icons) : base(new MenuColors()) { this.icons = icons; }

        protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e) { e.Graphics.Clear(Background); }
        protected override void OnRenderImageMargin(ToolStripRenderEventArgs e) { }
        protected override void OnRenderItemCheck(ToolStripItemImageRenderEventArgs e) { }
        protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e)
        {
            using (var pen = new Pen(Divider))
                e.Graphics.DrawLine(pen,0,e.Item.Height/2,e.Item.Width,e.Item.Height/2);
        }
        protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
        {
            var item = (ToolStripMenuItem)e.Item;
            var color = item.Enabled ? Ink : Muted;
            var flags = TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding;
            int width = item.Owner.ClientSize.Width;
            int textLeft = e.TextRectangle.Left;
            TextRenderer.DrawText(e.Graphics,(string)item.Tag,icons,
                new Rectangle(3,0,textLeft-4,item.Height),color,flags);
            TextRenderer.DrawText(e.Graphics,e.Text,e.TextFont,new Rectangle(textLeft,0,width-textLeft-27,item.Height),
                color,TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix | TextFormatFlags.NoPadding);
            if (item.Checked)
                TextRenderer.DrawText(e.Graphics,"\uE73E",icons,new Rectangle(width-29,0,24,item.Height),Accent,flags);
        }
    }

    private class ShellButton : Button
    {
        public string Glyph;
        public Font GlyphFont;
        public ShellButton() { DoubleBuffered = true; }
        public override Size GetPreferredSize(Size proposedSize)
        {
            int size = Font.Height;
            int extra = Text.Length == 0 ? 0 : size / 3 + TextRenderer.MeasureText(Text,Font).Width;
            return new Size(size * 5 / 2 + extra, size * 2);
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            if (Width < 12 || Height < 12) return;
            e.Graphics.Clear(Parent == null ? Surface : Parent.BackColor);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (var path = new GraphicsPath()) {
                const int d = 9;
                path.AddArc(1, 1, d, d, 180, 90);
                path.AddArc(Width-d-2, 1, d, d, 270, 90);
                path.AddArc(Width-d-2, Height-d-2, d, d, 0, 90);
                path.AddArc(1, Height-d-2, d, d, 90, 90);
                path.CloseFigure();
                bool hover = Enabled && ClientRectangle.Contains(PointToClient(MousePosition));
                Color fill = BackColor;
                if (hover) fill = Capture && MouseButtons == MouseButtons.Left ? Divider : ControlPaint.Light(fill, 0.12f);
                using (var brush = new SolidBrush(fill)) e.Graphics.FillPath(brush, path);
                using (var pen = new Pen(Focused && ShowFocusCues ? Accent : Divider)) e.Graphics.DrawPath(pen, path);
            }
            var flags = TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix;
            Color tint = Enabled ? ForeColor : Color.FromArgb(115, 119, 138);
            int iconSize = GlyphFont == null ? Font.Height : GlyphFont.Height;
            int caption = Text.Length == 0 ? 0 : TextRenderer.MeasureText(Text, Font, Size.Empty, flags).Width;
            int gap = caption == 0 ? 0 : Font.Height / 3;
            int left = (Width - iconSize - gap - caption) / 2;
            var icon = new Rectangle(left, (Height-iconSize)/2, iconSize, iconSize);
            if (Glyph != null) TextRenderer.DrawText(e.Graphics, Glyph, GlyphFont, icon, tint, flags);
            else {
                var box = Rectangle.Inflate(icon,-2,-4);
                using (var pen = new Pen(tint,Math.Max(1.5f,iconSize/12f))) {
                    e.Graphics.DrawRectangle(pen,box);
                    int split = box.Left + box.Width * 2 / 3;
                    e.Graphics.DrawLine(pen,split,box.Top,split,box.Bottom);
                }
            }
            if (caption > 0)
                TextRenderer.DrawText(e.Graphics,Text,Font,new Rectangle(icon.Right+gap,0,caption,Height),Ink,flags);
        }
    }

    private async Task OpenWebPachca()
    {
        try {
            if (pachcaWeb.CoreWebView2 == null) {
                var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "PachcaWebClient", "webview2");
                var environment = await CoreWebView2Environment.CreateAsync(null, folder);
                if (exiting || IsDisposed) return;
                await pachcaWeb.EnsureCoreWebView2Async(environment);
                if (exiting || IsDisposed) return;
                pachcaWeb.CoreWebView2.Settings.AreHostObjectsAllowed = false;
                pachcaWeb.CoreWebView2.WebMessageReceived += OpenHtmlAttachment;
                await pachcaWeb.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(EditorResource("HtmlAttachment.js"));
                ConfigurePachcaLinks(pachcaWeb.CoreWebView2, OpenInBrowser);
                pachcaWeb.CoreWebView2.DocumentTitleChanged += (s, e) => UpdateWebTitle();
                await ListenToPachca(pachcaWeb.CoreWebView2);
                pachcaWeb.CoreWebView2.NavigationCompleted += async (s, e) => await ResumeAgent(e.IsSuccess);
            }
            if (pachcaWeb.Source == null || pachcaWeb.Source.Scheme == "about")
                OpenPachcaChat(PachcaOrigin + "/chats");
            pachcaWeb.Visible = true;
            return;
        } catch (Exception error) {
            if (exiting || IsDisposed) return;
            checkingSavedAgent = false;
            UpdateAgentHeader();
            var retry = new LinkLabel { Text = "Не удалось открыть веб-Пачку. Повторить", AutoSize = false,
                Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, LinkColor = Accent, BackColor = Paper,
                AccessibleDescription = error.Message };
            pachcaWeb.Visible = false;
            retry.LinkClicked += async (s, e) => { retry.Dispose(); pachcaWeb.Visible = true; await OpenWebPachca(); };
            panes.Panel1.Controls.Add(retry);
            retry.BringToFront();
        }
    }

    private void UpdateWebTitle()
    {
        string title = pachcaWeb.CoreWebView2 != null ? pachcaWeb.CoreWebView2.DocumentTitle : "";
        Text = String.IsNullOrWhiteSpace(title) ? "Пачка AI" : title + " · Пачка AI";
    }

    private static bool IsPachcaChat(Uri uri)
    {
        return uri != null && uri.GetLeftPart(UriPartial.Authority) == PachcaOrigin &&
            Regex.IsMatch(uri.AbsolutePath, @"^/chats(?:/[0-9]+)?/?$");
    }

    private static bool TryWebLink(string url, out Uri uri)
    {
        return Uri.TryCreate(url, UriKind.Absolute, out uri) &&
            (uri.Scheme == Uri.UriSchemeHttps || uri.Scheme == Uri.UriSchemeHttp);
    }

    private void ConfigurePachcaLinks(CoreWebView2 core, Action<Uri> openInBrowser)
    {
        core.NewWindowRequested += (s, e) => {
            Uri target;
            if (!TryWebLink(e.Uri, out target)) return;
            e.Handled = true;
            if (!e.IsUserInitiated) return;
            if (IsPachcaChat(target)) OpenPachcaChat(target.AbsoluteUri);
            else openInBrowser(target);
        };
        core.NavigationStarting += (s, e) => {
            // Leave sign-in, redirects and history navigation to the web app.
            if (!e.IsUserInitiated || e.IsRedirected || e.NavigationKind != CoreWebView2NavigationKind.NewDocument ||
                !IsPachcaChat(pachcaWeb.Source)) return;
            Uri target;
            if (!TryWebLink(e.Uri, out target)) return;
            if (IsPachcaChat(target)) {
                if (System.Web.HttpUtility.ParseQueryString(target.Query)["noRedirect"] == "1") return;
                e.Cancel = true;
                OpenPachcaChat(target.AbsoluteUri);
            } else {
                e.Cancel = true;
                openInBrowser(target);
            }
        };
    }

    private void OpenInBrowser(Uri target)
    {
        try {
            using (Process.Start(new ProcessStartInfo(target.AbsoluteUri) { UseShellExecute = true })) { }
        } catch (Win32Exception error) {
            MessageBox.Show(this, error.Message, "Не удалось открыть браузер", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private long? WebChatId()
    {
        var uri = pachcaWeb.Source;
        if (uri == null || uri.Scheme != "https" || uri.Host != "app.pachca.com" || !uri.IsDefaultPort) return null;
        var match = Regex.Match(uri.AbsolutePath, @"^/chats/([0-9]+)/?$");
        long id;
        return match.Success && Int64.TryParse(match.Groups[1].Value, out id) && id > 0 ? id : (long?)null;
    }

}
