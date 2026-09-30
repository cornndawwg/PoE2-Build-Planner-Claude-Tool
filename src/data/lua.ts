/**
 * Parser for the generated Lua data files Path of Building ships (Gems.lua, Essence.lua, …).
 * Handles the literal subset those files use: `return { … }` with nested tables,
 * `["key"] = value`, `name = value`, positional values, strings, numbers, booleans and nil.
 * It does not execute Lua.
 */

export type LuaValue = string | number | boolean | null | LuaValue[] | { [key: string]: LuaValue };

type Token =
  | { kind: "punct"; value: "{" | "}" | "[" | "]" | "=" | "," | ";" }
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "name"; value: string };

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "'": "'", "\\": "\\", "\n": "\n" };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (src.startsWith("--", i)) {
      const long = /^--\[(=*)\[/.exec(src.slice(i, i + 20));
      if (long) {
        const end = src.indexOf(`]${long[1]}]`, i);
        i = end === -1 ? src.length : end + long[1]!.length + 2;
      } else {
        const end = src.indexOf("\n", i);
        i = end === -1 ? src.length : end + 1;
      }
    } else if ("{}[]=,;".includes(c)) {
      // "[[" / "[==[" starts a long string, not an index.
      const long = c === "[" ? /^\[(=*)\[/.exec(src.slice(i, i + 20)) : null;
      if (long) {
        const open = long[0].length;
        const end = src.indexOf(`]${long[1]}]`, i + open);
        if (end === -1) throw new Error("Unterminated long string");
        tokens.push({ kind: "string", value: src.slice(i + open, end).replace(/^\n/, "") });
        i = end + long[1]!.length + 2;
      } else {
        tokens.push({ kind: "punct", value: c as "{" });
        i++;
      }
    } else if (c === '"' || c === "'") {
      let value = "";
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") {
          const next = src[i + 1] ?? "";
          if (/\d/.test(next)) {
            const digits = /^\d{1,3}/.exec(src.slice(i + 1))![0];
            value += String.fromCharCode(Number(digits));
            i += 1 + digits.length;
            continue;
          }
          value += ESCAPES[next] ?? next;
          i += 2;
        } else {
          value += src[i];
          i++;
        }
      }
      if (i >= src.length) throw new Error("Unterminated string");
      i++;
      tokens.push({ kind: "string", value });
    } else if (/[\d.-]/.test(c)) {
      const m = /^-?(0x[\da-fA-F]+|\d*\.?\d+(?:[eE][+-]?\d+)?)/.exec(src.slice(i));
      if (!m) throw new Error(`Unexpected '${c}' at ${i}`);
      tokens.push({ kind: "number", value: Number(m[0]) });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_]\w*/.exec(src.slice(i))!;
      tokens.push({ kind: "name", value: m[0] });
      i += m[0].length;
    } else {
      throw new Error(`Unexpected '${c}' at ${i}`);
    }
  }
  return tokens;
}

export function parseLuaData(src: string): LuaValue {
  const tokens = tokenize(src.replace(/^\uFEFF/, "")); // some PoB files start with a byte-order mark
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => {
    const t = tokens[pos++];
    if (!t) throw new Error("Unexpected end of input");
    return t;
  };
  const expect = (value: string) => {
    const t = next();
    if (t.kind !== "punct" || t.value !== value) throw new Error(`Expected '${value}'`);
  };

  function value(): LuaValue {
    const t = next();
    if (t.kind === "string" || t.kind === "number") return t.value;
    if (t.kind === "name") {
      if (t.value === "true") return true;
      if (t.value === "false") return false;
      if (t.value === "nil") return null;
      throw new Error(`Unsupported expression '${t.value}'`);
    }
    if (t.value === "{") return table();
    throw new Error(`Unexpected '${t.value}'`);
  }

  function table(): LuaValue {
    const keyed: Record<string, LuaValue> = {};
    const positional: LuaValue[] = [];
    let hasKeys = false;
    for (;;) {
      const t = peek();
      if (!t) throw new Error("Unterminated table");
      if (t.kind === "punct" && t.value === "}") {
        pos++;
        break;
      }
      if (t.kind === "punct" && t.value === "[") {
        pos++;
        const key = value();
        expect("]");
        expect("=");
        keyed[String(key)] = value();
        hasKeys = true;
      } else if (t.kind === "name" && tokens[pos + 1]?.kind === "punct" && (tokens[pos + 1] as { value: string }).value === "=") {
        pos += 2;
        keyed[t.value] = value();
        hasKeys = true;
      } else {
        positional.push(value());
      }
      const sep = peek();
      if (sep?.kind === "punct" && (sep.value === "," || sep.value === ";")) pos++;
    }
    if (!hasKeys) return positional;
    positional.forEach((v, index) => (keyed[String(index + 1)] = v));
    return keyed;
  }

  const first = next();
  if (first.kind !== "name" || first.value !== "return") throw new Error("Expected 'return'");
  const result = value();
  if (pos !== tokens.length) throw new Error("Unexpected trailing input");
  return result;
}
