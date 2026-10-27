import { describe, expect, it } from "vitest";

import { chiefOfStaffSystemPrompt, chiefSetsThreadModel, chiefTidies } from "./chief-of-staff.ts";

describe("chiefTidies", () => {
  const chief = { id: "chief", name: "Chief", section: "Work", chiefOfStaff: true };
  const opener = { id: "opener", name: "Opener", section: "Work" };
  const recipient = { id: "recipient", name: "Recipient", section: "Work" };
  const task = { openedBy: { botId: opener.id, name: opener.name, threadId: "source", at: 1 } };

  it("allows only Chiefs and bot-opened, non-routine threads", () => {
    expect(chiefTidies(chief, task, opener, recipient)).toBe(true);
    expect(chiefTidies({ ...chief, chiefOfStaff: false }, task, opener, recipient)).toBe(false);
    expect(chiefTidies(chief, {}, opener, recipient)).toBe(false);
    expect(chiefTidies(chief, { ...task, routineRunId: "run" }, opener, recipient)).toBe(false);
  });

  it("needs authority over both the opener and the thread's own bot, which reach alone never gives", () => {
    expect(chiefTidies({ ...chief, peers: ["recipient"] }, task, opener, recipient)).toBe(false);
    expect(chiefTidies(chief, task, { ...opener, section: "Private" }, recipient)).toBe(false);
    expect(chiefTidies(chief, task, opener, { ...recipient, section: "Private" })).toBe(false);
    expect(chiefTidies(chief, task, { ...opener, hidden: true }, recipient)).toBe(false);
    expect(chiefTidies(chief, task, { ...opener, visibility: { people: ["person@example.test"] } }, recipient)).toBe(false);
    expect(chiefTidies({ ...chief, managedSections: ["Private"] }, task, { ...opener, section: "Private" }, { ...recipient, section: "Private" })).toBe(true);
  });
});

describe("chiefSetsThreadModel", () => {
  const chief = { id: "chief", name: "Chief", section: "Work", chiefOfStaff: true };
  const opener = { id: "opener", name: "Opener", section: "Work" };
  const recipient = { id: "recipient", name: "Recipient", section: "Work" };
  const delegated = { openedBy: { botId: opener.id, name: opener.name, threadId: "source", at: 1 } };

  it("allows a Chief its own opened threads and the delegation threads it manages", () => {
    expect(chiefSetsThreadModel(chief, { openedBy: { botId: chief.id, name: chief.name, threadId: "s", at: 1 } }, chief, recipient)).toBeNull();
    expect(chiefSetsThreadModel(chief, delegated, opener, recipient)).toBeNull();
    expect(chiefSetsThreadModel(chief, {}, undefined, chief)).toBeNull();
    expect(chiefSetsThreadModel(chief, { openedBy: { botId: chief.id, name: chief.name, threadId: "s", at: 1 } }, chief, { ...recipient, section: "Private" })).not.toBeNull();
  });

  it("refuses person-started threads, other sections' threads, routine threads and non-Chiefs", () => {
    expect(chiefSetsThreadModel(chief, {}, undefined, recipient)).toContain("the person started");
    expect(chiefSetsThreadModel(chief, delegated, { ...opener, section: "Private" }, recipient)).toContain("cannot manage");
    expect(chiefSetsThreadModel(chief, { ...delegated, routineRunId: "run" }, opener, recipient)).toContain("automation");
    expect(chiefSetsThreadModel({ ...chief, chiefOfStaff: false }, { openedBy: { botId: "chief", name: "Chief", threadId: "s", at: 1 } }, chief, chief)).toContain("Chief of Staff");
  });
});

describe("chiefOfStaffSystemPrompt roster caps", () => {
  it("clips oversized persona fields instead of interpolating them whole", () => {
    const prompt = chiefOfStaffSystemPrompt(
      "chief",
      [
        { id: "chief", name: "Atlas" },
        {
          id: "big",
          name: "N".repeat(500),
          title: "T".repeat(500),
          description: "D".repeat(10_000),
        },
      ],
      true,
    );
    const rosterLine = prompt.split("\n").find((line) => line.startsWith("- N"))!;
    expect(rosterLine.length).toBeLessThan(500);
    expect(rosterLine).toContain("…");
  });

  it("caps the roster length and says how many were left out", () => {
    const team = Array.from({ length: 60 }, (_, i) => ({ id: `bot${i}`, name: `Bot ${i}` }));
    const prompt = chiefOfStaffSystemPrompt("chief", [{ id: "chief", name: "Atlas" }, ...team], true);
    expect(prompt).toContain("Bot 39");
    expect(prompt).not.toContain("Bot 40 —");
    expect(prompt).toContain("…and 20 more");
  });
});

