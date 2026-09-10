import { describe, expect, it } from "vitest";
import { navigationUrl, parseAppNavigation } from "@/lib/app-navigation";

describe("shareable app navigation", () => {
  const destinations = new Set(["at-vienna", "pt-horta"]);

  it("parses valid destination, tab, and filter values", () => {
    expect(parseAppNavigation("?destination=pt-horta&view=alerts&filter=high", destinations)).toEqual({
      destinationId: "pt-horta",
      view: "alerts",
      filter: "high",
    });
  });

  it("fails closed to defaults for unknown or invalid values", () => {
    expect(parseAppNavigation("?destination=missing&view=globe&filter=quiet", destinations)).toEqual({
      destinationId: null,
      view: "map",
      filter: "all",
    });
  });

  it("omits defaults while preserving unrelated query parameters", () => {
    expect(navigationUrl("/", "?campaign=field-guide&destination=at-vienna&view=alerts", {
      destinationId: null,
      view: "map",
      filter: "all",
    })).toBe("/?campaign=field-guide");
    expect(navigationUrl("/", "", { destinationId: "at-vienna", view: "alerts", filter: "unavailable" }))
      .toBe("/?destination=at-vienna&view=alerts&filter=unavailable");
  });
});
