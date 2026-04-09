"""
COLMAP sparse point cloud에서 방의 경계면(6개 평면)을 추출한다.

흐름:
    COLMAP sparse points (points3D.bin / points3D.txt)
        ↓
    바닥/천장: normal ≈ (0, ±1, 0) 인 수평 평면 RANSAC 추출
    벽 4개:   normal ≈ 수평 방향인 수직 평면 RANSAC 추출
        ↓
    6개 평면으로 방의 bounding box 정의

TODO:
- COLMAP points3D 파일 로더 구현 (.bin / .txt 포맷)
- 수평/수직 평면 분리 후 RANSAC으로 dominant plane 추출
- 바닥/천장이 텍스처 없어서 COLMAP 포인트 희박할 경우 fallback 처리
- 추출된 6개 평면을 반환하는 인터페이스 설계
"""
