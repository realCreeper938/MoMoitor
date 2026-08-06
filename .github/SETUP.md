# GitHub Actions 构建配置

## 概述

本项目使用 GitHub Actions 自动构建 Windows 可执行文件。当推送以 `v` 开头的 tag 时，
会自动触发构建并创建 GitHub Release。工作流文件：`.github/workflows/build.yml`。

## 配置步骤

1. 进入 GitHub 仓库页面 → **Settings** → **Actions** → **General**
2. 在 **Workflow permissions** 选择 **Read and write permissions**（工作流需创建 Release）
3. 勾选 **Allow GitHub Actions to create and approve pull requests**
4. 点击 **Save**

无需配置任何 Secrets（使用默认 GITHUB_TOKEN）。

## 使用方法

### 方法一：推送 tag 自动发布

```bash
python scripts/build.py release --version 1.1.0   # 提升版本号 + 提交 + 打 tag
git push origin main
git push origin v1.1.0                              # 触发 CI：构建 + 创建 Release
```

### 方法二：手动触发

进入 Actions 页面 → **Build and Release** → **Run workflow**，可选勾选 prerelease。

## 工作流内容

1. 检出代码，安装 Python 3.12
2. `pip install -r requirements-dev.txt`
3. `python scripts/build.py check`（语法检查）
4. `python scripts/build.py build`（PyInstaller onedir → zip + SHA-256）
5. 上传构建产物 `dist/MoMoitor-v*-win64.zip`（保留 30 天）
6. tag 推送时用 softprops/action-gh-release 创建 Release 并挂载 zip

## 故障排查

| 问题 | 处理 |
|---|---|
| 构建失败 | 查看 Actions 日志；本地 `python scripts/build.py build` 复现 |
| Release 未创建 | 确认 tag 以 `v` 开头、Workflow permissions 为 Read and write |
| SmartScreen 提示 | 未签名 exe 属正常现象，README 已说明 |

## 参考链接

- [GitHub Actions 文档](https://docs.github.com/en/actions)
- [PyInstaller 文档](https://pyinstaller.org/)
- [softprops/action-gh-release](https://github.com/softprops/action-gh-release)
