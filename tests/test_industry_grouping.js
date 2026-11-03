// Verify the business rule with synthetic multi-height cohorts, using real renderers.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
const context = vm.createContext({ state: { grouping: "industry", meta: { latest_date: "2026-10-15" } } });
vm.runInContext(source.slice(source.indexOf("function escapeHTML"), source.indexOf("function debounce")), context);
vm.runInContext(source.slice(source.indexOf("function stockTags"), source.indexOf("function renderTagEditor")), context);
const stock = (code, boards, tags, province = "广西壮族自治区") => ({
  code, name: `样本${code}`, date: "2026-10-15", boards, tags, registered_province: province
});
const rows = [
  stock("000001", 5, ["主业", "独有", "同板业务", "跨板业务", "首板关联", "另一个跨板业务"]),
  stock("000002", 5, ["同板业务"]),
  stock("000003", 3, ["跨板业务"]),
  stock("000004", 1, ["首板关联", "首板独有"]),
  stock("000005", 2, ["另一个跨板业务"]),
  stock("000006", 3, []),
];
const unchanged = JSON.stringify(rows);
const full = context.renderIndustryColumns(rows);
const occurrences = (html, code) => (html.match(new RegExp(`data-card-code="${code}"`, "g")) || []).length;
assert.equal(occurrences(full, "000001"), 3, "cross-height groups replace an otherwise redundant private fallback");
assert.ok(!full.includes('data-group-label="主业"'), "a private primary tag is unnecessary when cross-height groups already show the stock");
assert.ok(!full.includes('data-group-label="独有"'), "a private secondary tag creates no duplicate column");
const fiveBoardRow = full.slice(full.indexOf('data-board-height="5"'), full.indexOf('data-board-height="3"'));
const sameHeightCell = fiveBoardRow.split('data-group-label="同板业务"')[1].split('<section class="matrix-cell')[0];
assert.ok(!sameHeightCell.includes('data-card-code="000001"'), "same-height peers cannot trigger extra cards");
assert.equal(occurrences(full, "000004"), 2, "first-board stocks keep all their tags");
assert.equal(occurrences(full, "000006"), 1, "an untagged stock still has a fallback card");
assert.ok(full.includes('data-group-label="暂无标签 · 样本000006"') && !full.includes('data-group-label="独苗"'), "an untagged consecutive-board stock gets its own column");
const selected = context.renderIndustryColumns(rows.filter(row => row.boards === 5), context.industryTagBoardCounts(rows));
assert.equal(occurrences(selected, "000001"), 3, "board filtering preserves full-day cross-height evidence");
assert.equal(occurrences(selected, "000002"), 1);
const regressionRows = [stock("003029",2,["金融","博弈","低空"]),stock("000099",1,["低空"]),
  stock("600668",2,["医药生物","水泥"]),stock("603168",1,["医药生物"]),stock("600802",1,["水泥"]),
  stock("000007",3,["独立主业","独立副业"]),stock("000008",2,["仅同板"]),stock("000009",2,["仅同板"])];
