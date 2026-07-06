export function fixMojibake(value: string): string {
  if (!value || !/[ÃØÙÛÄÅï]/.test(value)) {
    return value;
  }

  try {
    const bytes = Uint8Array.from(value, (char) => char.charCodeAt(0) & 0xff);
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return value;
  }
}
