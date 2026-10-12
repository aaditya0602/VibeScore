# Deploying VibeScore on Azure

VibeScore uses two Azure services for different jobs:

- **Microsoft Foundry** runs the AI coach and semantic drill assessment.
- **Azure Container Apps Consumption** runs the Node/Docker web application.

The application keeps its active SQLite database on the container's local disk. Litestream continuously copies that database to a private Azure Blob container and restores it on every cold start. The container app uses managed identity for Blob access, so no storage key is stored in the app.

## Current resources

The deployment script defaults match the Azure for Students subscription used by this repository:

| Resource | Name |
|---|---|
| Resource group | `vibescore-rg` |
| Region | `eastus2` |
| Container Apps environment | `vibescore-env` |
| Container app | `vibescore` |
| Container registry | `vibescoref801edf9acr` |
| Storage account | `vibescoref801edf9data` |
| Blob container | `vibescore-data` |
| Foundry account | `foundry-demo-ms` in `rg-im-demo` |
| Foundry model deployment | `gpt-4.1-mini` |
| Public application | `https://vibescore.jollyrock-e347bbe2.eastus2.azurecontainerapps.io` |

Container Apps Consumption includes a monthly free grant, but the registry, storage, logs, and Foundry inference can consume Azure student credit. Azure AI Foundry provides models and agents; it does not host this website.

## Deploy

Requirements:

- Azure CLI signed in to the intended subscription
- Docker source in this repository
- permission to create role assignments

Run from the repository root:

```sh
./infra/deploy-azure.sh
```

The script is safe to rerun. It:

1. Creates or reuses the resource group, private Blob container, Basic Azure Container Registry, and Consumption Container Apps environment.
2. Builds the current Git commit in Azure Container Registry.
3. Reads the existing Foundry key without printing or writing it to the repository.
4. Stores the Foundry key and a generated clinic pseudonym secret as Container Apps secrets.
5. Gives the app's managed identity `AcrPull` and `Storage Blob Data Contributor` roles.
6. Deploys one app replica with external HTTPS ingress on port `8787`.
7. Configures Litestream to restore and replicate `vibescore.sqlite` through Azure Blob Storage.

Override any default with an environment variable, for example:

```sh
APP_NAME=vibescore-staging AI_MODEL=gpt-4.1-mini ./infra/deploy-azure.sh
```

Do not run more than one replica. SQLite and Litestream require a single writer.

## Verify the release

The script prints the public HTTPS URL. Then run:

```sh
npm run smoke -- https://YOUR-APP.eastus2.azurecontainerapps.io
```

Check the public status without exposing secrets:

```sh
curl -fsS https://YOUR-APP.eastus2.azurecontainerapps.io/api/status
```

Expected signals include `ok: true`, `ai.enabled: true`, provider `foundry`, and model `gpt-4.1-mini`.

The production deployment was verified on October 12, 2026. The verification created a temporary account and interview attempt, restarted the active revision, confirmed that Litestream restored the session from Blob storage, and received a coaching response through the backend from Foundry `gpt-4.1-mini`. The temporary account was deleted after the check.

Inspect startup and Litestream output:

```sh
az containerapp logs show -g vibescore-rg -n vibescore --follow
```

On startup the logs should show a restore attempt followed by `starting app under litestream replicate`. After creating a test account or score, confirm Blob objects exist under the `vibescore/` prefix. Deploy a new revision and verify the data returns after restart; this proves restore as well as backup.

## Set optional integrations

GoDaddy ANS and Databricks remain optional. Add their values as Container Apps secrets, then reference those secrets as environment variables. Never place credentials in Git or in a browser bundle. The relevant variable names are in [.env.example](../.env.example).

After the final hostname or custom domain is stable, prepare the ANS registration:

```sh
npm run ans -- prepare --host YOUR-PUBLIC-HOST
```

## Local production image

```sh
docker build -t vibescore-test .
docker run --rm -p 8787:8787 \
  -e PUBLIC_ORIGIN=http://localhost:8787 \
  vibescore-test
```

Without Azure or S3 Litestream variables, local container data is intentionally ephemeral.

## Render alternative

`render.yaml` and the S3-compatible settings in `.env.example` remain supported. They can deploy the same image to Render with Backblaze B2. Azure is the primary hackathon deployment because it connects directly to the existing Microsoft Foundry resource and keeps hosting, model inference, and backups under the same Azure account.
