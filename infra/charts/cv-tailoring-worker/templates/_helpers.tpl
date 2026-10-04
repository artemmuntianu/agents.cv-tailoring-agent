{{/* Common template helpers */}}

{{- define "cv-tailoring-worker.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "cv-tailoring-worker.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "cv-tailoring-worker.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "cv-tailoring-worker.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 }}
{{ include "cv-tailoring-worker.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: cv-tailoring-platform
{{- end -}}

{{- define "cv-tailoring-worker.selectorLabels" -}}
app.kubernetes.io/name: {{ include "cv-tailoring-worker.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: ai-worker
{{- end -}}

{{- define "cv-tailoring-worker.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "cv-tailoring-worker.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* Name of the Secret that holds the runtime credentials. */}}
{{- define "cv-tailoring-worker.secretName" -}}
{{- if .Values.existingSecret -}}
{{- .Values.existingSecret -}}
{{- else -}}
{{- include "cv-tailoring-worker.fullname" . -}}
{{- end -}}
{{- end -}}
