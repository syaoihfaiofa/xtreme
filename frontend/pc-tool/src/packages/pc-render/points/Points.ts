import * as THREE from 'three';
import { PCDLoader } from '../loader';
import PointsMaterial from '../material/PointsMaterial';
import { Event } from '../config';
import { IPoints } from './type';

interface IData {
    position?: number[];
    intensity?: number[];
    color?: number[];
}

enum Status {
    loading = 'loading',
    completed = 'completed',
    failed = 'failed',
}

function createGeometry(data: IData = { position: [], color: [], intensity: [] }) {
    let geometry = new THREE.BufferGeometry();

    let positionAttr = new THREE.Float32BufferAttribute(data.position || [], 3);
    // positionAttr.usage = THREE.DynamicDrawUsage;

    let intensityAttr = new THREE.Float32BufferAttribute(data.intensity || [], 1);
    // intensityAttr.usage = THREE.DynamicDrawUsage;

    let colorAttr = new THREE.Uint8BufferAttribute(data.color || [], 3);
    // colorAttr.usage = THREE.DynamicDrawUsage;

    geometry.setAttribute('position', positionAttr);
    geometry.setAttribute('intensity', intensityAttr);
    geometry.setAttribute('color', colorAttr);
    return geometry;
}

export default class Points extends THREE.Points implements IPoints {
    completed: boolean = false;
    loading: boolean = false;
    timeStamp: number = 0;
    loader: PCDLoader = new PCDLoader();
    constructor(material: PointsMaterial) {
        let geometry = createGeometry();
        super(geometry, material);
    }

    clear() {
        return this;
    }

    setBufferAttribute(attr: THREE.Float32BufferAttribute, data: number[] | Float32Array = []) {
        if (!(data instanceof Float32Array)) data = new Float32Array(data);
        attr.array = data;
        attr.count = data.length / attr.itemSize;
        attr.needsUpdate = true;
    }

    updateData(data: IData) {
        let geometry = this.geometry as THREE.BufferGeometry;
        const position = data.position || [];
        const oldPosition = geometry.getAttribute('position') as THREE.BufferAttribute;

        // Preview -> full resolution and adjacent-frame switching should not continuously create
        // GPU buffers. Grow only when necessary; otherwise reuse the existing capacity.
        if (!oldPosition || oldPosition.array.length < position.length) {
            geometry.dispose();
            this.geometry = createGeometry(data);
            geometry = this.geometry as THREE.BufferGeometry;
        } else {
            const update = (name: string, source: number[] | undefined, ArrayType: any) => {
                const values = source || [];
                let attr = geometry.getAttribute(name) as THREE.BufferAttribute;
                const itemSize = name === 'intensity' ? 1 : 3;
                if (!attr || attr.array.length < values.length) {
                    attr = new THREE.BufferAttribute(new ArrayType(oldPosition.array.length), itemSize);
                    geometry.setAttribute(name, attr);
                }
                (attr.array as any).set(values as any);
                attr.count = values.length / itemSize;
                attr.needsUpdate = true;
            };
            update('position', position, Float32Array);
            update('intensity', data.intensity, Float32Array);
            update('color', data.color, Uint8Array);
            geometry.setDrawRange(0, position.length / 3);
        }

        this.geometry.computeBoundingSphere();
        this.dispatchEvent({ type: Event.POINTS_CHANGE });
    }

    loadUrl(url: string, onProgress?: (percent: number) => void): Promise<any> {
        this.loading = true;
        let timeStamp = new Date().getTime();
        this.timeStamp = timeStamp;

        return new Promise((resolve, reject) => {
            this.loader.load(
                url,
                (data: any) => {
                    if (timeStamp !== this.timeStamp) {
                        reject();
                        return;
                    }

                    // this.dispatchEvent({ type: Event.LOAD_POINT_BEFORE });

                    this.updateData(data);
                    this.loading = false;
                    resolve(this);
                    // this.dispatchEvent({ type: Event.LOAD_POINT_AFTER });
                },
                (e) => {
                    if (onProgress) onProgress(e.loaded / e.total);
                },
                () => {
                    reject();
                },
            );
        });
    }
}
