from typing import Any


def is_admin_user(user: Any) -> bool:
    role = getattr(user, "role", None)
    role_value = getattr(role, "value", role)
    return role_value == "admin"


def can_read_scene(
    user: Any,
    scene: Any,
    module: Any,
    floor: Any,
    building: Any,
) -> bool:
    if is_admin_user(user):
        return True
    if getattr(scene, "user_id", None) == getattr(user, "id", None):
        return True
    return bool(
        getattr(scene, "is_aligned", False)
        and getattr(module, "is_visible", False)
        and getattr(floor, "is_visible", False)
        and getattr(building, "is_visible", False)
    )


def can_write_scene_door_position(user: Any, scene: Any, module: Any) -> bool:
    if is_admin_user(user):
        return True
    user_id = getattr(user, "id", None)
    return (
        getattr(scene, "user_id", None) == user_id
        and getattr(module, "user_id", None) == user_id
    )
