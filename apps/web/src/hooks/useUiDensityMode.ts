import { useEffect, useState } from "react";

import type { UiDensityMode } from "../uiTypes";

const TABLET_MIN_WIDTH = 768;
const DESKTOP_MIN_WIDTH = 1024;

export function resolveUiDensityMode(width: number): UiDensityMode {
  if (width >= DESKTOP_MIN_WIDTH) {
    return "desktop";
  }
  if (width >= TABLET_MIN_WIDTH) {
    return "tablet";
  }
  return "mobile";
}

export function useUiDensityMode(): UiDensityMode {
  const [mode, setMode] = useState<UiDensityMode>(() => {
    if (typeof window === "undefined") {
      return "mobile";
    }
    return resolveUiDensityMode(window.innerWidth);
  });

  useEffect(() => {
    const onResize = (): void => {
      setMode(resolveUiDensityMode(window.innerWidth));
    };

    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return mode;
}
