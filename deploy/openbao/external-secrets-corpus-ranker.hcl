# OpenBao policy for the estate External Secrets role (CRANK-140): the ranker's
# API key set and its MinIO credentials, two exact paths, read-only. No list,
# no metadata, no wildcard, no other path (Rule:
# policies/placement-defaults.yaml#estate secrets). Attached estate-side to the
# role the `openbao` ClusterSecretStore logs in with, beside
# external-secrets-ghcr-pull.hcl; its readers in this product are the
# ExternalSecrets `ranker-api-keys` (kv/corpus-ranker/api-keys, written by
# the ranker-api-keys-generate Job), `ranker-minio` and `ranker-minio-service`
# (kv/corpus-ranker/minio) in deploy/externalsecrets.yaml.
# tests/deploy/external-secrets.test.ts loads it into a throwaway OpenBao.
path "kv/data/corpus-ranker/api-keys" {
  capabilities = ["read"]
}

path "kv/data/corpus-ranker/minio" {
  capabilities = ["read"]
}
