import Editor from '../Editor';
import Event from '../config/event';
import * as THREE from 'three';
import { StatusType } from 'pc-editor';

type IForward = 1 | -1;

interface IPlayOption {
    forward?: IForward;
    interval?: number;
}

export default class PlayManager extends THREE.EventDispatcher {
    editor: Editor;
    forward: IForward = 1;
    interval: number = 300;
    playing: boolean = false;
    timer: number = -1;
    test: number = 1;
    constructor(editor: Editor) {
        super();
        this.editor = editor;

        this.run = this.run.bind(this);
    }
    play(option: IPlayOption = {}) {
        // let { config } = this.editor.state;
        let { forward = 1, interval = this.interval } = option;

        this.dispatchEvent({ type: Event.PLAY_START });
        this.forward = forward;
        this.interval = interval;
        this.editor.dataResource.setPrefetchDirection(forward);

        if (this.playing) return;

        // this.editor.state.filterActive = [config.FILTER_ALL];
        this.playing = true;
        this.editor.state.status = StatusType.Play;
        this.editor.dataResource.onPlaybackStarted();
        this.editor.performanceMonitor.startFps(this.editor.getCurrentFrame()?.id || 'playback');

        if (this.timer > 0) {
            clearTimeout(this.timer);
        }

        this.timer = setTimeout(this.run, this.interval) as any;
    }
    stop() {
        if (!this.playing) return;

        this.playing = false;
        this.editor.state.status = StatusType.Default;
        this.editor.performanceMonitor.stopFps({ direction: this.forward });

        if (this.timer > 0) {
            clearTimeout(this.timer);
            this.timer = -1;
        }
        this.dispatchEvent({ type: Event.PLAY_STOP });
        this.editor.dataResource.onPlaybackStopped();
    }
    async next() {
        if (!this.playing) return;

        const { frames } = this.editor.state;
        const toIndex = this.editor.getAdjacentFrameIndex(this.forward);
        const data = frames[toIndex];
        // data.loadState === 'complete'
        if (toIndex >= 0 && data?.loadState === 'complete') {
            try {
                // console.log('toIndex:', toIndex);
                const loaded = await this.editor.loadFrame(toIndex, false);
                if (!loaded) this.stop();
                // this.dispatchEvent({ type: Event.PLAY_FRAME_CHANGE });
            } catch (error) {
                this.editor.handleErr(error as any, this.editor.lang('play-error'));
                this.stop();
            }
        } else {
            this.editor.performanceMonitor.record('playback-buffer-miss', data?.id || String(toIndex));
            this.stop();
        }
    }

    async run() {
        // console.log('run:');
        await this.next();

        if (this.playing) {
            this.timer = setTimeout(this.run, this.interval) as any;
        }
    }
}
