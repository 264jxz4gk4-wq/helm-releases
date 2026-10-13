# Helm — Universal TV Manager

Set up and manage Fire TV, Google TV and Android TV from your computer, phone or tablet: install apps, remove bloatware, a full remote, and guides.

## Install

**Mac** (Apple Silicon or Intel): open Terminal and paste
```
curl -fsSL https://raw.githubusercontent.com/264jxz4gk4-wq/helm-releases/main/install-mac.sh | bash
```
**Windows**: open PowerShell and paste
```
irm https://raw.githubusercontent.com/264jxz4gk4-wq/helm-releases/main/install-windows.ps1 | iex
```
**Android** (phones and tablets, Android 4.4 and newer): download **Helm.apk** from the [latest release](https://github.com/264jxz4gk4-wq/helm-releases/releases/latest) and open it.

<details><summary>Downloaded the zip instead and got a warning?</summary>

Helm isn't signed with a paid Apple or Microsoft certificate, so your computer warns you the first time. That's expected, and the installers above skip it.

- **Mac**, "cannot be opened because Apple cannot check it": open **System Settings → Privacy & Security**, scroll down and click **Open Anyway** next to Helm. Use **HelmMac.zip** on Apple Silicon Macs (M1 and newer) and **HelmMacIntel.zip** on Intel Macs. Not sure? Apple menu → About This Mac: "Chip" means Apple Silicon, "Processor … Intel" means Intel.
- **Windows**, "Windows protected your PC": click **More info**, then **Run anyway**.
</details>

