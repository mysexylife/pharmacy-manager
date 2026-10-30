@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 약국 Wi-Fi에 연결된 폰에서도 접속할 수 있게 엽니다. (암호화되지 않으므로 약국 내부망에서만 사용)
set HOST=0.0.0.0
echo 푸른약국 장부(약국 Wi-Fi 공개)를 시작합니다. 이 창을 닫으면 꺼집니다.
node --disable-warning=ExperimentalWarning src\server.js
pause
