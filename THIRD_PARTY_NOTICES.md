# 第三方组件与来源

- Windows Python 运行环境：Python Software Foundation 官方 CPython 3.13.16 x64 嵌入包，完整原始 ZIP 随项目提供；安装时解包的 `LICENSE.txt` 保留其许可及第三方声明。官方发布页：https://www.python.org/downloads/release/python-31316/ 。
- Python 依赖：`requests`、`xlrd`、`truststore`、`pypinyin`、`urllib3`、`certifi`、`charset-normalizer`、`idna`。固定版本见 `requirements.txt`，未经改写的 wheel 来自 PyPI；其 `.dist-info` 元数据和许可证随安装完整保留。来源及文件散列见 `vendor/SOURCES.json`。
- 网页字体：Google Fonts / Adobe 的 Noto Sans SC，SIL OFL 1.1。完整许可证和来源见 `web/fonts/OFL.txt`、`web/fonts/SOURCE.md`。
- 站点标题图片：沿用用户提供并已用于本地版本的原始页面资源，未改变图片与布局。
- 历史事实数据、行业及省份等字段：来源与边界由程序和页面“说明”列出，个人设置及原始来源响应不在初始档案中。

第三方名称与许可不表示其作者对本项目的推荐、背书或数据准确性保证。
# Mac 运行环境补充（2026.11.03）

Mac 完整安装包另附 Astral 维护的 [Python Standalone Builds](https://github.com/astral-sh/python-build-standalone)，固定来源和 SHA-256 见 `macos-runtimes.json`。它包含 CPython 和其构建所需组件；原有许可随运行环境一并提供，解压后保留，不改变本项目代码或既有依赖的许可。
