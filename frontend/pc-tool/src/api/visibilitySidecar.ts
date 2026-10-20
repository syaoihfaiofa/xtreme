const VISIBILITY_SIDECAR_FIELDS = new Set([
    'autoVisibleRatio',
    'autoVisibleRatioByView',
    'autoOccluded',
    'autoSegmentVisibilityByView',
    'autoSegmentMeta',
]);

export function stripAutoVisibilitySidecarFields<T extends Record<string, unknown>>(
    attributes: T,
): T {
    return Object.keys(attributes).reduce((result, key) => {
        if (!VISIBILITY_SIDECAR_FIELDS.has(key)) {
            result[key as keyof T] = attributes[key];
        }
        return result;
    }, {} as T);
}
