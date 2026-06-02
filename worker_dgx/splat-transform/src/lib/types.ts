/**
 * Options for read/write operations (trimmed SOG-converter build).
 */
type Options = {
    /** Number of iterations for SOG SH compression (higher = better quality). Default: 10 */
    iterations: number;
};

/**
 * A function that creates a PlayCanvas GraphicsDevice on demand.
 *
 * Used for GPU-accelerated SOG SH compression. SOG export also works without a
 * device (CPU k-means fallback); the application is responsible for caching.
 *
 * @returns Promise resolving to a GraphicsDevice instance.
 */
type DeviceCreator = () => Promise<import('playcanvas').GraphicsDevice>;

export type { Options, DeviceCreator };
