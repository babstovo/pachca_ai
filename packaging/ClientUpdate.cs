using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal sealed partial class PachcaWindow
{
    private const string Repository = "babstovo/pachca_ai";
    private const string AssetName = "Pachca-AI-win-portable-x64.exe";
    private const long MaxArchive = 256L * 1024 * 1024;
    private sealed class Asset { public string name { get; set; } public string digest { get; set; }
        public string browser_download_url { get; set; } public string state { get; set; } public long size { get; set; } }
    private sealed class Release { public string tag_name { get; set; } public bool draft { get; set; }
        public bool prerelease { get; set; } public Asset[] assets { get; set; } }

    private static HttpClient ReleaseClient()
    {
        System.Net.ServicePointManager.SecurityProtocol |= System.Net.SecurityProtocolType.Tls12;
        var client = new HttpClient();
        client.DefaultRequestHeaders.UserAgent.ParseAdd("Pachca-AI-Updater/1");
        return client;
    }

    private static string PackageVersion(string directory)
    {
        var json = new JavaScriptSerializer();
        return json.Deserialize<System.Collections.Generic.Dictionary<string,object>>(
            File.ReadAllText(Path.Combine(directory, "app", "package.json")))["version"] as string;
    }

    private void AddUpdateButton(TableLayoutPanel toolbar)
    {
        var button = new Button { Visible = false, AutoSize = true, Margin = new Padding(4, 7, 12, 7) };
        DecorateButton(button, "Доступно обновление", true);
        toolbar.Controls.Add(button, 1, 0);
        Shown += async (sender, args) => {
            try {
                string target = Environment.GetEnvironmentVariable("PACHCA_PORTABLE_EXE");
                if (String.IsNullOrEmpty(target) || !File.Exists(target)) return;
                Release release;
                using (var client = ReleaseClient()) {
                    client.Timeout = TimeSpan.FromSeconds(8);
                    string raw = await client.GetStringAsync("https://api.github.com/repos/" + Repository + "/releases/latest");
                    release = new JavaScriptSerializer().Deserialize<Release>(raw);
                }
                if (release == null || release.draft || release.prerelease || release.tag_name == null ||
                    !release.tag_name.StartsWith("v", StringComparison.Ordinal)) return;
                string version = release.tag_name.Substring(1);
                if (!PortableInstall.IsVersion(version) || new Version(version) <= new Version(PackageVersion(PortableInstall.Here))) return;
                string url = "https://github.com/" + Repository + "/releases/download/v" + version + "/" + AssetName;
                var asset = (release.assets ?? new Asset[0]).SingleOrDefault(item => item.name == AssetName && item.state == "uploaded");
                if (asset == null || asset.browser_download_url != url || asset.size <= 0 || asset.size > MaxArchive ||
                    !Regex.IsMatch(asset.digest ?? "", @"\Asha256:[0-9a-f]{64}\z")) return;
                if (IsDisposed || exiting) return;
                button.Text = "Доступно обновление · " + version;
                button.Click += async (s,e) => {
                    button.Enabled = false;
                    string caption = button.Text;
                    button.Text = "Скачивание…";
                    string stage = null;
                    try {
                        stage = await Task.Run(() => PrepareUpdate(target, version, asset));
                        if (!exiting && !IsDisposed) {
                            if (generating || signingOut || changingAgent)
                                throw new InvalidOperationException("Дождитесь завершения текущей операции и нажмите кнопку ещё раз.");
                            await ExitApp(() => {
                                string arguments = "--apply-portable-update " + Process.GetCurrentProcess().Id + " " +
                                    Path.GetFileName(stage) + " " + asset.digest.Substring(7);
                                using (Process.Start(Application.ExecutablePath, arguments)) { }
                                stage = null; // The helper now owns the download.
                            });
                        }
                    } catch (Exception error) {
                        if (!IsDisposed) MessageBox.Show(this, error.Message, "Не удалось обновить Пачку");
                    } finally {
                        if (stage != null) CleanStage(stage);
                        if (!IsDisposed) { button.Text = caption; button.Enabled = true; }
                    }
                };
                button.Visible = true;
            } catch (Exception error) { Trace.WriteLine(error); }
        };
    }

    private static void CleanStage(string stage)
    {
        try { Directory.Delete(stage, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    private static string FileDigest(string path)
    {
        using (var stream = File.OpenRead(path))
        using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
    }

    private static async Task<string> PrepareUpdate(string target, string version, Asset asset)
    {
        string stage = Directory.CreateDirectory(Path.Combine(Path.GetDirectoryName(target), ".pachca-update-" + Guid.NewGuid().ToString("N"))).FullName;
        string archive = Path.Combine(stage, AssetName);
        try {
            using (var client = ReleaseClient())
            using (var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(5)))
            using (var response = await client.GetAsync(asset.browser_download_url, HttpCompletionOption.ResponseHeadersRead, timeout.Token)) {
                response.EnsureSuccessStatusCode();
                using (var input = await response.Content.ReadAsStreamAsync())
                using (var output = File.Create(archive)) {
                    byte[] buffer = new byte[81920];
                    int read;
                    while ((read = await input.ReadAsync(buffer, 0, buffer.Length, timeout.Token)) != 0) {
                        if (output.Length + read > asset.size) throw new InvalidDataException("Размер файла превышает указанный в релизе.");
                        await output.WriteAsync(buffer, 0, read, timeout.Token);
                    }
                    if (output.Length != asset.size) throw new InvalidDataException("EXE скачан не полностью.");
                }
            }
            if ("sha256:" + FileDigest(archive) != asset.digest ||
                System.Reflection.AssemblyName.GetAssemblyName(archive).Version.ToString(3) != version)
                throw new InvalidDataException("Контрольная сумма или версия EXE не совпала с релизом.");
            return stage;
        } catch {
            CleanStage(stage);
            throw;
        }
    }

    private static void FinishPortableUpdate(string[] args)
    {
        string target = Environment.GetEnvironmentVariable("PACHCA_PORTABLE_EXE");
        int previous;
        if (String.IsNullOrEmpty(target) || !File.Exists(target) || !int.TryParse(args[1], out previous) ||
            !Regex.IsMatch(args[2], @"\A\.pachca-update-[a-f0-9]{32}\z") ||
            !Regex.IsMatch(args[3], @"\A[a-f0-9]{64}\z")) return;
        string stage = Path.Combine(Path.GetDirectoryName(target), args[2]);
        string next = Path.Combine(stage, AssetName);
        string backup = Path.Combine(stage, "previous.exe");
        bool closed = false;
        try {
            try {
                using (var old = Process.GetProcessById(previous))
                    if (!old.WaitForExit(30000)) throw new IOException("Окно Пачки ещё открыто.");
            } catch (ArgumentException) { }
            closed = true;
            if (FileDigest(next) != args[3]) throw new InvalidDataException("Файл обновления изменился.");
            PortableInstall.RetryFileOperation(() => File.Replace(next, target, backup));
            using (var started = Process.Start(new ProcessStartInfo(target) { UseShellExecute = false })) {
                started.WaitForExit();
                if (started.ExitCode != 0) throw new IOException("Новый клиент не запустился.");
            }
            File.Delete(backup);
        } catch (Exception error) {
            try {
                if (File.Exists(backup)) File.Replace(backup, target, null);
                if (closed) using (Process.Start(target)) { }
            } catch (Exception recovery) {
                MessageBox.Show(error.Message + "\n" + recovery.Message + "\nПапка восстановления: " + stage, "Обновление Пачки");
                return;
            }
            MessageBox.Show(error.Message, "Не удалось обновить Пачку");
        } finally {
            if (!File.Exists(backup)) CleanStage(stage);
        }
    }
}
