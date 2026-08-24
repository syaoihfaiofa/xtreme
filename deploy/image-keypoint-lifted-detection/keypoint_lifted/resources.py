from typing import Mapping

import cv2
import numpy as np
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


class HTTPResources:
    def __init__(self, timeout: float) -> None:
        if timeout <= 0.0:
            raise ValueError("timeout must be positive, got {!r}".format(timeout))
        self._timeout = timeout
        self._session = requests.Session()
        retry = Retry(
            total=3,
            backoff_factor=0.5,
            status_forcelist=(429, 500, 502, 503, 504),
            allowed_methods=frozenset(("GET",)),
        )
        self._session.mount("http://", HTTPAdapter(max_retries=retry))
        self._session.mount("https://", HTTPAdapter(max_retries=retry))

    def _get(self, url: str) -> requests.Response:
        if not isinstance(url, str) or not url:
            raise ValueError("resource URL must be a non-empty string, got {!r}".format(url))
        try:
            response = self._session.get(url, timeout=self._timeout)
        except requests.RequestException as error:
            raise ValueError(
                "GET {!r} failed after 3 retries with timeout={}: {}".format(
                    url, self._timeout, error
                )
            ) from error
        try:
            response.raise_for_status()
        except requests.HTTPError as error:
            raise ValueError(
                "GET {!r} failed with status {}: {}".format(
                    url, response.status_code, response.text[:500]
                )
            ) from error
        return response

    def load_json(self, url: str) -> object:
        response = self._get(url)
        try:
            payload = response.json()
        except ValueError as error:
            raise ValueError("GET {!r} returned invalid JSON".format(url)) from error
        if not isinstance(payload, (Mapping, list)):
            raise ValueError("GET {!r} must return a JSON object or array".format(url))
        return payload

    def load_image(self, url: str) -> np.ndarray:
        response = self._get(url)
        encoded = np.frombuffer(response.content, dtype=np.uint8)
        try:
            image = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
        except cv2.error as error:
            raise ValueError(
                "GET {!r} image decode failed: {}".format(url, error)
            ) from error
        if image is None:
            raise ValueError("GET {!r} returned invalid image bytes".format(url))
        return image
