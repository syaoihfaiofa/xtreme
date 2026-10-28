export function canApplyPointCloudChunk(
    currentFrameId: string | undefined,
    requestFrameId: string,
    currentGeneration: number,
    requestGeneration: number,
    isAborted: boolean,
): boolean {
    return (
        !isAborted &&
        currentFrameId === requestFrameId &&
        currentGeneration === requestGeneration
    );
}
