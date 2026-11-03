"""Read-time refinements; keep the provider's original classifications in storage."""
import re

HUIJIN_NAMES = frozenset({"中央汇金投资有限责任公司", "中央汇金资产管理有限责任公司"})

# Verified regulator/official lists and old disclosed names. See docs/SHAREHOLDER-TYPES.md.
AMC_NAMES = frozenset({
    "中国长城资产管理股份有限公司", "中国长城资产管理公司",
    "中国信达资产管理股份有限公司", "中国信达资产管理公司",
    "中国东方资产管理股份有限公司", "中国东方资产管理公司",
    "中国银河资产管理有限责任公司",
    "中国中信金融资产管理股份有限公司", "中国华融资产管理股份有限公司", "中国华融资产管理公司",
    "江苏资产管理有限公司", "苏州资产管理有限公司",
    "湖北省资产管理有限公司", "湖北省天乾资产管理有限公司", "湖北天乾资产管理有限公司",
    "长沙湘江资产管理有限公司", "黑龙江国瑞金融资产管理有限公司",
    "中原资产管理有限公司", "山东省金融资产管理股份有限公司", "陕西金融资产管理股份有限公司",
})
COMPANY_NAME = re.compile(r"(?:有限公司|有限责任公司|股份公司|集团公司|总公司|合伙企业\((?:有限|普通|特殊普通)合伙\))(?:[\u4e00-\u9fff]+分公司)?$")
FINANCIAL_OR_ACCOUNT = re.compile(r"[—–-]|基金|私募|资管|资产管理|投资管理|资本管理|财富管理|金融|证券|银行|保险|信托|期货|社保|养老金|年金|结算|清算|托管|账户|客户|资金|理财|投资计划|投资组合|员工持股计划|fund|asset management|bank|securities|nominee")


def classify_holder(holder_key, source_type):
    # Keys have already been normalized at collection; never fuzzy-match entities.
    if holder_key == "香港中央结算有限公司":
        return "香港中央结算有限公司"
    if holder_key in HUIJIN_NAMES:
        return "中央汇金"
    if holder_key in AMC_NAMES or (holder_key.endswith("分公司") and any(
            holder_key.startswith(name) and re.fullmatch(r"[\u4e00-\u9fff]+分公司", holder_key[len(name):])
            for name in AMC_NAMES)):
        return "AMC"
    if source_type == "其他" and COMPANY_NAME.search(holder_key) and not FINANCIAL_OR_ACCOUNT.search(holder_key):
        return "企业股东"
    return source_type
