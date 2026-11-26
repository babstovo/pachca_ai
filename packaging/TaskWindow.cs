using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading.Tasks;
using System.Windows.Forms;

internal sealed partial class PachcaWindow
{
    private void OpenTaskBoard(object selectedTask = null, object selectedAccount = null)
    {
        if (taskProfile == null || signingOut || exiting) return;
        using (var dialog = new TaskWindow(this, taskProfile, selectedTask, selectedAccount)) dialog.ShowDialog(this);
    }

    private sealed class TaskWindow : ResourceWindow
    {
        private readonly object profile;
        private readonly object selectedAccount;
        private object selectedTask;
        private bool saving;

        public TaskWindow(PachcaWindow app, object profile, object selectedTask, object selectedAccount) : base(app, "Мои задачи · OpenProject", "Tasks.html", openLink: app.OpenInBrowser)
        {
            this.profile = profile;
            this.selectedTask = selectedTask;
            this.selectedAccount = selectedAccount;
            FormClosing += (s, e) => { if (saving && e.CloseReason == CloseReason.UserClosing) e.Cancel = true; };
        }

        protected override async Task Receive(string json)
        {
            int request = 0;
            bool updating = false;
            try {
                var data = app.json.Deserialize<Dictionary<string, object>>(json);
                request = Convert.ToInt32(Get(data, "request"));
                if (!Equals(profile, app.taskProfile)) throw new InvalidOperationException("Пространство изменилось. Откройте доску заново.");
                data["profile_id"] = profile;
                object result;
                switch (Convert.ToString(Get(data, "action"))) {
                    case "list":
                        if (selectedTask != null) data["account_id"] = selectedAccount;
                        var page = await app.Request("desktop-task-board", data);
                        page["selected_task"] = selectedTask;
                        selectedTask = null;
                        result = page;
                        break;
                    case "workflow":
                        result = await app.Request("desktop-task-workflow", data);
                        break;
                    case "detail":
                    case "fields":
                    case "comments":
                    case "codex-info":
                        result = await app.Request("desktop-task-" + Get(data,"action"), data);
                        break;
                    case "codex-open":
                        var chat = await app.Request("desktop-task-codex-open", data);
                        string link = Get(chat, "url") as string;
                        Uri target;
                        Guid thread;
                        if (!Uri.TryCreate(link, UriKind.Absolute, out target) || target.Scheme != "codex" || target.Host != "threads" ||
                            !string.IsNullOrEmpty(target.UserInfo) || !target.IsDefaultPort || target.Query.Length != 0 || target.Fragment.Length != 0 ||
                            !Guid.TryParseExact(target.AbsolutePath.Substring(1), "D", out thread))
                            throw new InvalidOperationException("Codex не вернул ссылку на чат задачи.");
                        using (Process.Start(new ProcessStartInfo("codex://threads/" + thread.ToString("D")) { UseShellExecute = true })) { }
                        result = new { };
                        break;
                    case "edit":
                    case "comment":
                    case "update":
                    case "codex-start":
                        if (saving) throw new InvalidOperationException("Запрос уже выполняется.");
                        updating = saving = true;
                        result = await app.Request("desktop-task-" + Get(data,"action"), data);
                        break;
                    case "key":
                        var settings = await app.Request("desktop-openproject-key-state", new { profile_id = profile });
                        if (IsDisposed) return;
                        result = app.EditOpenProjectKey(this, Equals(Get(settings, "configured"), true), Get(settings, "boardUrl") as string, profile);
                        break;
                    default: throw new InvalidOperationException("Неизвестное действие доски.");
                }
                Post(new { request, result });
            } catch (Exception ex) { Post(new { request, error = ex.Message }); }
            finally { if (updating) saving = false; }
        }
    }
}
