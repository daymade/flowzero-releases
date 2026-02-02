# Flowzero

[English](README.md) | **中文**

---

**Flowzero** 是一款专为中文优化的语音转文字桌面应用。

📥 **[下载最新版本](https://github.com/daymade/flowzero-releases/releases)**

---

## 下载

| 平台 | 文件格式 | 架构 |
|------|----------|------|
| macOS | `.dmg` | Apple Silicon (arm64) / Intel (x64) |
| Windows | `-setup.exe` | x64 |
| Linux | `.AppImage`, `.deb` | x64 |

前往 [Releases](https://github.com/daymade/flowzero-releases/releases) 页面下载适合你系统的版本。

---

## 安装指南

### macOS

#### ⚠️ 关于 Gatekeeper 安全提示

当前发布的版本**未进行 Apple 代码签名**，macOS Gatekeeper 会阻止应用运行。这不是恶意软件，只是因为我们尚未加入 Apple 开发者计划。

**方法 1：右键打开（推荐）**

1. 下载 `.dmg` 文件并打开
2. 将 Flowzero 拖入「应用程序」文件夹
3. 在访达中找到 Flowzero.app
4. **按住 Control 键点击**（或右键点击）应用图标
5. 选择「打开」
6. 在弹出对话框中再次点击「打开」

**方法 2：通过系统设置**

1. 尝试打开应用，会看到被阻止的提示
2. 打开「系统设置」→「隐私与安全性」
3. 滚动到底部，找到被阻止的应用提示
4. 点击「仍要打开」

**方法 3：终端命令（技术用户）**

```bash
xattr -d com.apple.quarantine "/Applications/Flowzero.app"
```

如果上述命令无效，尝试递归清除：

```bash
xattr -rd com.apple.quarantine "/Applications/Flowzero.app"
```

---

### Windows

1. 下载 `-setup.exe` 安装程序
2. 双击运行安装程序
3. 按照安装向导完成安装
4. 从开始菜单启动 Flowzero

> 💡 如果 Windows Defender SmartScreen 提示未知发布者，点击「更多信息」→「仍要运行」

---

### Linux

**AppImage（推荐）**

```bash
# 下载后赋予执行权限
chmod +x Flowzero-*.AppImage

# 运行
./Flowzero-*.AppImage
```

**Debian/Ubuntu (.deb)**

```bash
sudo dpkg -i flowzero-*.deb
```

---

## 更新通道

| 通道 | 说明 | 更新服务器 |
|------|------|------------|
| **Stable** | 生产就绪版本 | `https://updates.flowzero.app` |
| **Beta** | 预览版本（版本号含 `-beta.x`） | `https://updates-beta.flowzero.app` |

应用内置自动更新功能，会自动检查并提示更新。

---

## 常见问题

### macOS 提示"无法验证开发者"怎么办？

参见上方「macOS 安装指南」中的三种解决方法。

### 为什么没有代码签名？

Apple 开发者计划需要年费，我们正在评估是否加入。未签名不影响应用功能，只是首次打开需要额外步骤。

### 自动更新不工作？

1. 确认网络连接正常
2. 检查是否能访问更新服务器
3. 尝试手动下载最新版本

### 在哪里反馈问题？

请在 [Issues](https://github.com/daymade/flowzero-releases/issues) 页面提交问题反馈。

---

## 构建信息

- 所有发布版本通过 GitHub Actions 自动构建
- 源码托管在私有仓库

---

## License

Flowzero 是专有软件。
