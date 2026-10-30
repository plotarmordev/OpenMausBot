import { createHash } from "node:crypto";

import type { ProfileRequestChanges } from "../shared/profile-request.ts";

export function profileSnapshot(
  bot: { name: string; title: string; description: string; soul?: string; cwd?: string; notifications?: boolean; speakReplies?: boolean },
): Required<ProfileRequestChanges> {
  return {
    name: bot.name,
    title: bot.title,
    description: bot.description,
    soul: bot.soul ?? "",
    cwd: bot.cwd ?? "",
    notifications: bot.notifications ?? true,
    speakReplies: bot.speakReplies ?? false,
  };
}

export function profileRevision(
  bot: { name: string; title: string; description: string; soul?: string; cwd?: string; notifications?: boolean; speakReplies?: boolean; lastProfileRequestId?: string },
): string {
  // The private receipt stops an older, interrupted card from applying restored identical text twice.
  return createHash("sha256")
    .update(JSON.stringify({ ...profileSnapshot(bot), lastProfileRequestId: bot.lastProfileRequestId ?? "" }), "utf8")
    .digest("hex");
}

/** Unique per soul write, so a later write of the same bytes still moves it. `legacy` marks a soul last written before
 * write ids existed; its hash part still moves when the bytes do. */
export function soulRevision(bot: { soul?: string; soulWriteId?: string }): string {
  const hash = createHash("sha256").update(bot.soul ?? "", "utf8").digest("hex");
  return `${bot.soulWriteId ?? "legacy"}.${hash}`;
}
