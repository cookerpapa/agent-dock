{{- define "agent-dock-platform.name" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "agent-dock-platform.labels" -}}
app.kubernetes.io/name: agent-dock
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
{{- end -}}

{{- define "agent-dock-platform.image" -}}
{{- printf "%s:%s" .repository .tag -}}
{{- end -}}

{{- define "agent-dock-platform.secretMounts" -}}
- name: platform-secrets
  mountPath: /run/agent-dock-secrets/database-url
  subPath: {{ .Values.external.database.secretKey }}
  readOnly: true
- name: platform-secrets
  mountPath: /run/agent-dock-secrets/database-notification-url
  subPath: {{ .Values.external.database.notificationSecretKey }}
  readOnly: true
- name: platform-secrets
  mountPath: /run/agent-dock-secrets/aws-credentials
  subPath: aws-credentials
  readOnly: true
- name: platform-secrets
  mountPath: /run/agent-dock-secrets/supervisor-enrollment-token
  subPath: supervisor-enrollment-token
  readOnly: true
- name: platform-secrets
  mountPath: /run/agent-dock-secrets/supervisor-management-token
  subPath: supervisor-management-token
  readOnly: true
- name: platform-secrets
  mountPath: /run/agent-dock-secrets/model-credential-master-key
  subPath: model-credential-master-key
  readOnly: true
- name: platform-secrets
  mountPath: /run/agent-dock-secrets/cube-egress-config-token
  subPath: cube-egress-config-token
  readOnly: true
- name: platform-secrets
  mountPath: /run/agent-dock-secrets/sandbox-materializer-token
  subPath: sandbox-materializer-token
  readOnly: true
- name: platform-secrets
  mountPath: /run/agent-dock-secrets/metrics-token
  subPath: metrics-token
  readOnly: true
- name: platform-secrets
  mountPath: /run/agent-dock-secrets/worker-event-ingest-token
  subPath: {{ .Values.external.eventIngest.tokenSecretKey }}
  readOnly: true
{{- end -}}
