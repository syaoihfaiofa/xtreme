import os
from typing import Dict, Mapping, Optional, cast

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from keypoint_lifted.service import RecognitionService


def _error(message: str, status_code: int) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"code": "ERROR", "message": message, "data": []},
    )


def create_app(service: Optional[RecognitionService] = None) -> FastAPI:
    application = FastAPI(title="Xtreme keypoint-lifted detection")
    application.state.recognition_service = service

    def recognition_service() -> RecognitionService:
        configured_service = application.state.recognition_service
        if configured_service is None:
            configured_service = RecognitionService.from_env()
            application.state.recognition_service = configured_service
        return cast(RecognitionService, configured_service)

    @application.get("/health")
    def health() -> Dict[str, object]:
        return recognition_service().health()

    @application.post("/image/keypoint-lifted/recognition")
    async def recognition(request: Request) -> JSONResponse:
        try:
            body = await request.json()
        except ValueError:
            return _error("request body must contain valid JSON", 400)
        if not isinstance(body, Mapping):
            return _error("request body must be a JSON object", 400)
        datas = body.get("datas")
        if not isinstance(datas, list) or not datas:
            return _error("datas must be a non-empty array", 400)

        results = []
        configured_service = await run_in_threadpool(recognition_service)
        for frame in datas:
            if not isinstance(frame, Mapping):
                results.append(
                    {
                        "id": None,
                        "code": "ERROR",
                        "message": "each datas item must be a JSON object, got {!r}".format(
                            frame
                        ),
                        "objects": [],
                        "rejections": [],
                    }
                )
                continue
            results.append(
                await run_in_threadpool(configured_service.recognize, frame)
            )
        return JSONResponse(
            content={"code": "OK", "message": "", "data": results}
        )

    return application


app = create_app()


if __name__ == "__main__":
    uvicorn.run(
        "app:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "5000")),
    )
