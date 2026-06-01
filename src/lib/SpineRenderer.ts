/**
 * SpineRenderer — TypeScript port of DesktopAnt SpineRenderer.js
 * Uses @esotericsoftware/spine-webgl for WebGL-based Spine 2D rendering.
 */
import {
  ManagedWebGLRenderingContext,
  AssetManager,
  SceneRenderer,
  TimeKeeper,
  AtlasAttachmentLoader,
  SkeletonBinary,
  Skeleton,
  AnimationState,
  AnimationStateData,
  Physics,
  Vector2,
  SkeletonJson,
} from "@esotericsoftware/spine-webgl";

// Polyfill: spine-webgl 4.2 may lack Physics enum
const SpinePhysics = Physics ?? { none: 0, reset: 1, update: 2, pose: 3 };

export interface SpineRendererOptions {
  /** Base URL path to spine assets (e.g. "/assets/spine/moshumao/") */
  assetPath: string;
  /** Skeleton file name (e.g. "moshumao.skel.bytes") */
  skelName: string;
  /** Atlas file name (e.g. "moshumao.atlas.txt") */
  atlasName: string;
  /** Default animation to play */
  defaultAnimation?: string;
}

export class SpineRenderer {
  private canvas: HTMLCanvasElement;
  private context: ManagedWebGLRenderingContext;
  private assetManager: AssetManager;
  private renderer: SceneRenderer;
  private timeKeeper: TimeKeeper;

  private skeleton: Skeleton | null = null;
  private animationState: AnimationState | null = null;
  private bounds = { offset: new Vector2(), size: new Vector2() };

  private isRendering = false;
  private isLoading = false;
  private lastFrameTime = 0;
  private renderErrorCount = 0;
  private disposed = false;

  private assetPath: string;
  private skelName: string;
  private atlasName: string;
  private defaultAnimation: string;

  constructor(canvas: HTMLCanvasElement, options: SpineRendererOptions) {
    this.canvas = canvas;
    this.assetPath = options.assetPath;
    this.skelName = options.skelName;
    this.atlasName = options.atlasName;
    this.defaultAnimation = options.defaultAnimation ?? "stand";

    this.context = new ManagedWebGLRenderingContext(canvas, {
      alpha: true,
      premultipliedAlpha: false,
    });

    this.assetManager = new AssetManager(this.context);
    this.renderer = new SceneRenderer(canvas, this.context);
    this.timeKeeper = new TimeKeeper();
    this.lastFrameTime = Date.now() / 1000;
  }

  async load(): Promise<boolean> {
    if (this.isLoading) return false;
    this.isLoading = true;

    const prefix = this.assetPath;

    // Load atlas
    this.assetManager.loadTextureAtlas(prefix + this.atlasName);

    // Load skeleton (binary or JSON based on extension)
    if (
      this.skelName.endsWith(".skel") ||
      this.skelName.endsWith(".bytes")
    ) {
      this.assetManager.loadBinary(prefix + this.skelName);
    } else {
      this.assetManager.loadJson(prefix + this.skelName);
    }

    // Wait for assets
    await this.waitForAssets();

    if (this.assetManager.hasErrors()) {
      const errors = this.assetManager.getErrors();
      console.error("[SpineRenderer] Asset load errors:", errors);
      this.isLoading = false;
      throw new Error("Failed to load Spine assets");
    }

    this.initializeSkeleton();
    this.isLoading = false;
    return true;
  }

