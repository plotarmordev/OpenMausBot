// A Team Cloud person's inbox: their own conversation with their own Chief of Staff, or with their own MausBot while they
// crowned none. Everything addressed to them lands there as one line that says who it is from and where it came from:
// a message a bot or a teammate passed them, an @mention, a question or approval card a bot asks them (a copy, answered
// here as there), a routine's report and a failure routed to them. Each line is one notification, sent from there.
// Replying to a line answers it: the answer goes back to the bot that asked, which carries on, or to the teammate's own
// inbox. A question that a fact the person shares with the team answers, their assistant may answer (representative.ts).
// Security: a line carries only what was addressed to the person, and links its conversation only when they may read
// it. The state is ids, names and short excerpts, in person-inbox.json. Off a team nothing here exists.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { botOwner } from "../../shared/bot-owner.ts";
import type { InboxItem } from "../../shared/inbox.ts";
import type { Notification } from "../../shared/notification.ts";
import { ASK_NOTIFICATIONS } from "../ask-routing.ts";
import { writeFileAtomic } from "../atomic.ts";
import { audienceMember, type Audience } from "../audience.ts";
import { isRestricted } from "../bot-visibility.ts";
import type { CloudTeam } from "../cloud-team.ts";
import { peerStatus, peerStatusWords } from "../peer-roster.ts";
import type { BotRecord, Message, Store, StoreChange } from "../store.ts";
import type { Representative, SharedFacts } from "./representative.ts";
import { clip, oneLine } from "./text-clip.ts";

export const PERSON_INBOX_FILE = "person-inbox.json";
const INBOX_TITLE = "Inbox";
/** A person's own chat with their Chief by this title is the one their inbox takes over first. */
const BRIEF_TITLE = "Brief";
const MAX_ITEMS = 2_000;
const KEEP_MS = 30 * 24 * 60 * 60_000;
const NOTE_MAX = 2_000;
/** Questions one person's assistant may answer in an hour; past it they wait for the person. */
export const ASSISTANT_HOURLY = 20;
const HOUR_MS = 60 * 60_000;

const id = z.string().min(1).max(512);
const person = z.string().regex(/^p_[\w-]{22}$/u);
const itemSchema = z.object({
  id, person, botId: id, threadId: id,
  kind: z.enum(["message", "ask", "result", "notice"]),
  from: z.string().max(200),
  fromEmail: z.string().max(320).optional(),
  fromBot: id.optional(),
  /** Who an answer goes to: the bot that asked, in its conversation, or the teammate who wrote, in their inbox. */
  to: z.enum(["bot", "person"]).optional(),
  asker: person.optional(),
  origin: z.object({ botId: id, threadId: id, groupId: id.optional(), messageId: id.optional() }).optional(),
  requestId: z.string().max(200).optional(),
  text: z.string().max(400),
  at: z.number(),
  answered: z.boolean().optional(),
  seen: z.boolean().optional(),
});
const fileSchema = z.object({ version: z.literal(1), homes: z.record(person, z.object({ botId: id, threadId: id })), items: z.array(itemSchema).max(MAX_ITEMS) });

export type Item = z.infer<typeof itemSchema>;
type Origin = NonNullable<Item["origin"]>;
type Teammate = { key: string; email: string; name: string };
export type Passed = { status: number; text: string };
type Relay = NonNullable<Message["relay"]>;

/** One thing for one person's inbox. */
export interface Delivery {
  kind: Item["kind"];
  from: { name: string; email?: string; botId?: string };
  via?: { botId: string; name: string };
  to?: Item["to"];
  asker?: string;
  origin?: Origin;
  text: string;
  /** The notification's title and kind. */
  title: string;
  notify: Notification["kind"];
  /** An ask's card, copied so it is answered here as there. */
  card?: NonNullable<Message["card"]>;
  /** Answered by their assistant, which their inbox says. */
  assistant?: boolean;
  /** Their assistant may answer it first: the notification waits for it. */
  representable?: boolean;
  /** The caller sends the one notification itself. */
  quiet?: boolean;
}

