/**
 * Named accent colours.
 *
 * "Make today's sales green" has to land somewhere concrete, and a name is far
 * more robust than asking an agent to remember a hex triplet. These are the
 * names the catalog documents; anything else is passed through to CSS, so a
 * literal `#16a34a` or `rebeccapurple` works too.
 */
export const ACCENTS: Record<string, string> = {
  green: '#16a34a',
  red: '#dc2626',
  blue: '#2563eb',
  amber: '#d97706',
  violet: '#7c3aed',
  teal: '#0d9488',
  slate: '#475569',
  pink: '#db2777',
  orange: '#ea580c',
  cyan: '#0891b2',
};

/** The default categorical scale, used when a chart encodes colour by a field. */
export const CATEGORICAL = [
  '#2563eb',
  '#16a34a',
  '#d97706',
  '#7c3aed',
  '#0d9488',
  '#db2777',
  '#ea580c',
  '#0891b2',
  '#65a30d',
  '#475569',
];

export function resolveAccent(accent: string | undefined | null, fallback = CATEGORICAL[0]!): string {
  if (!accent) return fallback;
  return ACCENTS[accent.toLowerCase()] ?? accent;
}
