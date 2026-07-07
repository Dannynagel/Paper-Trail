@echo off
rem Paper Trail UIA Companion launcher — invoked by Chrome Native Messaging.
rem stdio is passed straight through to PowerShell.
powershell.exe -NoProfile -NoLogo -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0PaperTrailHost.ps1"
