import budgets from "../../../data/catalog-releases/3-conditions-budgets.json";

/** Fixed namespace allocations bound even an arbitrary mix of publication generations. */
export function catalog3ConditionsCountryLimit(country: string): number {
  if (!Object.hasOwn(budgets.countryBytes, country)) throw new Error(`Unknown conditions country: ${country}`);
  return budgets.countryBytes[country as keyof typeof budgets.countryBytes];
}
