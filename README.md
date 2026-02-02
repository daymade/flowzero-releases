# Flowzero

**English** | [中文](README_CN.md)

---

**Flowzero** is a speech-to-text desktop application optimized for Chinese.

📥 **[Download Latest Release](https://github.com/daymade/flowzero-releases/releases)**

---

## Download

| Platform | File Format | Architecture |
|----------|-------------|--------------|
| macOS | `.dmg` | Apple Silicon (arm64) / Intel (x64) |
| Windows | `-setup.exe` | x64 |
| Linux | `.AppImage`, `.deb` | x64 |

Go to the [Releases](https://github.com/daymade/flowzero-releases/releases) page to download the version for your system.

---

## Installation Guide

### macOS

#### ⚠️ About Gatekeeper Security Warning

The current release is **not code-signed with Apple Developer ID**. macOS Gatekeeper will block the app from running. This is not malware - we simply haven't joined the Apple Developer Program yet.

**Method 1: Right-click to Open (Recommended)**

1. Download and open the `.dmg` file
2. Drag Flowzero to the Applications folder
3. Find Flowzero.app in Finder
4. **Control-click** (or right-click) the app icon
5. Select "Open" from the context menu
6. Click "Open" again in the confirmation dialog

**Method 2: Via System Settings**

1. Try to open the app - you'll see a blocked message
2. Open "System Settings" → "Privacy & Security"
3. Scroll to the bottom to find the blocked app notice
4. Click "Open Anyway"

**Method 3: Terminal Command (Advanced Users)**

```bash
xattr -d com.apple.quarantine "/Applications/Flowzero.app"
```

If the above command doesn't work, try recursive removal:

```bash
xattr -rd com.apple.quarantine "/Applications/Flowzero.app"
```

---

### Windows

1. Download the `-setup.exe` installer
2. Double-click to run the installer
3. Follow the installation wizard
4. Launch Flowzero from the Start menu

> 💡 If Windows Defender SmartScreen shows an unknown publisher warning, click "More info" → "Run anyway"

---

### Linux

**AppImage (Recommended)**

```bash
# Grant execute permission after download
chmod +x Flowzero-*.AppImage

# Run
./Flowzero-*.AppImage
```

**Debian/Ubuntu (.deb)**

```bash
sudo dpkg -i flowzero-*.deb
```

---

## Update Channels

| Channel | Description | Update Server |
|---------|-------------|---------------|
| **Stable** | Production-ready releases | `https://updates.flowzero.app` |
| **Beta** | Preview releases (version contains `-beta.x`) | `https://updates-beta.flowzero.app` |

The app has built-in auto-update functionality and will automatically check for updates.

---

## FAQ

### macOS shows "Cannot verify developer" - what do I do?

See the three solutions in the "macOS Installation Guide" section above.

### Why is the app not code-signed?

The Apple Developer Program requires an annual fee. We're evaluating whether to join. Being unsigned doesn't affect app functionality - it just requires extra steps on first launch.

### Auto-update not working?

1. Check your network connection
2. Verify you can access the update server
3. Try downloading the latest version manually

### Where can I report issues?

Please submit feedback on the [Issues](https://github.com/daymade/flowzero-releases/issues) page.

---

## Build Info

- All releases are built automatically via GitHub Actions
- Source code is hosted in a private repository

---

## License

Flowzero is proprietary software.
