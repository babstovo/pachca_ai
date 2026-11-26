using System;
using System.Collections.Generic;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;

internal sealed partial class PachcaWindow
{
    private void OpenAgentSettings(string section = "replies")
    {
        if (settingsWindow != null) { settingsWindow.Activate(); return; }
        using (var window = new AgentSettingsWindow(this, section)) {
            settingsWindow = window;
            try { window.ShowDialog(this); }
            finally { settingsWindow = null; }
        }
    }

    private sealed class AgentSettingsWindow : ResourceWindow
    {
        private readonly string initialSection;
        private object profile;
        private long keyProfile;
        private string lastState;
        private bool ready, dirty, discard;
        public bool Writing { get; private set; }

        public AgentSettingsWindow(PachcaWindow app, string section)
            : base(app, "Настройки агента", "AgentSettings.html")
        {
            profile = app.settingsProfile;
            initialSection = section;
            ClientSize = new Size(800, 568);
            MinimumSize = new Size(520, 430);
            FormClosing += (s, e) => {
                if (e.CloseReason != CloseReason.UserClosing || discard) return;
                if (Writing) e.Cancel = true;
                else if (dirty) { e.Cancel = true; Post(new { type = "confirmClose" }); }
            };
        }

        public void PublishState()
        {
            if (!ready || IsDisposed) return;
            if (profile == null) profile = app.settingsProfile;
            bool changed = profile != null && app.settingsProfile != null && !Equals(profile, app.settingsProfile);
            var state = new {
                online = app.connected && !app.signingOut && !changed,
                changed, signedIn = app.signedIn, cliLinked = app.cliLinked, client = app.agentClient, connectionError = app.workerError, autoReply = app.lastAutoReply,
                confirm = app.confirmationRequired, generating = app.generating, codex = app.codexState,
                taskPanel = new { autoOpen = app.OverlayOptions.AutoOpen, inBrowser = app.OverlayOptions.InBrowser },
                connecting = app.changingAgent || app.connectingCodex, disconnecting = app.signingOut, checking = app.checkingCodex
            };
            string serialized = app.json.Serialize(state);
            if (lastState == serialized) return;
            lastState = serialized;
            Post(new { type = "state", state });
        }

