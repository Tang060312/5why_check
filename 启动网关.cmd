@echo off
chcp 65001 >nul
title 5Why 审核工具 - 内网网关
cd /d "%~dp0"

set "CFG=server\.local-config.cmd"
if exist "%CFG%" call "%CFG%"

if not "%AI_API_KEY%"=="" goto run

echo.
echo ============================================================
echo  首次运行：需要一个大模型 API Key
echo ------------------------------------------------------------
echo  推荐用智谱开放平台（有完全免费的档位）：
echo    1) 浏览器打开 https://bigmodel.cn 注册并登录
echo    2) 进入「API Keys」新建一个，复制出来
echo    3) 回到这里粘贴后回车（只保存在本机，不会上传）
echo ============================================================
echo.
set /p AI_API_KEY=请粘贴 API Key 后回车: 
if "%AI_API_KEY%"=="" goto nokey

> "%CFG%" echo set "AI_API_KEY=%AI_API_KEY%"
>> "%CFG%" echo set "AI_ENDPOINT=https://open.bigmodel.cn/api/paas/v4/chat/completions"
>> "%CFG%" echo set "AI_MODEL=glm-4.7-flash"
>> "%CFG%" echo set "AI_CONCURRENCY=1"
>> "%CFG%" echo set "AI_QUEUE_LIMIT=20"
>> "%CFG%" echo set "AI_RETRY_BASE_MS=3000"
echo.
echo 已保存到 %CFG% —— 该文件不会被提交到代码仓库。
echo 以后要换 Key / 换模型 / 改队列人数，直接编辑这个文件再重新双击本文件即可。
echo.

:run
where node >nul 2>nul
if errorlevel 1 goto nonode

cd server
if not exist node_modules (
  echo 首次运行，正在安装依赖（需要联网，大约 1 分钟）...
  call npm install
  if errorlevel 1 goto npmfail
)

echo.
echo ============================================================
echo  网关启动中，请稍候...
echo ------------------------------------------------------------
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do echo   本机局域网地址可能是: http://%%a:3001
echo.
echo  把上面那个地址（IP:3001）发给大家，他们用浏览器打开就能用，
echo  不需要填任何 Key，也不会因为多人同时提交而报错。
echo.
echo  【本窗口不要关闭】关闭窗口 = 服务停止。
echo ============================================================
echo.
node server.js
pause
exit /b 0

:nokey
echo.
echo 未填写 Key，已退出。
pause
exit /b 1

:npmfail
echo.
echo 依赖安装失败，请检查这台机器能否联网，然后重试。
pause
exit /b 1

:nonode
echo.
echo 未检测到 Node.js。
echo 请先到 https://nodejs.org 下载 LTS 版本安装（一路“下一步”即可），
echo 装完关掉本窗口，再重新双击本文件。
echo.
pause
exit /b 1
