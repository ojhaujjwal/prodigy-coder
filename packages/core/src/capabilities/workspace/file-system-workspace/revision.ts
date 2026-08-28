import { Hash } from "effect";

/** Hash-based revision for optimistic concurrency. */
export const revisionOf = (content: string): string => Hash.hash(content).toString(16);
