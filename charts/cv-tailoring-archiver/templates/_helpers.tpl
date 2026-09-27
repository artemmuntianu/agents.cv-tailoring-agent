{{/*
  Names for the inactivity sweep. Mirrors the scout chart's helpers so every workload group
  labels its objects the same way (and `kubectl get pods -l app.kubernetes.io/part-of=...`
  keeps working across the release).
*/}}
{{- define "cv-tailoring-archiver.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "cv-tailoring-archiver.fullname" -}}
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

{{- define "cv-tailoring-archiver.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "cv-tailoring-archiver.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: cv-tailoring-platform
{{- end -}}

{{- define "cv-tailoring-archiver.selectorLabels" -}}
app.kubernetes.io/name: {{ include "cv-tailoring-archiver.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: archiver
{{- end -}}

{{/*
  The Secret the CronJob reads: the worker's, so DATABASE_URL lives in exactly one object
  (`scripts/worker-secret.ps1`). `required` because a silent empty name would make the pod
  fail at start-up with a confusing "secret not found".
*/}}
{{- define "cv-tailoring-archiver.secretName" -}}
{{- required "existingSecret is required: the sweep needs DATABASE_URL for the board's tables" .Values.existingSecret -}}
{{- end -}}
