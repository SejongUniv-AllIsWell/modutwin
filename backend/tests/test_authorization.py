from types import SimpleNamespace

from app.core.authorization import (
    can_read_scene,
    can_write_scene_door_position,
    is_admin_user,
)


def _ns(**kwargs):
    return SimpleNamespace(**kwargs)


def test_is_admin_user_supports_string_and_enum_like_role() -> None:
    assert is_admin_user(_ns(role="admin")) is True
    assert is_admin_user(_ns(role=_ns(value="admin"))) is True
    assert is_admin_user(_ns(role="user")) is False


def test_can_read_scene_allows_owner_even_when_not_public() -> None:
    user = _ns(id="u-1", role="user")
    scene = _ns(user_id="u-1", is_aligned=False)
    module = _ns(is_visible=False)
    floor = _ns(is_visible=False)
    building = _ns(is_visible=False)

    assert can_read_scene(user, scene, module, floor, building) is True


def test_can_read_scene_allows_visible_aligned_scene_for_non_owner() -> None:
    user = _ns(id="u-2", role="user")
    scene = _ns(user_id="u-1", is_aligned=True)
    module = _ns(is_visible=True)
    floor = _ns(is_visible=True)
    building = _ns(is_visible=True)

    assert can_read_scene(user, scene, module, floor, building) is True


def test_can_read_scene_denies_non_owner_when_visibility_chain_breaks() -> None:
    user = _ns(id="u-2", role="user")
    scene = _ns(user_id="u-1", is_aligned=True)
    module = _ns(is_visible=False)
    floor = _ns(is_visible=True)
    building = _ns(is_visible=True)

    assert can_read_scene(user, scene, module, floor, building) is False


def test_can_write_scene_door_position_allows_admin_and_requires_double_ownership_for_user() -> None:
    scene = _ns(user_id="owner-scene")
    module = _ns(user_id="owner-module")

    admin = _ns(id="someone-else", role="admin")
    assert can_write_scene_door_position(admin, scene, module) is True

    owner = _ns(id="owner-scene", role="user")
    assert can_write_scene_door_position(owner, scene, _ns(user_id="owner-scene")) is True
    assert can_write_scene_door_position(owner, scene, module) is False
