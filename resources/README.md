# 打包资源

当前目录用于放置 Electron Builder 的图标与签名相关资源。

建议结构：

```text
resources/
├─ icon.png        # 1024x1024，Windows/macOS/Linux 通用源图
├─ icon.ico        # Windows（可由 icon.png 生成）
├─ icon.icns       # macOS（可由 icon.png 生成）
└─ entitlements.mac.plist
```

把 1024x1024 的 `icon.png` 放到这里后，`electron-builder.yml` 的 `directories.buildResources` 会自动识别它，并在 Windows/macOS 打包时生成对应格式。

代码签名与公证尚未配置：

- Windows：需要代码签名证书，配置 `CSC_LINK` / `CSC_KEY_PASSWORD`。
- macOS：需要 Developer ID 证书，并配置 `notarize`。
- 自动更新需要额外的发布通道与签名校验。
