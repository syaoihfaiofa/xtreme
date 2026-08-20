import { useInjectEditor } from '../../state';
import { IItem } from './type';
import * as locale from './lang';

export default function useTrackItem() {
    let editor = useInjectEditor();
    let pc = editor.pc;
    let $$ = editor.bindLocale(locale);

    function onEdit(item: IItem) {
        editor.viewManager.showClassView(item.id);
        // editor.state.config.showClassView = true;
        // editor.dispatchEvent({ type: EditorEvent.SHOW_CLASS_INFO, data: { id: item.id } });
    }

    function onSelect(item: IItem) {
        let annotate3D = pc.getAnnotate3D();
        let annotate2D = pc.getAnnotate2D();

        let objects = [...annotate3D, ...annotate2D].filter((e) => e.userData.trackId === item.id);
        editor.pc.selectObject(objects);
    }

    function onDelete(item: IItem) {
        let { name } = item;

        editor
            .showConfirm({
                title: $$('msg-delete-title'),
                subTitle: $$('msg-track-delete', { n: item.data.length, name }),
                okText: $$('msg-delete-title'),
                cancelText: $$('msg-cancel-title'),
                okDanger: true,
            })
            .then(
                async () => {
                    try {
                        await editor.deleteTrackAcrossScene(item.id);
                    } catch (error) {
                        editor.showMsg('error', $$('errorDelete'));
                    }
                },
                () => {},
            );
    }

    function onToggleVisible(item: IItem) {
        let visible = !item.visible;
        item.visible = visible;

        let idMap = {} as Record<string, boolean>;
        item.data.forEach((e) => {
            idMap[e.id] = true;
        });

        let annotate3D = pc.getAnnotate3D();
        let annotate2D = pc.getAnnotate2D();
        let objects = [...annotate3D, ...annotate2D].filter((object) => idMap[object.uuid]);

        if (objects.length > 0) {
            editor.cmdManager.execute('toggle-visible', { objects, visible: visible });
        }
    }

    return {
        onEdit,
        onSelect,
        onDelete,
        onToggleVisible,
    };
}
