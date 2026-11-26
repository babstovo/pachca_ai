using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

internal sealed partial class PachcaWindow
{
    private readonly ShellButton activityButton = new ShellButton();
    private ActivityWindow activityWindow;
    private string activityInstance, noticeInstance;
    private long activityRevision, activityNotice;
    private bool activityBalloon;
    private Guid? taskBalloonChat;
    private readonly HashSet<string> announcedSends = new HashSet<string>();

    private void OpenActivity()
    {
        if (activityWindow == null || activityWindow.IsDisposed) {
            activityWindow = new ActivityWindow(this);
            activityWindow.Show(this);
        } else {
            activityWindow.Show();
            activityWindow.Activate();
        }
    }

    private void UpdateActivity(Dictionary<string,object> head)
    {
        string instance = Get(head,"instance") as string;
        activityInstance = instance;
        if (instance != null && instance != noticeInstance) {
            noticeInstance = instance;
            activityNotice = 0;
            announcedSends.Clear();
            activityBalloon = false;
            taskBalloonChat = null;
        }
        activityRevision = Convert.ToInt64(Get(head,"revision"));
        int count = Convert.ToInt32(Get(head,"active"));
        activityButton.Text = count == 0 ? "" : count.ToString();
        NameShellButton(activityButton,count == 0 ? "Журнал агента" : "Журнал агента · В работе: " + count);
        if (activityWindow != null && !activityWindow.IsDisposed) activityWindow.RefreshJournal();
        if (head == null || DateTime.UtcNow < nextNotification || exiting || signingOut) return;
        var prepared = (Get(head,"ready") as IList ?? new object[0]).Cast<Dictionary<string,object>>().ToArray();
        announcedSends.IntersectWith(prepared.Select(row => Convert.ToString(Get(row,"id"))));
        if (!Visible || WindowState == FormWindowState.Minimized) {
            var waiting = prepared.Where(row => announcedSends.Add(Convert.ToString(Get(row,"id")))).ToArray();
            if (waiting.Length > 0) {
                var first = waiting[0];
                ShowActivityBalloon(waiting.Length > 1 ? "Пачка AI · Ожидают отправки: " + waiting.Length : "Пачка AI · Готово к отправке",
                    Get(first,"title") + " — " + Get(first,"text") + "\nНажмите, чтобы открыть журнал.",ToolTipIcon.Info);
                return;
            }
        }
        var notices = (Get(head,"notices") as IList ?? new object[0]).Cast<Dictionary<string,object>>()
            .Where(n => Convert.ToInt64(Get(n,"seq")) > activityNotice).ToArray();
        if (notices.Length == 0) return;
        var firstNotice = notices[0];
        Guid thread;
        if (Equals(Get(firstNotice,"state"),"codex-chat") && Guid.TryParseExact(Get(firstNotice,"threadId") as string,"D",out thread)) {
            activityNotice = Convert.ToInt64(Get(firstNotice,"seq"));
            ShowActivityBalloon("Пачка AI · Чат в Codex",Get(firstNotice,"title") + "\nНажмите, чтобы открыть чат.",ToolTipIcon.Info);
            taskBalloonChat = thread;
            return;
        }
        int nextTask = Array.FindIndex(notices,1,n => Equals(Get(n,"state"),"codex-chat"));
        if (nextTask > 0) notices = notices.Take(nextTask).ToArray();
        var last = notices.Last();
        activityNotice = Convert.ToInt64(Get(last,"seq"));
        bool failure = notices.Any(n => Equals(Get(n,"state"),"error") || Equals(Get(n,"state"),"uncertain"));
        var title = failure ? "Пачка AI · Проверьте журнал" :
            Equals(Get(last,"state"),"sent") ? "Пачка AI · Сообщение отправлено" : "Пачка AI · Поручение выполнено";
        var detail = Convert.ToString(Get(last,"title")) + " — " + Convert.ToString(Get(last,"text"));
        ShowActivityBalloon(title,(notices.Length > 1 ? "Событий: " + notices.Length + ". " : "") + detail,
            failure ? ToolTipIcon.Warning : ToolTipIcon.Info);
    }

    private void ShowActivityBalloon(string title,string text,ToolTipIcon icon)
    {
        taskBalloonChat = null;
        tray.BalloonTipTitle = title;
        tray.BalloonTipText = text.Length > 200 ? text.Substring(0,197) + "…" : text;
        tray.BalloonTipIcon = icon;
        activityBalloon = true;
        nextNotification = DateTime.UtcNow.AddSeconds(6);
        tray.ShowBalloonTip(6000);
    }

    private sealed class ActivityWindow : ResourceWindow
    {
        private string displayed;
        private long revision = -1;
        private DateTime refreshNamesAt;
        private bool ready;

        public ActivityWindow(PachcaWindow app) : base(app,"Журнал агента","Activity.html","http://localhost/pachca-journal/") {}

        public void RefreshJournal()
        {
            if (!ready || IsDisposed) return;
            string instance = app.activityInstance;
            if (instance == null) {
                displayed = null;
                revision = -1;
                Post(new {type="offline"});
                return;
            }
            if (displayed != null && displayed != instance) {
                displayed = null;
                Post(new {type="offline"});
            }
            if (displayed == instance && revision == app.activityRevision && DateTime.UtcNow < refreshNamesAt) return;
            displayed = instance;
            revision = app.activityRevision;
            refreshNamesAt = DateTime.UtcNow.AddMinutes(1);
            Post(new {type="head",instance,revision});
        }

        protected override async Task Receive(string json)
        {
            object requestId = null;
            string requestInstance = null;
            try {
                var data = app.json.Deserialize<Dictionary<string,object>>(json);
                var action = Get(data,"action") as string;
                if (action == "ready") { ready = true; displayed = null; RefreshJournal(); return; }
                if (displayed == null || displayed != app.activityInstance || !Equals(Get(data,"instance"),displayed))
                    throw new InvalidOperationException("Пространство изменилось.");
                if (action == "page") {
                    string instance = displayed;
                    requestInstance = instance;
                    requestId = Get(data,"id");
                    var result = await app.Request("desktop-activity", new {profile_id=app.settingsProfile,
                        filter=Get(data,"filter"),limit=Get(data,"limit"),offset=Get(data,"offset")});
                    if (!IsDisposed && app.activityInstance == instance && Equals(Get(result,"instance"),instance))
                        Post(new {type="page",instance,id=requestId,result});
                } else if (action == "cancel") {
                    await app.Request("desktop-activity-cancel", new {profile_id=app.settingsProfile,id=Get(data,"id"),filter=Get(data,"filter")});
                    revision = -1;
                    RefreshJournal();
                } else if (action == "open") {
                    app.OpenPachcaChat(Convert.ToString(Get(data,"url")));
                    app.Activate();
                }
            } catch (Exception ex) {
                if (requestId == null) Post(new {type="error",text=ex.Message});
                else if (app.activityInstance == requestInstance)
                    Post(new {type="page",instance=requestInstance,id=requestId,error=ex.Message});
            }
        }
    }
}
