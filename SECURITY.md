# Security Policy

## Scope

Labelfaster is a local, browser-only workspace. It has no server, no account
system and no telemetry: datasets are loaded from the machine that serves them,
annotation documents are stored in the browser's IndexedDB, and UI preferences
use `localStorage`. Anything you open in the browser stays in that browser
profile unless you export it yourself.

The supported surface is therefore the rendering and editing code in
`packages/core` and `apps/web-ui`, plus the offline Python tools in `tools/py`
that read local dataset files.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub Security
Advisories rather than a public issue:

https://github.com/k7/labelfaster/security/advisories/new

If that page is unavailable, open a regular issue that describes the impact
without a working exploit, and ask for a private channel.

Useful details to include:

- affected commit or released version, and platform (browser, OS);
- the dataset kind and frame involved, if the report needs real data;
- reproduction steps and the observed versus expected behaviour;
- whether the issue exposes data, corrupts a stored annotation document, or
  only affects rendering.

## Response

This is a volunteer-maintained project, so there is no guaranteed response
time. Reports are triaged in the order they arrive; the reporter is credited in
the advisory unless anonymity is requested. Fixes land on `main` and are
credited in the release notes of the next tag.

Please do not include third-party datasets, private recordings or annotation
documents in a report.

## Out of scope

- Vulnerabilities in browser or GPU drivers.
- Vulnerabilities in third-party dependencies that have no reachable path
  through this repository's code.
- Data corruption caused by deliberately editing files outside the documented
  formats, or by clearing browser storage.
- Denial of service caused by malformed or oversized input datasets that the
  tools are not documented to accept.
