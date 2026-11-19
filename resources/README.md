# 打包资源

品牌图标与 Electron Builder 打包资源。

```text
resources/
├─ icon.png        # 1024x1024 应用图标源图
├─ icon-light.png  # 浅色背景版本
├─ icon.ico        # Windows 多尺寸图标
├─ icon.icns       # macOS 图标
├─ icon.svg        # 应用图标矢量源
└─ README.md
```

`electron-builder.yml` 已分别指定 Windows、macOS 和 Linux 使用的图标文件。

代码签名与公证尚未配置：

- Windows：需要代码签名证书，配置 `CSC_LINK` / `CSC_KEY_PASSWORD`。
- macOS：需要 Developer ID 证书，并配置 `notarize`。
