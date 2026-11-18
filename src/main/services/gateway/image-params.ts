import { ProviderError } from "./errors";

const QUALITY_VALUES = ["low", "medium", "high", "xhigh", "max"];
const DEFAULT_SHORT_SIDE = 1024;
const SIZE_STEP = 16;
const MIN_PIXELS = 655360;
const MAX_PIXELS = 8294400;
const MAX_EDGE = 3840;
const MAX_RATIO = 3;
const GEMINI_SUPPORTED_RATIOS = ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"];

export const IMAGE_SIZE_PRESETS: Record<string, Record<string, string>> = {
    "1k": { "1:1": "1024x1024", "2:3": "1024x1536", "3:2": "1536x1024", "4:3": "1024x768", "3:4": "768x1024", "16:9": "1536x864", "9:16": "864x1536", "21:9": "2016x864", "9:21": "864x2016" },
    "2k": { "1:1": "2048x2048", "2:3": "1360x2048", "3:2": "2048x1360", "4:3": "2048x1536", "3:4": "1536x2048", "16:9": "2048x1152", "9:16": "1152x2048", "21:9": "2688x1152", "9:21": "1152x2688" },
    "4k": { "1:1": "2880x2880", "2:3": "2336x3520", "3:2": "3520x2336", "4:3": "3312x2480", "3:4": "2480x3312", "16:9": "3840x2160", "9:16": "2160x3840", "21:9": "3840x1648", "9:21": "1648x3840" },
};

export function normalizeQuality(quality: string | undefined) {
    const value = quality?.trim().toLowerCase();
    return value && QUALITY_VALUES.includes(value) ? value : undefined;
}

export function normalizeBackground(background: string | undefined) {
    return background?.trim().toLowerCase() === "transparent" ? "transparent" : undefined;
}

function parseRatioValue(value: string) {
    const parts = value.split(":");
    if (parts.length !== 2) throw new ProviderError("invalid_request", `Unsupported image size format: ${value}`, { retryable: false });
    const width = Number(parts[0]);
    const height = Number(parts[1]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new ProviderError("invalid_request", "Image ratio must contain positive numbers", { retryable: false });
    }
    return { width, height };
}

function parseImageRatio(value: string) {
    const ratio = parseRatioValue(value);
    if (Math.max(ratio.width, ratio.height) / Math.min(ratio.width, ratio.height) > MAX_RATIO) {
        throw new ProviderError("invalid_request", "Image aspect ratio cannot exceed 3:1", { retryable: false });
    }
    return ratio;
}

function parseImageDimensions(value: string) {
    const match = value.match(/^(\d+)x(\d+)$/i);
    if (!match) return null;
    return { width: Number(match[1]), height: Number(match[2]) };
}

function validateImageSize(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        throw new ProviderError("invalid_request", "Image dimensions must be positive integers", { retryable: false });
    }
    if (width % SIZE_STEP !== 0 || height % SIZE_STEP !== 0) {
        throw new ProviderError("invalid_request", "Image dimensions must be multiples of 16", { retryable: false });
    }
    if (Math.max(width, height) > MAX_EDGE) {
        throw new ProviderError("invalid_request", `Image edge cannot exceed ${MAX_EDGE}px`, { retryable: false });
    }
    if (Math.max(width, height) / Math.min(width, height) > MAX_RATIO) {
        throw new ProviderError("invalid_request", "Image aspect ratio cannot exceed 3:1", { retryable: false });
    }
    const pixels = width * height;
    if (pixels < MIN_PIXELS || pixels > MAX_PIXELS) {
        throw new ProviderError("invalid_request", "Image pixel count is outside the supported range", { retryable: false });
    }
}

function resolveRatioSize(ratio: string) {
    const parsed = parseImageRatio(ratio);
    const preset = IMAGE_SIZE_PRESETS["1k"][ratio];
    if (preset) return preset;
    const landscape = parsed.width >= parsed.height;
    const longRatio = landscape ? parsed.width / parsed.height : parsed.height / parsed.width;
    const longSide = Math.round((DEFAULT_SHORT_SIDE * longRatio) / SIZE_STEP) * SIZE_STEP;
    const width = landscape ? longSide : DEFAULT_SHORT_SIDE;
    const height = landscape ? DEFAULT_SHORT_SIDE : longSide;
    validateImageSize(width, height);
    return `${width}x${height}`;
}

export function resolveRequestSize(size: string | undefined) {
    const value = (size || "").trim();
    if (!value || value.toLowerCase() === "auto") return undefined;
    const dimensions = parseImageDimensions(value);
    if (dimensions) {
        validateImageSize(dimensions.width, dimensions.height);
        return `${dimensions.width}x${dimensions.height}`;
    }
    if (value.includes(":")) return resolveRatioSize(value);
    throw new ProviderError("invalid_request", `Unsupported image size format: ${value}`, { retryable: false });
}

export function closestGeminiAspectRatio(value: string) {
    const ratio = parseImageRatio(value);
    const target = ratio.width / ratio.height;
    return GEMINI_SUPPORTED_RATIOS.reduce((best, item) => {
        const current = parseRatioValue(item);
        const bestRatio = parseRatioValue(best);
        return Math.abs(current.width / current.height - target) < Math.abs(bestRatio.width / bestRatio.height - target) ? item : best;
    });
}

function resolveGeminiImageSize(dimensions: { width: number; height: number } | null) {
    if (!dimensions) return undefined;
    const size = `${dimensions.width}x${dimensions.height}`;
    const scale = Object.keys(IMAGE_SIZE_PRESETS).find((key) => Object.values(IMAGE_SIZE_PRESETS[key]).includes(size));
    if (scale) return scale.toUpperCase();
    const edge = Math.max(dimensions.width, dimensions.height);
    if (edge <= 768) return "512";
    if (edge <= 1536) return "1K";
    if (edge <= 3072) return "2K";
    return "4K";
}

export function resolveGeminiImageConfig(size: string | undefined) {
    const value = (size || "").trim();
    const dimensions = parseImageDimensions(value);
    const ratio = dimensions ? `${dimensions.width}:${dimensions.height}` : value;
    const aspectRatio = value && value.toLowerCase() !== "auto" ? closestGeminiAspectRatio(ratio) : undefined;
    const imageSize = resolveGeminiImageSize(dimensions);
    const image = { ...(aspectRatio ? { aspectRatio } : {}), ...(imageSize ? { imageSize } : {}) };
    return Object.keys(image).length ? { imageConfig: image } : {};
}

export function inferMediaScale(size: string | undefined) {
    const value = (size || "").trim();
    if (!value || value === "auto" || value.includes(":")) return "auto";
    const pixels = parseImageDimensions(value);
    if (!pixels) return "auto";
    const presetScale = Object.keys(IMAGE_SIZE_PRESETS).find((scale) => Object.values(IMAGE_SIZE_PRESETS[scale]).includes(`${pixels.width}x${pixels.height}`));
    if (presetScale) return presetScale;
    const longSide = Math.max(pixels.width, pixels.height);
    if (longSide >= 3072) return "4k";
    if (longSide >= 1536) return "2k";
    return "1k";
}
