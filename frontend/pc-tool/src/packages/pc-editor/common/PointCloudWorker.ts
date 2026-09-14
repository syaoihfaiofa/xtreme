/// <reference lib="webworker" />
import PCDFile from '../../pc-render/loader/PCDFile';

type PointPayload = {
    id: number;
    buffer: ArrayBuffer;
    calculateLocalLuminance?: boolean;
};

interface LuminanceCell {
    sum: number;
    count: number;
}

function toColorChannel(value: number | undefined) {
    const channel = Number(value) || 0;
    // Accommodate both common PCD conventions: uint8 [0, 255] and float [0, 1].
    return Math.max(0, Math.min(255, Math.round(channel > 0 && channel <= 1 ? channel * 255 : channel)));
}

function calculateLocalLuminance(position: Float32Array, color: Uint8Array): Float32Array {
    const cellSize = 0.25;
    const heightSize = 0.25;
    const pointCount = position.length / 3;
    const luminance = new Float32Array(pointCount);
    if (!pointCount || color.length < position.length) return luminance;

    // String keys were constructed twice for every point on every frame load.  For a
    // typical LiDAR frame that dominates the local-contrast preparation time.  Encode
    // grid cells relative to the frame's minimum cell instead, preserving exact cells
    // without allocating per-point strings.
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let index = 0; index < pointCount; index++) {
        const offset = index * 3;
        const x = Math.floor(position[offset] / cellSize);
        const y = Math.floor(position[offset + 1] / cellSize);
        const z = Math.floor(position[offset + 2] / heightSize);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        minZ = Math.min(minZ, z);
        maxY = Math.max(maxY, y);
        maxZ = Math.max(maxZ, z);
    }
    const yStride = maxY - minY + 1;
    const zStride = maxZ - minZ + 1;
    const getCellKey = (offset: number) => {
        const x = Math.floor(position[offset] / cellSize) - minX;
        const y = Math.floor(position[offset + 1] / cellSize) - minY;
        const z = Math.floor(position[offset + 2] / heightSize) - minZ;
        return (x * yStride + y) * zStride + z;
    };
    const cells = new Map<number, LuminanceCell>();
    for (let index = 0; index < pointCount; index++) {
        const offset = index * 3;
        const value = (
            color[offset] * 0.2126
            + color[offset + 1] * 0.7152
            + color[offset + 2] * 0.0722
        ) / 255;
        luminance[index] = value;
        const key = getCellKey(offset);
        const cell = cells.get(key);
        if (cell) {
            cell.sum += value;
            cell.count++;
        } else {
            cells.set(key, { sum: value, count: 1 });
        }
    }
    for (let index = 0; index < pointCount; index++) {
        const offset = index * 3;
        const key = getCellKey(offset);
        const cell = cells.get(key);
        luminance[index] = cell ? cell.sum / cell.count : luminance[index];
    }
    return luminance;
}

self.onmessage = ({ data }: MessageEvent<PointPayload>) => {
    try {
        const source = PCDFile.parse(data.buffer).pointsDataMap;
        const x = source.x || [];
        const y = source.y || [];
        const z = source.z || [];
        const intensity = source.intensity?.length ? source.intensity : source.i?.length ? source.i : source.int || [];
        const rgb = source.rgb || [];
        const hasSeparateRGB = source.r?.length === x.length && source.g?.length === x.length && source.b?.length === x.length;
        const position = new Float32Array(x.length * 3);
        const color = new Uint8Array(x.length * 3);
        const normalizedIntensity = new Float32Array(x.length);
        const groundHistogram = new Map<string, number>();
        let minIntensity = Infinity;
        let maxIntensity = -Infinity;
        for (let index = 0; index < x.length; index++) {
            position[index * 3] = x[index];
            position[index * 3 + 1] = y[index];
            position[index * 3 + 2] = z[index];
            const value = intensity[index] || 0;
            // Keep intensity normalization consistent with RGB channels.  In particular,
            // a float value of exactly 1.0 represents full-scale 255, not intensity 1.
            // Otherwise RGB=intensity sky points become (255,255,255,1) and evade filtering.
            normalizedIntensity[index] = value > 0 && value <= 1 ? value * 255 : value;
            minIntensity = Math.min(minIntensity, normalizedIntensity[index]);
            maxIntensity = Math.max(maxIntensity, normalizedIntensity[index]);
            const groundKey = position[index * 3 + 2].toFixed(1);
            groundHistogram.set(groundKey, (groundHistogram.get(groundKey) || 0) + 1);
            if (hasSeparateRGB) {
                color[index * 3] = toColorChannel(source.r[index]);
                color[index * 3 + 1] = toColorChannel(source.g[index]);
                color[index * 3 + 2] = toColorChannel(source.b[index]);
            } else {
                const packed = rgb[index] || 0;
                color[index * 3] = (packed >> 16) & 255;
                color[index * 3 + 1] = (packed >> 8) & 255;
                color[index * 3 + 2] = packed & 255;
            }
        }
        const hasRgb = rgb.length || hasSeparateRGB;
        const localLuminance =
            hasRgb && data.calculateLocalLuminance
                ? calculateLocalLuminance(position, color)
                : new Float32Array();
        let ground = 0;
        let groundCount = -1;
        groundHistogram.forEach((count, key) => {
            if (count > groundCount) {
                groundCount = count;
                ground = Number(key);
            }
        });
        self.postMessage(
            {
                id: data.id,
                position,
                intensity: normalizedIntensity,
                color: hasRgb ? color : new Uint8Array(),
                localLuminance,
                pointInfo: { ground, intensityRange: Number.isFinite(minIntensity) ? [minIntensity, maxIntensity] : undefined },
            },
            [position.buffer, normalizedIntensity.buffer, color.buffer, localLuminance.buffer],
        );
    } catch (error) {
        self.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) });
    }
};
