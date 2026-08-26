@echo off
cd /d "%~dp0"
rem 优先使用当前目录下的虚拟环境
set "PYTHONW=pythonw.exe"
if exist "%~dp0.venv\Scripts\pythonw.exe" set "PYTHONW=%~dp0.venv\Scripts\pythonw.exe"
if exist "%~dp0venv\Scripts\pythonw.exe" set "PYTHONW=%~dp0venv\Scripts\pythonw.exe"
powershell -Command "Start-Process -FilePath '%PYTHONW%' -ArgumentList '-m','momoitor.main' -Verb RunAs -WorkingDirectory '%~dp0'"