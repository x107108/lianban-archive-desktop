# Mac 共享版

Mac 与 Windows 使用同一套业务源码、页面、字体、公开初始档案和发布标签，版本由各自安装包的 VERSION.json 提供。新增个人数据导入不改变原有查询和编辑功能。

## 安装

支持 Apple 芯片（arm64）与 Intel（x86_64），分别提供独立的 `.tar.gz` 完整包。无需预装 Python、Homebrew、Node.js 或 Codex，无需管理员权限。当前自动验收系统为 macOS 15；更早系统及 Safari 的完整交互需另行实机确认。

在终端执行：

```bash
curl -fsSL https://raw.githubusercontent.com/x107108/lianban-archive-desktop/main/install-online-macos.sh -o "$HOME/Downloads/lianban-install.sh"
bash "$HOME/Downloads/lianban-install.sh"
```

入口仅安装最新正式 Release，按本机芯片选择安装包并核对 SHA-256，不从待发布 main 拼装程序。默认位置为 `~/Library/Application Support/LianbanArchive`；需要其他位置时，运行前设置 `LIANBAN_INSTALL_DIR`。可以加 `--no-browser` 只启动不打开页面。

下载后离线安装：从正式 Release 下载匹配芯片的包及 SHA256SUMS.txt，核对 SHA-256 后完整解压，双击“安装连板档案.command”，再双击“启动连板档案.command”。停止和检查分别使用“停止连板档案.command”“校验连板档案.command”。系统若要求确认打开下载的启动脚本，按 macOS 自己的提示操作；不关闭系统保护。包内入口没有 Apple 开发者签名或公证。

## 更新和个人数据

在线安装入口管理的版本会保留旧目录，升级前停止原副本并生成 SQLite 一致性快照，复制完整个人数据库到新版本，验证启动后才切换默认入口；启动失败时尝试恢复此前正在运行的版本。同版本复用当前副本。不会接管未知目录，也不会清空文件。

手动下载版升级：停止旧版，用旧版自带运行环境运行 `backup_db.py` 生成一致性快照，然后将快照放到新版 `data/archive.sqlite3`，再安装启动。不得在运行中只复制主数据库文件，不得使用发布初始库覆盖个人库。

从线上迁移：在原浏览器和原域名打开网站，点击右上角“迁移到共享版”，导出 JSON。打开 Mac/Windows 新版共享版，点击“导入个人数据”，选择文件、核对数量，再点击“备份并导入”。标签归属、标签层级、备注历史（含删除状态和空日期）、黑名单及股东屏蔽选择随文件迁移。保留本机已有标签和备注；同名层级冲突、本机已有股东屏蔽选择以本机为准。导入前快照在 `data/backups/`，重复导入同一份文件不重复添加。

迁移文件含私人备注，不进入仓库或公共初始档案。浏览器清理过的、其他浏览器或另一域名的记录无法由当前页面恢复。

## 构建和验收

`macos-runtimes.json` 固定 Astral Python Standalone 20261026 的 CPython 3.13.18 双架构来源及 SHA-256。`tools/build_macos.py` 在完整分发清单的基础上移除 Windows Python 包，放入对应 Mac 运行环境并重新生成该包的 BUNDLE.json；全部原业务基线仍验证。运行环境内包含其许可证和第三方许可。

GitHub Actions 的 `Mac installation acceptance` 分别在 Apple 芯片及 Intel macOS 15 上构建、干净安装、校验、启动、重复启动、端口占用、查询、字体图片、个人数据和停止流程。每个架构单独产出安装包和校验文件。通过自动验收不代表所有 macOS 版本、Safari 触控板操作及下载隔离提示均已实机验收。
