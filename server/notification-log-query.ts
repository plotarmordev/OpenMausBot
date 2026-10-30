import type { DatabaseSync } from "node:sqlite";

import type { NotificationLogEntry } from "../shared/notification.ts";
import type { OpenTransaction } from "./sqlite-transaction.ts";

const NOTIFICATION_LOG_LIMIT = 500;

const rowToNotificationLogEntry = (row: {
  id: string; at: number; kind: string; bot_id: string; bot_name: string; thread_id: string;
  group_id: string | null; title: string; body: string; avatar_url: string | null; read: number; for_person: string | null;
}): NotificationLogEntry => ({
  id: row.id,
  at: row.at,
  kind: row.kind as NotificationLogEntry["kind"],
  botId: row.bot_id,
  botName: row.bot_name,
  threadId: row.thread_id,
  ...(row.group_id ? { groupId: row.group_id } : {}),
  title: row.title,
  body: row.body,
  ...(row.avatar_url ? { avatarUrl: row.avatar_url } : {}),
  ...(row.for_person ? { forPerson: row.for_person } : {}),
  read: row.read !== 0,
});

export function insertNotificationRow(database: OpenTransaction, entry: NotificationLogEntry): void {
  database.prepare(
    "INSERT INTO notification_log(id, at, kind, bot_id, bot_name, thread_id, group_id, title, body, avatar_url, for_person, read) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
  ).run(entry.id, entry.at, entry.kind, entry.botId, entry.botName, entry.threadId, entry.groupId ?? null, entry.title, entry.body, entry.avatarUrl ?? null, entry.forPerson ?? null);
  database.prepare(
    "DELETE FROM notification_log WHERE id NOT IN (SELECT id FROM notification_log ORDER BY at DESC, rowid DESC LIMIT ?)",
  ).run(NOTIFICATION_LOG_LIMIT);
}

export function readNotificationLog(database: DatabaseSync, limit = NOTIFICATION_LOG_LIMIT): NotificationLogEntry[] {
  const rows = database.prepare(
    "SELECT id, at, kind, bot_id, bot_name, thread_id, group_id, title, body, avatar_url, for_person, read FROM notification_log ORDER BY at DESC, rowid DESC LIMIT ?",
  ).all(limit) as Array<Parameters<typeof rowToNotificationLogEntry>[0]>;
  return rows.map(rowToNotificationLogEntry);
}

export function markNotificationRowsRead(database: DatabaseSync, ids: readonly string[]): void {
  database.prepare("UPDATE notification_log SET read = 1 WHERE read = 0 AND id IN (SELECT value FROM json_each(?))").run(JSON.stringify(ids));
}

export function markThreadNotificationRowsRead(database: DatabaseSync, threadId: string): string[] {
  const rows = database.prepare("UPDATE notification_log SET read = 1 WHERE thread_id = ? AND read = 0 RETURNING id").all(threadId) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}
