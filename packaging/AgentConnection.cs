using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;

internal sealed partial class PachcaWindow
{
    private bool changingAgent, resumeChecked, mcpEnabled, cliLinked;
    private bool checkingSavedAgent = true, awaitingHostStatus;
    private string agentClient = "codex", clientFile;
    private long hostProfile;
    private readonly HashSet<string> pachcaSockets = new HashSet<string>();
    private const string PachcaOrigin = "https://app.pachca.com";

    private bool InPachca()
    {
        Uri uri = pachcaWeb.Source;
        return uri != null && uri.GetLeftPart(UriPartial.Authority) == PachcaOrigin;
    }

    private async Task<Dictionary<string,object>> FetchInPachca(object query)
    {
        if (!InPachca() || pachcaWeb.CoreWebView2 == null)
            throw new InvalidOperationException("Откройте своё пространство в основном окне Пачки.");
        // The browser applies its own session. The worker cannot provide code, headers or a destination origin.
        const string fetch = @"(async q => {
          const url = new URL(q.url);
          if (location.origin !== 'https://app.pachca.com' || url.origin !== location.origin ||
              !url.pathname.startsWith('/api/v3/') || !['GET','POST','PUT'].includes(q.method))
            return {status:403,body:''};
          const headers = {accept:'application/json','web-version':'1.48.10','x-version':q.version || '3.14',platform:'web'};
          if (q.profile) headers['user-id']=q.profile;
          let body;
          if (q.file) {
            body=new FormData();
            body.append('file',new Blob([Uint8Array.from(atob(q.file.bytes), c=>c.charCodeAt(0))],{type:q.file.mimeType || 'image/png'}),q.file.name);
          } else if (q.data != null) {headers['content-type']='application/json';body=JSON.stringify(q.data);}
          const r=await fetch(url,{method:q.method,credentials:'same-origin',redirect:'manual',headers,body,
            signal:AbortSignal.timeout(q.file ? 30000 : 15000)});
          return {status:r.type==='opaqueredirect'?401:r.status,body:await r.text()};
        })";
        var reply = await pachcaWeb.CoreWebView2.CallDevToolsProtocolMethodAsync("Runtime.evaluate",
            json.Serialize(new { expression = fetch + "(" + json.Serialize(query) + ")", awaitPromise = true, returnByValue = true }));
        var evaluation = json.Deserialize<Dictionary<string,object>>(reply);
        var result = Get(evaluation,"result") as Dictionary<string,object>;
        var value = Get(result,"value") as Dictionary<string,object>;
        if (value == null) throw new InvalidOperationException("Не удалось получить ответ из открытой Пачки. Проверьте соединение.");
        return value;
    }

    private Task<Dictionary<string,object>> FetchPachcaWorkspaces()
    {
        return FetchInPachca(new { url = PachcaOrigin + "/api/v3/workspaces", method = "GET" });
    }

    private Dictionary<long,string> PachcaProfiles(string body)
    {
        var data = json.Deserialize<Dictionary<string,object>>(body);
        var profiles = new Dictionary<long,string>();
        foreach (Dictionary<string,object> account in Get(data,"data") as IList ?? new object[0]) {
            foreach (Dictionary<string,object> workspace in Get(account,"workspaces") as IList ?? new object[0]) {
                var profile = Get(workspace,"profile") as Dictionary<string,object>;
                var company = Get(workspace,"company") as Dictionary<string,object>;
                long id = Convert.ToInt64(Get(profile,"id"));
                if (id > 0) profiles[id] = Convert.ToString(Get(company,"name")) + " · " +
                    Convert.ToString(Get(profile,"name") ?? Get(profile,"nickname")) + " (" + id + ")";
            }
        }
        return profiles;
    }

    private async Task<long> ChoosePachcaProfile(long preferred)
    {
        var response = await FetchPachcaWorkspaces();
        int status = Convert.ToInt32(Get(response,"status"));
        if (status == 401 || status == 403) throw new InvalidOperationException("Войдите в аккаунт в основном окне Пачки.");
        if (status != 200) throw new InvalidOperationException("Пачка не вернула список пространств (HTTP " + status + ").");
        var profiles = PachcaProfiles(Convert.ToString(Get(response,"body")));
        if (preferred > 0) {
            if (profiles.ContainsKey(preferred)) return preferred;
            throw new InvalidOperationException("Выбранное пространство недоступно в текущем аккаунте Пачки.");
        }
        if (profiles.Count == 0) throw new InvalidOperationException("Войдите в аккаунт в основном окне Пачки.");
        if (profiles.Count == 1) return profiles.Keys.First();
        using (var dialog = new Form { Text = "Выберите пространство Пачки", ClientSize = new Size(400,95),
            StartPosition = FormStartPosition.CenterParent, FormBorderStyle = FormBorderStyle.FixedDialog,
            MaximizeBox = false, MinimizeBox = false, BackColor = Surface, ForeColor = Ink }) {
            var options = new ComboBox { Dock = DockStyle.Top, DropDownStyle = ComboBoxStyle.DropDownList,
                DataSource = profiles.ToList(), DisplayMember = "Value", ValueMember = "Key" };
            var ok = new Button { Text = "Выбрать", Dock = DockStyle.Bottom, DialogResult = DialogResult.OK };
            DecorateButton(ok,ok.Text,true);
            dialog.Controls.Add(options); dialog.Controls.Add(ok); dialog.AcceptButton = ok;
            return dialog.ShowDialog((Form)settingsWindow ?? this) == DialogResult.OK ? Convert.ToInt64(options.SelectedValue) : 0;
        }
    }

    private void WriteHost(Process owner, object message)
    {
        if (owner != worker || owner.HasExited) return;
        try {
            var bytes = System.Text.Encoding.UTF8.GetBytes(json.Serialize(message) + "\n");
            owner.StandardInput.BaseStream.Write(bytes,0,bytes.Length);
            owner.StandardInput.BaseStream.Flush();
        }
        catch (IOException) { } catch (InvalidOperationException) { }
    }

    private async Task HandleHostRequest(Process owner, string line)
    {
        if (owner != worker || String.IsNullOrEmpty(line)) return;
        var request = json.Deserialize<Dictionary<string,object>>(line);
        var id = Get(request,"id");
        if (id == null) return;
        try {
            if (signingOut || exiting) throw new InvalidOperationException();
            var requested = Get(request,"profile");
            if (requested != null && Convert.ToInt64(requested) != hostProfile) throw new InvalidOperationException();
            var result = await FetchInPachca(request);
            WriteHost(owner,new { id, status = Get(result,"status"), body = Get(result,"body") });
        } catch { WriteHost(owner,new { id, status = 503, body = "" }); }
    }

    private async Task ListenToPachca(CoreWebView2 core)
    {
        bool receivedWorkspaces = false;
        core.NavigationStarting += (s,e) => {
            if (e.Cancel) return;
            receivedWorkspaces = false;
            SetBoardKeyProfile(null);
        };
        core.NavigationCompleted += async (s,e) => {
            if (!e.IsSuccess || !InPachca() || receivedWorkspaces || exiting) return;
            // Some pages reuse a cached workspace list. Request it for this browser session.
            try { await FetchPachcaWorkspaces(); } catch (InvalidOperationException) { }
        };
        core.WebResourceResponseReceived += async (s,e) => {
            Uri uri;
            if (exiting || !Uri.TryCreate(e.Request.Uri,UriKind.Absolute,out uri) ||
                uri.GetLeftPart(UriPartial.Authority) != PachcaOrigin || uri.AbsolutePath != "/api/v3/workspaces") return;
            if (e.Response.StatusCode == 401 || e.Response.StatusCode == 403) {
                SetBoardKeyProfile(null);
                if (worker != null && !worker.HasExited && !signingOut && !changingAgent) {
                    workerError = "Сеанс Пачки завершён. Войдите в основном окне и подключите агента.";
                    WriteHost(worker,new { @event = "stop" });
                }
                return;
            }
            if (e.Response.StatusCode != 200 || !InPachca()) return;
            receivedWorkspaces = true;
            int revision = ++boardKeyRevision;
            try {
                string body;
                using (var stream = await e.Response.GetContentAsync())
                using (var reader = new StreamReader(stream)) body = await reader.ReadToEndAsync();
                var profiles = PachcaProfiles(body);
                var result = await Request("desktop-task-profile", new { profiles = profiles.Keys.ToArray() });
                if (!exiting && revision == boardKeyRevision) SetBoardKeyProfile(Get(result,"profile_id"));
            } catch (Exception) {
                if (!exiting && revision == boardKeyRevision) SetBoardKeyProfile(null);
            }
        };
        core.GetDevToolsProtocolEventReceiver("Network.webSocketCreated").DevToolsProtocolEventReceived += (s,e) => {
            var info = json.Deserialize<Dictionary<string,object>>(e.ParameterObjectAsJson);
            Uri uri;
            if (Uri.TryCreate(Convert.ToString(Get(info,"url")),UriKind.Absolute,out uri) &&
                uri.Scheme == "wss" && uri.Host == "wss.pachca.com") pachcaSockets.Add(Convert.ToString(Get(info,"requestId")));
        };
        core.GetDevToolsProtocolEventReceiver("Network.webSocketClosed").DevToolsProtocolEventReceived += (s,e) => {
            var info = json.Deserialize<Dictionary<string,object>>(e.ParameterObjectAsJson);
            pachcaSockets.Remove(Convert.ToString(Get(info,"requestId")));
        };
        core.GetDevToolsProtocolEventReceiver("Network.webSocketFrameReceived").DevToolsProtocolEventReceived += (s,e) => {
            if (worker == null || worker.HasExited || !connected || !InPachca()) return;
            var info = json.Deserialize<Dictionary<string,object>>(e.ParameterObjectAsJson);
            if (!pachcaSockets.Contains(Convert.ToString(Get(info,"requestId")))) return;
            var frame = Get(info,"response") as Dictionary<string,object>;
            var payload = Get(frame,"payloadData") as string;
            if (payload != null && payload.StartsWith("42") && payload.Contains("message.created"))
                WriteHost(worker,new { @event = "activity", payload });
        };
        await core.CallDevToolsProtocolMethodAsync("Network.enable","{}");
    }

    private async Task StartHost(long profile)
    {
        var state = Get(await Request("desktop-state",new {}),"status") as Dictionary<string,object>;
        if (Equals(Get(state,"running"),true)) {
            await Request("stop-watch",new {});
            for (int i=0; i<40; i++) {
                state = Get(await Request("desktop-state",new {}),"status") as Dictionary<string,object>;
                if (!Equals(Get(state,"running"),true)) break;
                if (i==39) throw new InvalidOperationException("Предыдущий агент ещё завершает работу.");
                await Task.Delay(200);
            }
        }
        if (worker != null && !worker.HasExited) throw new InvalidOperationException("Предыдущее подключение ещё закрывается.");
        if (worker != null) worker.Dispose();
        workerError = null;
        hostProfile = profile;
        var owner = new Process { StartInfo = Node("desktop-host " + profile) };
        var ready = new TaskCompletionSource<bool>();
        owner.EnableRaisingEvents = true;
        owner.Exited += (s,e) => ready.TrySetResult(false);
        owner.ErrorDataReceived += (s,e) => { if (owner == worker && !String.IsNullOrWhiteSpace(e.Data)) workerError = e.Data; };
        owner.OutputDataReceived += (s,e) => {
            if (e.Data == "READY") { ready.TrySetResult(true); return; }
            if (!String.IsNullOrEmpty(e.Data) && !IsDisposed && IsHandleCreated)
                BeginInvoke(new Action(async () => { try { await HandleHostRequest(owner,e.Data); } catch (Exception ex) { workerError = ex.Message; } }));
        };
        worker = owner;
        owner.Start();
        owner.BeginErrorReadLine(); owner.BeginOutputReadLine();
        if (await Task.WhenAny(ready.Task,Task.Delay(45000)) != ready.Task || !await ready.Task)
            throw new InvalidOperationException(workerError ?? "Не удалось подключить агента к открытой Пачке.");
    }

    private async Task ConnectAgent(long preferred = 0, object model = null, object effort = null, string client = "codex", string file = null)
    {
        if (changingAgent || signingOut || exiting) return;
        changingAgent = true;
        accountGeneration++;
        UpdateSend();
        try {
            if (client != "codex" && client != "copilot" && client != "custom") throw new InvalidOperationException("Выберите MCP-клиент.");
            if (preferred == 0 && client == "codex" && codexState != "ready") {
                await ConnectLocalCodex();
                if (codexState != "ready") throw new InvalidOperationException(codexState == "missing" ? "Установите Codex и повторите подключение." : "Для этого агента нужен вход в Codex.");
            }
            long profile = await ChoosePachcaProfile(preferred);
            if (profile == 0) return;
            await StartHost(profile);
            if (preferred == 0) await Request("desktop-agent-enable",new { profile_id = profile, model, effort, client, file });
            agentClient = client;
            clientFile = file;
            WriteHost(worker,new { @event = "activate" });
            mcpEnabled = true;
            cliLinked = false;
            workerError = null;
            accountGeneration++;
            awaitingHostStatus = true;
            await RefreshState();
        } catch {
            if (worker != null && !worker.HasExited) WriteHost(worker,new { @event = "stop" });
            throw;
        } finally { changingAgent = false; UpdateSend(); }
    }

    private async Task ResumeAgent(bool navigationSucceeded)
    {
        if (resumeChecked) return;
        try {
            if (!navigationSucceeded || changingAgent || !InPachca()) return;
            resumeChecked = true;
            checkingSavedAgent = true;
            UpdateAgentHeader();
            var link = await Request("desktop-agent-link",new {});
            if (Equals(Get(link,"enabled"),true) && Get(link,"profile_id") != null) {
                var status = await Request("desktop-codex-status",new {});
                var client = Get(link,"client") as string ?? "codex";
                if (Equals(Get(status,"mcp_enabled"),true) && (client != "codex" || Equals(Get(status,"state"),"ready")))
                    await ConnectAgent(Convert.ToInt64(Get(link,"profile_id")),null,null,client,Get(link,"file") as string);
            }
        } catch (Exception ex) { workerError = ex.Message; }
        finally { checkingSavedAgent = false; if (!exiting) UpdateSend(); }
    }
}
