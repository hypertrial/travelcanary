import { afterEach, describe, expect, it, vi } from "vitest";
import { destinationTime } from "@/lib/time";

afterEach(() => vi.useRealTimers());

describe("destination-local time", () => {
  it("can label deterministic demo times relative to the snapshot clock", () => {
    expect(destinationTime("2026-08-25T14:00:00Z", "Europe/Vienna", new Date("2026-08-25T12:00:00Z"))).toMatch(/^today at/);
  });

  it("labels tomorrow using the destination timezone across midnight", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-28T22:30:00Z"));
    expect(destinationTime("2026-03-28T23:30:00Z", "Europe/Amsterdam")).toMatch(/^tomorrow at 12:30 AM$/);
  });

  it("uses the post-transition local hour at daylight-saving start", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-29T00:00:00Z"));
    expect(destinationTime("2026-03-29T01:30:00Z", "Europe/Amsterdam")).toContain("3:30 AM");
  });
});
