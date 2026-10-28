/** On a Team Cloud, a line in a person's inbox: their own conversation with their own Chief of Staff (their own MausBot
 * when they crowned none), where everything addressed to them arrives. It says who it is from and where it came from,
 * so clients can label it and open that conversation. Replying to the line answers it: the answer goes back where it
 * came from. */
export interface InboxItem {
  /** "message": a teammate's or a bot's message, or an @mention; "ask": a question or approval card, copied here
   * and answered here as there; "result": a routine's report; "notice": a failure or a sign-in it needs. */
  kind: "message" | "ask" | "result" | "notice";
  /** Who it is from: a teammate (their address) or a bot (its id). */
  from: { name: string; email?: string; botId?: string };
  /** The bot that passed a teammate's message on. */
  via?: { botId: string; name: string };
  /** The conversation it came from, when the person may open it. */
  origin?: { botId: string; threadId: string; title: string; groupId?: string; messageId?: string };
  /** It waits on the person's answer. */
  replies?: true;
  /** The sender's assistant wrote it for them, from what they share with the team. */
  assistant?: true;
  /** How it was answered: the person's own words, or their assistant's, which answers facts only. */
  answers?: Array<{ by: "person" | "assistant"; text: string; at: number }>;
}
