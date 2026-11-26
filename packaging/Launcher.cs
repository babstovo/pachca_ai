using System;
using System.Diagnostics;
using System.IO;
using System.Text;

internal static class Launcher
{
    private static int Main(string[] args)
    {
        int exitCode;
        try
        {
            if (args.Length == 0)
            {
                using (Process.Start(Path.Combine(PortableInstall.Active(), "pachca-ui.exe"))) { }
                return 0;
            }
            string app = Path.Combine(PortableInstall.Active(), "app");
            string node = Path.Combine(app, "node.exe");
            string client = Path.Combine(app, "pachca.mjs");
            if (!File.Exists(node) || !File.Exists(client))
                throw new FileNotFoundException("Распакуйте весь архив и запустите pachca.exe из распакованной папки.");

            var startInfo = new ProcessStartInfo
            {
                FileName = node,
                Arguments = PortableInstall.Quote(client) + " " + string.Join(" ", Array.ConvertAll(args, PortableInstall.Quote)),
                UseShellExecute = false
            };
            startInfo.EnvironmentVariables["PACHCA_PORTABLE"] = "1";
            startInfo.EnvironmentVariables["PACHCA_INSTALL_ROOT"] = PortableInstall.Root;

            using (Process child = Process.Start(startInfo))
            {
                child.WaitForExit();
                exitCode = child.ExitCode;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            exitCode = 1;
        }

        if (args.Length == 0 && !Console.IsInputRedirected)
        {
            Console.WriteLine("Нажмите Enter, чтобы закрыть окно.");
            Console.ReadLine();
        }
        return exitCode;
    }
}
