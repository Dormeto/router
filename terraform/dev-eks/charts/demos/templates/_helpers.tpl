{{/* A demo's Deployment or StatefulSet pod template: nginx answering on 80, with requests (the savings price them). */}}
{{- define "demos.pod" -}}
metadata:
  labels:
    app: {{ .name }}
spec:
  containers:
    - name: web
      image: {{ .image }}
      ports:
        - containerPort: 80
      readinessProbe:
        httpGet:
          path: /
          port: 80
      resources:
        requests:
          cpu: 100m
          memory: 128Mi
{{- end -}}

{{/* A demo's Service. */}}
{{- define "demos.service" -}}
apiVersion: v1
kind: Service
metadata:
  name: {{ .name }}
  namespace: {{ .namespace }}
spec:
  selector:
    app: {{ .name }}
  ports:
    - port: 80
      targetPort: 80
{{- end -}}

{{/* A demo's Ingress: in the group unless lone (then its own ALB). */}}
{{- define "demos.ingress" -}}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ .name }}
  namespace: {{ .namespace }}
  annotations:
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTP": 80}, {"HTTPS": 443}]'
    alb.ingress.kubernetes.io/ssl-redirect: "443"
    alb.ingress.kubernetes.io/certificate-arn: {{ .certificateArn }}
    {{- if not .lone }}
    alb.ingress.kubernetes.io/group.name: {{ .group }}
    {{- end }}
spec:
  ingressClassName: alb
  rules:
    - host: {{ .name }}.{{ .domain }}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: {{ .name }}
                port:
                  number: 80
{{- end -}}
