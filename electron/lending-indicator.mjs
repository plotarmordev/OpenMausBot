/** The device word the person knows this computer by. */
export const deviceWord = (platform = process.platform) => platform === "darwin" ? "Mac" : platform === "win32" ? "PC" : "computer";

export function createLendingIndicator({ Tray, Menu, nativeImage, iconPath, onStop, onOpen, device = deviceWord() }) {
  let tray = null;
  let shown = { lending: false, busy: false, internetOnly: false };
  const lent = internetOnly => internetOnly ? `this ${device}'s internet connection` : `this ${device}`;
  const menu = (busy, internetOnly) => Menu.buildFromTemplate([
    { label: busy ? `Your bots are using ${lent(internetOnly)} now` : `Your bots can use ${lent(internetOnly)}`, enabled: false },
    { type: "separator" },
    { label: "Stop sharing", click: () => onStop() },
    { label: "Sharing settings…", click: () => onOpen() },
  ]);
  return {
    update({ lending, busy, internetOnly }) {
      const next = { lending: Boolean(lending), busy: Boolean(lending && busy), internetOnly: Boolean(lending && internetOnly) };
      if (next.lending === shown.lending && next.busy === shown.busy && next.internetOnly === shown.internetOnly && (tray !== null) === next.lending) return;
      shown = next;
      if (!next.lending) { if (tray && !tray.isDestroyed()) tray.destroy(); tray = null; return; }
      if (!tray || tray.isDestroyed()) {
        tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 }));
        tray.on("click", () => tray?.popUpContextMenu?.());
      }
      tray.setToolTip(next.busy ? "OpenMausBot: in use by your bots" : `OpenMausBot: your bots can use ${lent(next.internetOnly)}`);
      // macOS shows the title beside the icon: visible while in use.
      tray.setTitle?.(next.busy ? "In use" : "");
      tray.setContextMenu(menu(next.busy, next.internetOnly));
    },
    destroy() { if (tray && !tray.isDestroyed()) tray.destroy(); tray = null; shown = { lending: false, busy: false, internetOnly: false }; },
  };
}
