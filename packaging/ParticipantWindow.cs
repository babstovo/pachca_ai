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

}
