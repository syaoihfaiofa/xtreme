# modify from https://github.com/mit-han-lab/bevfusion
from typing import Any, Mapping, Optional, Sequence, Tuple

import torch
from torch import nn

from mmdet3d.registry import MODELS
from .camera_geometry import (project_camera_points,
                              unproject_image_points)
from .ops import bev_pool


def gen_dx_bx(xbound, ybound, zbound):
    dx = torch.Tensor([row[2] for row in [xbound, ybound, zbound]])
    bx = torch.Tensor(
        [row[0] + row[2] / 2.0 for row in [xbound, ybound, zbound]])
    nx = torch.LongTensor([(row[1] - row[0]) / row[2]
                           for row in [xbound, ybound, zbound]])
    return dx, bx, nx


class BaseViewTransform(nn.Module):

    def __init__(
        self,
        in_channels: int,
        out_channels: int,
        image_size: Tuple[int, int],
        feature_size: Tuple[int, int],
        xbound: Tuple[float, float, float],
        ybound: Tuple[float, float, float],
        zbound: Tuple[float, float, float],
        dbound: Tuple[float, float, float],
        camera_calibrations: Optional[Sequence[Mapping[str, Any]]] = None,
    ) -> None:
        super().__init__()
        self.in_channels = in_channels
        self.image_size = image_size
        self.feature_size = feature_size
        self.xbound = xbound
        self.ybound = ybound
        self.zbound = zbound
        self.dbound = dbound

        dx, bx, nx = gen_dx_bx(self.xbound, self.ybound, self.zbound)
        self.dx = nn.Parameter(dx, requires_grad=False)
        self.bx = nn.Parameter(bx, requires_grad=False)
        self.nx = nn.Parameter(nx, requires_grad=False)

        self.C = out_channels
        self.frustum = self.create_frustum()
        self.D = self.frustum.shape[0]
        self.fp16_enabled = False
        self._set_camera_calibrations(camera_calibrations)

    def _set_camera_calibrations(
            self, camera_calibrations: Optional[Sequence[Mapping[str,
                                                                  Any]]]
    ) -> None:
        if camera_calibrations is None:
            self.register_buffer('configured_intrinsics', None)
            self.register_buffer('configured_distortion', None)
            self.register_buffer('configured_fisheye_mask', None)
            self.register_buffer('configured_axis_signs', None)
            return
        if len(camera_calibrations) == 0:
            raise ValueError('camera_calibrations must not be empty')

        intrinsics = []
        distortion = []
        fisheye_mask = []
        axis_signs = []
        for camera_index, calibration in enumerate(camera_calibrations):
            camera_model = str(
                calibration.get('camera_model', 'pinhole')).lower()
            if camera_model not in {'pinhole', 'fisheye'}:
                raise ValueError(
                    f'Unsupported camera_model={camera_model!r} at camera '
                    f'index {camera_index}')
            if 'camera_intrinsic' not in calibration:
                raise ValueError(
                    f'camera_intrinsic is required at camera index '
                    f'{camera_index}')
            intrinsic = torch.as_tensor(
                calibration['camera_intrinsic'], dtype=torch.float32)
            if intrinsic.shape != (3, 3):
                raise ValueError(
                    f'camera_intrinsic at camera index {camera_index} must '
                    f'have shape (3, 3), got {tuple(intrinsic.shape)}')
            coefficients = torch.as_tensor(
                calibration.get('distortion', [0.0, 0.0, 0.0, 0.0]),
                dtype=torch.float32)
            if coefficients.shape != (4, ):
                raise ValueError(
                    f'distortion at camera index {camera_index} must have '
                    f'shape (4,), got {tuple(coefficients.shape)}')
            signs = torch.as_tensor(
                calibration.get('axis_signs', [1.0, 1.0, 1.0]),
                dtype=torch.float32)
            if signs.shape != (3, ) or not torch.all(signs.abs() == 1):
                raise ValueError(
                    f'axis_signs at camera index {camera_index} must contain '
                    f'three values selected from -1 and 1, got {signs.tolist()}')

            intrinsics.append(intrinsic)
            distortion.append(coefficients)
            fisheye_mask.append(camera_model == 'fisheye')
            axis_signs.append(signs)

        self.register_buffer('configured_intrinsics',
                             torch.stack(intrinsics))
        self.register_buffer('configured_distortion',
                             torch.stack(distortion))
        self.register_buffer(
            'configured_fisheye_mask',
            torch.tensor(fisheye_mask, dtype=torch.bool))
        self.register_buffer('configured_axis_signs',
                             torch.stack(axis_signs))

    def _resolve_camera_calibrations(
            self, runtime_intrinsics: torch.Tensor
    ) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        batch_size, num_cameras = runtime_intrinsics.shape[:2]
        if self.configured_intrinsics is None:
            distortion = runtime_intrinsics.new_zeros(
                (batch_size, num_cameras, 4))
            fisheye_mask = torch.zeros(
                (batch_size, num_cameras),
                dtype=torch.bool,
                device=runtime_intrinsics.device)
            axis_signs = runtime_intrinsics.new_ones(
                (batch_size, num_cameras, 3))
            return runtime_intrinsics, distortion, fisheye_mask, axis_signs

        configured_cameras = self.configured_intrinsics.shape[0]
        if configured_cameras != num_cameras:
            raise ValueError(
                f'Configured camera count {configured_cameras} does not match '
                f'input camera count {num_cameras}')
        intrinsics = self.configured_intrinsics.to(
            runtime_intrinsics).unsqueeze(0).expand(batch_size, -1, -1, -1)
        distortion = self.configured_distortion.to(
            runtime_intrinsics).unsqueeze(0).expand(batch_size, -1, -1)
        fisheye_mask = self.configured_fisheye_mask.to(
            runtime_intrinsics.device).unsqueeze(0).expand(batch_size, -1)
        axis_signs = self.configured_axis_signs.to(
            runtime_intrinsics).unsqueeze(0).expand(batch_size, -1, -1)
        return intrinsics, distortion, fisheye_mask, axis_signs

    def create_frustum(self):
        iH, iW = self.image_size
        fH, fW = self.feature_size

        ds = (
            torch.arange(*self.dbound,
                         dtype=torch.float).view(-1, 1, 1).expand(-1, fH, fW))
        D, _, _ = ds.shape

        xs = (
            torch.linspace(0, iW - 1, fW,
                           dtype=torch.float).view(1, 1, fW).expand(D, fH, fW))
        ys = (
            torch.linspace(0, iH - 1, fH,
                           dtype=torch.float).view(1, fH, 1).expand(D, fH, fW))

        frustum = torch.stack((xs, ys, ds), -1)
        return nn.Parameter(frustum, requires_grad=False)

    def get_geometry(
        self,
        camera2lidar_rots,
        camera2lidar_trans,
        intrins,
        post_rots,
        post_trans,
        **kwargs,
    ):
        B, N, _ = camera2lidar_trans.shape

        # undo post-transformation
        # B x N x D x H x W x 3
        points = self.frustum - post_trans.view(B, N, 1, 1, 1, 3)
        points = (
            torch.inverse(post_rots).view(B, N, 1, 1, 1, 3,
                                          3).matmul(
                                              points.unsqueeze(-1)).squeeze(-1))
        resolved = self._resolve_camera_calibrations(intrins)
        points, valid, _ = unproject_image_points(
            points[..., :2],
            points[..., 2],
            *resolved,
            newton_iterations=10)
        points = camera2lidar_rots.view(
            B, N, 1, 1, 1, 3, 3).matmul(points.unsqueeze(-1)).squeeze(-1)
        points += camera2lidar_trans.view(B, N, 1, 1, 1, 3)

        if 'extra_rots' in kwargs:
            extra_rots = kwargs['extra_rots']
            points = (
                extra_rots.view(B, 1, 1, 1, 1, 3,
                                3).repeat(1, N, 1, 1, 1, 1, 1).matmul(
                                    points.unsqueeze(-1)).squeeze(-1))
        if 'extra_trans' in kwargs:
            extra_trans = kwargs['extra_trans']
            points += extra_trans.view(B, 1, 1, 1, 1,
                                       3).repeat(1, N, 1, 1, 1, 1)

        points = torch.where(
            valid.unsqueeze(-1), points, torch.full_like(points, 1e6))
        return points

    def get_cam_feats(self, x):
        raise NotImplementedError

    def bev_pool(self, geom_feats, x):
        B, N, D, H, W, C = x.shape
        Nprime = B * N * D * H * W

        # flatten x
        x = x.reshape(Nprime, C)

        # flatten indices
        geom_feats = ((geom_feats - (self.bx - self.dx / 2.0)) /
                      self.dx).long()
        geom_feats = geom_feats.view(Nprime, 3)
        batch_ix = torch.cat([
            torch.full([Nprime // B, 1], ix, device=x.device, dtype=torch.long)
            for ix in range(B)
        ])
        geom_feats = torch.cat((geom_feats, batch_ix), 1)

        # filter out points that are outside box
        kept = ((geom_feats[:, 0] >= 0)
                & (geom_feats[:, 0] < self.nx[0])
                & (geom_feats[:, 1] >= 0)
                & (geom_feats[:, 1] < self.nx[1])
                & (geom_feats[:, 2] >= 0)
                & (geom_feats[:, 2] < self.nx[2]))
        x = x[kept]
        geom_feats = geom_feats[kept]

        x = bev_pool(x, geom_feats, B, self.nx[2], self.nx[0], self.nx[1])

        # collapse Z
        final = torch.cat(x.unbind(dim=2), 1)

        return final

    def forward(
        self,
        img,
        points,
        lidar2image,
        camera_intrinsics,
        camera2lidar,
        img_aug_matrix,
        lidar_aug_matrix,
        metas,
        **kwargs,
    ):
        intrins = camera_intrinsics[..., :3, :3]
        post_rots = img_aug_matrix[..., :3, :3]
        post_trans = img_aug_matrix[..., :3, 3]
        camera2lidar_rots = camera2lidar[..., :3, :3]
        camera2lidar_trans = camera2lidar[..., :3, 3]

        extra_rots = lidar_aug_matrix[..., :3, :3]
        extra_trans = lidar_aug_matrix[..., :3, 3]

        geom = self.get_geometry(
            camera2lidar_rots,
            camera2lidar_trans,
            intrins,
            post_rots,
            post_trans,
            extra_rots=extra_rots,
            extra_trans=extra_trans,
        )

        x = self.get_cam_feats(img)
        x = self.bev_pool(geom, x)
        return x


@MODELS.register_module()
class LSSTransform(BaseViewTransform):

    def __init__(
        self,
        in_channels: int,
        out_channels: int,
        image_size: Tuple[int, int],
        feature_size: Tuple[int, int],
        xbound: Tuple[float, float, float],
        ybound: Tuple[float, float, float],
        zbound: Tuple[float, float, float],
        dbound: Tuple[float, float, float],
        downsample: int = 1,
        camera_calibrations: Optional[Sequence[Mapping[str, Any]]] = None,
    ) -> None:
        super().__init__(
            in_channels=in_channels,
            out_channels=out_channels,
            image_size=image_size,
            feature_size=feature_size,
            xbound=xbound,
            ybound=ybound,
            zbound=zbound,
            dbound=dbound,
            camera_calibrations=camera_calibrations,
        )
        self.depthnet = nn.Conv2d(in_channels, self.D + self.C, 1)
        if downsample > 1:
            assert downsample == 2, downsample
            self.downsample = nn.Sequential(
                nn.Conv2d(
                    out_channels, out_channels, 3, padding=1, bias=False),
                nn.BatchNorm2d(out_channels),
                nn.ReLU(True),
                nn.Conv2d(
                    out_channels,
                    out_channels,
                    3,
                    stride=downsample,
                    padding=1,
                    bias=False,
                ),
                nn.BatchNorm2d(out_channels),
                nn.ReLU(True),
                nn.Conv2d(
                    out_channels, out_channels, 3, padding=1, bias=False),
                nn.BatchNorm2d(out_channels),
                nn.ReLU(True),
            )
        else:
            self.downsample = nn.Identity()

    def get_cam_feats(self, x):
        B, N, C, fH, fW = x.shape

        x = x.view(B * N, C, fH, fW)

        x = self.depthnet(x)
        depth = x[:, :self.D].softmax(dim=1)
        x = depth.unsqueeze(1) * x[:, self.D:(self.D + self.C)].unsqueeze(2)

        x = x.view(B, N, self.C, self.D, fH, fW)
        x = x.permute(0, 1, 3, 4, 5, 2)
        return x

    def forward(self, *args, **kwargs):
        x = super().forward(*args, **kwargs)
        x = self.downsample(x)
        return x


class BaseDepthTransform(BaseViewTransform):

    def forward(
        self,
        img,
        points,
        lidar2image,
        cam_intrinsic,
        camera2lidar,
        img_aug_matrix,
        lidar_aug_matrix,
        metas,
        **kwargs,
    ):
        intrins = cam_intrinsic[..., :3, :3]
        post_rots = img_aug_matrix[..., :3, :3]
        post_trans = img_aug_matrix[..., :3, 3]
        camera2lidar_rots = camera2lidar[..., :3, :3]
        camera2lidar_trans = camera2lidar[..., :3, 3]
        resolved_calibrations = self._resolve_camera_calibrations(intrins)

        batch_size = len(points)
        depth = torch.zeros(batch_size, img.shape[1], 1,
                            *self.image_size).to(points[0].device)

        for b in range(batch_size):
            cur_coords = points[b][:, :3].clone()
            cur_img_aug_matrix = img_aug_matrix[b]
            cur_lidar_aug_matrix = lidar_aug_matrix[b]

            # inverse aug
            cur_coords -= cur_lidar_aug_matrix[:3, 3]
            cur_coords = torch.inverse(cur_lidar_aug_matrix[:3, :3]).matmul(
                cur_coords.transpose(1, 0))

            lidar2camera = torch.inverse(camera2lidar[b])
            camera_coords = lidar2camera[:, :3, :3].matmul(cur_coords)
            camera_coords += lidar2camera[:, :3, 3].reshape(-1, 3, 1)
            camera_coords = camera_coords.transpose(1, 2).unsqueeze(0)
            cur_coords, dist, projection_valid = project_camera_points(
                camera_coords,
                resolved_calibrations[0][b:b + 1],
                resolved_calibrations[1][b:b + 1],
                resolved_calibrations[2][b:b + 1],
                resolved_calibrations[3][b:b + 1])
            cur_coords = cur_coords.squeeze(0)
            dist = dist.squeeze(0)
            projection_valid = projection_valid.squeeze(0)

            # imgaug
            homogeneous_coords = torch.cat(
                (cur_coords, torch.ones_like(dist).unsqueeze(-1)), dim=-1)
            cur_coords = cur_img_aug_matrix[:, :3, :3].matmul(
                homogeneous_coords.transpose(1, 2))
            cur_coords += cur_img_aug_matrix[:, :3, 3].reshape(-1, 3, 1)
            cur_coords = cur_coords[:, :2, :].transpose(1, 2)

            # normalize coords for grid sample
            cur_coords = cur_coords[..., [1, 0]]

            on_img = ((cur_coords[..., 0] < self.image_size[0])
                      & (cur_coords[..., 0] >= 0)
                      & (cur_coords[..., 1] < self.image_size[1])
                      & (cur_coords[..., 1] >= 0) & projection_valid)
            for c in range(on_img.shape[0]):
                masked_coords = cur_coords[c, on_img[c]].long()
                masked_dist = dist[c, on_img[c]]
                depth = depth.to(masked_dist.dtype)
                depth[b, c, 0, masked_coords[:, 0],
                      masked_coords[:, 1]] = masked_dist

        extra_rots = lidar_aug_matrix[..., :3, :3]
        extra_trans = lidar_aug_matrix[..., :3, 3]
        geom = self.get_geometry(
            camera2lidar_rots,
            camera2lidar_trans,
            intrins,
            post_rots,
            post_trans,
            extra_rots=extra_rots,
            extra_trans=extra_trans,
        )

        x = self.get_cam_feats(img, depth)
        x = self.bev_pool(geom, x)
        return x


@MODELS.register_module()
class DepthLSSTransform(BaseDepthTransform):

    def __init__(
        self,
        in_channels: int,
        out_channels: int,
        image_size: Tuple[int, int],
        feature_size: Tuple[int, int],
        xbound: Tuple[float, float, float],
        ybound: Tuple[float, float, float],
        zbound: Tuple[float, float, float],
        dbound: Tuple[float, float, float],
        downsample: int = 1,
        camera_calibrations: Optional[Sequence[Mapping[str, Any]]] = None,
    ) -> None:
        """Compared with `LSSTransform`, `DepthLSSTransform` adds sparse depth
        information from lidar points into the inputs of the `depthnet`."""
        super().__init__(
            in_channels=in_channels,
            out_channels=out_channels,
            image_size=image_size,
            feature_size=feature_size,
            xbound=xbound,
            ybound=ybound,
            zbound=zbound,
            dbound=dbound,
            camera_calibrations=camera_calibrations,
        )
        self.dtransform = nn.Sequential(
            nn.Conv2d(1, 8, 1),
            nn.BatchNorm2d(8),
            nn.ReLU(True),
            nn.Conv2d(8, 32, 5, stride=4, padding=2),
            nn.BatchNorm2d(32),
            nn.ReLU(True),
            nn.Conv2d(32, 64, 5, stride=2, padding=2),
            nn.BatchNorm2d(64),
            nn.ReLU(True),
        )
        self.depthnet = nn.Sequential(
            nn.Conv2d(in_channels + 64, in_channels, 3, padding=1),
            nn.BatchNorm2d(in_channels),
            nn.ReLU(True),
            nn.Conv2d(in_channels, in_channels, 3, padding=1),
            nn.BatchNorm2d(in_channels),
            nn.ReLU(True),
            nn.Conv2d(in_channels, self.D + self.C, 1),
        )
        if downsample > 1:
            assert downsample == 2, downsample
            self.downsample = nn.Sequential(
                nn.Conv2d(
                    out_channels, out_channels, 3, padding=1, bias=False),
                nn.BatchNorm2d(out_channels),
                nn.ReLU(True),
                nn.Conv2d(
                    out_channels,
                    out_channels,
                    3,
                    stride=downsample,
                    padding=1,
                    bias=False,
                ),
                nn.BatchNorm2d(out_channels),
                nn.ReLU(True),
                nn.Conv2d(
                    out_channels, out_channels, 3, padding=1, bias=False),
                nn.BatchNorm2d(out_channels),
                nn.ReLU(True),
            )
        else:
            self.downsample = nn.Identity()

    def get_cam_feats(self, x, d):
        B, N, C, fH, fW = x.shape

        d = d.view(B * N, *d.shape[2:])
        x = x.view(B * N, C, fH, fW)

        d = self.dtransform(d)
        x = torch.cat([d, x], dim=1)
        x = self.depthnet(x)

        depth = x[:, :self.D].softmax(dim=1)
        x = depth.unsqueeze(1) * x[:, self.D:(self.D + self.C)].unsqueeze(2)

        x = x.view(B, N, self.C, self.D, fH, fW)
        x = x.permute(0, 1, 3, 4, 5, 2)
        return x

    def forward(self, *args, **kwargs):
        x = super().forward(*args, **kwargs)
        x = self.downsample(x)
        return x
