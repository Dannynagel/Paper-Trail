<#
.SYNOPSIS
    Registers the Paper Trail UIA Companion as a Chrome/Edge Native Messaging host.

.DESCRIPTION
    Writes com.papertrail.uia.json next to this script and registers it under
    HKCU for Chrome and Edge (per-user, no admin required).

.PARAMETER ExtensionId
    Your unpacked extension's ID from chrome://extensions (32 lowercase letters).

.PARAMETER Uninstall
    Remove the registry keys and manifest.

.EXAMPLE
    .\Install-PaperTrailHost.ps1 -ExtensionId abcdefghijklmnopabcdefghijklmnop
#>
param(
    [Parameter(Mandatory = $true, ParameterSetName = "Install")]
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId,

    [Parameter(ParameterSetName = "Uninstall")]
    [switch]$Uninstall
)

$HostName = "com.papertrail.uia"
$Dir = $PSScriptRoot
$ManifestPath = Join-Path $Dir "$HostName.json"
$RegPaths = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
)

if ($Uninstall) {
    foreach ($rp in $RegPaths) {
        if (Test-Path $rp) { Remove-Item $rp -Force; Write-Host "Removed $rp" }
    }
    if (Test-Path $ManifestPath) { Remove-Item $ManifestPath -Force; Write-Host "Removed $ManifestPath" }
    Write-Host "Paper Trail UIA Companion uninstalled." -ForegroundColor Green
    return
}

$BatPath = Join-Path $Dir "PaperTrailHost.bat"
if (-not (Test-Path $BatPath)) {
    Write-Host "PaperTrailHost.bat not found next to this script." -ForegroundColor Red
    exit 1
}

$Manifest = [ordered]@{
    name            = $HostName
    description     = "Paper Trail UIA Companion - semantic desktop capture"
    path            = $BatPath
    type            = "stdio"
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
$Manifest | ConvertTo-Json | Set-Content $ManifestPath -Encoding UTF8
Write-Host "Wrote host manifest: $ManifestPath"

foreach ($rp in $RegPaths) {
    New-Item -Path $rp -Force | Out-Null
    Set-ItemProperty -Path $rp -Name "(default)" -Value $ManifestPath
    Write-Host "Registered $rp"
}

Write-Host ""
Write-Host "Installed. In the Paper Trail side panel, click '⚡ UIA companion' to connect." -ForegroundColor Green
Write-Host "Note: reinstall with the new ID if you ever reload the extension from a different folder." -ForegroundColor Yellow
