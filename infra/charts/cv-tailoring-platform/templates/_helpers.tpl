{{/*
  Shared values for the broker and its credentials, so the username/password
  exist in exactly one place: the `rabbitmq-credentials` Secret consumed by both
  the RabbitMQ StatefulSet and the KEDA TriggerAuthentication.
*/}}

{{- define "cv-tailoring-platform.rabbitmqName" -}}
{{- default "rabbitmq" .Values.rabbitmq.fullnameOverride -}}
{{- end -}}

{{- define "cv-tailoring-platform.rabbitmqCredentialsSecret" -}}
{{- default "rabbitmq-credentials" .Values.rabbitmqCredentials.secretName -}}
{{- end -}}

{{- define "cv-tailoring-platform.rabbitmqUsername" -}}
{{- $fromAuth := default "cvt" .Values.rabbitmq.auth.username -}}
{{- default $fromAuth .Values.rabbitmqCredentials.username -}}
{{- end -}}
