## Helm — Universal TV Manager

### Install

**Mac** (Apple Silicon or Intel): open Terminal and paste
```
curl -fsSL https://raw.githubusercontent.com/264jxz4gk4-wq/helm-releases/main/install-mac.sh | bash
```
**Windows**: open PowerShell and paste
```
irm https://raw.githubusercontent.com/264jxz4gk4-wq/helm-releases/main/install-windows.ps1 | iex
```
**Android** (phones and tablets, Android 4.4 and newer): download **Helm.apk** below and open it.

<details><summary>Downloaded the zip instead and got a warning?</summary>

Helm isn't signed with a paid Apple or Microsoft certificate, so your computer warns you the first time. That's expected, and the installers above skip it.

- **Mac**, "cannot be opened because Apple cannot check it": open **System Settings → Privacy & Security**, scroll down and click **Open Anyway** next to Helm. Use **HelmMac.zip** on Apple Silicon Macs (M1 and newer) and **HelmMacIntel.zip** on Intel Macs. Not sure? Apple menu → About This Mac: "Chip" means Apple Silicon, "Processor … Intel" means Intel.
- **Windows**, "Windows protected your PC": click **More info**, then **Run anyway**.
</details>

### What's New in 1.3.11
- **Typing through the paired remote.** On a paired Google TV, text you send from the Remote page goes straight into the TV's search box: instant, no developer options needed, and accents and emoji work too.
- **What's on the TV.** The Remote page shows which app is open and the volume level.
- **Helm turns on developer options for you.** Paired with a code but no developer options yet? On the Remote page, tap **Turn on**: Helm presses the buttons to open Settings, taps the build number 7 times and opens Developer options. You flip the last switch yourself.

### 1.3.10
- **Helm for Android:** clearer messages when pairing the fast remote doesn't finish.

### 1.3.9
- **A faster remote.** On Google TVs and Android TVs, the Remote page offers **Pair** once: type the code the TV shows, and from then on every button goes over one open connection instead of a separate command per press, so presses land right away. Typing, installs and everything else keep using your normal connection.
- **Remote without developer options, now in Helm for Android too.** Phones and tablets get the **Remote only** option on the My TV page, like Mac and Windows.

### 1.3.8
- **Remote without developer options (Mac and Windows).** On a Google TV or Android TV, tap **Remote only** on the My TV page, type the code the TV shows, and Helm's Remote works: arrows, OK, Home, Back, volume, play/pause and power. It uses the same pairing as Google's own TV remote, so there's nothing to turn on in the TV's settings. Installing apps and the other tools still need developer options. Coming to Helm for Android next.

### 1.3.7
- **Turn your TV on from Helm.** Until now, Power over Wi‑Fi could only turn TVs off, because a TV that's off stops answering. Helm now remembers each TV's network address while it's connected, and when you press Power and the TV doesn't answer, it sends the TV a wake-up signal over Wi‑Fi (Wake-on-LAN). Found on the onn. 4K Plus, which keeps a service running just to listen for it. Connect to your TV once after updating so Helm can learn its address.

### 1.3.6
- **Store links checked and updated.** PPSSPP is now 1.20.4 (was 1.17.1), Projectivy 4.72 and Aerial Views 1.8.5. Every other download link was checked and points to the right, current file.

### 1.3.5
- **A simpler layout: four tabs instead of six.** **My TV**, **Remote**, **Apps** and **Help**. The Store and My Apps are now one **Apps** page: what's on your TV at the top, more to add below. Bloatware is now **Clean up**, one tap away on My TV and in Tune-ups. Guides are now **Help**.
- **Setup right after installing.** When an app has a setup step, like Projectivy, Kodi or Aerial Views, Helm offers it as soon as the install finishes, and the button sits next to the app in **On this TV**.

### 1.3.4
- **Projectivy sets itself up.** After installing Projectivy, tap **Finish setup** on its Store card (or in Tune-ups). Helm turns on the permissions Projectivy needs, so the Home button can open it and notification badges work, then opens Projectivy's settings on the TV. No more digging through the TV's Accessibility menu.
- **Button Mapper in one tap.** **Turn on** gives Button Mapper the permission it needs to remap your remote's buttons.

### 1.3.3
- **On TCL TVs, the sleep timer is the TV's own.** Helm now sets the TV's built-in sleep timer, so it shows in the TV's Sleep Timer menu, the TV gives its usual one-minute warning, and a timer set from the TV's menu shows in Helm too. Other TVs keep Helm's own timer.

### 1.3.2
- **Sleep timer on the remote.** Tap the moon key next to Power and the TV goes to sleep in 90 minutes. The time left shows under the key; tap it again to change the time, add 30 minutes or turn it off. The timer runs on the TV itself, so it still goes off if your phone or tablet sleeps or Helm is closed.
- **Tune-ups.** A new card on the Devices page with one-tap fixes for what's on your TV: smoother sports in Kodi, and Aerial Views as your screensaver.
- **Helm's version** now shows next to the logo.

### 1.3.1
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
