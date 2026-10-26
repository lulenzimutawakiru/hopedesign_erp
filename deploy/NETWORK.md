# Production network

Public ports on the production host are 80 and 443. Caddy listens there and terminates TLS. The API is not published on a host port. Postgres and Redis are not published. They are reachable only on the Compose network `hopedesign-erp`.

`deploy/security-hardening.sh` sets UFW to deny incoming traffic and then allows the SSH port, 80 and 443. Development uses `docker-compose.dev.yml`, which is a different Compose project from `docker-compose.prod.yml`.

The application sends a content-security policy and HSTS. Callers are rate-limited. Integration secrets for mail and the banks are encrypted before they are stored. A network-service review, when the company records one, is an ISO operating record of type `network_agreement`.
