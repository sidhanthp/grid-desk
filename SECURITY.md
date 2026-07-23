# Security

## Reporting a vulnerability

Please report security issues privately through this repository's GitHub Security Advisory page. Do not open a public issue for suspected credential exposure or authentication vulnerabilities.

## Credential handling

This repository must never contain Con Edison credentials, MFA seeds or codes, database URLs, bearer tokens, cookies, or generated environment files. Production secrets belong in Railway service variables and must only be attached to the collector service.

Before publishing a change, run a secret scanner over the working tree and Git history in addition to the normal test suites.
