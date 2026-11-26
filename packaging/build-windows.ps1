$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$temp = (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).Path
$stage = Join-Path $temp ('pachca-build-' + [Guid]::NewGuid().ToString('N'))
$bundle = Join-Path $stage 'Pachca-Codex-win-x64'
$app = Join-Path $bundle 'app'
$nodeVersion = '22.23.5'
$nodeArchiveName = "node-v$nodeVersion-win-x64.zip"
$nodeSha256 = '4a191082e9706866830379d577d2cc8a50c776fcd9436a8d061b063ed0d9a0e3'
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'The .NET Framework C# compiler is required to build the launcher.' }

try {
    New-Item -ItemType Directory -Path $app -Force | Out-Null
    $nodeArchive = Join-Path $stage $nodeArchiveName
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v$nodeVersion/$nodeArchiveName" -OutFile $nodeArchive -UseBasicParsing
    if ((Get-FileHash -LiteralPath $nodeArchive -Algorithm SHA256).Hash -ne $nodeSha256) {
        throw 'The downloaded Node.js archive does not match the checksum in the Node.js release notes.'
    }

    $runtime = Join-Path $stage 'runtime'
    Expand-Archive -LiteralPath $nodeArchive -DestinationPath $runtime
    $nodeFolder = Join-Path $runtime "node-v$nodeVersion-win-x64"
    Copy-Item -LiteralPath (Join-Path $nodeFolder 'node.exe') -Destination $app
    Copy-Item -LiteralPath (Join-Path $nodeFolder 'LICENSE') -Destination (Join-Path $app 'NODE-LICENSE.txt')

    foreach ($file in 'package.json', 'package-lock.json', 'pachca.mjs', 'session.mjs', 'client.mjs', 'mcp.mjs', 'mcp-client.mjs', 'codex.mjs', 'watch-pipe.mjs', 'watch.mjs', 'watch-log.mjs', 'activity-journal.mjs', 'dashboard.mjs', 'openproject.mjs', 'task-links.mjs', 'auto-reply.mjs', 'desktop.mjs', 'desktop-session.mjs', 'reply-memory.mjs', 'communication-profile.mjs', 'participant-directory.mjs', 'images.mjs', 'image-requests.mjs', 'projects.mjs', 'link-preview.mjs', 'chat-lookup.mjs', 'office-preview.mjs', 'unread.mjs', 'bugs.mjs') {
        Copy-Item -LiteralPath (Join-Path $root $file) -Destination $app
    }
    foreach ($file in 'codex-task-session.mjs', 'task-development.mjs', 'task-workspace.mjs', 'task-materials.mjs', 'task-partition.mjs', 'workspace-settings.mjs') {
        Copy-Item -LiteralPath (Join-Path $root $file) -Destination $app
    }
    Push-Location -LiteralPath $app
    try {
        & npm.cmd ci --ignore-scripts --no-audit --no-fund --omit=dev --no-bin-links
        if ($LASTEXITCODE -ne 0) { throw 'Could not install the locked dependencies.' }
    }
    finally {
        Pop-Location
    }

    $exe = Join-Path $bundle 'pachca.exe'
    & $compiler /nologo /target:exe /platform:x64 "/win32icon:$PSScriptRoot\pachca-ai.ico" /optimize+ /codepage:65001 "/out:$exe" (Join-Path $PSScriptRoot 'PortableInstall.cs') (Join-Path $PSScriptRoot 'Launcher.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Could not compile the launcher.' }
    & (Join-Path $PSScriptRoot 'build-desktop.ps1') -Bundle $bundle -Cache (Join-Path $stage 'sdk')
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'README.md') -Destination $bundle
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'codex-instructions.md') -Destination (Join-Path $bundle 'AGENTS.md')
    foreach ($file in 'Connect-Codex.cmd', 'OpenProject-Login.cmd', 'Watch-Pachca.cmd') {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $bundle
    }

    New-Item -ItemType Directory -Path $dist -Force | Out-Null
    $zip = Join-Path $stage 'client.zip'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($bundle, $zip, [IO.Compression.CompressionLevel]::Optimal, $false)
    $version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
    if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'A numeric three-part release version is required.' }
    $attributes = Join-Path $stage 'Version.cs'
    [IO.File]::WriteAllText($attributes, "[assembly: System.Reflection.AssemblyVersion(`"$version.0`")]")
    $portable = Join-Path $stage 'Pachca-AI-win-portable-x64.exe'
    & $compiler /nologo /target:winexe /platform:x64 /optimize+ /codepage:65001 /r:System.Windows.Forms.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll "/win32icon:$PSScriptRoot\pachca-ai.ico" "/resource:$zip,client.zip" "/out:$portable" $attributes (Join-Path $PSScriptRoot 'Bootstrap.cs') (Join-Path $PSScriptRoot 'PortableInstall.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Could not compile the portable client.' }
    Copy-Item -LiteralPath $portable -Destination $dist -Force
    Get-Item -LiteralPath (Join-Path $dist 'Pachca-AI-win-portable-x64.exe')
}
finally {
    if (Test-Path -LiteralPath $stage) {
        $resolvedStage = (Resolve-Path -LiteralPath $stage).Path
        if ((Split-Path -Parent $resolvedStage) -eq $temp -and (Split-Path -Leaf $resolvedStage) -match '^pachca-build-[a-f0-9]{32}$') {
            Remove-Item -LiteralPath $resolvedStage -Recurse -Force
        }
    }
}
