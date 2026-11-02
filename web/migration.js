"use strict";

globalThis.LianbanMigration = (() => {
  const preferenceKey = "limit-up-archive.shareholder-blocked-types.v1";
  const prefix = "lianban.personal.v1.stock.";
  async function exportBrowser(storage, personal, send) {
    const config = JSON.parse(storage.getItem("lianban.personal.v2.tag-state") || "{}");
    const entries = new Map();
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(prefix) && /^\d{6}$/.test(key.slice(prefix.length))) {
        const value = JSON.parse(storage.getItem(key));
        if (!value || value.version !== 1) throw new Error("个人记录格式异常，请保留浏览器数据后重试。");
        entries.set(key.slice(prefix.length), value);
      }
    }
    const inventory = await send("/api/tag-inventory");
    const catalog = await personal.request("/api/tags", {}, send);
    const base = new Map(inventory.rows.map(row => [row.code, row]));
    const codes = config.revision > 0 ? new Set([...base.keys(), ...entries.keys()]) : new Set(entries.keys());
    const stocks = [];
    for (const code of codes) {
      const entry = entries.get(code) || {};
      const stock = base.get(code) || entry.stock;
      if (!stock?.name) throw new Error(`未能核实 ${code} 的股票名称，未生成不完整的导出文件。`);
      const row = {code, name: stock.name};
      if (entry.tags || config.revision > 0) {
        const effective = personal.overlay({...stock});
        row.tags = {values: effective.tags, source: stock.source_tags || stock.tags || []};
      }
      if (entry.note) {
        row.notes = entry.note.entries || (entry.note.content ? [{content: entry.note.content,
          occurred_at: entry.note.updated_at, updated_at: entry.note.updated_at, note_date: entry.note.updated_at.slice(0,10)}] : []);
        row.notes = row.notes.map(note => ({content: note.content, occurred_at: note.occurred_at,
          updated_at: note.updated_at, note_date: note.note_date ?? note.occurred_at.slice(0,10), deleted_at: note.deleted_at || null}));
      }
      if (entry.blacklist) row.blacklisted = entry.blacklist.value;
      if (Object.keys(row).length > 2) stocks.push(row);
    }
    const preferences = {};
    const saved = storage.getItem(preferenceKey);
    if (saved !== null) preferences[preferenceKey] = saved;
    // Read again after asynchronous queries: never silently mix two editing states.
    if (JSON.stringify(config) !== JSON.stringify(JSON.parse(storage.getItem("lianban.personal.v2.tag-state") || "{}")) ||
        [...entries].some(([code, entry]) => JSON.stringify(entry) !== JSON.stringify(JSON.parse(storage.getItem(prefix + code))))) {
      throw new Error("导出期间个人数据发生了修改，请保存编辑后重新导出。");
    }
    return {format: "lianban-personal-data", version: 1, exported_at: new Date().toISOString(),
      source: "online-browser", stocks, hierarchy: catalog.hierarchy || [], preferences};
  }
  return {exportBrowser};
})();