const regressionHTML=context.renderIndustryColumns(regressionRows);
assert.equal(occurrences(regressionHTML,"003029"),1,"吉大正元 has only its useful low-altitude grouping");
assert.ok(!regressionHTML.includes('data-group-label="金融"') && !regressionHTML.includes('data-group-label="博弈"'));
assert.equal(occurrences(regressionHTML,"600668"),2,"尖峰集团 keeps both real cross-height links");
assert.equal(occurrences(regressionHTML,"000007"),1,"a stock with no cross-height links keeps one fallback");
assert.ok(!regressionHTML.includes('data-group-label="独苗"') && ["独立主业", "独立副业"].filter(tag => regressionHTML.includes(`data-group-label="${tag}"`)).length === 1, "an independent leader retains one normal concept column");
const regressionSelected=context.renderIndustryColumns(regressionRows.filter(row=>row.boards===2),context.industryTagBoardCounts(regressionRows));
assert.equal(occurrences(regressionSelected,"003029"),1);
assert.equal(occurrences(regressionSelected,"600668"),2);
const blocked=context.renderStockCard({...regressionRows[4],blacklisted:true});
assert.ok(blocked.includes("blacklisted-stock") && blocked.includes('class="stock-blacklist-badge">黑名单'));
assert.ok(!context.renderStockCard(regressionRows[4]).includes("blacklisted-stock"));
context.state.latestLimitUps=new Map([["600802",1]]);
const latestBlocked=context.renderStockCard({...regressionRows[4],date:"2026-10-14",blacklisted:true});
assert.ok(latestBlocked.includes("latest-limit-up blacklisted-stock") && latestBlocked.includes("涨停"),"blacklist status coexists with latest-day evidence");
context.state.grouping = "region";
const regional = context.renderIndustryColumns(rows);
for (const row of rows) assert.equal(occurrences(regional, row.code), 1, "region mode shows each stock once");
assert.equal(JSON.stringify(rows), unchanged, "grouping must not alter stored tags or stock facts");
context.state.grouping = "pinyin";
const pinyinRows = [
  {...stock("600802",1,["水泥","建材"]),name:"福建水泥",initials:"fjsn",date:"2026-10-14"},
  {...stock("002949",1,["传媒"]),name:"华阳国际",initials:"HYGJ"},
  {...stock("002724",1,["军工"]),name:"海洋王",initials:"HYW"},
  {...stock("000003",1,["甲"]),initials:"CCJG"},
  {...stock("000004",2,["乙"]),initials:"CCJGZ"},
  {...stock("000005",2,["甲"]),initials:"XXHYZ"},
  {...stock("000999",1,[]),name:"待补名称"}
];
const pinyinBefore = JSON.stringify(pinyinRows);
const pinyinHTML = context.renderIndustryColumns(pinyinRows);
const headings = [...pinyinHTML.matchAll(/data-group-label="([^"]+)"/g)].map(match=>match[1]);
const expectedGroups = ["CCJG","CCJ","CJG","CC","CJ","HY","JG","C","F","G","H","J","N","S","W","X","Y","Z","#"];
assert.deepEqual(headings.slice(0,expectedGroups.length),expectedGroups,"all matching tokens, including middle letters, sort by 4/3/2/1 length and then alphabetically");
const cellHTML = (html,token,height=1)=>html.split(`data-board-height="${height}"`)[1].split(`data-group-label="${token}"`)[1].split('<section class="matrix-cell')[0];
for(const token of ["HY","H","Y"]){
  const cell = cellHTML(pinyinHTML,token);
  for(const code of ["002949","002724"]) assert.equal(occurrences(cell,code),1,"华阳国际 and 海洋王 both appear once in each HY, H and Y group");
  assert.ok(cell.includes('>HYGJ</span>') && cell.includes('>HYW</span>'),"cards retain their complete initials in every group");
  assert.equal(occurrences(cellHTML(pinyinHTML,token,2),"000005"),1,"the same token also matches inside a longer name on another board row");
}
assert.equal(occurrences(cellHTML(pinyinHTML,"C"),"000003"),1,"two C letters in a name cannot duplicate its card within the C group");
assert.equal(occurrences(cellHTML(pinyinHTML,"X",2),"000005"),1,"repeated X letters also deduplicate within a group");
assert.equal(occurrences(pinyinHTML,"600802"),4,"FJSN participates in F, J, S and N groups");
assert.equal(occurrences(pinyinHTML,"002949"),5,"HYGJ participates in HY, H, Y, G and J groups");
assert.equal(occurrences(pinyinHTML,"002724"),4,"HYW participates in HY, H, Y and W groups");
assert.equal(occurrences(pinyinHTML,"000999"),1,"missing initials have a single unknown-group card");
for(const row of pinyinRows) assert.ok(occurrences(pinyinHTML,row.code)>0,"no underlying stock may disappear");
assert.ok(pinyinHTML.includes('--matrix-columns:19') && pinyinHTML.includes('<strong>7</strong> 只股票'),"unique-stock totals remain separate from cross-group appearances");
assert.ok(pinyinHTML.includes('同一股票可跨组展示'));
assert.ok(pinyinHTML.includes('title="股票名称首字母：FJSN">FJSN'));
assert.ok(pinyinHTML.includes("按拼音分组分列"));
assert.equal(context.renderIndustryColumns([...pinyinRows].reverse()).split('<div class="board-comparison"')[1],pinyinHTML.split('<div class="board-comparison"')[1],"input order cannot change groups or card order");
const jCell = cellHTML(pinyinHTML,"J");
assert.deepEqual([...jCell.matchAll(/data-card-code="([^"]+)"/g)].map(match => match[1]), ["000003", "002949", "600802"], "missing first-limit times use stable stock-code order instead of letter-match position");
const selectedPinyin = context.renderIndustryColumns(pinyinRows.filter(row=>row.boards===1));
for(const token of ["HY","H","Y"]) for(const code of ["002949","002724"]) assert.equal(occurrences(cellHTML(selectedPinyin,token),code),1,"board filtering retains overlapping memberships");
assert.equal(occurrences(selectedPinyin,"000005"),0,"another height's stock must remain filtered out");
const longRows = [{...stock("000010",1,[]),initials:"HYW"},{...stock("000011",1,[]),initials:"ZZZHYW"}];
const longHTML = context.renderIndustryColumns(longRows);
assert.ok(longHTML.includes('data-group-label="HYW"') && longHTML.includes('data-group-label="YW"'),"matching scans past the first four positions while keeping tokens at most four letters");
assert.ok([...longHTML.matchAll(/data-group-label="([^"]+)"/g)].every(match=>match[1].length<=4));
const repeatedHTML=context.renderIndustryColumns([{...stock("000012",1,[]),initials:"AAAAA"}]);
assert.ok(!repeatedHTML.includes('data-group-label="AA"') && occurrences(repeatedHTML,"000012")===1,"self-repetition cannot create a multi-stock matching group");
assert.equal(JSON.stringify(pinyinRows),pinyinBefore,"overlapping presentation never rewrites names, tags or archived facts");
assert.deepEqual(Array.from(context.orderPinyinGroups(new Map(),"#")),[],"an empty classification remains valid");
context.state.grouping="code";
const codeRows = [stock("001234",1,["甲","乙"]),stock("001235",2,["甲"]),
  stock("123450",1,["乙"]),stock("999999",1,[]),stock("000001",1,[])];
const codeBefore = JSON.stringify(codeRows);
const codeHTML = context.renderIndustryColumns(codeRows);
const codeGroups = [...new Set([...codeHTML.matchAll(/data-group-label="([^"]+)"/g)].map(match=>match[1]))];
assert.deepEqual(codeGroups.slice(0,8),["00123","0012","0123","1234","001","012","123","234"],"longer numeric matches precede shorter ones and keep leading zeros");
assert.ok(codeHTML.includes("按代码分组分列") && codeHTML.includes("6 → 5 → 4 → 3 → 2 → 1"));
assert.ok(codeHTML.includes('<strong>5</strong> 只股票'),"cross-group duplicates do not inflate the stock total");
for (const token of ["00123","001","00","0"]) {
  assert.equal(occurrences(cellHTML(codeHTML,token),"001234"),1);
  assert.equal(occurrences(cellHTML(codeHTML,token,2),"001235"),1);
}
assert.equal(occurrences(cellHTML(codeHTML,"0"),"000001"),1,"repeated zeroes still create only one card per group");
assert.equal(occurrences(codeHTML,"999999"),1,"self-repetition cannot create multi-stock numeric matches");
const zeroCell=cellHTML(codeHTML,"0");
assert.ok(zeroCell.indexOf('data-card-code="000001"')<zeroCell.indexOf('data-card-code="001234"')
  &&zeroCell.indexOf('data-card-code="001234"')<zeroCell.indexOf('data-card-code="123450"'),"missing first-limit times use stable stock-code order within numeric groups");
assert.equal(context.renderIndustryColumns([...codeRows].reverse()).split('<div class="board-comparison"')[1],codeHTML.split('<div class="board-comparison"')[1]);
const codeSelected=context.renderIndustryColumns(codeRows.filter(row=>row.boards===2));
assert.equal(occurrences(cellHTML(codeSelected,"0",2),"001235"),1);
assert.equal(occurrences(codeSelected,"001234"),0);
assert.equal(JSON.stringify(codeRows),codeBefore,"numeric grouping does not change codes, tags or archive facts");
assert.equal(context.codeDigits({code:"000001"}),"000001");
assert.equal(context.codeDigits({code:"１２３４５６"}),"");
assert.deepEqual(Array.from(context.orderCodeGroups(new Map(),"#")),[]);
context.state.grouping="industry";
const metadataCard = context.renderStockCard({...pinyinRows[0],blacklisted:true,registered_address:"福建<&地址"});
assert.ok(metadataCard.includes('<div class="industry-stock-meta"><span class="row-stock-code">600802</span><span class="stock-initials" title="股票名称首字母：FJSN">FJSN</span><span class="stock-location"'),"code, full initials and province are separate, ordered sibling fields in every layout");
assert.ok(!metadataCard.includes("地址") && !metadataCard.includes('class="stock-location" tabindex'), "province is plain metadata without a detailed address tooltip");
const metadata = metadataCard.split('<div class="industry-stock-meta">')[1].split('</div>')[0];
assert.ok(!metadata.includes("stock-blacklist-badge"),"blacklist status cannot interrupt the three metadata fields");
assert.ok(metadataCard.includes('class="stock-blacklist-badge">黑名单'),"blacklist status remains visible on the card");
assert.ok(context.renderStockCard(stock("000000",1,[])).includes('title="股票名称首字母：暂未获取">—</span>'),"missing initials keep their metadata position without inventing a name");
console.log("Cross-height tags, overlapping HY/H/Y memberships, 4/3/2/1 substring groups, per-group deduplication and card metadata: passed.");
