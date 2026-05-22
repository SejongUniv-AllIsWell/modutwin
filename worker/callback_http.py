import requests


def post_json(url: str, payload: dict, headers: dict[str, str], timeout: int) -> requests.Response:
    response = requests.post(url, json=payload, headers=headers, timeout=timeout)
    if response.status_code >= 400:
        raise RuntimeError(f"HTTP {response.status_code} body={response.text[:300]}")
    return response
