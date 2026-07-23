FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
WORKDIR /app
COPY pyproject.toml ./
COPY coned_collector ./coned_collector
RUN pip install --no-cache-dir .
RUN useradd --create-home --uid 10001 collector
USER collector
EXPOSE 8001
CMD ["uvicorn", "coned_collector.main:app", "--host", "0.0.0.0", "--port", "8001"]
