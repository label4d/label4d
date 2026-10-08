"""Common binary XYZI PCD writer."""
import numpy as np


def write_pcd(path, points):
    points = np.asarray(points)
    if points.ndim != 2 or points.shape[1] != 4 or not np.isfinite(points).all():
        raise ValueError('PCD requires finite N x 4 XYZI points')
    count = len(points)
    header = f'VERSION 0.7\nFIELDS x y z intensity\nSIZE 4 4 4 4\nTYPE F F F F\nCOUNT 1 1 1 1\nWIDTH {count}\nHEIGHT 1\nPOINTS {count}\nDATA binary\n'
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('wb') as stream:
        stream.write(header.encode())
        stream.write(points.astype('<f4').tobytes())
