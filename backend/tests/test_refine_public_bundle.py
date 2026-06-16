def test_refined_bundle_uses_optional_auth(required_env) -> None:
    from app.api import refine
    from app.core.security import get_current_user_optional

    route = next(
        route
        for route in refine.router.routes
        if getattr(route, "path", None) == "/refine/refined-bundle"
    )

    dependency_calls = [dependency.call for dependency in route.dependant.dependencies]
    assert get_current_user_optional in dependency_calls
