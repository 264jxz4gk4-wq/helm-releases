@echo off
echo Building Helm for Windows...
pip install pystray pillow flask requests pyinstaller

REM Download ADB for Windows if not present
if not exist adb.exe (
    echo Downloading ADB...
    curl -L "https://dl.google.com/android/repository/platform-tools-latest-windows.zip" -o platform-tools.zip
    tar -xf platform-tools.zip platform-tools/adb.exe platform-tools/AdbWinApi.dll platform-tools/AdbWinUsbApi.dll
    copy platform-tools\adb.exe adb.exe
    copy platform-tools\AdbWinApi.dll AdbWinApi.dll
    copy platform-tools\AdbWinUsbApi.dll AdbWinUsbApi.dll
    rmdir /s /q platform-tools
    del platform-tools.zip
)

pyinstaller --onefile --windowed --name "Helm" ^
    --add-data "ui;ui" ^
    --add-binary "adb.exe;." ^
    --add-binary "AdbWinApi.dll;." ^
    --add-binary "AdbWinUsbApi.dll;." ^
    --icon helm.ico ^
    menubar_windows.py --noconfirm

echo Done! Helm.exe is in dist/
pause