  private waitForAssets(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.assetManager.isLoadingComplete()) {
          resolve();
        } else {
          requestAnimationFrame(check);
        }
      };
      check();
    });
  }

  private initializeSkeleton() {
    const prefix = this.assetPath;
    const atlas = this.assetManager.require(prefix + this.atlasName);
    const atlasLoader = new AtlasAttachmentLoader(atlas);

    let skeletonData;
    if (
      this.skelName.endsWith(".skel") ||
      this.skelName.endsWith(".bytes")
    ) {
      const skeletonBinary = new SkeletonBinary(atlasLoader);
      skeletonData = skeletonBinary.readSkeletonData(
        this.assetManager.require(prefix + this.skelName)
      );
    } else {
      const skeletonJson = new SkeletonJson(atlasLoader);
      skeletonData = skeletonJson.readSkeletonData(
        this.assetManager.require(prefix + this.skelName)
      );
    }

    this.skeleton = new Skeleton(skeletonData);
    this.skeleton.updateWorldTransform(SpinePhysics.update);
    this.skeleton.getBounds(this.bounds.offset, this.bounds.size, []);

    const animStateData = new AnimationStateData(this.skeleton.data);
    animStateData.defaultMix = 0.2;
    this.animationState = new AnimationState(animStateData);

    // Set default skin
    if (this.skeleton.data.defaultSkin) {
      this.skeleton.setSkin(this.skeleton.data.defaultSkin);
    }

    // Play default animation
    this.setAnimation(this.defaultAnimation, true);

    // Start render loop
    if (!this.isRendering) {
      this.isRendering = true;
      this.lastFrameTime = Date.now() / 1000;
      requestAnimationFrame(this.render.bind(this));
    }
  }

  setAnimation(name: string, loop = true) {
    if (!this.animationState || !this.skeleton) return;

    let animation = this.skeleton.data.findAnimation(name);
    if (!animation) {
      // Fallback: stand -> idle -> first available
      const names = this.getAnimationNames();
      const fallbacks = ["stand", "idle"];
      let fallbackName = names[0];
      for (const fb of fallbacks) {
        if (names.includes(fb)) {
          fallbackName = fb;
          break;
        }
      }
      if (fallbackName) {
        console.warn(
          `[SpineRenderer] Animation '${name}' not found, falling back to '${fallbackName}'`
        );
        animation = this.skeleton.data.findAnimation(fallbackName);
        name = fallbackName;
        loop = true;
      } else {
        return;
      }
    }

    this.animationState.setAnimation(0, name, loop);
  }

  getAnimationNames(): string[] {
    if (!this.skeleton) return [];
    return this.skeleton.data.animations.map((a) => a.name);
  }

  /**
   * Set the skeleton's facing direction.
   * @param direction 1 = right (default), -1 = left
   */
  setFacingDirection(direction: 1 | -1) {
    if (!this.skeleton) return;
    this.skeleton.scaleX = direction;
  }

  /**
   * Get current facing direction.
   */
  getFacingDirection(): 1 | -1 {
    if (!this.skeleton) return 1;
    return this.skeleton.scaleX >= 0 ? 1 : -1;
  }

  /**
   * Get the underlying skeleton (for advanced control).
   */
  getSkeleton(): Skeleton | null {
    return this.skeleton;
  }

  resize(width: number, height: number) {
    this.canvas.width = width;
    this.canvas.height = height;
  }

  dispose() {
    this.disposed = true;
    this.isRendering = false;
    this.isLoading = false;
    this.skeleton = null;
    this.animationState = null;
  }

  private render() {
    if (!this.isRendering || this.disposed) return;

    try {
      const now = Date.now() / 1000;
      const delta = now - this.lastFrameTime;
      this.lastFrameTime = now;

      this.timeKeeper.update();
      if (delta > 0.1) this.timeKeeper.delta = 0; // Cap large deltas (tab switch)

      // Clear with transparent background
      const gl = this.context.gl;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      if (this.skeleton && this.animationState) {
        // Reset to setup pose to avoid cumulative deformations
        if (typeof this.skeleton.setBonesToSetupPose === "function") {
          this.skeleton.setBonesToSetupPose();
        }

        this.animationState.update(delta);
        this.animationState.apply(this.skeleton);
        this.skeleton.updateWorldTransform(SpinePhysics.update);

        // Camera setup: fit skeleton bounds
        let bw = this.bounds.size.x || 250;
        let bh = this.bounds.size.y || 250;
        let ox = this.bounds.offset.x || 0;
        let oy = this.bounds.offset.y || 0;

        this.renderer.camera.viewportWidth = bw * 1.5;
        this.renderer.camera.viewportHeight = bh * 1.5;

        const scaleSign = Math.sign(this.skeleton.scaleX) || 1;
        this.renderer.camera.position.x = (ox + bw / 2) * scaleSign;
        this.renderer.camera.position.y =
          oy +
          this.renderer.camera.viewportHeight / 2 -
          this.renderer.camera.viewportHeight * 0.1;

        if (typeof this.renderer.camera.update === "function") {
          this.renderer.camera.update();
        }

        this.renderer.begin();
        this.renderer.drawSkeleton(this.skeleton, true);
        this.renderer.end();
      }

      this.renderErrorCount = 0;
    } catch (err: unknown) {
      this.renderErrorCount++;
      const message = err instanceof Error ? err.message : String(err);
      if (this.renderErrorCount <= 3) {
        console.warn("[SpineRenderer] Render error (frame skipped):", message);
      }
      if (this.renderErrorCount === 5 && this.skeleton && this.animationState) {
        try {
          this.setAnimation("stand", true);
        } catch (_) {}
      }
      if (this.renderErrorCount > 100) {
        this.isRendering = false;
        console.error("[SpineRenderer] Too many render errors, stopping.");
        return;
      }
    }

    requestAnimationFrame(this.render.bind(this));
  }
}
