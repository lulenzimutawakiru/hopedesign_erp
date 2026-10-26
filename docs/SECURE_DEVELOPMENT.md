# Secure development procedure

This is the procedure a change to Hope Design ERP has to pass. It is the company's own rule. It is not the text of a standard.

## Gates

A change reaches `main` only through the test workflow and the security workflow.

- The test workflow runs the API suite, including authentication, authorization, segregation of duties and tenant isolation.
- The security workflow fails the build on a high or critical production dependency advisory and runs a secret scan.
- Schema change is a numbered migration. Application authorization stays on the server.

## Engineering principles

The API denies a call that has no permission. Business tables are forced through a tenant policy. The runtime database role is not a superuser and cannot bypass row-level security. Integration secrets are encrypted before they are stored. Passwords are hashed. Session tokens are hashed.

## Test data

Production personal data is not copied into a development or test database. Automated tests create the rows they need and remove them. A developer database is the development Compose project, not a restore of production.

## Audit testing

An audit test is non-destructive. A probe that changes a row is reverted before the tester leaves. Production is not the system under a destructive test.

## Environments

Development, test and production are separate Compose projects. The test workflow does not point at the production database.
