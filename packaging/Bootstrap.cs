using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

internal static class Bootstrap
{
    private static void Extract(ZipArchive zip, string stage)
    {
        foreach (var entry in zip.Entries) {
            string relative = entry.FullName.Replace('/', '\\');
            if (Path.IsPathRooted(relative) || relative.IndexOf(':') >= 0 ||
                Array.Exists(relative.Split('\\'), part => part == ".." || part == "."))
                throw new InvalidDataException("Некорректный путь в пакете.");
            string path = Path.Combine(stage, relative);
            if (relative.EndsWith("\\", StringComparison.Ordinal)) Directory.CreateDirectory(path);
            else {
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                entry.ExtractToFile(path);
            }
        }
    }

    [STAThread]
    private static int Main(string[] args)
    {
        try {
            AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
            AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
            var assembly = Assembly.GetExecutingAssembly();
            string version = assembly.GetName().Version.ToString(3);
            string key;
            using (var hash = SHA256.Create()) key = BitConverter.ToString(hash.ComputeHash(
                Encoding.UTF8.GetBytes(assembly.Location.ToUpperInvariant()))).Replace("-", "").Substring(0, 24);
            string localData = Environment.GetEnvironmentVariable("LOCALAPPDATA") ??
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string root = Path.Combine(localData,
                "PachcaWebClient", "runtime", key);
            string cachePath = Path.GetFullPath(root);
            string extended = cachePath.StartsWith(@"\\", StringComparison.Ordinal)
                ? @"\\?\UNC\" + cachePath.Substring(2) : @"\\?\" + cachePath;
            string versions = Path.Combine(extended, "versions");
            Directory.CreateDirectory(versions);
            string folder = Path.Combine(versions, version);
            using (var mutex = new Mutex(false, @"Local\PachcaPortable-" + key)) {
                try { if (!mutex.WaitOne(120000)) throw new IOException("Подготовка клиента уже выполняется."); }
                catch (AbandonedMutexException) { }
                try {
                    if (!Directory.Exists(folder)) {
                        string stage = Path.Combine(versions, ".unpack-" + Guid.NewGuid().ToString("N"));
                        Directory.CreateDirectory(stage);
                        try {
                            using (var stream = assembly.GetManifestResourceStream("client.zip"))
                            using (var zip = new ZipArchive(stream, ZipArchiveMode.Read)) Extract(zip, stage);
                            PortableInstall.RetryFileOperation(() => Directory.Move(stage, folder));
                        } finally { if (Directory.Exists(stage)) Directory.Delete(stage, true); }
                    }
                    // Keep a stable entry point for Codex and other stdio MCP clients.
                    string launcher = Path.Combine(root, "pachca.exe");
                    if (!File.Exists(launcher)) File.Copy(Path.Combine(folder, "pachca.exe"), launcher);
                    string pointer = Path.Combine(root, "current-version.txt");
                    if (!File.Exists(pointer) || File.ReadAllText(pointer) != version) {
                        string next = pointer + "." + Guid.NewGuid().ToString("N");
                        File.WriteAllText(next, version);
                        if (File.Exists(pointer)) File.Replace(next, pointer, null);
                        else File.Move(next, pointer);
                    }
                } finally { mutex.ReleaseMutex(); }
            }
            var info = new ProcessStartInfo(Path.Combine(root, "versions", version, args.Length == 0 ? "pachca-ui.exe" : "pachca.exe")) {
                UseShellExecute = false, Arguments = string.Join(" ", Array.ConvertAll(args, PortableInstall.Quote))
            };
            info.EnvironmentVariables["PACHCA_PORTABLE_EXE"] = assembly.Location;
            bool cli = args.Length > 0;
            info.CreateNoWindow = cli;
            info.RedirectStandardOutput = info.RedirectStandardError = info.RedirectStandardInput = cli;
            using (var child = Process.Start(info)) {
                if (!cli) return 0;
                var stdout = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
                var stderr = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
                Task.Run(() => {
                    try {
                        using (var input = child.StandardInput.BaseStream) Console.OpenStandardInput().CopyTo(input);
                    } catch (IOException) { } catch (InvalidOperationException) { }
                });
                child.WaitForExit();
                Task.WaitAll(stdout, stderr);
                return child.ExitCode;
            }
        } catch (Exception error) {
            if (args.Length == 0) MessageBox.Show(error.Message, "Не удалось запустить Пачку");
            else Console.Error.WriteLine(error.Message);
            return 1;
        }
    }
}
