"""3DGS PLY 기반 Door 3D Corner 추정 모듈.

Pipeline: PLY -> multi-view render -> SAM3 mask -> 2D quadrilateral
-> world ray -> robust triangulation -> 3D door corners (raw 4 points).

상세 설계는 MD_files/door_corner_estimation_plan.md 참조.
"""
