@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 푸른약국 장부를 시작합니다. 브라우저에서 http://localhost:3000 을 여세요.
echo 이 창을 닫으면 장부가 꺼집니다.
node --disable-warning=ExperimentalWarning src\server.js
pause
