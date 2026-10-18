$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework compiler not found' }
$destination = Join-Path $projectRoot 'dist\Perch'
New-Item -ItemType Directory -Force -Path $destination | Out-Null
foreach ($name in @('src','public','docs','scripts','tests','package.json','package-lock.json','playwright.config.mjs','README.md','README.en.md','LICENSE','CHANGELOG.md')) {
  Copy-Item -LiteralPath (Join-Path $projectRoot $name) -Destination $destination -Recurse -Force
}
Get-ChildItem -LiteralPath $projectRoot -Filter '*.cmd' | Copy-Item -Destination $destination -Force
$launcherName = ([string][char]0x6816) + '.exe'
& $compiler /nologo /codepage:65001 /target:winexe "/out:$destination\$launcherName" "/win32icon:$projectRoot\public\icon.ico" /reference:System.Windows.Forms.dll /reference:Microsoft.CSharp.dll "$projectRoot\src\windows\Launcher.cs"
if ($LASTEXITCODE -ne 0) { throw 'Launcher compilation failed' }
Compress-Archive -LiteralPath $destination -DestinationPath (Join-Path $projectRoot 'dist\Perch-0.2.0-windows.zip') -Force
Write-Output 'Built dist/Perch-0.2.0-windows.zip (requires Node.js 24+)'
