# 自由流通市值来源

2026-11-25 按站主要求，与本地测试版使用同一份通达信统计资料。由通达信 `calc.tdx.com.cn:7709`（备用 `calc2.tdx.com.cn:7709`）的报表文件命令 `0x06b9` 下载 `zhb.zip`，只读取其中 `tdxstat.cfg`，不依赖作者本机文件，不上传个人资料。

股票按市场及代码定位；竖线分隔文件的第 5 列是资料日期（YYYYMMDD），第 12 列是自由流通股本（万股）。换算为“所选交易日东方财富股价 × 自由流通股本 × 10000”。来源日期须处于所选日与上一个已归档交易日之间，结果不得超过当日流通市值；日期过旧、未来日期、非法或缺失的股本均不填值。两处来源无法读取时，仍返回其他已有市值。与本地版一样，最新股本不能冒充任意历史日期的股本。

全市场统计在进程内按 30 分钟共用一份缓存，线程间共用下载；单次下载有总时限和大小校验。该实现使用 Python 标准库读取同一通达信来源，无须分发本地研究环境的 ELTDX 依赖。未修改分钟行情、个人资料存储或数据库结构。

协议事实参考：
- https://github.com/rainx/pytdx/blob/master/pytdx/parser/get_report_file.py
- https://github.com/rainx/pytdx/blob/master/pytdx/parser/base.py
- https://github.com/injoyai/tdx/blob/master/protocol/model_stat.go
- https://help.tdx.com.cn/gspt/docs/markdown/redword/functionlist.html

字段含义通过同一时刻的本地版结果逐股核对，验收记录另列于本轮发布记录。