export interface PersonInboxDeps {
  team: CloudTeam | null;
  dataDir: string;
  store: Pick<Store, "bots" | "bot" | "tasks" | "taskByThread" | "createTask" | "patchTask" | "patchGroup" | "appendMessage" | "patchMessage" | "messagesFor" | "groupByThread" | "onChange">;
  starters: { get(threadId: string): string | undefined; set(threadId: string, person: string): void };
  audienceOf(threadId: string): Audience;
  personKeyOf(email: string): string;
  /** A current teammate by person key. */
  person(key: string): Teammate | undefined;
  /** What one person may read, as their own session would. */
  sees(person: string, threadId: string): boolean;
  /** Sends a notification as it is, past `route`. */
  send(notification: Notification): void;
  /** The person an ask in this conversation is for; null: the Admins. */
  askedPerson(botId: string | undefined, threadId: string): string | null;
  /** The conversation that handed work into this one, when it was handed. */
  handedFrom?(threadId: string): string | null;
  /** Starts this bot's turn in its conversation with a line from someone else, or queues it behind the running one. */
  continueTurn(botId: string, threadId: string, text: string, from: { botId: string; name: string }, relay: Relay): void;
  representative?: Representative;
  /** A bot's shared notes (its team layer). */
  notes(botId: string): string;
  /** Gives a member who has neither a Chief nor a MausBot yet the MausBot every member gets. */
  ensureOwnBot?(email: string): void;
  now?: () => number;
}

