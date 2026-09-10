import type { HazardLevel, HazardType } from "../domain/schemas";

const labels: Record<HazardType, string> = {
  "severe-weather": "Severe weather", flood: "Flooding", "extreme-heat": "Extreme heat", "extreme-cold": "Extreme cold",
  wildfire: "Wildfire", "fire-danger": "Very high fire danger", "air-quality": "Poor air quality", earthquake: "Earthquake",
  volcano: "Volcanic activity", drought: "Drought",
  "snow-ice": "Snow or ice", avalanche: "Avalanche danger", coastal: "Coastal hazard", "civil-unrest": "Civil unrest",
  security: "Security incident", terrorism: "Security incident", "armed-conflict": "Armed conflict", industrial: "Industrial emergency",
  nuclear: "Radiological emergency", "civil-emergency": "Major civil emergency",
};

const actions: Partial<Record<HazardType, string>> = {
  "severe-weather": "Avoid exposed outdoor areas and follow local authority advice.",
  flood: "Avoid flood water and low-lying affected areas. Follow local authority advice.",
  "extreme-heat": "Limit strenuous activity, stay hydrated, and follow local health advice.",
  "extreme-cold": "Limit exposure and follow local weather and emergency advice.",
  wildfire: "Avoid the affected area and follow evacuation or emergency instructions.",
  "fire-danger": "Avoid activities that could start a fire and check local access restrictions.",
  earthquake: "Expect possible aftershocks and follow local emergency instructions.",
  volcano: "Avoid restricted areas and follow local volcanic hazard advice.",
  drought: "Check local water restrictions and fire precautions.",
  "snow-ice": "Allow extra time outdoors and follow local weather advice.",
  avalanche: "Avoid exposed backcountry terrain and follow local avalanche advice.",
  coastal: "Stay away from exposed coasts and follow local authority advice.",
  industrial: "Avoid the affected area and follow local emergency instructions.",
  "civil-emergency": "Avoid the affected area and follow local authority instructions.",
};

export function eventCopy(type: HazardType, level: HazardLevel, area: string, upcoming: boolean) {
  const label = labels[type];
  const seriousness = level === "SEVERE" ? (type === "extreme-heat" || type === "extreme-cold" ? "Dangerous" : "Extreme") : level === "HIGH" ? "Serious" : "Potentially disruptive";
  return {
    headline: `${label} ${upcoming ? "may affect" : "is affecting"} ${area}.`,
    explanation: `${seriousness} ${label.toLowerCase()} conditions are ${upcoming ? "expected" : "reported"} for ${area}.`,
    action: actions[type] || "Avoid the affected area and follow official local advice.",
  };
}

export function weatherHazard(event: string): HazardType {
  const value = event.toLowerCase().replace(/[_–—-]+/g, " ").replace(/\s+/g, " ").trim();
  if (value.includes("flood")) return "flood";
  if (value.includes("heat") || value.includes("high temperature")) return "extreme-heat";
  if (value.includes("cold") || value.includes("low temperature")) return "extreme-cold";
  if (value.includes("forest") || value.includes("fire")) return "wildfire";
  if (value.includes("avalanche")) return "avalanche";
  if (value.includes("snow") || value.includes("ice")) return "snow-ice";
  if (value.includes("coast") || value.includes("wave") || value.includes("surge")) return "coastal";
  return "severe-weather";
}
