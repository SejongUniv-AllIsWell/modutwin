import pytest

from app.services.metadata_options import (
    INT32_MAX,
    MAX_MODULE_RANGE_SIZE,
    parse_module_name_input,
    validate_floor_number,
)


def test_validate_floor_number_allows_negative_and_positive_int32_values() -> None:
    assert validate_floor_number(-1) == -1
    assert validate_floor_number(1) == 1
    assert validate_floor_number(INT32_MAX) == INT32_MAX


def test_validate_floor_number_rejects_zero() -> None:
    with pytest.raises(ValueError, match="0층"):
        validate_floor_number(0)


def test_parse_module_name_input_keeps_plain_string() -> None:
    assert parse_module_name_input("A-101") == ["A-101"]


def test_parse_module_name_input_expands_numeric_range() -> None:
    assert parse_module_name_input("0~3") == ["0", "1", "2", "3"]


def test_parse_module_name_input_rejects_large_batch() -> None:
    with pytest.raises(ValueError, match=str(MAX_MODULE_RANGE_SIZE)):
        parse_module_name_input(f"0~{MAX_MODULE_RANGE_SIZE}")
