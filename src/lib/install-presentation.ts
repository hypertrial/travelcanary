export const INSTALL_HINT_STORAGE_KEY = "travelcanary-install-hint-dismissed-v1";

export type InstallPlatform = "ios" | "android" | "other";

export function installPlatform(userAgent: string): InstallPlatform {
  if (/iPad|iPhone|iPod/i.test(userAgent)) return "ios";
  if (/Android/i.test(userAgent)) return "android";
  return "other";
}

export function isStandaloneDisplay(matchMedia: (query: string) => { matches: boolean }, navigatorStandalone?: boolean): boolean {
  return Boolean(navigatorStandalone) || matchMedia("(display-mode: standalone)").matches;
}

export function installInstructions(platform: InstallPlatform): string {
  if (platform === "ios") return "In Safari, tap Share, choose Add to Home Screen, then tap Add.";
  if (platform === "android") return "Open your browser menu and choose Install app or Add to Home screen.";
  return "Use your browser's Install app or Add to Home Screen command when available.";
}
