const MAX_INTEGER = 0x7fffffff;

function adaptBias(delta: number, points: number, first: boolean): number {
  delta = Math.floor(delta / (first ? 700 : 2));
  delta += Math.floor(delta / points);
  let bias = 0;
  while (delta > 455) {
    delta = Math.floor(delta / 35);
    bias += 36;
  }
  return bias + Math.floor((36 * delta) / (delta + 38));
}

/** RFC 3492 section 6.2, without the xn-- prefix. IDNA mapping belongs to the caller. */
export function decodePunycode(input: string): string | null {
  const delimiter = input.lastIndexOf("-");
  const output = Array.from(input.slice(0, Math.max(0, delimiter)), (text) => text.charCodeAt(0));
  if (output.some((point) => point > 0x7f)) return null;

  let cursor = delimiter + 1;
  let point = 0x80;
  let index = 0;
  let bias = 72;
  while (cursor < input.length) {
    const previous = index;
    let weight = 1;
    for (let base = 36; ; base += 36) {
      if (cursor === input.length) return null;
      const code = input.charCodeAt(cursor++);
      const digit =
        code >= 0x30 && code <= 0x39
          ? code - 0x30 + 26
          : code >= 0x41 && code <= 0x5a
            ? code - 0x41
            : code >= 0x61 && code <= 0x7a
              ? code - 0x61
              : 36;
      if (digit >= 36 || digit > Math.floor((MAX_INTEGER - index) / weight)) return null;
      index += digit * weight;
      const threshold = Math.min(26, Math.max(1, base - bias));
      if (digit < threshold) break;
      if (weight > Math.floor(MAX_INTEGER / (36 - threshold))) return null;
      weight *= 36 - threshold;
    }
    const length = output.length + 1;
    bias = adaptBias(index - previous, length, previous === 0);
    point += Math.floor(index / length);
    if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return null;
    index %= length;
    output.splice(index, 0, point);
    index += 1;
  }
  return output.map((point) => String.fromCodePoint(point)).join("");
}
