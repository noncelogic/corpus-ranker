# Security policy — corpus-ranker

## Reporting a vulnerability

**Do not open a public issue for a security problem.** A public issue is a
public disclosure, and it will be closed and removed.

Report privately, either way:

1. **GitHub private vulnerability reporting** — the repository's
   **Security** tab → **Report a vulnerability**. This keeps the report
   visible only to you and the maintainer.
2. **Email** — jg@noncelogic.com, with `corpus-ranker security` in the subject.

Include what you found, where (file, function, commit), and how to reproduce
it if you can. Proof-of-concept detail helps; please don't test against
anyone's live systems or data beyond the minimum needed to confirm the issue.

## What to expect

This is a one-person project. Reports are read and acted on, but there is no
support team and no guaranteed response time. Best effort is the honest
offer: genuine reports get genuine attention, in severity order. Please
allow reasonable time for a fix before any public disclosure.

## Scope

In scope: the code and configuration in this repository, its CI and review
infrastructure, and anything that could compromise the owner's estate through
this repo (for example, a workflow weakness that would let untrusted code
reach self-hosted runners or credentials).

Out of scope: vulnerabilities in third-party services this project merely
talks about (GitHub, model providers) — report those to their owners.

## A note on credentials in the open

If you ever see what looks like a real secret committed here, treat it as
compromised and report it privately using the channels above. Do not quote
it in any public place.
