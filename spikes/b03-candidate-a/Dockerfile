# PostgreSQL 17 + PGroonga 3.2.5 (the version the hosted Supabase project offers)
# + pgvector from the PGDG repository.
ARG PGROONGA_TAG=3.2.5-debian-17
FROM groonga/pgroonga:${PGROONGA_TAG}
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-17-pgvector && rm -rf /var/lib/apt/lists/*
