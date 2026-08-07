@echo off
cd /d "%~dp0"
powershell -Command "Start-Process pythonw.exe -ArgumentList '-m','momoitor.main' -Verb RunAs -WorkingDirectory '%~dp0'"