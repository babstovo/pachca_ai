param(
    [Parameter(Mandatory)][string]$Bundle,
    [Parameter(Mandatory)][string]$Cache
)
$ErrorActionPreference = 'Stop'
$version = '1.0.3537.50'
$expectedHash = '5EA526BBD728ADDA0DA4D31219267E96460494A427E4894C4E09D9F320F4B9AA'
$archive = Join-Path $Cache "webview2.$version.zip"
$sdk = Join-Path $Cache "webview2.$version"
New-Item -ItemType Directory -Path $Cache -Force | Out-Null
if (!(Test-Path -LiteralPath $archive)) {
    Invoke-WebRequest -UseBasicParsing -Uri "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$version/microsoft.web.webview2.$version.nupkg" -OutFile $archive
}
if ((Get-FileHash -LiteralPath $archive).Hash -ne $expectedHash) { throw 'WebView2 SDK checksum mismatch.' }
Expand-Archive -LiteralPath $archive -DestinationPath $sdk -Force
$core = Join-Path $sdk 'lib\net462\Microsoft.Web.WebView2.Core.dll'
$forms = Join-Path $sdk 'lib\net462\Microsoft.Web.WebView2.WinForms.dll'
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$exe = Join-Path $Bundle 'pachca-ui.exe'
$editor = Join-Path $PSScriptRoot 'chatkit.html'
$chatkitScript = Join-Path $PSScriptRoot 'chatkit.js'
& $compiler /nologo /target:winexe /platform:x64 "/win32icon:$PSScriptRoot\pachca-ai.ico" /optimize+ /codepage:65001 /r:System.Net.Http.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Runtime.Serialization.dll /r:System.Web.Extensions.dll "/r:$core" "/r:$forms" "/resource:$editor,ChatKit.html" "/resource:$PSScriptRoot\history-scroll.js,HistoryScroll.js" "/resource:$PSScriptRoot\reply-context.js,ReplyContext.js" "/resource:$PSScriptRoot\activity.html,Activity.html" "/resource:$PSScriptRoot\html-attachment.js,HtmlAttachment.js" "/resource:$PSScriptRoot\agent-settings.html,AgentSettings.html" "/resource:$PSScriptRoot\participants.html,Participants.html" "/resource:$PSScriptRoot\tasks.html,Tasks.html" "/resource:$PSScriptRoot\task-overlay.html,TaskOverlay.html" "/resource:${chatkitScript},ChatKit.js" "/out:$exe" (Join-Path $PSScriptRoot 'PortableInstall.cs') (Join-Path $PSScriptRoot 'ClientUpdate.cs') (Join-Path $PSScriptRoot 'Desktop.cs') (Join-Path $PSScriptRoot 'PachcaWebView.cs') (Join-Path $PSScriptRoot 'HtmlAttachment.cs') (Join-Path $PSScriptRoot 'AgentConnection.cs') (Join-Path $PSScriptRoot 'PanelEditor.cs') (Join-Path $PSScriptRoot 'PanelHistory.cs') (Join-Path $PSScriptRoot 'ActivityWindow.cs') (Join-Path $PSScriptRoot 'ParticipantWindow.cs') (Join-Path $PSScriptRoot 'TaskWindow.cs') (Join-Path $PSScriptRoot 'TaskOverlay.cs') (Join-Path $PSScriptRoot 'AgentSettingsWindow.cs')
if ($LASTEXITCODE -ne 0) { throw 'Could not compile the desktop application.' }
Copy-Item -LiteralPath $core,$forms,(Join-Path $sdk 'runtimes\win-x64\native\WebView2Loader.dll') -Destination $Bundle -Force
Copy-Item -LiteralPath (Join-Path $sdk 'LICENSE.txt') -Destination (Join-Path $Bundle 'WebView2-LICENSE.txt') -Force
Copy-Item -LiteralPath (Join-Path $sdk 'NOTICE.txt') -Destination (Join-Path $Bundle 'WebView2-NOTICE.txt') -Force
Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'composer') -Filter '*-LICENSE.txt' | Copy-Item -Destination $Bundle -Force
