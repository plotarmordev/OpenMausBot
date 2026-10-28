/** The device word the person knows this computer by. */
export const deviceWord = (platform = process.platform) => platform === "darwin" ? "Mac" : platform === "win32" ? "PC" : "computer";

/** `onTerminal(on)` asks before it lends the terminal and settles once main answers. Electron ticks a checkbox item on click (Electron 43), so the menu
 * is built again from what is lent once it settles: a No leaves it unticked. */
export function createLendingIndicator({ Tray, Menu, nativeImage, iconPath, onStop, onOpen, onTerminal, device = deviceWord() }) {
  let tray = null;
  const off = { lending: false, busy: false, internetOnly: false, terminal: false };
  let shown = off;
  const lent = internetOnly => internetOnly ? `this ${device}'s internet connection` : `this ${device}`;
  const menu = ({ busy, internetOnly, terminal }) => Menu.buildFromTemplate([
    { label: busy ? `Your bots are using ${lent(internetOnly)} now` : `Your bots can use ${lent(internetOnly)}`, enabled: false },
    { type: "separator" },
    ...(onTerminal ? [{ label: "Terminal", type: "checkbox", checked: terminal, click: () => void onTerminal(!terminal).finally(redraw) }] : []),
    { label: "Stop sharing", click: () => onStop() },
    { label: "Sharing settings…", click: () => onOpen() },
  ]);
  const redraw = () => { if (tray && !tray.isDestroyed()) tray.setContextMenu(menu(shown)); };
  return {
    update({ lending, busy, internetOnly, terminal }) {
      const next = { lending: Boolean(lending), busy: Boolean(lending && busy), internetOnly: Boolean(lending && internetOnly), terminal: Boolean(lending && terminal) };
      if (Object.keys(off).every(key => next[key] === shown[key]) && (tray !== null) === next.lending) return;
      shown = next;
      if (!next.lending) { if (tray && !tray.isDestroyed()) tray.destroy(); tray = null; return; }
      if (!tray || tray.isDestroyed()) {
        tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 }));
        tray.on("click", () => tray?.popUpContextMenu?.());
      }
      tray.setToolTip(next.busy ? "OpenMausBot: in use by your bots" : `OpenMausBot: your bots can use ${lent(next.internetOnly)}`);
      // macOS shows the title beside the icon: visible while in use.
      tray.setTitle?.(next.busy ? "In use" : "");
      redraw();
    },
    destroy() { if (tray && !tray.isDestroyed()) tray.destroy(); tray = null; shown = off; },
  };
}
