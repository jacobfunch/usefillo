import type { Flags } from "./flags.js";

/**
 * One CLI command, registered in the index REGISTRY. Adding a command is a new
 * module exporting a `Command` plus one line in the registry.
 */
export type Command = {
  name: string;
  aliases?: readonly string[];
  /** Per-command flag allow-list, merged with the global flags at validation. */
  flags: readonly string[];
  run: (args: string[], flags: Flags) => void | Promise<void>;
  /** Command-family help printed for `fillo <name> --help`. */
  help?: () => void;
};
