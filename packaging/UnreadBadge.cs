using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Globalization;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;

internal sealed partial class PachcaWindow
{
    private long[] unreadProfiles = new long[0];
    private long unreadCount;
    private bool fetchingUnread, taskbarReady;
    private DateTime nextUnreadCheck, lastUnreadCheck;

    private void SetUnreadProfiles(long[] profiles)
    {
        if (unreadProfiles.SequenceEqual(profiles)) return;
        unreadProfiles = profiles;
        nextUnreadCheck = DateTime.MinValue;
        SetUnreadCount(0);
    }

    private void RequestUnreadRefresh()
    {
        var earliest = lastUnreadCheck.AddSeconds(3);
        if (nextUnreadCheck > earliest) nextUnreadCheck = earliest;
    }

    private async Task<IList> GetUnreadData(long profile, string path)
    {
        var response = await FetchInPachca(new { url = PachcaOrigin + "/api/v3" + path, method = "GET", profile });
        int status = Convert.ToInt32(Get(response, "status"));
        if (status == 401 || status == 403) throw new UnauthorizedAccessException();
        if (status != 200) throw new InvalidOperationException("Unread count HTTP " + status);
        var envelope = json.Deserialize<Dictionary<string,object>>(Convert.ToString(Get(response, "body")));
        var rows = Get(envelope, "data") as IList;
        if (rows == null) throw new FormatException("Missing unread data.");
        return rows;
    }

    private static async Task<long> CountUnreadMessages(Func<string,Task<IList>> get)
    {
        var unread = await get("/chats/unread_ids");
        var ids = unread.Cast<object>().Select(id => Convert.ToInt64(id)).Where(id => id > 0).Distinct().ToArray();
        long count = 0;
        for (int offset = 0; offset < ids.Length; offset += 40) {
            var group = new HashSet<long>(ids.Skip(offset).Take(40));
            var query = String.Join("&", group.Select(id => "ids%5B%5D=" + id.ToString(CultureInfo.InvariantCulture)));
            var states = await get("/chats/read_info?" + query);
            foreach (Dictionary<string,object> state in states) {
                if (group.Remove(Convert.ToInt64(Get(state, "id"))))
                    count += Math.Max(0L, Convert.ToInt64(Get(state, "unread_message_counter")));
            }
        }
        return count;
    }

    private async Task RefreshUnreadBadge()
    {
        if (exiting || fetchingUnread || unreadProfiles.Length == 0 || DateTime.UtcNow < nextUnreadCheck) return;
        var profiles = unreadProfiles;
        fetchingUnread = true;
        lastUnreadCheck = DateTime.UtcNow;
        nextUnreadCheck = lastUnreadCheck.AddSeconds(30);
        try {
            long total = 0;
            foreach (long profile in profiles) {
                if (exiting || profiles != unreadProfiles) return;
                try { total += await CountUnreadMessages(path => GetUnreadData(profile, path)); }
                catch (UnauthorizedAccessException) { } // This workspace no longer contributes.
            }
            if (!exiting && profiles == unreadProfiles) SetUnreadCount(total);
        } catch (Exception error) {
            // Keep the last complete count across transient network or WebView failures.
            Debug.WriteLine(error.GetType().Name);
        } finally { fetchingUnread = false; }
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int RegisterWindowMessage(string name);
    [DllImport("user32.dll")]
    private static extern bool DestroyIcon(IntPtr icon);
    private static readonly int TaskbarButtonCreated = RegisterWindowMessage("TaskbarButtonCreated");

    protected override void WndProc(ref Message message)
    {
        base.WndProc(ref message);
        if (message.Msg != TaskbarButtonCreated || TaskbarButtonCreated == 0) return;
        taskbarReady = true;
        ApplyUnreadOverlay();
    }

    protected override void OnHandleDestroyed(EventArgs e)
    {
        taskbarReady = false;
        base.OnHandleDestroyed(e);
    }

    private void SetUnreadCount(long count)
    {
        if (unreadCount == count) return;
        unreadCount = count;
        ApplyUnreadOverlay();
    }

    private static IntPtr CreateUnreadIcon(long count)
    {
        string label = count > 99 ? "99+" : count.ToString(CultureInfo.InvariantCulture);
        using (var bitmap = new Bitmap(32, 32))
        using (var g = Graphics.FromImage(bitmap))
        using (var fill = new SolidBrush(Color.FromArgb(199, 39, 60)))
        using (var font = new Font("Segoe UI", label.Length == 3 ? 15 : 21, FontStyle.Bold, GraphicsUnit.Pixel))
        using (var format = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center }) {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            g.FillEllipse(fill, 0, 0, 32, 32);
            g.DrawString(label, font, Brushes.White, new RectangleF(-1, 0, 34, 32), format);
            return bitmap.GetHicon();
        }
    }

    private void ApplyUnreadOverlay()
    {
        if (!taskbarReady || !IsHandleCreated || exiting) return;
        ITaskbarList3 taskbar = null;
        IntPtr icon = IntPtr.Zero;
        try {
            taskbar = (ITaskbarList3)new TaskbarList();
            taskbar.HrInit();
            if (unreadCount > 0) icon = CreateUnreadIcon(unreadCount);
            taskbar.SetOverlayIcon(Handle, icon, unreadCount > 0 ? "Непрочитанных сообщений: " + unreadCount : "");
        } catch (COMException error) {
            Debug.WriteLine(error.ErrorCode);
        } finally {
            if (icon != IntPtr.Zero) DestroyIcon(icon);
            if (taskbar != null) Marshal.ReleaseComObject(taskbar);
        }
    }

    [ComImport, Guid("56FDF344-FD6D-11D0-958A-006097C9A090")]
    private class TaskbarList { }

    // Native vtable order includes ITaskbarList and ITaskbarList2.
    [ComImport, Guid("EA1AFB91-9E28-4B86-90E9-9E9F8A5EEFAF"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ITaskbarList3
    {
        void HrInit();
        void AddTab(IntPtr hwnd);
        void DeleteTab(IntPtr hwnd);
        void ActivateTab(IntPtr hwnd);
        void SetActiveAlt(IntPtr hwnd);
        void MarkFullscreenWindow(IntPtr hwnd, int fullscreen);
        void SetProgressValue(IntPtr hwnd, ulong completed, ulong total);
        void SetProgressState(IntPtr hwnd, uint state);
        void RegisterTab(IntPtr tab, IntPtr parent);
        void UnregisterTab(IntPtr tab);
        void SetTabOrder(IntPtr tab, IntPtr before);
        void SetTabActive(IntPtr tab, IntPtr parent, uint flags);
        void ThumbBarAddButtons(IntPtr hwnd, uint count, IntPtr buttons);
        void ThumbBarUpdateButtons(IntPtr hwnd, uint count, IntPtr buttons);
        void ThumbBarSetImageList(IntPtr hwnd, IntPtr images);
        void SetOverlayIcon(IntPtr hwnd, IntPtr icon, [MarshalAs(UnmanagedType.LPWStr)] string description);
    }
}
