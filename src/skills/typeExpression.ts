/**
 * Evaluate a skill-type expression the way the game and Path of Building do.
 *
 * Expressions are postfix: a type name pushes "does the skill have this type?",
 * AND / OR combine the top two values, NOT negates the top one. The expression
 * matches if any value left on the stack is true — so a plain list of types means
 * "has any of these". Mirrors calcLib.doesTypeExpressionMatch in PoB's CalcTools.lua.
 */
export function matchesTypeExpression(
  expression: readonly string[],
  skillTypes: ReadonlySet<string>,
  minionTypes?: ReadonlySet<string>,
): boolean {
  const stack: boolean[] = [];
  for (const token of expression) {
    if (token === "OR" || token === "AND") {
      const right = stack.pop() ?? false;
      const left = stack.pop() ?? false;
      stack.push(token === "OR" ? left || right : left && right);
    } else if (token === "NOT") {
      stack.push(!(stack.pop() ?? false));
    } else {
      stack.push(skillTypes.has(token) || (minionTypes?.has(token) ?? false));
    }
  }
  return stack.some(Boolean);
}
