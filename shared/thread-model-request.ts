/**
 * Durable payload carried by a thread-model change card (set_thread_model).
 * "before" is the thread's own pinned selection at propose time, undefined
 * when the thread followed its bot's default; "beforeDefault" is that bot
 * default, so Undo can put the follow back exactly. A confirmation or Undo
 * fails closed if the thread's model moved since.
 */
import type { ModelSelection } from "./wire.ts";

export interface ThreadModelRequestCardData {
  version: 1;
  requestId: string;
  /** The Chief conversation that asked; authority is fixed here. */
  botId: string;
  threadId: string;
  /** Whose conversation changes: the bot that owns the target thread. */
  targetBotId: string;
  targetName: string;
  targetThreadId: string;
  targetTitle: string;
  createdAt: number;
  reason: string;
  selection: ModelSelection;
  before?: ModelSelection;
  beforeDefault: ModelSelection;
  appliedAt?: number;
}
