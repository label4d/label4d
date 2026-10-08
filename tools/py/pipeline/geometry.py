"""Right-handed local Y-up geometry used by offline adapters."""
import numpy as np

# Source X-forward/Y-left/Z-up -> display X-forward/Y-up/Z-right.
BASIS = np.array([[1., 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, 0], [0, 0, 0, 1]])


def rigid(values):
    matrix = np.asarray(values, dtype=np.float64).reshape(4, 4)
    rotation = matrix[:3, :3]
    if (not np.isfinite(matrix).all() or
            not np.allclose(matrix[3], [0, 0, 0, 1], atol=1e-8) or
            not np.allclose(rotation.T @ rotation, np.eye(3), atol=1e-3) or
            abs(np.linalg.det(rotation) - 1) >= 1e-3):
        raise ValueError('Expected a finite right-handed rigid transform')
    return matrix


def transform_points(points, matrix):
    return np.asarray(points, dtype=np.float64) @ matrix[:3, :3].T + matrix[:3, 3]


def rotation_rpy(angles):
    """Rz(yaw) Ry(pitch) Rx(roll), vectorized over leading dimensions."""
    roll, pitch, yaw = np.moveaxis(np.asarray(angles, dtype=np.float64), -1, 0)
    cr, sr, cp, sp, cy, sy = np.cos(roll), np.sin(roll), np.cos(pitch), np.sin(pitch), np.cos(yaw), np.sin(yaw)
    return np.stack([cy*cp, cy*sp*sr-sy*cr, cy*sp*cr+sy*sr,
                     sy*cp, sy*sp*sr+cy*cr, sy*sp*cr-cy*sr,
                     -sp, cp*sr, cp*cr], axis=-1).reshape((*np.shape(roll), 3, 3))


def box_transform(center, heading, vehicle_to_world):
    """Box local X/Y/Z is length/height/width, preserving world roll and pitch."""
    local = np.eye(4)
    local[:3, :3] = rotation_rpy([0, 0, heading]) @ BASIS[:3, :3].T
    local[:3, 3] = center
    return vehicle_to_world @ local


def points_outside_boxes(points, boxes, padding=.2):
    keep = np.ones(len(points), dtype=bool)
    for box in boxes:
        matrix = np.asarray(box['boxToWorld']).reshape(4, 4, order='F')
        local = (points[:, :3] - matrix[:3, 3]) @ matrix[:3, :3]
        inside = (np.abs(local) < np.asarray(box['size']) / 2 + padding).all(axis=1)
        keep &= ~inside
    return keep
