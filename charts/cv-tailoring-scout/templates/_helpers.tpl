{{/*
  Names for the scheduled intake. Mirrors the worker chart's helpers so both workload groups
  label their objects the same way (and `kubectl get pods -l app.kubernetes.io/part-of=...`
  keeps working across the release).
*/}}
{{- define "cv-tailoring-scout.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "cv-tailoring-scout.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "cv-tailoring-scout.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "cv-tailoring-scout.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: cv-tailoring-platform
{{- end -}}

{{- define "cv-tailoring-scout.selectorLabels" -}}
app.kubernetes.io/name: {{ include "cv-tailoring-scout.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: scout
{{- end -}}

{{/*
  The Secret the CronJob reads: the worker's, so DATABASE_URL and the bot token live in one
  place (`scripts/worker-secret.ps1`). `required` because a silent empty name would make the
  pod fail at start-up with a confusing "secret not found".
*/}}
{{- define "cv-tailoring-scout.secretName" -}}
{{- required "existingSecret is required: the scout needs DATABASE_URL and SCOUT_TELEGRAM_TOKEN/_CHAT_ID" .Values.existingSecret -}}
{{- end -}}
