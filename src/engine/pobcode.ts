// Path of Building build codes: the build XML, zlib-compressed and base64-encoded with "-" and "_"
// in place of "+" and "/" (what PoB's "Import/Export Build" shows and accepts).

import { deflateSync, inflateRawSync, inflateSync } from "node:zlib";

export function encodePobCode(xml: string): string {
  return deflateSync(Buffer.from(xml, "utf8"), { level: 9 }).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

/** The build XML inside a PoB code. Accepts codes with whitespace or line breaks pasted in. */
export function decodePobCode(code: string): string {
  const cleaned = code.trim().replace(/\s+/g, "");
  if (/^https?:\/\//i.test(cleaned)) {
    throw new Error("That's a link, not a code. In Path of Building use Import/Export Build → Generate, then copy the code (or open the link and copy its code).");
  }
  if (cleaned.startsWith("<")) return cleaned; // already XML
  const bytes = Buffer.from(cleaned.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  let xml: string;
  try {
    xml = inflateSync(bytes).toString("utf8");
  } catch {
    try {
      xml = inflateRawSync(bytes).toString("utf8");
    } catch {
      throw new Error("That doesn't look like a Path of Building code. Copy the whole code from PoB's Import/Export Build tab.");
    }
  }
  if (!xml.includes("<PathOfBuilding")) throw new Error("That code isn't a Path of Building build.");
  if (!xml.includes("<PathOfBuilding2")) {
    throw new Error("That's a Path of Exile 1 build code. This tool needs a code from Path of Building for PoE2.");
  }
  return xml;
}
