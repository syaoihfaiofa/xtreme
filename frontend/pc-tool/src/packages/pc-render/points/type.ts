import type { Points } from 'three';
import type { ForceGroundOperation, ForceGroundProtectedVolume } from './forceGround';

export interface IPoints extends Points {
    loading: boolean;
    updateData(
        data: any,
        operations: readonly ForceGroundOperation[],
        protectedVolumes: readonly ForceGroundProtectedVolume[],
    ): void;
    loadUrl(url: any): void;
}
