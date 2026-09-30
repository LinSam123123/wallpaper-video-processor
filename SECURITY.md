# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.4.x | Yes |
| Earlier versions | No |

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on the repository Security tab. Do not open a public Issue for a suspected vulnerability and do not attach private videos, unredacted local paths, tokens, or credentials.

Include the affected version, impact, minimal reproduction steps, and any suggested mitigation. You should receive an acknowledgement within seven days. Public disclosure should wait until a fix or mitigation is available.

## Dependency downloads

The application only offers external artifacts declared in `resources/dependencies.json`. Each entry pins a version, HTTPS download URL, license, expected executable paths, and SHA-256 digest. A download requires explicit user action and is rejected if the digest does not match.
