
from ad_ext import CameraCalibParams
import cv2
import numpy as np
import math

try:
    import torch
    import torch.nn.functional as F
except ImportError:  # pragma: no cover
    torch = None
    F = None


class CameraProjection:
    def __init__(self, conf, fisheye_boundary=None):
        """Args:
            conf: Camera calibration config.
            fisheye_boundary: For ``kFisheye`` only — ``list`` of at least four built-in
            ``float`` values: ``max_visible_theta``, ``max_visible_theta_d``,
            ``invisible_distort_slope``, ``invisible_distort_offset``.
            Callers must convert tensors / numpy arrays themselves.
            When set, skips the internal derivative search that fills those fields.
        """
        self.config = conf

        self.rvec = np.array(conf.rvec, dtype=np.float32)
        self.tvec = np.array(conf.tvec, dtype=np.float32)

        self.mtx = np.zeros((3,3), dtype=np.float32)
        self.mtx[0, 0] = conf.fx
        self.mtx[1, 1] = conf.fy
        self.mtx[0, 2] = conf.cx
        self.mtx[1, 2] = conf.cy
        self.mtx[2, 2] = 1
        self.mtx_inv = np.linalg.inv(self.mtx)

        self.R = np.zeros((3,3), dtype=np.float32)
        cv2.Rodrigues(self.rvec, self.R)
        self.R_inv = np.linalg.inv(self.R)

        if conf.camera_type == CameraCalibParams.BaseCameraConfig.kPinhole:
            self.dist = np.zeros((1,5), dtype=np.float32)
            self.dist[0, 0] = conf.k1
            self.dist[0, 1] = conf.k2
            self.dist[0, 2] = conf.p1
            self.dist[0, 3] = conf.p2
            self.dist[0, 4] = conf.k3
        elif conf.camera_type == CameraCalibParams.BaseCameraConfig.kFisheye:
            self.dist = np.zeros((1,4), dtype=np.float32)
            self.dist[0, 0] = conf.k1
            self.dist[0, 1] = conf.k2
            self.dist[0, 2] = conf.k3
            self.dist[0, 3] = conf.k4
        elif conf.camera_type == CameraCalibParams.BaseCameraConfig.kOmnidir:
            self.dist = np.zeros((1,4), dtype=np.float32)
            self.dist[0, 0] = conf.k1
            self.dist[0, 1] = conf.k2
            self.dist[0, 2] = conf.p1
            self.dist[0, 3] = conf.p2

        # distortion curve calibrated by visible target points is not well shaped in invisible area
        # when we need to draw points out of image bounds, we will get large err
        # to fix such issue, we need to replace such curve in invisible area with a well shaped one
        # we can simply use the tangent line of the curve 
        self.max_visible_theta = 1e10
        self.max_visible_theta_d = 1e10
        self.invisible_distort_slope = 1
        self.invisible_distort_offset = 0
        if self.config.camera_type == CameraCalibParams.BaseCameraConfig.kFisheye:

            if fisheye_boundary is not None:
                self.max_visible_theta = fisheye_boundary[0]
                self.max_visible_theta_d = fisheye_boundary[1]
                self.invisible_distort_slope = fisheye_boundary[2]
                self.invisible_distort_offset = fisheye_boundary[3]

            else:
                # Derivative should be around 1, 
                # if it's too low/high, it will be hard to solve the undistorted value using Newton method.
                # if it's goes from around 1 to below 0, it means one y could correspond to more than one x, which is not good when solve x given y.
                # 
                prev_theta_list = []
                bad_value_found = False
                for theta in np.arange (0, math.pi, 0.1):

                    theta_2 = theta*theta
                    theta_4 = theta_2*theta_2
                    theta_6 = theta_4*theta_2
                    theta_8 = theta_4*theta_4
                    
                    deriv_theta = 1 + 3*self.config.k1*theta_2 + 5*self.config.k2*theta_4 \
                            + 7*self.config.k3*theta_6 + 9*self.config.k4*theta_8

                    prev_theta_list.insert(0, (theta, deriv_theta))

                    # derivative should be in reasonable value, otherwise we need to replace the curve with its tangent line    
                    if deriv_theta < 0.1 or deriv_theta > 5:
                        bad_value_found = True
                        break

                if bad_value_found and len(prev_theta_list) > 0:
                    theta = prev_theta_list[0][0]
                    if theta < math.pi / 2:
                        print ('Derivative of distortion curve is bad in calib area, need to check the calibration')
                    else: 
                        for theta, deriv_theta in prev_theta_list:
                            if deriv_theta > 0.3 and deriv_theta < 2:
                                #print ('check', theta, deriv_theta)
                                theta_2 = theta*theta
                                theta_4 = theta_2*theta_2
                                theta_6 = theta_4*theta_2
                                theta_8 = theta_4*theta_4
                        
                                self.max_visible_theta = theta
                                # calc theta_d for precision value
                                self.max_visible_theta_d = theta * (1 + self.config.k1*theta_2 + self.config.k2*theta_4 \
                                        + self.config.k3*theta_6 + self.config.k4*theta_8)
                                self.invisible_distort_slope = deriv_theta
                                # slope * theta + offset = theta_d
                                self.invisible_distort_offset = self.max_visible_theta_d - self.invisible_distort_slope * self.max_visible_theta
                                # print ('init max_visible_theta', self.max_visible_theta, self.max_visible_theta_d, self.invisible_distort_slope, self.invisible_distort_offset)
                                break

        
    def CataDistortion(p_u, k1, k2, p1, p2):
        
        mx2_u = p_u[0] * p_u[0]
        my2_u = p_u[1] * p_u[1]
        mxy_u = p_u[0] * p_u[1]
        rho2_u = mx2_u + my2_u
        rad_dist_u = k1 * rho2_u + k2 * rho2_u * rho2_u
        d_u_0 = p_u[0] * rad_dist_u + 2.0 * p1 * mxy_u + p2 * (rho2_u + 2.0 * mx2_u)
        d_u_1 = p_u[1] * rad_dist_u + 2.0 * p2 * mxy_u + p1 * (rho2_u + 2.0 * my2_u)
        
        return [d_u_0, d_u_1]
    
                
    def SolveTheta(self, theta_d, stop_iter_count, stop_iter_diff):
        # NOTE: solving may result in no root, one root or multiple root
        # depends one the calibrate params
        theta = theta_d
        if theta_d > self.max_visible_theta: # limit init x, when given y which may solve more than one x
            theta = self.max_visible_theta
        prev_theta = theta
        for j in range(stop_iter_count):
            theta_2 = theta*theta
            theta_4 = theta_2*theta_2
            theta_6 = theta_4*theta_2
            theta_8 = theta_4*theta_4
            theta = theta_d / (1 + self.config.k1 * theta_2 + self.config.k2 * theta_4 + self.config.k3 * theta_6 + self.config.k4 * theta_8)
            #print ('prev_theta diff', theta - prev_theta)
            if abs(theta - prev_theta) < stop_iter_diff:
                break
            prev_theta = theta
           
        if j+1 == stop_iter_count:
            return -1 # not converge until last step

        return theta
        
    # input: u,v is in image coord, z_plane is in vehicle coord.
    # output: x,y is in vehicle coord
    def CoordImageToWorld(self, u, v, z_plane): 

        if self.config.camera_type == CameraCalibParams.BaseCameraConfig.kPinhole:
            distorted_points = [(u, v)]
            undistorted_points = self.UndistortPoints(distorted_points)
            u_dist = undistorted_points[0][0]
            v_dist = undistorted_points[0][1]
            return self.UndistortedImagePointToWorldPoint(u_dist, v_dist, z_plane)
        else:

            P0 = None

            if self.config.camera_type == CameraCalibParams.BaseCameraConfig.kFisheye:
                # ref: calib3d/fisheye.cpp in opencv source code

                x1 = (u - self.config.cx)/self.config.fx
                y1 = (v - self.config.cy)/self.config.fy

                r1 = math.hypot(x1, y1)

                # according to the formula in https://docs.opencv.org/3.4/db/d58/group__calib3d__fisheye.html
                # note here we compute directly on sphere, avoid using tan() which can be infinite.
                theta_d = r1

                P0 = np.zeros((3,1), dtype=np.float32)
                if theta_d > 1e-8:

                    if theta_d > self.max_visible_theta_d:
                        theta = (theta_d - self.invisible_distort_offset) / self.invisible_distort_slope
                        #print('theta_d > self.max_visible_theta_d')
                    else:
                        kStopIterCount = 20
                        kStopIterDiff = 1e-4
                        theta = self.SolveTheta(theta_d, kStopIterCount, kStopIterDiff)
                        if theta < 0:
                            return None
                    
                    #print("theta", theta_d, " -> ", theta)

                    P0[2] = math.cos(theta)
                    r0 = math.sin(theta)

                    # obviously, x1/y1 = x0/y0
                    if abs(y1) > 1e-8:
                        k = abs(x1 / y1)
                        # x0 = k * y0, x0*x0 + y0*y0 = r0*r0,
                        P0[1] = math.sqrt(r0*r0 / (1 + k*k))
                        P0[0] = k * P0[1]
                        # std::cout << "1) k " << k << " r0 " << r0 << std::endl;
                    else:
                        k = abs(y1 / x1)
                        # y0 = k * x0, x0*x0 + y0*y0 = r0*r0,
                        P0[0] = math.sqrt(r0*r0 / (1 + k*k))
                        P0[1] = k * P0[0]
                        # std::cout << "2) k " << k << " r0 " << r0 << std::endl;

                    # the sign of x0, y0 are same as x1, y1
                    if x1 < 0:
                        P0[0] = -P0[0]
                    if y1 < 0:
                        P0[1] = -P0[1]

                else:
                    P0[0] = 0
                    P0[1] = 0
                    P0[2] = 1
            
            elif self.config.camera_type == CameraCalibParams.BaseCameraConfig.kOmnidir:
                mx_d = (u - self.config.cx)/self.config.fx
                my_d = (v - self.config.cy)/self.config.fy
                
                k1 = self.config.k1
                k2 = self.config.k2
                p1 = self.config.p1
                p2 = self.config.p2

                # Recursive distortion model
                n = 6
                d_u = self.CataDistortion([mx_d, my_d], k1, k2, p1, p2)
                # Approximate value
                mx_u = mx_d - d_u[0]
                my_u = my_d - d_u[1]

                for _ in range(1,n):
                    d_u = self.CataDistortion([mx_u, my_u], k1, k2, p1, p2)
                    mx_u = mx_d - d_u[0]
                    my_u = my_d - d_u[1]

                # Lift normalised points to the sphere (inv_hslash)
                xi = self.config.xi
                if xi == 1.0:
                    lmda = 2.0 / (mx_u * mx_u + my_u * my_u + 1.0)
                    P0[0] = lmda * mx_u 
                    P0[1] = lmda * my_u 
                    P0[2] = lmda - 1.0
                else:
                    lmda = (xi + math.sqrt(1.0 + (1.0 - xi * xi) * (mx_u * mx_u + my_u * my_u))) / (1.0 + mx_u * mx_u + my_u * my_u)
                    P0[0] = lmda * mx_u 
                    P0[1] = lmda * my_u 
                    P0[2] = lmda - xi


            # calucate ray & plane intersection

            # std::cout << " x1y1 " << x1 << "," << y1 << " P0 " << P0 << std::endl;

            #R = np.copy(self.R)
            #R_inv = np.copy(self.R_inv)
            T = np.copy(self.tvec).reshape(3,1)

            # O,P and O,P0 colinear:
            # (R * P + T) = k * P0
            # => P = R.inv * (k * P0 - T)  ------- (1)
            
            Z0 = np.array([0, 0, z_plane], dtype=np.float32).reshape(3,1) # a point on plane
            Zn = np.array([0, 0, 1], dtype=np.float32).reshape(3,1) # normal vector of the plane
            # cv::Vec3f Z0 = R * Z0_vehicle + T;
            # cv::Vec3f Zn = R * Zn_vehicle;
            # std::cout << " Z0 " << Z0 << " Zn " << Zn << std::endl;

            # P is on plane
            # (P - Z0) · Zn = 0   --------- (2)

            # So according to (1) and (2)
            # (k * R.inv * P0 - R.inv * T - Z0) · Zn = 0
            # => k * R.inv * P0 · Zn = (R.inv * T + Z0) · Zn
            # => k = ((R.inv * T + Z0) · Zn) / (R.inv * P0 · Zn)

            kd = np.vdot(np.matmul(self.R_inv, P0), Zn)
            #print ('kd', kd)
            if abs(kd) < 1e-8: # ray is on plane
                return None
            else:
                kn = np.vdot((np.matmul(self.R_inv, T) + Z0), Zn)
                k = kn / kd
                #print ('k', k)
                if k > 0:
                    P = np.matmul(self.R_inv, k * P0 - T)
                    x = P[0][0]
                    y = P[1][0]
                    return x, y
                else: # don't use the intersection in reverse direction of the ray
                    return None

            # std::cout << "=== uv " << u << "," << v << "," << z_plane << " -> " << x << "," << y << std::endl;
            
            

    def UndistortedImagePointToWorldPoint(self, u, v, z_plane):
        # s * uv = M * (R_ * XYZ + T_)
        # => R_.inv * (M.inv * s * uv - T_) = XYZ
        # so we can get the ray formula: X = f(s), Y = g(s), Z = h(s)
        # assume point is on world plane: aX + bY + cZ + d = 0,
        # then we can caculate s for the intersaction point of the ray and the plane

        # if the plane is Z = 0, then it becomes more easy:
        # => R_.inv * M.inv * s * uv - R_.inv * T_ = XYZ
        # => s * M1 - M2 = XYZ
        # => s * M1[2] - M2[2] = Z
        # => s = (Z + M2[2]) / M1[2]
        uv = np.zeros((3, 1), dtype=np.float32) 
        uv[0][0] = u
        uv[1][0] = v
        uv[2][0] = 1
        
        T = np.copy(self.tvec).reshape(3,1)

        m1 = np.matmul(np.matmul(self.R_inv, self.mtx_inv), uv)
        m2 = np.matmul(self.R_inv, T)
        s = (z_plane + m2[2][0]) / m1[2][0]
        
        # should not project point above ground to the ground behind camera
        if s < 0:
            return None

        xyz = s * m1 - m2
        # print u,v,'====>',xyz[0][0], xyz[1][0]
        
        x = xyz[0][0]
        y = xyz[1][0]
        # z = xyz(2,0);
        return x, y

    # vectorization by Cursor, not carefully verified
    # uv: (2, N) array, u=uv[0,:], v=uv[1,:]. z_plane: scalar.
    # Returns xy: (2, N) world x,y; valid: (N,) bool, False where ray misses or behind camera.
    def CoordImageToWorldNumpy(self, uv, z_plane):
        uv = np.asarray(uv, dtype=np.float32)
        if uv.ndim == 1:
            uv = uv.reshape(2, -1)
        n = uv.shape[1]
        if self.config.camera_type == CameraCalibParams.BaseCameraConfig.kPinhole:
            distorted = uv.T  # (N, 2)
            undistorted = self.UndistortPoints(distorted)  # (N, 2)
            u_dist = undistorted[:, 0]
            v_dist = undistorted[:, 1]
            uv_h = np.ones((3, n), dtype=np.float32)
            uv_h[0, :] = u_dist
            uv_h[1, :] = v_dist
            T = np.array(self.tvec.reshape(3, 1), dtype=np.float32)
            m1 = np.matmul(np.matmul(self.R_inv, self.mtx_inv), uv_h)  # (3, N)
            m2 = np.matmul(self.R_inv, T)  # (3, 1)
            s = (z_plane + m2[2, 0]) / (m1[2, :] + 1e-12)
            valid = s > 0
            s = np.where(valid, s, 0)
            xyz = s * m1 - m2  # (3, N)
            xy = np.stack([xyz[0, :], xyz[1, :]], axis=0)
            return xy, valid
        elif self.config.camera_type == CameraCalibParams.BaseCameraConfig.kFisheye:
            # 向量化 Fisheye: theta_d -> theta (Newton) -> P0 单位球 -> 射线与平面求交
            x1 = (uv[0, :] - self.config.cx) / self.config.fx
            y1 = (uv[1, :] - self.config.cy) / self.config.fy
            r1 = np.hypot(x1, y1)
            theta_d = r1.astype(np.float32)
            # 可见区外线性外推
            linear_theta = (theta_d - self.invisible_distort_offset) / self.invisible_distort_slope
            theta = np.where(theta_d > self.max_visible_theta_d, linear_theta,
                             np.minimum(theta_d, self.max_visible_theta))
            # 可见区内 Newton 迭代
            k1, k2, k3, k4 = self.config.k1, self.config.k2, self.config.k3, self.config.k4
            for _ in range(20):
                theta_2 = theta * theta
                theta_4 = theta_2 * theta_2
                theta_6 = theta_4 * theta_2
                theta_8 = theta_4 * theta_4
                theta_new = theta_d / (1 + k1 * theta_2 + k2 * theta_4 + k3 * theta_6 + k4 * theta_8)
                theta = np.where(theta_d <= self.max_visible_theta_d, theta_new, theta)
            valid_theta = np.isfinite(theta) & (theta >= 0)
            # P0 单位球方向 (3, N)
            r0 = np.sin(theta)
            P0_z = np.cos(theta)
            r1_safe = np.where(r1 > 1e-8, r1, 1.0)
            P0_x = np.where(r1 > 1e-8, r0 * x1 / r1_safe, 0.0)
            P0_y = np.where(r1 > 1e-8, r0 * y1 / r1_safe, 0.0)
            P0 = np.stack([P0_x, P0_y, P0_z], axis=0).astype(np.float32)
            P0[:, r1 <= 1e-8] = 0.0
            P0[2, r1 <= 1e-8] = 1.0
            # 射线与 z=z_plane 求交
            T = np.array(self.tvec.reshape(3, 1), dtype=np.float32)
            m1 = np.matmul(self.R_inv, P0)
            m2 = np.matmul(self.R_inv, T)
            s = (z_plane + m2[2, 0]) / (m1[2, :] + 1e-12)
            valid_s = s > 0
            s = np.where(valid_s, s, 0.0)
            xyz = s * m1 - m2
            xy = np.stack([xyz[0, :], xyz[1, :]], axis=0)
            valid = valid_theta & valid_s
            return xy, valid
        elif self.config.camera_type == CameraCalibParams.BaseCameraConfig.kOmnidir:
            # 向量化 Omnidir: CataDistortion 迭代 -> 球面 lift -> 射线与平面求交
            mx_d = (uv[0, :] - self.config.cx) / self.config.fx
            my_d = (uv[1, :] - self.config.cy) / self.config.fy
            k1, k2, p1, p2 = self.config.k1, self.config.k2, self.config.p1, self.config.p2
            mx2 = mx_d * mx_d
            my2 = my_d * my_d
            mxy = mx_d * my_d
            rho2 = mx2 + my2
            rad_dist = k1 * rho2 + k2 * rho2 * rho2
            d0 = mx_d * rad_dist + 2.0 * p1 * mxy + p2 * (rho2 + 2.0 * mx2)
            d1 = my_d * rad_dist + 2.0 * p2 * mxy + p1 * (rho2 + 2.0 * my2)
            mx_u = mx_d - d0
            my_u = my_d - d1
            for _ in range(5):
                mx2 = mx_u * mx_u
                my2 = my_u * my_u
                mxy = mx_u * my_u
                rho2 = mx2 + my2
                rad_dist = k1 * rho2 + k2 * rho2 * rho2
                d0 = mx_u * rad_dist + 2.0 * p1 * mxy + p2 * (rho2 + 2.0 * mx2)
                d1 = my_u * rad_dist + 2.0 * p2 * mxy + p1 * (rho2 + 2.0 * my2)
                mx_u = mx_d - d0
                my_u = my_d - d1
            xi = self.config.xi
            denom = mx_u * mx_u + my_u * my_u + 1.0
            if xi == 1.0:
                lmda = 2.0 / denom
                P0_z = lmda - 1.0
            else:
                inner = 1.0 + (1.0 - xi * xi) * (mx_u * mx_u + my_u * my_u)
                lmda = (xi + np.sqrt(inner)) / denom
                P0_z = lmda - xi
            P0_x = lmda * mx_u
            P0_y = lmda * my_u
            P0 = np.stack([P0_x, P0_y, P0_z], axis=0).astype(np.float32)
            T = np.array(self.tvec.reshape(3, 1), dtype=np.float32)
            m1 = np.matmul(self.R_inv, P0)
            m2 = np.matmul(self.R_inv, T)
            s = (z_plane + m2[2, 0]) / (m1[2, :] + 1e-12)
            valid_s = s > 0
            s = np.where(valid_s, s, 0.0)
            xyz = s * m1 - m2
            xy = np.stack([xyz[0, :], xyz[1, :]], axis=0)
            valid = valid_s & np.isfinite(xy[0, :]) & np.isfinite(xy[1, :])
            return xy, valid
        else:
            assert False, "CoordImageToWorldNumpy: unsupported camera_type %s" % getattr(
                self.config.camera_type, 'name', self.config.camera_type)

    def CoordImageToWorldRayTorch(self, uv):
        """World-frame camera rays through image pixels (no intersection with a plane).

        Each viewing ray is ``p(t) = ray_origin + t * ray_dir`` with ``t > 0`` in front of
        the camera (same parameterization as :meth:`CoordImageToWorldTorch` uses internally).

        Args:
            uv (torch.Tensor): Shape ``(2, N)`` — pixel coordinates ``u, v``.

        Returns:
            tuple: ``(ray_origin, ray_dir, valid)`` with ``ray_origin`` shape ``(3,)`` (camera
            center in world frame), ``ray_dir`` shape ``(3, N)`` unit directions, and ``valid``
            shape ``(N,)``.
        """
        if not isinstance(uv, torch.Tensor):
            raise TypeError('uv must be a torch.Tensor')
        if uv.dim() == 1:
            uv = uv.reshape(2, -1)
        if uv.shape[0] != 2:
            uv = uv.T.contiguous()
        n = uv.shape[1]
        device, dtype = uv.device, uv.dtype

        if self.config.camera_type == CameraCalibParams.BaseCameraConfig.kPinhole:
            uv_np = uv.detach().cpu().numpy()
            distorted = uv_np.T
            undistorted = self.UndistortPoints(distorted)
            uv_h = np.ones((3, n), dtype=np.float32)
            uv_h[0, :] = undistorted[:, 0]
            uv_h[1, :] = undistorted[:, 1]
            m1 = np.matmul(np.matmul(self.R_inv, self.mtx_inv), uv_h)
            m2 = np.matmul(self.R_inv, self.tvec.reshape(3, 1))
            m1_t = torch.from_numpy(m1).to(device=device, dtype=dtype)
            m2_t = torch.from_numpy(m2).to(device=device, dtype=dtype)
            ray_origin = (-m2_t).reshape(3)
            ray_dir = F.normalize(m1_t, dim=0, eps=1e-12)
            valid = torch.isfinite(ray_dir).all(dim=0) & (m1_t.norm(dim=0) > 1e-8)
            return ray_origin, ray_dir, valid

        if self.config.camera_type == CameraCalibParams.BaseCameraConfig.kFisheye:
            fx = torch.tensor(self.config.fx, device=device, dtype=dtype)
            fy = torch.tensor(self.config.fy, device=device, dtype=dtype)
            cx = torch.tensor(self.config.cx, device=device, dtype=dtype)
            cy = torch.tensor(self.config.cy, device=device, dtype=dtype)
            k1 = torch.tensor(self.config.k1, device=device, dtype=dtype)
            k2 = torch.tensor(self.config.k2, device=device, dtype=dtype)
            k3 = torch.tensor(self.config.k3, device=device, dtype=dtype)
            k4 = torch.tensor(self.config.k4, device=device, dtype=dtype)

            mvt = torch.tensor(self.max_visible_theta, device=device, dtype=dtype)
            mvtd = torch.tensor(self.max_visible_theta_d, device=device, dtype=dtype)
            slope = torch.tensor(self.invisible_distort_slope, device=device, dtype=dtype)
            off = torch.tensor(self.invisible_distort_offset, device=device, dtype=dtype)

            x1 = (uv[0] - cx) / fx
            y1 = (uv[1] - cy) / fy
            r1 = torch.hypot(x1, y1)
            theta_d = r1

            linear_theta = (theta_d - off) / slope
            theta = torch.where(
                theta_d > mvtd,
                linear_theta,
                torch.minimum(theta_d, mvt),
            )

            for _ in range(20):
                theta_2 = theta * theta
                theta_4 = theta_2 * theta_2
                theta_6 = theta_4 * theta_2
                theta_8 = theta_4 * theta_4
                theta_new = theta_d / (
                    1.0 + k1 * theta_2 + k2 * theta_4 + k3 * theta_6 + k4 * theta_8)
                theta = torch.where(theta_d <= mvtd, theta_new, theta)

            valid_theta = torch.isfinite(theta) & (theta >= 0)

            r0 = torch.sin(theta)
            r1_safe = torch.where(r1 > 1e-8, r1, torch.ones_like(r1))
            P0_x = torch.where(r1 > 1e-8, r0 * x1 / r1_safe, torch.zeros_like(r1))
            P0_y = torch.where(r1 > 1e-8, r0 * y1 / r1_safe, torch.zeros_like(r1))
            P0_z = torch.cos(theta)
            P0 = torch.stack([P0_x, P0_y, P0_z], dim=0).to(dtype=dtype)

            center = r1 <= 1e-8
            P0[:, center] = 0.0
            P0[2, center] = 1.0

            R_inv_t = torch.from_numpy(self.R_inv).to(device=device, dtype=dtype)
            T_t = torch.from_numpy(self.tvec.reshape(3, 1)).to(device=device, dtype=dtype)

            m1 = torch.matmul(R_inv_t, P0)
            m2 = torch.matmul(R_inv_t, T_t)
            ray_origin = (-m2).reshape(3)
            ray_dir = m1
            return ray_origin, ray_dir, valid_theta

        if self.config.camera_type == CameraCalibParams.BaseCameraConfig.kOmnidir:
            raise NotImplementedError(
                'CoordImageToWorldRayTorch: omnidir — use CoordImageToWorldNumpy on CPU.')

        assert False, (
            'CoordImageToWorldRayTorch: unsupported camera_type %s' % getattr(
                self.config.camera_type, 'name', self.config.camera_type))

    def CoordImageToWorldTorch(
            self,
            uv,
            z_plane,
            return_xyz=False,
    ):
        """Torch counterpart of :meth:`CoordImageToWorldNumpy`.

        Args:
            uv (torch.Tensor): Shape ``(2, N)`` — pixel coordinates ``u, v`` (same layout as numpy).
            z_plane (torch.Tensor or float): World/vehicle plane ``Z`` for ray--plane intersection.
                Use a tensor of shape ``(N,)`` for per-ray depth (LSS frustum).
            return_xyz (bool): If True, return full ``(3, N)`` intersection points; if False,
                return ``(xy, valid)`` like :meth:`CoordImageToWorldNumpy`.

        Returns:
            tuple: ``(xy, valid)`` with ``xy`` of shape ``(2, N)``, or ``(xyz, valid)`` with
            ``xyz`` of shape ``(3, N)`` when ``return_xyz`` is True.
        """
        if not isinstance(uv, torch.Tensor):
            raise TypeError('uv must be a torch.Tensor')
        if uv.dim() == 1:
            uv = uv.reshape(2, -1)
        if uv.shape[0] != 2:
            uv = uv.T.contiguous()
        n = uv.shape[1]
        device, dtype = uv.device, uv.dtype

        if isinstance(z_plane, torch.Tensor):
            zp = z_plane.to(device=device, dtype=dtype).reshape(-1)
        else:
            zp = torch.full((n,), float(z_plane), device=device, dtype=dtype)
        if zp.numel() == 1:
            zp = zp.expand(n)
        elif zp.numel() != n:
            raise ValueError(
                f'z_plane must be scalar, (1,), or (N,), got shape {tuple(zp.shape)} with N={n}')

        if self.config.camera_type == CameraCalibParams.BaseCameraConfig.kPinhole:
            uv_np = uv.detach().cpu().numpy()
            if (zp - zp[0]).abs().max() > 1e-5:
                raise NotImplementedError(
                    'CoordImageToWorldTorch pinhole: only uniform z_plane; use fisheye '
                    'or CoordImageToWorldNumpy.')
            zp0 = float(zp[0].detach().cpu())
            xy_np, valid_np = self.CoordImageToWorldNumpy(uv_np, zp0)
            xy = torch.from_numpy(xy_np).to(device=device, dtype=dtype)
            valid = torch.from_numpy(valid_np).to(device=device, dtype=torch.bool)
            if return_xyz:
                xyz = torch.cat([xy, zp.reshape(1, n)], dim=0)
                return xyz, valid
            return xy, valid
        elif self.config.camera_type == CameraCalibParams.BaseCameraConfig.kFisheye:
            # 射线见 :meth:`CoordImageToWorldRayTorch`；此处仅与 z=z_plane 求交
            ray_origin, ray_dir, valid_theta = self.CoordImageToWorldRayTorch(uv)
            m2 = (-ray_origin).reshape(3, 1)
            s = (zp + m2[2, 0]) / (ray_dir[2, :] + 1e-12)
            valid_s = s > 0
            s = torch.where(valid_s, s, torch.zeros_like(s))
            xyz = s.unsqueeze(0) * ray_dir - m2

            valid = valid_theta & valid_s
            if return_xyz:
                return xyz, valid
            xy = xyz[[0, 1], :]
            return xy, valid
        elif self.config.camera_type == CameraCalibParams.BaseCameraConfig.kOmnidir:
            raise NotImplementedError(
                'CoordImageToWorldTorch: omnidir — use CoordImageToWorldNumpy on CPU.')
        else:
            assert False, (
                'CoordImageToWorldTorch: unsupported camera_type %s' % getattr(
                    self.config.camera_type, 'name', self.config.camera_type))

    def CoordWorldToImage(self, x, y, z):
    
        T = np.copy(self.tvec).reshape(3,1)

        if self.config.camera_type == CameraCalibParams.BaseCameraConfig.kPinhole:
            # TODO: avoid project point behind camera
            object_points = [[x, y, z]]
            
            image_points = self.WorldPointsToImagePoints(object_points)
            u = image_points[0][0]
            v = image_points[0][1]
        elif self.config.camera_type == CameraCalibParams.BaseCameraConfig.kFisheye:
            # https://docs.opencv.org/3.4/db/d58/group__calib3d__fisheye.html
            # NOTE: this implementation doesn't divide by z to avoid overflow 

            Pv = np.zeros((3, 1), dtype=np.float32)
            Pv[0][0] = x
            Pv[1][0] = y
            Pv[2][0] = z
            # cv::Mat_<float> Pc = R_inv_ * (Pv - T_);
            Pc = np.matmul(self.R, Pv) + T
            
            x = Pc[0][0]
            y = Pc[1][0]
            z = Pc[2][0]
            
            r = math.hypot(x, y)
            theta = math.atan2(r, z)
            theta_2 = theta*theta
            theta_4 = theta_2*theta_2
            theta_6 = theta_4*theta_2
            theta_8 = theta_4*theta_4

            if theta > self.max_visible_theta:
                #print('theta > self.max_visible_theta', theta, self.max_visible_theta)
                theta_d = self.invisible_distort_slope * theta + self.invisible_distort_offset
            else:
                theta_d = theta * (1 + self.config.k1*theta_2 + self.config.k2*theta_4
                    + self.config.k3*theta_6 + self.config.k4*theta_8)
            #print ('theta',theta,theta_d,r)
            theta_d_r = (theta_d / r) if (r > 1e-6) else 1

            x1 = theta_d_r * x
            y1 = theta_d_r * y

            u = self.config.fx * x1 + self.config.cx
            v = self.config.fy * y1 + self.config.cy
            
        elif self.config.camera_type == CameraCalibParams.BaseCameraConfig.kOmnidir:
            object_points = [[x, y, z]]
            
            image_points = self.WorldPointsToImagePoints(object_points)
            u = image_points[0][0]
            v = image_points[0][1]
        
        return u, v
    
    # points: 3xN or 4xN tensor
    def CoordWorldToImageTorch(self, points):
        
        T = torch.tensor(self.tvec.reshape(3,1), dtype=points.dtype).to(points.device)
        R = torch.tensor(self.R, dtype=points.dtype).to(points.device)

        if self.config.camera_type == CameraCalibParams.BaseCameraConfig.kPinhole:
            raise ValueError("Not implemented")
        elif self.config.camera_type == CameraCalibParams.BaseCameraConfig.kFisheye:
            # https://docs.opencv.org/3.4/db/d58/group__calib3d__fisheye.html
            # NOTE: this implementation doesn't divide by z to avoid overflow 

            Pc = torch.matmul(R, points[:3]) + T
            
            r = torch.hypot(Pc[0, :], Pc[1, :]) # x, y
            theta = torch.atan2(r, Pc[2, :]) # r / z
            theta_2 = theta*theta
            theta_4 = theta_2*theta_2
            theta_6 = theta_4*theta_2
            theta_8 = theta_4*theta_4

            theta_d_outlier = self.invisible_distort_slope * theta + self.invisible_distort_offset
        
            theta_d_inlier = theta * (1 + self.config.k1*theta_2 + self.config.k2*theta_4
                + self.config.k3*theta_6 + self.config.k4*theta_8)
            
            theta_d = torch.where(theta > self.max_visible_theta, theta_d_outlier, theta_d_inlier)
            
            one_tensor = torch.tensor(1.0, dtype=points.dtype).to(points.device)
            theta_d_r = torch.where(r > 1e-6, theta_d / r, one_tensor)

            x1 = theta_d_r * Pc[0, :]
            y1 = theta_d_r * Pc[1, :]

            u = self.config.fx * x1 + self.config.cx
            v = self.config.fy * y1 + self.config.cy

            uv = torch.stack([u, v])
            
        elif self.config.camera_type == CameraCalibParams.BaseCameraConfig.kOmnidir:
            raise ValueError("Not implemented")
        else:
            raise ValueError("Not implemented")

        return uv

    # points: 3xN or 4xN tensor
    def CoordWorldToImageNumpy(self, points):
        
        T = np.array(self.tvec.reshape(3,1), dtype=points.dtype)
        R = np.array(self.R, dtype=points.dtype)

        if self.config.camera_type == CameraCalibParams.BaseCameraConfig.kPinhole:
            # TODO: avoid project point behind camera
            object_points = np.transpose(points, [1, 0]) # (3,N)->(N,3)
            
            image_points = self.WorldPointsToImagePoints(object_points)
            
            return np.transpose(image_points, [1, 0]) # (N,2) -> (2,N)

        elif self.config.camera_type == CameraCalibParams.BaseCameraConfig.kFisheye:
            # https://docs.opencv.org/3.4/db/d58/group__calib3d__fisheye.html
            # NOTE: this implementation doesn't divide by z to avoid overflow 

            Pc = np.matmul(R, points[:3]) + T
            
            r = np.hypot(Pc[0, :], Pc[1, :]) # x, y
            theta = np.arctan2(r, Pc[2, :]) # r / z
            theta_2 = theta*theta
            theta_4 = theta_2*theta_2
            theta_6 = theta_4*theta_2
            theta_8 = theta_4*theta_4

            theta_d_outlier = self.invisible_distort_slope * theta + self.invisible_distort_offset
        
            theta_d_inlier = theta * (1 + self.config.k1*theta_2 + self.config.k2*theta_4
                + self.config.k3*theta_6 + self.config.k4*theta_8)
            
            theta_d = np.where(theta > self.max_visible_theta, theta_d_outlier, theta_d_inlier)
            
            one_tensor = np.array(1.0, dtype=points.dtype)
            theta_d_r = np.where(r > 1e-6, theta_d / r, one_tensor)

            x1 = theta_d_r * Pc[0, :]
            y1 = theta_d_r * Pc[1, :]

            u = self.config.fx * x1 + self.config.cx
            v = self.config.fy * y1 + self.config.cy

            uv = np.stack([u, v])
            
        elif self.config.camera_type == CameraCalibParams.BaseCameraConfig.kOmnidir:
            raise ValueError("Not implemented")
        else:
            raise ValueError("Not implemented")

        return uv

    def WorldPointsToImagePoints(self, object_points): 
        #T = np.copy().reshape(3,1)

        points = np.array(object_points, dtype=np.float32).reshape(-1,1,3)
        if self.config.camera_type == CameraCalibParams.BaseCameraConfig.kPinhole:
            image_points, jac = cv2.projectPoints(points, self.rvec, self.tvec, self.mtx, self.dist)
        elif self.config.camera_type == CameraCalibParams.BaseCameraConfig.kFisheye:
            image_points, jac = cv2.fisheye.projectPoints(points, self.rvec, self.tvec, self.mtx, self.dist)
        elif self.config.camera_type == CameraCalibParams.BaseCameraConfig.kOmnidir:
            image_points, jac = cv2.omnidir.projectPoints(points, self.rvec, self.tvec, self.mtx, self.config.xi, self.dist)
        

        return image_points.reshape(-1,2)
            
    def UndistortPoints(self, distorted):
        points = np.array(distorted, dtype=np.float32).reshape(-1,1,2)
        if self.config.camera_type == CameraCalibParams.BaseCameraConfig.kPinhole:
            undistorted = cv2.undistortPoints(points, self.mtx, self.dist, None, self.mtx)
        elif self.config.camera_type == CameraCalibParams.BaseCameraConfig.kFisheye:
            undistorted = cv2.fisheye.undistortPoints(points, self.mtx, self.dist, None, self.mtx)
        elif self.config.camera_type == CameraCalibParams.BaseCameraConfig.kOmnidir:
            undistorted = cv2.omnidir.undistortPoints(points, self.mtx, self.dist, self.config.xi, None)
        
        return undistorted.reshape(-1,2)

    
    def InitUndistortMap(self): 
        sz = (self.config.width, self.config.height)

        if self.config.camera_type == CameraCalibParams.BaseCameraConfig.kPinhole:
            return cv2.initUndistortRectifyMap(self.mtx, self.dist, None, self.mtx, sz, cv2.CV_32FC1)
        elif self.config.camera_type == CameraCalibParams.BaseCameraConfig.kFisheye:
            return cv2.fisheye.initUndistortRectifyMap(self.mtx, self.dist, None, self.mtx, sz, cv2.CV_32FC1)
        elif self.config.camera_type == CameraCalibParams.BaseCameraConfig.kOmnidir:
            return cv2.omnidir.initUndistortRectifyMap(self.mtx, self.dist, self.config.xi, None, self.mtx, sz, cv2.CV_32FC1)


    

