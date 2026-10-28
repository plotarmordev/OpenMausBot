import type { DatabaseSync } from "node:sqlite";

import type { Message } from "./store.ts";

/** Runs inside the caller's migration transaction. */
export function migrateInputOrder(database: DatabaseSync): void {
  for (const table of ["messages", "chat_followups"]) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === "input_order")) database.exec(`ALTER TABLE ${table} ADD COLUMN input_order INTEGER`);
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS input_order (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL);
    INSERT OR IGNORE INTO input_order(id, value) VALUES (1, 0);
  `);
}

/** Call inside a transaction: the reserved value and the row it stamps commit together. */
export function nextInputOrder(database: DatabaseSync): number {
  return Number(database.prepare("UPDATE input_order SET value = value + 1 WHERE id = 1 RETURNING value").get()!.value);
}

/** A user line takes its place once, when first stored; rewriting it keeps that place. */
export function isNewInput(database: DatabaseSync, threadId: string, message: Message): boolean {
  return message.role === "user" && message.kind === "text" &&
    !database.prepare("SELECT 1 FROM messages WHERE thread_id = ? AND id = ?").get(threadId, message.id);
}

export function stampInputOrder(database: DatabaseSync, threadId: string, messageId: string): void {
  database.prepare("UPDATE messages SET input_order = ? WHERE thread_id = ? AND id = ?").run(nextInputOrder(database), threadId, messageId);
}

/** A line without an order (legacy, or a coordinated turn that reserved none) fails closed: something may be newer. */
export function queuedInputAfter(database: DatabaseSync, kind: string, ownerId: string, threadId: string, messageId: string | undefined,
  coordinatedInputOrder?: number): boolean {
  const order = messageId
    ? database.prepare("SELECT input_order FROM messages WHERE thread_id = ? AND id = ?").get(threadId, messageId)?.input_order
    : coordinatedInputOrder;
  if (order == null) return true;
  return Boolean(database.prepare(
    "SELECT 1 FROM chat_followups WHERE kind = ? AND owner_id = ? AND thread_id = ? AND status = 'pending' AND (input_order IS NULL OR input_order > ?) AND json_extract(payload, '$.recovery') IS NULL LIMIT 1",
  ).get(kind, ownerId, threadId, order));
}
