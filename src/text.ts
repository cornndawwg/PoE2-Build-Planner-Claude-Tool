/**
 * Strip GGG's inline markup from game text.
 * "[Ignite|Ignites]" -> "Ignites", "[Fire]" -> "Fire".
 */
export function stripMarkup(text: string): string {
  return text.replace(/\[([^\]|]*)\|([^\]]*)\]/g, "$2").replace(/\[([^\]]*)\]/g, "$1");
}
