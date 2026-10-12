#!/usr/bin/env bash
# Build and deploy VibeScore to Azure Container Apps. Safe to run again.
set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-vibescore-rg}"
LOCATION="${LOCATION:-eastus2}"
APP_NAME="${APP_NAME:-vibescore}"
ENVIRONMENT_NAME="${ENVIRONMENT_NAME:-vibescore-env}"
FOUNDRY_RESOURCE_GROUP="${FOUNDRY_RESOURCE_GROUP:-rg-im-demo}"
FOUNDRY_ACCOUNT="${FOUNDRY_ACCOUNT:-foundry-demo-ms}"
AI_MODEL="${AI_MODEL:-gpt-4.1-mini}"
BLOB_CONTAINER="${BLOB_CONTAINER:-vibescore-data}"

command -v az >/dev/null || { echo "Azure CLI is required." >&2; exit 1; }
az account show --output none

SUBSCRIPTION_ID="$(az account show --query id --output tsv)"
SUFFIX="$(printf '%s' "$SUBSCRIPTION_ID" | tr -d '-' | cut -c1-8)"
ACR_NAME="${ACR_NAME:-vibescore${SUFFIX}acr}"
STORAGE_ACCOUNT="${STORAGE_ACCOUNT:-vibescore${SUFFIX}data}"
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD)}"
IMAGE="${ACR_NAME}.azurecr.io/vibescore:${IMAGE_TAG}"
ACR_ADMIN_TEMPORARY=0

disable_temporary_acr_admin() {
  if [ "$ACR_ADMIN_TEMPORARY" = 1 ]; then
    az acr update --resource-group "$RESOURCE_GROUP" --name "$ACR_NAME" \
      --admin-enabled false --output none || true
  fi
}
trap disable_temporary_acr_admin EXIT

for provider in Microsoft.App Microsoft.ContainerRegistry Microsoft.OperationalInsights Microsoft.Storage; do
  az provider register --namespace "$provider" --wait --output none
done

az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none

if ! az storage account show --resource-group "$RESOURCE_GROUP" --name "$STORAGE_ACCOUNT" --output none 2>/dev/null; then
  az storage account create --resource-group "$RESOURCE_GROUP" --name "$STORAGE_ACCOUNT" \
    --location "$LOCATION" --sku Standard_LRS --kind StorageV2 --min-tls-version TLS1_2 \
    --allow-blob-public-access false --output none
fi
STORAGE_KEY="$(az storage account keys list --resource-group "$RESOURCE_GROUP" --account-name "$STORAGE_ACCOUNT" --query '[0].value' --output tsv)"
az storage container create --account-name "$STORAGE_ACCOUNT" --account-key "$STORAGE_KEY" \
  --name "$BLOB_CONTAINER" --public-access off --output none
unset STORAGE_KEY

if ! az acr show --resource-group "$RESOURCE_GROUP" --name "$ACR_NAME" --output none 2>/dev/null; then
  az acr create --resource-group "$RESOURCE_GROUP" --name "$ACR_NAME" --location "$LOCATION" \
    --sku Basic --admin-enabled false --output none
fi

if ! az containerapp env show --resource-group "$RESOURCE_GROUP" --name "$ENVIRONMENT_NAME" --output none 2>/dev/null; then
  az containerapp env create --resource-group "$RESOURCE_GROUP" --name "$ENVIRONMENT_NAME" \
    --location "$LOCATION" --enable-workload-profiles false --output none
fi
for attempt in $(seq 1 80); do
  ENVIRONMENT_STATE="$(az containerapp env show --resource-group "$RESOURCE_GROUP" \
    --name "$ENVIRONMENT_NAME" --query properties.provisioningState --output tsv)"
  case "$ENVIRONMENT_STATE" in
    Succeeded) break ;;
    Failed|Canceled) echo "Container Apps environment entered ${ENVIRONMENT_STATE}." >&2; exit 1 ;;
  esac
  if [ "$attempt" = 80 ]; then
    echo "Timed out waiting for the Container Apps environment." >&2
    exit 1
  fi
  sleep 15
done

az acr build --registry "$ACR_NAME" --image "vibescore:${IMAGE_TAG}" . --output none

FOUNDRY_ENDPOINT="$(az cognitiveservices account show --resource-group "$FOUNDRY_RESOURCE_GROUP" \
  --name "$FOUNDRY_ACCOUNT" --query 'properties.endpoints."OpenAI Language Model Instance API"' --output tsv)"
