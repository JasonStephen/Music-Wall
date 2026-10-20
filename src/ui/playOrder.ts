import { setIcon } from "obsidian";
import type { InternalPlayer, PlaybackOrder } from "../core/internalPlayer";
import { t } from "../i18n";

const icons: Record<PlaybackOrder, string> = {
  order: "list-ordered", repeat: "repeat", one: "repeat-1", shuffle: "shuffle",
};

export function cyclePlayOrder(player: InternalPlayer, onChanged?: (order: PlaybackOrder) => void): void {
  const orders = player.allowedOrders;
  player.setOrder(orders[(orders.indexOf(player.order) + 1) % orders.length]);
  onChanged?.(player.order);
}

export function updatePlayOrderButton(button: HTMLElement, player: InternalPlayer): void {
  if (button.dataset.order !== player.order) {
    setIcon(button, icons[player.order]);
    button.dataset.order = player.order;
  }
  const label = t(`queue.${player.order === "repeat" && player.contentKind === "playlist" ? "repeatList" : player.order}`);
  button.setAttr("title", label);
  button.setAttr("aria-label", label);
}
