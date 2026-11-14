-- Run once by CNPG at bootstrap (Cluster ranker-db, initdb
-- postInitApplicationSQLRefs), as superuser, inside the `ranker` database,
-- after initdb has made ranker_migrator the database owner.
--
-- Role split (TECH-STACK §2):
--   ranker_migrator  owns the database, the public schema and, by running
--                    every migration, every object in it. Not a superuser.
--   ranker_app       NOLOGIN grant role; db/migrations grant it the service's
--                    privileges (append-only on score events). Created here
--                    because the migrator cannot create roles.
--   ranker_service   the API's login role (CNPG managed role), a member of
--                    ranker_app and nothing else.

CREATE ROLE ranker_app NOLOGIN;

-- Nothing for PUBLIC: only the owner and ranker_app's members get in.
ALTER SCHEMA public OWNER TO ranker_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO ranker_app', current_database());
END
$$;
