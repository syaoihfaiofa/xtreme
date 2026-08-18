import os

bind = '0.0.0.0:5000'
workers = int(os.environ.get('GUNICORN_WORKERS', '1'))
threads = int(os.environ.get('GUNICORN_THREADS', '1'))
timeout = int(os.environ.get('GUNICORN_TIMEOUT', '300'))
