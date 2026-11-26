using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.Serialization;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("Пачка AI")]
[assembly: System.Reflection.AssemblyProduct("Пачка AI")]

internal sealed partial class PachcaWindow : Form
{
    private static readonly Color Ink = Color.FromArgb(229, 231, 240), Paper = Color.FromArgb(29, 30, 34),
        Indigo = Color.FromArgb(72, 84, 249), Soft = Color.FromArgb(42, 44, 52), Surface = Color.FromArgb(30, 31, 35),
        Accent = Color.FromArgb(151, 162, 255), Muted = Color.FromArgb(164, 169, 189), Divider = Color.FromArgb(50, 54, 68);
    private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 18 * 1024 * 1024 };

    private readonly Label feedback = new Label();
    private readonly List<string> dialogue = new List<string>();
    private string openProjectTaskView;
    private string lookupToken;
    private readonly HashSet<string> shownPanelNotes = new HashSet<string>();
    private readonly List<MessageRow> codexMessages = new List<MessageRow>();
    private readonly EditorDraft guidance = new EditorDraft();
    private readonly ShellButton tasksButton = new ShellButton();
    private readonly Font iconFont = new Font("Segoe MDL2 Assets", 13);
    private readonly ToolTip iconTips = new ToolTip();
    private AgentSettingsWindow settingsWindow;
    private object settingsProfile;
    private int settingsRevision;
    private readonly ContextMenuStrip codexMenu;
    private readonly System.Windows.Forms.Timer poll = new System.Windows.Forms.Timer { Interval = 1300 };
    private readonly NotifyIcon tray = new NotifyIcon();
    private readonly EventWaitHandle reopen;
    private Question[] pending = new Question[0];
    private Question selectedQuestion;
    private readonly HashSet<string> notifiedQuestions = new HashSet<string>(StringComparer.Ordinal);
    private string notificationQuestionKey;
    private DateTime nextNotification;
    private bool openNotifiedQuestion;
    private object taskProfile;
    private Process worker;
    private ToolStripItem trayTasks, trayBoard;
    private volatile string workerError;
    private bool busy, generating, exiting, connected,
        signedIn, signingOut, lastAutoReply;
    private int accountGeneration;
    private DateTime codexCheckAt;
    private bool checkingCodex, connectingCodex;
    private bool questionsOnly;
    private bool confirmationRequired = true;
    private string codexState = "";

    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length == 4 && args[0] == "--apply-portable-update") { FinishPortableUpdate(args); return; }
        var name = @"Local\PachcaCodexDesktop-" + Environment.UserName;
        bool first;
        using (var instanceLock = new Mutex(true, name, out first))
        using (var show = new EventWaitHandle(false, EventResetMode.AutoReset, name + "-show"))
        {
            if (!first) { show.Set(); return; }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (var window = new PachcaWindow(show)) Application.Run(window);
        }
    }

    private PachcaWindow(EventWaitHandle reopenSignal)
    {
        reopen = reopenSignal;
        Text = "Пачка AI";
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        Font = new Font("Segoe UI", 10);
        BackColor = Paper;
        ForeColor = Ink;
        StartPosition = FormStartPosition.CenterScreen;
        Size = new Size(1280, 800);
        MinimumSize = new Size(950, 650);
        AutoScaleMode = AutoScaleMode.Font;

        var layout = Grid(1, 2, Paper);
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        var toolbar = Grid(5, 1, Surface);
        toolbar.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        toolbar.Padding = new Padding(13, 0, 10, 0);
        toolbar.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        toolbar.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        toolbar.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        toolbar.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        toolbar.Controls.Add(Heading("Пачка AI"), 0, 0);
        toolbar.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        AddUpdateButton(toolbar);
        ConfigureShellButton(tasksButton, "\uE930", "Мои задачи", Color.FromArgb(175, 153, 255));
        tasksButton.Enabled = false;
        tasksButton.Click += (s, e) => OpenTaskOverlay();
        ConfigureShellButton(activityButton, "\uE77F", "Журнал агента", Color.FromArgb(53, 201, 156));
        activityButton.Click += (s,e) => OpenActivity();
        toolbar.Controls.Add(activityButton, 2, 0);
        toolbar.Controls.Add(tasksButton, 3, 0);
        ConfigureShellButton(panelButton, null, "Открыть панель агента", Color.FromArgb(128, 151, 255));
        panelButton.Click += (s, e) => SetCodexPanel(panes.Panel2Collapsed);
        toolbar.Controls.Add(panelButton, 4, 0);
        layout.Controls.Add(toolbar, 0, 0);

        var content = new SplitContainer { Dock = DockStyle.Fill, BackColor = Divider, SplitterWidth = 2, FixedPanel = FixedPanel.Panel2 };
        panes = content;
        panes.SplitterMoving += (s, e) => draggingPanel = true;
        panes.SplitterMoved += RememberPanelWidth;
        panes.SizeChanged += (s, e) => RestorePanelWidth();
        layout.Controls.Add(content, 0, 1);
        Controls.Add(layout);
        content.Panel1.Controls.Add(pachcaWeb);

        var right = Grid(1, 3, Surface);
        right.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        right.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        right.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        var codexHeader = Grid(3, 1, Surface);
        codexHeader.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        codexHeader.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        codexHeader.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        codexHeader.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        var title = Heading("Агент");
        title.Padding = new Padding(12, 0, 0, 0);
        title.AutoEllipsis = true;
        codexHeader.Controls.Add(title, 0, 0);
        var preferences = new ShellButton();
        ConfigureShellButton(preferences, "\uE713", "Настройки агента", Ink);
        preferences.Click += (s, e) => OpenAgentSettings();
        codexHeader.Controls.Add(preferences, 1, 0);
        var codexMenuButton = new ShellButton();
        ConfigureShellButton(codexMenuButton, "\uE712", "Меню чата Codex", Muted);
        codexMenuButton.Margin = new Padding(0, 6, 10, 6);
        codexMenu = CreateCodexMenu();
        codexMenu.Opened += (s,e) => codexMenuButton.BackColor = Divider;
        codexMenu.Closed += (s,e) => codexMenuButton.BackColor = Soft;
        codexMenuButton.ContextMenuStrip = codexMenu;
        codexMenuButton.Click += (s, e) => codexMenu.Show(codexMenuButton,
            new Point(codexMenuButton.Width, codexMenuButton.Height), ToolStripDropDownDirection.BelowLeft);
        codexHeader.Controls.Add(codexMenuButton, 2, 0);
        right.Controls.Add(codexHeader, 0, 0);
        guidance.PasteError += message => feedback.Text = message;
        InstallPanelEditor(right);
        content.Panel2.Controls.Add(right);
        SetCodexPanel(false);
        RenderCodex();

        var menu = ShellMenu();
        menu.Items.Add("Открыть Пачку AI", null, (s, e) => ShowWindow());
        trayTasks = menu.Items.Add("Мои задачи", null, (s, e) => OpenTaskOverlay());
        trayBoard = menu.Items.Add("Доска OpenProject", null, (s, e) => { ShowWindow(); OpenTaskBoard(); });
        menu.Items.Add("Журнал агента", null, (s,e) => { ShowWindow(); OpenActivity(); });
        menu.Items.Add("Рассказать о себе", null, (s, e) => { ShowWindow(); OpenAgentSettings("profile"); });
        menu.Items.Add("Выход", null, async (s, e) => await ExitApp());
        tray.Icon = Icon;
        tray.Text = "Пачка AI";
        tray.ContextMenuStrip = menu;
        tray.Visible = true;
        tray.DoubleClick += (s, e) => ShowWindow();
        tray.BalloonTipClicked += (s, e) => {
            if (exiting || signingOut) return;
            if (activityBalloon && taskBalloonChat.HasValue) {
                try {
                    using (Process.Start(new ProcessStartInfo("codex://threads/"+taskBalloonChat.Value.ToString("D")) { UseShellExecute=true })) { }
                } catch (Exception ex) { MessageBox.Show(this,ex.Message,"Не удалось открыть Codex"); }
                return;
            }
            ShowWindow();
            if (activityBalloon) { OpenActivity(); return; }
            openNotifiedQuestion = true;
            OpenNotifiedQuestion();
        };
        FormClosing += (s, e) => {
            if (!exiting && e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; Hide(); }
        };
        FormClosed += (s, e) => { if (taskOverlay != null) taskOverlay.Close(); };
        bool wasMinimized = false;
        Resize += (s, e) => {
            bool minimized = WindowState == FormWindowState.Minimized;
            if (wasMinimized && !minimized) RestoreTaskOverlay();
            wasMinimized = minimized;
        };
        poll.Tick += async (s, e) => await Task.WhenAll(RefreshState(), CheckLocalCodex(), RefreshUnreadBadge());
        Shown += async (s, e) => {
            UpdateSend();
            poll.Start();
            await OpenWebPachca();
            await CheckLocalCodex();
        };
    }

    private static Label Heading(string text) { return new Label { Text = text, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, Font = new Font("Segoe UI Semibold", 12) }; }

    private static TableLayoutPanel Grid(int columns, int rows, Color color)
    {
        return new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = columns, RowCount = rows, Margin = Padding.Empty, BackColor = color };
    }

    private sealed class Draft
    {
        public string Text;
        public ClipboardImage[] Images;
        public string[] EncodeImages() { return Images.Select(image => Convert.ToBase64String(image.Png)).ToArray(); }
        public byte[][] Previews() { return Images.Select(image => image.Preview).ToArray(); }
    }

    private sealed class ClipboardImage
    {
        public byte[] Png, Preview;
    }

    private sealed class EditorDraft
    {
        public const int MaxLength = 16000;
        public bool Enabled = true;
        public readonly List<ClipboardImage> Images = new List<ClipboardImage>();

        public event Action<string> PasteError = delegate { };
        public string Text = "";

        public Draft Snapshot() { return new Draft { Text = Text, Images = Images.ToArray() }; }

        public void SetDraft(Draft draft)
        {
            Images.Clear();
            if (draft != null) Images.AddRange(draft.Images);
            Text = draft == null ? "" : draft.Text;
        }

        public void AddImage(Image image)
        {
            if (Images.Count >= 3) { PasteError("В одном сообщении можно добавить до трёх картинок."); return; }
            if ((long)image.Width * image.Height > 25000000) { PasteError("Слишком большие размеры картинки."); return; }
            using (var encoded = new MemoryStream()) {
                image.Save(encoded, ImageFormat.Png);
                if (encoded.Length > 4 * 1024 * 1024) { PasteError("Картинка должна занимать не больше 4 МБ."); return; }
                var size = FitImage(image.Size, new Size(180, 120));
                using (var preview = new Bitmap(size.Width, size.Height))
                using (var canvas = Graphics.FromImage(preview))
                using (var thumbnail = new MemoryStream()) {
                    canvas.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    canvas.DrawImage(image, new Rectangle(Point.Empty, size));
                    preview.Save(thumbnail, ImageFormat.Png);
                    Images.Add(new ClipboardImage { Png = encoded.ToArray(), Preview = thumbnail.ToArray() });
                }
            }
            PasteError("");
        }

    }

    private static Size FitImage(Size source, Size limits)
    {
        double scale = Math.Min(1, Math.Min((double)limits.Width / source.Width, (double)limits.Height / source.Height));
        return new Size(Math.Max(1, (int)(source.Width * scale)), Math.Max(1, (int)(source.Height * scale)));
    }

    private static void ConfigureText(TextBox box, string label, bool readOnly)
    {
        box.AccessibleName = label;
        box.Multiline = true;
        box.ReadOnly = readOnly;
        box.Dock = DockStyle.Fill;
        box.ScrollBars = ScrollBars.Vertical;
        box.BackColor = Paper;
        box.ForeColor = Ink;
    }

    private static void DecorateButton(Button button, string text, bool primary)
    {
        button.Text = text;
        button.Dock = DockStyle.Fill;
        button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.BorderSize = 0;
        button.BackColor = primary ? Indigo : Soft;
        button.ForeColor = primary ? Color.White : Ink;
    }

    private void ConfigureShellButton(ShellButton button, string glyph, string name, Color color)
    {
        DecorateButton(button, "", false);
        button.Glyph = glyph;
        button.GlyphFont = iconFont;
        button.ForeColor = color;
        button.AutoSize = true;
        button.AutoSizeMode = AutoSizeMode.GrowAndShrink;
        button.Margin = new Padding(0, 6, 8, 6);
        button.Cursor = Cursors.Hand;
        NameShellButton(button,name);
    }

    private void NameShellButton(ShellButton button, string name)
    {
        if (button.AccessibleName == name) return;
        button.AccessibleName = name;
        iconTips.SetToolTip(button,name);
    }

    private static ProcessStartInfo Node(string command)
    {
        var app = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app");
        var encoding = new UTF8Encoding(false);
        var info = new ProcessStartInfo {
            FileName = Path.Combine(app, "node.exe"), Arguments = "--disable-warning=ExperimentalWarning \"" + Path.Combine(app, "pachca.mjs") + "\" " + command,
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true,
            RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = encoding, StandardErrorEncoding = encoding
        };
        info.EnvironmentVariables["PACHCA_PORTABLE"] = "1";
        info.EnvironmentVariables["PACHCA_INSTALL_ROOT"] = PortableInstall.Root;
        return info;
    }

    private async Task<Dictionary<string, object>> Request(string command, object input)
    {
        using (var child = Process.Start(Node(command)))
        {
            var output = child.StandardOutput.ReadToEndAsync();
            var error = child.StandardError.ReadToEndAsync();
            var bytes = Encoding.UTF8.GetBytes(json.Serialize(input));
            await child.StandardInput.BaseStream.WriteAsync(bytes, 0, bytes.Length);
            child.StandardInput.Close();
            var result = await output;
            var failure = await error;
            await Task.Run(() => child.WaitForExit());
            if (child.ExitCode != 0) throw new InvalidOperationException(failure.Trim());
            return json.Deserialize<Dictionary<string, object>>(result);
        }
    }

    private static object Get(Dictionary<string, object> data, string key)
    {
        object value;
        return data != null && data.TryGetValue(key, out value) ? value : null;
    }

    private async Task RefreshState()
    {
        if (reopen.WaitOne(0)) ShowWindow();
        if (busy || exiting || signingOut) return;
        busy = true;
        int generation = accountGeneration;
        int revision = settingsRevision;
        try {
            var response = await Request("desktop-state", new { });
            if (exiting || signingOut || generation != accountGeneration) return;
            awaitingHostStatus = false;
            var state = Get(response, "status") as Dictionary<string, object>;
            bool attached = Equals(Get(state, "desktop_host"),true) && worker != null && !worker.HasExited &&
                Convert.ToInt64(Get(state,"profile_id")) == hostProfile && mcpEnabled;
            bool online = attached && Equals(Get(state, "connected"), true);
            if (attached && historyProfile != hostProfile) LoadPanelHistory(hostProfile);
            settingsProfile = attached ? Get(state, "profile_id") : null;
            signedIn = settingsProfile != null;
            connected = online;
            RefreshTaskProfile();
            if (online) workerError = null;
            tray.Text = online ? "Пачка AI · подключено" : "Пачка AI";
            if (revision == settingsRevision && (settingsWindow == null || !settingsWindow.Writing)) {
                lastAutoReply = Equals(Get(state, "auto_reply"), true);
                confirmationRequired = !Equals(Get(state, "confirmation_required"), false);
            }
            var rows = Get(response, "questions") as IList;
            if (attached) {
                var notes = (Get(state,"panel_notes") as IList ?? new object[0]).Cast<Dictionary<string,object>>().ToArray();
                shownPanelNotes.IntersectWith(notes.Select(item => Convert.ToString(Get(item,"id"))));
                foreach (var item in notes) {
                    string id = Convert.ToString(Get(item,"id"));
                    if (shownPanelNotes.Add(id)) AddCodexMessage("Агент",Convert.ToString(Get(item,"text")),false,noteId:id);
                }
            }
            if (attached && rows != null) RenderQuestions(rows);
            if (attached && rows != null) NotifyAboutQuestions(pending.Where(q => !q.IsDraft).ToArray());
            UpdateActivity(attached ? Get(state,"activity") as Dictionary<string,object> : null);
            OpenNotifiedQuestion();
            if (exiting || signingOut || generation != accountGeneration) return;
            UpdateSend();
        } catch (Exception error) {
            if (exiting || signingOut || generation != accountGeneration) return;
            awaitingHostStatus = false;
            connected = false;
            workerError = error.Message;
            UpdateActivity(null);
            UpdateSend();
        } finally { busy = false; }
    }

    private void SetCodexState(string state)
    {
        codexState = state;
        UpdateSend();
    }

    private async Task CheckLocalCodex()
    {
        if (exiting || checkingCodex || connectingCodex || DateTime.UtcNow < codexCheckAt) return;
        checkingCodex = true;
        int generation = accountGeneration;
        UpdateSend();
        try {
            var result = await Request("desktop-codex-status", new { });
            if (!exiting && !changingAgent && !signingOut && generation == accountGeneration) {
                mcpEnabled = Equals(Get(result,"mcp_enabled"),true);
                agentClient = Get(result,"client") as string ?? "codex";
                clientFile = Get(result,"file") as string;
                cliLinked = Equals(Get(result,"cli_link"),true);
                if (!mcpEnabled && worker != null && !worker.HasExited) WriteHost(worker,new { @event = "stop" });
                SetCodexState(Convert.ToString(Get(result, "state")));
            }
        } catch (Exception) {
            if (!exiting) SetCodexState("error");
        } finally {
            checkingCodex = false;
            codexCheckAt = String.IsNullOrEmpty(codexState) ? DateTime.MinValue : DateTime.UtcNow.AddSeconds(40);
            if (!exiting) UpdateSend();
        }
    }

    private async Task ConnectLocalCodex()
    {
        if (connectingCodex || exiting) return;
        connectingCodex = true;
        feedback.Text = "Если откроется браузер, завершите вход в Codex.";
        UpdateSend();
        try {
            var result = await Request("desktop-codex-connect", new { });
            if (exiting) return;
            SetCodexState(Convert.ToString(Get(result, "state")));
            feedback.Text = "";
            if (codexState == "missing") {
                string detail = Get(result, "detail") as string ?? "Пачка не нашла Codex на этом компьютере.";
                if (MessageBox.Show(this, detail + "\n\nОткрыть страницу установки Codex?", "Подключение агента",
                    MessageBoxButtons.YesNo, MessageBoxIcon.Information) == DialogResult.Yes) OpenCodexDownload();
                throw new InvalidOperationException(detail);
            }
        } catch (Exception error) {
            if (!exiting) {
                SetCodexState("error");
                feedback.Text = error.Message;
            }
            throw;
        } finally {
            connectingCodex = false;
            codexCheckAt = DateTime.UtcNow.AddSeconds(codexState == "missing" ? 5 : 40);
            if (!exiting) UpdateSend();
        }
    }

    private void OpenCodexDownload()
    {
        try {
            using (Process.Start("https://chatgpt.com/download/")) { }
            feedback.Text = "Установите Codex, затем вернитесь в Пачка AI.";
            codexCheckAt = DateTime.UtcNow.AddSeconds(5);
        } catch (Exception error) { feedback.Text = error.Message; }
    }

    private bool? EditOpenProjectKey(IWin32Window owner, bool configured, string boardUrl, object profile)
    {
        using (var dialog = new Form { Text = "Подключение OpenProject", Icon = Icon, Font = Font, ForeColor = Ink, BackColor = Paper,
            ClientSize = new Size(530, 270), MinimumSize = new Size(490, 309), StartPosition = FormStartPosition.CenterParent, ShowInTaskbar = false }) {
            var grid = Grid(3, 7, Paper);
            grid.Padding = new Padding(12);
            for (int i = 0; i < 3; i++) grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f / 3));
            grid.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
            grid.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
            grid.RowStyles.Add(new RowStyle(SizeType.Absolute, 32));
            grid.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
            grid.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
            grid.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            grid.RowStyles.Add(new RowStyle(SizeType.Absolute, 36));
            var addressTitle = new Label { Dock = DockStyle.Fill, Text = "Ссылка на доску OpenProject из адресной строки браузера" };
            var address = new TextBox { Dock = DockStyle.Fill, BackColor = Soft, ForeColor = Ink,
                AccessibleName = "Ссылка на доску", Text = boardUrl ?? "" };
            var state = new Label { Dock = DockStyle.Fill, ForeColor = configured ? Accent : Muted,
                Text = configured ? "Сохранённый ключ   ••••••••••••" : "Ключ ещё не сохранён" };
            var title = new Label { Dock = DockStyle.Fill,
                Text = configured ? "Вставьте новый ключ для замены" : "API-ключ для вашего сервера OpenProject" };
            var input = new TextBox { Dock = DockStyle.Fill, BackColor = Soft, ForeColor = Ink,
                AccessibleName = title.Text, UseSystemPasswordChar = true, MaxLength = 256 };
            var notice = new Label { Dock = DockStyle.Fill, ForeColor = Muted };
            grid.Controls.Add(state, 0, 0);
            grid.SetColumnSpan(state, 3);
            grid.Controls.Add(addressTitle, 0, 1);
            grid.SetColumnSpan(addressTitle, 3);
            grid.Controls.Add(address, 0, 2);
            grid.SetColumnSpan(address, 3);
            grid.Controls.Add(title, 0, 3);
            grid.SetColumnSpan(title, 3);
            grid.Controls.Add(input, 0, 4);
            grid.SetColumnSpan(input, 3);
            grid.Controls.Add(notice, 0, 5);
            grid.SetColumnSpan(notice, 3);
            var cancel = new Button { DialogResult = DialogResult.Cancel };
            var remove = new Button();
            var save = new Button();
            DecorateButton(cancel, "Отмена", false);
            DecorateButton(remove, "Удалить ключ", false);
            DecorateButton(save, "Проверить и сохранить", true);
            grid.Controls.Add(cancel, 0, 6);
            grid.Controls.Add(remove, 1, 6);
            grid.Controls.Add(save, 2, 6);
            dialog.CancelButton = cancel;
            dialog.Controls.Add(grid);
            bool working = false;
            bool? result = null;
            Action refresh = () => {
                address.Enabled = input.Enabled = cancel.Enabled = !working;
                remove.Enabled = configured && !working;
                save.Enabled = !working && !string.IsNullOrWhiteSpace(address.Text) && !string.IsNullOrWhiteSpace(input.Text);
            };
            Func<bool, Task> change = async removeKey => {
                working = true;
                refresh();
                notice.Text = removeKey ? "Удаляю сохранённый ключ…" : "Проверяю доступ…";
                try {
                    var response = removeKey ? await Request("desktop-openproject-remove-key", new { profile_id = profile }) :
                        await Request("desktop-openproject-key", new { profile_id = profile, boardUrl = address.Text.Trim(), key = input.Text.Trim() });
                    input.Clear();
                    result = Equals(Get(response, "configured"), true);
                    SetBoardKeyProfile(result == true ? profile : null, true);
                    working = false;
                    dialog.DialogResult = DialogResult.OK;
                } catch (Exception error) { notice.Text = error.Message; }
                finally { working = false; refresh(); }
            };
            address.TextChanged += (s, e) => refresh();
            input.TextChanged += (s, e) => refresh();
            dialog.FormClosing += (s, e) => { if (working) e.Cancel = true; };
            save.Click += async (s, e) => await change(false);
            remove.Click += async (s, e) => await change(true);
            refresh();
            dialog.ShowDialog(owner);
            return result;
        }
    }

    private async Task<bool> DisconnectAgent()
    {
        if ((!signedIn && !cliLinked) || changingAgent || signingOut || generating || exiting) return false;
        if (HasDraft(guidance) &&
            MessageBox.Show(settingsWindow, "Черновик в панели агента будет очищен. Отключить агента?", "Пачка AI",
                MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return false;
        signingOut = true;
        accountGeneration++;
        UpdateSend();
        try {
            try { await Request("desktop-agent-disable", new {}); }
            finally {
                mcpEnabled = false;
                cliLinked = false;
                if (worker != null && !worker.HasExited) WriteHost(worker,new { @event = "stop" });
                ClearAgentSession();
                SetCodexPanel(false);
            }
            return true;
        } finally {
            signingOut = false;
            UpdateSend();
        }
    }

    private void ClearAgentSession()
    {
        UpdateActivity(null);
        historyProfile = 0;
        awaitingHostStatus = false;
        signedIn = connected = false;
        workerError = null;
        guidance.SetDraft(null);
        feedback.Text = "";
        pending = new Question[0];
        notifiedQuestions.Clear();
        notificationQuestionKey = null;
        nextNotification = DateTime.MinValue;
        openNotifiedQuestion = false;
        questionsOnly = false;
        confirmationRequired = true;
        SetQuestion(null, false);
        codexMessages.Clear();
        dialogue.Clear();
        openProjectTaskView = null;
        lookupToken = null;
        shownPanelNotes.Clear();
        RenderCodex();
        settingsProfile = null;
        RefreshTaskProfile();
        lastAutoReply = false;
    }

    private static bool HasDraft(EditorDraft box) { return box.Images.Count > 0 || !string.IsNullOrWhiteSpace(box.Text); }
    [DataContract]
    private sealed class MessageRow
    {
        [DataMember] public string Author, Text, NoteId;
        [DataMember(EmitDefaultValue = false)] public string Kind;
        public Question PendingQuestion;
        [DataMember] public DateTime? Date;
        [DataMember] public bool Owner;
        public string PanelId, HistoryFile;
        [DataMember] public byte[][] Previews;
        [DataMember] public List<PanelLink> Links;
    }

    private sealed class Question
    {
        public bool IsDraft;
        public string Key, Text, Incoming, ChatTitle, Author;
        public long ChatId, MessageId;
        public DateTime Received;
    }

    private void RenderQuestions(IList rows)
    {
        var next = rows.Cast<Dictionary<string, object>>().Select(row => {
            var target = Get(row, "destination") as Dictionary<string, object>;
            var messages = Get(row, "messages") as IList;
            var source = messages != null && messages.Count > 0 ? messages[0] as Dictionary<string, object> : null;
            long chatId = Convert.ToInt64(Get(source, "chat_id"));
            var key = Convert.ToString(Get(row, "key"));
            var saved = pending.FirstOrDefault(question => question.Key == key);
            bool isDraft = Equals(Get(row, "status"), "draft");
            return new Question { Key = key, IsDraft = isDraft, Text = Convert.ToString(Get(row, isDraft ? "reply" : "question")), Incoming = Convert.ToString(Get(row, "incoming_text")),
                ChatId = chatId, MessageId = Convert.ToInt64(Get(source, "id")), Received = saved == null ? DateTime.Now : saved.Received,
                ChatTitle = Convert.ToString(Get(target, "title") ?? ("Чат №" + chatId)), Author = Convert.ToString(Get(target, "author")) };
        }).OrderBy(question => question.MessageId).ToArray();
        if (pending.Length == next.Length && pending.Zip(next, (a, b) =>
            a.Key == b.Key && a.IsDraft == b.IsDraft && a.ChatTitle == b.ChatTitle && a.Author == b.Author && a.Text == b.Text && a.Incoming == b.Incoming).All(equal => equal)) {
            if (!generating && selectedQuestion != null && !pending.Any(item => item.Key == selectedQuestion.Key))
                SetQuestion(null, false);
            return;
        }
        pending = next;
        if (selectedQuestion != null && !generating)
            SetQuestion(pending.FirstOrDefault(item => item.Key == selectedQuestion.Key), false);
        RenderCodex();
    }

    private void NotifyAboutQuestions(Question[] questions)
    {
        if (exiting || signingOut || DateTime.UtcNow < nextNotification) return;
        if (notifiedQuestions.Count >= 500) {
            var existingKeys = new HashSet<string>(pending.Select(item => item.Key), StringComparer.Ordinal);
            notifiedQuestions.IntersectWith(existingKeys);
        }
        var unseen = questions.Where(item => !string.IsNullOrEmpty(item.Key) && notifiedQuestions.Add(item.Key)).ToArray();
        if (unseen.Length == 0) return;
        notificationQuestionKey = unseen.Length == 1 ? unseen[0].Key : null;
        string chat = unseen.Length == 1 ? unseen[0].ChatTitle.Trim() : "";
        if (chat.Length > 100) chat = chat.Substring(0, 97) + "…";
        tray.BalloonTipTitle = "Пачка AI · Codex ждёт ответа";
        activityBalloon = false;
        tray.BalloonTipText = unseen.Length > 1 ? "Новых вопросов: " + unseen.Length + ". Нажмите, чтобы открыть список." :
            chat.Length > 0 ? "Вопрос из чата «" + chat + "». Нажмите, чтобы ответить." : "Нажмите, чтобы открыть вопрос.";
        tray.BalloonTipIcon = ToolTipIcon.Info;
        nextNotification = DateTime.UtcNow.AddSeconds(6);
        tray.ShowBalloonTip(6000);
    }

    private void OpenNotifiedQuestion()
    {
        if (!openNotifiedQuestion || generating || signingOut || exiting) return;
        SetCodexPanel(true);
        openNotifiedQuestion = false;
        var question = pending.FirstOrDefault(item => item.Key == notificationQuestionKey);
        bool holdsOtherDraft = (panelEditor.ContainsFocus || HasDraft(guidance)) && (selectedQuestion == null || selectedQuestion.Key != notificationQuestionKey);
        if (question != null && !holdsOtherDraft) {
            SetQuestion(question);
        } else {
            questionsOnly = true;
            RenderCodex();
        }

    }

    private void SetQuestion(Question question, bool focus = true)
    {
        if (generating && focus) return;
        selectedQuestion = question;
        UpdatePanelEditor();
        if (focus) {
            if (question != null && questionsOnly) { questionsOnly = false; RenderCodex(); }
            FocusPanelEditor();
        }
    }

    private ContextMenuStrip CreateCodexMenu()
    {
        var menu = ShellMenu();
        menu.BackColor = AgentMenuRenderer.Background;
        menu.ShowImageMargin = true;
        menu.Renderer = new AgentMenuRenderer(iconFont);
        var menuFont = new Font("Segoe UI Semibold", 10);
        menu.Font = menuFont;
        menu.Disposed += (s,e) => menuFont.Dispose();
        var dialogueView = new ToolStripMenuItem("Вся переписка") { Tag = "\uE8F2" };
        dialogueView.Click += (s, e) => { questionsOnly = false; RenderCodex(); };
        menu.Items.Add(dialogueView);
        var questionsView = new ToolStripMenuItem("Вопросы Codex") { Tag = "\uE897" };
        questionsView.Click += (s, e) => { questionsOnly = true; RenderCodex(); };
        menu.Items.Add(questionsView);
        menu.Items.Add(new ToolStripSeparator());
        var dismiss = new ToolStripMenuItem("Снять выбранный вопрос") { Tag = "\uE8BB" };
        dismiss.Click += async (s, e) => await DismissQuestion(selectedQuestion);
        menu.Items.Add(dismiss);
        menu.MinimumSize = new Size(TextRenderer.MeasureText(dismiss.Text,menuFont).Width + 78,0);
        foreach (var item in menu.Items.OfType<ToolStripMenuItem>())
            item.Padding = new Padding(0, 8, 0, 8);
        menu.Opening += (s, e) => {
            dialogueView.Checked = !questionsOnly;
            questionsView.Checked = questionsOnly;
            dismiss.Enabled = selectedQuestion != null && connected && !generating && !signingOut;
        };
        return menu;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) {
            iconTips.Dispose();
            iconFont.Dispose();
            if (codexMenu != null && !codexMenu.IsDisposed) {
                codexMenu.Close();
                codexMenu.Dispose();
            }
        }
        base.Dispose(disposing);
    }

    private async Task DismissQuestion(Question question)
    {
        if (question == null || !connected || generating || signingOut) return;
        generating = true;
        UpdateSend();
        try {
            var result = await Request("desktop-dismiss-question", new { key = question.Key });
            if (!Equals(Get(result, "dismissed"), true)) throw new InvalidOperationException("Не удалось пропустить вопрос.");
            RemoveQuestion(question);
            AddCodexMessage("Codex", "Вопрос пропущен.", false, kind:"status");
        } catch (Exception error) { feedback.Text = error.Message; }
        finally { generating = false; UpdateSend(); }
    }

    private async Task ReviewIncomingDraft(Question draft, bool send)
    {
        if (!connected || generating || signingOut || settingsProfile == null)
            throw new InvalidOperationException("Дождитесь подключения агента и завершения текущей операции.");
        int generation = accountGeneration;
        generating = true;
        UpdateSend();
        try {
            var result = await Request("desktop-review-draft", new { profile_id = settingsProfile, key = draft.Key,
                action = send ? "send" : "dismiss", expected = draft.Text });
            if (generation != accountGeneration || exiting) return;
            RemoveQuestion(draft);
            string note = send ? "Отправлено в «" + Get(result, "recipient") + "»\n" + draft.Text : "Черновик пропущен.";
            AddCodexMessage("Агент", note, false, kind:"status");
        } finally { generating = false; UpdateSend(); }
    }

    private void RemoveQuestion(Question question)
    {
        pending = pending.Where(item => item.Key != question.Key).ToArray();
        if (selectedQuestion != null && selectedQuestion.Key == question.Key) SetQuestion(null, false);
    }

    private void RenderCodex()
    {
        panelRevision++;
        UpdatePanelEditor();
    }

    private void AddCodexMessage(string author, string text, bool owner, byte[][] previews = null, List<PanelLink> links = null, string noteId = null, string kind = null)
    {
        if (links == null || links.Count == 0) {
            links = new List<PanelLink>();
            foreach (var url in Regex.Matches(text ?? "", @"https://app\.pachca\.com/chats(?:/\d+)?(?:\?[\w%=&-]+)?")
                .Cast<Match>().Select(m => m.Value).Distinct().Take(12)) {
                string target = url;
                string label = url.Contains("sidebar_message=") || url.Contains("message=") ? "Открыть сообщение" :
                    url.Contains("thread_message_id=") ? "Открыть тред" : "Открыть чат";
                links.Add(ChatLink(label,target));
            }
        }
        var row = new MessageRow { Author = author, Text = text, Owner = owner, Date = DateTime.Now, Previews = previews, Links = links, NoteId = noteId,
            Kind = kind ?? (noteId != null ? "status" : owner ? "owner" : "reply") };
        codexMessages.Add(row);
        SavePanelMessage(row);
        if (streamRequest != null) EditorPost(new { type = "item", id = streamRequest, row = PanelItem(row) });
        if (codexMessages.Count > PanelHistoryLimit) codexMessages.RemoveAt(0);
        RenderCodex();
    }

    private void OpenPachcaChat(string url)
    {
        Uri uri;
        if (!Uri.TryCreate(url, UriKind.Absolute, out uri) || !IsPachcaChat(uri) || pachcaWeb.CoreWebView2 == null) return;
        // Pachca's "Open in browser" flag also applies to direct chat and thread links.
        var query = System.Web.HttpUtility.ParseQueryString(uri.Query);
        query.Remove("noRedirect");
        query.Add("noRedirect", "1");
        var target = new UriBuilder(uri) { Query = query.ToString() };
        pachcaWeb.CoreWebView2.Navigate(target.Uri.AbsoluteUri);
    }

    private List<PanelLink> LookupLinks(Dictionary<string,object> plan, string[] images)
    {
        var links = new List<PanelLink>();
        foreach (Dictionary<string,object> source in Get(plan,"sources") as IList ?? new object[0]) {
            string url = Convert.ToString(Get(source,"url"));
            links.Add(ChatLink(Convert.ToString(Get(source,"label")), url));
        }
        string token = Get(plan,"lookup_token") as string;
        foreach (Dictionary<string,object> choice in Get(plan,"lookup_choices") as IList ?? new object[0]) {
            string label = Convert.ToString(Get(choice,"label"));
            long chat = Convert.ToInt64(Get(choice,"chat_id"));
            int index = Convert.ToInt32(Get(choice,"index"));
            links.Add(new PanelLink {Label = label, Url = chat > 0 ? PachcaOrigin + "/chats/" + chat : null, Open = async () => {
                if (chat > 0) OpenPachcaChat(PachcaOrigin + "/chats/" + chat);
                if (!CanDelegate || token != lookupToken) return;
                generating = true;
                UpdateSend();
                try {
                    var result = await Request("desktop-compose-read", new {token,index,images});
                    lookupToken = Get(result,"lookup_token") as string;
                    var sources = Get(result,"sources") as IList;
                    if (sources != null && sources.Count == 1)
                        OpenPachcaChat(Convert.ToString(Get(sources[0] as Dictionary<string,object>,"url")));
                    else if (chat == 0 && Get(result,"chat_id") != null) OpenPachcaChat(PachcaOrigin + "/chats/" + Get(result,"chat_id"));
                    string note = Convert.ToString(Get(result,"note"));
                    bool isStatus = false;
                    if (Get(result,"candidates") is IList) {
                        Dictionary<string,object> next;
                        string recipient;
                        bool sent = ShowComposeResult(result,out next,out recipient,images);
                        while (next != null && Get(next,"candidates") is IList)
                            sent = ShowComposeResult(next,out next,out recipient,images);
                        isStatus = next == null || Equals(Get(next,"skipped"),true);
                        note = next != null ? Convert.ToString(Get(next,"note")) : sent ? "Сообщение отправлено." : "Действие отменено.";
                    }
                    AddCodexMessage("Codex",note,false,null,LookupLinks(result,images),kind:isStatus ? "status" : "reply");
                    dialogue.Add("Вы\n"+label);
                    dialogue.Add("Codex\n"+note);
                    if (dialogue.Count > 12) dialogue.RemoveRange(0,dialogue.Count-12);
                } catch (Exception ex) { AddCodexMessage("Codex",ex.Message,false,kind:"error"); }
                finally { generating = false; UpdateSend(); }
            }});
        }
        return links;
    }

    private void UpdateSend()
    {
        UpdateAgentHeader();
        guidance.Enabled = !generating && !signingOut;
        UpdatePanelEditor();
        tasksButton.Enabled = trayTasks.Enabled = trayBoard.Enabled = taskProfile != null && !signingOut;
        if (settingsWindow != null) settingsWindow.PublishState();
    }

    private async Task DelegateAnswer()
    {
        if (!CanDelegate || !HasDraft(guidance)) return;
        var draft = guidance.Snapshot();
        var input = draft.Text.Trim();
        var images = draft.EncodeImages();
        var question = selectedQuestion;
        long? chatId = WebChatId();
        generating = true;
        feedback.Text = "";
        UpdateSend();
        AddCodexMessage("Вы", input, true, draft.Previews());
        guidance.SetDraft(null);
        try {
            Dictionary<string,object> plan;
            try {
                plan = await Request("desktop-compose", new { text = input, images, chat_id = chatId,
                    question_key = question == null ? null : question.Key, dialog = dialogue.ToArray(), openproject_task_view = openProjectTaskView, lookup_token = lookupToken });
            } catch {
                guidance.SetDraft(draft);
                throw;
            }
            lookupToken = Get(plan, "lookup_token") as string;
            string sentTo = "";
            bool sent = false;
            while (Get(plan, "candidates") is IList) {
                if (Equals(Get(plan, "auto_send"), true) && !Equals(Get(plan, "lookup"), true)) {
                    var result = await Request("desktop-compose-send", new { token = Get(plan, "token"), index = 0,
                        text = Get(plan, "draft"), skip_confirmation = true });
                    if (Get(result,"candidates") is IList) { plan = result; continue; }
                    if (Equals(Get(result,"owner_question"),true)) { plan = result; break; }
                    sentTo = SentRecipient(result);
                    sent = true;
                    break;
                }
                Dictionary<string, object> next;
                sent = ShowComposeResult(plan, out next, out sentTo, images);
                if (next == null) break;
                plan = next;
            }
            if (question != null && Equals(Get(plan, "dismissed_question"), true))
                RemoveQuestion(question);
            var note = Convert.ToString(Get(plan, "note"));
            var taskView = Get(plan, "openproject_task_view") as string;
            if (taskView != null) openProjectTaskView = taskView;
            var statusChange = Get(plan, "openproject_change") as Dictionary<string, object>;
            if (statusChange != null) note = await ConfirmOpenProjectStatus(statusChange);
            if (sent) note = sentTo.Length > 0 ? "Сообщение отправлено. Получатель — " + sentTo + "." : "Сообщение отправлено.";
            if (sent && Get(plan, "attachment_name") is string) note += " Вложение — " + Get(plan, "attachment_name") + ".";
            bool isStatus = sent || statusChange != null || Equals(Get(plan,"skipped"),true) || Equals(Get(plan, "dismissed_question"), true) || note.Length == 0;
            if (note.Length == 0) note = "Действие отменено.";
            if (question == null || !Equals(Get(plan, "answers_question"), true)) {
                dialogue.Add("Вы\n" + input + (images.Length > 0 ? "\n[Были приложены картинки]" : ""));
                dialogue.Add("Codex\n" + note);
                if (dialogue.Count > 12) dialogue.RemoveRange(0, dialogue.Count - 12);
            }
            AddCodexMessage("Codex", note, false, null, LookupLinks(plan,images), kind:isStatus ? "status" : "reply");
        } catch (Exception error) {
            AddCodexMessage("Codex", error.Message, false, kind:"error");
            if (question == null) {
                dialogue.Add("Вы\n" + input);
                dialogue.Add("Codex\n" + error.Message);
                if (dialogue.Count > 12) dialogue.RemoveRange(0, dialogue.Count - 12);
            }
        } finally {
            generating = false;
            UpdateSend();
            if (Visible) FocusPanelEditor();
        }
    }

    private async Task<string> ConfirmOpenProjectStatus(Dictionary<string, object> change)
    {
        var changes = ((IList)Get(change, "changes")).Cast<Dictionary<string, object>>();
        var warnings = (Get(change, "warnings") as IList ?? new object[0]).Cast<object>().Select(item => Convert.ToString(item)).ToArray();
        var lines = changes.Select(item => "№" + Convert.ToString(Get(item, "id")) + " " + Convert.ToString(Get(item, "subject")) + "\n" +
            Convert.ToString(Get(item, "current")) + " → " + Convert.ToString(Get(item, "next")));
        var description = string.Join("\n\n", lines);
        if (warnings.Length > 0) description += "\n\nОстальные задачи\n" + string.Join("\n", warnings);
        description += "\n\nПрименить изменения в OpenProject?";
        if (MessageBox.Show(this, description, "Подтвердить смену статуса", MessageBoxButtons.YesNo,
            MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) != DialogResult.Yes) return "Изменение статусов отменено.";
        var result = await Request("desktop-openproject-status", new { token = Get(change, "token") });
        var updated = ((IList)Get(result, "updated")).Cast<Dictionary<string, object>>()
            .Select(item => "№" + Convert.ToString(Get(item, "id")) + " · " + Convert.ToString(Get(item, "status")));
        var failed = ((IList)Get(result, "failed")).Cast<Dictionary<string, object>>()
            .Select(item => "№" + Convert.ToString(Get(item, "id")) + " · " + Convert.ToString(Get(item, "error")));
        return string.Join("\n", updated.Concat(failed).Concat(warnings));
    }

    private bool ShowComposeResult(Dictionary<string, object> plan, out Dictionary<string, object> next, out string recipient, string[] images)
    {
        Dictionary<string, object> followup = null;
        string sentTo = "";
        var candidates = Get(plan, "candidates") as IList;
        bool canSend = candidates != null && candidates.Count > 0;
        bool lookup = Equals(Get(plan, "lookup"), true);
        string changed = Get(plan,"context_changed") as string;
        using (var dialog = new Form { Text = lookup ? "Выбрать переписку" : "Проверить сообщение", Icon = Icon,
            Font = Font, ForeColor = Ink, BackColor = Paper, ClientSize = new Size(630, canSend ? 455 : 340),
            MinimumSize = new Size(480, 290), StartPosition = FormStartPosition.CenterParent, ShowInTaskbar = false }) {
            var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(16), ColumnCount = 1, RowCount = 7 };
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, canSend ? 28 : 0));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, canSend ? 110 : 0));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, canSend ? 27 : 0));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, canSend && !lookup ? 29 : 0));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 40));
            var recipients = new ListBox { Dock = DockStyle.Fill, IntegralHeight = false, BackColor = Paper, AccessibleName = "Получатель" };
            if (canSend) {
                layout.Controls.Add(new Label { Text = changed == null ? "Выберите получателя" : "Новые сообщения · " +
                    Convert.ToString(Get(candidates[0] as Dictionary<string,object>,"label")), Dock = DockStyle.Fill }, 0, 0);
                foreach (Dictionary<string, object> candidate in candidates) {
                    string type = Equals(Get(candidate, "type"), "user") ? "Личные сообщения" : "Чат";
                    recipients.Items.Add(type + " · " + Convert.ToString(Get(candidate, "label")) + " · №" + Convert.ToString(Get(candidate, "id")));
                }
                if (changed == null) layout.Controls.Add(recipients, 0, 1);
                else {
                    var context = new TextBox { Text = changed };
                    ConfigureText(context,"Новые сообщения",true);
                    layout.Controls.Add(context,0,1);
                }
                string attachmentName = Get(plan, "attachment_name") as string;
                string caption = attachmentName == null ? "Сообщение в Пачку (можно изменить)" : "Вложение — " + attachmentName;
                layout.Controls.Add(new Label { Text = lookup ? "Что прочитает Codex" : caption, Dock = DockStyle.Fill }, 0, 2);
            }
            var editor = new TextBox { Text = Convert.ToString(Get(plan, canSend ? "draft" : "note")), MaxLength = 16000 };
            ConfigureText(editor, lookup ? "Что прочитает Codex" : "Сообщение в Пачку", lookup);
            layout.Controls.Add(editor, 0, 3);
            var notice = new Label { Dock = DockStyle.Fill, AutoEllipsis = true };
            layout.Controls.Add(notice, 0, 4);
            var remember = new CheckBox { Text = "Больше не спрашивать, если получатель один", Dock = DockStyle.Fill,
                Checked = !confirmationRequired };
            if (canSend && !lookup && changed == null) layout.Controls.Add(remember, 0, 5);
            int count = changed == null ? 2 : 3;
            var buttons = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = count };
            for (int i=0;i<count;i++) buttons.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100f/count));
            var cancel = new Button { DialogResult = DialogResult.Cancel };
            var confirm = new Button();
            DecorateButton(cancel, changed != null ? "Пропустить" : canSend ? "Отмена" : "Закрыть", false);
            DecorateButton(confirm, changed != null ? "Отправить как есть" : lookup ? "Прочитать переписку" : "Отправить выбранному", changed == null);
            var revise = new Button();
            if (changed != null) {
                DecorateButton(revise,"Учесть новую реплику",true);
                buttons.Controls.Add(revise,0,0);
            }
            buttons.Controls.Add(cancel, changed == null ? 0 : 2, 0);
            if (canSend) buttons.Controls.Add(confirm, 1, 0);
            layout.Controls.Add(buttons, 0, 6);
            dialog.Controls.Add(layout);
            dialog.CancelButton = cancel;
            bool sendingNow = false;
            bool used = false;
            Action update = () => confirm.Enabled = canSend && !used && !sendingNow && recipients.SelectedIndex >= 0 && !string.IsNullOrWhiteSpace(editor.Text);
            recipients.SelectedIndexChanged += (s, e) => {
                update();
                if (!lookup && recipients.SelectedIndex >= 0) {
                    var target = candidates[recipients.SelectedIndex] as Dictionary<string, object>;
                    notice.Text = "Получатель — " + Convert.ToString(Get(target, "label"));
                }
            };
            editor.TextChanged += (s, e) => update();
            if (canSend && candidates.Count == 1) recipients.SelectedIndex = 0;
            update();
            dialog.FormClosing += (s, e) => { if (sendingNow && e.CloseReason == CloseReason.UserClosing) e.Cancel = true; };
            Func<string,Task> submit = async contextAction => {
                if (sendingNow || used) return;
                sendingNow = true;
                recipients.Enabled = editor.Enabled = cancel.Enabled = remember.Enabled = revise.Enabled = false;
                notice.Text = contextAction == "skip" ? "Пропускаю…" : contextAction == "revise" ? "Обновляю черновик…" : lookup ? "Codex читает переписку…" : "Отправляю…";
                update();
                try {
                    var result = await Request(lookup ? "desktop-compose-read" : "desktop-compose-send",
                        new { token = Get(plan, "token"), index = recipients.SelectedIndex, text = editor.Text,
                            images = lookup ? images : null, context_action = contextAction,
                            remember_no_confirm = !lookup && changed == null && remember.Checked });
                    if (lookup || contextAction == "skip" || Get(result,"candidates") is IList || Equals(Get(result,"owner_question"),true)) followup = result;
                    else sentTo = SentRecipient(result);
                    sendingNow = false;
                    dialog.DialogResult = DialogResult.OK;
                } catch (Exception error) {
                    notice.Text = error.Message;
                    used = true;
                    sendingNow = false;
                    cancel.Enabled = true;
                    update();
                }
            };
            confirm.Click += async (s,e) => await submit(null);
            revise.Click += async (s,e) => await submit("revise");
            if (changed != null) {
                cancel.DialogResult = DialogResult.None;
                cancel.Click += async (s,e) => { if (used) dialog.DialogResult = DialogResult.Cancel; else await submit("skip"); };
            }
            var accepted = dialog.ShowDialog(this) == DialogResult.OK;
            next = followup;
            recipient = sentTo;
            return accepted && !lookup && followup == null;
        }
    }

    private string SentRecipient(Dictionary<string, object> result)
    {
        if (!Equals(Get(result, "accepted"), true)) throw new InvalidOperationException("Проверьте журнал перед повтором.");
        string answeredKey = Get(result, "answered_question_key") as string;
        if (selectedQuestion != null && selectedQuestion.Key == answeredKey)
            RemoveQuestion(selectedQuestion);
        if (Get(result, "confirmation_required") is bool)
            confirmationRequired = Equals(Get(result, "confirmation_required"), true);
        return Convert.ToString(Get(result, "recipient"));
    }

    private void ShowWindow()
    {
        Show();
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        RestorePanelWidth();
        Activate();
        RestoreTaskOverlay();
    }

    private async Task ExitApp(Action beforeClose = null)
    {
        if (exiting || signingOut || changingAgent) return;
        if (generating) { ShowWindow(); feedback.Text = "Дождитесь результата отправки или поручения."; return; }
        exiting = true;
        poll.Stop();
        try {
            if (worker != null && !worker.HasExited) {
                WriteHost(worker,new { @event = "stop" });
                worker.StandardInput.Close();
                await Task.Run(() => worker.WaitForExit(5000));
            }
            if (beforeClose != null) beforeClose();
        } catch (Exception error) {
            exiting = false;
            poll.Start();
            ShowWindow();
            feedback.Text = "Не удалось остановить наблюдение. " + error.Message;
            return;
        }
        tray.Visible = false;
        tray.Dispose();
        Close();
    }
}
