#!/bin/bash
# Script de despliegue para el ETL de ObraClara en GCP

# ==========================================
# VARIABLES DE CONFIGURACIÓN
# Cambia 'TU_PROJECT_ID' por el ID real de tu proyecto en GCP
PROJECT_ID="TU_PROJECT_ID"
BUCKET_NAME="obraclara-datasets"
REGION="us-central1"
# ==========================================

echo "1. Habilitando APIs necesarias..."
gcloud services enable run.googleapis.com cloudbuild.googleapis.com cloudscheduler.googleapis.com --project=$PROJECT_ID

echo "2. Creando el bucket de almacenamiento (si no existe)..."
gsutil mb -p $PROJECT_ID -l $REGION gs://$BUCKET_NAME 2>/dev/null || echo "El bucket ya existe."

echo "3. Construyendo y subiendo la imagen de Docker a Artifact Registry..."
gcloud builds submit --tag gcr.io/$PROJECT_ID/etl-infobras --project=$PROJECT_ID

echo "4. Creando el Cloud Run Job..."
gcloud beta run jobs create etl-infobras-job \
  --image gcr.io/$PROJECT_ID/etl-infobras \
  --set-env-vars BUCKET_NAME=$BUCKET_NAME \
  --region $REGION \
  --project $PROJECT_ID

echo "5. Creando el Trigger en Cloud Scheduler (Se ejecuta a las 3:00 AM hora local)..."
# Obtiene el email de la cuenta de servicio por defecto de Compute Engine
SERVICE_ACCOUNT=$(gcloud iam service-accounts list --project=$PROJECT_ID --filter="name:compute@developer.gserviceaccount.com" --format="value(email)")

gcloud scheduler jobs create http etl-diario \
  --location $REGION \
  --schedule "0 3 * * *" \
  --time-zone "America/Lima" \
  --uri "https://$REGION-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/$PROJECT_ID/jobs/etl-infobras-job:run" \
  --http-method POST \
  --oauth-service-account-email=$SERVICE_ACCOUNT \
  --project $PROJECT_ID

echo "¡Despliegue finalizado!"
echo "Puedes probar la ejecución manualmente desde la consola de Cloud Run, o ejecutando:"
echo "gcloud beta run jobs execute etl-infobras-job --region $REGION --project $PROJECT_ID"
