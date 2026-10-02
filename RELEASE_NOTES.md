## Helm — Universal TV Manager

### What's New in 1.3.1
- **Smoother sports in Kodi, in one tap.** On the Store's Kodi card, **Smooth sports playback** sets Kodi to switch the TV to each stream's frame rate (no more judder on 25 and 50 fps streams), decode video with the TV's video chip, and keep a bigger buffer (Kodi 21 and newer). Pair it with your TV's own motion smoothing for the smoothest picture.
- **IR remote: no more codes that can't be sent.** Some Android builds report an IR blaster that can't actually transmit, like CyanogenMod 11 on the Galaxy Tab 3. Helm now says so instead of offering codes that do nothing, and if no code works during setup it suggests a quick phone-camera test.

### 1.3.0
- **A new look.** Helm has been redesigned from the ground up: cleaner screens, new icons, and a layout that fits phones (tabs along the bottom), tablets and computers.
- **Remote.** Control your TV from Helm: arrows, OK, back, home, volume, channels, play/pause and power. **Type on your TV** from your keyboard or phone, for searches and Wi‑Fi passwords. On a computer, the arrow keys, Enter and Esc work too.
- **IR blaster support (Helm for Android).** On phones and tablets with an IR blaster, like the Galaxy Tab 3, the remote also works over infrared, so it can turn the TV on, which Wi‑Fi can't. Pick your TV's brand and Helm tries its codes until the TV responds.
- **Six new apps in the Store:** Moonlight (play PC games on the TV), Aerial Views (Apple TV-style screensaver, with one tap to make it your screensaver), TV Bro (a web browser for the remote), LocalSend (send files from your phone), Just Player and Lemuroid (retro games).
- **Removed Wolf Launcher:** its download didn't come from the launcher's developer. Projectivy is still there.
- **Helm for Android runs on the newest phones.** Some phones on Android 15 and later use a different memory layout (16 KB pages) that Helm's built-in adb couldn't run on. Helm now ships its own build that works on them.
- **Security fixes.** On Mac and Windows, other devices on your Wi‑Fi could use Helm's local server to read or write files on your computer. Helm now only accepts the commands it actually uses, and only downloads apps over HTTPS. On Android, a web page open on the same phone or tablet could send Helm commands; Helm now only takes requests from its own screen. Updating is recommended.
- **Windows:** "Find my TV" now works, and black command windows no longer flash up while Helm talks to the TV.

### 1.2.5
- **VLC installs on 32-bit TVs** (like the onn. 4K and many TCL models). Helm only offered the 64-bit build, which those TVs reject.
- **Store updated to the latest versions:** VLC 3.7.1, SmartTube 32.56, Jellyfin 0.19.10, NewPipe 0.29.1, Projectivy 4.71, RetroArch 1.22.2.

### 1.2.4
- **Helm for Android:** fixes app downloads on Android 4.4. Older Android loaded only a handful of Helm's up-to-date security certificates, so downloads from GitHub, where most store apps live, were rejected.

### 1.2.3
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
