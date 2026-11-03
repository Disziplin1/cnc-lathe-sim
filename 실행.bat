@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
  echo 처음 실행: 필요한 패키지를 설치합니다...
  call npm install
)
echo 브라우저에서 http://localhost:5180 을 엽니다. 끝내려면 이 창을 닫으세요.
start "" http://localhost:5180
call npx vite --port 5180
