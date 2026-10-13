# Helm for Windows installer. Paste this into PowerShell:
#   irm https://raw.githubusercontent.com/264jxz4gk4-wq/helm-releases/main/install-windows.ps1 | iex
#
# Installs Helm in your user folder (no admin needed), adds Start menu and
# desktop shortcuts and opens it. Files downloaded this way aren't marked
# as "from the internet", so Windows doesn't show the blue "Windows
# protected your PC" screen for them.
$ErrorActionPreference = 'Stop'
$repo = '264jxz4gk4-wq/helm-releases'
$dest = Join-Path $env:LOCALAPPDATA 'Helm'
$tmp = Join-Path $env:TEMP ('helm-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
  Write-Host 'Downloading Helm...'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $zip = Join-Path $tmp 'HelmWindows.zip'
  $ProgressPreference = 'SilentlyContinue'   # the progress bar makes downloads much slower
  Invoke-WebRequest -UseBasicParsing "https://github.com/$repo/releases/latest/download/HelmWindows.zip" -OutFile $zip
  Expand-Archive $zip -DestinationPath $tmp -Force
  $app = Join-Path $tmp 'Helm'
  if (-not (Test-Path (Join-Path $app 'Helm.exe'))) { throw "The download didn't contain Helm.exe. Please try again later." }

  Get-Process Helm -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Milliseconds 500
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  Move-Item $app $dest
  Get-ChildItem $dest -Recurse | Unblock-File

  # Shortcuts start Helm from its own folder (it looks for adb.exe next to itself).
  $shell = New-Object -ComObject WScript.Shell
  foreach ($dir in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))) {
    $link = $shell.CreateShortcut((Join-Path $dir 'Helm.lnk'))
    $link.TargetPath = Join-Path $dest 'Helm.exe'
    $link.WorkingDirectory = $dest
    $link.Save()
  }

  Start-Process (Join-Path $dest 'Helm.exe') -WorkingDirectory $dest
  Write-Host 'Helm is installed. It runs in the system tray; open http://localhost:5001 in your browser, or use the Helm shortcut.'
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