describe("chiefOfStaffSystemPrompt", () => {
  const bots = [
    { id: "chief", name: "Atlas", title: "Operations", section: "Work" },
    { id: "writer", name: "Quill", title: "Writer", description: "Drafts concise copy", section: "Work" },
    { id: "coder", name: "Patch", title: "Engineer", busy: true, section: "Work" },
    { id: "hidden", name: "Secret", hidden: true, section: "Work" },
    { id: "personal", name: "Scout", title: "Travel planner", section: "Personal" },
  ];

  it("describes visible teammates and roles, but not who is busy", () => {
    const prompt = chiefOfStaffSystemPrompt("chief", bots, true);

    expect(prompt).toContain("Chief of Staff for the Work department");
    expect(prompt).toContain("Quill — Writer: Drafts concise copy [id: writer]");
    expect(prompt).toContain("Patch — Engineer [id: coder]");
    expect(prompt).not.toContain("working right now");
    expect(prompt).not.toContain("(available)");
    expect(prompt).not.toContain("Secret");
    expect(prompt).toContain("Other bots you can reach, in other departments:\n- Scout — Travel planner (Personal) [id: personal]");
    expect(prompt).not.toContain("Travel planner (Personal): ");
    expect(prompt).not.toContain("Atlas —");
    expect(prompt).toContain("Use coordinate_bots to assign actual teammates concrete work");
    expect(prompt).toContain("keeps you available to the user");
    expect(prompt).toContain("you resume automatically when their results return, success or failure");
    expect(prompt).toContain("Do not poll or wait");
    expect(prompt).toContain("with consult: true to ask them for advice");
    expect(prompt).toContain("Consultations are advice, not proof that work or tests ran");
    expect(prompt).not.toMatch(/\b(delegate_bot|ask_bot|send_to_bot|check_delegation|wait_delegation)\b/);
    expect(prompt).toContain("propose_team_setup once");
    expect(prompt).toContain("structured result");
  });

  it("is the person's assistant, does the work itself and adds a specialist without asking", () => {
    const prompt = chiefOfStaffSystemPrompt("chief", [{ id: "chief", name: "Atlas" }], true);

    expect(prompt).toContain("You are the person's assistant");
    expect(prompt).toContain("Do the work yourself");
    expect(prompt).toContain("add one with create_bot without asking first, then tell the person in one line");
    expect(prompt).toContain("an ongoing area of work, a different skill set, or work to run in parallel");
    expect(prompt).toContain("When their goal matches a ready-made team, list_team_library has its roles");
    expect(prompt, "a suggestion no longer waits on a card").not.toMatch(/suggestion|Not now/);
  });

  it("does not promise delegation when the engine cannot mount agent tools", () => {
    const prompt = chiefOfStaffSystemPrompt("chief", bots, false);

    expect(prompt).toContain("cannot contact teammates");
    expect(prompt).not.toContain("coordinate_bots");
    expect(prompt, "never name a tool the engine cannot call").not.toContain("create_bot");
  });

  it("follows staffing result states", () => {
    const prompt = chiefOfStaffSystemPrompt("chief", bots, true);
    expect(prompt).toContain("after an applied result, continue already-requested work without another confirmation");
    expect(prompt).toContain("Only if review is pending, end your turn");
    expect(prompt).toContain("Report failed or cancelled results honestly");
    expect(prompt).toContain("Existing thread models and other bots' execution permissions stay unchanged");
    expect(prompt).toContain("For explicitly requested bot deletion");
    expect(prompt).not.toContain("End your turn after the proposal:");
  });


  it("tells a place's MausBot that is not the Chief that the person's day and brief are its own, and a member's that they are not", () => {
    const place = chiefOfStaffSystemPrompt("maus", [{ id: "maus", name: "MausBot", defaultBot: {} }], true);
    expect(place).toContain("but you are not the Chief: team incidents and escalations stay with the Chief.");
    expect(place).toContain("Keeping an eye on the person's day and their daily brief are yours.");
    const member = chiefOfStaffSystemPrompt("maus", [{ id: "maus", name: "MausBot", defaultBot: { person: "ada@example.test" } }], true);
    expect(member).toContain("but you are not the Chief: the daily brief, team incidents and escalations stay with the Chief.");
    expect(member).not.toContain("daily brief are yours");
  });

  it("narrows the Chief's own roster when the Chief carries an allow-list", () => {
    const prompt = chiefOfStaffSystemPrompt(
      "chief",
      bots.map((bot) => (bot.id === "chief" ? { ...bot, peers: ["coder"] } : bot)),
      true,
    );

    expect(prompt).toContain("Patch — Engineer [id: coder]");
    expect(prompt).not.toContain("Quill");
  });
});
