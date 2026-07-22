{{- define "agent-dock-execution-plane.labels" -}}
app.kubernetes.io/name: agent-dock-execution-plane
app.kubernetes.io/instance: {{ .Release.Name | quote }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/part-of: agent-dock
app.kubernetes.io/managed-by: {{ .Release.Service | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
{{- end -}}
{{- define "agent-dock-execution-plane.proxyLabels" -}}
{{ include "agent-dock-execution-plane.labels" . }}
agent-dock.io/workload: dependency-egress-proxy
{{- end -}}

{{- define "agent-dock-execution-plane.proxyImage" -}}
{{- if .Values.dependencyEgressProxy.image.digest -}}
{{ printf "%s@%s" .Values.dependencyEgressProxy.image.repository .Values.dependencyEgressProxy.image.digest }}
{{- else -}}
{{ printf "%s:%s" .Values.dependencyEgressProxy.image.repository .Values.dependencyEgressProxy.image.tag }}
{{- end -}}
{{- end -}}
