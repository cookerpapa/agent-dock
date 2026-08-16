{{- define "pi-cloud-pi-worker-pool.name" -}}
{{- printf "pi-cloud-pi-worker-%s" .Values.workerPool.name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "pi-cloud-pi-worker-pool.labels" -}}
app.kubernetes.io/name: pi-cloud-pi-worker
app.kubernetes.io/instance: {{ .Release.Name | quote }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/component: trusted-pi-worker
app.kubernetes.io/part-of: pi-cloud
app.kubernetes.io/managed-by: {{ .Release.Service | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
pi-cloud.io/worker-pool: {{ .Values.workerPool.name | quote }}
{{- end -}}

{{- define "pi-cloud-pi-worker-pool.selectorLabels" -}}
app.kubernetes.io/name: pi-cloud-pi-worker
app.kubernetes.io/instance: {{ .Release.Name | quote }}
pi-cloud.io/worker-pool: {{ .Values.workerPool.name | quote }}
{{- end -}}

{{- define "pi-cloud-pi-worker-pool.pvcLabels" -}}
app.kubernetes.io/name: pi-cloud-pi-worker
app.kubernetes.io/instance: {{ .Release.Name | quote }}
app.kubernetes.io/component: trusted-pi-worker-state
app.kubernetes.io/part-of: pi-cloud
pi-cloud.io/worker-pool: {{ .Values.workerPool.name | quote }}
{{- end -}}

{{- define "pi-cloud-pi-worker-pool.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "pi-cloud-pi-worker-pool.name" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- required "serviceAccount.name is required when serviceAccount.create=false" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "pi-cloud-pi-worker-pool.image" -}}
{{- if .Values.image.digest -}}
{{ printf "%s@%s" .Values.image.repository .Values.image.digest }}
{{- else -}}
{{ printf "%s:%s" .Values.image.repository .Values.image.tag }}
{{- end -}}
{{- end -}}
