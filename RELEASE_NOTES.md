## Helm — Universal TV Manager

### What's New in 1.2.3
- **Installs report what really happened.** Helm used to show "Installed!" whenever the error didn't contain one particular word, so a failed download looked like success. It now requires the TV to confirm the install, and says why when it doesn't (couldn't download, not enough space, wrong processor type, and so on).
- **Helm for Android:** fixes app downloads failing on Android 4.4 with a certificate error.
- Clearer advice when a TV hasn't approved your device yet.

### 1.2.2
- **Connecting tells you what's wrong.** Helm used to say "Connected" even when the TV refused it, then show an empty app list. It now checks that the TV actually responds, and says why when it doesn't: the TV is waiting for you to approve the device, it needs pairing, debugging is off, or it can't be reached on your Wi-Fi.
- Typing an address with the port (like `192.168.1.78:5555`) now works.
- **Helm for Android:** fixes the built-in adb failing to start on Android 4.4 devices, which left every TV unreachable.

### 1.2.1
- **Helm for Android now runs on Android 4.4 (KitKat) and newer**, including older tablets like the Galaxy Tab 3. On older devices Helm brings its own up-to-date security for app downloads, so installs work even where the device's browser can't open modern websites.

### 1.2.0
- **Helm for Android** — run Helm on an Android phone, tablet or TV box, with no computer. Connect, pair, install and manage apps on your TV directly from the device. 
- **Security fixes for the Mac and Windows apps** — the local server now only runs adb commands, no longer accepts requests from other websites, and verifies downloads (including app updates) over HTTPS. Updating is recommended.

### Downloads
- **Helm.apk** — Android (open it on your device and allow installs from unknown sources)
- **HelmMac.zip** — Mac app (double-click to install)
- **HelmWindows.zip** — Windows app (extract and run Helm.exe)

### Setup
1. Download for your platform
2. Open Helm
3. Connect your TV by IP address
4. Install apps, manage bloatware, and more!
