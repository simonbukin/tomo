export const plainTextInput = { autoCapitalize: "none", autoCorrect: "off", spellCheck: false } as const;

export type ClassValue = string | false | null | undefined;

/** Base UI accepts a className function; Tomo primitives take a plain string. */
export type WithClassName<P> = Omit<P, "className"> & { className?: string };

export function cx(...values: ClassValue[]): string {
  return values.filter(Boolean).join(" ");
}
