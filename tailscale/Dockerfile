FROM tailscale/tailscale:stable

# Bake in the serve config so containerboot can find it.
# ${TS_CERT_DOMAIN} is replaced at runtime by containerboot with the node's FQDN.
COPY serve.json /config/serve.json

ENV TS_SERVE_CONFIG=/config/serve.json
