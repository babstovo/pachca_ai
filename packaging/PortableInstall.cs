using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Text.RegularExpressions;

internal static class PortableInstall
{
    internal static readonly string Here = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
    internal static readonly string Root = FindRoot();
    internal static readonly string Versions = Path.Combine(Root, "versions");
    internal static readonly string Pointer = Path.Combine(Root, "current-version.txt");

    internal static bool IsVersion(string value)
    {
        Version version;
        return value != null && Regex.IsMatch(value, @"\A(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\z") &&
            Version.TryParse(value, out version);
    }

    private static string FindRoot()
    {
        var dir = new DirectoryInfo(Here);
        if (IsVersion(dir.Name) && dir.Parent != null && dir.Parent.Name == "versions" && dir.Parent.Parent != null &&
            File.Exists(Path.Combine(dir.Parent.Parent.FullName, "pachca.exe"))) return dir.Parent.Parent.FullName;
        return Here;
    }

    internal static string Active()
    {
        if (Here != Root || !File.Exists(Pointer)) return Here;
        string version = File.ReadAllText(Pointer).Trim();
        if (!IsVersion(version)) return Here;
        string path = Path.Combine(Versions, version);
        return File.Exists(Path.Combine(path, "pachca-ui.exe")) && File.Exists(Path.Combine(path, "app", "node.exe")) ? path : Here;
    }
    internal static string Quote(string argument)
    {
        // Windows treats backslashes directly before a quote specially.
        var quoted = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char character in argument)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }

            quoted.Append('\\', character == '"' ? backslashes * 2 + 1 : backslashes);
            quoted.Append(character);
            backslashes = 0;
        }
        quoted.Append('\\', backslashes * 2);
        return quoted.Append('"').ToString();
    }

    internal static void RetryFileOperation(Action operation)
    {
        // Windows can briefly hold newly written executables while inspecting them.
        for (int attempt = 0; ; attempt++) {
            try { operation(); return; }
            catch (IOException) { if (attempt == 6) throw; }
            catch (UnauthorizedAccessException) { if (attempt == 6) throw; }
            Thread.Sleep(150 * (attempt + 1));
        }
    }
}
