export function createUuidFromHex(value: string) {
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-${((Number.parseInt(value.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${value.slice(17, 20)}-${value.slice(20, 32)}`;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
