import { useEffect, useRef, useImperativeHandle, forwardRef, useState } from "react";
import { SpineRenderer } from "../lib/SpineRenderer";

interface SpinePetProps {
  /** Pet name — maps to folder under /assets/spine/{petName}/ */
  petName?: string;
  /** Canvas width */
  width?: number;
  /** Canvas height */
  height?: number;
  /** CSS class for the canvas */
  className?: string;
}

/** Exposed imperative handle for parent control */
export interface SpinePetHandle {
  setAnimation: (name: string, loop?: boolean) => void;
  setFacingDirection: (dir: 1 | -1) => void;
  getFacingDirection: () => 1 | -1;
  getAnimationNames: () => string[];
}

/**
 * SpinePet — React component that renders a Spine 2D skeleton animation.
 * Loads .skel.bytes + .atlas.txt + .png from /public/assets/spine/{petName}/.
 */
const SpinePet = forwardRef<SpinePetHandle, SpinePetProps>(function SpinePet(
  { petName = "moshumao", width = 260, height = 260, className },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<SpineRenderer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Expose imperative API to parent
  useImperativeHandle(ref, () => ({
    setAnimation: (name: string, loop = true) => {
      rendererRef.current?.setAnimation(name, loop);
    },
    setFacingDirection: (dir: 1 | -1) => {
      rendererRef.current?.setFacingDirection(dir);
    },
    getFacingDirection: () => {
      return rendererRef.current?.getFacingDirection() ?? 1;
    },
    getAnimationNames: () => {
      return rendererRef.current?.getAnimationNames() ?? [];
    },
  }));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Clean up previous renderer
    if (rendererRef.current) {
      rendererRef.current.dispose();
      rendererRef.current = null;
    }

    setLoading(true);
    setError(null);

    const renderer = new SpineRenderer(canvas, {
      assetPath: `/assets/spine/${petName}/`,
      skelName: `${petName}.skel.bytes`,
      atlasName: `${petName}.atlas.txt`,
      defaultAnimation: "stand",
    });

    renderer
      .load()
      .then(() => {
        rendererRef.current = renderer;
        setLoading(false);
        console.log(
          `[SpinePet] Loaded '${petName}', animations:`,
          renderer.getAnimationNames()
        );
      })
      .catch((err) => {
        console.error("[SpinePet] Load failed:", err);
        setError(err.message ?? "Load failed");
        setLoading(false);
      });

    return () => {
      renderer.dispose();
      rendererRef.current = null;
    };
  }, [petName]);

  // Handle resize
  useEffect(() => {
    if (rendererRef.current) {
      rendererRef.current.resize(width, height);
    }
  }, [width, height]);

  return (
    <div
      className={className}
      style={{
        width,
        height,
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        style={{
          width,
          height,
          background: "transparent",
        }}
      />
      {loading && (
        <div
          style={{
            position: "absolute",
            color: "rgba(255,255,255,0.5)",
            fontSize: 12,
          }}
        >
          Loading...
        </div>
      )}
      {error && (
        <div
          style={{
            position: "absolute",
            color: "#FF3B30",
            fontSize: 11,
            textAlign: "center",
            padding: "0 8px",
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
});

export default SpinePet;
