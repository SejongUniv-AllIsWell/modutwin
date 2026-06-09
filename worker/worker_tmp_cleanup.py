import logging
import os
import shutil
import tempfile
import time

logger = logging.getLogger(__name__)

TMP_PREFIXES = ("colmap_", "3dgs_", "gs_", "ffmpeg_", "sog_", "align_")


def cleanup_stale_tmp_dirs() -> int:
    """Remove stale worker temp directories left by hard stops or orphan tasks."""
    tmp_dir = tempfile.gettempdir()
    min_age = float(os.environ.get("WORKER_TMP_CLEANUP_MIN_AGE_SECONDS", "0"))
    now = time.time()
    deleted = 0

    try:
        names = os.listdir(tmp_dir)
    except OSError:
        logger.warning("[tmp_cleanup] cannot list temp dir: %s", tmp_dir, exc_info=True)
        return 0

    for name in names:
        if not name.startswith(TMP_PREFIXES):
            continue
        path = os.path.join(tmp_dir, name)
        if not os.path.isdir(path):
            continue
        try:
            if min_age > 0 and now - os.path.getmtime(path) < min_age:
                continue
            shutil.rmtree(path, ignore_errors=True)
            if not os.path.exists(path):
                deleted += 1
                logger.info("[tmp_cleanup] removed stale worker temp dir: %s", path)
        except Exception:
            logger.warning("[tmp_cleanup] failed to remove temp dir: %s", path, exc_info=True)

    return deleted