if (typeof document !== "undefined") {
  const online = !!globalThis.LianbanPersonalization;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "text-button";
  button.id = "personal-data-button";
  button.textContent = online ? "迁移到共享版" : "导入个人数据";
  button.setAttribute("aria-haspopup", "dialog");
  document.querySelector(".topbar-right")?.prepend(button);
  const dialog = document.createElement("dialog");
  dialog.id = "personal-data-dialog";
  dialog.className = "migration-dialog";
  const title = document.createElement("h2");
  title.id = "personal-data-title";
  title.textContent = online ? "迁移到共享版" : "导入网页版个人数据";
  dialog.setAttribute("aria-labelledby", title.id);
  const description = document.createElement("p");
  description.textContent = online
    ? "导出当前浏览器的标签、标签层级、备注历史、黑名单和股东屏蔽选择。在 Windows 或 Mac 共享版点击“导入个人数据”，选择导出的文件即可。请在原来编辑数据的浏览器及域名操作。"
    : "选择线上网站导出的 JSON 文件。确认后先备份本机数据库，再合并标签、备注历史与黑名单。保留本机已有记录；同名标签的父级、已保存的股东屏蔽选择以本机为准。重复导入会去重。";
  const privacy = document.createElement("p");
  privacy.className = "muted";
  privacy.textContent = online ? "文件含你的私人备注，请自行保管。导出不会清除原数据，也不会将个人数据上传服务器。" : "数据仅导入当前电脑。备份保存在本安装目录的 data/backups 中。";
  const status = document.createElement("p");
  status.className = "migration-status";
  status.setAttribute("role", "status");
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.setAttribute("aria-label", "选择个人数据文件");
  input.hidden = online;
  const actions = document.createElement("div");
  actions.className = "migration-actions";
  const primary = document.createElement("button");
  primary.type = "button";
  primary.className = "button primary";
  primary.textContent = online ? "导出迁移文件" : "备份并导入";
  primary.disabled = !online;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "button secondary";
  close.textContent = "关闭";
  close.onclick = () => dialog.close();
  actions.append(primary, close);
  if (online) {
    const link = document.createElement("a");
    link.href = "https://github.com/x107108/lianban-archive-desktop/releases/latest";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "下载 Windows / Mac 共享版";
    actions.append(link);
  }
  dialog.append(title, description, privacy, input, status, actions);
  document.body.append(dialog);
  button.onclick = () => dialog.showModal();
  let pending = null, imported = false;
  async function send(path, options = {}) {
    const response = await fetch(path, {...options, cache: "no-store"});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "操作暂未完成，请重试。");
    return data;
  }
  const post = (action, data) => send("/__desktop__/personal-data/" + action,
    {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(data)});
  input.onchange = async () => {
    primary.disabled = true;
    pending = null;
    const file = input.files[0];
    if (!file) return;
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error("迁移文件不能超过 20 MB。");
      const value = JSON.parse(await file.text());
      const counts = await post("preview", value);
      pending = value;
      status.textContent = `文件已核对：${counts.tag_stocks} 只股票的标签、${counts.hierarchy} 个标签层级、${counts.notes} 条备注、${counts.blacklist} 只黑名单股票。`;
      primary.disabled = false;
    } catch (error) { status.textContent = error.message; }
  };
  primary.onclick = async () => {
    primary.disabled = true;
    close.disabled = true;
    try {
      if (online) {
        status.textContent = "正在读取当前浏览器的个人数据…";
        const value = await LianbanMigration.exportBrowser(localStorage, LianbanPersonalization, send);
        const blob = new Blob([JSON.stringify(value, null, 2)], {type: "application/json"});
        const url = URL.createObjectURL(blob);
        const download = document.createElement("a");
        download.href = url;
        download.download = "连板档案-个人数据-" + new Date().toISOString().slice(0,10) + ".json";
        document.body.append(download);
        download.click();
        download.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        status.textContent = `已生成迁移文件，包含 ${value.stocks.length} 只股票的个人记录。下载完成后，在共享版导入该文件。`;
      } else {
        status.textContent = "正在备份并导入，请稍候…";
        const result = await post("import", pending);
        let preferenceFailed = false;
        for (const [key, value] of Object.entries(result.preferences || {})) {
          try { if (localStorage.getItem(key) === null) localStorage.setItem(key, value); }
          catch { preferenceFailed = true; }
        }
        status.textContent = result.already_imported ? "这份文件已经导入过，未重复添加记录。"
          : `导入完成：新增 ${result.added_tags} 个标签归属、${result.added_notes} 条备注、${result.added_blacklist} 只黑名单股票。${result.hierarchy_conflicts ? `有 ${result.hierarchy_conflicts} 个同名标签父级采用本机设置。` : ""}备份：${result.backup}。`;
        if (preferenceFailed) status.textContent += "浏览器未能保存股东屏蔽选择，请手动设置；数据库记录已导入。";
        imported = true;
        close.textContent = "完成并刷新";
        close.onclick = () => location.reload();
        pending = null;
        input.disabled = true;
      }
    } catch (error) { status.textContent = error.message; }
    finally { primary.disabled = !online && !pending; close.disabled = false; }
  };
  dialog.addEventListener("close", () => { if (imported) location.reload(); });
}
