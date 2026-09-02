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
- macOS 与 Windows 分别经过 candidate、平台验收、双镜像、R2 平台 pointer CAS 和用户可见 canary；一个平台保留旧版本不会阻塞另一个平台。Vercel 更新服务分别读取两个平台 pointer，再适配现有更新协议。
- GitHub Release 是异步 immutable archive；archive 失败不会回滚已经通过 canary 的平台。发布会先验证精确 immutable 资产集合，再按 [`.github/scripts/archive-release.mjs`](.github/scripts/archive-release.mjs) 的 canonical matcher/backoff 有界等待 attestation；发布后受控 404 或空 attestation 集合保持 pending，其他查询错误立即失败。若归档步骤仍失败，重跑只恢复验证，不会再次上传或发布。
- 构建流程通过 GitHub Actions 执行。
- 源码位于私有仓库中维护。

标准入口由私有源码仓 dispatch 内容寻址的 Release Intent。Actions 页面仍保留手动恢复入口，但同样必须填写私有 `main` 上的精确源码 SHA、版本、平台集合与 variant，不会按分支猜源码。

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

再与平台频道 manifest 中的 SHA-256 或可选 GitHub immutable archive 对比。自动更新选择只读平台 pointer，不从 GitHub Release 列表推断。

## 发布通道

| 通道 | Tag 规则 | 自动更新地址 |
|---|---|---|
| Stable | `vX.Y.Z` | `https://updates.flowzero.app` |
| Beta | `vX.Y.Z-beta.N` | `https://updates-beta.flowzero.app` |

`Beta` 版本会以 GitHub Pre-release 形式发布。

Windows 兼容桥接包使用独立的资格验证/暂停通道。桥接 hold 以内容寻址方式写入 `channels/<channel>/platforms/windows-x64/legacy-bridges/<tag>/`；hold 工作流必须证明普通 `current.json` 在动作前后字节完全不变。hold 不是已发布版本：它没有 promotion、canary 或 GitHub archive 出口。后续 Windows 正式目标若声明需要桥接，必须先验证精确不可变 hold 和 old → bridge → target 两跳验收 binding，才能对 `current.json` 执行唯一一次平台 pointer CAS。

`Initialize Empty Platform Channel` 只用于从未存在 pointer 或 published snapshot 的平台。已有平台在获准撤回后清空，必须走 `Withdraw Platform Channel`：当前 tag 必须已经 tombstone，并通过 ETag CAS 切到 `no_release`。

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
- 每个平台的 candidate 都经过内容寻址与原生验收，再以 create-only 写入 R2 和北京 OSS，并用服务端 checksum/metadata、公开 HEAD 和 1-byte range 证明。
- macOS 业务回执会保留包结构与产品旅程证据；verifier 产出运行时依赖图证据时，checkpoint 会严格校验并保留该行，同时兼容早期 v2 回执。
- 平台只有在自己的 R2 pointer CAS 和更新服务/origin canary 通过后才对客户端可见；GitHub archive 随后异步创建，不阻塞另一平台。
- 短期 CAS 续跑使用精确 Actions state artifact；长期恢复使用不可变 R2 checkpoint；镜像对象缺失或历史回滚则通过 `Repair or Roll Back Published Platform` 从 GitHub archive manifest 精确修复。
- 最终公证后的 macOS ZIP 会先生成 SHA-512 完整性 sidecar；客户端从更新服务读取当前通道元数据，再从镜像流式下载版本化 ZIP。
- macOS 产物在发布前完成签名与公证。
- Windows 产物由 public release workflow 构建，在发布前完成 installer smoke，并在该 tag 启用 Windows lane 时与 macOS 产物一起发布。

## License

Flowzero 为专有软件。
