import os
from celery import Celery

app = Celery('worker')
app.config_from_object({
    'broker_url': os.environ.get('RABBITMQ_URL', 'amqp://guest:guest@localhost:5672//'),
    'result_backend': os.environ.get('REDIS_URL', 'redis://localhost:6379/0'),
    'task_serializer': 'json',
    'result_serializer': 'json',
    'accept_content': ['json'],
    'task_track_started': True,
    'task_acks_late': True,
    'worker_prefetch_multiplier': 1,
    'task_routes': {
        'tasks.training.*': {'queue': 'training'},
        'tasks.alignment.*': {'queue': 'alignment'},
    },
    'task_default_queue': 'training',
})

app.autodiscover_tasks(['tasks'])
