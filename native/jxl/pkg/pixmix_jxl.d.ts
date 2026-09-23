/* tslint:disable */
/* eslint-disable */

export class Animation {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    takePixels(): Uint8Array;
    readonly channels: number;
    /**
     * Number of frames; `takePixels` holds them one after another.
     */
    readonly count: number;
    readonly durationsMs: Uint32Array;
    readonly height: number;
    /**
     * 0 = forever.
     */
    readonly loops: number;
    readonly width: number;
}

export class Decoded {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Moves the 16-bit pixels out (call once; empty unless decoded with `high`).
     */
    takePixels16(): Uint16Array;
    /**
     * Moves the 8-bit pixels out (call once; empty when decoded with `high`).
     */
    takePixels(): Uint8Array;
    /**
     * 1 grey, 2 grey + alpha, 3 RGB, 4 RGBA.
     */
    readonly channels: number;
    readonly height: number;
    /**
     * ICC profile of the returned pixels; empty when they are sRGB.
     */
    readonly icc: Uint8Array;
    readonly width: number;
}

/**
 * `high`: 16-bit samples instead of 8-bit (for images with more than 8 bits).
 */
export function decode(bytes: Uint8Array, srgb: boolean, high: boolean): Decoded;

/**
 * All keyframes (composited, orientation applied), like `decode` but for animations.
 */
export function decodeAnimation(bytes: Uint8Array, srgb: boolean): Animation;

export function lastPanic(): string;

/**
 * `None` when the file carries no JPEG reconstruction data.
 */
export function reconstructJpeg(bytes: Uint8Array): Uint8Array | undefined;

/**
 * Panics abort the WASM instance (a JS RuntimeError without a message); keep the message
 * so JS can report it.
 */
export function start(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_animation_free: (a: number, b: number) => void;
    readonly __wbg_decoded_free: (a: number, b: number) => void;
    readonly animation_channels: (a: number) => number;
    readonly animation_count: (a: number) => number;
    readonly animation_durationsMs: (a: number, b: number) => void;
    readonly animation_height: (a: number) => number;
    readonly animation_loops: (a: number) => number;
    readonly animation_takePixels: (a: number, b: number) => void;
    readonly animation_width: (a: number) => number;
    readonly decode: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly decodeAnimation: (a: number, b: number, c: number, d: number) => void;
    readonly decoded_channels: (a: number) => number;
    readonly decoded_height: (a: number) => number;
    readonly decoded_icc: (a: number, b: number) => void;
    readonly decoded_takePixels: (a: number, b: number) => void;
    readonly decoded_takePixels16: (a: number, b: number) => void;
    readonly decoded_width: (a: number) => number;
    readonly lastPanic: (a: number) => void;
    readonly reconstructJpeg: (a: number, b: number, c: number) => void;
    readonly start: () => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export2: (a: number, b: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
