/** Validate only explicit values, leaving option recognition to the canonical parser. */
export const explicitBooleanArgumentError = (
  arguments_: readonly string[],
  booleanOptions: ReadonlySet<string>,
  valuedOptions: ReadonlySet<string>,
): string | undefined => {
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (valuedOptions.has(argument)) {
      index += 1;
      continue;
    }
    const equals = argument.indexOf("=");
    if (!argument.startsWith("--") || equals < 0) continue;
    const raw = argument.slice(2, equals);
    const name = raw
      .replace(/^no-/u, "")
      .replace(/-([a-z])/gu, (_, character: string) => character.toUpperCase());
    if (!booleanOptions.has(name)) continue;
    const value = argument.slice(equals + 1);
    if (value !== "true" && value !== "false")
      return `Invalid boolean value for --${raw}: ${value}; expected true or false`;
  }
  return undefined;
};
