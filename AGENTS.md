# Repository guidance

## Development and deployment

- Do not install dependencies or run dependency installation commands in the local Windows workspace. Local read-only inspection and tests using already available tools are fine.
- Install dependencies and build the application on the test host: dq@172.20.30.201 over SSH port 1204.
- The deployment checkout is /home/dq/work/standard-implementation-supervision.
- The application is exposed on host port 17006. Do not use 17005; that port belongs to another service on the test host.
- After implementing a user-requested application change, deploy it to the test host and verify the container and health endpoint unless the user explicitly says not to deploy.
- Preserve the test host's .env, PostgreSQL data volume, and other persistent data. Never run docker compose down -v, delete volumes, or otherwise reset test data as part of routine deployment.
- Prefer rebuilding and replacing only the application service; avoid restarting unrelated Compose projects or services.
- Keep reference-docs/ local and excluded from Git and Docker build contexts.
