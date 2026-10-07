# Official KITTI references

Calibration text is extracted unchanged from the official `2011_09_26_calib.zip` and `data_tracking_calib.zip` (sequence 0011). `tracking-reference.json` contains human label samples for frames 0, 12, 50, 100, 199 from official `data_tracking_label_2.zip`, and exact PNG SHA-256 hashes from `data_tracking_image_2.zip`, training/image_02/0011.

Sources: https://www.cvlibs.net/datasets/kitti/ and https://s3.eu-central-1.amazonaws.com/avg-kitti/ . KITTI's dataset terms apply to the reference data.

Raw drive 0084 was incorrectly associated with tracking 0011 by earlier local scripts. Correct internal transforms do not prove that two different recordings correspond. The camera preview now uses tracking images, tracking Velodyne frames, tracking OXTS and tracking calibration together. The old raw-drive R-mini is historical and must not be used as proof of alignment to tracking 0011.
