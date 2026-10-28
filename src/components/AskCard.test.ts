import { createElement, type KeyboardEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const mode = vi.hoisted(() => ({ advanced: true }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => mode.advanced }));

import { AskCard, AskChoiceLetter, AskSettledLine, moveChoiceFocus } from "./AskCard";

afterEach(() => {
  vi.unstubAllGlobals();
  mode.advanced = true;
});

describe("AskCard", () => {
  it("leads with an accent title and an optional line on why in Advanced mode", () => {
    const html = renderToStaticMarkup(createElement(AskCard, {
      ariaLabel: "Plan",
      icon: null,
      title: "Choose a plan",
      explanation: "The workspace needs one before it can start.",
    }));
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Plan"');
    expect(html).toMatch(/text-accent-text[^"]*"><bdi dir="auto">Choose a plan</);
    expect(html).toContain("The workspace needs one before it can start.");
    expect(html).toContain("text-start");
    expect(html).not.toContain("text-left");
    expect(html).toContain("rounded-2xl bg-composer");
    expect(html).toContain("ring-1 ring-composer-ring");
    expect(html).not.toContain("border-accent");
    expect(html).not.toContain("shadow");
  });

  it("is Simple mode's question card: the composer's surface, 560 wide, rounded 20, a 16/22 semibold title in secondary ink", () => {
    mode.advanced = false;
    const html = renderToStaticMarkup(createElement(AskCard, { ariaLabel: "Plan", icon: null, title: "Choose a plan", explanation: "Why it asks." }));
    const card = html.match(/^<div[^>]*class="([^"]*)"/)![1]!.split(" ");
    expect(card).toEqual(expect.arrayContaining(["bg-composer", "ring-[0.5px]", "ring-ink/10", "max-w-[560px]", "rounded-[24px]", "w-full"]));
    expect(card).not.toContain("rounded-2xl");
    expect(html).toMatch(/text-\[16px\] font-semibold leading-\[22px\] text-ink-secondary"><bdi dir="auto">Choose a plan</);
    expect(html).not.toContain("text-accent-text\"><bdi");
  });

  it("letters each Simple choice in a 24px rounded box, greyed when quiet", () => {
    const box = (props: Parameters<typeof AskChoiceLetter>[0]) => renderToStaticMarkup(createElement(AskChoiceLetter, props)).match(/class="([^"]*)"/)![1]!.split(" ");
    expect(box({ letter: "A" })).toEqual(expect.arrayContaining(["size-6", "rounded-[7px]", "bg-ink/[0.06]", "text-[12px]", "text-ink-secondary"]));
    expect(box({ letter: "A", quiet: true })).toContain("text-ink-tertiary");
    expect(box({ letter: "A", picked: true })).toContain("text-ink");
  });

  it("offers a dismiss button only with a name for it", () => {
    const base = { ariaLabel: "Key", icon: null, title: "API key" };
    expect(renderToStaticMarkup(createElement(AskCard, { ...base, onDismiss: () => {} }))).not.toContain("<button");
    expect(renderToStaticMarkup(createElement(AskCard, { ...base, onDismiss: () => {}, dismissLabel: "Not now" })))
      .toContain('aria-label="Not now"');
  });

  it("settles into one quiet line that announces itself", () => {
    const html = renderToStaticMarkup(createElement(AskSettledLine, { ariaLabel: "Plan", children: "Choose a plan · Pro" }));
    expect(html).toContain('data-ask-card="settled"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("truncate");
    expect(html).toContain("Choose a plan · Pro");
  });
});

describe("moveChoiceFocus", () => {
  function setup(direction: "ltr" | "rtl", focused: number) {
    const items = [0, 1, 2].map(() => ({ focus: vi.fn() }));
    vi.stubGlobal("document", { activeElement: items[focused] });
    vi.stubGlobal("getComputedStyle", () => ({ direction }));
    const group = { querySelectorAll: () => items };
    const press = (key: string) => {
      const event = { key, currentTarget: group, preventDefault: vi.fn() } as unknown as KeyboardEvent<HTMLElement>;
      moveChoiceFocus(event);
      return event;
    };
    return { items, press };
  }

  it("moves forward and wraps with the arrows", () => {
    const { items, press } = setup("ltr", 2);
    press("ArrowRight");
    expect(items[0]!.focus).toHaveBeenCalled();
  });

  it("follows the reading direction in a right-to-left chat", () => {
    const { items, press } = setup("rtl", 0);
    press("ArrowLeft");
    expect(items[1]!.focus).toHaveBeenCalled();
  });

  it("jumps to the ends with Home and End", () => {
    const { items, press } = setup("ltr", 1);
    press("End");
    expect(items[2]!.focus).toHaveBeenCalled();
    press("Home");
    expect(items[0]!.focus).toHaveBeenCalled();
  });

  it("leaves every other key alone", () => {
    const { items, press } = setup("ltr", 1);
    const event = press("Enter");
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(items.every((item) => item.focus.mock.calls.length === 0)).toBe(true);
  });
});