FOUNDRY_KEY="$(az cognitiveservices account keys list --resource-group "$FOUNDRY_RESOURCE_GROUP" \
  --name "$FOUNDRY_ACCOUNT" --query key1 --output tsv)"
AI_ENDPOINT="${FOUNDRY_ENDPOINT%/}/openai/v1/chat/completions"

if ! az containerapp show --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" --output none 2>/dev/null; then
  # Bootstrap with temporary registry credentials; after the identity exists we
  # switch the app to managed-identity image pulls and disable the admin user.
  az acr update --resource-group "$RESOURCE_GROUP" --name "$ACR_NAME" --admin-enabled true --output none
  ACR_ADMIN_TEMPORARY=1
  ACR_USER="$(az acr credential show --resource-group "$RESOURCE_GROUP" --name "$ACR_NAME" --query username --output tsv)"
  ACR_PASSWORD="$(az acr credential show --resource-group "$RESOURCE_GROUP" --name "$ACR_NAME" --query 'passwords[0].value' --output tsv)"
  CLINIC_SECRET="$(openssl rand -hex 32)"
  az containerapp create --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" \
    --environment "$ENVIRONMENT_NAME" --image "$IMAGE" --registry-server "${ACR_NAME}.azurecr.io" \
    --registry-username "$ACR_USER" --registry-password "$ACR_PASSWORD" --system-assigned \
    --ingress external --target-port 8787 --transport auto --revisions-mode single \
    --cpu 0.5 --memory 1.0Gi --min-replicas 0 --max-replicas 1 \
    --secrets "foundry-api-key=${FOUNDRY_KEY}" "clinic-pseudonym-secret=${CLINIC_SECRET}" \
    --env-vars NODE_ENV=production PORT=8787 VIBESCORE_DATA_DIR=/data TRUST_PROXY=1 \
      AI_PROVIDER=foundry AI_MODEL="$AI_MODEL" AI_ENDPOINT="$AI_ENDPOINT" AI_API_KEY=secretref:foundry-api-key \
      CLINIC_PSEUDONYM_SECRET=secretref:clinic-pseudonym-secret \
    --output none
  unset ACR_USER ACR_PASSWORD CLINIC_SECRET
else
  az containerapp secret set --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" \
    --secrets "foundry-api-key=${FOUNDRY_KEY}" --output none
fi
unset FOUNDRY_KEY

PRINCIPAL_ID="$(az containerapp identity show --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" \
  --query principalId --output tsv)"
STORAGE_ID="$(az storage account show --resource-group "$RESOURCE_GROUP" --name "$STORAGE_ACCOUNT" --query id --output tsv)"
ACR_ID="$(az acr show --resource-group "$RESOURCE_GROUP" --name "$ACR_NAME" --query id --output tsv)"

assign_role() {
  local role="$1" scope="$2"
  if [ "$(az role assignment list --assignee-object-id "$PRINCIPAL_ID" --role "$role" --scope "$scope" --query 'length(@)' --output tsv)" = 0 ]; then
    az role assignment create --assignee-object-id "$PRINCIPAL_ID" --assignee-principal-type ServicePrincipal \
      --role "$role" --scope "$scope" --output none
  fi
}
assign_role "Storage Blob Data Contributor" "$STORAGE_ID"
assign_role "AcrPull" "$ACR_ID"

az containerapp registry set --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" \
  --server "${ACR_NAME}.azurecr.io" --identity system --output none
az acr update --resource-group "$RESOURCE_GROUP" --name "$ACR_NAME" --admin-enabled false --output none
ACR_ADMIN_TEMPORARY=0

FQDN="$(az containerapp show --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" \
  --query properties.configuration.ingress.fqdn --output tsv)"
az containerapp update --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" --image "$IMAGE" \
  --min-replicas 0 --max-replicas 1 \
  --set-env-vars NODE_ENV=production PORT=8787 VIBESCORE_DATA_DIR=/data TRUST_PROXY=1 \
    PUBLIC_ORIGIN="https://${FQDN}" AI_PROVIDER=foundry AI_MODEL="$AI_MODEL" AI_ENDPOINT="$AI_ENDPOINT" \
    AI_API_KEY=secretref:foundry-api-key CLINIC_PSEUDONYM_SECRET=secretref:clinic-pseudonym-secret \
    LITESTREAM_AZURE_ACCOUNT_NAME="$STORAGE_ACCOUNT" \
    LITESTREAM_AZURE_CONTAINER="$BLOB_CONTAINER" \
  --output none

printf 'Deployed VibeScore: https://%s\n' "$FQDN"
