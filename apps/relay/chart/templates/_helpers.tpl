{{/* The chart name, cut to the 63 characters a label value allows. */}}
{{- define "oxagen-relay.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* The release's full name. A release named after the chart keeps one copy of the name. */}}
{{- define "oxagen-relay.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "oxagen-relay.selectorLabels" -}}
app.kubernetes.io/name: {{ include "oxagen-relay.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "oxagen-relay.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "oxagen-relay.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.image.tag | trunc 63 | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "oxagen-relay.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "oxagen-relay.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* The Secret that holds the relay token: the one you manage, or the chart's own. */}}
{{- define "oxagen-relay.tokenSecretName" -}}
{{- if .Values.token.existingSecret -}}
{{- .Values.token.existingSecret -}}
{{- else -}}
{{- printf "%s-token" (include "oxagen-relay.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "oxagen-relay.tokenSecretKey" -}}
{{- if .Values.token.existingSecret -}}
{{- .Values.token.existingSecretKey -}}
{{- else -}}
RELAY_TOKEN
{{- end -}}
{{- end -}}

{{/* Refuse a release that is missing a value the relay cannot start without. */}}
{{- define "oxagen-relay.validate" -}}
{{- $_ := required "Set image.repository to the registry path of the relay image you built from apps/relay/Dockerfile." .Values.image.repository -}}
{{- $_ := required "Set image.tag to the relay image tag you pushed." .Values.image.tag -}}
{{- $_ := required "Set relay.brokerUrl to the broker's wss:// address." .Values.relay.brokerUrl -}}
{{- $_ := required "Set relay.name to the relay's name in Oxagen." .Values.relay.name -}}
{{- $_ := required "Set relay.workspace to the workspace id: wrk_ and 22 characters." .Values.relay.workspace -}}
{{- $_ := required "Set relay.trustedKeys to the PEM public key Oxagen signs relay requests with." .Values.relay.trustedKeys -}}
{{- if not .Values.relay.allowedHosts -}}
{{- fail "Set relay.allowedHosts to the hosts the relay may reach." -}}
{{- end -}}
{{- if and .Values.token.value .Values.token.existingSecret -}}
{{- fail "Set token.value or token.existingSecret, not both." -}}
{{- end -}}
{{- if not (or .Values.token.value .Values.token.existingSecret) -}}
{{- fail "Set token.value to the relay token, or token.existingSecret to a Secret that holds it." -}}
{{- end -}}
{{- end -}}
