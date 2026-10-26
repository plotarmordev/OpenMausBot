import type { DataContext } from "../shared/data-context.ts";
import type { RoutineRunOn, RoutineRunTrigger } from "../shared/routines.ts";
import type { ResolvedSender } from "../shared/wire.ts";
import type { ModelSelection } from "./contracts.ts";
import type { WorkOrigin } from "./peer-provenance.ts";
import type { ReplyTarget } from "./replies.ts";
import type { Message } from "./store.ts";
import type { UsageTrigger } from "./usage-ledger.ts";

export interface SerializableTurnOptions {
  commsDepth?: number;
  userMessage?: Message;
  editedMessageId?: string;
  sender?: ResolvedSender;
  trigger?: UsageTrigger;
  excludeMessageIds?: string[];
  threadId?: string;
  runOn?: RoutineRunOn;
  /** Puts externally supplied payloads behind an explicit untrusted-data boundary in the system prompt. */
  automationSource?: RoutineRunTrigger;
  unattended?: boolean;
  peerAsk?: Message["peerAsk"];
  cardContinuation?: boolean;
  /** Harness-only provenance: never a client option, never inferred from the latest user line. */
  requestMessageId?: string;
  origin?: WorkOrigin;
  computerSelectionContinuation?: boolean;
  replyTo?: ReplyTarget;
  sendId?: string;
  via?: "call";
  callId?: string;
  relayed?: boolean;
  capacity?: "person";
  dataContext?: DataContext;
  app?: { context?: string; fromApp?: Message["fromApp"]; pointed?: Message["pointed"] };
  compactOnly?: boolean;
  automaticRecoveryAttempted?: boolean;
  automaticRecoveryIndex?: number;
  allowRoomTurnElsewhere?: boolean;
}

export interface QueuedAutomaticRecovery {
  selection: ModelSelection;
  from: ModelSelection;
  userMessage: Message;
  recoveryUserMessageId: string | undefined;
  activity: string;
  limit?: { resetsAt: number | null };
  generation: string;
  options: SerializableTurnOptions;
  coordination?: { id: string; resumed: boolean };
}
