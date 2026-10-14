<# :
@echo off
rem Sets up label printing for katasync on this computer: installs QZ Tray if
rem it's missing, makes it trust katasync, locks it down to what katasync
rem uses, and restarts it. Safe to run again.
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
function Get-QzVersion {
	if (Test-Path "$qz\qz-tray.exe") {
		$reportedVersion = (Get-Item "$qz\qz-tray.exe").VersionInfo.ProductVersion
		if ($reportedVersion -match '^(\d+\.\d+\.\d+)') { return [version]$Matches[1] }
	}
	return [version]'0.0.0'
}
$certificate = @'
KATASYNC_CERTIFICATE
'@

# Run as admin (the script starts itself this way): install QZ Tray, set its
# properties, write the certificate into its folder, and stop it so it reads
# them.
if ($env:KATASYNC_STEP -eq 'admin') {
	try {
		$version = '2.3.0'
		$installedVersion = Get-QzVersion
		if ($installedVersion -lt [version]$version) {
			# A version we've checked, matched by hash, so a changed or newer
			# release on GitHub can't slip in. To move to a newer one, take the
			# SHA-256s from its release page.
			$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x86_64' }
			$sha256 = @{
				'x86_64' = '7a44a50f679f0a1dab6679e6c22158dd335511074f5fcc1b208b6f9caf711ba7'
				'arm64' = '10e308b91d84b637520eb36096cb6814b33a66f3cabc317ce776253e759babc8'
			}[$arch]
			# A new folder in Program Files, which only admins can write to from
			# the moment it exists, so nothing else on the computer can swap the
			# installer between download and run.
			$stage = Join-Path $env:ProgramFiles "katasync-setup-$([guid]::NewGuid())"
			New-Item -ItemType Directory -Path $stage | Out-Null
			try {
				$installer = Join-Path $stage "qz-tray-$version-$arch.exe"
				Write-Host "Downloading QZ Tray $version..."
				[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
				Invoke-WebRequest "https://github.com/qzind/tray/releases/download/v$version/qz-tray-$version-$arch.exe" -OutFile $installer -UseBasicParsing
				if ((Get-FileHash $installer -Algorithm SHA256).Hash -ne $sha256) {
					throw "The QZ Tray download isn't the one katasync expects. Nothing was installed."
				}
				Write-Host "Installing QZ Tray $version..."
				# Waits for the installer only: -Wait would also wait for the QZ Tray
				# it starts, which keeps running.
				$installProcess = Start-Process $installer -ArgumentList '/S' -PassThru
				$installProcess.WaitForExit()
				if ($installProcess.ExitCode -ne 0) { throw "QZ Tray installer failed with exit code $($installProcess.ExitCode)." }
			} finally {
				Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
			}
			if ((Get-QzVersion) -lt [version]$version) { throw "QZ Tray $version didn't install." }
		}
		# katasync only needs QZ to print to this computer's printers, so turn
		# off what it doesn't use: listening beyond this computer, reading and
		# writing files, and printing to a web address.
		$properties = "$qz\qz-tray.properties"
		$locked = [ordered]@{
			'security.wss.host' = '127.0.0.1'
			'security.file.enabled' = 'false'
			'security.print.tohost' = 'false'
		}
		$kept = if (Test-Path $properties) {
			Get-Content $properties | Where-Object { ($_ -split '=', 2)[0].Trim() -notin $locked.Keys }
		} else { @() }
		$lines = @($kept) + @($locked.Keys | ForEach-Object { "$_=$($locked[$_])" })
		Set-Content -Path $properties -Value $lines -Encoding Ascii
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
	$file = Join-Path $env:TEMP "katasync-$([guid]::NewGuid()).crt"
	Set-Content -Path $file -Value $certificate -Encoding Ascii
	$allowed = $false
	if (Test-Path "$qz\qz-tray-console.exe") {
		& "$qz\qz-tray-console.exe" --allow $file | Out-Null
		$allowed = $LASTEXITCODE -eq 0
	}
	Remove-Item $file

	# QZ reads this person's own preferences before its install-wide ones, so
	# file access goes off here too. Each person who prints needs this run.
	$prefsDir = Join-Path $env:APPDATA 'qz'
	New-Item -ItemType Directory -Path $prefsDir -Force | Out-Null
	$prefs = Join-Path $prefsDir 'prefs.properties'
	$kept = if (Test-Path $prefs) {
		Get-Content $prefs | Where-Object { ($_ -split '=', 2)[0].Trim() -ne 'security.file.enabled' }
	} else { @() }
	Set-Content -Path $prefs -Value (@($kept) + 'security.file.enabled=false') -Encoding Ascii

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
