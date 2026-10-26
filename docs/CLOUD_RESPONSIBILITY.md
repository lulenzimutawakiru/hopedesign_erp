# Shared responsibility

Hope Design ERP is operated as a self-hosted Docker stack on a VPS. Caddy terminates TLS. Postgres and Redis stay on the private Compose network. The host firewall allows 80, 443 and the SSH port named in the hardening script.

Hope Design is responsible for the application, the database role, the tenant policies, the host firewall and the backups taken by the deploy kit.

A connected service is responsible for its own platform. That includes the mail provider, the bank notification services, the tax authority gateway and the object store if one is configured. Credentials for those services are encrypted in company configuration. The contract for each service is a supplier-service review in the ISO operating records, with a date when it was last reviewed.

The VPS provider is responsible for the physical host, the power and the network up to the machine. That review is an ISO operating record of type `supplier_service_review`. It is not assumed by this document.
