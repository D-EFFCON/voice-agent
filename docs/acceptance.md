# Acceptance checklists

Dated, owner-run checks against real accounts. The build stages never block on these; they record what a real deploy showed.

## 1. Hello deploy from a fresh Railway account (scaffold)

Owner action. Proves the pipeline end to end: GitHub, Railway's native Node build (no Dockerfile), a running placeholder that answers `/health`.

| Step                                               | Expected                                                                                                                                                        | Result |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Date and account                                   | A Railway account with no earlier projects                                                                                                                      |        |
| New project from the GitHub repo, branch `release` | Railway lists the branch and starts a build                                                                                                                     |        |
| Build log                                          | Railpack; Node 24.x picked from `engines.node`; pnpm 11.x picked from `packageManager`; `pnpm install`, `pnpm build`, start command `pnpm start`; no Dockerfile |        |
| Settings, Networking, generate a domain            | `RAILWAY_PUBLIC_DOMAIN` appears in the service variables                                                                                                        |        |
| Open `https://<domain>/`                           | The placeholder text                                                                                                                                            |        |
| Open `https://<domain>/health`                     | HTTP 200, `"ready": false`, `"commit"` equal to the deployed SHA                                                                                                |        |
| Deploy log                                         | One JSON line with `"event":"server.listening"` and the port                                                                                                    |        |
| Redeploy from the Railway menu                     | The old instance stops cleanly (a `server.draining` line, then `server.stopped`, no crash) and the new one answers `/health`                                    |        |
| Outcome                                            | pass or fail, plus notes                                                                                                                                        |        |

### Q9 record: Railway templates and the `release` branch

Read from the Railway docs on 2026-09-09 during the scaffold. Confirm each point on the account above and correct this record.

- Branch: the template composer takes the source as a GitHub URL and accepts a branch in it (`https://github.com/<owner>/<repo>/tree/release`). Confirm the composer shows `release` and that a service deployed from the template shows `release` as its branch.
- Attachment: a service deployed from a template is attached to and deploys directly from the template repository, so non-ejected deployers run the owner's repo. Confirm the service settings show the upstream repo.
- Eject: service settings, Source, Upstream Repo, Eject creates the deployer's own copy of the repository. Confirm the wording for the README's eject-to-own-repo section.
- Updates: the docs say services are not redeployed automatically; Railway checks for upstream changes when the deployer visits the project and offers the update, and the deployer applies it when ready (on an ejected copy this arrives as a pull request). The same docs say updates are triggered by merges to "the root branch (main or master)". Check which branch drives it for a template that tracks `release`: push a harmless commit to `main` only and confirm the deployed service neither redeploys nor gets an update offer; then push to `release` and confirm the offer appears. If `main` drives the offer, keep `main` equal to `release` at all times (develop on feature branches, merge to `main` only at release time) and say so in the README.
- Template variables: confirm `${{secret(32)}}` generates `WS_SECRET` and `STATUS_TOKEN`, and that HTTP public networking is on so `RAILWAY_PUBLIC_DOMAIN` exists at first boot (blueprint Q19).
