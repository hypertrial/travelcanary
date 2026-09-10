export function contextFeedsEnabled(value = process.env.CONTEXT_FEEDS_ENABLED) {
  return value?.trim().toLowerCase() === "true";
}
