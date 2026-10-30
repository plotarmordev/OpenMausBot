import type { DatabaseSync } from "node:sqlite";

declare const open: unique symbol;
export type OpenTransaction = DatabaseSync & { readonly [open]: true };
