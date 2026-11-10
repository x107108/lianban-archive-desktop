import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "@/components/base/buttons/button";
import { StatCards, type Stat } from "@/components/application/dashboard/stat-cards";
import { ScrollFade, SCROLL_FADE_DISTANCE } from "@/components/foundations/scroll-fade/scroll-fade";
import { cx } from "@/utils/cx";
import { DirectionProvider } from "@/components/foundations/direction/direction";
import {
  RiArrowRightLine, RiBarChartBoxLine, RiStackLine, RiFireLine, RiFlagLine,
  RiSearchLine, RiLineChartLine, RiForbid2Line, RiPriceTag3Line, RiInformationLine, RiStickyNoteLine, RiCloseLine,
} from "@remixicon/react";

const stats: Stat[] = [
  { icon: RiBarChartBoxLine, label: "涨停家数", value: <span data-stat="total">—</span>, caption: "当前筛选结果", delta: "", deltaColor: "neutral" },
  { icon: RiFireLine, label: "最高连板", value: <><span data-stat="max_boards">—</span><span className="ms-2 text-body-medium text-text-tertiary">板</span></>, caption: <span id="date-height-note">当前筛选最高高度</span>, delta: "", deltaColor: "neutral" },
  { icon: RiStackLine, label: "连板家数", value: <span data-stat="consecutive">—</span>, caption: "连续涨停 ≥ 2 板", delta: "", deltaColor: "neutral" },
  { icon: RiFlagLine, label: "首板家数", value: <span data-stat="first_boards">—</span>, caption: "当前筛选中的首板", delta: "", deltaColor: "neutral" },
];

const navItems = [
  { id: "nav-search", label: "历史检索", text: "检索", icon: RiSearchLine },
  { id: "nav-intraday", label: "主板分时", text: "分时", icon: RiLineChartLine },
  { id: "nav-blacklist", label: "黑名单", text: "黑名单", icon: RiForbid2Line, disabled: true },
  { id: "nav-tags", label: "标签管理", text: "标签管理", icon: RiPriceTag3Line, disabled: true },
  { id: "method-nav", label: "查看数据说明", text: "说明", icon: RiInformationLine },
];

const stockStats: Stat[] = [
  { icon: RiBarChartBoxLine, label: "累计涨停天数", value: <span data-stat="limit_days">—</span>, caption: "全部已收录涨停记录", delta: "", deltaColor: "neutral" },
  { icon: RiFireLine, label: "最高连板", value: <><span data-stat="max_boards">—</span><span className="ms-2 text-body-medium text-text-tertiary">板</span></>, caption: "已收录历史最高高度", delta: "", deltaColor: "neutral" },
  { icon: RiStackLine, label: "涨停周期", value: <span data-stat="cycles">—</span>, caption: "含首板独立周期", delta: "", deltaColor: "neutral" },
];

export function renderHomeParts() {
  return {
    stats: renderToStaticMarkup(<div id="date-stats" className="boardui-stats" aria-label="当日统计"><DirectionProvider locale="zh-CN"><StatCards stats={stats} className="home-stat-cards" /></DirectionProvider></div>),
    stockStats: renderToStaticMarkup(<div id="stock-stats" className="boardui-stats stock-stats" aria-label="个股统计"><DirectionProvider locale="zh-CN"><StatCards stats={stockStats} className="home-stat-cards stock-stat-cards" /></DirectionProvider></div>),
    queryHeading: renderToStaticMarkup(<div className="query-panel-heading"><h2>档案检索</h2><p>选择交易日，或搜索一只股票回看历史</p></div>),
    stockEditorHeadings: [
      { id: "stock-editor-tags-title", html: renderToStaticMarkup(<h3 id="stock-editor-tags-title"><span className="stock-editor-section-icon"><RiPriceTag3Line aria-hidden="true" /></span>标签</h3>) },
      { id: "stock-note-title", html: renderToStaticMarkup(<h3 id="stock-note-title"><span className="stock-editor-section-icon"><RiStickyNoteLine aria-hidden="true" /></span>备注</h3>) },
    ],
    stockEditorFade: renderToStaticMarkup(<ScrollFade progress={0} surfaceClassName="from-background-secondary-default" />),
    stockEditorFadeDistance: SCROLL_FADE_DISTANCE,
    buttons: [
      { id: "stock-query-button", html: renderToStaticMarkup(<Button id="stock-query-button" type="submit" className="button primary" trailingIcon={RiArrowRightLine}>查询</Button>) },
      { id: "latest-date", html: renderToStaticMarkup(<Button id="latest-date" className="button secondary small" variant="secondary">最新交易日</Button>) },
      { id: "close-tags", html: renderToStaticMarkup(<Button id="close-tags" variant="secondary" iconOnly leadingIcon={RiCloseLine} aria-label="关闭股票资料" autoFocus />) },
      { id: "add-tag", html: renderToStaticMarkup(<Button id="add-tag" className="button secondary stock-editor-add" variant="secondary" disabled>添加</Button>) },
      { id: "save-stock-note", html: renderToStaticMarkup(<Button id="save-stock-note" type="submit" className="button secondary stock-editor-add" variant="secondary" disabled>添加</Button>) },
      { id: "cancel-tags", html: renderToStaticMarkup(<Button id="cancel-tags" className="button secondary" variant="secondary">关闭</Button>) },
      { id: "save-tags", html: renderToStaticMarkup(<Button id="save-tags" type="submit" form="tag-editor-form" className="button primary">保存</Button>) },
      ...navItems.map(item => ({id:item.id, html:renderToStaticMarkup(<Button id={item.id} variant="ghost" leadingIcon={item.icon} aria-label={item.label} aria-current={item.id === "nav-search" ? "page" : undefined} disabled={item.disabled} className={cx("nav-item", item.id === "nav-search" && "active")}>{item.text}</Button>)})),
    ],
  };
}
