"use client";

import { useEffect, useState } from "react";
import styles from "./page.module.css";

const DESKTOP_CANVAS_WIDTH = 800;

export default function ResponsivePreview() {
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const updateScale = () => {
      setScale(Math.min(1, window.innerWidth / DESKTOP_CANVAS_WIDTH));
    };

    updateScale();
    window.addEventListener("resize", updateScale);
    return () => window.removeEventListener("resize", updateScale);
  }, []);

  return (
    <main
      className={styles.viewport}
      style={{ "--preview-scale": scale }}
    >
      <iframe
        className={styles.site}
        src="/legacy.html?v=profile-image-3"
        title="Ary's little corner"
      />
    </main>
  );
}
