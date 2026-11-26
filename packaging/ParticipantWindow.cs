using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal sealed partial class PachcaWindow
{
    private abstract class ResourceWindow : Form
    {
        protected readonly PachcaWindow app;
        private readonly WebView2 web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Surface };

        protected ResourceWindow(PachcaWindow app, string title, string resource, string pageUrl = null, Action<Uri> openLink = null, bool transparent = false)
        {
            this.app = app;
            Text = title;
            Icon = app.Icon;
            StartPosition = FormStartPosition.CenterParent;
            ClientSize = new Size(900, 620);
            MinimumSize = new Size(580, 460);
            BackColor = Surface;
            if (transparent) web.DefaultBackgroundColor = Color.Transparent;
            Controls.Add(web);
            Shown += async (s, e) => await Initialize(resource,pageUrl,openLink);
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            int dark = 1;
            DwmSetWindowAttribute(Handle, 20, ref dark, sizeof(int));
        }

        private async Task Initialize(string resource, string pageUrl, Action<Uri> openLink)
        {
            try {
                var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PachcaWebClient", pageUrl == null ? "webview2" : "chatkit-webview2");
                var env = await CoreWebView2Environment.CreateAsync(null, folder);
                if (IsDisposed) return;
                await web.EnsureCoreWebView2Async(env);
                if (IsDisposed) return;
                var core = web.CoreWebView2;
                if (resource == "Activity.html") await core.AddScriptToExecuteOnDocumentCreatedAsync(EditorResource("HistoryScroll.js"));
                core.Settings.AreHostObjectsAllowed = false;
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.IsStatusBarEnabled = false;
                bool initial = true;
                core.NavigationStarting += (s, e) => { e.Cancel = pageUrl == null ? !initial : e.Uri != pageUrl; initial = false; };
                core.NewWindowRequested += (s, e) => {
                    e.Handled = true;
                    Uri target;
                    if (openLink != null && e.IsUserInitiated && TryWebLink(e.Uri, out target))
                        openLink(target);
                };
                core.WebMessageReceived += async (s, e) => {
                    if (e.Source != (pageUrl ?? "about:blank") || IsDisposed) return;
                    await Receive(e.WebMessageAsJson);
                };
                if (pageUrl == null) core.NavigateToString(EditorResource(resource));
                else {
                    core.AddWebResourceRequestedFilter(pageUrl, CoreWebView2WebResourceContext.Document);
                    core.WebResourceRequested += (s,e) => {
                        if (e.Request.Uri == pageUrl)
                            e.Response = env.CreateWebResourceResponse(typeof(ResourceWindow).Assembly.GetManifestResourceStream(resource),
                                200,"OK","Content-Type: text/html; charset=utf-8\r\nCache-Control: no-store");
                    };
                    core.Navigate(pageUrl);
                }
            } catch (Exception ex) {
                if (!IsDisposed) { MessageBox.Show(this, ex.Message, Text); Close(); }
            }
        }

        protected void Post(object message)
        {
            if (!IsDisposed && !web.IsDisposed && web.CoreWebView2 != null)
                web.CoreWebView2.PostWebMessageAsJson(app.json.Serialize(message));
        }

        protected abstract Task Receive(string json);
    }

    private sealed class ParticipantWindow : ResourceWindow
    {
        private object profile;
        private bool dirty, saving, discard;

        public ParticipantWindow(PachcaWindow app) : base(app, "Участники и стиль ответов", "Participants.html")
        {
            FormClosing += (s, e) => {
                if (e.CloseReason != CloseReason.UserClosing || discard || (!dirty && !saving)) return;
                e.Cancel = true;
                if (!saving) Post(new { type = "closeRequest" });
            };
        }

        protected override async Task Receive(string json)
        {
            int request = 0;
            bool writing = false;
            try {
                var data = app.json.Deserialize<Dictionary<string,object>>(json);
                var action = Convert.ToString(Get(data,"action"));
                if (action == "dirty") { dirty = Equals(Get(data,"value"),true); return; }
                if (action == "close") { if (!saving) { discard = true; Close(); } return; }
                request = Convert.ToInt32(Get(data,"request"));
                Dictionary<string,object> result;
                if (action == "list") {
                    result = await app.Request("desktop-participants", new { });
                    var current = Get(result,"profile_id");
                    if (current == null || (profile != null && !Equals(profile,current)))
                        throw new InvalidOperationException("Пространство изменилось. Откройте справочник заново.");
                    profile = current;
                } else {
                    if (profile == null) throw new InvalidOperationException("Сначала загрузите список участников.");
                    long id = Convert.ToInt64(Get(data,"id"));
                    switch (action) {
                        case "card":
                            result = await app.Request("desktop-participant", new { profile_id = profile, user_id = id });
                            break;
                        case "save":
                            if (saving) throw new InvalidOperationException("Сохранение уже выполняется.");
                            writing = saving = true;
                            result = await app.Request("desktop-save-participant", new { profile_id = profile, user_id = id,
                                role = Get(data,"role"), portrait = Get(data,"portrait"), style = Get(data,"style"),
                                approach = Get(data,"approach"), detail = Get(data,"detail") });
                            dirty = false;
                            break;
                        case "refresh":
                            result = await app.Request("desktop-index-participants", new { profile_id = profile,
                                ids = Get(data,"ids"), depth = Get(data,"depth") });
                            break;
                        case "find":
                            result = await app.Request("desktop-find-participants", new { profile_id = profile, query = Get(data,"query") });
                            break;
                        default: throw new InvalidOperationException("Неизвестное действие.");
                    }
                }
                Post(new { request, result });
            } catch (Exception ex) { Post(new { request, error = ex.Message }); }
            finally { if (writing) saving = false; }
        }
    }
}
