# Deploying the HT Global website (OCI VM)

The site runs as the container `ht-global-web` behind the existing Caddy (`platform-caddy-1`) at https://htglobal.vantegrateos.com. It is public but `noindex`, with per-IP rate limits. Pushes to `main` deploy through GitHub Actions.

## One-time server bootstrap

1. DNS: add an A record `htglobal.vantegrateos.com` -> `<vm-ip>` (the NS are at Hostinger).
2. Folders: `mkdir -p /home/ubuntu/ht-global/{repo,secrets}`.
3. Deploy key: create an SSH key pair on the VM, add the public key as a **read-only deploy key** on the private GitHub repo, then `git clone git@github.com:<owner>/<repo>.git /home/ubuntu/ht-global/repo`.
4. Secrets: copy `server.key` and `config.json` (JWT integration user, see `.secrets/ht-global-n8n/`) into `/home/ubuntu/ht-global/secrets`, then `chmod 700 secrets && chmod 600 secrets/*`. The container runs as uid 1000 (`node`). On the OCI VM `ubuntu` is uid **1001**, so the secrets must be `sudo chown 1000:1000 secrets secrets/*` (keep 700/600). After that `ubuntu` can no longer list the folder; use `sudo` to inspect it.
5. Env: copy `deploy/web.env.example` to `/home/ubuntu/ht-global/web.env`, fill in the real `N8N_AGENT_WEBHOOK_URL` and `N8N_AGENT_SECRET` (only these two lines are required; the rate limits have defaults), `chmod 600`.
   First deploy without GitHub: `git archive --format=tar HEAD | ssh ubuntu@<vm-ip> 'mkdir -p ~/ht-global/repo && tar -x -C ~/ht-global/repo'` (tracked files only; the commit goes in `repo/DEPLOYED_COMMIT`), then `cd ~/ht-global/repo && docker compose -f deploy/docker-compose.yml up -d --build`. `deploy.sh` needs a git checkout (`git fetch`/`reset`), so it does not work on the archive copy. To switch to CI later, move `repo` aside (`mv repo repo.archive`) and `git clone` into `repo`; `secrets` and `web.env` live outside it.
6. First start (from a git clone): `/home/ubuntu/ht-global/repo/deploy/deploy.sh`.
7. Caddy: append `deploy/Caddyfile.snippet` to `/opt/platform/Caddyfile` after a timestamped backup, then validate and reload (commands are in the snippet header). The existing file has no trailing newline: start the appended text with a blank line. Backup used on the first deploy: `/opt/platform/Caddyfile.bak-pre-htglobal-20261111-212258`.
8. Check: `curl -i https://htglobal.vantegrateos.com/api/health` -> `200 {"ok":true}`.

## SSH keys

Two separate keys, each with the least privilege it needs.

- **Deploy key (VM -> GitHub, read-only).** `~/.ssh/ht-global-deploy` on the VM, ssh alias `github-ht-global` in `~/.ssh/config` (`IdentitiesOnly yes`). Its public key is a **read-only** deploy key on the repo (title `oci demo-vantegrateapp (read-only)`). The clone uses `git@github-ht-global:hat-y/ht-global-demo.git`. The github.com ed25519 host key was checked against GitHub's published fingerprint `SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU`.
- **CI key (GitHub Actions / you -> VM, forced command).** The private key is `.secrets/ht-global-ci/id_ed25519` (gitignored) and the repo secret `VM_SSH_KEY`. On the VM its line in `~ubuntu/.ssh/authorized_keys` is restricted to `command="/home/ubuntu/ht-global/repo/deploy/deploy.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty`. Whatever command the client sends, only `deploy.sh` runs; there is no shell.

### Rotate

- **Deploy key:** on the VM `ssh-keygen -t ed25519 -N "" -f ~/.ssh/ht-global-deploy` (replace the old file), then `gh repo deploy-key delete <id> -R hat-y/ht-global-demo` for the old one and `gh repo deploy-key add ~/.ssh/ht-global-deploy.pub -R hat-y/ht-global-demo --title "oci demo-vantegrateapp (read-only)"` (no `--allow-write`). Check with `git -C ~/ht-global/repo ls-remote origin`.
- **CI key:** generate a new pair in `.secrets/ht-global-ci/`, back up `~/.ssh/authorized_keys`, replace only the `ht-global-ci` line (keep the same forced-command options), then `gh secret set VM_SSH_KEY -R hat-y/ht-global-demo < .secrets/ht-global-ci/id_ed25519`. Never `echo` the private key.

