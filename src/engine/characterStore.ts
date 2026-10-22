// Imported characters, kept on the player's machine so later steps can refer to them by a short
// id instead of passing the whole Path of Building code around.

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultCacheDir } from "../data/cache.js";

export interface StoredCharacter {
  id: string;
  label: string;
  savedAt: string;
}

function storeDir(): string {
  return process.env.POE2BF_CHARACTERS_DIR ?? join(dirname(defaultCacheDir()), "characters");
}

/** Save a character's build XML; the id is stable for the same build. */
export async function saveCharacter(xml: string, label: string): Promise<StoredCharacter> {
  const id = createHash("sha1").update(xml).digest("hex").slice(0, 8);
  const dir = storeDir();
  await mkdir(dir, { recursive: true });
  const meta: StoredCharacter = { id, label, savedAt: new Date().toISOString() };
  await writeFile(join(dir, `${id}.xml`), xml);
  await writeFile(join(dir, `${id}.json`), JSON.stringify(meta));
  return meta;
}

export async function characterXml(id: string): Promise<string> {
  if (!/^[0-9a-f]{8}$/.test(id)) throw new Error(`"${id}" isn't a character id; import the character first (import_character).`);
  try {
    return await readFile(join(storeDir(), `${id}.xml`), "utf8");
  } catch {
    throw new Error(`No imported character ${id}. Import it again with import_character.`);
  }
}

export async function listCharacters(): Promise<StoredCharacter[]> {
  const dir = storeDir();
  const files = await readdir(dir).catch(() => [] as string[]);
  const metas = await Promise.all(
    files.filter((f) => f.endsWith(".json")).map((f) => readFile(join(dir, f), "utf8").then((t) => JSON.parse(t) as StoredCharacter).catch(() => undefined)),
  );
  return metas.filter((m): m is StoredCharacter => !!m).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}
