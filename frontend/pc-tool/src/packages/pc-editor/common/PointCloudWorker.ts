/// <reference lib="webworker" />
import PCDFile from '../../pc-render/loader/PCDFile';

type PointPayload = { id: number; buffer: ArrayBuffer };

self.onmessage = ({ data }: MessageEvent<PointPayload>) => {
    try {
        const source = PCDFile.parse(data.buffer).pointsDataMap;
        const x = source.x || [];
        const y = source.y || [];
        const z = source.z || [];
        const intensity = source.intensity?.length ? source.intensity : source.i || [];
        const rgb = source.rgb || [];
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
            normalizedIntensity[index] = value > 0 && value < 1 ? value * 255 : value;
            minIntensity = Math.min(minIntensity, normalizedIntensity[index]);
            maxIntensity = Math.max(maxIntensity, normalizedIntensity[index]);
            const groundKey = position[index * 3 + 2].toFixed(1);
            groundHistogram.set(groundKey, (groundHistogram.get(groundKey) || 0) + 1);
            const packed = rgb[index] || 0;
            color[index * 3] = (packed >> 16) & 255;
            color[index * 3 + 1] = (packed >> 8) & 255;
            color[index * 3 + 2] = packed & 255;
        }
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
                color: rgb.length ? color : new Uint8Array(),
                pointInfo: { ground, intensityRange: Number.isFinite(minIntensity) ? [minIntensity, maxIntensity] : undefined },
            },
            [position.buffer, normalizedIntensity.buffer, color.buffer],
        );
    } catch (error) {
        self.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) });
    }
};
