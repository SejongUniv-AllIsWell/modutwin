import re


INT32_MAX = 2**31 - 1
INT32_MIN = -INT32_MAX
MAX_MODULE_RANGE_SIZE = 1000

UNSAFE_PATH_PATTERN = re.compile(r"[/\\%?#&\t\r\n\x00]|\.\.")
MODULE_RANGE_PATTERN = re.compile(r"^\s*(\d+)\s*~\s*(\d+)\s*$")


def validate_floor_number(value: int) -> int:
    if value < INT32_MIN or value > INT32_MAX:
        raise ValueError("층수는 32비트 정수 범위 안에서 입력해야 합니다.")
    if value == 0:
        raise ValueError("0층은 사용할 수 없습니다.")
    return value


def validate_module_name(value: str) -> str:
    name = value.strip()
    if not name:
        raise ValueError("모듈 이름을 입력하세요.")
    if len(name) > 255:
        raise ValueError("모듈 이름은 255자를 초과할 수 없습니다.")
    if UNSAFE_PATH_PATTERN.search(name):
        raise ValueError("모듈 이름에 허용되지 않는 문자가 포함되어 있습니다.")
    return name


def parse_module_name_input(value: str) -> list[str]:
    raw = validate_module_name(value)
    range_match = MODULE_RANGE_PATTERN.match(raw)
    if not range_match:
        return [raw]

    start = int(range_match.group(1))
    end = int(range_match.group(2))
    if start > INT32_MAX or end > INT32_MAX:
        raise ValueError("모듈 범위는 0부터 32비트 양의 정수 범위 안에서 입력해야 합니다.")
    if start > end:
        raise ValueError("모듈 범위 시작값은 끝값보다 클 수 없습니다.")
    count = end - start + 1
    if count > MAX_MODULE_RANGE_SIZE:
        raise ValueError(f"모듈 범위는 한 번에 {MAX_MODULE_RANGE_SIZE}개 이하로 추가하세요.")
    return [str(n) for n in range(start, end + 1)]
