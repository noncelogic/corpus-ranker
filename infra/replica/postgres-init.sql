-- Runs once, on first boot of an empty data volume, as the superuser,
-- inside the ranker database (POSTGRES_DB). Mirrors the deployed shape:
-- one database per system, with pgvector enabled in it (TECH-STACK §2, §3).
CREATE EXTENSION IF NOT EXISTS vector;
