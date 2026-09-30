# Dependency manifest

Production packages copy the repository's `resources/dependencies.json` into this directory. The desktop installer accepts the same `schemaVersion: 1`, `platform: "win32-x64"`, `artifacts` schema as the core package, with HTTPS URLs, exact SHA-256 digests, and expected executable paths. No dependency is downloaded when the manifest is absent or invalid.
