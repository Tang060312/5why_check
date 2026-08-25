@echo off
cd /d %~dp0
echo === 5why_check 自动上传 ===
git add -A
git status --short
git commit -m "update: %date% %time%"
git push
if %errorlevel%==0 (
  echo.
  echo 上传完成，GitHub Pages 将自动重新部署。
) else (
  echo.
  echo 上传失败（可能没有改动，或网络/凭据问题）。
)
pause
