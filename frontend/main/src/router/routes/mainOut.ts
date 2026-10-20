/**
The routing of this file will not show the layout.
It is an independent new page.
the contents of the file still need to log in to access
 */
import type { AppRouteModule } from '/@/router/types';

export const mainOutRoutes: AppRouteModule[] = [
  {
    path: '/auto-occlusion',
    name: 'AutoOcclusion',
    component: () => import('/@/views/autoOcclusion/index.vue'),
    meta: {
      title: '自动遮挡',
      hideMenu: true,
    },
  },
];

export const mainOutRouteNames = mainOutRoutes.map((item) => item.name);
