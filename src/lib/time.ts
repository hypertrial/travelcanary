export function destinationTime(iso: string, timezone: string, now = new Date()) {
  const date = new Date(iso);
  const formatter = new Intl.DateTimeFormat("en", { timeZone: timezone, year: "numeric", month: "numeric", day: "numeric" });
  const parts = (value: Date) => Object.fromEntries(formatter.formatToParts(value).map((part) => [part.type, part.value]));
  const dateKey = (value: Date) => {
    const valueParts = parts(value);
    return `${valueParts.year}-${valueParts.month.padStart(2, "0")}-${valueParts.day.padStart(2, "0")}`;
  };
  const todayParts = parts(now);
  const tomorrowDate = new Date(Date.UTC(Number(todayParts.year), Number(todayParts.month) - 1, Number(todayParts.day) + 1));
  const tomorrow = `${tomorrowDate.getUTCFullYear()}-${String(tomorrowDate.getUTCMonth() + 1).padStart(2, "0")}-${String(tomorrowDate.getUTCDate()).padStart(2, "0")}`;
  const destinationDay = dateKey(date);
  const today = dateKey(now);
  const day = destinationDay === today ? "today" : destinationDay === tomorrow ? "tomorrow" : new Intl.DateTimeFormat("en", { timeZone: timezone, month: "short", day: "numeric" }).format(date);
  return `${day} at ${new Intl.DateTimeFormat("en", { timeZone: timezone, hour: "numeric", minute: "2-digit" }).format(date)}`;
}