export function createPersonInbox(deps: PersonInboxDeps) {
  const { team, store } = deps;
  const now = deps.now ?? Date.now;
  const file = join(deps.dataDir, PERSON_INBOX_FILE);
  let homes: Record<string, { botId: string; threadId: string }> = {};
  let items: Item[] = [];
  if (team) {
    try {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (parsed.success) ({ homes, items } = parsed.data);
      else console.warn(`person inbox: ${file} is not an inbox file; starting fresh`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`person inbox: ${file} is unreadable; starting fresh`);
    }
  }
  const save = () => {
    items = items.filter((item) => now() - item.at < KEEP_MS).slice(-MAX_ITEMS);
    try {
      writeFileAtomic(file, `${JSON.stringify({ version: 1, homes, items })}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(`person inbox: could not save ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const ownerKey = (bot: BotRecord) => { const email = botOwner(bot); return email ? deps.personKeyOf(email) : null; };
  /** The person's own Chief, else their own MausBot. */
  function representativeOf(person: string): BotRecord | null {
    const own = (bot: BotRecord) => !bot.hidden && ownerKey(bot) === person;
    return store.bots.find((bot) => bot.chiefOfStaff && own(bot)) ?? store.bots.find((bot) => Boolean(bot.defaultBot?.person) && own(bot)) ?? null;
  }

  /** The person's inbox: the one it was, while its bot still represents them, else their own chat with that bot (the one
   * their brief was in first), else a new one. */
  function home(person: string): { bot: BotRecord; threadId: string } | null {
    if (!team || !deps.person(person)) return null;
    const email = representativeOf(person) ? undefined : deps.person(person)?.email;
    if (email) deps.ensureOwnBot?.(email);
    const bot = representativeOf(person);
    if (!bot) return null;
    const kept = homes[person];
    const task = kept?.botId === bot.id ? store.taskByThread(bot.id, kept.threadId) : undefined;
    if (task && !task.archivedAt) return { bot, threadId: task.threadId };
    const own = store.tasks(bot.id).filter((one) => !one.archivedAt && !one.routineRunId && !one.openedBy && deps.starters.get(one.threadId) === person);
    const brief = own.find((one) => one.title === BRIEF_TITLE);
    const chat = brief ?? own.sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))[0];
    let threadId = chat?.threadId;
    if (brief) store.patchTask(bot.id, brief.threadId, { title: INBOX_TITLE });
    else if (!chat) {
      const created = store.createTask(bot.id, INBOX_TITLE, false);
      if (!created) return null;
      deps.starters.set(created.threadId, person);
      threadId = created.threadId;
    }
    homes[person] = { botId: bot.id, threadId: threadId! };
    indexHomes();
    save();
    return { bot, threadId: threadId! };
  }

  let homeThreads = new Map<string, string>();
  const indexHomes = () => { homeThreads = new Map(Object.entries(homes).map(([key, at]) => [at.threadId, key])); };
  indexHomes();

  /** Whose inbox this conversation is, or null. */
  function personOf(threadId: string): string | null {
    const key = homeThreads.get(threadId);
    return key && representativeOf(key)?.id === homes[key]?.botId ? key : null;
  }

  function titleOf(origin: Origin): string {
    const group = origin.groupId ? store.groupByThread(origin.threadId) : undefined;
    if (group) return group.name;
    const bot = store.bot(origin.botId);
    const task = store.taskByThread(origin.botId, origin.threadId);
    const first = store.tasks(origin.botId).filter((one) => !one.routineRunId).sort((a, b) => a.createdAt - b.createdAt)[0];
    const main = deps.audienceOf(origin.threadId) === "team" && first?.threadId === origin.threadId;
    return task && !main ? task.title : bot?.name ?? task?.title ?? "";
  }

  const line = (item: Item) => store.messagesFor(item.threadId).find((message) => message.id === item.id);

  function notifyItem(item: Item, title: string, kind: Notification["kind"], body: string): void {
    const bot = store.bot(item.botId);
    if (!bot || bot.notifications === false) return;
    deps.send({ kind, botId: bot.id, botName: bot.name, threadId: item.threadId, title, body: oneLine(body, 200), forPerson: item.person, ...(bot.avatarUrl ? { avatarUrl: bot.avatarUrl } : {}) });
  }

  /** The person's shared facts: the notes and the work of their bots the whole team sees, and nothing private. */
  function shared(person: string, representative: BotRecord): SharedFacts {
    const theirs = store.bots.filter((bot) => !bot.hidden && !isRestricted(bot.visibility) && (bot.id === representative.id || ownerKey(bot) === person));
    return {
      notes: theirs.flatMap((bot) => { const text = clip(deps.notes(bot.id), NOTE_MAX); return text ? [{ bot: bot.name, text }] : []; }),
      work: theirs.filter((bot) => bot.id !== representative.id).map((bot) => ({
        bot: bot.name, ...(bot.title ? { role: bot.title } : {}), status: peerStatusWords(peerStatus(bot.activity, bot.busy)),
        on: store.tasks(bot.id).filter((task) => task.activity === "working" && deps.audienceOf(task.threadId) === "team").map((task) => task.title).slice(0, 3),
      })),
    };
  }

  function deliver(to: string, delivery: Delivery): Item | null {
    const at = home(to);
    const origin = delivery.origin;
    if (!at) {
      const bot = origin && deps.sees(to, origin.threadId) && !delivery.card ? store.bot(origin.botId) : null;
      if (bot && !delivery.quiet) deps.send({ kind: delivery.notify, botId: bot.id, botName: bot.name, threadId: origin!.threadId, title: delivery.title, body: oneLine(delivery.text, 200), forPerson: to, ...(origin!.groupId ? { groupId: origin!.groupId } : {}) });
      return null;
    }
    const wire: InboxItem = {
      kind: delivery.kind, from: delivery.from, ...(delivery.via ? { via: delivery.via } : {}),
      ...(origin && deps.sees(to, origin.threadId) ? { origin: { ...origin, title: titleOf(origin) } } : {}),
      ...(delivery.to ? { replies: true as const } : {}),
      ...(delivery.assistant ? { assistant: true as const } : {}),
    };
    const posted = store.appendMessage(at.threadId, delivery.card
      ? { role: "bot", kind: "options", text: delivery.text, card: { ...delivery.card }, inbox: wire }
      : { role: "bot", kind: "text", text: delivery.text, inbox: wire });
    store.patchTask(at.bot.id, at.threadId, { unread: true });
    const item: Item = {
      id: posted.id, person: to, botId: at.bot.id, threadId: at.threadId, kind: delivery.kind, from: delivery.from.name.slice(0, 200),
      ...(delivery.from.email ? { fromEmail: delivery.from.email } : {}), ...(delivery.from.botId ? { fromBot: delivery.from.botId } : {}),
      ...(delivery.to ? { to: delivery.to } : {}), ...(delivery.asker ? { asker: delivery.asker } : {}),
      ...(origin ? { origin } : {}),
      ...(delivery.card?.requestId ? { requestId: delivery.card.requestId } : {}), text: oneLine(delivery.text, 400), at: now(),
    };
    items.push(item);
    save();
    if (delivery.representable && deps.representative) void represent(item, delivery, at.bot);
    else if (!delivery.quiet) notifyItem(item, delivery.title, delivery.notify, delivery.text);
    return item;
  }

  const asked = new Map<string, number[]>();
  /** Their assistant answers a fact, or leaves the question for them; either way one notification says which. */
  async function represent(item: Item, delivery: Delivery, bot: BotRecord): Promise<void> {
    const recent = (asked.get(item.person) ?? []).filter((at) => now() - at < HOUR_MS);
    const person = recent.length < ASSISTANT_HOURLY ? deps.person(item.person) : undefined;
    if (person) asked.set(item.person, [...recent, now()]);
    let answer: string | null = null;
    try {
      answer = person ? await deps.representative!.answer({
        person: { key: person.key, name: person.name }, bot: { id: bot.id }, team: team?.name ?? "", asker: item.from, question: delivery.text, shared: shared(item.person, bot),
      }) : null;
    } catch (error) {
      console.warn(`person inbox: the assistant could not answer: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (answer && answerItem(item, answer, "assistant").status === 200) {
      notifyItem(item, `${delivery.title} · your assistant answered`, delivery.notify, `${delivery.text} → ${answer}`);
    } else notifyItem(item, delivery.title, delivery.notify, delivery.text);
  }

  /** The person answered this line, or their assistant did: the answer goes back where it came from. */
  function answerItem(item: Item, text: string, by: "person" | "assistant"): Passed {
    const replier = deps.person(item.person);
    if (!replier) return { status: 410, text: "This inbox's person has left the team." };
    const label = by === "assistant" ? `${replier.name}'s assistant answered` : `${replier.name} replied`;
    const relay: Relay = { kind: by === "assistant" ? "assistant" : "reply", email: replier.email, name: replier.name };
    let passed: Passed;
    if (item.to === "bot" && item.origin) {
      const { botId, threadId, groupId } = item.origin;
      const asker = store.bot(botId), rep = store.bot(item.botId);
      const group = groupId ? store.groupByThread(threadId) : undefined;
      if (!asker || !rep || (groupId ? !group?.memberIds.includes(botId) : !store.taskByThread(botId, threadId))) {
        return { status: 410, text: `The conversation ${item.from} asked from is gone, so the answer can't reach it.` };
      }
      if (group) {
        store.appendMessage(threadId, { role: "bot", kind: "text", text: `${label}: ${text}`, relay, from: { botId: asker.id, name: asker.name, color: asker.color } });
        store.patchGroup(group.id, { unread: true });
      } else {
        const quoted = JSON.stringify(oneLine(item.text, 160));
        deps.continueTurn(botId, threadId, by === "assistant"
          ? `${replier.name}'s assistant answered your message (${quoted}), from what ${replier.name} shares with the team: ${text}`
          : `${replier.name} replied to your message (${quoted}): ${text}`, { botId: rep.id, name: rep.name }, relay);
      }
      passed = { status: 200, text: `Passed back to ${item.from}, who carries on with it.` };
    } else if (item.to === "person" && item.asker) {
      const delivered = deliver(item.asker, {
        kind: "message", from: { name: replier.name, email: replier.email }, to: "person", asker: item.person,
        ...(item.origin ? { origin: item.origin } : {}), text, title: label, notify: "mention", ...(by === "assistant" ? { assistant: true } : {}),
      });
      if (!delivered) return { status: 409, text: `${item.from} has no inbox here, so the answer can't reach them.` };
      passed = { status: 200, text: `Passed back to ${item.from}'s inbox; they were notified.` };
    } else return { status: 409, text: "Nothing waits on an answer there." };
    item.answered = true;
    const posted = line(item);
    if (posted?.inbox) store.patchMessage(item.threadId, item.id, { inbox: { ...posted.inbox, answers: [...(posted.inbox.answers ?? []), { by, text: oneLine(text, 600), at: now() }] } });
    save();
    return passed;
  }

  /** The newest open card in a conversation, by the bot that asked. */
  function openCard(botId: string, threadId: string): NonNullable<Message["card"]> | undefined {
    return store.messagesFor(threadId).findLast((message) => message.kind === "options" && message.card?.requestId && !message.card.answered && !message.card.dismissed
      && !message.inbox && (!message.from || message.from.botId === botId))?.card;
  }

  /** An ask, a failure or a routine's report routed to a person reaches their inbox, and the one notification about it
   * comes from there. Anything else, and an ask in the person's own chat where they are, goes out as it is. */
  function route(notification: Notification, how: { routine?: boolean } = {}): Notification | null {
    const result = notification.kind === "done" && how.routine === true;
    if (!team || notification.forPerson || (!ASK_NOTIFICATIONS.has(notification.kind) && !result)) return notification;
    const person = deps.askedPerson(notification.botId, notification.threadId);
    if (!person || personOf(notification.threadId)) return notification;
    const own = audienceMember(deps.audienceOf(notification.threadId)) === person;
    if (own && !how.routine && !deps.handedFrom?.(notification.threadId)) return notification;
    const card = notification.kind === "approval" || notification.kind === "question" ? openCard(notification.botId, notification.threadId) : undefined;
    const copied = card && items.find((item) => item.requestId === card.requestId && item.origin?.threadId === notification.threadId && item.person === person);
    const kind: Item["kind"] = card || notification.kind === "approval" || notification.kind === "question" ? "ask" : result ? "result" : "notice";
    const delivered = copied || deliver(person, {
      kind, from: { name: notification.botName, botId: notification.botId },
      origin: { botId: notification.botId, threadId: notification.threadId, ...(notification.groupId ? { groupId: notification.groupId } : {}) },
      text: notification.body || notification.title, title: notification.title, notify: notification.kind, ...(card ? { card } : {}), quiet: true,
    });
    if (!delivered) return notification;
    const bot = store.bot(delivered.botId);
    if (!bot || bot.notifications === false) return null;
    const { groupId: _room, avatarUrl: _face, ...rest } = notification;
    return { ...rest, botId: bot.id, botName: bot.name, threadId: delivered.threadId, forPerson: person, ...(bot.avatarUrl ? { avatarUrl: bot.avatarUrl } : {}) };
  }

  /** Where an answer to a card in this conversation goes: an inbox's copy answers the conversation that asked. */
  function answeredIn(threadId: string, requestId: string): string {
    return items.find((item) => item.threadId === threadId && item.requestId === requestId && item.origin)?.origin?.threadId ?? threadId;
  }

  const unsubscribe = team ? store.onChange((change: StoreChange) => {
    if (change.type === "message.patch" && change.message.card?.requestId && !change.message.inbox) {
      const card = change.message.card;
      for (const item of items) {
        if (item.requestId !== card.requestId || item.origin?.threadId !== change.threadId) continue;
        const copy = line(item);
        if (copy?.card && JSON.stringify(copy.card) !== JSON.stringify(card)) store.patchMessage(item.threadId, item.id, { card: { ...card } });
      }
    } else if (change.type === "thread.deleted") {
      const before = items.length;
      items = items.filter((item) => item.threadId !== change.threadId);
      for (const [key, at] of Object.entries(homes)) if (at.threadId === change.threadId) delete homes[key];
      indexHomes();
      if (items.length !== before) save();
    }
  }) : () => {};

  return {
    home,
    personOf,
    deliver,
    route,
    answeredIn,
    answer: answerItem,
    /** The line in this inbox that `messageId` is, when it waits on an answer. */
    replyable(threadId: string, messageId: string): Item | undefined {
      return items.find((item) => item.threadId === threadId && item.id === messageId && item.to !== undefined);
    },
    /** The newest line in this inbox from this sender (a teammate's name or address, or a bot's name) that waits on an answer. */
    waitingFrom(threadId: string, sender: string): Item | undefined {
      const wanted = sender.replace(/^@+/, "").replace(/\s+/g, " ").trim().toLowerCase();
      return items.findLast((item) => item.threadId === threadId && item.to !== undefined && !item.answered
        && (item.from.toLowerCase() === wanted || item.from.toLowerCase().split(" ")[0] === wanted || item.fromEmail === wanted));
    },
    /** This line of a conversation already reached this person's inbox. */
    reached(person: string, threadId: string, messageId: string): boolean {
      return items.some((item) => item.person === person && item.origin?.threadId === threadId && item.origin.messageId === messageId);
    },
    /** The lines in this inbox that wait on its person's answer, oldest first. */
    waiting(threadId: string): Item[] {
      return items.filter((item) => item.threadId === threadId && item.to !== undefined && !item.answered);
    },
    /** What arrived in this person's inbox that they have not opened yet, newest first. */
    unseen(person: string): Item[] {
      return items.filter((item) => item.person === person && !item.seen && !item.answered).sort((a, b) => b.at - a.at);
    },
    /** The person opened or wrote in this conversation: what waited there for them is seen. */
    seen(person: string, threadId: string): void {
      let changed = false;
      for (const item of items) if (item.person === person && item.threadId === threadId && !item.seen) { item.seen = true; changed = true; }
      if (changed) save();
    },
    /** The person left: their inbox and what waited in it are forgotten. */
    forget(person: string): void {
      delete homes[person];
      indexHomes();
      items = items.filter((item) => item.person !== person);
      save();
    },
    stop: unsubscribe,
  };
}

export type PersonInbox = ReturnType<typeof createPersonInbox>;
