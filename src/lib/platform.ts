import { invoke } from "@tauri-apps/api/core";

function setPlatform(platform: string) {
  document.documentElement.dataset.platform = platform;
  if (document.body) document.body.dataset.platform = platform;
}

export function applyPlatformClass() {
  setPlatform("web");
  invoke<string>("get_platform")
    .then((platform) => setPlatform(platform))
    .catch(() => {
      const ua = navigator.userAgent.toLowerCase();
      if (ua.includes("windows")) setPlatform("windows");
      else if (ua.includes("mac")) setPlatform("macos");
      else if (ua.includes("linux")) setPlatform("linux");
    });
}
