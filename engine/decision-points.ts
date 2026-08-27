export function decisionPoints(functions: { cyclomaticComplexity: number }[]): number {
  const total = functions.reduce((sum, fn) => sum + fn.cyclomaticComplexity, 0);
  return total - functions.length;
}
