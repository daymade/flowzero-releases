# Flowzero Releases

**English** | [中文](README_CN.md)

---

Official release repository for **Flowzero**.

[![Latest Release](https://img.shields.io/github/v/release/daymade/flowzero-releases?display_name=tag&include_prereleases)](https://github.com/daymade/flowzero-releases/releases)
![Platform](https://img.shields.io/badge/platform-macOS%20arm64%20%7C%20Windows%20x64-black)
![Signing](https://img.shields.io/badge/security-Developer%20ID%20%2B%20Notarized-success)

- Beta download endpoint: https://updates-beta.flowzero.app/download
- Release archive and checksums: https://github.com/daymade/flowzero-releases/releases
- Issue tracker: https://github.com/daymade/flowzero-releases/issues

## What This Repository Is

This repository records signed releases and runs the release pipeline.

- Published release tags and their binary archives are hosted here. Intentionally withdrawn releases are removed from distribution and permanently recorded by the [release tombstone policy](.github/release-tombstones.json).
- Normal downloads and automatic updates use the channel-configured Flowzero release origin. The public release workflow writes the same immutable objects to the global R2 mirror and the Beijing OSS mirror before publishing.
- macOS and Windows advance through independent candidate, verification, mirror, R2 platform-pointer CAS, and canary lanes. The Vercel update service reads both platform pointers and adapts them to the existing updater protocols; one platform may remain on an older tag without blocking the other.
- GitHub Release is an asynchronous immutable archive. Archive failure does not roll back a platform that already passed its user-facing canary. Publication verifies the exact immutable asset set first, then uses the bounded attestation matcher/backoff defined in [`.github/scripts/archive-release.mjs`](.github/scripts/archive-release.mjs); a controlled post-publication 404 or empty attestation set remains pending, while other query failures stop immediately. Rerunning a failed archive step resumes verification without uploading or publishing again.
- Build pipeline runs in GitHub Actions.
- Source code is maintained in a private repository.

The private source repository normally dispatches a content-addressed release
intent. The Actions manual entry remains available for recovery, but still
requires the exact private-main source SHA, version, platform set, and variant.

## Release Asset Contract

| Platform | Architecture | Files |
|---|---|---|
| macOS | Apple Silicon (arm64) | `.dmg`, `.zip`, updater integrity metadata |
| Windows | x64 | `Setup.exe`, `RELEASES`, `full.nupkg` |

## Download & Install (macOS)

1. Open the [Apple Silicon beta DMG endpoint](https://updates-beta.flowzero.app/download/mac_arm64). A channel with no published release returns HTTP 404 instead of selecting another channel or an older withdrawn build.
2. Open the downloaded `.dmg`.
3. Open the DMG and drag `Flowzero.app` into `Applications`.
4. Launch Flowzero from `Applications`.

## Download & Install (Windows)

1. Open the [Windows beta installer endpoint](https://updates-beta.flowzero.app/download/windows). A channel with no published release returns HTTP 404 instead of selecting another channel or an older withdrawn build.
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

Then compare it with the SHA-256 in the platform channel manifest or the optional GitHub immutable archive. Automatic update selection comes from the platform pointer, not from the GitHub Release list.

## Release Channels

| Channel | Tag Pattern | Auto-Update Server |
|---|---|---|
| Stable | `vX.Y.Z` | `https://updates.flowzero.app` |
| Beta | `vX.Y.Z-beta.N` | `https://updates-beta.flowzero.app` |

`Beta` releases are published as GitHub Pre-releases.
Promotion is serialized per channel and platform. The canonical tag, current platform version, current-main tombstone policy, content-addressed candidate, and native platform receipt are checked before external writes.

Windows compatibility bridges use a separate qualification-hold lane. The bridge and its planned full target must be built from one exact private-source SHA, whose desktop package version is the planned target version; the smaller bridge version is an output of the dedicated bridge builder, not a second source checkout. Before either immutable tag is reserved, the hold workflow checks out that exact SHA, verifies its package version, and proves it belongs to private `main`, so invalid input cannot permanently consume a version. A held bridge is content-addressed under `channels/<channel>/platforms/windows-x64/legacy-bridges/<tag>/`, and the hold workflow proves the ordinary `current.json` pointer is byte-for-byte unchanged. The source SHA is preserved through the candidate, hold, durable tag reservation, target readback, and final compatibility binding, which fails closed if the target uses another source even at the same version. A hold is not a published release: it has no promotion, canary, or GitHub archive path. A later Windows target that declares a bridge requirement cannot advance `current.json` until its exact immutable hold and a content-addressed old → bridge → target acceptance binding are validated; promotion still performs one platform-pointer CAS.

`Initialize Empty Platform Channel` is only for a platform that has never had a pointer or published snapshot. An existing platform is cleared after an authorized withdrawal only through `Withdraw Platform Channel`, which requires the current tag to be tombstoned and uses ETag CAS.

Withdrawn tags are immutable historical facts in the
[release tombstone policy](.github/release-tombstones.json). Standard release,
mirror, and channel-promotion paths reject them permanently; deleting a GitHub
Release or tag never makes its version reusable.

## FAQ

### Why does auto-update not show a new version?

1. Confirm your app channel (`stable` / `beta`) matches the release tag.
2. Check network access to the update server.
3. Open the channel's direct download link above and install the current package.

### Is this repo open source?

No. This repository is for release distribution and issue tracking.
Flowzero source code is currently private.

### Where should I report bugs?

Please open an issue:
https://github.com/daymade/flowzero-releases/issues

## Build Provenance

- Releases are built by GitHub Actions.
- Published artifacts are uploaded from CI jobs.
- Each requested platform is content-addressed, natively verified, written create-only to R2 and Beijing OSS, and proven by server checksum/metadata plus public HEAD and a one-byte range probe.
- macOS business receipts preserve packaged structure and product-journey evidence; when the verifier emits runtime-dependency-graph evidence, the checkpoint validates and preserves that row while remaining compatible with earlier v2 receipts.
- A platform becomes visible to clients only after its own R2 pointer CAS and update-server/origin canary. GitHub archive creation runs afterward and never gates another platform.
- Short-term CAS replay uses the exact Actions state artifact; long-term recovery uses the immutable R2 checkpoint; missing mirror objects or historical rollback use the exact GitHub archive manifest through `Repair or Roll Back Published Platform`.
- The final notarized macOS ZIP receives a generated SHA-512 integrity sidecar before mirroring; clients consume channel metadata from the update service and stream the versioned ZIP from the mirror.
- macOS artifacts are signed and notarized before publishing.
- Windows artifacts are built in the public release workflow, installer-smoke tested, and published alongside macOS assets when the tag includes the Windows lane.

## License

Flowzero is proprietary software.
