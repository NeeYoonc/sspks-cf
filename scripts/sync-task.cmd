@echo off
chcp 65001 >nul
rem 计划任务入口：同步 NeeYoonc/dsh-nas 最新 Release 到本套件源，并写日志。
rem 由 Windows 计划任务 "sspks-cf sync" 每 15 分钟调用一次。
setlocal
cd /d "%~dp0.."
if not exist logs mkdir logs

rem 日志超过 2 MB 轮换一次（只保留一个旧文件）
if exist "logs\sync.log" if exist "logs\sync.log.old" del /q "logs\sync.log.old"
if exist "logs\sync.log" for %%A in ("logs\sync.log") do if %%~zA GTR 2000000 move /y "logs\sync.log" "logs\sync.log.old" >nul

echo [%date% %time%] --- sync start --- >> "logs\sync.log"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0sync-latest-release.ps1" >> "logs\sync.log" 2>&1
set RC=%ERRORLEVEL%
echo [%date% %time%] --- sync exit %RC% --- >> "logs\sync.log"
exit /b %RC%
