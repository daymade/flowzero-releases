# Flowzero Releases

[English](README.md) | **中文**

---

这是 **Flowzero** 的官方发布仓库。

[![Latest Release](https://img.shields.io/github/v/release/daymade/flowzero-releases?display_name=tag&include_prereleases)](https://github.com/daymade/flowzero-releases/releases)
![Platform](https://img.shields.io/badge/platform-macOS%20arm64%20%7C%20Windows%20x64-black)
![Signing](https://img.shields.io/badge/security-Developer%20ID%20%2B%20Notarized-success)

- 测试版下载入口：https://updates-beta.flowzero.app/download
- 历史版本与校验信息：https://github.com/daymade/flowzero-releases/releases
- 问题反馈：https://github.com/daymade/flowzero-releases/issues

## 仓库定位

本仓库记录签名版本并运行发布流水线。

- 已发布版本的标签和二进制归档在这里维护。主动撤回的版本会从分发链移除，并永久记录在[版本撤回 tombstone 权威表](.github/release-tombstones.json)。
- 普通下载和自动更新使用当前通道明确选择的 Flowzero 发布源；发布流程会在正式发布前把同一份不可变产物写入全球 R2 镜像和北京 OSS 镜像。
- macOS 与 Windows 的 GitHub draft 资产验收都通过后，CI 才将 draft 转为正式发布，生成不可变的通道快照并原子推进 R2 `current.json` 指针。Vercel 更新服务只读取这一个快照，再适配现有 macOS 与 Windows 更新协议。
- 构建流程通过 GitHub Actions 执行。
- 源码位于私有仓库中维护。

## 发布资产契约

| 平台 | 架构 | 文件 |
|---|---|---|
| macOS | Apple Silicon (arm64) | `.dmg`、`.zip`、更新完整性元数据 |
| Windows | x64 | `Setup.exe`, `RELEASES`, `full.nupkg` |

## 下载与安装（macOS）

1. 打开 [Apple Silicon 测试版 DMG 入口](https://updates-beta.flowzero.app/download/mac_arm64)。通道没有已发布版本时返回 HTTP 404，不会自动选择另一通道或已撤回旧版本。
2. 打开下载的 `.dmg`。
3. 打开 DMG，将 `Flowzero.app` 拖入 `Applications`。
4. 从 `Applications` 启动 Flowzero。

## 下载与安装（Windows）

1. 打开 [Windows 测试版安装器入口](https://updates-beta.flowzero.app/download/windows)。通道没有已发布版本时返回 HTTP 404，不会自动选择另一通道或已撤回旧版本。
2. 运行安装器
3. 从开始菜单或桌面快捷方式启动 Flowzero

`RELEASES` 和 `*.nupkg` 是自动更新使用的产物，不是普通手动安装文件。

## 安全说明：签名与公证

本仓库的官方 macOS 发布包：

- 已使用 Apple Developer ID 完成签名
- 已通过 Apple notarization（兼容 Gatekeeper）

可选本地校验命令：

```bash
codesign --verify --deep --strict --verbose=2 "/Applications/Flowzero.app"
spctl --assess --type execute --verbose "/Applications/Flowzero.app"
```

## 完整性校验（可选）

下载后可在本地计算 SHA256：

```bash
shasum -a 256 Flowzero-*.dmg
shasum -a 256 Flowzero-*.zip
```

再与对应 GitHub Release 的资产详情/API 中展示的 checksum 对比。镜像与 GitHub 归档在发布前由 CI 对同一份产物完成校验。

## 发布通道

| 通道 | Tag 规则 | 自动更新地址 |
|---|---|---|
| Stable | `vX.Y.Z` | `https://updates.flowzero.app` |
| Beta | `vX.Y.Z-beta.N` | `https://updates-beta.flowzero.app` |

`Beta` 版本会以 GitHub Pre-release 形式发布。

通道没有匹配的已发布版本时——包括首个版本发布前和获准撤回后——可运行
显式的 `Initialize Empty Update Channel` workflow 写入 `no_release` 快照；
只要该通道仍有匹配的已发布版本，workflow 就会拒绝清空。

撤回标签是[版本撤回 tombstone 权威表](.github/release-tombstones.json)中的
不可变历史事实。标准发布、补镜像和频道提升路径都会永久拒绝这些标签；
删除 GitHub Release 或 tag 不会让版本号重新可用。

## 常见问题

### 为什么自动更新没有出现新版本？

1. 确认应用通道（`stable` / `beta`）与版本标签一致。
2. 检查是否可访问更新服务器。
3. 打开上方对应通道的直接下载链接并安装当前版本。

### 这是开源仓库吗？

不是。本仓库用于发布分发与问题跟踪。
Flowzero 源码目前在私有仓库维护。

### 在哪里反馈问题？

请在这里提交 Issue：  
https://github.com/daymade/flowzero-releases/issues

## 构建来源说明

- 发布版本由 GitHub Actions 构建。
- 发布产物由 CI 流程上传。
- GitHub release draft 创建前，CI 会先把完整发布清单镜像到 R2 和北京 OSS，并通过两个公开源完成验证。
- 只有 macOS 与 Windows 的 draft 资产验收通过、GitHub draft 转为正式发布并完成通道指针推进后，新版本才会对自动更新客户端可见。重新运行 `Mirror Published Release` 可以修复指针，或在显式允许时回滚到旧发布，无需重新构建二进制；`mirror_assets` 输入决定是否重新校验已验证过的二进制镜像。
- 最终公证后的 macOS ZIP 会先生成 SHA-512 完整性 sidecar；客户端从更新服务读取当前通道元数据，再从镜像流式下载版本化 ZIP。
- macOS 产物在发布前完成签名与公证。
- Windows 产物由 public release workflow 构建，在发布前完成 installer smoke，并在该 tag 启用 Windows lane 时与 macOS 产物一起发布。

## License

Flowzero 为专有软件。
