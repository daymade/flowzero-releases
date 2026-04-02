# Flowzero Releases

**English** | [中文](README_CN.md)

---

Official release repository for **Flowzero**.

[![Latest Release](https://img.shields.io/github/v/release/daymade/flowzero-releases?display_name=tag&include_prereleases)](https://github.com/daymade/flowzero-releases/releases)
![Platform](https://img.shields.io/badge/platform-macOS%20arm64%20%7C%20Windows%20x64-black)
![Signing](https://img.shields.io/badge/security-Developer%20ID%20%2B%20Notarized-success)

- Download page: https://github.com/daymade/flowzero-releases/releases
- Issue tracker: https://github.com/daymade/flowzero-releases/issues

## What This Repository Is

This repository publishes signed release artifacts for end users.

- Release binaries and tags are hosted here.
- Build pipeline runs in GitHub Actions.
- Source code is maintained in a private repository.

## Platform Availability

| Platform | Architecture | Status | Files |
|---|---|---|---|
| macOS | Apple Silicon (arm64) | Available | `.dmg`, `.zip` |
| Windows | x64 | Published when the release tag includes Windows assets | `Setup.exe`, `RELEASES`, `full.nupkg` |

## Download & Install (macOS)

1. Open the [Releases](https://github.com/daymade/flowzero-releases/releases) page.
2. Download the latest `.dmg` (recommended).
3. Open the DMG and drag `Flowzero.app` into `Applications`.
4. Launch Flowzero from `Applications`.

## Download & Install (Windows)

If a release tag includes Windows assets:

1. Download the latest `Flowzero-*-Setup.exe`.
2. Run the installer.
3. Launch Flowzero from the Start menu or desktop shortcut.

`RELEASES` and `*.nupkg` are updater artifacts, not the normal manual-install files.

## Security: Signing & Notarization

Official macOS packages in this repository are:

- Signed with Apple Developer ID
- Notarized by Apple (Gatekeeper-compatible)

Optional local verification:

```bash
codesign --verify --deep --strict --verbose=2 "/Applications/Flowzero.app"
spctl --assess --type execute --verbose "/Applications/Flowzero.app"
```

## Integrity Check (Optional)

After download, compute SHA256 locally:

```bash
shasum -a 256 Flowzero-*.dmg
shasum -a 256 Flowzero-*.zip
```

Then compare with the checksum shown in the corresponding GitHub Release asset details/API response.

## Release Channels

| Channel | Tag Pattern | Auto-Update Server |
|---|---|---|
| Stable | `vX.Y.Z` | `https://updates.flowzero.app` |
| Beta | `vX.Y.Z-beta.N` | `https://updates-beta.flowzero.app` |

`Beta` releases are published as GitHub Pre-releases.

## FAQ

### Why does auto-update not show a new version?

1. Confirm your app channel (`stable` / `beta`) matches the release tag.
2. Check network access to the update server.
3. Download and install from Releases manually if needed.

### Is this repo open source?

No. This repository is for release distribution and issue tracking.
Flowzero source code is currently private.

### Where should I report bugs?

Please open an issue:
https://github.com/daymade/flowzero-releases/issues

## Build Provenance

- Releases are built by GitHub Actions.
- Published artifacts are uploaded from CI jobs.
- macOS artifacts are signed and notarized before publishing.
- Windows artifacts are built in the public release workflow, installer-smoke tested, and published alongside macOS assets when the tag includes the Windows lane.

## License

Flowzero is proprietary software.
