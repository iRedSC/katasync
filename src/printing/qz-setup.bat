<# :
@echo off
rem Sets up label printing for katasync on this computer: installs QZ Tray if
rem it's missing, makes it trust katasync, and restarts it. Safe to run again.
rem The batch part only starts PowerShell on this same file; the rest is
rem PowerShell, which skips this block as a comment.
set "KATASYNC_SETUP=%~f0"
set "KATASYNC_STEP=%~1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ([IO.File]::ReadAllText($env:KATASYNC_SETUP))"
exit /b %errorlevel%
#>

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$qz = Join-Path $env:ProgramFiles 'QZ Tray'
$certificate = @'
KATASYNC_CERTIFICATE
'@

# Run as admin (the script starts itself this way): install QZ Tray, write
# the certificate into its folder, and stop it so it reads the certificate.
if ($env:KATASYNC_STEP -eq 'admin') {
	try {
		if (-not (Test-Path "$qz\qz-tray.exe")) {
			Write-Host 'Downloading QZ Tray...'
			[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
			$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x86_64' }
			$release = Invoke-RestMethod 'https://api.github.com/repos/qzind/tray/releases/latest'
			$asset = $release.assets | Where-Object { $_.name -like "*-$arch.exe" } | Select-Object -First 1
			if (-not $asset) { throw "Couldn't find QZ Tray $($release.name) for $arch on GitHub." }
			$installer = Join-Path $env:TEMP $asset.name
			Invoke-WebRequest $asset.browser_download_url -OutFile $installer -UseBasicParsing
			Write-Host "Installing QZ Tray $($release.name)..."
			# Waits for the installer only: -Wait would also wait for the QZ Tray
			# it starts, which keeps running.
			(Start-Process $installer -ArgumentList '/S' -PassThru).WaitForExit()
			Remove-Item $installer
			if (-not (Test-Path "$qz\qz-tray.exe")) { throw "QZ Tray didn't install." }
		}
		Get-Process | Where-Object { $_.Path -like "$qz\*" } | Stop-Process -Force
		Set-Content -Path "$qz\override.crt" -Value $certificate -Encoding Ascii
		exit 0
	} catch {
		Write-Host $_ -ForegroundColor Red
		Read-Host 'Press Enter to close'
		exit 1
	}
}

# Run as the person at the computer: get the admin part done, then allow
# katasync and start QZ Tray as them, not as admin.
try {
	Write-Host 'Setting up label printing for katasync. Click Yes when Windows asks.'
	try {
		$admin = Start-Process $env:KATASYNC_SETUP -ArgumentList 'admin' -Verb RunAs -PassThru
	} catch {
		throw 'Setup needs Yes on the Windows prompt. Run it again and click Yes.'
	}
	$admin.WaitForExit()
	if ($admin.ExitCode -ne 0) { throw 'Setup stopped before it finished. See the other window for why.' }

	# Allowing ahead of time skips QZ's "Allow katasync?" question on the
	# first print. If it doesn't take, QZ asks once instead.
	$file = Join-Path $env:TEMP 'katasync-qz.crt'
	Set-Content -Path $file -Value $certificate -Encoding Ascii
	$allowed = $false
	if (Test-Path "$qz\qz-tray-console.exe") {
		& "$qz\qz-tray-console.exe" --allow $file | Out-Null
		$allowed = $LASTEXITCODE -eq 0
	}
	Remove-Item $file

	Start-Process "$qz\qz-tray.exe"
	Write-Host ''
	Write-Host 'Done. Label printing is set up on this computer.' -ForegroundColor Green
	if (-not $allowed) {
		Write-Host 'The first time katasync prints, QZ Tray asks about it: tick Remember and click Allow.'
	}
} catch {
	Write-Host $_ -ForegroundColor Red
}
Read-Host 'Press Enter to close'
