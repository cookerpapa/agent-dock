{{- define "agent-dock-pi-worker-pool.name" -}}
{{- printf "agent-dock-pi-worker-%s" .Values.workerPool.name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "agent-dock-pi-worker-pool.labels" -}}
app.kubernetes.io/name: agent-dock-pi-worker
app.kubernetes.io/instance: {{ .Release.Name | quote }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/component: trusted-pi-worker
app.kubernetes.io/part-of: agent-dock
app.kubernetes.io/managed-by: {{ .Release.Service | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
agent-dock.io/worker-pool: {{ .Values.workerPool.name | quote }}
agent-dock.io/worker-build-id: {{ .Values.temporal.workerBuildId | quote }}
{{- end -}}

{{- define "agent-dock-pi-worker-pool.selectorLabels" -}}
app.kubernetes.io/name: agent-dock-pi-worker
app.kubernetes.io/instance: {{ .Release.Name | quote }}
agent-dock.io/worker-pool: {{ .Values.workerPool.name | quote }}
{{- end -}}

{{- define "agent-dock-pi-worker-pool.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "agent-dock-pi-worker-pool.name" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- required "serviceAccount.name is required when serviceAccount.create=false" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "agent-dock-pi-worker-pool.image" -}}
{{- if .Values.image.digest -}}
{{ printf "%s@%s" .Values.image.repository .Values.image.digest }}
{{- else -}}
{{ printf "%s:%s" .Values.image.repository .Values.image.tag }}
{{- end -}}
{{- end -}}