## GitHub secrets (repo settings)

- `VM_HOST`: `<vm-ip>`
- `VM_SSH_KEY`: the CI private key above (not the personal VM admin key `~/.ssh/oci-demovantegrate`).

Actions needs the GitHub account's Actions/billing to work. If a run ends in `startup_failure` before any job starts, the account cannot run Actions (other private repos of the account fail the same way); fix it in the account's billing/Actions settings, not in the workflow.

## Deploy

- Automatic: push to `main` touching `website/**`, `deploy/**` or the workflow. Tests run first, then the VM deploy, then a health smoke test.
- Manual: Actions tab -> "Deploy HT Global website" -> Run workflow, or from this machine: `ssh -i .secrets/ht-global-ci/id_ed25519 ubuntu@<vm-ip> deploy` (any command runs `deploy.sh`), or on the VM run `/home/ubuntu/ht-global/repo/deploy/deploy.sh`.

## Roll back

The script keeps the previous image as `ht-global-web:previous`:

```bash
docker tag ht-global-web:previous ht-global-web:latest
docker compose -f /home/ubuntu/ht-global/repo/deploy/docker-compose.yml up -d --no-build
```

The next deploy from `main` overwrites the rollback, so revert the commit on `main` as well.

## Rotate secrets

- **n8n webhook secret:** change the secret in the n8n workflow, update `N8N_AGENT_SECRET` in `/home/ubuntu/ht-global/web.env`, then `docker compose -f deploy/docker-compose.yml up -d --force-recreate`.
- **JWT certificate:** create a new key/cert, upload the cert to the External Client App in Salesforce, replace `secrets/server.key`, keep modes 600/700, then `docker restart ht-global-web`. The key is read on the next token request (sessions are cached for 10 min).

## Placeholders

`<vm-ip>` is the VM address. The External Client App files in `ht-demo` (`externalClientApps/*.eca-meta.xml` and `extlClntAppGlobalOauthSets/*`) hold placeholder values (`admin@example.com`, `https://n8n.example.com/oauth/callback`); the org keeps its real values, so do not deploy those two files.

`ht-demo/main/default/customMetadata/ConversationBrand.Default.md-meta.xml` has `__HT_LOGO_PUBLIC_URL__` in `LogoUrl__c`. The org keeps its real value, which is the public ContentDistribution link of the HT logo. Replace the placeholder with that link before you deploy the file, or leave the file out of the deploy. Otherwise the console logo breaks.

## File uploads (RFQ drawings, stack-ups, Gerbers)

- Endpoint: `POST /api/quote/files?conversationId=..&quoteId=..` (raw body, `Content-Type: application/octet-stream`, `X-File-Name` URL-encoded). The pair is verified in Salesforce before anything is stored; allowlist pdf, doc, docx, xls, xlsx, csv, jpg, jpeg, png, zip, gbr, tgz; magic bytes must match; 5 MB per file; 10 uploads per IP per 10 min; at most 2 in flight (memory). Files land as Salesforce Files on the Quote (FirstPublishLocationId), plus a customer message `📎 Attached: <name> (<size>)` and, for zip/gbr/tgz, `Quote.PCB_Gerbers_Received__c = true`.
- Limits are env-tunable (`deploy/web.env.example`: `RATE_UPLOAD_*`, `UPLOAD_MAX_*`, `UPLOAD_IDLE_TIMEOUT_SEC`). A body idle for 30 s gets a generic 408 and frees its slot; the server also sets requestTimeout 120 s, headersTimeout 30 s, keepAliveTimeout 5 s. If the file is stored but the conversation message cannot be written, the answer is 200 `{success:true, stored:true, messageLogged:false}` (log `upload_without_message`, agent not notified) so a retry does not duplicate the file. `POST /api/quote` accepts `filesPending:true` (no `rfq_created` notification; the last upload notifies, `more=1` on the others). The container memory limit is 384m.
- Caddy needs nothing extra: it has no default request body limit (do not add `request_body max_size` below 25MB).
- Not scanned for malware: files are stored as-is in Salesforce (the integration user owns them); the team opens them from the Quote's Files.
- Logs: one JSON line per stored upload (`file_uploaded`: name, size, type, quote id; never the content).
