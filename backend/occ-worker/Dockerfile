FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY xtreme_occ ./xtreme_occ
COPY tests ./tests

ENV PYTHONPATH=/app

CMD ["python", "-m", "xtreme_occ.worker"]
