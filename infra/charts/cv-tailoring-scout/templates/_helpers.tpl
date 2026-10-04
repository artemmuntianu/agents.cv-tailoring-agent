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
  The scout's pod template, shared by its two triggers - the CronJob (`cronjob.yaml`) and the
  startup hook (`startup-job.yaml`).

  Two triggers of one job must run the *same* pod: same image, same ConfigMap and Secret, same
  resources and security context, same `checksum/config` roll-on-change. Only `command` differs,
  because the ledger has to be able to tell a startup run from a CronJob slot (`--trigger`), and
  a copy of this block that drifted would make the startup run a different job in disguise.

  Call it as: include "cv-tailoring-scout.podTemplate" (dict "root" $ "command" (list ...))
*/}}
{{- define "cv-tailoring-scout.podTemplate" -}}
{{- $root := .root -}}
template:
  metadata:
    labels:
      {{- include "cv-tailoring-scout.selectorLabels" $root | nindent 6 }}
    annotations:
      # Roll the job template when the configuration changes.
      checksum/config: {{ include (print $root.Template.BasePath "/configmap.yaml") $root | sha256sum }}
  spec:
    restartPolicy: {{ $root.Values.restartPolicy | quote }}
    securityContext:
      {{- toYaml $root.Values.podSecurityContext | nindent 6 }}
    {{- with $root.Values.imagePullSecrets }}
    imagePullSecrets:
      {{- toYaml . | nindent 6 }}
    {{- end }}
    containers:
      - name: scout
        image: "{{ $root.Values.image.repository }}:{{ $root.Values.image.tag | default $root.Chart.AppVersion }}"
        imagePullPolicy: {{ $root.Values.image.pullPolicy }}
        # The package's entry point: there is no root `scout.py` on purpose (a same-named
        # package would shadow it).
        command: {{ .command | toJson }}
        envFrom:
          - configMapRef:
              name: {{ include "cv-tailoring-scout.fullname" $root }}
          - secretRef:
              name: {{ include "cv-tailoring-scout.secretName" $root }}
        resources:
          {{- toYaml $root.Values.resources | nindent 10 }}
        securityContext:
          {{- toYaml $root.Values.securityContext | nindent 10 }}
        volumeMounts:
          # `config.TEMP_ROOT` defaults under /tmp; the heartbeat file lives there too.
          - name: work
            mountPath: /tmp/cvt
    volumes:
      - name: work
        emptyDir: {}
    {{- with $root.Values.nodeSelector }}
    nodeSelector:
      {{- toYaml . | nindent 6 }}
    {{- end }}
    {{- with $root.Values.affinity }}
    affinity:
      {{- toYaml . | nindent 6 }}
    {{- end }}
    {{- with $root.Values.tolerations }}
    tolerations:
      {{- toYaml . | nindent 6 }}
    {{- end }}
{{- end -}}

{{/*
  The Secret the CronJob reads: the worker's, so DATABASE_URL and the bot token live in one
  place (`scripts/worker-secret.ps1`). `required` because a silent empty name would make the
  pod fail at start-up with a confusing "secret not found".
*/}}
{{- define "cv-tailoring-scout.secretName" -}}
{{- required "existingSecret is required: the scout needs DATABASE_URL and SCOUT_TELEGRAM_TOKEN/_CHAT_ID" .Values.existingSecret -}}
{{- end -}}
