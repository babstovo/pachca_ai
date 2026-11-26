using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal sealed partial class PachcaWindow
{
    // WebView2 serves this document from the executable. No HTTP listener is opened.
    private const string ChatKitPage = "http://localhost/pachca-agent/";
    private readonly WebView2 panelEditor = new WebView2 { Dock = DockStyle.Fill, Margin = Padding.Empty,
        AccessibleName = "Чат с локальным Codex", DefaultBackgroundColor = Surface };
    private bool editorReady;
    private string lastEditorStatus, streamRequest;
    private int panelRevision;
    private string PanelThread { get { return "pachca-" + historyProfile + "-" + accountGeneration; } }
    private bool CanDelegate { get { return connected && codexState == "ready" && guidance.Enabled; } }

    private static string EditorResource(string name)
    {
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
        using (var reader = new StreamReader(stream)) return reader.ReadToEnd();
    }

    private void EditorPost(object message)
    {
        if (editorReady && !exiting && !panelEditor.IsDisposed)
            panelEditor.CoreWebView2.PostWebMessageAsJson(json.Serialize(message));
    }

    private void UpdatePanelEditor()
    {
        if (!editorReady || exiting || panelEditor.IsDisposed) return;
        var payload = json.Serialize(new { type = "state", thread = PanelThread, available = CanDelegate,
            reply = selectedQuestion == null ? null : new { key = selectedQuestion.Key, title = selectedQuestion.ChatTitle, canClear = !generating && !signingOut },
            revision = panelRevision, notice = feedback.Text, signedIn = signedIn || connected, connected = connected && codexState == "ready" });
        if (payload == lastEditorStatus) return;
        lastEditorStatus = payload;
        panelEditor.CoreWebView2.PostWebMessageAsJson(payload);
    }

    private void FocusPanelEditor()
    {
        if (editorReady) { panelEditor.Focus(); EditorPost(new { type = "focus" }); }
    }

    private void InstallPanelEditor(TableLayoutPanel panel)
    {
        feedback.Visible = false;
        panel.Controls.Add(feedback, 0, 1);
        panel.Controls.Add(panelEditor, 0, 2);
        feedback.TextChanged += (s, e) => UpdatePanelEditor();
        bool starting = false;
        panel.VisibleChanged += async (s, e) => {
            if (starting || !panel.Visible || exiting) return;
            starting = true;
            try {
                var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PachcaWebClient", "chatkit-webview2");
                var env = await CoreWebView2Environment.CreateAsync(null, folder);
                if (panelEditor.IsDisposed || exiting) return;
                await panelEditor.EnsureCoreWebView2Async(env);
                if (panelEditor.IsDisposed || exiting) return;
                var core = panelEditor.CoreWebView2;
                await core.AddScriptToExecuteOnDocumentCreatedAsync(EditorResource("HistoryScroll.js"));
                await core.AddScriptToExecuteOnDocumentCreatedAsync(EditorResource("ReplyContext.js"));
                core.Settings.AreHostObjectsAllowed = false;
                core.Settings.IsStatusBarEnabled = false;
                core.AddWebResourceRequestedFilter(ChatKitPage + "*", CoreWebView2WebResourceContext.All);
                core.WebResourceRequested += (sender, args) => {
                    string uri = args.Request.Uri;
                    string resource = uri == ChatKitPage ? "ChatKit.html" : uri == ChatKitPage + "panel.js" ? "ChatKit.js" : null;
                    args.Response = env.CreateWebResourceResponse(resource == null ? null : Assembly.GetExecutingAssembly().GetManifestResourceStream(resource),
                        resource == null ? 404 : 200, resource == null ? "Not Found" : "OK", "Cache-Control: no-store\r\nContent-Type: " +
                        (uri == ChatKitPage ? "text/html" : "text/javascript") + "; charset=utf-8");
                };
                core.NewWindowRequested += (sender, args) => { args.Handled = true; OpenPachcaChat(args.Uri); };
                core.NavigationStarting += (sender, args) => {
                    args.Cancel = args.Uri != ChatKitPage;
                    if (!args.Cancel) { editorReady = false; lastEditorStatus = null; }
                };
                core.WebMessageReceived += async (sender, args) => {
                    if (exiting || panelEditor.IsDisposed || args.Source != ChatKitPage) return;
                    string id = null;
                    try {
                        var data = json.Deserialize<Dictionary<string,object>>(args.WebMessageAsJson);
                        string type = Get(data,"type") as string;
                        if (type == "ready") { editorReady = true; lastEditorStatus = null; UpdatePanelEditor(); return; }
                        id = Get(data,"id") as string;
                        if (String.IsNullOrEmpty(id) || id.Length > 64) return;
                        if (!Equals(Get(data,"thread"), PanelThread)) throw new InvalidOperationException("Профиль или режим чата изменился.");
                        object result = null;
                        if (type == "history") result = ChatKitHistory(data);
                        else if (type == "clearReply") {
                            if (!generating && !signingOut && selectedQuestion != null && Equals(Get(data,"key"),selectedQuestion.Key))
                                SetQuestion(null);
                        }
                        else if (type == "submit") await SubmitChatKit(data, id);
                        else if (type == "action") await OpenPanelAction(data);
                        else throw new InvalidOperationException("Неизвестное действие.");
                        EditorPost(new { type = "result", id, result });
                    } catch (Exception error) { EditorPost(new { type = "result", id, error = error.Message }); }
                };
                core.Navigate(ChatKitPage);
            } catch (Exception error) {
                if (!exiting && !panel.IsDisposed) {
                    feedback.Text = "Не удалось открыть ChatKit. " + error.Message;
                    feedback.Visible = true;
                    starting = false;
                }
            }
        };
    }

    private IEnumerable<MessageRow> PanelRows()
    {
        var questions = pending.Select(q => new MessageRow { PanelId = "q-" + q.Key, Author = "Codex", Date = q.Received,
            Text = q.Text, PendingQuestion = q,
            Links = new List<PanelLink> {
                new PanelLink { Label = "Ответить на вопрос", Open = () => SetQuestion(q) },
                new PanelLink { Label = "Пропустить", QuestionToSkip = q }
            } });
        return (questionsOnly ? questions : codexMessages.Concat(questions)).OrderBy(row => row.Date);
    }

    private static string RowId(MessageRow row)
    {
        return row.PanelId ?? (row.PanelId = row.HistoryFile == null ? Guid.NewGuid().ToString("N") : Path.GetFileNameWithoutExtension(row.HistoryFile));
    }

    private object PanelItem(MessageRow row)
    {
        var q = row.PendingQuestion;
        // Older history files recorded delivery receipts as ordinary Codex messages.
        var kind = row.Kind;
        if (kind == null && !row.Owner && (row.NoteId != null || row.Author == "Агент" || row.Text == "Вопрос снят." ||
            row.Text == "Вопрос пропущен." || row.Text == "Действие отменено." || row.Text == "Сообщение отправлено." ||
            row.Text.StartsWith("Сообщение отправлено. Получатель — ", StringComparison.Ordinal))) kind = "status";
        return new { id = RowId(row), date = row.Date.Value.ToUniversalTime().ToString("o", CultureInfo.InvariantCulture),
            kind, question = q == null ? null : new { chat = q.ChatTitle, author = q.Author, incoming = q.Incoming },
            text = row.Text, owner = row.Owner, previews = row.Previews == null ? null : row.Previews.Select(p => Convert.ToBase64String(p)).ToArray(),
            actions = row.Links == null ? null : row.Links.Select(link => link.Label).ToArray() };
    }

    private object ChatKitHistory(Dictionary<string,object> data)
    {
        var rows = PanelRows().ToList();
        if (Equals(Get(data,"order"), "desc")) rows.Reverse();
        var after = Get(data,"after") as string;
        int start = 0;
        if (after != null) {
            int cursor = rows.FindIndex(r => RowId(r) == after);
            if (cursor < 0) return new { rows = new object[0], more = false };
            start = cursor + 1;
        }
        int limit = Math.Max(1, Math.Min(16, Convert.ToInt32(Get(data,"limit") ?? 20)));
        var page = rows.Skip(start).Take(limit).ToArray();
        return new { rows = page.Select(PanelItem).ToArray(), more = start + page.Length < rows.Count };
    }

    private async Task OpenPanelAction(Dictionary<string,object> data)
    {
        var row = PanelRows().FirstOrDefault(r => RowId(r) == Get(data,"row") as string);
        int index = Convert.ToInt32(Get(data,"index"));
        if (row == null || row.Links == null || index < 0 || index >= row.Links.Count)
            throw new InvalidOperationException("Действие уже недоступно.");
        var link = row.Links[index];
        if (link.QuestionToSkip != null) {
            await DismissQuestion(link.QuestionToSkip);
            return;
        }
        if (!CanDelegate) throw new InvalidOperationException("Действие уже недоступно.");
        link.Open();
    }

    private async Task SubmitChatKit(Dictionary<string,object> data, string requestId)
    {
        if (!CanDelegate || streamRequest != null) throw new InvalidOperationException("Локальный Codex сейчас недоступен.");
        string text = Get(data,"text") as string;
        var images = Get(data,"images") as IList;
        if (text == null || text.Length > EditorDraft.MaxLength || images == null || images.Count > 3 ||
            (String.IsNullOrWhiteSpace(text) && images.Count == 0)) throw new ArgumentException("Проверьте текст и вложения.");
        var draft = new EditorDraft();
        string issue = "";
        draft.PasteError += message => issue = message;
        foreach (string encoded in images) {
            if (encoded == null || encoded.Length > 5592408) throw new ArgumentException("Изображение превышает 4 МБ.");
            using (var stream = new MemoryStream(Convert.FromBase64String(encoded)))
            using (var image = Image.FromStream(stream)) draft.AddImage(image);
            if (issue.Length > 0) throw new ArgumentException(issue);
        }
        draft.Text = text;
        guidance.SetDraft(draft.Snapshot());
        streamRequest = requestId;
        try { await DelegateAnswer();
            if (HasDraft(guidance)) EditorPost(new { type = "restoreDraft", id = requestId });
        }
        finally { streamRequest = null; }
    }
}
