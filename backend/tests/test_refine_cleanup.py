from app.api.refine import _refined_cleanup_targets


UPLOAD_KEY = "buildings/b/f/modules/m_mod/gsplat/input.ply"


def test_refined_cleanup_targets_delete_session_for_session_key() -> None:
    scene_key = "buildings/b/f/modules/m_mod/gsplat/refined/s1/final.ply"

    prefixes, keys = _refined_cleanup_targets(UPLOAD_KEY, scene_key, delete_session=True)

    assert prefixes == {"buildings/b/f/modules/m_mod/gsplat/refined/s1"}
    assert keys == set()


def test_refined_cleanup_targets_delete_object_for_legacy_key() -> None:
    scene_key = "buildings/b/f/modules/m_mod/gsplat/refined/1700000000000_final.ply"

    prefixes, keys = _refined_cleanup_targets(UPLOAD_KEY, scene_key, delete_session=True)

    assert prefixes == set()
    assert keys == {scene_key}


def test_refined_cleanup_targets_can_skip_object_delete() -> None:
    scene_key = "buildings/b/f/modules/m_mod/gsplat/refined/1700000000000_final.ply"

    prefixes, keys = _refined_cleanup_targets(
        UPLOAD_KEY,
        scene_key,
        delete_session=False,
        delete_object=False,
    )

    assert prefixes == set()
    assert keys == set()
