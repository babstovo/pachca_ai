using System;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.Serialization;
using System.Xml;

internal sealed partial class PachcaWindow
{
    private const int PanelHistoryLimit = 100;
    private long historyProfile, lastHistorySequence;
    private readonly string historyRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "PachcaWebClient", "agent-history");
    private readonly DataContractSerializer messageSerializer = new DataContractSerializer(typeof(MessageRow));

    [DataContract]
    private sealed class PanelLink
    {
        [DataMember] public string Label, Url;
        public Action Open;
        public Question QuestionToSkip;
    }

    private PanelLink ChatLink(string label, string url)
    {
        return new PanelLink { Label = label, Url = url, Open = () => OpenPachcaChat(url) };
    }

    private string PanelHistoryFolder()
    {
        return Path.Combine(historyRoot, historyProfile.ToString(CultureInfo.InvariantCulture));
    }

    private void LoadPanelHistory(long profile)
    {
        if (profile <= 0 || profile == historyProfile) return;
        if (historyProfile != 0) ClearAgentSession();
        historyProfile = profile;
        lastHistorySequence = 0;
        try {
            string folder = PanelHistoryFolder();
            if (!Directory.Exists(folder)) return;
            var files = Directory.GetFiles(folder, "*.xml").Where(path =>
                System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(path), @"^[0-9]{19}\.xml$"))
                .OrderBy(path => path, StringComparer.Ordinal).ToArray();
            foreach (string file in files.Skip(Math.Max(0, files.Length - PanelHistoryLimit))) {
                try {
                    long sequence;
                    if (!Int64.TryParse(Path.GetFileNameWithoutExtension(file), out sequence)) continue;
                    lastHistorySequence = Math.Max(lastHistorySequence, sequence);
                    MessageRow row;
                    using (var stream = File.OpenRead(file)) row = (MessageRow)messageSerializer.ReadObject(stream);
                    if (row == null || row.Text == null || row.Date == null) continue;
                    row.HistoryFile = file;
                    if (row.Links != null) row.Links = row.Links.Where(link => link != null && !String.IsNullOrEmpty(link.Url))
                        .Select(link => ChatLink(link.Label, link.Url)).ToList();
                    codexMessages.Add(row);
                    if (row.NoteId != null) shownPanelNotes.Add(row.NoteId);
                    if (row.Owner || row.Author == "Codex") dialogue.Add(row.Author + "\n" + row.Text +
                        (row.Previews != null && row.Previews.Length > 0 ? "\n[Были приложены картинки]" : ""));
                } catch (SerializationException) { feedback.Text = "Часть истории агента не удалось прочитать."; }
                  catch (XmlException) { feedback.Text = "Часть истории агента не удалось прочитать."; }
            }
            if (dialogue.Count > 12) dialogue.RemoveRange(0, dialogue.Count - 12);
            RenderCodex();
            foreach (var older in files.Take(Math.Max(0, files.Length - PanelHistoryLimit))) File.Delete(older);
        } catch (IOException e) { feedback.Text = "Не удалось прочитать историю агента. " + e.Message; }
          catch (UnauthorizedAccessException e) { feedback.Text = "Нет доступа к истории агента. " + e.Message; }
    }

    private void SavePanelMessage(MessageRow row)
    {
        if (historyProfile <= 0) return;
        try {
            string folder = PanelHistoryFolder();
            Directory.CreateDirectory(folder);
            lastHistorySequence = Math.Max(DateTime.UtcNow.Ticks, lastHistorySequence + 1);
            string file = Path.Combine(folder, lastHistorySequence.ToString("D19", CultureInfo.InvariantCulture) + ".xml");
            string temp = Path.Combine(folder, "pending.tmp");
            using (var stream = File.Create(temp)) messageSerializer.WriteObject(stream, row);
            File.Move(temp, file);
            row.HistoryFile = file;
            if (codexMessages.Count > PanelHistoryLimit && codexMessages[0].HistoryFile != null)
                File.Delete(codexMessages[0].HistoryFile);
        } catch (IOException e) { feedback.Text = "Не удалось сохранить историю агента. " + e.Message; }
          catch (UnauthorizedAccessException e) { feedback.Text = "Нет доступа к истории агента. " + e.Message; }
    }
}
