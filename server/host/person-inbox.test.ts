import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Notification } from "../../shared/notification.ts";
import { key, MARCO, PHILIPP, teamInbox } from "../testing/team-inbox-fixture.ts";
import { PERSON_INBOX_FILE } from "./person-inbox.ts";

const fixtures: Array<ReturnType<typeof teamInbox>> = [];
const fixture = (options: Parameters<typeof teamInbox>[0] = {}) => { const made = teamInbox(options); fixtures.push(made); return made; };
afterEach(() => { for (const made of fixtures.splice(0)) made.close(); });

const ask = (botId: string, botName: string, threadId: string, kind: Notification["kind"] = "approval"): Notification =>
  ({ kind, botId, botName, threadId, title: `${botName} needs approval`, body: "Run: rm -rf ./build" });
const card = (requestId: string) => ({ title: "Run a command?", subtitle: "rm -rf ./build", options: ["Allow", "Deny"], requestId, tool: "Bash", requestType: "permission" as const });

describe("asks routed to a person", () => {
  it("copies an approval Marco owns into his inbox, sends the one notification from there, and answers the copy where it was asked", () => {
    const f = fixture();
    f.bots.find((bot) => bot.id === "reporter")!.tasks.push({ threadId: "rep-shared", title: "Weekly numbers" });
    const asked = f.store.appendMessage("rep-shared", { role: "bot", kind: "options", text: "Run a command?", card: card("req-1") });
    const sent = f.team.route(ask("reporter", "Reporter", "rep-shared"));
    const inbox = f.inboxOf(MARCO);
    expect(sent).toEqual({ kind: "approval", botId: "marcos-chief", botName: "Marco's Chief", threadId: inbox.threadId, title: "Reporter needs approval", body: "Run: rm -rf ./build", forPerson: key(MARCO.email) });
    const copy = f.lines(inbox.threadId)[0]!;
    expect(copy).toMatchObject({ kind: "options", card: card("req-1"), inbox: { kind: "ask", from: { name: "Reporter", botId: "reporter" }, origin: { threadId: "rep-shared", title: "Weekly numbers" } } });
    expect(f.team.inbox.answeredIn(inbox.threadId, "req-1")).toBe("rep-shared");
    expect(f.team.inbox.answeredIn(inbox.threadId, "req-other")).toBe(inbox.threadId);
    expect(f.team.route(ask("reporter", "Reporter", "rep-shared")), "the same card again is the same line").toMatchObject({ threadId: inbox.threadId });
    expect(f.lines(inbox.threadId)).toHaveLength(1);
    f.store.patchMessage("rep-shared", asked.id, { card: { ...card("req-1"), answered: "allow" } });
    expect(f.lines(inbox.threadId)[0]!.card).toMatchObject({ answered: "allow" });
    expect(f.notified).toEqual([]);
  });

  it("leaves an ask in the person's own chat where they are, an Admins' ask and anything not an ask as they are", () => {
    const f = fixture();
    const own = ask("scout", "Scout", "marco-private");
    expect(f.team.route(own)).toBe(own);
    const mainChief = { id: "nobodys", name: "Nobody's", color: "silver" as const, threadId: "n-main", tasks: [{ threadId: "n-main", title: "Nobody's" }] };
    f.bots.push(mainChief);
    const admins = ask("nobodys", "Nobody's", "n-main");
    expect(f.team.route(admins)).toBe(admins);
    const done: Notification = { kind: "done", botId: "scout", botName: "Scout", threadId: "scout-main", title: "Scout finished", body: "Done." };
    expect(f.team.route(done)).toBe(done);
    expect(f.team.inbox.home(key(MARCO.email))).not.toBeNull();
    expect(f.lines(f.inboxOf(MARCO).threadId)).toEqual([]);
  });

  it("brings a routine's report and its failures, even from the person's own chat, and labels where they came from", () => {
    const f = fixture();
    const report: Notification = { kind: "done", botId: "scout", botName: "Scout", threadId: "marco-private", title: "Scout finished", body: "Daily digest: 3 new leads." };
    const sent = f.team.route(report, { routine: true });
    const inbox = f.inboxOf(MARCO);
    expect(sent).toMatchObject({ kind: "done", threadId: inbox.threadId, forPerson: key(MARCO.email), title: "Scout finished" });
    expect(f.lines(inbox.threadId)[0]).toMatchObject({ text: "Daily digest: 3 new leads.", inbox: { kind: "result", origin: { threadId: "marco-private", title: "Marco and Scout" } } });
    f.team.route({ kind: "routine-failed", botId: "reporter", botName: "Reporter", threadId: "rep-main", title: "Reporter's routine failed", body: "Timed out" });
    expect(f.lines(inbox.threadId)[1]).toMatchObject({ inbox: { kind: "notice", from: { name: "Reporter" } } });
  });

  it("brings work handed on from Marco's chat that waits on him, though it runs in a chat of his own", () => {
    const f = fixture({ handed: { "marco-private": "mc-main" } });
    const sent = f.team.route(ask("scout", "Scout", "marco-private", "question"));
    const inbox = f.inboxOf(MARCO);
    expect(sent).toMatchObject({ kind: "question", threadId: inbox.threadId, forPerson: key(MARCO.email) });
    expect(f.lines(inbox.threadId)[0]).toMatchObject({ inbox: { kind: "ask", from: { name: "Scout" }, origin: { threadId: "marco-private" } } });
  });

  it("does nothing off a team", () => {
    const f = fixture({ team: false });
    const one = ask("reporter", "Reporter", "rep-main");
    expect(f.team.route(one)).toBe(one);
  });
});

describe("the inbox itself", () => {
  it("becomes the chat the person's brief was in, and moves when they crown another Chief", () => {
    const f = fixture();
    const chief = f.bots.find((bot) => bot.id === "marcos-chief")!;
    chief.tasks.push({ threadId: "brief-chat", title: "Brief" });
    f.starters.set("brief-chat", key(MARCO.email));
    expect(f.inboxOf(MARCO)).toMatchObject({ threadId: "brief-chat" });
    expect(chief.tasks.find((task) => task.threadId === "brief-chat")!.title).toBe("Inbox");
    expect(f.team.inbox.personOf("brief-chat")).toBe(key(MARCO.email));
    chief.chiefOfStaff = false;
    f.bots.find((bot) => bot.id === "reporter")!.chiefOfStaff = true;
    expect(f.team.inbox.personOf("brief-chat")).toBeNull();
    expect(f.inboxOf(MARCO).bot.id).toBe("reporter");
    expect(JSON.parse(readFileSync(join(f.dataDir, PERSON_INBOX_FILE), "utf8")).homes[key(MARCO.email)].botId).toBe("reporter");
  });

  it("forgets a person who left, and a deleted inbox", () => {
    const f = fixture();
    f.team.pass("scout", "scout-main", "Marco", "Hi");
    f.team.inbox.forget(key(MARCO.email));
    expect(f.team.inbox.unseen(key(MARCO.email))).toEqual([]);
    expect(f.team.inbox.personOf(f.inboxOf(PHILIPP).threadId)).toBe(key(PHILIPP.email));
  });
});
