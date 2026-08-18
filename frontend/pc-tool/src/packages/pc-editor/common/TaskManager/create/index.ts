// @ts-ignore
// import CreateWorker from './worker?worker&url';
import Editor from '../../../Editor';
import { ITaskEnum, IMessage, IMsgHandler, ICallBack } from './type';
import * as THREE from 'three';

interface IQueuedJob {
  data: IMessage;
  transfer: Transferable[];
}

const MAX_PENDING_JOBS = 100;

let seedMsgID = 100;
function createMsgID(): string {
  seedMsgID += 1;
  return seedMsgID + '';
}

export default class CreateTask {
  editor: Editor;
  worker: Worker;
  handleMap: Map<string, IMsgHandler> = new Map();
  isInit: boolean = false;
  queue: IQueuedJob[] = [];
  working: boolean = false;
  private destroyed: boolean = false;
  private readonly messageHandler = ({ data }: MessageEvent<IMessage>): void => {
    const msgHandler = this.handleMap.get(data.msgId);
    if (msgHandler) {
      if (data.type === ITaskEnum.Error) {
        msgHandler.reject(data);
      } else {
        msgHandler.resolve(data);
      }
      this.handleMap.delete(data.msgId);
    }
    if (data.type !== ITaskEnum.Reset) this.isInit = true;
    this.working = false;
    this.run();
  };

  constructor(editor: Editor) {
    this.editor = editor;
    // this.worker = new CreateWorker() as Worker;
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.initWorkerEvent();
  }

  run(): void {
    if (this.destroyed || this.working) return;
    const job = this.queue.shift();
    if (!job) return;
    this.working = true;
    try {
      this.worker.postMessage(job.data, job.transfer);
    } catch (error) {
      this.handleMap.get(job.data.msgId)?.reject(error);
      this.handleMap.delete(job.data.msgId);
      this.working = false;
      this.run();
    }
  }

  postMessage(msg: ITaskEnum, data?: any, transfer: Transferable[] = []): Promise<IMessage> {
    const msgKey = createMsgID();
    const frameId = this.getCurFrameID();
    return new Promise<IMessage>((resolve, reject) => {
      if (this.destroyed) {
        reject(new Error('CreateTask has been destroyed'));
        return;
      }
      if (this.queue.length >= MAX_PENDING_JOBS) {
        reject(new Error(`CreateTask queue limit exceeded: ${MAX_PENDING_JOBS}`));
        return;
      }
      this.handleMap.set(msgKey, { resolve, reject });
      this.queue.push({
        data: { type: msg, data, frameId, msgId: msgKey },
        transfer,
      });
      this.run();
    });
  }

  initWorkerEvent(): void {
    this.worker.addEventListener('message', this.messageHandler);
  }

  getCurFrameID(): string {
    const frame = this.editor.getCurrentFrame();
    return frame ? String(frame.id) : '';
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.worker.removeEventListener('message', this.messageHandler);
    this.worker.terminate();
    const error = new Error('CreateTask was terminated before completion');
    this.handleMap.forEach(({ reject }) => reject(error));
    this.handleMap.clear();
    this.queue = [];
    this.working = false;
    this.isInit = false;
  }

  terminate(): void {
    this.destroy();
  }

  init(pc: THREE.Float32BufferAttribute): Promise<IMessage> | undefined {
    if (this.isInit) return;
    const float32Array = pc.array as Float32Array;
    const buffer = float32Array.buffer.slice(0);
    return this.postMessage(ITaskEnum.Init, { pc: buffer }, [buffer]);
  }

  reset(): Promise<IMessage> | undefined {
    if (!this.isInit) return;
    this.isInit = false;
    return this.postMessage(ITaskEnum.Reset, '');
  }

  getRoadZByPosition(
    coordinate: THREE.Vector3[],
    pc: THREE.Float32BufferAttribute,
  ): Promise<IMessage> {
    const float32Array = pc.array as Float32Array;
    const buffer = float32Array.buffer.slice(0);
    return this.postMessage(
      ITaskEnum.ROAD_Z,
      {
        pc: buffer,
        coordinate: coordinate,
      },
      [buffer],
    );
  }
  getRoadIndices(pc: THREE.Float32BufferAttribute): Promise<IMessage> {
    const float32Array = pc.array as Float32Array;
    const buffer = float32Array.buffer.slice(0);
    return this.postMessage(
      ITaskEnum.ROAD,

      {
        pc: buffer,
      },
      [buffer],
    );
  }
  create(
    pc: THREE.Float32BufferAttribute,
    projectPos: THREE.Vector2[],
    matrix: THREE.Matrix4,
    headAngle: number,
    deNoise = true,
    heightRange = [-Infinity, Infinity],
  ): Promise<IMessage> {
    const float32Array = pc.array as Float32Array;
    const buffer = float32Array.buffer.slice(0);
    return this.postMessage(
      ITaskEnum.Create,
      {
        pc: buffer,
        projectPos,
        heightRange: JSON.parse(JSON.stringify(heightRange)),
        matrix: matrix.toArray(),
        headAngle,
        deNoise,
      },
      [buffer],
    );
  }
}
