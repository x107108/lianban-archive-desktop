// Mount the static BoardUI components before app.js binds its controls.
document.getElementById("date-stats").outerHTML = uiParts.stats;
document.getElementById("stock-stats").outerHTML = uiParts.stockStats;
document.getElementById("stock-query-form").insertAdjacentHTML("beforebegin", uiParts.queryHeading);
for (const part of [...uiParts.buttons, ...uiParts.stockEditorHeadings]) document.getElementById(part.id).outerHTML = part.html;

const stockEditorBody = document.getElementById("stock-editor-body");
stockEditorBody.insertAdjacentHTML("afterend", uiParts.stockEditorFade);
const stockEditorFadeLayers = stockEditorBody.nextElementSibling.children;
stockEditorBody.addEventListener("scroll", () => {
  const progress = Math.min(1, Math.max(0, stockEditorBody.scrollTop) / uiParts.stockEditorFadeDistance);
  for (const layer of stockEditorFadeLayers) layer.style.opacity = progress;
}, {passive: true});
