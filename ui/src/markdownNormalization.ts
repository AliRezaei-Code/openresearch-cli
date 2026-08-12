// Markdown code regions are intentionally opaque to delimiter normalization.
// The unclosed-fence alternatives matter while assistant text is streaming.
const CODE_REGIONS = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g;

const CURRENCY_AMOUNT = /^\d+(?:,\d{3})*(?:\.\d+)?(?:\s*[–—-]\s*\$?\d+(?:,\d{3})*(?:\.\d+)?)?(?:\/[A-Za-z][A-Za-z0-9-]*)?/;

function unescapedDollarIndices(text: string): number[] {
  const indices: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "$") continue;
    let slashes = 0;
    for (let j = i - 1; j >= 0 && text[j] === "\\"; j -= 1) slashes += 1;
    if (slashes % 2 === 1) continue;
    if (text[i - 1] !== "$" && text[i + 1] !== "$") indices.push(i);
  }
  return indices;
}

/** Escape legacy currency markers at render time while preserving paired math. */
export function normalizeCurrencyDollars(text: string): string {
  const dollars = unescapedDollarIndices(text);
  const escaped = new Set<number>();
  const protectedMath = new Set<number>();

  for (let d = 0; d < dollars.length; d += 1) {
    const index = dollars[d]!;
    if (protectedMath.has(index)) continue;
    const next = dollars[d + 1];
    const amount = CURRENCY_AMOUNT.exec(text.slice(index + 1));

    if (!amount) {
      if (next != null) {
        protectedMath.add(index);
        protectedMath.add(next);
        d += 1;
      }
      continue;
    }

    const amountEnd = index + 1 + amount[0].length;
    if (next === amountEnd) {
      protectedMath.add(index);
      protectedMath.add(next);
      d += 1;
      continue;
    }

    if (next != null) {
      const remainder = text.slice(amountEnd, next);
      const numericExpression = /^[\s\d.,%+*/=^_{}\\<>|()-]+$/.test(remainder)
        && /[+*/=^_{}\\<>|]/.test(remainder);
      if (numericExpression || /[=^_{}\\]/.test(remainder)) {
        protectedMath.add(index);
        protectedMath.add(next);
        d += 1;
        continue;
      }
    }

    escaped.add(index);
  }

  let normalized = "";
  for (let i = 0; i < text.length; i += 1) {
    if (text.startsWith("$$$", i) && text[i - 1] !== "$") {
      normalized += "\\$\\$\\$";
      i += 2;
    } else if (escaped.has(i)) {
      normalized += "\\$";
    } else {
      normalized += text[i];
    }
  }
  return normalized;
}

/** Normalize legacy LaTeX delimiters and unescaped currency outside code. */
export function normalizeMathDelimiters(text: string): string {
  return text
    .split(CODE_REGIONS)
    .map((segment, index) => {
      if (index % 2 === 1) return segment;
      const normalizedMath = segment
        .replace(/\\\[([\s\S]+?)\\\]/g, (_, inner: string) => `$$${inner}$$`)
        .replace(/\\\(([\s\S]+?)\\\)/g, (_, inner: string) => `$$${inner}$$`);
      return normalizeCurrencyDollars(normalizedMath);
    })
    .join("");
}
