/** A message: plain text with `{param}` slots, or plural forms chosen by `params.n` (Intl.PluralRules). */
export type Plural = { zero?: string; one?: string; two?: string; few?: string; many?: string; other: string };
export type Msg = string | Plural;
export type Dict = Record<string, Msg>;
/** A Russian (or any other) dictionary for an area: exactly the English keys, no more, no less. */
export type Translation<D> = { [K in keyof D]: Msg };
