# OpenBao policy for the estate External Secrets role (CRANK-140): the ranker's
# API key set, one exact path, read-only. No list, no metadata, no wildcard,
# no other path (Rule: policies/placement-defaults.yaml#estate secrets). One
# policy per custody path: the MinIO credentials are granted by
# external-secrets-corpus-ranker-minio.hcl. Both are attached estate-side,
# add-only, to the Kubernetes auth role eso-obs the `openbao` ClusterSecretStore
# logs in with (devops/openbao/kubernetes-roles/eso-obs.attach.json), beside
# the estate-held ACR pull grant (kv/corpus-ranker/acr-pull); this one's only reader in this product is
# the ExternalSecret `ranker-api-keys` (kv/corpus-ranker/api-keys, written by
# the ranker-api-keys-generate Job) in deploy/externalsecrets.yaml.
# tests/deploy/external-secrets.test.ts loads it alone into a throwaway OpenBao.
path "kv/data/corpus-ranker/api-keys" {
  capabilities = ["read"]
}
