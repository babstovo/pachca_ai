using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal sealed partial class PachcaWindow
{
    private const int MaxHtmlAttachmentBytes = 8 * 1024 * 1024;

    private async void OpenHtmlAttachment(object sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        Uri source;
        if (exiting || !InPachca() || !Uri.TryCreate(e.Source, UriKind.Absolute, out source) ||
            source.GetLeftPart(UriPartial.Authority) != PachcaOrigin) return;
        var payload = e.WebMessageAsJson;
        if (payload.Length > (MaxHtmlAttachmentBytes + 2) / 3 * 4 + 4096) return;
        Form window = null;
        try {
            var message = json.DeserializeObject(payload) as Dictionary<string, object>;
            if (message == null || !Equals(Get(message, "type"), "html-attachment")) return;
            var name = Get(message, "name") as string;
            var data = Get(message, "data") as string;
            if (name == null || name.Length > 512 || data == null ||
                !(name.EndsWith(".html", StringComparison.OrdinalIgnoreCase) || name.EndsWith(".htm", StringComparison.OrdinalIgnoreCase))) return;
            var bytes = Convert.FromBase64String(data);
            if (bytes.Length > MaxHtmlAttachmentBytes) return;

            window = new Form { Text = name, Icon = Icon, StartPosition = FormStartPosition.CenterParent,
                Size = Size, WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Maximized : FormWindowState.Normal };
            var viewer = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.White,
                CreationProperties = new CoreWebView2CreationProperties {
                    UserDataFolder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        "PachcaWebClient", "attachment-viewer"), IsInPrivateModeEnabled = true
                } };
            window.Controls.Add(viewer);
            window.Show(this);
            await viewer.EnsureCoreWebView2Async();
            if (window.IsDisposed) return;
            ShowHtmlDocument(viewer.CoreWebView2, bytes);
        } catch (Exception error) {
            if (exiting || IsDisposed || (window != null && window.IsDisposed)) return;
            if (window != null) window.Close();
            MessageBox.Show(this, error.Message, "Не удалось открыть HTML-вложение", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private void ShowHtmlDocument(CoreWebView2 core, byte[] bytes)
    {
        var page = "https://" + Guid.NewGuid().ToString("N") + ".invalid/attachment.html";
        core.Settings.AreHostObjectsAllowed = false;
        core.Settings.IsWebMessageEnabled = false;
        core.PermissionRequested += (s, e) => e.State = CoreWebView2PermissionState.Deny;
        core.LaunchingExternalUriScheme += (s, e) => e.Cancel = true;
        core.DownloadStarting += (s, e) => e.Cancel = true;
        core.NewWindowRequested += (s, e) => {
            e.Handled = true;
            if (e.IsUserInitiated) OpenHtmlLink(e.Uri);
        };
        core.NavigationStarting += (s, e) => {
            if (e.Uri.Split('#')[0] == page) return;
            e.Cancel = true;
            if (e.IsUserInitiated && !e.IsRedirected) OpenHtmlLink(e.Uri);
        };
        core.AddWebResourceRequestedFilter(page, CoreWebView2WebResourceContext.Document);
        core.WebResourceRequested += (s, e) => {
            if (e.Request.Uri != page) return;
            e.Response = core.Environment.CreateWebResourceResponse(new MemoryStream(bytes, false), 200, "OK",
                "Content-Type: text/html\r\nContent-Security-Policy: sandbox allow-scripts\r\nReferrer-Policy: no-referrer\r\nCache-Control: no-store");
        };
        core.Navigate(page);
    }

    private void OpenHtmlLink(string url)
    {
        Uri target;
        if (!TryWebLink(url, out target)) return;
        if (IsPachcaChat(target)) { OpenPachcaChat(url); Activate(); }
        else OpenInBrowser(target);
    }
}
