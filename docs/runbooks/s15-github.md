# S15 GitHub connection

Connect GitHub to an S15 installation from the Web UI only. You never edit a file or use a terminal for this ([GIT15-04 #385](https://github.com/chayapats/jit/issues/385), [ADR 0073](../adr/0073-s15-first-standing-policy-and-web-github-connection.md)). This applies when the configuration has `github: null`, which is what `install.sh --s15` writes. An installation with an explicit `github` configuration keeps that path, and the Web page then says the connection is not available here.

## 1. Create a fine-grained token on GitHub

Open <https://github.com/settings/personal-access-tokens/new>:

- **Repository access:** "Only select repositories". Choose the repositories Jit should work on, for example `chayapats/jit-s15-sandbox`.
- **Repository permissions**, exactly:
  - Contents: Read and write
  - Issues: Read-only
  - Pull requests: Read and write
  - Checks: Read-only
  - Commit statuses: Read-only
  - Administration: Read-only (Jit reads branch protection; it never changes it)
  - Metadata: Read-only (GitHub always requires it)
- **Expiration:** pick one. Jit shows it and warns you 14 days before it ends.

A classic token (`ghp_…`) is refused, because it reaches more than these permissions.

## 2. Connect

**Manage → GitHub** (`/resources/github`): paste the token and press **Check and connect**.

Jit checks the token with GitHub, read-only: who it belongs to, its expiry and the repositories it can reach. Only after that check does it keep the token. The token is stored only in the installation's protected key store (`ConnectionVault`). It is never shown again, and never placed in the configuration, logs, exports, model prompts or the working computer. A refusal names the reason and the next step:

| Code | What to do |
| --- | --- |
| `github_token_fine_grained_required` | Create a fine-grained token as in step 1 |
| `github_token_invalid` | Copy the whole token again, or create a new one |
| `github_token_forbidden` | Give the token the Metadata permission |
| `github_unreachable` | Check this machine's internet connection and try again |
| `github_verify_failed` | GitHub answered unexpectedly; try again in a minute |

## 3. Choose repositories

Tick the repositories Jit may work on and press **Use the ticked repositories**. Jit refuses work on every other repository, even ones the token can reach. Reading issues and working on code in the working computer is ordinary work. Every push, pull request, review reply and merge still asks you first (the product default). A personal exception is a separate setup on **Standing rules → Personal GitHub profile**.

## 4. Review the updated standing rules

Connecting repositories changes what the installation has, so **Standing rules** (`/rules`) shows "Updated standing rules to review". The rows include the repositories and GitHub as a recipient. One press installs the new revision and makes the repositories team resources. Until you press it, the current rules stay in force and do not cover the new repositories.

Then ask in a conversation, for example "Inspect the GitHub issues in chayapats/jit-s15-sandbox and report readiness only".

## Replace or remove

- **Replace the token:** open "Replace the token" on the same page and paste the new one. Repositories the new token can still reach stay selected.
- **Disconnect:** deletes the token at once and stops new GitHub work. History stays; anything already pushed or merged is not undone. Reconnecting and selecting a repository again gives it a new resource generation, so you review the standing rules again.

## Upgrading an existing installation

An installation created before this release has no `github.sqlite`. The first start of this release creates it once and records it in `runtime/composition.json`, under the same rollback-safe rule as the browser store. A ledger that is listed there but missing still refuses to start, as before.
