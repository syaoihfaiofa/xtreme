export type FullLoadPolicyInput = {
    isCurrentFrame: boolean;
    isPlaying: boolean;
    resourceState?: 'preview-ready' | 'full-loading' | 'full-ready' | 'cancelled';
    hasPreview: boolean;
};

/** Full resolution is intentionally reserved for an idle, active frame. */
export function shouldScheduleFullLoad(input: FullLoadPolicyInput): boolean {
    return input.isCurrentFrame &&
        !input.isPlaying &&
        input.hasPreview &&
        input.resourceState === 'preview-ready';
}