        protected override async Task Receive(string json)
        {
            // Leave the WebView event before opening another modal window.
            await Task.Yield();
            if (IsDisposed) return;
            int request = 0;
            bool locked = false;
            try {
                var data = app.json.Deserialize<Dictionary<string, object>>(json);
                string action = Convert.ToString(Get(data, "action"));
                request = Convert.ToInt32(Get(data, "request"));
                if (action == "ready") {
                    ready = true;
                    Post(new { type = "open", section = initialSection });
                    lastState = null;
                    PublishState();
                    return;
                }
                if (action == "dirty") { dirty = Equals(Get(data, "value"), true); return; }
                if (action == "close") { if (!Writing) { discard = true; Close(); } return; }

                bool read = action == "models" || action == "availableModels" || action == "profile" || action == "projects" || action == "codexProjects";
                if (!read) {
                    if (Writing) throw new InvalidOperationException("Дождитесь завершения операции.");
                    locked = Writing = true;
                }
                bool keyAction = action == "inspectKey" || action == "saveKey" || action == "removeKey";
                bool local = keyAction || action == "taskStartup" || action == "taskDestination" || action == "resetTaskPanel" ||
                    action == "connectAgent" || action == "availableModels" || (action == "disconnectAgent" && app.cliLinked);
                if (!local && (profile == null || !Equals(profile, app.settingsProfile) ||
                    (!app.connected && action != "disconnectAgent") || app.signingOut))
                    throw new InvalidOperationException("Проверьте подключение к Пачке и откройте настройки заново.");
                data["profile_id"] = profile;
                object result = null;
                switch (action) {
                    case "taskStartup":
                        app.SaveOverlayOptions(Equals(Get(data, "enabled"), true), app.OverlayOptions.InBrowser, app.OverlayOptions.SavedBounds());
                        break;
                    case "taskDestination":
                        app.SaveOverlayOptions(app.OverlayOptions.AutoOpen, Equals(Get(data, "inBrowser"), true), app.OverlayOptions.SavedBounds());
                        break;
                    case "resetTaskPanel":
                        app.ResetOverlayOptions();
                        break;
                    case "autoReply":
                        var auto = await app.Request("desktop-auto-reply", data);
                        app.lastAutoReply = Equals(Get(auto, "enabled"), true);
                        break;
                    case "confirm":
                        var confirm = await app.Request("desktop-confirmation", data);
                        app.confirmationRequired = Equals(Get(confirm, "confirmation_required"), true);
                        break;
                    case "models": result = await app.Request("desktop-models", data); break;
                    case "availableModels": result = await app.Request("desktop-available-models",new {}); break;
                    case "saveModel":
                        if (app.generating || app.codexState != "ready") throw new InvalidOperationException("Сейчас модель недоступна для изменения.");
                        result = await app.Request("desktop-save-model", data);
                        break;
                    case "profile": result = await app.Request("desktop-profile", data); break;
                    case "saveProfile": result = await app.Request("desktop-save-profile", data); break;
                    case "projects": result = await app.Request("desktop-projects", data); break;
                    case "codexProjects": result = await app.Request("desktop-codex-projects", data); break;
                    case "saveProjects": result = await app.Request("desktop-save-projects", data); break;
                    case "inspectKey":
                        keyProfile = 0;
                        keyProfile = await app.ChoosePachcaProfile(Convert.ToInt64(app.settingsProfile));
                        if (keyProfile > 0) result = await app.Request("desktop-openproject-key-state", new { profile_id = keyProfile });
                        if (result != null && Equals(Get((Dictionary<string,object>)result, "configured"), true)) app.SetBoardKeyProfile(keyProfile);
                        break;
                    case "saveKey":
                    case "removeKey":
                        if (keyProfile <= 0 || app.signingOut || (app.settingsProfile != null && Convert.ToInt64(app.settingsProfile) != keyProfile))
                            throw new InvalidOperationException("Пространство изменилось. Откройте настройку ключа заново.");
                        await app.ChoosePachcaProfile(keyProfile);
                        result = action == "saveKey"
                            ? await app.Request("desktop-openproject-key", new { profile_id = keyProfile, boardUrl = Get(data, "boardUrl"), key = Get(data, "key") })
                            : await app.Request("desktop-openproject-remove-key", new { profile_id = keyProfile });
                        app.SetBoardKeyProfile(action == "saveKey" ? (object)keyProfile : null, true);
                        break;
                    case "loginBoard": await app.Request("openproject-login", new { }); break;
                    case "participants":
                        using (var dialog = new ParticipantWindow(app)) dialog.ShowDialog(this);
                        break;
                    case "connectAgent":
                        if (!app.signedIn) {
                            var client = Get(data,"client") as string ?? "codex";
                            string file = null;
                            if (client == "custom") {
                                using (var picker = new SaveFileDialog { Title = "Файл настроек MCP выбранного клиента",
                                    Filter = "Конфигурация MCP (*.json;*.jsonc)|*.json;*.jsonc", FileName = app.agentClient == "custom" ? app.clientFile : "mcp.json",
                                    OverwritePrompt = false, AddExtension = true, DefaultExt = "json" }) {
                                    if (picker.ShowDialog(this) != DialogResult.OK) break;
                                    file = picker.FileName;
                                }
                            }
                            profile = null;
                            await app.ConnectAgent(0,Get(data,"model"),Get(data,"effort"),client,file);
                        }
                        break;
                    case "disconnectAgent":
                        if (dirty) throw new InvalidOperationException("Сохраните или отмените правки перед отключением агента.");
                        if (await app.DisconnectAgent()) profile = null;
                        break;
                    default: throw new InvalidOperationException("Неизвестная настройка.");
                }
                PublishState();
                Post(new { request, result });
            } catch (Exception ex) { Post(new { request, error = ex.Message }); }
            finally {
                if (locked) { Writing = false; app.settingsRevision++; PublishState(); }
            }
        }
    }
}
