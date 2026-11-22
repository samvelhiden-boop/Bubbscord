@echo off
chcp 65001 >nul
setlocal EnableExtensions
title Установка Bubbscord

rem ================================================================
rem  Bubbscord — установка в один клик.
rem  Ставит (если нет) Git и Node.js, скачивает Vencord и Bubbscord,
rem  собирает, устанавливает в Discord и сразу включает плагин.
rem  Повторный запуск = обновление.
rem ================================================================

set "REPO=https://github.com/samvelhiden-boop/Bubbscord"
set "ROOT=%USERPROFILE%\Bubbscord"
set "SETTINGS=%APPDATA%\Vencord\settings\settings.json"
rem для проверки установщика без трогания Discord: set BUBBS_TEST=C:\some\folder
if defined BUBBS_TEST (
    set "ROOT=%BUBBS_TEST%"
    set "SETTINGS=%BUBBS_TEST%\settings.json"
)
set "VENCORD=%ROOT%\Vencord"
set "PLUGIN=%VENCORD%\src\userplugins\bubbscord"

echo.
echo   ====================================
echo      Bubbscord — установка
echo   ====================================
echo.
echo   Займёт 2-5 минут. Окно не закрывай.
echo.

rem ---------- 1. Git ----------
where git >nul 2>nul
if errorlevel 1 (
    echo [1/6] Ставлю Git...
    winget install --id Git.Git -e --source winget --silent --accept-package-agreements --accept-source-agreements
    set "PATH=%PATH%;%ProgramFiles%\Git\cmd"
)
where git >nul 2>nul
if errorlevel 1 goto :no_git
echo [1/6] Git есть.

rem ---------- 2. Node.js и pnpm ----------
where node >nul 2>nul
if errorlevel 1 (
    echo [2/6] Ставлю Node.js...
    winget install --id OpenJS.NodeJS.LTS -e --source winget --silent --accept-package-agreements --accept-source-agreements
    set "PATH=%PATH%;%ProgramFiles%\nodejs;%APPDATA%\npm"
)
where node >nul 2>nul
if errorlevel 1 goto :no_node
set "PATH=%PATH%;%APPDATA%\npm"
where pnpm >nul 2>nul
if errorlevel 1 (
    echo [2/6] Ставлю pnpm...
    call npm install -g pnpm --silent
)
where pnpm >nul 2>nul
if errorlevel 1 goto :no_pnpm
echo [2/6] Node.js и pnpm есть.

rem ---------- 3. Vencord ----------
if not exist "%ROOT%" mkdir "%ROOT%"
if exist "%VENCORD%\.git" (
    echo [3/6] Обновляю Vencord...
    git -C "%VENCORD%" pull -q
) else (
    echo [3/6] Скачиваю Vencord...
    git clone -q --depth 1 https://github.com/Vendicated/Vencord "%VENCORD%"
)
if not exist "%VENCORD%\package.json" goto :fail_download

rem ---------- 4. Bubbscord ----------
if exist "%PLUGIN%\.git" (
    echo [4/6] Обновляю Bubbscord...
    git -C "%PLUGIN%" pull -q --ff-only
) else (
    echo [4/6] Скачиваю Bubbscord...
    if exist "%PLUGIN%" rmdir /s /q "%PLUGIN%"
    git clone -q "%REPO%" "%PLUGIN%"
)
if not exist "%PLUGIN%\index.tsx" goto :fail_download

rem ---------- 5. Сборка ----------
echo [5/6] Собираю (это самая долгая часть)...
pushd "%VENCORD%"
call pnpm install --frozen-lockfile --silent
if errorlevel 1 ( popd & goto :fail_build )
call pnpm build
if errorlevel 1 ( popd & goto :fail_build )

rem ---------- 6. Установка в Discord ----------
if defined BUBBS_TEST (
    echo [6/6] Проверочный режим — в Discord не устанавливаю.
    popd
    goto :enable
)
echo [6/6] Устанавливаю в Discord (Discord закроется и откроется сам)...
taskkill /IM Discord.exe /F >nul 2>nul
timeout /t 2 /nobreak >nul
node scripts\runInstaller.mjs -- --install -branch auto
if errorlevel 1 ( popd & goto :fail_inject )
popd

:enable
rem включаем плагин в настройках Vencord, чтобы не искать его руками
node -e "const fs=require('fs'),p=require('path'),f=process.argv[1];let s={};try{s=JSON.parse(fs.readFileSync(f,'utf8'))}catch{}s.plugins=s.plugins||{};s.plugins.Bubbscord=Object.assign({},s.plugins.Bubbscord,{enabled:true});fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(s,null,4))" "%SETTINGS%"

if not defined BUBBS_TEST (
    if exist "%LOCALAPPDATA%\Discord\Update.exe" start "" "%LOCALAPPDATA%\Discord\Update.exe" --processStart Discord.exe
)

echo.
echo   ====================================
echo      Готово! Bubbscord установлен.
echo   ====================================
echo.
echo   Discord откроется сам. Настройки: Настройки - Vencord - Plugins - Bubbscord.
echo   Обновления будут приходить уведомлением — нажми на него, и всё обновится само.
echo   Удалить: в папке %VENCORD% выполнить pnpm uninject.
echo.
if not defined BUBBS_TEST pause
exit /b 0

:no_git
echo.
echo   Не получилось поставить Git автоматически.
echo   Скачай и установи его: https://git-scm.com/download/win
echo   Потом запусти этот файл ещё раз.
goto :end_fail

:no_node
echo.
echo   Не получилось поставить Node.js автоматически.
echo   Скачай и установи LTS-версию: https://nodejs.org
echo   Потом запусти этот файл ещё раз.
goto :end_fail

:no_pnpm
echo.
echo   Не получилось поставить pnpm. Закрой это окно и запусти файл ещё раз —
echo   после установки Node.js Windows иногда видит его только в новом окне.
goto :end_fail

:fail_download
echo.
echo   Не получилось скачать файлы. Проверь интернет и запусти ещё раз.
goto :end_fail

:fail_build
echo.
echo   Сборка не прошла. Запусти файл ещё раз; если не поможет — пришли скрин автору.
goto :end_fail

:fail_inject
echo.
echo   Не получилось установить в Discord. Проверь, что Discord установлен, и запусти ещё раз.
goto :end_fail

:end_fail
echo.
if not defined BUBBS_TEST pause
exit /b 1
