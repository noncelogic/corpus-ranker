# OpenBao policy for the estate External Secrets role (CRANK-140): the ranker's
# MinIO credentials, one exact path, read-only. No list, no metadata, no
# wildcard, no other path (Rule: policies/placement-defaults.yaml#estate
# secrets). One policy per custody path: the API key set is granted by
# external-secrets-corpus-ranker.hcl. Both are attached estate-side to the
# role the `openbao` ClusterSecretStore logs in with, beside
# external-secrets-ghcr-pull.hcl; this one's readers in this product are the
# ExternalSecrets `ranker-minio` and `ranker-minio-service`
# (kv/corpus-ranker/minio, written by the ranker-minio-provision Job) in
# deploy/externalsecrets.yaml.
# tests/deploy/external-secrets.test.ts loads it alone into a throwaway OpenBao.
path "kv/data/corpus-ranker/minio" {
  capabilities = ["read"]
}
