import { useInjectEditor } from '../../state';
import { IClass } from './type';
import { AnnotateObject } from 'pc-render';
import { Event as EditorEvent, IUserData } from 'pc-editor';
import * as _ from 'lodash';
import * as locale from './lang';

export function getObjectsForClass(
    item: Pick<IClass, 'classId' | 'classType'>,
    objects: AnnotateObject[],
): AnnotateObject[] {
    return objects.filter((object) => {
        const userData = object.userData as IUserData;
        return item.classId
            ? userData.classId === item.classId
            : userData.classType === item.classType;
    });
}

export default function useClassItem() {
    let editor = useInjectEditor();
    let pc = editor.pc;
    let $$ = editor.bindLocale(locale);

    function onDelete(item: IClass) {
        let { className } = item;
        className = className || '';

        editor
            .showConfirm({
                title: $$('msg-delete-title'),
                subTitle: $$('msg-class-delete', { n: item.data.length, name: className }),
                okText: $$('msg-delete-title'),
                cancelText: $$('msg-cancel-title'),
                okDanger: true,
            })
            .then(
                async () => {
                    await editor.loadManager.loadAllObjects();
                    const deleteData = editor.state.frames.flatMap((frame) => {
                        const objects = getObjectsForClass(
                            item,
                            editor.dataManager.getFrameObject(frame.id) || [],
                        );
                        return objects.length > 0 ? [{ objects, frame }] : [];
                    });

                    if (deleteData.length > 0) {
                        editor.cmdManager.execute('delete-object', deleteData);
                    }
                },
                () => {},
            );
    }

    function onEdit(item: IClass) {
        let { config } = editor.state;
        let ids = item.data.map((e) => e.id);
        editor.viewManager.showClassView(ids);
    }

    function onToggleVisible(item: IClass) {
        let visible = !item.visible;
        item.visible = visible;

        let idMap = {} as Record<string, boolean>;
        item.data.forEach((e) => {
            idMap[e.id] = true;
        });

        let object3D: AnnotateObject[] = [];
        let object2D: AnnotateObject[] = [];
        let annotate3D = pc.getAnnotate3D();
        let annotate2D = pc.getAnnotate2D();

        annotate3D.forEach((object) => {
            let userData = object.userData as Required<IUserData>;
            if (idMap[userData.trackId]) object3D.push(object);
        });

        annotate2D.forEach((object) => {
            let userData = object.userData as Required<IUserData>;
            if (idMap[userData.trackId]) object2D.push(object);
        });

        if (object3D.length > 0) {
            pc.setVisible(object3D, visible);
        }

        if (object2D.length > 0) {
            pc.setVisible(object2D, visible);
        }
    }
    function onHeaderClick(item: IClass) {
        if (editor.state.currentClass == item.classId) return;
        editor.pc.selectObject();
        if (item.isModel) {
            editor.state.currentClass = '';
        } else {
            editor.state.currentClass = item.classId;
        }
    }
    return {
        onEdit,
        onDelete,
        onToggleVisible,
        onHeaderClick,
    };
}
