@echo off
REM 招聘作战台 - 启动脚本（双击运行）
REM 本脚本位于 workbench/ 目录内，自动定位当前目录
cd /d %~dp0
echo Starting recruit workbench on http://localhost:5173 ...
node server.mjs
pause
