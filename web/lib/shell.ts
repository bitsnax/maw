/** Single-quoted for sh: safe for any text without NUL. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
